const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;
const MAX_SNIPPET_CHARS = 600;

const SEARCHABLE_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
  'developer/message',
  'compaction/summary',
]);

/**
 * Reconstruct the active surface seq set when `session.surface.nodes` is absent
 * (e.g. standalone tests passing plain events), or use `session.surface.nodes` directly.
 *
 * @param {any} session
 * @param {Array<any>} events
 * @returns {Set<number>}
 */
function resolveCurrentSurfaceSet(session, events) {
  if (Array.isArray(session?.surface?.nodes) && session.surface.nodes.length > 0) {
    return new Set(session.surface.nodes);
  }
  const nodes = [];
  for (const ev of events) {
    if (!ev || ev.surfaceOp === undefined) continue;
    if (ev.surfaceOp === 'append') {
      nodes.push(ev.seq);
    } else if (ev.surfaceOp && typeof ev.surfaceOp === 'object' && ev.surfaceOp.op === 'replace') {
      const startIdx = nodes.indexOf(ev.surfaceOp.startSeq);
      const endIdx = nodes.indexOf(ev.surfaceOp.endSeq);
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        nodes.splice(startIdx, endIdx - startIdx + 1, ev.seq);
      } else {
        nodes.push(ev.seq);
      }
    }
  }
  return new Set(nodes);
}

/**
 * Determine the highest event seq eligible for recall, excluding the currently
 * executing step (mirroring `@deepseek-ai/dsh-tool-session-query`'s caller boundary).
 *
 * @param {Array<any>} events
 * @returns {number}
 */
function resolveCutoffSeq(events) {
  if (!Array.isArray(events) || events.length === 0) return -1;

  // Check if there is an open `step/start` at the tail (without a later `step/end`)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.type === 'step/end') break;
    if (ev.type === 'step/start') {
      return ev.seq - 1;
    }
  }

  // Fallback when test fixtures omit `step/start`: exclude a trailing assistant message invoking soul_recall_history
  const last = events[events.length - 1];
  if (last?.type === 'assistant/message') {
    const content = last.data?.message?.content ?? last.data?.content;
    if (
      Array.isArray(content)
      && content.some((b) => b?.type === 'tool-call' && b.name === 'soul_recall_history')
    ) {
      return last.seq - 1;
    }
  }

  return last.seq;
}

/**
 * Extract searchable text segments from a session event (supporting user text,
 * assistant text + `reasoning`/`thinking` chains + tool calls, and raw unpruned `tool/result`).
 *
 * @param {any} ev
 * @param {{ includeReasoning?: boolean }} opts
 * @returns {Array<{ channel: string, text: string }>}
 */
function extractEventSegments(ev, { includeReasoning = true } = {}) {
  if (!ev || !SEARCHABLE_EVENT_TYPES.has(ev.type)) return [];

  const segments = [];
  const pushText = (channel, text) => {
    const cleaned = typeof text === 'string' ? text.trim() : '';
    if (cleaned.length > 0) {
      segments.push({ channel, text: cleaned });
    }
  };

  if (ev.type === 'compaction/summary') {
    const blocks = Array.isArray(ev.data?.summary) ? ev.data.summary : [];
    for (const block of blocks) {
      if (block?.type === 'text') pushText('summary', block.text);
    }
    return segments;
  }

  const msg = ev.type === 'user/message'
    ? (ev.data?.message ?? ev.data)
    : (ev.data?.message ?? ev.data);

  if (!msg) return segments;

  if (typeof msg.content === 'string') {
    pushText(ev.type === 'tool/result' ? 'tool-result' : 'text', msg.content);
    return segments;
  }

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        pushText(ev.type === 'tool/result' ? 'tool-result' : 'text', block.text);
      } else if (block.type === 'reasoning' || block.type === 'thinking') {
        if (includeReasoning) {
          pushText('reasoning', block.text ?? block.thinking ?? '');
        }
      } else if (block.type === 'tool-call') {
        const argsStr = typeof block.arguments === 'string'
          ? block.arguments
          : JSON.stringify(block.input ?? block.arguments ?? '');
        pushText('tool-call', `${block.name ?? ''}(${argsStr})`);
      }
    }
  }

  return segments;
}

/**
 * Parse a query string into normalized exact phrase, whitespace terms, and fine-grained
 * CJK / numeric / identifier sub-tokens for robust Chinese + English + percentage matching.
 */
function tokenizeQuery(rawQuery) {
  const normalized = String(rawQuery ?? '').trim().replace(/\s+/g, ' ');
  const lower = normalized.toLowerCase();
  const wsTerms = lower.split(/\s+/).filter(Boolean);

  // Extract punctuation-split / script-boundary tokens (e.g. "宁德时代", "2025q3", "毛利率", "22.4%", "dcf")
  const fineSet = new Set(wsTerms);
  const subMatches = lower.match(/[a-z0-9_./:%+-]+|[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const tok of subMatches) {
    if (tok.length >= 2 || /\d/.test(tok)) {
      fineSet.add(tok);
    }
  }

  return {
    normalized,
    lower,
    wsTerms,
    fineTerms: [...fineSet],
  };
}

/**
 * Score a text segment against the parsed query and locate the best match offset.
 */
function scoreSegment(text, parsedQuery) {
  const lowerText = text.toLowerCase();

  // 1. Exact full query match (highest priority)
  const exactPos = lowerText.indexOf(parsedQuery.lower);
  if (exactPos !== -1) {
    return { score: 100 + parsedQuery.lower.length, matchPos: exactPos, matchedCount: parsedQuery.wsTerms.length };
  }

  // 2. All whitespace-separated terms present (AND match)
  if (parsedQuery.wsTerms.length > 1) {
    let firstPos = -1;
    let allFound = true;
    for (const term of parsedQuery.wsTerms) {
      const pos = lowerText.indexOf(term);
      if (pos === -1) {
        allFound = false;
        break;
      }
      if (firstPos === -1 || pos < firstPos) firstPos = pos;
    }
    if (allFound) {
      return { score: 80 + parsedQuery.wsTerms.length * 5, matchPos: firstPos, matchedCount: parsedQuery.wsTerms.length };
    }
  }

  // 3. Partial match over fine-grained CJK/numeric/identifier tokens
  let matchedCount = 0;
  let weighted = 0;
  let bestPos = -1;
  for (const term of parsedQuery.fineTerms) {
    const pos = lowerText.indexOf(term);
    if (pos !== -1) {
      matchedCount += 1;
      // Weight exact numbers/percentages/identifiers slightly higher
      const weight = /\d|%/.test(term) ? 14 : Math.min(12, term.length * 2);
      weighted += weight;
      if (bestPos === -1 || pos < bestPos) bestPos = pos;
    }
  }

  if (matchedCount === 0) return null;

  // Require at least 2 matching terms when multiple fine tokens exist (or 1 if query only has 1 token)
  const minRequired = parsedQuery.fineTerms.length >= 2 ? Math.min(2, parsedQuery.fineTerms.length) : 1;
  if (matchedCount < minRequired && parsedQuery.wsTerms.length <= 1) {
    // Allow single-token match if it's a strong number/identifier (>= 3 chars) or >= 50% of query length
    const bestTokLen = parsedQuery.fineTerms
      .filter((t) => lowerText.includes(t))
      .reduce((m, t) => Math.max(m, t.length), 0);
    if (bestTokLen < Math.max(3, Math.ceil(parsedQuery.lower.length * 0.4))) {
      return null;
    }
  } else if (matchedCount < minRequired) {
    return null;
  }

  return { score: weighted, matchPos: bestPos, matchedCount };
}

/**
 * Extract a concise <= MAX_SNIPPET_CHARS window centered around `matchPos`.
 */
function buildSnippet(text, matchPos, maxChars = MAX_SNIPPET_CHARS) {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, matchPos - Math.floor(half * 0.7));
  let end = start + maxChars;
  if (end > text.length) {
    end = text.length;
    start = Math.max(0, end - maxChars);
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const budget = maxChars - prefix.length - suffix.length;
  return `${prefix}${text.slice(start, start + budget).trim()}${suffix}`;
}

function formatRoleLabel(ev, channel) {
  if (ev.type === 'user/message') {
    const kind = (ev.data?.message ?? ev.data)?.source?.kind;
    if (kind === 'compact-checkpoint') return 'checkpoint/summary';
    return 'user/message';
  }
  if (ev.type === 'assistant/message') {
    if (channel === 'reasoning') return 'assistant/reasoning';
    if (channel === 'tool-call') return 'assistant/tool-call';
    return 'assistant/message';
  }
  return ev.type;
}

/**
 * Pure in-memory history recall engine over a DSH `Session` (or compatible snapshot).
 *
 * @param {any} session
 * @param {{
 *   query: string,
 *   scope?: 'shadowed' | 'all',
 *   include_reasoning?: boolean,
 *   seq_from?: number,
 *   seq_to?: number,
 *   limit?: number,
 * }} args
 */
export function searchSessionHistory(session, args = {}) {
  const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
  if (!rawQuery) {
    return {
      ok: false,
      hits: [],
      usedFallbackScope: false,
      text: '查询词 `query` 不能为空，请传入要检索的中文词组、精确数值或代码标识符。',
    };
  }

  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : Array.isArray(session?.events)
      ? session.events
      : null;

  if (!events) {
    return {
      ok: false,
      hits: [],
      usedFallbackScope: false,
      text: '当前会话未绑定内存事件流，无法检索历史底稿。',
    };
  }

  const requestedScope = args.scope === 'all' ? 'all' : 'shadowed';
  const includeReasoning = args.include_reasoning !== false;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isInteger(args.limit) ? args.limit : DEFAULT_LIMIT),
  );

  const cutoffSeq = resolveCutoffSeq(events);
  const seqFrom = Number.isInteger(args.seq_from) ? Math.max(0, args.seq_from) : 0;
  const seqTo = Number.isInteger(args.seq_to) ? Math.min(args.seq_to, cutoffSeq) : cutoffSeq;

  if (seqFrom > seqTo || cutoffSeq < 0) {
    return {
      ok: true,
      hits: [],
      usedFallbackScope: false,
      text: `未在指定区间 [seq #${seqFrom}..#${seqTo}] 找到与「${rawQuery}」匹配的历史底稿。`,
    };
  }

  const currentSurfaceSet = resolveCurrentSurfaceSet(session, events);
  const parsedQuery = tokenizeQuery(rawQuery);

  const scan = (onlyShadowed) => {
    const matches = [];
    for (const ev of events) {
      if (!ev || typeof ev.seq !== 'number') continue;
      if (ev.seq < seqFrom || ev.seq > seqTo) continue;
      if (!SEARCHABLE_EVENT_TYPES.has(ev.type)) continue;

      const isCurrent = currentSurfaceSet.has(ev.seq);
      const surfaceTag = isCurrent ? 'current' : 'shadowed';
      if (onlyShadowed && isCurrent) continue;

      const segments = extractEventSegments(ev, { includeReasoning });
      let bestForEvent = null;
      for (const seg of segments) {
        const scored = scoreSegment(seg.text, parsedQuery);
        if (!scored) continue;
        if (!bestForEvent || scored.score > bestForEvent.score) {
          bestForEvent = {
            seq: ev.seq,
            type: ev.type,
            roleLabel: formatRoleLabel(ev, seg.channel),
            channel: seg.channel,
            surface: surfaceTag,
            score: scored.score,
            snippet: buildSnippet(seg.text, scored.matchPos, MAX_SNIPPET_CHARS),
          };
        }
      }
      if (bestForEvent) {
        matches.push(bestForEvent);
      }
    }

    // Sort by relevance score descending, then shadowed before current, then newer seq first
    matches.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.surface !== b.surface) return a.surface === 'shadowed' ? -1 : 1;
      return b.seq - a.seq;
    });
    return matches;
  };

  let usedFallbackScope = false;
  let allMatches = scan(requestedScope === 'shadowed');
  if (requestedScope === 'shadowed' && allMatches.length === 0) {
    const fallbackMatches = scan(false);
    if (fallbackMatches.length > 0) {
      allMatches = fallbackMatches;
      usedFallbackScope = true;
    }
  }

  const hits = allMatches.slice(0, limit);
  if (hits.length === 0) {
    return {
      ok: true,
      hits: [],
      usedFallbackScope,
      text: `未在当前会话历史底稿中找到与「${rawQuery}」匹配的内容（已检索范围：seq #${seqFrom}..#${seqTo}）。`,
    };
  }

  const scopeDesc = usedFallbackScope
    ? '折叠历史无命中，已自动回退检索全部历史'
    : requestedScope === 'shadowed'
      ? '已被折叠/剪枝的历史底稿 (shadowed)'
      : '全部历史事件 (all)';

  const lines = [
    `共命中 ${allMatches.length} 条记录，展示最相关的 ${hits.length} 条（范围：${scopeDesc}；查询：「${rawQuery}」）：`,
  ];

  for (const hit of hits) {
    lines.push('');
    lines.push(`[seq #${hit.seq} | ${hit.roleLabel} | ${hit.surface}]`);
    lines.push(hit.snippet);
  }

  if (allMatches.length > hits.length) {
    lines.push('', `（尚有 ${allMatches.length - hits.length} 条相关记录未展开，可缩小 query 或指定 seq_from / seq_to 精确回捞。）`);
  }

  return {
    ok: true,
    hits,
    totalMatches: allMatches.length,
    usedFallbackScope,
    text: lines.join('\n'),
  };
}

/**
 * Create the static, read-only, concurrency-safe DSH tool definition for `soul_recall_history`.
 * Fully compatible with `@deepseek-ai/dsh-tools`'s `ToolsService.register()` contract without
 * requiring an async import race during Cordis `ctx.inject(['tools'], ...)` setup.
 */
export function createSoulRecallTool() {
  return {
    name: 'soul_recall_history',
    description:
      '只读检索当前会话中已被压缩折叠（compaction）或被工具输出剪枝（tool-result-pruner）隐藏的早期历史底稿，支持中文词组、精确数值、代码标识符、assistant 思维链（reasoning）与原始未截断工具输出回捞。需要核对早期细节时直接调用，绝不凭记忆猜测。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '必填查询词，支持中文词组、精确数值（如 22.4%）、代码标识符或空格分隔多词匹配。',
        },
        scope: {
          type: 'string',
          enum: ['shadowed', 'all'],
          description: '检索范围：默认 shadowed（优先检索已被压缩折叠或剪枝隐藏的历史事件，无命中时自动回退检索 all）；也可显式传 all。',
        },
        include_reasoning: {
          type: 'boolean',
          description: '是否同时检索 assistant 的 reasoning/thinking 思维链正文，默认 true。',
        },
        seq_from: {
          type: 'integer',
          description: '可选起始事件序号（含）。',
        },
        seq_to: {
          type: 'integer',
          description: '可选结束事件序号（含）。',
        },
        limit: {
          type: 'integer',
          description: '返回最大条数，默认 6，上限 12。',
        },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      kind: 'search',
      title: '检索历史底稿 (soul_recall_history)',
      rawInput: typeof args?.query === 'string' ? args.query : '',
    }),
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || typeof args.query !== 'string' || !args.query.trim()) {
        throw new Error('soul_recall_history: query must be a non-empty string');
      }
      if (args.scope !== undefined && args.scope !== 'shadowed' && args.scope !== 'all') {
        throw new Error('soul_recall_history: scope must be "shadowed" or "all"');
      }
      if (args.include_reasoning !== undefined && typeof args.include_reasoning !== 'boolean') {
        throw new Error('soul_recall_history: include_reasoning must be a boolean');
      }
      if (args.seq_from !== undefined && (!Number.isSafeInteger(args.seq_from) || args.seq_from < 0)) {
        throw new Error('soul_recall_history: seq_from must be a non-negative integer');
      }
      if (args.seq_to !== undefined && (!Number.isSafeInteger(args.seq_to) || args.seq_to < 0)) {
        throw new Error('soul_recall_history: seq_to must be a non-negative integer');
      }
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
        throw new Error('soul_recall_history: limit must be a positive integer');
      }

      const session = exec?.agent?.session ?? exec?.session ?? null;
      if (!session) {
        return '当前调用未绑定活跃会话，无法检索历史底稿。';
      }
      const res = searchSessionHistory(session, args);
      return res.text;
    },
  };
}
