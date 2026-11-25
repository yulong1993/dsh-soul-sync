import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  saveConfig,
  loadConfig,
  savePassphraseKey,
  writeFileAtomic,
  GLOBAL_AGENTS_RULES_MARKER,
} from '../lib/config.js';
import { encodeSegment, projectKey, encodeV4SessionLog } from '../lib/zstd-v4.js';
import { VaultStore } from '../lib/crypto-vault.js';
import { exportSessionClosure } from '../lib/session-plane.js';
import {
  recordDeliverableCandidate,
  pushWorkspaceDeliverables,
  loadWorkspaceDeliverableState,
} from '../lib/deliverable-plane.js';

import {
  SOUL_COMPACTION_INSTRUCTION,
  SOUL_COMPACTION_SECTIONS,
  DEFAULT_SOUL_RETAIN_RATIO,
  rewriteCompactionStreamOptions,
  createSoulCompactionPlugin,
} from '../lib/compaction-soul.js';
import {
  name as pluginName,
  apply as applySoulSyncPlugin,
  SoulSyncController,
} from '../lib/index.js';
import { parseNaturalSoulIntent } from '../lib/nl-router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_ROOT = path.join(REPO_ROOT, '.test-tmp', `plugin-compaction-${process.pid}-${Date.now()}`);

/**
 * Lightweight Cordis mock supporting `on`, `waterfall`, `emit`, `inject`, `effect`,
 * `commands.register`, and `sessions.flush`.
 */
function createMockCordisCtx({ flushImpl } = {}) {
  const listeners = new Map();
  const commands = new Map();
  const disposers = [];
  const flushCalls = [];

  const ctx = {
    on(eventName, fn) {
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(fn);
      return () => {
        const arr = listeners.get(eventName);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx !== -1) arr.splice(idx, 1);
      };
    },
    inject(_deps, cb) {
      return cb(ctx);
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') disposers.push(cleanup);
    },
    commands: {
      register(cmd) {
        commands.set(cmd.name, cmd);
        return () => commands.delete(cmd.name);
      },
      get(cmdName) {
        return commands.get(cmdName);
      },
    },
    sessions: {
      async flush(session) {
        flushCalls.push(session?.id ?? session?.header?.id ?? 'unknown');
        if (flushImpl) return flushImpl(session);
      },
    },
    async emit(eventName, ...args) {
      const arr = [...(listeners.get(eventName) ?? [])];
      const results = [];
      for (const fn of arr) {
        results.push(await fn(...args));
      }
      return results;
    },
    async waterfall(eventName, payload, baseHandler) {
      const arr = [...(listeners.get(eventName) ?? [])];
      let index = 0;
      const next = async () => {
        if (index < arr.length) {
          const fn = arr[index++];
          return fn(payload, next);
        }
        return baseHandler ? baseHandler(payload) : payload;
      };
      return next();
    },
    async disposeAll() {
      while (disposers.length > 0) {
        const fn = disposers.pop();
        await fn();
      }
    },
    _flushCalls: flushCalls,
    _commands: commands,
  };

  return ctx;
}

async function writeLocalSession(dshHome, header, events, version = header.version ?? 4) {
  const projDir = header.cwd ? projectKey(header.cwd) : '_no-cwd';
  const sessDir = path.join(dshHome, 'sessions', projDir, encodeSegment(header.id));
  await fs.mkdir(sessDir, { recursive: true });
  const logPath = path.join(sessDir, `session.v${version}.jsonl.zstd`);
  const encoded = await encodeV4SessionLog(header, events);
  await writeFileAtomic(logPath, encoded, { mode: 0o600 });
  return logPath;
}

test.after(async () => {
  await fs.rm(TEST_TMP_ROOT, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
});

test('compaction-soul: instruction contract, KV-cache prefix preservation, and llm/stream waterfall interception', async () => {
  assert.equal(DEFAULT_SOUL_RETAIN_RATIO, 0.25);
  assert.equal(SOUL_COMPACTION_SECTIONS.length, 6);

  // Verify all 6 required H2 sections appear in exact order
  let cursor = -1;
  for (const heading of SOUL_COMPACTION_SECTIONS) {
    const idx = SOUL_COMPACTION_INSTRUCTION.indexOf(heading);
    assert.ok(idx > cursor, `Missing or out-of-order heading: ${heading}`);
    cursor = idx;
  }

  // First-person native-language + Flash -> V4Pro visual bridge + scope isolation + DSH safety rules
  assert.match(SOUL_COMPACTION_INSTRUCTION, /第一人称/);
  assert.match(SOUL_COMPACTION_INSTRUCTION, /deepseek-v4-pro/i);
  assert.match(SOUL_COMPACTION_INSTRUCTION, /<compacted-summary>/);
  assert.match(SOUL_COMPACTION_INSTRUCTION, /\(无\)/);
  assert.match(SOUL_COMPACTION_INSTRUCTION, /议题作用域隔离/);

  // rewriteCompactionStreamOptions replaces ONLY last user message and keeps prefix references identical
  const sysMsg = { role: 'system', content: 'You are DSH.' };
  const userTurn1 = { role: 'user', content: [{ type: 'text', text: '帮我分析美股财报' }] };
  const assistantTurn1 = { role: 'assistant', content: [{ type: 'text', text: '好的，我先拉数据' }] };
  const origCompactionPrompt = { role: 'user', content: [{ type: 'text', text: 'Summarize the conversation above.' }] };

  const compactionOpts = {
    purpose: 'compaction',
    messages: [sysMsg, userTurn1, assistantTurn1, origCompactionPrompt],
  };

  const replaced = rewriteCompactionStreamOptions(compactionOpts);
  assert.equal(replaced, true);
  assert.equal(compactionOpts.messages.length, 4);
  assert.strictEqual(compactionOpts.messages[0], sysMsg);
  assert.strictEqual(compactionOpts.messages[1], userTurn1);
  assert.strictEqual(compactionOpts.messages[2], assistantTurn1);
  assert.equal(compactionOpts.messages[3].role, 'user');
  assert.equal(compactionOpts.messages[3].content[0].text, SOUL_COMPACTION_INSTRUCTION);

  // Non-compaction request MUST NOT be touched
  const normalPrompt = { role: 'user', content: [{ type: 'text', text: '继续写 DCF 脚本' }] };
  const chatOpts = {
    purpose: 'chat',
    messages: [sysMsg, normalPrompt],
  };
  assert.equal(rewriteCompactionStreamOptions(chatOpts), false);
  assert.strictEqual(chatOpts.messages[1], normalPrompt);
  assert.equal(chatOpts.messages[1].content[0].text, '继续写 DCF 脚本');

  // Standalone compaction plugin hooks llm/stream via Cordis waterfall
  const ctx = createMockCordisCtx();
  const compactionPlugin = createSoulCompactionPlugin();
  assert.equal(compactionPlugin.name, 'dsh-compaction-soul');
  await compactionPlugin.apply(ctx);

  const liveCompactionOpts = {
    purpose: 'compaction',
    messages: [userTurn1, { role: 'user', content: [{ type: 'text', text: 'OLD PROMPT' }] }],
  };
  await ctx.waterfall('llm/stream', liveCompactionOpts, (opts) => opts);
  assert.strictEqual(liveCompactionOpts.messages[0], userTurn1);
  assert.equal(liveCompactionOpts.messages[1].content[0].text, SOUL_COMPACTION_INSTRUCTION);
});

test('host plugin lifecycle: step/end 30s throttle, turn/end dual-plane sync, tools/result ledger, and session/disposed without flush', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'lifecycle');
  const dshHome = path.join(caseDir, 'dsh-home');
  const vaultDir = path.join(caseDir, 'vault');
  const wsDir = path.join(caseDir, 'ws-equity');
  await fs.mkdir(path.join(wsDir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(wsDir, 'outputs'), { recursive: true });

  const secretKeys = await savePassphraseKey(dshHome, 'lifecycle-secret-pass');
  await saveConfig(dshHome, {
    deviceId: 'win-office-01',
    deviceLabel: '公司Win台式机',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: true,
    workspaceMappings: [
      { id: 'ws-equity', title: '美股分析', win32: wsDir, darwin: '/Users/demo/ws-equity' },
    ],
    quotas: {
      stepSyncIntervalMs: 30000,
    },
  });

  const sessionId = 'sess-lifecycle-01';
  const header = {
    version: 4,
    id: sessionId,
    cwd: wsDir,
    createdAt: Date.now(),
  };
  const events = [
    { seq: 0, time: Date.now(), type: 'user/message', data: { content: [{ type: 'text', text: '写个 DCF 模型' }] } },
    { seq: 1, time: Date.now() + 10, type: 'assistant/message', data: { content: [{ type: 'text', text: '正在编写 scripts/dcf.py' }] } },
  ];
  await writeLocalSession(dshHome, header, events);

  let rejectFlush = false;
  const ctx = createMockCordisCtx({
    flushImpl: async () => {
      if (rejectFlush) {
        throw new Error('session is not live');
      }
    },
  });

  assert.equal(pluginName, 'dsh-soul-sync');
  const controller = await applySoulSyncPlugin(ctx, {
    dshHome,
    platform: 'win32',
    dshVersion: '0.2.2-rc.1',
    defaultModelTriple: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' },
    minQuietMs: 0,
  });
  await controller.readyPromise;

  // Startup ensured global AGENTS.md rules & published global commit
  const agentsContent = await fs.readFile(path.join(dshHome, 'AGENTS.md'), 'utf8');
  assert.ok(agentsContent.includes(GLOBAL_AGENTS_RULES_MARKER));

  const vault = new VaultStore({
    vaultDir,
    deviceId: 'observer-mac',
    platform: 'darwin',
    secretKeys,
  });
  const globalCommits = await vault.listCommits('global', { targetId: 'AGENTS.md', includeSelf: true });
  assert.equal(globalCommits.commits.length, 1);

  // Write a deliverable file and emit tools/result
  const dcfPath = path.join(wsDir, 'scripts', 'dcf.py');
  await fs.writeFile(dcfPath, 'print("dcf ok")\n', 'utf8');
  const sessionObj = {
    id: sessionId,
    cwd: wsDir,
    header,
    snapshotEvents: () => [...events],
  };

  await ctx.emit('tools/result', {
    toolName: 'write',
    input: { path: dcfPath },
    result: { ok: true },
    session: sessionObj,
    cwd: wsDir,
  });

  // First step/end -> flushes + exports session ONLY (must NOT publish workspace deliverables)
  await ctx.emit('session/event', sessionObj, { type: 'step/end', data: {} });
  assert.equal(ctx._flushCalls.length, 1);
  let sessCommits = await vault.listCommits('session', { targetId: sessionId, includeSelf: true });
  let wsCommits = await vault.listCommits('workspace', { targetId: 'ws-equity', includeSelf: true });
  assert.equal(sessCommits.commits.length, 1);
  assert.equal(wsCommits.commits.length, 0);

  // Second step/end immediately within 30s -> throttled!
  await ctx.emit('session/event', sessionObj, { type: 'step/end', data: {} });
  assert.equal(ctx._flushCalls.length, 1);
  sessCommits = await vault.listCommits('session', { targetId: sessionId, includeSelf: true });
  assert.equal(sessCommits.commits.length, 1);

  // deliverables/presented event + turn/end -> flushes, exports session, AND pushes workspace deliverables
  const reportPath = path.join(wsDir, 'outputs', 'summary.md');
  await fs.writeFile(reportPath, '# 估值结论\n核心假设清晰。\n', 'utf8');
  await ctx.emit('session/event', sessionObj, {
    type: 'deliverables/presented',
    data: { files: [{ path: reportPath }] },
  });
  events.push({
    seq: 2,
    time: Date.now() + 20,
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: '已完成脚本与报告' }] },
  });
  await writeLocalSession(dshHome, header, events);

  await ctx.emit('session/event', sessionObj, { type: 'turn/end', data: {} });
  assert.equal(ctx._flushCalls.length, 2);
  sessCommits = await vault.listCommits('session', { targetId: sessionId, includeSelf: true });
  wsCommits = await vault.listCommits('workspace', { targetId: 'ws-equity', includeSelf: true });
  assert.equal(sessCommits.commits.length, 2);
  assert.equal(wsCommits.commits.length, 1);
  assert.ok(wsCommits.commits[0].payload.tree['scripts/dcf.py']);
  assert.ok(wsCommits.commits[0].payload.tree['outputs/summary.md']);

  // session/disposed MUST NOT call ctx.sessions.flush (simulated to throw 'not live')
  rejectFlush = true;
  events.push({
    seq: 3,
    time: Date.now() + 30,
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: '关闭前最后一句' }] },
  });
  await assert.doesNotReject(async () => {
    await ctx.emit('session/disposed', sessionObj);
  });
  assert.equal(ctx._flushCalls.length, 2, 'session/disposed must never invoke ctx.sessions.flush');
  sessCommits = await vault.listCommits('session', { targetId: sessionId, includeSelf: true });
  assert.equal(sessCommits.commits.length, 3);
  assert.equal(sessCommits.commits[2].payload.nodes[0].eventCount, 4);

  // llm/stream compaction interception active inside main host plugin too
  const prefixMsg = { role: 'user', content: [{ type: 'text', text: '原始问题' }] };
  const streamOpts = {
    purpose: 'compaction',
    messages: [prefixMsg, { role: 'user', content: [{ type: 'text', text: 'Default compaction' }] }],
  };
  await ctx.waterfall('llm/stream', streamOpts, (o) => o);
  assert.strictEqual(streamOpts.messages[0], prefixMsg);
  assert.equal(streamOpts.messages[1].content[0].text, SOUL_COMPACTION_INSTRUCTION);

  await ctx.disposeAll();
});

test('cross-OS migration & agent/pre-step one-shot injection: Windows -> Encrypted Vault -> Mac', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'cross-os-prestep');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const macWsDir = '/Users/colleague/美股分析';

  const mappings = [
    { id: 'ws-proj', title: '投研项目', win32: 'D:\\美股分析', darwin: macWsDir },
  ];

  const winKeys = await savePassphraseKey(winHome, 'shared-vault-key');
  await savePassphraseKey(macHome, 'shared-vault-key');

  const winVault = new VaultStore({
    vaultDir,
    deviceId: 'win-desk-01',
    platform: 'win32',
    secretKeys: winKeys,
  });

  const sessionId = 'sess-win-to-mac-01';
  const winHeader = {
    version: 4,
    id: sessionId,
    cwd: 'D:\\美股分析',
    createdAt: Date.now() - 5000,
  };
  const winEvents = [
    { seq: 0, time: Date.now() - 4000, type: 'user/message', data: { content: [{ type: 'text', text: '在 Windows 上开始分析' }] } },
    { seq: 1, time: Date.now() - 3000, type: 'assistant/message', data: { content: [{ type: 'text', text: '我已在 Windows 上跑出初步脚本' }] } },
  ];

  await exportSessionClosure({
    dshHome: winHome,
    vault: winVault,
    sessionId,
    workspaceMappings: mappings,
    deviceLabel: '公司Win电脑',
    snapshot: { header: winHeader, events: winEvents },
  });

  // Boot Mac plugin (simulating targetPlatform === 'darwin')
  await saveConfig(macHome, {
    deviceId: 'mac-air-01',
    deviceLabel: 'MacBookAir',
    platform: 'darwin',
    vaultDir,
    encryptionEnabled: true,
    workspaceMappings: mappings,
  });

  const macCtx = createMockCordisCtx();
  const macController = await applySoulSyncPlugin(macCtx, {
    dshHome: macHome,
    platform: 'darwin',
    dshVersion: '0.2.2-rc.1',
    defaultModelTriple: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    minQuietMs: 0,
  });
  await macController.readyPromise;

  const mockAgent = {
    session: { id: sessionId, cwd: macWsDir },
  };
  const ac = new AbortController();

  // First agent/pre-step -> injects one-shot first-person cross-OS migration note
  const decision1 = await macCtx.waterfall(
    'agent/pre-step',
    { agent: mockAgent, signal: ac.signal },
    () => ({ kind: 'continue', messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '继续吧' }] }] }),
  );
  assert.equal(decision1.kind, 'continue');
  assert.equal(decision1.messages.length, 2);
  const injected = decision1.messages[1];
  assert.equal(injected.role, 'user');
  assert.ok(Object.isFrozen(injected), 'fallback UserMessage should be deeply frozen');
  const noteText = injected.content[0].text;
  assert.ok(noteText.includes('【跨设备接力备注】'));
  assert.ok(noteText.includes('公司Win电脑'));
  assert.ok(noteText.includes('win32'));
  assert.ok(noteText.includes('darwin'));
  assert.ok(noteText.includes('D:\\美股分析'));
  assert.ok(noteText.includes(macWsDir));

  // Second agent/pre-step -> MUST NOT re-inject
  const baseDecision2 = { kind: 'continue', messages: [{ id: 'm2', role: 'user', content: [{ type: 'text', text: '下一步呢' }] }] };
  const decision2 = await macCtx.waterfall(
    'agent/pre-step',
    { agent: mockAgent, signal: ac.signal },
    () => baseDecision2,
  );
  assert.equal(decision2.messages.length, 1);

  await macCtx.disposeAll();
});

test('/soul commands: status (Flash vs V4Pro + Office lock), handoff (agent.steer + baton), keep, pull (.dsh-incoming drain), and config', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'slash-commands');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  const macWs = path.join(caseDir, 'mac-ws');
  await fs.mkdir(path.join(winWs, 'notes'), { recursive: true });
  await fs.mkdir(path.join(macWs, 'outputs'), { recursive: true });

  const mappings = [
    { id: 'ws-fund', title: '半导体研报', win32: winWs, darwin: macWs },
  ];

  const keys = await savePassphraseKey(winHome, 'cmd-secret');
  await savePassphraseKey(macHome, 'cmd-secret');

  // Peer (Mac) writes a heartbeat with deepseek-flash + publishes a workspace file
  const macVault = new VaultStore({
    vaultDir,
    deviceId: 'mac-home-01',
    platform: 'darwin',
    secretKeys: keys,
  });
  await macVault.writeHeartbeat({
    deviceLabel: '家里Mac',
    dshVersion: '0.2.2-rc.1',
    defaultModelTriple: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'medium' },
    status: 'active',
    baton: { state: 'released-for-handoff', holder: '家里Mac', releasedAt: Date.now() - 2000 },
  });

  // Mac produces outputs/估值表.xlsx and pushes to vault
  const macXlsx = path.join(macWs, 'outputs', '估值表.xlsx');
  // Valid minimal ZIP EOCD trailer so container guard accepts it
  const validXlsxBytes = Buffer.concat([Buffer.from('PK\x03\x04dummy-xlsx-v2', 'binary'), Buffer.from('PK\x05\x06', 'binary'), Buffer.alloc(18)]);
  await fs.writeFile(macXlsx, validXlsxBytes);
  await pushWorkspaceDeliverables({
    dshHome: macHome,
    vault: macVault,
    workspaceId: 'ws-fund',
    workspaceRoot: macWs,
    deviceLabel: '家里Mac',
    minQuietMs: 0,
  });

  // On Windows side, simulate user currently has Excel open on outputs/估值表.xlsx (`~$估值表.xlsx`)
  await fs.mkdir(path.join(winWs, 'outputs'), { recursive: true });
  const winLockPath = path.join(winWs, 'outputs', '~$估值表.xlsx');
  await fs.writeFile(winLockPath, 'excel-lock', 'utf8');

  await saveConfig(winHome, {
    deviceId: 'win-office-02',
    deviceLabel: '办公室Win',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: true,
    workspaceMappings: mappings,
  });

  const ctx = createMockCordisCtx();
  const controller = await applySoulSyncPlugin(ctx, {
    dshHome: winHome,
    platform: 'win32',
    dshVersion: '0.2.2-rc.1',
    defaultModelTriple: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    minQuietMs: 0,
  });
  await controller.readyPromise;

  const soulCmd = ctx.commands.get('soul');
  assert.ok(soulCmd, '/soul command must be registered');

  const steeredMessages = [];
  const sessionId = 'sess-cmd-01';
  const sessionHeader = { version: 4, id: sessionId, cwd: winWs, createdAt: Date.now() };
  const sessionEvents = [
    { seq: 0, time: Date.now(), type: 'user/message', data: { content: [{ type: 'text', text: '复盘一下估值模型' }] } },
  ];
  await writeLocalSession(winHome, sessionHeader, sessionEvents);

  const mockAgent = {
    session: { id: sessionId, cwd: winWs, header: sessionHeader, snapshotEvents: () => sessionEvents },
    async steer(msg) {
      steeredMessages.push(msg);
    },
  };

  // 1) /soul status: Flash vs V4Pro notice + ~$估值表.xlsx lock warning + .dsh-incoming staged notice
  const statusRes = await soulCmd.handler({ agent: mockAgent, rawInput: 'status' });
  assert.equal(statusRes.kind, 'success');
  assert.ok(statusRes.text.includes('双机接力体检卡'));
  assert.ok(statusRes.text.includes('AES-256-GCM'));
  assert.ok(statusRes.text.includes('检测到双端默认模型档位不同'));
  assert.ok(statusRes.text.includes('视觉文字桥接保护'));
  assert.ok(statusRes.text.includes('~$估值表.xlsx'));
  assert.ok(statusRes.text.includes('.dsh-incoming'));

  // 2) /soul handoff: warns about Excel lock, calls agent.steer, and marks baton released-for-handoff
  const handoffRes = await soulCmd.handler({ agent: mockAgent, rawInput: 'handoff 晚上回家用 Mac 继续拆利润表' });
  assert.equal(handoffRes.kind, 'success');
  assert.ok(handoffRes.text.includes('~$估值表.xlsx'), 'handoff should warn about open Excel lock');
  assert.equal(steeredMessages.length, 1);
  const steerText = steeredMessages[0].content[0].text;
  assert.ok(steerText.includes('第一人称'));
  assert.ok(steerText.includes('中场交接心路日记'));
  assert.ok(steerText.includes('deepseek-v4-pro'));
  assert.ok(steerText.includes('晚上回家用 Mac 继续拆利润表'));

  const hbsAfterHandoff = await macVault.readHeartbeats();
  const winHb = hbsAfterHandoff.find((h) => h.deviceId === 'win-office-02');
  assert.equal(winHb?.baton?.state, 'released-for-handoff');
  assert.equal(winHb?.baton?.note, undefined, 'encrypted mode must omit plaintext baton.note from heartbeat.json');
  const rawWinHbText = await fs.readFile(path.join(vaultDir, 'devices', 'win-office-02', 'heartbeat.json'), 'utf8');
  assert.equal(
    rawWinHbText.includes('晚上回家用 Mac 继续拆利润表'),
    false,
    'encrypted mode heartbeat.json must not leak plaintext handoff note',
  );

  // 3) Close Excel (remove ~$ lock) -> /soul pull drains .dsh-incoming/ into outputs/估值表.xlsx!
  await fs.rm(winLockPath, { force: true });
  const pullRes = await soulCmd.handler({ agent: mockAgent, rawInput: 'pull' });
  assert.equal(pullRes.kind, 'success');
  const landedBytes = await fs.readFile(path.join(winWs, 'outputs', '估值表.xlsx'));
  assert.ok(landedBytes.equals(validXlsxBytes));

  // 4) /soul keep notes/thesis.md -> manually tracks and immediately pushes
  const thesisPath = path.join(winWs, 'notes', 'thesis.md');
  await fs.writeFile(thesisPath, '# 核心逻辑\n护城河来自工艺良率。\n', 'utf8');
  const keepRes = await soulCmd.handler({ agent: mockAgent, rawInput: 'keep notes/thesis.md' });
  assert.equal(keepRes.kind, 'success');
  const wsState = await loadWorkspaceDeliverableState(winHome, 'ws-fund');
  assert.equal(wsState.trackedPaths['notes/thesis.md']?.source, 'manual');
  const winWsCommits = await macVault.listCommits('workspace', { targetId: 'ws-fund', includeSelf: true });
  const latestWinCommit = winWsCommits.commits.find((c) => c.deviceId === 'win-office-02');
  assert.ok(latestWinCommit?.payload?.tree?.['notes/thesis.md']);

  // 5) /soul config maxFileMB=50 maxWorkspaceMB=1000 retainSnapshots=15
  const cfgRes = await soulCmd.handler({
    agent: mockAgent,
    rawInput: 'config maxFileMB=50 maxWorkspaceMB=1000 retainSnapshots=15',
  });
  assert.equal(cfgRes.kind, 'success');
  const reloadedCfg = await loadConfig(winHome);
  assert.equal(reloadedCfg.quotas.maxFileBytes, 50 * 1024 * 1024);
  assert.equal(reloadedCfg.quotas.maxWorkspaceBytes, 1000 * 1024 * 1024);
  assert.equal(reloadedCfg.quotas.retainSnapshots, 15);
  assert.equal(controller.vault.quotas.retainSnapshots, 15);

  // Invalid config value returns error
  const badCfgRes = await soulCmd.handler({ agent: mockAgent, rawInput: 'config maxFileMB=-5' });
  assert.equal(badCfgRes.kind, 'error');

  await ctx.disposeAll();
});

test('skills/soul-handoff/SKILL.md: strict DSH YAML frontmatter and required workflow guidance', async () => {
  const skillPath = path.join(REPO_ROOT, 'skills', 'soul-handoff', 'SKILL.md');
  const raw = await fs.readFile(skillPath, 'utf8');

  // No UTF-8 BOM
  assert.notEqual(raw.charCodeAt(0), 0xFEFF, 'SKILL.md must be UTF-8 without BOM');

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(raw);
  assert.ok(fmMatch, 'SKILL.md must begin with strict YAML frontmatter fences');

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  const nameMatch = /^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/m.exec(frontmatter);
  assert.ok(nameMatch, 'frontmatter must contain kebab-case name');
  assert.equal(nameMatch[1], 'soul-handoff');

  const descMatch = /^description:\s*(.+)$/m.exec(frontmatter);
  assert.ok(descMatch && descMatch[1].trim().length >= 10, 'frontmatter must contain a non-empty description');

  assert.match(body, /中场交接心路日记/);
  assert.match(body, /第一人称/);
  assert.match(body, /deepseek-v4-pro/i);
  assert.match(body, /parallel\(\s*\(\)\s*=>\s*agent\(/);
});

test('SoulSyncController._detectDefaultModelTriple reads cordis.patch.yml before empty cordis.yml', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'detect-model-patch');

  // Case 1: desktop profile has empty cordis.yml ([]) and agent-default-model in cordis.patch.yml (deepseek-v4-pro)
  const homeV4 = path.join(caseDir, 'home-v4pro');
  const desktopDir = path.join(homeV4, 'profiles', 'desktop');
  await fs.mkdir(desktopDir, { recursive: true });
  await fs.writeFile(path.join(desktopDir, 'cordis.yml'), '[]\n', 'utf8');
  await fs.writeFile(
    path.join(desktopDir, 'cordis.patch.yml'),
    [
      '- id: some-other-plugin',
      '  config:',
      '    enabled: true',
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek',
      '    model: deepseek-v4-pro',
      '    reasoningEffort: high',
    ].join('\n') + '\n',
    'utf8',
  );

  const ctrlV4 = new SoulSyncController(null, { dshHome: homeV4, platform: 'win32' });
  const tripleV4 = await ctrlV4._detectDefaultModelTriple();
  assert.deepEqual(tripleV4, {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  });

  // Case 2: web profile has empty cordis.yml and deepseek-flash in cordis.patch.yml
  const homeFlash = path.join(caseDir, 'home-flash');
  const webDir = path.join(homeFlash, 'profiles', 'web');
  await fs.mkdir(webDir, { recursive: true });
  await fs.writeFile(path.join(webDir, 'cordis.yml'), '[]\n', 'utf8');
  await fs.writeFile(
    path.join(webDir, 'cordis.patch.yml'),
    [
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek',
      '    model: deepseek-flash',
      '    reasoningEffort: medium',
    ].join('\n') + '\n',
    'utf8',
  );

  const ctrlFlash = new SoulSyncController(null, { dshHome: homeFlash, platform: 'darwin' });
  const tripleFlash = await ctrlFlash._detectDefaultModelTriple();
  assert.deepEqual(tripleFlash, {
    provider: 'deepseek',
    model: 'deepseek-flash',
    reasoningEffort: 'medium',
  });
});

test('/soul config vaultDir hot-rebuilds controller.vault and tools/result extracts payload.meta & payload.result.meta paths', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'config-vault-and-meta');
  const dshHome = path.join(caseDir, 'home');
  const vaultA = path.join(caseDir, 'vault-a');
  const vaultB = path.join(caseDir, 'vault-b');
  const wsDir = path.join(caseDir, 'ws');
  await fs.mkdir(vaultA, { recursive: true });
  await fs.mkdir(vaultB, { recursive: true });
  await fs.mkdir(path.join(wsDir, 'outputs'), { recursive: true });

  await saveConfig(dshHome, {
    deviceId: 'win-hot-cfg',
    deviceLabel: 'HotConfigWin',
    platform: 'win32',
    vaultDir: vaultA,
    encryptionEnabled: false,
    workspaceMappings: [{ id: 'ws-hot', title: 'Hot', win32: wsDir, darwin: '/Users/me/hot' }],
  });

  const controller = new SoulSyncController(null, { dshHome, platform: 'win32', minQuietMs: 0 });
  await controller.reloadConfig();
  assert.equal(controller.vault.vaultDir, path.resolve(vaultA));

  // Hot-update vaultDir via handleConfig -> controller.vault must immediately point to vaultB
  const cfgRes = await controller.handleConfig({ argsText: `vaultDir=${vaultB}` });
  assert.equal(cfgRes.kind, 'success');
  assert.equal(controller.vault.vaultDir, path.resolve(vaultB));

  // Unsupported key error message must include vaultDir and fallbackDir
  const unknownRes = await controller.handleConfig({ argsText: 'noSuchKey=123' });
  assert.equal(unknownRes.kind, 'error');
  assert.ok(unknownRes.text.includes('vaultDir'));
  assert.ok(unknownRes.text.includes('fallbackDir'));

  // extractToolPaths via handleToolsResult must capture payload.meta.path and payload.result.meta.path
  await controller.handleToolsResult({
    toolName: 'write_file',
    cwd: wsDir,
    meta: { path: path.join(wsDir, 'outputs', 'from-meta.txt') },
  });
  await controller.handleToolsResult({
    toolName: 'edit_file',
    cwd: wsDir,
    result: { meta: { path: 'outputs/from-result-meta.txt' } },
  });

  const wsState = await loadWorkspaceDeliverableState(dshHome, 'ws-hot');
  assert.ok(wsState.trackedPaths['outputs/from-meta.txt'], 'payload.meta.path should be tracked');
  assert.ok(wsState.trackedPaths['outputs/from-result-meta.txt'], 'payload.result.meta.path should be tracked');
  await controller.dispose();
});

test('stepSyncEnabled toggle: default true, disables step/end while keeping turn/end intact, status card & config & NL toggle', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'step-sync-toggle');
  const dshHome = path.join(caseDir, 'dsh-home');
  const vaultDir = path.join(caseDir, 'vault');
  const wsDir = path.join(caseDir, 'ws-toggle');
  await fs.mkdir(path.join(wsDir, 'outputs'), { recursive: true });

  // Default config has stepSyncEnabled === true
  const defaultCfg = await loadConfig(dshHome);
  assert.equal(defaultCfg.stepSyncEnabled, true);

  await saveConfig(dshHome, {
    deviceId: 'win-toggle-01',
    deviceLabel: '稳妥派Win',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: false,
    stepSyncEnabled: false,
    workspaceMappings: [
      { id: 'ws-toggle', title: '稳妥项目', win32: wsDir, darwin: '/Users/me/ws-toggle' },
    ],
  });
  const loadedDisabled = await loadConfig(dshHome);
  assert.equal(loadedDisabled.stepSyncEnabled, false);

  const sessionId = 'sess-step-toggle-01';
  const header = { version: 4, id: sessionId, cwd: wsDir, createdAt: Date.now() };
  const events = [
    { seq: 0, time: Date.now(), type: 'user/message', data: { content: [{ type: 'text', text: '测试关闭30秒快照' }] } },
  ];
  await writeLocalSession(dshHome, header, events);

  const ctx = createMockCordisCtx();
  const controller = await applySoulSyncPlugin(ctx, {
    dshHome,
    platform: 'win32',
    minQuietMs: 0,
  });
  await controller.readyPromise;

  const soulCmd = ctx.commands.get('soul');
  const vault = new VaultStore({ vaultDir, deviceId: 'observer', platform: 'darwin' });
  const sessionObj = { id: sessionId, cwd: wsDir, header, snapshotEvents: () => [...events] };

  // Status card clearly shows disabled state
  const statusOff = await soulCmd.handler({ rawInput: 'status' });
  assert.equal(statusOff.kind, 'success');
  assert.ok(statusOff.text.includes('步级防断电快照（运行中每30秒）'));
  assert.ok(statusOff.text.includes('已关闭'));
  assert.ok(statusOff.text.includes('/soul 开启30秒快照'));

  // Config overview shows stepSyncEnabled: false
  const cfgOverview = await soulCmd.handler({ rawInput: 'config' });
  assert.equal(cfgOverview.kind, 'success');
  assert.ok(cfgOverview.text.includes('`stepSyncEnabled`: false'));

  // When stepSyncEnabled === false, step/end MUST NOT flush or export session
  await ctx.emit('session/event', sessionObj, { type: 'step/end', data: {} });
  assert.equal(ctx._flushCalls.length, 0);
  let sessCommits = await vault.listCommits('session', { targetId: sessionId, includeSelf: true });
  assert.equal(sessCommits.commits.length, 0);

  // turn/end MUST STILL export session AND workspace deliverables 100% normally
  await fs.writeFile(path.join(wsDir, 'outputs', 'report.md'), '# 完稿\n', 'utf8');
  await ctx.emit('session/event', sessionObj, { type: 'turn/end', data: {} });
  assert.equal(ctx._flushCalls.length, 1);
  sessCommits = await vault.listCommits('session', { targetId: sessionId, includeSelf: true });
  let wsCommits = await vault.listCommits('workspace', { targetId: 'ws-toggle', includeSelf: true });
  assert.equal(sessCommits.commits.length, 1);
  assert.equal(wsCommits.commits.length, 1);

  // Toggle ON via natural language: /soul 开启30秒防灾快照
  const nlOnRes = await soulCmd.handler({ rawInput: '开启30秒防灾快照' });
  assert.equal(nlOnRes.kind, 'success');
  assert.equal((await loadConfig(dshHome)).stepSyncEnabled, true);
  assert.equal(controller.config.stepSyncEnabled, true);

  const statusOn = await soulCmd.handler({ rawInput: 'status' });
  assert.ok(statusOn.text.includes('已开启'));
  assert.ok(statusOn.text.includes('/soul 关闭30秒快照'));

  // Now step/end triggers export!
  await ctx.emit('session/event', sessionObj, { type: 'step/end', data: {} });
  assert.equal(ctx._flushCalls.length, 2);
  sessCommits = await vault.listCommits('session', { targetId: sessionId, includeSelf: true });
  assert.equal(sessCommits.commits.length, 2);

  // Toggle OFF via /soul config stepSync=off and back ON via stepSyncEnabled=1
  const cfgOff = await soulCmd.handler({ rawInput: 'config stepSync=off' });
  assert.equal(cfgOff.kind, 'success');
  assert.equal((await loadConfig(dshHome)).stepSyncEnabled, false);

  const cfgOn = await soulCmd.handler({ rawInput: 'config stepSyncEnabled=1' });
  assert.equal(cfgOn.kind, 'success');
  assert.equal((await loadConfig(dshHome)).stepSyncEnabled, true);

  // Toggle OFF via natural language: /soul 关闭30秒自动快照
  const nlOffRes = await soulCmd.handler({ rawInput: '关闭30秒自动快照' });
  assert.equal(nlOffRes.kind, 'success');
  assert.equal((await loadConfig(dshHome)).stepSyncEnabled, false);

  await ctx.disposeAll();
});

test('nl-router & /soul natural-language routing: all Tier-1 direct intents and Tier-2 agent-assist delegation', async () => {
  // Unit checks on parseNaturalSoulIntent
  assert.deepEqual(parseNaturalSoulIntent('关闭30秒自动快照'), { kind: 'set-step-sync', enabled: false });
  assert.deepEqual(parseNaturalSoulIntent('把每30秒备份关掉免得出问题'), { kind: 'set-step-sync', enabled: false });
  assert.deepEqual(parseNaturalSoulIntent('停用步级同步'), { kind: 'set-step-sync', enabled: false });
  assert.deepEqual(parseNaturalSoulIntent('开启30秒快照'), { kind: 'set-step-sync', enabled: true });
  assert.deepEqual(parseNaturalSoulIntent('打开步级备份'), { kind: 'set-step-sync', enabled: true });

  assert.deepEqual(parseNaturalSoulIntent('把单文件上限改成 100M'), { kind: 'config', argsText: 'maxFileMB=100' });
  assert.deepEqual(parseNaturalSoulIntent('单文件上限 1G'), { kind: 'config', argsText: 'maxFileMB=1024' });
  assert.deepEqual(parseNaturalSoulIntent('工作区总上限改成 1G'), { kind: 'config', argsText: 'maxWorkspaceMB=1024' });
  assert.deepEqual(parseNaturalSoulIntent('历史版本保留 20 份'), { kind: 'config', argsText: 'retainSnapshots=20' });
  assert.deepEqual(parseNaturalSoulIntent('快照间隔改成 60 秒'), { kind: 'config', argsText: 'stepSyncSeconds=60' });

  const mapIntent = parseNaturalSoulIntent('帮我绑定目录 D:\\港股研究 到 /Users/alice/港股研究');
  assert.equal(mapIntent.kind, 'add-mapping');
  assert.equal(mapIntent.winPath, 'D:\\港股研究');
  assert.equal(mapIntent.macPath, '/Users/alice/港股研究');

  assert.equal(parseNaturalSoulIntent('帮我看看现在同步正常吗').kind, 'status');
  assert.equal(parseNaturalSoulIntent('有没有没关的Excel锁').kind, 'status');

  const handoffIntent = parseNaturalSoulIntent('我准备下班回家用Mac继续算毛利率了');
  assert.equal(handoffIntent.kind, 'handoff');
  assert.equal(handoffIntent.extraNote, '我准备下班回家用Mac继续算毛利率了');

  assert.deepEqual(parseNaturalSoulIntent('帮我把 notes/核心假设.md 也加进同步'), {
    kind: 'keep',
    targetPath: 'notes/核心假设.md',
  });
  assert.deepEqual(parseNaturalSoulIntent('把 outputs/估值模型.xlsx 同步上'), {
    kind: 'keep',
    targetPath: 'outputs/估值模型.xlsx',
  });

  // Must NOT misclassify generic sync progress without file path as `keep`
  assert.equal(parseNaturalSoulIntent('帮我把最新进度同步一下').kind, 'sync');
  assert.equal(parseNaturalSoulIntent('同步').kind, 'sync');
  assert.equal(parseNaturalSoulIntent('同步一下').kind, 'sync');
  assert.equal(parseNaturalSoulIntent('接力').kind, 'sync');
  assert.equal(parseNaturalSoulIntent('恢复').kind, 'sync');
  assert.equal(parseNaturalSoulIntent('刷新').kind, 'sync');
  assert.equal(parseNaturalSoulIntent('sync').kind, 'sync');

  assert.equal(parseNaturalSoulIntent('把家里Mac改过的东西拉下来').kind, 'pull');
  assert.equal(parseNaturalSoulIntent('我把Excel关了帮我把暂存文件落位').kind, 'pull');
  assert.equal(parseNaturalSoulIntent('帮我把现在的进度马上备份一下').kind, 'push');
  assert.deepEqual(parseNaturalSoulIntent('compact'), { kind: 'compact', keepTurns: 3 });
  assert.deepEqual(parseNaturalSoulIntent('帮我无损压缩一下'), { kind: 'compact', keepTurns: 3 });
  assert.equal(parseNaturalSoulIntent('怎么用').kind, 'help');
  assert.equal(parseNaturalSoulIntent('help').kind, 'help');

  // Unrecognized / complex requests MUST NOT hijack active AI session -> instant `help-with-status`
  assert.equal(parseNaturalSoulIntent('帮我对比一下冲突副本和现在的估值表差在哪并合并').kind, 'help-with-status');
  assert.equal(parseNaturalSoulIntent('帮我看看今天新建的几个脚本哪些还没进同步账本，挑重要的同步上去').kind, 'help-with-status');
  assert.equal(parseNaturalSoulIntent('帮我排查一下为什么刚才有个文件被拦截了').kind, 'help-with-status');

  // End-to-end execution through SoulSyncController /soul command
  const caseDir = path.join(TEST_TMP_ROOT, 'nl-e2e');
  const dshHome = path.join(caseDir, 'dsh-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  const macWs = '/Users/alice/us-equity';
  await fs.mkdir(path.join(winWs, 'notes'), { recursive: true });
  await fs.mkdir(path.join(winWs, 'outputs'), { recursive: true });

  await saveConfig(dshHome, {
    deviceId: 'win-nl-01',
    deviceLabel: '公司Win',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: false,
    workspaceMappings: [
      { id: 'ws-nl', title: '美股分析', win32: winWs, darwin: macWs },
    ],
  });

  const ctx = createMockCordisCtx();
  const controller = await applySoulSyncPlugin(ctx, { dshHome, platform: 'win32', minQuietMs: 0, pollIntervalMs: 0 });
  await controller.readyPromise;
  const soulCmd = ctx.commands.get('soul');

  const steered = [];
  const sessionId = 'sess-nl-01';
  const header = { version: 4, id: sessionId, cwd: winWs, createdAt: Date.now() };
  const events = [
    { seq: 0, time: Date.now(), type: 'user/message', data: { content: [{ type: 'text', text: '测试自然语言' }] } },
  ];
  await writeLocalSession(dshHome, header, events);

  const mockAgent = {
    session: { id: sessionId, cwd: winWs, header, snapshotEvents: () => events },
    async steer(msg) {
      steered.push(msg);
    },
  };

  // 1) NL status
  const nlStatus = await soulCmd.handler({ agent: mockAgent, rawInput: '帮我看看现在同步正常吗' });
  assert.equal(nlStatus.kind, 'success');
  assert.ok(nlStatus.text.includes('双机接力体检卡'));

  // 2) NL config quota (100M / 1G)
  const nlQuota1 = await soulCmd.handler({ agent: mockAgent, rawInput: '把单文件上限改成 100M' });
  assert.equal(nlQuota1.kind, 'success');
  const nlQuota2 = await soulCmd.handler({ agent: mockAgent, rawInput: '工作区总上限改成 1G' });
  assert.equal(nlQuota2.kind, 'success');
  let cfg = await loadConfig(dshHome);
  assert.equal(cfg.quotas.maxFileBytes, 100 * 1024 * 1024);
  assert.equal(cfg.quotas.maxWorkspaceBytes, 1024 * 1024 * 1024);

  // 3) NL add-mapping
  const nlMap = await soulCmd.handler({
    agent: mockAgent,
    rawInput: '帮我绑定跨系统目录 D:\\港股研究 到 /Users/alice/港股研究',
  });
  assert.equal(nlMap.kind, 'success');
  cfg = await loadConfig(dshHome);
  assert.ok(
    cfg.workspaceMappings.some((m) => m.win32 === 'D:\\港股研究' && m.darwin === '/Users/alice/港股研究'),
    'workspaceMappings should include newly bound mapping',
  );

  // 4) NL keep with file path
  await fs.writeFile(path.join(winWs, 'notes', '核心假设.md'), '# 假设\n毛利率 72%\n', 'utf8');
  const nlKeep = await soulCmd.handler({ agent: mockAgent, rawInput: '帮我把 notes/核心假设.md 也加进同步' });
  assert.equal(nlKeep.kind, 'success');
  const wsState = await loadWorkspaceDeliverableState(dshHome, 'ws-nl');
  assert.equal(wsState.trackedPaths['notes/核心假设.md']?.source, 'manual');

  // 5) NL push, pull, and deterministic bidirectional sync
  const nlPush = await soulCmd.handler({ agent: mockAgent, rawInput: '帮我把现在的进度马上备份一下' });
  assert.equal(nlPush.kind, 'success');
  assert.ok(nlPush.text.includes('推送完成'));

  const nlPull = await soulCmd.handler({ agent: mockAgent, rawInput: '把家里Mac改过的东西拉下来' });
  assert.equal(nlPull.kind, 'success');
  assert.ok(nlPull.text.includes('拉取完成'));

  const nlSync = await soulCmd.handler({ agent: mockAgent, rawInput: '同步一下' });
  assert.equal(nlSync.kind, 'success');
  assert.ok(nlSync.text.includes('双向同步完成'));

  // 6) NL handoff -> triggers agent.steer with handoff diary prompt
  const nlHandoff = await soulCmd.handler({ agent: mockAgent, rawInput: '我准备下班回家用Mac继续算毛利率了' });
  assert.equal(nlHandoff.kind, 'success');
  assert.equal(steered.length, 1);
  assert.ok(steered[0].content[0].text.includes('中场交接心路日记'));
  assert.ok(steered[0].content[0].text.includes('我准备下班回家用Mac继续算毛利率了'));

  // 7) NL help
  const nlHelp = await soulCmd.handler({ agent: mockAgent, rawInput: '你能帮我干嘛' });
  assert.equal(nlHelp.kind, 'success');
  assert.ok(nlHelp.text.includes('/soul'));

  // 8) Unrecognized / complex request -> instant cheat-sheet + status card, ZERO steer/LLM hijacking!
  const nlUnrecognized = await soulCmd.handler({
    agent: mockAgent,
    rawInput: '帮我对比一下冲突副本和现在的估值表差在哪并合并',
  });
  assert.equal(nlUnrecognized.kind, 'success');
  assert.ok(nlUnrecognized.text.includes('Soul Sync 速查指南'));
  assert.ok(nlUnrecognized.text.includes('双机接力体检卡'));
  assert.equal(steered.length, 1, 'Unrecognized /soul input must NEVER hijack AI via agent.steer');

  // 9) Offline unrecognized request also returns instant cheat-sheet + status card
  const nlUnrecognizedOffline = await soulCmd.handler({
    agent: null,
    rawInput: '帮我排查一下为什么刚才有个文件被拦截了',
  });
  assert.equal(nlUnrecognizedOffline.kind, 'success');
  assert.ok(nlUnrecognizedOffline.text.includes('双机接力体检卡'));

  await ctx.disposeAll();
});

test('background 15s poller auto-pulls new peer commits silently & volatile Settings UI sync persists config.json + secret.key + heartbeat lastBackupAt', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'poller-and-settings');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  const macWs = path.join(caseDir, 'mac-ws');
  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(macWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  // Simulate volatile refs like Cordis passes from Schemastery `.volatile()` fields
  const makeVolatile = (initial) => {
    let val = initial;
    return {
      get: () => val,
      set: (next) => { val = next; },
    };
  };

  const vVault = makeVolatile('');
  const vPass = makeVolatile('');
  const vStepSync = makeVolatile(true);
  const vLabel = makeVolatile('');

  const ctx = createMockCordisCtx();
  const controller = await applySoulSyncPlugin(ctx, {
    dshHome: winHome,
    platform: 'win32',
    minQuietMs: 0,
    pollIntervalMs: 60,
    vaultDir: vVault,
    passphrase: vPass,
    stepSyncEnabled: vStepSync,
    deviceLabel: vLabel,
  });
  await controller.readyPromise;
  assert.equal(controller.vault, null, 'Vault is null before user configures Settings UI');

  // Simulate user filling in DSH Settings -> Plugins -> Soul Sync form!
  vVault.set(vaultDir);
  vPass.set('ui-settings-secret-2026');
  vStepSync.set(false);
  vLabel.set('图形设置Win');
  await ctx.emit('settings/document-updated', 'dsh-soul-sync');
  // Wait briefly for async syncVolatileSettings
  await new Promise((r) => setTimeout(r, 120));

  const savedCfg = await loadConfig(winHome);
  assert.equal(savedCfg.vaultDir, path.resolve(vaultDir));
  assert.equal(savedCfg.encryptionEnabled, true);
  assert.equal(savedCfg.stepSyncEnabled, false);
  assert.equal(savedCfg.deviceLabel, '图形设置Win');
  assert.ok(controller.vault?.encrypted, 'Controller vault should hot-reload in encrypted mode');

  // Now simulate Mac peer publishing a brand-new encrypted session into vaultDir while Win DSH is idling
  const macKeys = await savePassphraseKey(macHome, 'ui-settings-secret-2026');
  const macVault = new VaultStore({ vaultDir, deviceId: 'mac-poller-peer', platform: 'darwin', secretKeys: macKeys });
  const peerSid = 'sess-bg-polled-01';
  await writeLocalSession(
    macHome,
    { type: 'session', version: 4, id: peerSid, createdAt: Date.now(), cwd: macWs, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: Date.now(), type: 'user/message', data: { content: [{ type: 'text', text: '后台15秒无感拉取测试' }] } }],
  );
  await exportSessionClosure({
    dshHome: macHome,
    vault: macVault,
    sessionId: peerSid,
    workspaceMappings: [{ id: 'w-poll', title: 'Poll', win32: winWs, darwin: macWs }],
  });

  // Add workspace mapping so polled session lands cleanly in winWs, then wait for background poll tick!
  await saveConfig(winHome, {
    workspaceMappings: [{ id: 'w-poll', title: 'Poll', win32: winWs, darwin: macWs }],
  });
  await controller.reloadConfig();

  const deadline = Date.now() + 2000;
  let pulledPath = null;
  while (Date.now() < deadline) {
    const cand = path.join(winHome, 'sessions', projectKey(winWs), encodeSegment(peerSid), 'session.v4.jsonl.zstd');
    try {
      await fs.stat(cand);
      pulledPath = cand;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  assert.ok(pulledPath, 'Background poller should automatically pull newly arrived peer commit without any command');

  // Verify reloadConfig restores _lastBackupAt from local device heartbeat.json on fresh restart
  const priorBackupTs = Date.now() - 45000;
  await controller.vault.writeHeartbeat({ deviceLabel: '图形设置Win', lastBackupAt: priorBackupTs });
  const freshCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', pollIntervalMs: 0 });
  await freshCtrl.reloadConfig();
  assert.equal(freshCtrl._lastBackupAt, priorBackupTs);
  await freshCtrl.dispose();

  await ctx.disposeAll();
});
