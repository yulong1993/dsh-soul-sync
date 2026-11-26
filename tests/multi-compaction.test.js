import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOUL_COMPACTION_SECTIONS,
  SOUL_COMPACTION_INSTRUCTION,
  SOUL_RECALL_HINT_LINE,
  SUMMARY_OPEN_TAG,
  SUMMARY_CLOSE_TAG,
  CHECKPOINT_PREAMBLE,
  detectCompactionGeneration,
  buildSoulCompactionInstruction,
  rewriteCompactionStreamOptions,
  estimateFramedSummaryTokens,
  estimateShadowedBudgetTokens,
  wrapCompactionStreamWithBudgetGuard,
  interceptCompactionStream,
} from '../lib/compaction-soul.js';
import {
  compactSessionPreservingTail,
  selectTailPreservingSpan,
} from '../lib/tail-compactor.js';
import {
  createSoulRecallTool,
  searchSessionHistory,
} from '../lib/recall-tool.js';
import {
  hasUnclosedCompaction,
  exportSessionClosure,
  exportAllLocalSessions,
  pullSessionsFromVault,
} from '../lib/session-plane.js';
import { parseNaturalSoulIntent } from '../lib/nl-router.js';
import { apply as applySoulSyncPlugin } from '../lib/index.js';
import { saveConfig, writeFileAtomic } from '../lib/config.js';
import { VaultStore } from '../lib/crypto-vault.js';
import { encodeSegment, projectKey, encodeV4SessionLog } from '../lib/zstd-v4.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_ROOT = path.join(REPO_ROOT, '.test-tmp', `multi-compaction-${process.pid}-${Date.now()}`);

test.after(async () => {
  await fs.rm(TEST_TMP_ROOT, { recursive: true, force: true });
});

/**
 * In-memory Session simulator matching DSH V4 surface replacement semantics.
 */
function createMockSession({ id = 'sess-mock-1', cwd = '/tmp/ws', provider = 'deepseek', model = 'deepseek-v4-pro' } = {}) {
  const log = [];
  const surfaceNodes = [];
  let replaceGeneration = 0;

  const session = {
    id,
    cwd,
    header: { version: 4, id, cwd, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 },
    surface: {
      get nodes() {
        return surfaceNodes;
      },
      get replaceGeneration() {
        return replaceGeneration;
      },
    },
    get seq() {
      return log.length;
    },
    eventAt(seq) {
      return log[seq];
    },
    snapshotEvents() {
      return Object.freeze([...log]);
    },
    requestHeader() {
      return {
        config: { provider, model, reasoningEffort: 'high' },
        tools: [{ name: 'read_file', description: 'Read file' }],
      };
    },
    toolHistory() {
      return [];
    },
    deriveEventMessage(ev) {
      if (!ev) return null;
      if (ev.type === 'user/message') return ev.data;
      if (ev.type === 'system/message' || ev.type === 'assistant/message' || ev.type === 'developer/message') {
        return ev.data?.message ?? ev.data;
      }
      if (ev.type === 'tool/result') return ev.data?.message ?? ev.data;
      return null;
    },
    append(type, data, opts = {}) {
      const event = {
        type,
        seq: log.length,
        time: Date.now() + log.length,
        data,
        ...(opts.surfaceOp !== undefined ? { surfaceOp: opts.surfaceOp } : {}),
        ...(opts.sourceEventSeqs !== undefined ? { sourceEventSeqs: opts.sourceEventSeqs } : {}),
      };
      log.push(event);
      if (opts.surfaceOp === 'append') {
        surfaceNodes.push(event.seq);
      } else if (opts.surfaceOp && typeof opts.surfaceOp === 'object' && opts.surfaceOp.op === 'replace') {
        const sIdx = surfaceNodes.indexOf(opts.surfaceOp.startSeq);
        const eIdx = surfaceNodes.indexOf(opts.surfaceOp.endSeq);
        if (sIdx === -1 || eIdx === -1 || sIdx > eIdx) {
          throw new Error(`Invalid replace range ${opts.surfaceOp.startSeq}-${opts.surfaceOp.endSeq}`);
        }
        surfaceNodes.splice(sIdx, eIdx - sIdx + 1, event.seq);
        replaceGeneration += 1;
      }
      return event;
    },
  };

  return session;
}

function makeUserMsg(text, source = { kind: 'user' }) {
  return {
    id: `u-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  };
}

function makeAssistantMsg(blocks) {
  return {
    message: {
      id: `a-${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content: blocks,
    },
  };
}

function makeToolResultMsg(callId, text) {
  return {
    message: {
      id: `t-${Math.random().toString(36).slice(2, 8)}`,
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text }],
    },
  };
}

async function* chunksFromArray(chunks) {
  for (const c of chunks) {
    yield c;
  }
}

test('Module 1: 5-generation anti-decay compaction, explicit user overturn, zero prefix mutation & streaming budget guard', async () => {
  // 1. Verify dead code `loadSoulCompactionEngineClass` is removed
  const compactionMod = await import('../lib/compaction-soul.js');
  assert.equal('loadSoulCompactionEngineClass' in compactionMod, false, 'dead code loadSoulCompactionEngineClass must be removed');

  // 2. Verify all 6 upgraded anti-decay H2 sections and key rules
  assert.equal(SOUL_COMPACTION_SECTIONS.length, 6);
  let cursor = -1;
  for (const heading of SOUL_COMPACTION_SECTIONS) {
    const idx = SOUL_COMPACTION_INSTRUCTION.indexOf(heading);
    assert.ok(idx > cursor, `Missing or out-of-order section heading: ${heading}`);
    cursor = idx;
  }
  assert.match(SOUL_COMPACTION_INSTRUCTION, /≤\s*600\s*字/);
  assert.match(SOUL_COMPACTION_INSTRUCTION, /\[本代翻案:\s*旧X\s*→\s*新Y\]/);
  assert.match(SOUL_COMPACTION_INSTRUCTION, /≤\s*3\s*条/);
  assert.match(SOUL_COMPACTION_INSTRUCTION, /≤\s*10\s*条/);
  assert.match(SOUL_COMPACTION_INSTRUCTION, /thinking.*reasoning|reasoning/i);
  assert.ok(SOUL_COMPACTION_INSTRUCTION.includes(SOUL_RECALL_HINT_LINE));

  // 3. Simulate 5 consecutive compaction generations
  const sysMsg = { role: 'system', content: [{ type: 'text', text: 'System prompt' }] };
  const axioms = [
    '公理1：宁德时代2025Q3毛利率基准为 22.4%，严禁擅自改动口径。',
    '公理2：估值折现率 WACC 锁定 9.25%（无用户显式翻案绝不改）。',
  ];
  let currentSummary = null;

  for (let gen = 1; gen <= 5; gen += 1) {
    const prefixMsgs = [sysMsg];
    if (currentSummary) {
      prefixMsgs.push(makeUserMsg(`${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${currentSummary}\n${SUMMARY_CLOSE_TAG}`, {
        kind: 'compact-checkpoint',
        compactionId: `cmp-${gen - 1}`,
      }));
    }
    const turnUser = makeUserMsg(
      gen === 4
        ? '不对，翻案：WACC 从 9.25% 改成 8.75%，其余公理不动，继续拆解。'
        : `第 ${gen} 阶段补充数据与推进细节：分析产能利用率与折旧曲线。`,
    );
    const turnAssistant = makeAssistantMsg([
      { type: 'reasoning', text: `第 ${gen} 代思维链复盘：用户偏好直给核心矛盾，避免平行罗列。` },
      { type: 'text', text: `第 ${gen} 阶段已完成核心脚本测算并更新 outputs/model_g${gen}.xlsx。` },
    ]).message;
    prefixMsgs.push(turnUser, turnAssistant);

    const origInstruction = makeUserMsg('Default English compaction instruction');
    const options = {
      purpose: 'compaction',
      messages: [...prefixMsgs, origInstruction],
    };

    // Snapshot exact object references of messages.slice(0, -1)
    const beforePrefixRefs = options.messages.slice(0, -1);
    const detected = detectCompactionGeneration(options.messages);
    assert.equal(detected.generation, gen, `Expected generation ${gen}`);

    const rewritten = rewriteCompactionStreamOptions(options);
    assert.equal(rewritten, true);

    // 100% DeepSeek Prefix Cache guarantee: exact object identity of messages.slice(0, -1)
    for (let i = 0; i < beforePrefixRefs.length; i += 1) {
      assert.strictEqual(options.messages[i], beforePrefixRefs[i], `Prefix message ${i} must never be mutated at gen ${gen}`);
    }

    const injectedPrompt = options.messages[options.messages.length - 1].content[0].text;
    assert.ok(injectedPrompt.includes(`[压缩代次: G${gen}]`));
    if (gen >= 2) {
      assert.ok(injectedPrompt.includes(`第 ${gen} 代增量灵魂复盘压缩`));
    } else {
      assert.equal(injectedPrompt, SOUL_COMPACTION_INSTRUCTION);
    }

    // Simulate model honoring the generation instruction (Gen 4 overturns WACC; Gen 5 cleans Gen 4's overturn tag!)
    const effectiveAxioms = gen < 4
      ? [...axioms]
      : gen === 4
        ? [axioms[0], '公理2：估值折现率 WACC 更新为 8.75%。\n[本代翻案: 旧9.25% → 新8.75%]']
        : [axioms[0], '公理2：估值折现率 WACC 锁定为 8.75%。'];

    const scars = Array.from({ length: Math.min(10, gen * 2) }, (_, i) => `- 伤疤${i + 1}：否决路线#${i + 1}`);
    currentSummary = [
      `[压缩代次: G${gen}]`,
      SOUL_COMPACTION_SECTIONS[0],
      ...effectiveAxioms.map((a) => `- ${a}`),
      '',
      SOUL_COMPACTION_SECTIONS[1],
      `- 近阶段推演 G${gen} 精详链条`,
      '',
      SOUL_COMPACTION_SECTIONS[2],
      ...scars,
      '',
      SOUL_COMPACTION_SECTIONS[3],
      '- 待核实海外储能运费口径',
      '',
      SOUL_COMPACTION_SECTIONS[4],
      `- outputs/model_g${gen}.xlsx`,
      '',
      SOUL_COMPACTION_SECTIONS[5],
      `- 已吸收纠偏，直给主矛盾。${SOUL_RECALL_HINT_LINE}`,
    ].join('\n');

    // Assertions across all 5 generations
    assert.ok(currentSummary.includes('22.4%'), `Gen ${gen} must retain locked 22.4% axiom`);
    if (gen === 4) {
      assert.ok(currentSummary.includes('[本代翻案: 旧9.25% → 新8.75%]'));
    }
    if (gen === 5) {
      assert.ok(currentSummary.includes('8.75%'));
      assert.equal(currentSummary.includes('[本代翻案:'), false, 'Gen 5 must clear prior overturn marker to prevent split-brain');
      assert.equal(currentSummary.includes('9.25%'), false, 'Gen 5 must not resurrect overturned WACC');
    }
  }

  // 4. Streaming volume convergence guardrail on a SMALL compaction span
  //    Verify BOTH `text-delta` AND `block-end.block.text` are synchronously trimmed and framed < shadowedBudgetTokens!
  const smallSpanOptions = {
    purpose: 'compaction',
    messages: [
      sysMsg,
      makeUserMsg('请帮我测算宁德时代2025Q3毛利率22.4%下WACC=9.25%的灵敏度。'.repeat(6)),
      makeAssistantMsg([
        { type: 'text', text: '我已写好 scripts/sens.py，排除旧DCF口径，并跑出基准结果 22.4%。'.repeat(6) },
      ]).message,
      makeUserMsg('Summarize'),
    ],
  };

  const shadowedBudgetTokens = estimateShadowedBudgetTokens(smallSpanOptions.messages);
  assert.ok(shadowedBudgetTokens > 120, `Expected measurable small span budget, got ${shadowedBudgetTokens}`);

  const bloatedSummary = [
    '[压缩代次: G2]',
    SOUL_COMPACTION_SECTIONS[0],
    '- 宁德时代2025Q3毛利率锁定 22.4%，WACC 锁定 9.25%。',
    '',
    SOUL_COMPACTION_SECTIONS[1],
    '- ' + '非常冗长的历史推演流水账细节重复铺陈，用于触发流式体积收敛护栏截断次要段落。'.repeat(25),
    '',
    SOUL_COMPACTION_SECTIONS[2],
    '- 否决旧 DCF 口径',
    '',
    SOUL_COMPACTION_SECTIONS[3],
    '- 待补海外储能运费',
    '',
    SOUL_COMPACTION_SECTIONS[4],
    '- scripts/sens.py',
    '',
    SOUL_COMPACTION_SECTIONS[5],
    '- ' + '一大段非常啰嗦的沟通风格与环境描述，应最先被护栏精简。'.repeat(25),
  ].join('\n');

  assert.ok(
    estimateFramedSummaryTokens(bloatedSummary) > shadowedBudgetTokens,
    'Test fixture bloated summary must exceed shadowedBudgetTokens before guard',
  );

  const rawChunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: bloatedSummary.slice(0, 200) },
    { type: 'text-delta', index: 0, text: bloatedSummary.slice(200) },
    { type: 'block-end', index: 0, block: { type: 'text', text: bloatedSummary } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];

  const guardedStream = interceptCompactionStream(smallSpanOptions, () => chunksFromArray(rawChunks));
  const outChunks = [];
  for await (const chunk of guardedStream) {
    outChunks.push(chunk);
  }

  const deltaCombined = outChunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text)
    .join('');
  const endChunk = outChunks.find((c) => c.type === 'block-end');
  assert.ok(endChunk, 'block-end must still be emitted');
  assert.equal(deltaCombined, endChunk.block.text, 'text-delta and block-end.block.text must be 100% synchronized');
  assert.ok(deltaCombined.includes('22.4%'), 'Core axiom in section 1 must be preserved when trimming secondary sections');
  assert.ok(
    estimateFramedSummaryTokens(endChunk.block.text) < shadowedBudgetTokens,
    `Framed summary tokens (${estimateFramedSummaryTokens(endChunk.block.text)}) must be strictly < shadowedBudgetTokens (${shadowedBudgetTokens})`,
  );

  // Non-compaction stream MUST pass through completely untouched (same reference)
  const normalStream = chunksFromArray([{ type: 'text-delta', index: 0, text: 'hello' }]);
  const normalRes = interceptCompactionStream({ purpose: 'chat', messages: [sysMsg, makeUserMsg('hi')] }, () => normalStream);
  assert.strictEqual(normalRes, normalStream);
});

test('Module 2: tail-preserving compactor keeps last K turns (with reasoning & tool pairs), omits sourceCommandId, handles noop/error cleanly', async () => {
  const session = createMockSession({ id: 'sess-tail-01', cwd: 'D:\\ws-tail' });

  // System prompt at surface node 0
  session.append('system/message', {
    message: { id: 'sys-0', role: 'system', content: [{ type: 'text', text: 'System instructions' }] },
  }, { surfaceOp: 'append' });

  // 5 complete turns: early turns 1-2 have rich text + tool call/result, tail turns 3-5 have reasoning + tool pair
  for (let t = 1; t <= 5; t += 1) {
    session.append('turn/start', { turn: t });
    session.append('user/message', makeUserMsg(
      `第${t}轮真实用户提问：请分析标的#${t}的毛利率与估值敏感性，并检查历史口径差异。`.repeat(4),
    ), { surfaceOp: 'append' });

    const callId = `call-t${t}`;
    session.append('assistant/message', makeAssistantMsg([
      { type: 'reasoning', text: `第${t}轮原生思维链：仔细核对第${t}轮的现金流口径与假设边界。`.repeat(3) },
      { type: 'tool-call', id: callId, name: 'read_file', arguments: JSON.stringify({ path: `data/t${t}.csv` }) },
    ]), { surfaceOp: 'append' });

    session.append('tool/result', makeToolResultMsg(
      callId,
      `表t${t}数据：毛利率=22.${t}%，营收增速=+18.${t}%，已核验无误。`.repeat(4),
    ), { surfaceOp: 'append' });

    session.append('assistant/message', makeAssistantMsg([
      { type: 'reasoning', text: `第${t}轮收尾思维链：已确认第${t}轮指标。` },
      { type: 'text', text: `第${t}轮最终回复：标的#${t}分析结论清晰，脚本已生成。`.repeat(3) },
    ]), { surfaceOp: 'append' });

    session.append('turn/end', { turn: t });
  }

  let maintenanceCalled = false;
  let flushCount = 0;
  const mockCtx = {
    llm: {
      stream(opts) {
        assert.equal(opts.purpose, 'compaction');
        assert.equal(opts.sessionId, 'sess-tail-01');
        // Verify Prefix Cache order: system first, then shadowed turns 1-2 only, NOT turns 3-5!
        assert.equal(opts.messages[0].role, 'system');
        const bodyText = opts.messages.slice(1, -1).map((m) => JSON.stringify(m)).join('\n');
        assert.ok(bodyText.includes('第1轮真实用户提问'));
        assert.ok(bodyText.includes('第2轮真实用户提问'));
        assert.equal(bodyText.includes('第3轮真实用户提问'), false, 'Tail turn 3 must not be shadowed');
        assert.equal(bodyText.includes('第5轮真实用户提问'), false, 'Tail turn 5 must not be shadowed');

        const summary = [
          '[压缩代次: G1]',
          SOUL_COMPACTION_SECTIONS[0],
          '- 已完成标的#1、#2 的毛利率与口径核对。',
          '',
          SOUL_COMPACTION_SECTIONS[1],
          '- 标的#1/#2 已定稿。',
          '',
          SOUL_COMPACTION_SECTIONS[2],
          '- (无)',
          '',
          SOUL_COMPACTION_SECTIONS[3],
          '- 继续推进标的#3~#5。',
          '',
          SOUL_COMPACTION_SECTIONS[4],
          '- data/t1.csv, data/t2.csv',
          '',
          SOUL_COMPACTION_SECTIONS[5],
          `- ${SOUL_RECALL_HINT_LINE}`,
        ].join('\n');

        return chunksFromArray([
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: summary },
          { type: 'block-end', index: 0, block: { type: 'text', text: summary } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]);
      },
    },
    sessions: {
      async flush() {
        flushCount += 1;
      },
    },
  };

  const mockAgent = {
    session,
    async runMaintenance(fn) {
      maintenanceCalled = true;
      return fn(new AbortController().signal);
    },
  };

  const res = await compactSessionPreservingTail({
    ctx: mockCtx,
    agent: mockAgent,
    session,
    keepTurns: 3,
  });

  assert.equal(res.status, 'compacted');
  assert.equal(res.ok, true);
  assert.equal(maintenanceCalled, true);
  assert.equal(flushCount, 1);
  assert.equal(res.keptTurns, 3);
  assert.equal(res.shadowedCount, 8); // 2 early turns * 4 surface events each

  // Verify V4 4-event transaction and ZERO sourceCommandId
  const events = session.snapshotEvents();
  const tail4 = events.slice(-4);
  assert.deepEqual(
    tail4.map((e) => e.type),
    ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'],
  );
  assert.equal(tail4[0].data.turn, null);
  assert.equal(tail4[0].data.sourceCommandId, undefined, 'compaction/start must omit sourceCommandId');
  assert.equal(tail4[1].data.sourceCommandId, undefined, 'compaction/summary must omit sourceCommandId');
  assert.equal(tail4[2].data.source.kind, 'compact-checkpoint');
  assert.equal(tail4[2].data.source.sourceCommandId, undefined, 'checkpoint user/message must omit sourceCommandId');
  assert.equal(tail4[3].data.turn, null);
  assert.equal(tail4[3].data.sourceCommandId, undefined, 'compaction/end must omit sourceCommandId');
  assert.equal(hasUnclosedCompaction(events), false);

  // Verify surface preserves system[0], new checkpoint[1], and ALL 3 tail turns (with reasoning & tool pairs intact!)
  const surfaceTypes = session.surface.nodes.map((seq) => session.eventAt(seq).type);
  assert.equal(surfaceTypes[0], 'system/message');
  assert.equal(surfaceTypes[1], 'user/message'); // checkpoint
  const tailSurfaceEvents = session.surface.nodes.slice(2).map((seq) => session.eventAt(seq));
  assert.equal(tailSurfaceEvents.length, 12); // 3 turns * 4 events
  const tailText = JSON.stringify(tailSurfaceEvents);
  assert.ok(tailText.includes('第3轮原生思维链'));
  assert.ok(tailText.includes('第5轮原生思维链'));
  assert.ok(tailText.includes('call-t3'));
  assert.ok(tailText.includes('call-t5'));

  // Test error path: stream throws -> MUST append compaction/end with error (NO deadlock left behind!)
  const errSession = createMockSession({ id: 'sess-tail-err' });
  for (let t = 1; t <= 3; t += 1) {
    errSession.append('user/message', makeUserMsg(`用户提问${t}：`.repeat(40)), { surfaceOp: 'append' });
    errSession.append('assistant/message', makeAssistantMsg([{ type: 'text', text: `助手回答${t}：`.repeat(40) }]), { surfaceOp: 'append' });
  }
  const errCtx = {
    llm: {
      stream() {
        return (async function* () {
          throw new Error('simulated upstream LLM 503');
        })();
      },
    },
    sessions: { async flush() {} },
  };
  const errRes = await compactSessionPreservingTail({ ctx: errCtx, session: errSession, keepTurns: 1 });
  assert.equal(errRes.status, 'error');
  assert.equal(errRes.ok, false);
  const errEvents = errSession.snapshotEvents();
  assert.equal(errEvents[errEvents.length - 1].type, 'compaction/end');
  assert.ok(errEvents[errEvents.length - 1].data.error, 'compaction/end must record error chain');
  assert.equal(hasUnclosedCompaction(errEvents), false, 'failed compaction must close cleanly without leaving deadlock');

  // Test short conversation -> noop without appending any compaction event
  const shortSession = createMockSession({ id: 'sess-short' });
  shortSession.append('user/message', makeUserMsg('你好'), { surfaceOp: 'append' });
  shortSession.append('assistant/message', makeAssistantMsg([{ type: 'text', text: '你好！' }]), { surfaceOp: 'append' });
  const shortRes = await compactSessionPreservingTail({ ctx: mockCtx, session: shortSession, keepTurns: 3 });
  assert.equal(shortRes.status, 'noop');
  assert.equal(shortRes.ok, true);
  assert.equal(shortSession.snapshotEvents().length, 2);

  // Test NL routing for /soul compact (without colliding with step-sync toggles!)
  assert.deepEqual(parseNaturalSoulIntent('compact'), { kind: 'compact', keepTurns: 3 });
  assert.deepEqual(parseNaturalSoulIntent('compact 5'), { kind: 'compact', keepTurns: 5 });
  assert.deepEqual(parseNaturalSoulIntent('帮我无损压缩一下'), { kind: 'compact', keepTurns: 3 });
  assert.deepEqual(parseNaturalSoulIntent('整理一下上下文，保留 2 轮'), { kind: 'compact', keepTurns: 2 });
  assert.deepEqual(parseNaturalSoulIntent('压缩对话'), { kind: 'compact', keepTurns: 3 });
  assert.deepEqual(parseNaturalSoulIntent('给上下文瘦身'), { kind: 'compact', keepTurns: 3 });
  // Must NOT hijack step-sync toggles!
  assert.deepEqual(parseNaturalSoulIntent('关闭30秒快照'), { kind: 'set-step-sync', enabled: false });
  assert.deepEqual(parseNaturalSoulIntent('开启30秒快照'), { kind: 'set-step-sync', enabled: true });
});

test('Module 3: soul_recall_history hits folded Chinese facts, reasoning chains, and pruned tool results while excluding active step', async () => {
  const session = createMockSession({ id: 'sess-recall-01' });

  // Shadowed historical turn (will be replaced by a compaction checkpoint)
  const u0 = session.append('user/message', makeUserMsg(
    '请核对宁德时代2025Q3财报：宁德时代2025Q3毛利率为22.4%，否决了DCF方案，改用分部EV/EBITDA。',
  ), { surfaceOp: 'append' });
  const a1 = session.append('assistant/message', makeAssistantMsg([
    { type: 'reasoning', text: '内心复盘：刚才用户明确纠偏，强调不能用单阶段DCF方案来估值动力电池周期波动，需锚定22.4%毛利率。' },
    { type: 'tool-call', id: 'c1', name: 'run_python', arguments: '{"script":"scripts/margin_check.py"}' },
  ]), { surfaceOp: 'append' });
  const t2 = session.append('tool/result', makeToolResultMsg(
    'c1',
    'RAW_UNPRUNED_OUTPUT: CATL_2025Q3_GROSS_MARGIN=22.40%, ENERGY_STORAGE_MARGIN=26.8%, ERROR_CODE=NONE',
  ), { surfaceOp: 'append' });
  const a3 = session.append('assistant/message', makeAssistantMsg([
    { type: 'text', text: '已确认宁德时代2025Q3毛利率为22.4%，否决了DCF方案并记录在案。' },
  ]), { surfaceOp: 'append' });

  // Compaction replaces seq 0..3 with a short summary checkpoint (so seq 0..3 are now SHADOWED!)
  session.append('user/message', makeUserMsg(
    `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n简要复盘：已完成前段电池行业梳理。\n${SUMMARY_CLOSE_TAG}`,
    { kind: 'compact-checkpoint', compactionId: 'cmp-recall' },
  ), {
    surfaceOp: { op: 'replace', startSeq: u0.seq, endSeq: a3.seq },
    sourceEventSeqs: [u0.seq, a1.seq, t2.seq, a3.seq],
  });

  // Current visible turn + active executing step calling soul_recall_history (MUST be excluded!)
  session.append('user/message', makeUserMsg('帮我查一下前面说的毛利率数字和否决原因'), { surfaceOp: 'append' });
  session.append('step/start', { step: 9 });
  session.append('assistant/message', makeAssistantMsg([
    { type: 'reasoning', text: '当前正在调用 soul_recall_history 检索 22.4% 和 CATL_2025Q3_GROSS_MARGIN，不应命中本步！' },
    { type: 'tool-call', id: 'c-active', name: 'soul_recall_history', arguments: '{"query":"22.4%"}' },
  ]), { surfaceOp: 'append' });

  const tool = createSoulRecallTool();
  assert.equal(tool.name, 'soul_recall_history');
  assert.equal(tool.isConcurrencySafe(), true);
  assert.equal(tool.presentCall({ query: '22.4%' }).kind, 'search');

  const execCtx = { agent: { session } };

  // 1. Exact Chinese sentence hit in shadowed history
  const hit1 = await tool.execute({ query: '宁德时代2025Q3毛利率为22.4%，否决了DCF方案' }, execCtx);
  assert.ok(hit1.includes('[seq #0 | user/message | shadowed]'));
  assert.ok(hit1.includes('22.4%'));
  assert.ok(hit1.includes('否决了DCF方案'));
  assert.equal(hit1.includes('不应命中本步'), false, 'Active executing step must be excluded');

  // 2. Assistant reasoning chain hit
  const hitReasoning = await tool.execute({ query: '动力电池周期波动 单阶段DCF方案', include_reasoning: true }, execCtx);
  assert.ok(hitReasoning.includes('[seq #1 | assistant/reasoning | shadowed]'));
  assert.ok(hitReasoning.includes('内心复盘'));

  // 2b. With include_reasoning: false, reasoning-only text should NOT match seq #1
  const noReasoning = searchSessionHistory(session, { query: '动力电池周期波动', include_reasoning: false });
  assert.equal(noReasoning.hits.length, 0);

  // 3. Folded/pruned raw tool/result hit
  const hitTool = await tool.execute({ query: 'CATL_2025Q3_GROSS_MARGIN ENERGY_STORAGE_MARGIN' }, execCtx);
  assert.ok(hitTool.includes('[seq #2 | tool/result | shadowed]'));
  assert.ok(hitTool.includes('26.8%'));

  // 4. Fallback from shadowed to all when query only exists in current surface
  const hitFallback = searchSessionHistory(session, { query: '帮我查一下前面说的毛利率数字' });
  assert.equal(hitFallback.usedFallbackScope, true);
  assert.ok(hitFallback.hits.some((h) => h.surface === 'current'));
});

test('Module 4: hasUnclosedCompaction defers mid-compaction snapshot export without aborting other sessions, then exports cleanly once closed', async () => {
  assert.equal(hasUnclosedCompaction([]), false);
  assert.equal(hasUnclosedCompaction([
    { seq: 0, type: 'compaction/start', data: { compactionId: 'c1', turn: null } },
  ]), true);
  assert.equal(hasUnclosedCompaction([
    { seq: 0, type: 'compaction/start', data: { compactionId: 'c1', turn: null } },
    { seq: 1, type: 'compaction/end', data: { compactionId: 'c1', turn: null } },
  ]), false);
  assert.equal(hasUnclosedCompaction([
    { seq: 0, type: 'compaction/start', data: { compactionId: 'c1', turn: null } },
    { seq: 1, type: 'session/end-seed', data: {} },
  ]), false);

  const caseDir = path.join(TEST_TMP_ROOT, 'unclosed-compaction-guard');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  const macWs = path.join(caseDir, 'mac-ws');
  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(macWs, { recursive: true });

  const mappings = [{ id: 'ws-guard', title: '护栏测试', win32: winWs, darwin: macWs }];
  const winVault = new VaultStore({ vaultDir, deviceId: 'win-g1', platform: 'win32' });
  const macVault = new VaultStore({ vaultDir, deviceId: 'mac-g1', platform: 'darwin' });

  const writeSess = async (id, events) => {
    const header = { version: 4, id, cwd: winWs, createdAt: Date.now() };
    const sessDir = path.join(winHome, 'sessions', projectKey(winWs), encodeSegment(id));
    await fs.mkdir(sessDir, { recursive: true });
    const bytes = await encodeV4SessionLog(header, events);
    await writeFileAtomic(path.join(sessDir, 'session.v4.jsonl.zstd'), bytes, { mode: 0o600 });
    return header;
  };

  // Session A: healthy closed session
  await writeSess('sess-healthy', [
    { seq: 0, time: Date.now(), type: 'user/message', surfaceOp: 'append', data: makeUserMsg('健康会话') },
  ]);

  // Session B: mid-compaction (unclosed compaction/start!)
  const midEvents = [
    { seq: 0, time: Date.now(), type: 'user/message', surfaceOp: 'append', data: makeUserMsg('压缩中会话') },
    { seq: 1, time: Date.now() + 1, type: 'compaction/start', data: { compactionId: 'cmp-mid', turn: null } },
  ];
  await writeSess('sess-mid-compact', midEvents);

  // 1. exportAllLocalSessions must export sess-healthy and defer sess-mid-compact without throwing
  const res1 = await exportAllLocalSessions({
    dshHome: winHome,
    vault: winVault,
    workspaceMappings: mappings,
    deviceLabel: 'WinGuard',
  });
  assert.equal(res1.exported.length, 1);
  assert.equal(res1.exported[0].rootSessionId, 'sess-healthy');
  assert.deepEqual(res1.deferredCompactionSessions, ['sess-mid-compact']);

  // Direct exportSessionClosure on mid-compaction session also defers cleanly
  const directDefer = await exportSessionClosure({
    dshHome: winHome,
    vault: winVault,
    sessionId: 'sess-mid-compact',
    workspaceMappings: mappings,
  });
  assert.equal(directDefer.deferred, true);
  assert.equal(directDefer.reason, 'unclosed-compaction');
  assert.deepEqual(directDefer.deferredCompactionSessions, ['sess-mid-compact']);

  // 2. Once compaction/end lands, export succeeds and Mac peer pulls cleanly with zero unclosed lock!
  midEvents.push({
    seq: 2,
    time: Date.now() + 2,
    type: 'compaction/end',
    data: { compactionId: 'cmp-mid', turn: null },
  });
  await writeSess('sess-mid-compact', midEvents);

  const res2 = await exportAllLocalSessions({
    dshHome: winHome,
    vault: winVault,
    workspaceMappings: mappings,
    deviceLabel: 'WinGuard',
  });
  assert.equal(res2.exported.length, 1, 'sess-mid-compact should be newly exported once compaction closes');
  assert.equal(res2.exported[0].rootSessionId, 'sess-mid-compact');
  assert.equal(res2.skippedUnchangedCount, 1, 'unchanged sess-healthy should skip redundant duplicate vault commit');
  assert.deepEqual(res2.deferredCompactionSessions, []);

  const pullRes = await pullSessionsFromVault({
    dshHome: macHome,
    vault: macVault,
    workspaceMappings: mappings,
    targetPlatform: 'darwin',
  });
  assert.equal(pullRes.summary.imported, 2);
});

test('Host plugin registers soul_recall_history via ctx.inject([tools]) and executes /soul compact end-to-end', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'host-compact-and-recall');
  const dshHome = path.join(caseDir, 'dsh-home');
  const vaultDir = path.join(caseDir, 'vault');
  const wsDir = path.join(caseDir, 'ws');
  await fs.mkdir(wsDir, { recursive: true });

  await saveConfig(dshHome, {
    deviceId: 'win-host-mc',
    deviceLabel: 'WinMC',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: false,
    workspaceMappings: [{ id: 'ws-mc', title: 'MC', win32: wsDir, darwin: '/Users/me/ws-mc' }],
  });

  const commands = new Map();
  const tools = new Map();
  const session = createMockSession({ id: 'sess-host-mc', cwd: wsDir });
  for (let t = 1; t <= 4; t += 1) {
    session.append('user/message', makeUserMsg(`第${t}轮核心命题：测算宁德时代2025Q3毛利率22.4%`.repeat(6)), { surfaceOp: 'append' });
    session.append('assistant/message', makeAssistantMsg([
      { type: 'reasoning', text: `第${t}轮思维链：已排除错误口径。`.repeat(4) },
      { type: 'text', text: `第${t}轮完成回复：指标已核对。`.repeat(6) },
    ]), { surfaceOp: 'append' });
  }

  const ctx = {
    on() { return () => {}; },
    inject(_deps, cb) { return cb(ctx); },
    effect() {},
    commands: { register(cmd) { commands.set(cmd.name, cmd); return () => commands.delete(cmd.name); } },
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name); } },
    sessions: { async flush() {} },
    llm: {
      stream() {
        const text = [
          '[压缩代次: G1]',
          SOUL_COMPACTION_SECTIONS[0],
          '- 宁德时代2025Q3毛利率锁定 22.4%',
          '',
          SOUL_COMPACTION_SECTIONS[1],
          '- 前两轮推演已收敛',
          '',
          SOUL_COMPACTION_SECTIONS[2],
          '- 排除错误口径',
          '',
          SOUL_COMPACTION_SECTIONS[3],
          '- (无)',
          '',
          SOUL_COMPACTION_SECTIONS[4],
          '- (无)',
          '',
          SOUL_COMPACTION_SECTIONS[5],
          `- ${SOUL_RECALL_HINT_LINE}`,
        ].join('\n');
        return chunksFromArray([
          { type: 'text-delta', index: 0, text },
          { type: 'block-end', index: 0, block: { type: 'text', text } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]);
      },
    },
  };

  const controller = applySoulSyncPlugin(ctx, { dshHome, platform: 'win32', minQuietMs: 0 });
  await controller.readyPromise;

  // Verify soul_recall_history is registered
  const recallTool = tools.get('soul_recall_history');
  assert.ok(recallTool, 'soul_recall_history tool must be registered via ctx.inject([tools])');

  // Execute /soul 帮我无损压缩一下 (keeps last 2 turns)
  const soulCmd = commands.get('soul');
  const compactRes = await soulCmd.handler({
    agent: { session, runMaintenance: (fn) => fn(new AbortController().signal) },
    rawInput: '整理一下上下文，保留 2 轮',
  });
  assert.equal(compactRes.kind, 'success', compactRes.text);
  assert.ok(compactRes.text.includes('保尾无损压缩完成'));
  assert.ok(compactRes.text.includes('保留末尾 2 轮'));

  // Now invoke soul_recall_history to pull shadowed Turn 1!
  const recallOut = await recallTool.execute({ query: '第1轮核心命题 22.4%' }, { agent: { session } });
  assert.ok(recallOut.includes('shadowed'));
  assert.ok(recallOut.includes('22.4%'));

  // Verify vault backup landed cleanly after compaction closed
  const vault = new VaultStore({ vaultDir, deviceId: 'obs', platform: 'darwin' });
  const commits = await vault.listCommits('session', { targetId: 'sess-host-mc', includeSelf: true });
  assert.equal(commits.commits.length, 1);

  await controller.dispose();
});
