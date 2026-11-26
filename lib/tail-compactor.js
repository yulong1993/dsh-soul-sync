import crypto from 'node:crypto';

import {
  SOUL_COMPACTION_INSTRUCTION,
  SUMMARY_OPEN_TAG,
  SUMMARY_CLOSE_TAG,
  CHECKPOINT_PREAMBLE,
  buildSoulCompactionInstruction,
  detectCompactionGeneration,
  ensureCompactionGenerationTag,
  estimateMessageTokens,
  estimateFramedSummaryTokens,
  compressSummaryToBudget,
  computeSummaryBudget,
} from './compaction-soul.js';
import { importHostPackage } from './host-loader.js';

export const STALE_COMPACTION_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_COMPACTION_MAX_TOKENS = 4096;

let cachedHostModulesPromise = null;

async function loadHostCompactionModules() {
  if (!cachedHostModulesPromise) {
    cachedHostModulesPromise = (async () => {
      const [compactionMod, llmMod] = await Promise.all([
        importHostPackage('@deepseek-ai/dsh-compaction'),
        importHostPackage('@deepseek-ai/dsh-llm'),
      ]);
      return {
        compactCheckpointSource: typeof compactionMod?.compactCheckpointSource === 'function'
          ? compactionMod.compactCheckpointSource
          : null,
        toolPairingBalancedBefore: typeof compactionMod?.toolPairingBalancedBefore === 'function'
          ? compactionMod.toolPairingBalancedBefore
          : null,
        toolPairingBalancedAfter: typeof compactionMod?.toolPairingBalancedAfter === 'function'
          ? compactionMod.toolPairingBalancedAfter
          : null,
        CompactionId: typeof compactionMod?.CompactionId === 'function'
          ? compactionMod.CompactionId
          : (id) => id,
        BlockAssembler: typeof llmMod?.BlockAssembler === 'function' ? llmMod.BlockAssembler : null,
        createUserMessage: typeof llmMod?.createUserMessage === 'function' ? llmMod.createUserMessage : null,
        errorChain: typeof llmMod?.errorChain === 'function' ? llmMod.errorChain : null,
      };
    })();
  }
  return cachedHostModulesPromise;
}

function getCtxService(ctx, key) {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') return ctx.get(key);
  return ctx[key];
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (!Object.isFrozen(obj)) Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Pure-JS fallback matching `@deepseek-ai/dsh-compaction`'s tool-pairing balance semantics.
 */
function fallbackToolPairingTable(session) {
  const nodes = session?.surface?.nodes ?? [];
  const cutBalanced = [true];
  const indexBySeq = new Map();
  let openCalls = 0;

  for (let i = 0; i < nodes.length; i += 1) {
    const seq = nodes[i];
    const ev = session.eventAt(seq);
    if (!ev || ev.seq !== seq) {
      throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event`);
    }
    if (ev.type === 'assistant/message') {
      const content = ev.data?.message?.content ?? ev.data?.content ?? [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool-call') openCalls += 1;
        }
      }
    } else if (ev.type === 'tool/result') {
      openCalls -= 1;
    }
    if (openCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call`);
    }
    indexBySeq.set(seq, i);
    cutBalanced.push(openCalls === 0);
  }

  return { cutBalanced, indexBySeq };
}

export function fallbackToolPairingBalancedBefore(session, seq) {
  const { cutBalanced, indexBySeq } = fallbackToolPairingTable(session);
  const idx = indexBySeq.get(seq);
  if (idx === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`);
  return cutBalanced[idx];
}

export function fallbackToolPairingBalancedAfter(session, seq) {
  const { cutBalanced, indexBySeq } = fallbackToolPairingTable(session);
  const idx = indexBySeq.get(seq);
  if (idx === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`);
  return cutBalanced[idx + 1];
}

/**
 * Minimal fallback BlockAssembler matching `@deepseek-ai/dsh-llm/assembler`
 * (including `block-end` overriding accumulated `text-delta`).
 */
class FallbackBlockAssembler {
  constructor() {
    this.partials = new Map();
    this.order = [];
    this._usage = undefined;
    this._finish = undefined;
  }

  ensure(index, blockType) {
    let partial = this.partials.get(index);
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '', block: null };
      this.partials.set(index, partial);
      this.order.push(index);
    }
    return partial;
  }

  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return;
    switch (chunk.type) {
      case 'block-start':
        this.ensure(chunk.index, chunk.blockType);
        return;
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning');
        if (partial.block) return;
        partial.text += chunk.text ?? '';
        return;
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call');
        if (partial.block) return;
        partial.toolCallId = chunk.id;
        if (chunk.name) partial.toolCallName = chunk.name;
        partial.toolCallArguments += chunk.argumentsDelta ?? '';
        return;
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block?.type ?? 'text');
        if (partial.block) return;
        partial.block = chunk.block;
        return;
      }
      case 'usage':
        this._usage = chunk.usage;
        return;
      case 'finish':
        this._finish = chunk.reason;
        return;
      default:
        return;
    }
  }

  get usage() {
    return this._usage;
  }

  get finish() {
    return this._finish ?? { kind: 'stop' };
  }

  blocks() {
    return this.order.map((index) => {
      const p = this.partials.get(index);
      if (p.block) return p.block;
      if (p.blockType === 'text') return { type: 'text', text: p.text };
      if (p.blockType === 'reasoning') return { type: 'reasoning', text: p.text };
      return {
        type: 'tool-call',
        id: p.toolCallId ?? `call-${index}`,
        name: p.toolCallName ?? '',
        arguments: p.toolCallArguments,
      };
    });
  }
}

function fallbackErrorChain(err) {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: err.message || String(err),
      ...(typeof err.code === 'string' ? { code: err.code } : {}),
    };
  }
  return { name: 'Error', message: String(err) };
}

function deriveEventMessageSafe(session, event) {
  if (!event) return null;
  if (typeof session.deriveEventMessage === 'function') {
    return session.deriveEventMessage(event);
  }
  switch (event.type) {
    case 'user/message':
      return event.data ?? null;
    case 'system/message':
    case 'developer/message':
    case 'assistant/message': {
      const msg = event.data?.message ?? event.data;
      if (!msg || !Array.isArray(msg.content) || msg.content.length === 0) return null;
      return msg;
    }
    case 'tool/result':
      return event.data?.message ?? event.data ?? null;
    default:
      return null;
  }
}

export function isRealHumanUserEvent(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  const msg = ev.data?.message ?? ev.data;
  if (!msg || typeof msg !== 'object') return false;
  if (msg.source && typeof msg.source === 'object') {
    if (msg.source.syntheticSoulCard === true) return false;
    return msg.source.kind === 'user';
  }
  // Fallback when source metadata is absent in minimal synthetic fixtures
  const text = Array.isArray(msg.content)
    ? msg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    : typeof msg.content === 'string'
      ? msg.content
      : '';
  if (text.includes(SUMMARY_OPEN_TAG) || text.startsWith(CHECKPOINT_PREAMBLE)) return false;
  if (text.startsWith('【跨设备接力备注】') || text.startsWith('【同步提醒】')) return false;
  return true;
}

function isCompactCheckpointEvent(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  const msg = ev.data?.message ?? ev.data;
  if (msg?.source?.kind === 'compact-checkpoint') return true;
  const text = Array.isArray(msg?.content)
    ? msg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    : '';
  return text.includes(SUMMARY_OPEN_TAG);
}

function inspectEntryState(session) {
  const events = typeof session.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : [];
  let openTurn = null;
  let openTurnKnown = false;
  let unmatchedCompactionStart = null;
  let compactionKnown = false;
  let latestEndSeedSeq = undefined;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev) continue;
    if (latestEndSeedSeq === undefined && ev.type === 'session/end-seed') {
      latestEndSeedSeq = ev.seq;
    }
    if (!compactionKnown) {
      if (ev.type === 'compaction/start') {
        unmatchedCompactionStart = ev;
        compactionKnown = true;
      } else if (ev.type === 'compaction/end') {
        compactionKnown = true;
      }
    }
    if (!openTurnKnown) {
      if (ev.type === 'turn/start') {
        openTurn = ev.data?.turn ?? 'open';
        openTurnKnown = true;
      } else if (ev.type === 'turn/end') {
        openTurnKnown = true;
      }
    }
    if (openTurnKnown && compactionKnown && latestEndSeedSeq !== undefined) break;
  }

  const hasActiveCompaction = Boolean(
    unmatchedCompactionStart
    && (latestEndSeedSeq === undefined || latestEndSeedSeq <= unmatchedCompactionStart.seq),
  );

  return { openTurn, hasActiveCompaction, unmatchedCompactionStart };
}

function countVisibleRealHumanTurns(session) {
  const surfaceNodes = session?.surface?.nodes;
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) {
    return 0;
  }
  const headEvent = session.eventAt(surfaceNodes[0]);
  const firstIdx = headEvent?.type === 'system/message' ? 1 : 0;
  let count = 0;
  for (let i = firstIdx; i < surfaceNodes.length; i += 1) {
    const ev = session.eventAt(surfaceNodes[i]);
    if (isRealHumanUserEvent(ev)) {
      count += 1;
    }
  }
  return count;
}

function resolveEventTimestampMs(ev) {
  if (!ev || typeof ev !== 'object') return null;
  for (const candidate of [ev.data?.startedAt, ev.timestamp, ev.time]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function frameSummaryBlocks(summaryBlocks) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summaryBlocks,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ];
}

function estimateNodeTokens(session, seq, tokenMeter, measurementMap) {
  if (measurementMap && measurementMap.has(seq)) {
    return measurementMap.get(seq);
  }
  const ev = session.eventAt(seq);
  const msg = deriveEventMessageSafe(session, ev);
  const heuristic = msg ? estimateMessageTokens(msg) : 0;
  const route = msg && typeof tokenMeter?.estimateMessage === 'function'
    ? tokenMeter.estimateMessage(msg)
    : heuristic;
  return { seq, heuristicTokens: heuristic, tokens: route };
}

/**
 * Compute a safe tail-preserving compaction span `[start, end]` over `session.surface.nodes`.
 * Preserves surface node 0 when it is a `system/message`, keeps the last `keepTurns` (auto-downgrading
 * `keepTurns -> ... -> 1` if needed) real human user turns verbatim (with their native `reasoning`
 * chains and balanced `tool-call`/`tool/result` pairs), and guarantees balanced boundaries.
 */
export function selectTailPreservingSpan(session, {
  keepTurns = 3,
  tokenMeter = null,
  toolPairingBalancedBefore = fallbackToolPairingBalancedBefore,
  toolPairingBalancedAfter = fallbackToolPairingBalancedAfter,
} = {}) {
  const surfaceNodes = session?.surface?.nodes;
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) {
    return null;
  }

  const headEvent = session.eventAt(surfaceNodes[0]);
  const firstIdx = headEvent?.type === 'system/message' ? 1 : 0;
  if (surfaceNodes.length - firstIdx < 2) {
    return null;
  }

  const humanTurnIndices = [];
  for (let i = firstIdx; i < surfaceNodes.length; i += 1) {
    const ev = session.eventAt(surfaceNodes[i]);
    if (isRealHumanUserEvent(ev)) {
      humanTurnIndices.push(i);
    }
  }

  let measurementMap = null;
  if (typeof tokenMeter?.measure === 'function') {
    try {
      const m = tokenMeter.measure(session);
      if (Array.isArray(m?.nodes) && m.nodes.length === surfaceNodes.length) {
        measurementMap = new Map(m.nodes.map((n) => [n.seq, n]));
      }
    } catch {
      measurementMap = null;
    }
  }

  const requested = Math.max(1, Math.floor(Number(keepTurns) || 3));
  const framingMinTokens = estimateFramedSummaryTokens('摘要') + 12;

  // Never silently lower user-requested keepTurns: if total real human turns <= requested,
  // there is nothing ahead of the requested preserved tail to compact.
  if (humanTurnIndices.length <= requested) {
    return null;
  }

  let keepFromIdx = humanTurnIndices[humanTurnIndices.length - requested];
  if (keepFromIdx <= firstIdx) {
    return null;
  }

  while (keepFromIdx > firstIdx) {
    const beforeBalanced = toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]);
    const afterBalanced = toolPairingBalancedAfter(session, surfaceNodes[keepFromIdx - 1]);
    if (beforeBalanced && afterBalanced) break;
    keepFromIdx -= 1;
  }

  if (keepFromIdx <= firstIdx) {
    return null;
  }

  const startIdx = firstIdx;
  const endIdx = keepFromIdx - 1;
  const shadowedSeqs = surfaceNodes.slice(startIdx, endIdx + 1);
  if (shadowedSeqs.length === 0) {
    return null;
  }

  // Avoid pointlessly re-compacting a single existing compact-checkpoint with nothing new after it
  if (shadowedSeqs.length === 1 && isCompactCheckpointEvent(session.eventAt(shadowedSeqs[0]))) {
    return null;
  }

  if (!toolPairingBalancedBefore(session, surfaceNodes[startIdx])) return null;
  if (!toolPairingBalancedAfter(session, surfaceNodes[endIdx])) return null;

  let shadowedTokenCount = 0;
  let shadowedRouteTokenCount = 0;
  for (const seq of shadowedSeqs) {
    const priced = estimateNodeTokens(session, seq, tokenMeter, measurementMap);
    shadowedTokenCount += priced.heuristicTokens;
    shadowedRouteTokenCount += priced.tokens;
  }

  // Ensure the shadowed span is actually larger than the checkpoint framing overhead
  if (shadowedRouteTokenCount <= framingMinTokens) {
    return null;
  }

  // Count how many real human turns remain verbatim in the preserved tail
  const keptTurns = humanTurnIndices.filter((idx) => idx >= keepFromIdx).length;
  return {
    start: surfaceNodes[startIdx],
    end: surfaceNodes[endIdx],
    startIdx,
    endIdx,
    shadowedSeqs,
    shadowedTokenCount,
    shadowedRouteTokenCount,
    keptTurns,
    keptNodeCount: surfaceNodes.length - keepFromIdx,
    hasSystemHead: firstIdx === 1,
  };
}

function resolveSummarizationTarget({ session, agent, llmSvc, defaultModelTriple }) {
  const headerCfg = typeof session?.requestHeader === 'function'
    ? session.requestHeader()?.config
    : undefined;
  if (headerCfg?.provider && headerCfg?.model) {
    return { provider: headerCfg.provider, model: headerCfg.model };
  }
  if (agent?.options?.provider && agent?.options?.model) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  if (llmSvc?.defaultConfig?.provider && llmSvc?.defaultConfig?.model) {
    return { provider: llmSvc.defaultConfig.provider, model: llmSvc.defaultConfig.model };
  }
  if (defaultModelTriple?.provider && defaultModelTriple?.model) {
    return { provider: defaultModelTriple.provider, model: defaultModelTriple.model };
  }
  return null;
}

/**
 * Tail-preserving lossless soul compactor.
 * Compacts older conversation turns into a standard V4 `<compacted-summary>` checkpoint while
 * preserving the last `keepTurns` real human turns (including native `reasoning` chains and
 * balanced `tool-call`/`tool/result` pairs) completely verbatim!
 *
 * CRITICAL: Intentionally omits `sourceCommandId` from the four V4 compaction events so
 * `dsh-client-ui-chat` renders the native collapsible compaction card cleanly instead of
 * hiding it inside `/soul`.
 */
export async function compactSessionPreservingTail({
  ctx = null,
  agent = null,
  session = null,
  keepTurns = 3,
  signal = undefined,
  defaultModelTriple = null,
  maxTokens = undefined,
  staleCompactionTimeoutMs = STALE_COMPACTION_TIMEOUT_MS,
  nowMs = undefined,
} = {}) {
  const targetSession = session ?? agent?.session ?? null;

  // Capability probe BEFORE mutating anything (graceful degradation across future DSH changes)
  if (
    !targetSession
    || !Array.isArray(targetSession.surface?.nodes)
    || typeof targetSession.eventAt !== 'function'
    || typeof targetSession.append !== 'function'
  ) {
    return {
      status: 'degraded',
      ok: false,
      message: '当前环境未挂载活跃的 DSH 会话表面（缺少 `session.surface` / `session.append`），无法执行保尾无损压缩。',
    };
  }

  const llmSvc = getCtxService(ctx, 'llm');
  if (typeof llmSvc?.stream !== 'function') {
    return {
      status: 'degraded',
      ok: false,
      message: '当前运行环境未暴露 `ctx.llm.stream` 服务，保尾无损压缩已安全降级退出（未写入任何会话事件）。',
    };
  }

  const tokenMeter = getCtxService(ctx, 'tokenMeter') ?? null;
  const sessionsSvc = getCtxService(ctx, 'sessions') ?? null;
  const hostMods = await loadHostCompactionModules();

  const targetModel = resolveSummarizationTarget({
    session: targetSession,
    agent,
    llmSvc,
    defaultModelTriple,
  });
  if (!targetModel) {
    return {
      status: 'degraded',
      ok: false,
      message: '尚未检测到当前会话可用的模型路由（provider/model），请先发送一轮普通对话后再执行保尾压缩。',
    };
  }

  const requestedKeepTurns = Math.max(1, Math.floor(Number(keepTurns) || 3));

  const runUnderLock = async (effectiveSignal) => {
    effectiveSignal?.throwIfAborted?.();

    const entryState = inspectEntryState(targetSession);
    if (entryState.hasActiveCompaction) {
      const startEv = entryState.unmatchedCompactionStart;
      const startTs = resolveEventTimestampMs(startEv);
      const currentNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      const timeoutMs = Number.isFinite(Number(staleCompactionTimeoutMs)) && Number(staleCompactionTimeoutMs) > 0
        ? Number(staleCompactionTimeoutMs)
        : STALE_COMPACTION_TIMEOUT_MS;

      if (startTs !== null && (currentNow - startTs) >= timeoutMs) {
        const toChain = hostMods.errorChain ?? fallbackErrorChain;
        targetSession.append('compaction/end', {
          compactionId: startEv?.data?.compactionId ?? hostMods.CompactionId(crypto.randomUUID()),
          turn: startEv?.data?.turn ?? null,
          error: toChain(new Error('stale compaction auto-closed')),
        });
        if (typeof sessionsSvc?.flush === 'function') {
          await sessionsSvc.flush(targetSession).catch(() => {});
        }
      } else {
        return {
          status: 'busy',
          ok: false,
          message: '当前会话已有正在进行的压缩事务，请稍候片刻再试。',
        };
      }
    }
    if (entryState.openTurn !== null) {
      return {
        status: 'busy',
        ok: false,
        message: '当前对话回合尚未结束，请等待本轮回复完成后再执行保尾无损压缩。',
      };
    }

    const totalHumanTurns = countVisibleRealHumanTurns(targetSession);
    if (totalHumanTurns <= requestedKeepTurns) {
      return {
        status: 'noop',
        ok: true,
        keptTurns: totalHumanTurns,
        requestedKeepTurns,
        message: `当前会话仅有 ${totalHumanTurns} 轮真实对话（≤ 要求保留的 ${requestedKeepTurns} 轮），无需压缩，已保持原文不动。`,
      };
    }

    const selection = selectTailPreservingSpan(targetSession, {
      keepTurns: requestedKeepTurns,
      tokenMeter,
      toolPairingBalancedBefore: hostMods.toolPairingBalancedBefore ?? fallbackToolPairingBalancedBefore,
      toolPairingBalancedAfter: hostMods.toolPairingBalancedAfter ?? fallbackToolPairingBalancedAfter,
    });

    if (!selection) {
      return {
        status: 'noop',
        ok: true,
        keptTurns: totalHumanTurns,
        requestedKeepTurns,
        message: `当前对话较短（共 ${totalHumanTurns} 轮）或保留末尾 ${requestedKeepTurns} 轮原装回合后前段无需压缩，已保持原文不动。`,
      };
    }

    // Build 100% Prefix-Cache-compatible summarization input `[system?, ...regionMessages, user(instruction)]`
    // (NEVER call pruneSession beforehand so KV prefix cache stays warm)
    const header = typeof targetSession.requestHeader === 'function'
      ? targetSession.requestHeader()
      : undefined;
    const systemMsg = selection.hasSystemHead
      ? deriveEventMessageSafe(targetSession, targetSession.eventAt(targetSession.surface.nodes[0]))
      : null;
    const regionMessages = selection.shadowedSeqs
      .map((seq) => deriveEventMessageSafe(targetSession, targetSession.eventAt(seq)))
      .filter((msg) => msg !== null);

    if (regionMessages.length === 0) {
      return {
        status: 'noop',
        ok: true,
        keptTurns: totalHumanTurns,
        requestedKeepTurns,
        message: '当前待压前段无有效消息内容，无需压缩。',
      };
    }

    const prefixMessages = systemMsg === null ? regionMessages : [systemMsg, ...regionMessages];
    const { generation } = detectCompactionGeneration([...prefixMessages, { role: 'user', content: '' }]);
    const instructionText = generation === 1
      ? SOUL_COMPACTION_INSTRUCTION
      : buildSoulCompactionInstruction({ generation });

    const instructionMsg = deepFreeze({
      role: 'user',
      content: [{ type: 'text', text: instructionText }],
    });
    const streamMessages = [...prefixMessages, instructionMsg];

    const effectiveMaxTokens = Number.isInteger(maxTokens) && maxTokens > 0
      ? maxTokens
      : (Number.isInteger(header?.config?.maxTokens) && header.config.maxTokens > 0
        ? Math.min(header.config.maxTokens, 8192)
        : DEFAULT_COMPACTION_MAX_TOKENS);

    const compactionId = hostMods.CompactionId(crypto.randomUUID());
    // CRITICAL: intentionally omit `sourceCommandId` so chat UI renders the native compaction card!
    const lifecycle = {
      compactionId,
      turn: null,
    };

    const startEvent = targetSession.append('compaction/start', {
      ...lifecycle,
      startedAt: Date.now(),
    });
    let closed = false;

    try {
      const AssemblerClass = hostMods.BlockAssembler ?? FallbackBlockAssembler;
      const assembler = new AssemblerClass();

      const streamOptions = {
        provider: targetModel.provider,
        model: targetModel.model,
        messages: streamMessages,
        ...(typeof targetSession.toolHistory === 'function' ? { toolHistory: targetSession.toolHistory() } : {}),
        ...(header?.tools !== undefined ? { tools: [...header.tools] } : {}),
        maxTokens: effectiveMaxTokens,
        sessionId: targetSession.id,
        purpose: 'compaction',
        ...(effectiveSignal ? { signal: effectiveSignal } : {}),
      };

      for await (const chunk of llmSvc.stream(streamOptions)) {
        assembler.push(chunk);
      }

      effectiveSignal?.throwIfAborted?.();

      const finish = assembler.finish;
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        const errMsg = finish.failure?.message ?? `summarization ${finish.kind}`;
        const err = new Error(errMsg);
        if (finish.failure?.code) err.code = finish.failure.code;
        throw err;
      }
      if (finish?.kind === 'max-tokens') {
        const err = new Error('summarization truncated at the token cap (incomplete checkpoint)');
        err.code = 'MAX_TOKENS';
        throw err;
      }

      const rawOutput = assembler.blocks();
      if (rawOutput.some((b) => b?.type === 'image')) {
        throw new Error('compaction summary cannot contain image output');
      }
      let summaryBlocks = rawOutput.filter((b) => b?.type === 'text' && typeof b.text === 'string');
      if (!summaryBlocks.some((b) => b.text.trim().length > 0)) {
        throw new Error('summarization produced no text summary content');
      }

      // Deterministically ensure `[压缩代次: G<generation>]` is present even if model omitted it
      const combinedTagged = ensureCompactionGenerationTag(
        summaryBlocks.map((b) => b.text).join('\n').trim(),
        generation,
      );
      if (combinedTagged !== summaryBlocks.map((b) => b.text).join('\n').trim()) {
        summaryBlocks = [{ type: 'text', text: combinedTagged }];
      }

      const buildCheckpointMessage = (blocks) => {
        const source = hostMods.compactCheckpointSource
          ? hostMods.compactCheckpointSource(compactionId)
          : Object.freeze({ kind: 'compact-checkpoint', compactionId });
        const framedContent = frameSummaryBlocks(blocks);
        if (hostMods.createUserMessage) {
          return hostMods.createUserMessage({ content: framedContent, source });
        }
        return deepFreeze({
          id: crypto.randomUUID(),
          role: 'user',
          content: framedContent,
          source,
        });
      };

      const measureCheckpoint = (msg) => {
        if (typeof tokenMeter?.estimateMessage === 'function') {
          return tokenMeter.estimateMessage(msg);
        }
        return estimateMessageTokens(msg);
      };

      let checkpointMessage = buildCheckpointMessage(summaryBlocks);
      let framedSummaryTokenCount = measureCheckpoint(checkpointMessage);

      // Final convergence safeguard: compress summary text if still >= shadowedRouteTokenCount
      if (framedSummaryTokenCount >= selection.shadowedRouteTokenCount) {
        const budget = computeSummaryBudget(selection.shadowedRouteTokenCount, { messages: streamMessages });
        let combined = summaryBlocks.map((b) => b.text).join('\n').trim();
        let cap = budget ? budget.maxSummaryChars : Math.max(32, Math.floor(combined.length * 0.6));
        for (let iter = 0; iter < 6 && framedSummaryTokenCount >= selection.shadowedRouteTokenCount; iter += 1) {
          combined = compressSummaryToBudget(combined, cap, { generation });
          summaryBlocks = [{ type: 'text', text: combined }];
          checkpointMessage = buildCheckpointMessage(summaryBlocks);
          framedSummaryTokenCount = measureCheckpoint(checkpointMessage);
          cap = Math.max(16, Math.floor(cap * 0.75));
        }
      }

      if (framedSummaryTokenCount >= selection.shadowedRouteTokenCount) {
        throw new Error(
          `summary is not smaller than the shadowed content (${framedSummaryTokenCount} >= ${selection.shadowedRouteTokenCount})`,
        );
      }

      // Verify the selected surface span did not mutate while awaiting LLM
      const currentNodes = targetSession.surface.nodes;
      const curStartIdx = currentNodes.indexOf(selection.start);
      const curEndIdx = currentNodes.indexOf(selection.end);
      if (
        curStartIdx === -1
        || curEndIdx === -1
        || curEndIdx - curStartIdx + 1 !== selection.shadowedSeqs.length
        || selection.shadowedSeqs.some((seq, idx) => currentNodes[curStartIdx + idx] !== seq)
      ) {
        throw new Error('the selected conversation span changed during tail-preserving compaction');
      }

      // Synchronous non-await V4 atomic commit of summary + replace + end
      const summaryEvent = targetSession.append('compaction/summary', {
        compactionId,
        summary: summaryBlocks,
        rawOutput,
        llmStreamCall: true,
        shadowedRange: { start: selection.start, end: selection.end },
        shadowedSeqs: [...selection.shadowedSeqs],
        shadowedTokenCount: selection.shadowedTokenCount,
        provider: targetModel.provider,
        model: targetModel.model,
        maxTokens: effectiveMaxTokens,
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      });

      const checkpointEvent = targetSession.append('user/message', checkpointMessage, {
        surfaceOp: {
          op: 'replace',
          startSeq: selection.start,
          endSeq: selection.end,
        },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.shadowedSeqs],
      });

      const endEvent = targetSession.append('compaction/end', lifecycle);
      closed = true;

      if (typeof sessionsSvc?.flush === 'function') {
        await sessionsSvc.flush(targetSession);
      }

      return {
        status: 'compacted',
        ok: true,
        compactionId,
        generation,
        startSeq: startEvent.seq,
        summarySeq: summaryEvent.seq,
        checkpointSeq: checkpointEvent.seq,
        endSeq: endEvent.seq,
        shadowedRange: { start: selection.start, end: selection.end },
        shadowedCount: selection.shadowedSeqs.length,
        shadowedTokenCount: selection.shadowedTokenCount,
        shadowedRouteTokenCount: selection.shadowedRouteTokenCount,
        framedSummaryTokenCount,
        keptTurns: selection.keptTurns,
        keptNodeCount: selection.keptNodeCount,
      };
    } catch (error) {
      if (!closed) {
        try {
          const toChain = hostMods.errorChain ?? fallbackErrorChain;
          targetSession.append('compaction/end', {
            ...lifecycle,
            error: toChain(error),
          });
          closed = true;
        } catch {
          // Best-effort close; rethrow original below
        }
        if (closed && typeof sessionsSvc?.flush === 'function') {
          await sessionsSvc.flush(targetSession).catch(() => {});
        }
      }
      return {
        status: 'error',
        ok: false,
        error,
        message: `保尾无损压缩未能完成（已安全闭合压缩事务，无锁残留）：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  if (typeof agent?.runMaintenance === 'function') {
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        const combinedSignal = signal && agentSignal
          ? AbortSignal.any([agentSignal, signal])
          : (signal ?? agentSignal);
        return runUnderLock(combinedSignal);
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        status: 'busy',
        ok: false,
        error,
        message: `当前会话正忙，无法进入保尾无损压缩维护锁（${errMsg}）；请等待本轮回复结束后重试。`,
      };
    }
  }

  return runUnderLock(signal);
}
