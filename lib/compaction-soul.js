export const DEFAULT_SOUL_RETAIN_RATIO = 0.25;

export const SUMMARY_OPEN_TAG = '<compacted-summary>';
export const SUMMARY_CLOSE_TAG = '</compacted-summary>';
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

export const SOUL_RECALL_HINT_LINE =
  '（注：若后续需核对已被折叠的早期精确数字、原始工具输出、报错或思维链原文，我应直接调用 soul_recall_history 工具检索底稿，绝不凭记忆猜测。）';

export const BUDGET_TRIM_NOTICE =
  '[注：部分次要历史条目已按体积护栏折叠，完整原文与精确数字可随时调用 soul_recall_history 检索]';

export const SOUL_COMPACTION_SECTIONS = Object.freeze([
  '## 钢印共识与核心命题（跨代锁定 · 显式翻案才可改）',
  '## 我的关键推演脉络与滑动里程碑',
  '## 已踩过的死胡同与否决方案（高危伤疤 ≤ 10 条 — 严禁重提）',
  '## 当前悬而未决的拧巴点与信息缺口',
  '## 关键脚本、表格、图表视觉摘要与产出物坐标',
  '## 我们的默契频道、沟通尺度与跨设备环境',
]);

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;

/**
 * Extract plain text from a message's content (string or array of content blocks).
 * Read-only, never mutates the input.
 *
 * @param {any} content
 * @returns {string}
 */
function extractMessagePlainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * Read-only scan of `messages.slice(0, -1)` to detect whether prior `<compacted-summary>`
 * checkpoints already exist and infer the current compaction generation (`1` = first compaction,
 * `>= 2` = incremental multi-generation compaction).
 *
 * Guarantees zero mutation of `messages.slice(0, -1)` so provider KV Prefix Cache stays 100% hot.
 *
 * @param {Array<any>} messages
 * @returns {{ generation: number, hasPriorSummary: boolean, priorSummaryCount: number }}
 */
export function detectCompactionGeneration(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return { generation: 1, hasPriorSummary: false, priorSummaryCount: 0 };
  }

  let priorSummaryCount = 0;
  let maxPriorGen = 0;
  const prefix = messages.slice(0, -1);

  for (const msg of prefix) {
    if (!msg || typeof msg !== 'object') continue;
    const text = extractMessagePlainText(msg.content);
    if (!text || !text.includes(SUMMARY_OPEN_TAG)) continue;

    priorSummaryCount += 1;
    const genMatches = text.matchAll(/(?:\[压缩代次[:：]\s*G(\d+)\]|第\s*(\d+)\s*代(?:增量)?压缩)/g);
    for (const m of genMatches) {
      const parsed = Number.parseInt(m[1] || m[2], 10);
      if (Number.isFinite(parsed) && parsed > maxPriorGen) {
        maxPriorGen = parsed;
      }
    }
  }

  if (priorSummaryCount === 0) {
    return { generation: 1, hasPriorSummary: false, priorSummaryCount: 0 };
  }

  const generation = Math.max(maxPriorGen + 1, priorSummaryCount + 1, 2);
  return { generation, hasPriorSummary: true, priorSummaryCount };
}

/**
 * Build the first-person anti-decay soul compaction instruction.
 * Supports Generation 1 (initial compaction) and Generation k >= 2 (incremental anti-decay ledger).
 *
 * @param {{ generation?: number }} [opts]
 * @returns {string}
 */
export function buildSoulCompactionInstruction({ generation = 1 } = {}) {
  const gen = Number.isInteger(generation) && generation >= 1 ? generation : 1;
  const isIncremental = gen >= 2;

  const lines = [
    isIncremental
      ? `请你对以上对话执行**第 ${gen} 代增量灵魂复盘压缩**，将旧的 \`${SUMMARY_OPEN_TAG}\` 钢印账本与最新一阶段对话自然融合成一份单一、连贯的**第一人称亲历工作复盘**，供我在接下来的对话（包括换到另一台电脑续聊）中无缝接力，彻底消除多次压缩后的信息衰减与“旁观者看传记”割裂感。`
      : '请你把以上完整对话浓缩为一份**第一人称亲历工作复盘**，供我在接下来的对话（包括换到另一台电脑续聊）中无缝接力，彻底消除“旁观者看别人传记”的割裂感。',
    '',
    '【核心写作铁律】',
    '1. **母语一致**：必须使用与上方对话一致的主语言撰写（中文对话必须全程使用中文；仅代码标识符、文件路径、命令行与报错原文保留原样）。',
    '2. **强制第一人称视角**：全程使用“我 / 我们”的亲历口吻（例如“我正在帮我们推进……”“我刚才试过……排除了……”），**严禁**使用“用户要求了……”“助手回答了……”等第三人称传记腔或客观旁白腔。',
    '3. **防衰减两段式结构（跨代钢印账本 + 滑动金字塔）**：严格按顺序输出以下 6 个 Markdown 二级标题分节（绝不漏节、不改标题；若某节当前确实没有内容，直接写 `(无)`）；正文首行请标注 `[压缩代次: G' + gen + ']` 以便跨代追踪：',
    '',
    SOUL_COMPACTION_SECTIONS[0],
    '- **硬预算 ≤ 600 字，最多 ≤ 10 条**：锁定用户的核心意图、原话约束、业务/估值/工程硬公理、精确阈值数字与不可逾越红线。',
    '- **【议题作用域隔离】**：若对话中先后出现互不相关的独立任务或测试指令（例如前几轮顺手测试表格口径，后面讨论人物复盘），必须为每条规矩标明适用范围，**严禁将测试样例或甲课题的局部口径跨界强套到乙课题上**。',
    isIncremental
      ? `- **第 ${gen} 代跨代锁定铁律**：若前文已有 \`${SUMMARY_OPEN_TAG}\`，在**无用户新纠偏时必须逐条原样继承核心公理与精确阈值数字，严禁擅自缩写、降维或删除**；仅当最新对话中用户**明确推翻**旧决定时，才原地更新该条并附最多 1 行 \`[本代翻案: 旧X → 新Y]\`，同时**自动清理上代旧的 \`[本代翻案: ...]\` 标记**，防止跨代精神分裂。`
      : `- 若前文已有 \`${SUMMARY_OPEN_TAG}\`，在**无用户新纠偏时必须逐条继承核心公理与精确阈值数字，严禁擅自缩写删除**；仅当最新对话中用户**明确推翻**旧决定时，才原地更新并附最多 1 行 \`[本代翻案: 旧X → 新Y]\`（上代旧翻案标记自动清理，防止精神分裂）。`,
    '',
    SOUL_COMPACTION_SECTIONS[1],
    '- **滑动金字塔防膨胀**：近 1~2 代的推理链条、认知转折点与“为什么选方案 B 而不选方案 A”的核心权衡保持精详；更早已完成的历史阶段合并浓缩为 **≤ 3 条单行定稿里程碑**，绝不逐代无限堆积流水账。',
    '',
    SOUL_COMPACTION_SECTIONS[2],
    '- 跨代继承已验证走不通的思路、踩过的核心坑、关键报错根因以及被用户明确否决的方案；**上限 ≤ 10 条高危伤疤**，自动剔除一次性拼写/语法小报错或已彻底过期的偶发细节，严禁后续重复踩坑或重提被否决方案。',
    '',
    SOUL_COMPACTION_SECTIONS[3],
    '- 列出尚未敲定的关键假设、待核实的数据、未解分歧、单机独有本地大库缺口（无法在另一台设备重跑的步骤），以及清晰可执行的下一步行动锚点。',
    '',
    SOUL_COMPACTION_SECTIONS[4],
    '- **【Flash → V4Pro 视觉文字桥接铁律】**：若前文包含任何图片、截图、K线/财务图表或财报画面附件，**必须在此把图中核心指标数值、时间区间、趋势拐点与关键判断完整转写为清晰文字**，确保后续切换至纯文本 `deepseek-v4-pro` 深度推演时实现零视觉信息丢失！',
    '- 精确列出关键产出物与脚本的相对路径（如 `outputs/...`、`scripts/...`）、核心函数名、关键参数、报错原文与实测数值。',
    '',
    SOUL_COMPACTION_SECTIONS[5],
    '- **显式扫描上方 `assistant` 的明文 `thinking`/`reasoning` 思维链与用户纠偏原话**（例如“不对 / 不是这个意思 / 别平行罗列 / 太啰嗦 / 直接给结论”等），提炼被纠偏后的内心复盘与配合节奏，保留我们的专属黑话约定、沟通尺度偏好，以及当前操作系统、工作区路径映射与跨设备接力环境信息。',
    `- 本节末尾请固定附上这一句底稿回捞引导：${SOUL_RECALL_HINT_LINE}`,
    '',
    '【安全与收尾规范】',
    '- 不要提及压缩请求、摘要指令或本提示词本身，直接从 `[压缩代次: G' + gen + ']` 与第一个二级标题开始输出正文。',
    '- 严禁调用任何工具，仅输出纯文本复盘内容。',
    `- 如果上方对话中已经包含旧的 \`${SUMMARY_OPEN_TAG}\` 检查点，请按上述跨代钢印锁定与滑动金字塔规则，将其仍有效的信息与后续新进展融合为单一、连贯的第一人称复盘，不要简单堆叠重复段落。`,
  ];

  return lines.join('\n');
}

export const SOUL_COMPACTION_INSTRUCTION = buildSoulCompactionInstruction({ generation: 1 });

/**
 * Exact fixed-density heuristic token estimator matching `@deepseek-ai/dsh-token-meter/estimate`.
 *
 * @param {any} block
 * @returns {number}
 */
function estimateStructuralBlock(block) {
  if (block && block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block;
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN);
  }
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
}

/**
 * Heuristic token price for an array of content blocks (or a string).
 *
 * @param {string | Array<any>} content
 * @returns {number}
 */
export function estimateContentTokens(content) {
  if (typeof content === 'string') {
    return Math.ceil(content.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
  }
  if (!Array.isArray(content) || content.length === 0) return 0;

  let tokens = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' || block.type === 'reasoning') {
      const txt = typeof block.text === 'string' ? block.text : '';
      tokens += Math.ceil(txt.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
    } else if (block.type === 'tool-call') {
      const nameStr = typeof block.name === 'string' ? block.name : '';
      const argsStr = typeof block.arguments === 'string'
        ? block.arguments
        : JSON.stringify(block.input ?? block.arguments ?? '');
      tokens += Math.ceil(nameStr.length / CHARS_PER_TOKEN)
        + Math.ceil(argsStr.length / CHARS_PER_TOKEN)
        + BLOCK_OVERHEAD;
    } else {
      tokens += estimateStructuralBlock(block);
    }
  }
  return tokens;
}

/**
 * Heuristic token price for a single LLM message (exact parity with `dsh-token-meter`).
 *
 * @param {any} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  if (message.role === 'system') {
    if (typeof message.content === 'string') {
      return message.content.length === 0 ? 0 : Math.ceil(message.content.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
    }
    if (!Array.isArray(message.content) || message.content.length === 0) return 0;
    let chars = 0;
    for (const block of message.content) {
      chars += block?.type === 'text' && typeof block.text === 'string'
        ? block.text.length
        : JSON.stringify(block).length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
  }
  return estimateContentTokens(message.content) + ROLE_OVERHEAD;
}

/**
 * Estimate the token count of the framed `<compacted-summary>` checkpoint message
 * produced by `dsh-compaction-basic`'s `frameSummary(summary)`.
 *
 * @param {string | Array<{ type: string, text?: string }>} summaryOrText
 * @returns {number}
 */
export function estimateFramedSummaryTokens(summaryOrText) {
  const summaryBlocks = typeof summaryOrText === 'string'
    ? [{ type: 'text', text: summaryOrText }]
    : Array.isArray(summaryOrText)
      ? summaryOrText
      : [{ type: 'text', text: String(summaryOrText ?? '') }];

  const framed = {
    role: 'user',
    content: [
      { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
      ...summaryBlocks,
      { type: 'text', text: SUMMARY_CLOSE_TAG },
    ],
  };
  return estimateMessageTokens(framed);
}

/**
 * Estimate the shadowed region token budget from `llm/stream` compaction `options.messages`.
 * Excludes any leading `system` message and the trailing compaction instruction `user` message.
 *
 * @param {Array<any>} messages
 * @returns {number}
 */
export function estimateShadowedBudgetTokens(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return 0;
  const startIdx = messages[0]?.role === 'system' ? 1 : 0;
  const region = messages.slice(startIdx, -1);
  let total = 0;
  for (const msg of region) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

const FRAMING_OVERHEAD_TOKENS = estimateFramedSummaryTokens('');
const GEN_TAG_LINE_RE = /^\[压缩代次[:：]\s*G\d+\]\s*$/i;

/**
 * Extract total estimated tokens of prior `<compacted-summary>` / `<soul-ledger>`
 * checkpoint messages inside the shadowed region of `messages`.
 * Read-only, never mutates `messages`.
 *
 * @param {Array<any> | null | undefined} messages
 * @returns {number}
 */
export function extractPriorCheckpointTokens(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return 0;
  const startIdx = messages[0]?.role === 'system' ? 1 : 0;
  const region = messages.slice(startIdx, -1);
  let priorTokens = 0;
  for (const msg of region) {
    if (!msg || typeof msg !== 'object') continue;
    const text = extractMessagePlainText(msg.content);
    if (!text) continue;
    if (text.includes(SUMMARY_OPEN_TAG) || text.includes('<soul-ledger>')) {
      priorTokens += estimateMessageTokens(msg);
    }
  }
  return priorTokens;
}

/**
 * Deterministically ensure `[压缩代次: G<generation>]` is present at the top of a summary.
 * Replaces any stale/wrong generation tag line or prepends it when missing.
 *
 * @param {string} rawText
 * @param {number} generation
 * @returns {string}
 */
export function ensureCompactionGenerationTag(rawText, generation) {
  const text = String(rawText ?? '').trim();
  const gen = Number.isInteger(generation) && generation >= 1 ? generation : null;
  if (!gen || !text) return text;

  const expectedTag = `[压缩代次: G${gen}]`;
  const lines = text.split(/\r?\n/);
  let replaced = false;
  const updated = lines.map((line) => {
    if (!replaced && GEN_TAG_LINE_RE.test(line.trim())) {
      replaced = true;
      return expectedTag;
    }
    return line;
  });
  if (replaced) {
    return updated.join('\n').trim();
  }
  return `${expectedTag}\n${text}`;
}

/**
 * Compute the safe target framed token ceiling for a compaction stream given `shadowedBudgetTokens`.
 * Guarantees strictly `< shadowedBudgetTokens` whenever possible.
 * When a prior checkpoint ledger exists in `messages` (or `priorLedgerTokens > 0`), applies a
 * ledger floor `Math.max(computedSoftBudget, Math.min(hardLimit, priorLedgerTokens + 180, 1600))`
 * so short-span compactions never ratchet-shrink an already compact ledger.
 *
 * @param {number} shadowedBudgetTokens
 * @param {{ messages?: Array<any> | null, priorLedgerTokens?: number | null }} [opts]
 * @returns {{ targetFramedTokens: number, maxSummaryChars: number, priorLedgerTokens: number } | null}
 */
export function computeSummaryBudget(shadowedBudgetTokens, { messages = null, priorLedgerTokens = null } = {}) {
  if (!Number.isFinite(shadowedBudgetTokens) || shadowedBudgetTokens <= 0) {
    return null;
  }
  const resolvedPriorTokens = Number.isFinite(priorLedgerTokens) && priorLedgerTokens > 0
    ? priorLedgerTokens
    : extractPriorCheckpointTokens(messages);

  const hardLimit = shadowedBudgetTokens - 1;
  if (hardLimit <= FRAMING_OVERHEAD_TOKENS + 2) {
    // Region is too small to even hold framing + minimal text; trim as tightly as possible
    return {
      targetFramedTokens: Math.max(FRAMING_OVERHEAD_TOKENS + 1, hardLimit),
      maxSummaryChars: Math.max(8, (hardLimit - FRAMING_OVERHEAD_TOKENS) * CHARS_PER_TOKEN),
      priorLedgerTokens: resolvedPriorTokens,
    };
  }

  const computedSoftBudget = Math.floor(shadowedBudgetTokens * 0.8);
  const ledgerFloor = resolvedPriorTokens > 0
    ? Math.min(hardLimit, resolvedPriorTokens + 180, 1600)
    : 0;
  const softLimit = Math.max(computedSoftBudget, ledgerFloor);
  const targetFramedTokens = softLimit > FRAMING_OVERHEAD_TOKENS + 12
    ? Math.min(softLimit, hardLimit)
    : hardLimit;

  // Reserve 1 token safety margin for Math.ceil rounding
  const availableBodyTokens = Math.max(2, targetFramedTokens - FRAMING_OVERHEAD_TOKENS - 1);
  return {
    targetFramedTokens,
    maxSummaryChars: Math.max(8, availableBodyTokens * CHARS_PER_TOKEN),
    priorLedgerTokens: resolvedPriorTokens,
  };
}

/**
 * Section-aware budget compressor:
 * - Deterministically ensures `[压缩代次: G<generation>]` when `generation` is provided.
 * - Never drops `SOUL_RECALL_HINT_LINE` when present.
 * - Protects ALL Pinned Axioms (`priority 0`, up to 10 items) until all lower-priority sections
 *   (`priority 5 -> 1`) have been fully trimmed/collapsed.
 * - Appends an explicit `BUDGET_TRIM_NOTICE` whenever any lines are trimmed so compaction
 *   losses are never silent.
 *
 * @param {string} rawText
 * @param {number} maxChars
 * @param {{ generation?: number }} [opts]
 * @returns {string}
 */
export function compressSummaryToBudget(rawText, maxChars, { generation = null } = {}) {
  let text = String(rawText ?? '').trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';

  const gen = Number.isInteger(generation) && generation >= 1 ? generation : null;
  if (gen !== null) {
    text = ensureCompactionGenerationTag(text, gen);
  }

  if (text.length <= maxChars) return text;

  const hadRecallHint = text.includes(SOUL_RECALL_HINT_LINE);
  const lines = text.split(/\r?\n/);
  const preamble = [];
  const sections = [];
  let current = null;

  for (const rawLine of lines) {
    let line = rawLine;
    if (hadRecallHint && line.includes(SOUL_RECALL_HINT_LINE)) {
      line = line.replace(SOUL_RECALL_HINT_LINE, '').trimEnd();
      if (/^[-*•]\s*$/.test(line.trim())) {
        line = '';
      }
    }
    if (/^##\s+/.test(line)) {
      current = { heading: line, body: [] };
      sections.push(current);
    } else if (current) {
      if (line.trim().length > 0 || !hadRecallHint || !rawLine.includes(SOUL_RECALL_HINT_LINE)) {
        current.body.push(line);
      }
    } else if (line.trim().length > 0 || !hadRecallHint || !rawLine.includes(SOUL_RECALL_HINT_LINE)) {
      preamble.push(line);
    }
  }

  const genTagLine = gen !== null
    ? `[压缩代次: G${gen}]`
    : (preamble.find((l) => GEN_TAG_LINE_RE.test(l.trim()))?.trim() || '');

  // Fallback for unstructured text
  if (sections.length === 0) {
    const suffixParts = [];
    if (hadRecallHint) suffixParts.push(SOUL_RECALL_HINT_LINE);
    suffixParts.push(BUDGET_TRIM_NOTICE);
    const suffix = `\n${suffixParts.join('\n')}`;
    if (maxChars > suffix.length + 16) {
      const headBudget = maxChars - suffix.length - 1;
      const bodyOnly = text.replaceAll(SOUL_RECALL_HINT_LINE, '').trim();
      return `${bodyOnly.slice(0, headBudget).trimEnd()}…${suffix}`;
    }
    if (maxChars <= 16) return text.slice(0, maxChars);
    return `${text.slice(0, maxChars - 1).trimEnd()}…`;
  }

  // Assign trimming priority (higher trimOrder = trimmed FIRST to protect core axioms & scars)
  const getTrimPriority = (heading) => {
    if (heading.includes('钢印共识') || heading.includes('核心命题')) return 0; // Highest retention (up to 10 items)
    if (heading.includes('死胡同') || heading.includes('伤疤')) return 1;
    if (heading.includes('拧巴点') || heading.includes('信息缺口')) return 2;
    if (heading.includes('视觉摘要') || heading.includes('产出物')) return 3;
    if (heading.includes('推演脉络') || heading.includes('里程碑')) return 4;
    if (heading.includes('默契') || heading.includes('黑话') || heading.includes('沟通')) return 5; // Trim first
    return 4;
  };

  let wasTrimmed = false;

  const render = (includeNotice = wasTrimmed) => {
    const out = [];
    const preText = preamble.join('\n').trim();
    if (preText) out.push(preText);
    for (let i = 0; i < sections.length; i += 1) {
      const sec = sections[i];
      const bodyLines = sec.body.filter((l) => l.trim().length > 0);
      if (hadRecallHint && i === sections.length - 1) {
        bodyLines.push(`- ${SOUL_RECALL_HINT_LINE}`);
      }
      const bodyStr = bodyLines.join('\n').trim() || '(无)';
      out.push(`${sec.heading}\n${bodyStr}`);
    }
    if (includeNotice) {
      out.push(BUDGET_TRIM_NOTICE);
    }
    return out.join('\n\n').trim();
  };

  if (render(false).length <= maxChars) {
    return render(false);
  }

  // Trimming is required; account for BUDGET_TRIM_NOTICE in all subsequent budget checks
  wasTrimmed = true;

  const lowerPriorityIndices = sections
    .map((sec, idx) => ({ idx, priority: getTrimPriority(sec.heading) }))
    .filter((item) => item.priority > 0)
    .sort((a, b) => b.priority - a.priority || b.idx - a.idx)
    .map((item) => item.idx);

  const axiomIndices = sections
    .map((sec, idx) => ({ idx, priority: getTrimPriority(sec.heading) }))
    .filter((item) => item.priority === 0)
    .map((item) => item.idx);

  // Phase 1: Drop trailing non-essential lines from lower-priority sections ONLY (priority 5 -> 1)
  for (const idx of lowerPriorityIndices) {
    if (render(true).length <= maxChars) break;
    const sec = sections[idx];
    const nonEmpty = sec.body.filter((l) => l.trim().length > 0);
    if (nonEmpty.length <= 1) continue;

    while (nonEmpty.length > 1 && render(true).length > maxChars) {
      nonEmpty.pop();
      sec.body = [...nonEmpty];
    }
  }

  // Phase 2: Truncate individual long lines in lower-priority sections ONLY (priority 5 -> 1)
  if (render(true).length > maxChars) {
    for (const idx of lowerPriorityIndices) {
      if (render(true).length <= maxChars) break;
      const sec = sections[idx];
      const lineCap = 60;
      sec.body = sec.body
        .filter((l) => l.trim().length > 0)
        .slice(0, 1)
        .map((l) => (l.length > lineCap ? `${l.slice(0, lineCap - 1)}…` : l));
    }
  }

  // Phase 3: Collapse lower-priority sections (first priority >= 4, then 3 -> 1) before touching Pinned Axioms!
  if (render(true).length > maxChars) {
    for (const idx of lowerPriorityIndices) {
      if (render(true).length <= maxChars) break;
      const sec = sections[idx];
      if (getTrimPriority(sec.heading) >= 4) {
        sec.body = ['(已精简)'];
      }
    }
  }
  if (render(true).length > maxChars) {
    for (const idx of lowerPriorityIndices) {
      if (render(true).length <= maxChars) break;
      const sec = sections[idx];
      if (getTrimPriority(sec.heading) >= 1) {
        sec.body = ['(已精简)'];
      }
    }
  }

  // Phase 4: ONLY after all lower-priority sections are collapsed, trim Pinned Axioms (priority 0)
  // while preserving up to 10 axioms first, then gracefully narrowing if budget is extreme.
  if (render(true).length > maxChars) {
    for (const idx of axiomIndices) {
      if (render(true).length <= maxChars) break;
      const sec = sections[idx];
      const nonEmpty = sec.body.filter((l) => l.trim().length > 0);
      if (nonEmpty.length > 10) {
        sec.body = nonEmpty.slice(0, 10);
      }
      if (render(true).length <= maxChars) break;
      const working = sec.body.filter((l) => l.trim().length > 0);
      while (working.length > 3 && render(true).length > maxChars) {
        working.pop();
        sec.body = [...working];
      }
      if (render(true).length > maxChars) {
        sec.body = sec.body
          .filter((l) => l.trim().length > 0)
          .map((l) => (l.length > 120 ? `${l.slice(0, 119)}…` : l));
      }
    }
  }

  // Phase 5: Hard ceiling guarantee while preserving generation tag, SOUL_RECALL_HINT_LINE & BUDGET_TRIM_NOTICE when space allows
  let result = render(true);
  if (result.length > maxChars) {
    const pinnedFooterParts = [];
    if (hadRecallHint) pinnedFooterParts.push(SOUL_RECALL_HINT_LINE);
    pinnedFooterParts.push(BUDGET_TRIM_NOTICE);
    const fullFooter = `\n\n${pinnedFooterParts.join('\n')}`;
    const recallOnlyFooter = hadRecallHint ? `\n\n${SOUL_RECALL_HINT_LINE}` : '';
    const noticeOnlyFooter = `\n\n${BUDGET_TRIM_NOTICE}`;

    const chosenFooter = maxChars > fullFooter.length + 24
      ? fullFooter
      : (hadRecallHint && maxChars > recallOnlyFooter.length + 24
        ? recallOnlyFooter
        : (maxChars > noticeOnlyFooter.length + 24 ? noticeOnlyFooter : ''));

    if (chosenFooter) {
      const bodyWithoutFooter = result
        .replaceAll(BUDGET_TRIM_NOTICE, '')
        .replaceAll(SOUL_RECALL_HINT_LINE, '')
        .trim();
      const headBudget = maxChars - chosenFooter.length - 1;
      const prefix = genTagLine && !bodyWithoutFooter.startsWith(genTagLine) && headBudget > genTagLine.length + 8
        ? `${genTagLine}\n`
        : '';
      const sliceLen = Math.max(1, headBudget - prefix.length);
      result = `${prefix}${bodyWithoutFooter.slice(0, sliceLen).trimEnd()}…${chosenFooter}`;
    } else if (maxChars <= 8) {
      result = result.slice(0, maxChars);
    } else {
      result = `${result.slice(0, maxChars - 1).trimEnd()}…`;
    }
  }
  return result;
}

/**
 * In-place rewrite for `@deepseek-ai/dsh-llm`'s `llm/stream` waterfall options.
 * When `options.purpose === 'compaction'`:
 * - Performs a read-only scan of `options.messages.slice(0, -1)` to detect compaction generation (`1` vs `k >= 2`).
 * - Preserves `options.messages.slice(0, -1)` with exact object identity (100% DeepSeek KV Prefix Cache hit).
 * - Replaces ONLY the trailing `user` compaction instruction message.
 *
 * @param {any} options
 * @returns {boolean} Whether the compaction prompt was replaced
 */
export function rewriteCompactionStreamOptions(options) {
  if (!options || typeof options !== 'object') return false;
  if (options.purpose !== 'compaction') return false;
  if (!Array.isArray(options.messages) || options.messages.length === 0) return false;

  const lastIdx = options.messages.length - 1;
  const lastMsg = options.messages[lastIdx];
  if (!lastMsg || typeof lastMsg !== 'object' || lastMsg.role !== 'user') {
    return false;
  }

  const { generation } = detectCompactionGeneration(options.messages);
  const instruction = generation === 1
    ? SOUL_COMPACTION_INSTRUCTION
    : buildSoulCompactionInstruction({ generation });

  let updatedLast = null;
  if (typeof lastMsg.content === 'string') {
    updatedLast = {
      ...lastMsg,
      content: instruction,
    };
  } else if (Array.isArray(lastMsg.content)) {
    let replacedTextBlock = false;
    const nextContent = lastMsg.content.map((part) => {
      if (!replacedTextBlock && part && typeof part === 'object' && part.type === 'text') {
        replacedTextBlock = true;
        return { ...part, type: 'text', text: instruction };
      }
      return part;
    });
    if (!replacedTextBlock) {
      nextContent.push({ type: 'text', text: instruction });
    }
    updatedLast = {
      ...lastMsg,
      content: nextContent,
    };
  } else {
    return false;
  }

  if (Object.isFrozen(options.messages)) {
    options.messages = [...options.messages.slice(0, lastIdx), updatedLast];
  } else {
    options.messages[lastIdx] = updatedLast;
  }
  return true;
}

/**
 * Wrap a compaction LLM chunk stream with a volume convergence guardrail so that
 * `framedSummaryTokenCount < shadowedRouteTokenCount` holds even for small compaction spans,
 * keeping BOTH `text-delta` and `block-end.block.text` strictly synchronized for `BlockAssembler`.
 *
 * @param {AsyncIterable<any>} sourceStream
 * @param {any} options
 * @returns {AsyncGenerator<any, void, void>}
 */
export async function* wrapCompactionStreamWithBudgetGuard(sourceStream, options) {
  const shadowedBudgetTokens = estimateShadowedBudgetTokens(options?.messages);
  const budget = computeSummaryBudget(shadowedBudgetTokens, { messages: options?.messages });
  const { generation } = detectCompactionGeneration(options?.messages);

  // If we cannot estimate a positive shadowed region budget, pass stream straight through
  if (!budget) {
    for await (const chunk of sourceStream) {
      yield chunk;
    }
    return;
  }

  const collected = [];
  const textPartials = new Map();
  const blockOrder = [];
  let finishReason = null;

  for await (const chunk of sourceStream) {
    collected.push(chunk);
    if (!chunk || typeof chunk !== 'object') continue;

    if (chunk.type === 'block-start') {
      if (chunk.blockType === 'text' && !textPartials.has(chunk.index)) {
        textPartials.set(chunk.index, {
          index: chunk.index,
          sawStart: true,
          sawEnd: false,
          deltaText: '',
          endBlock: null,
        });
        blockOrder.push(chunk.index);
      }
    } else if (chunk.type === 'text-delta') {
      let entry = textPartials.get(chunk.index);
      if (!entry) {
        entry = {
          index: chunk.index,
          sawStart: false,
          sawEnd: false,
          deltaText: '',
          endBlock: null,
        };
        textPartials.set(chunk.index, entry);
        blockOrder.push(chunk.index);
      }
      if (!entry.sawEnd && typeof chunk.text === 'string') {
        entry.deltaText += chunk.text;
      }
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      let entry = textPartials.get(chunk.index);
      if (!entry) {
        entry = {
          index: chunk.index,
          sawStart: false,
          sawEnd: false,
          deltaText: '',
          endBlock: null,
        };
        textPartials.set(chunk.index, entry);
        blockOrder.push(chunk.index);
      }
      if (!entry.sawEnd) {
        entry.sawEnd = true;
        entry.endBlock = chunk.block;
      }
    } else if (chunk.type === 'finish') {
      finishReason = chunk.reason ?? null;
    }
  }

  // Pass error/aborted/empty streams through unmodified
  if (finishReason && (finishReason.kind === 'error' || finishReason.kind === 'aborted')) {
    for (const chunk of collected) yield chunk;
    return;
  }
  if (blockOrder.length === 0) {
    for (const chunk of collected) yield chunk;
    return;
  }

  const assembledTexts = blockOrder.map((idx) => {
    const entry = textPartials.get(idx);
    if (entry.sawEnd && typeof entry.endBlock?.text === 'string') {
      return entry.endBlock.text;
    }
    return entry.deltaText;
  });
  const combinedText = assembledTexts.join('\n').trim();
  const taggedText = ensureCompactionGenerationTag(combinedText, generation);
  const tagAddedOrNormalized = taggedText !== combinedText;
  const framedTokens = estimateFramedSummaryTokens(taggedText);

  if (!tagAddedOrNormalized && framedTokens <= budget.targetFramedTokens && framedTokens < shadowedBudgetTokens) {
    for (const chunk of collected) yield chunk;
    return;
  }

  // Either generation tag was injected/normalized, or summary exceeded budget:
  // compress summary text if needed so it stays strictly under both targetFramedTokens and shadowedBudgetTokens
  let trimmedText = taggedText;
  if (framedTokens > budget.targetFramedTokens || framedTokens >= shadowedBudgetTokens) {
    trimmedText = compressSummaryToBudget(taggedText, budget.maxSummaryChars, { generation });
    while (
      trimmedText.length > 8
      && estimateFramedSummaryTokens(trimmedText) >= shadowedBudgetTokens
    ) {
      const nextCap = Math.max(8, trimmedText.length - Math.max(8, Math.ceil(trimmedText.length * 0.15)));
      trimmedText = compressSummaryToBudget(trimmedText, nextCap, { generation });
    }
  }

  const primaryIndex = blockOrder[0];
  const primaryEntry = textPartials.get(primaryIndex);
  const textIndexSet = new Set(blockOrder);
  let emittedPrimaryDelta = false;
  let emittedPrimaryEnd = false;

  for (const chunk of collected) {
    if (!chunk || typeof chunk !== 'object') {
      yield chunk;
      continue;
    }

    const isTrackedTextChunk =
      (chunk.type === 'block-start' && chunk.blockType === 'text' && textIndexSet.has(chunk.index))
      || (chunk.type === 'text-delta' && textIndexSet.has(chunk.index))
      || (chunk.type === 'block-end' && chunk.block?.type === 'text' && textIndexSet.has(chunk.index));

    if (!isTrackedTextChunk) {
      yield chunk;
      continue;
    }

    // Collapse secondary text blocks into the single trimmed primary text block
    if (chunk.index !== primaryIndex) {
      continue;
    }

    if (chunk.type === 'block-start') {
      yield chunk;
    } else if (chunk.type === 'text-delta') {
      if (!emittedPrimaryDelta) {
        emittedPrimaryDelta = true;
        yield { ...chunk, type: 'text-delta', index: primaryIndex, text: trimmedText };
      }
    } else if (chunk.type === 'block-end') {
      if (!emittedPrimaryDelta) {
        emittedPrimaryDelta = true;
        yield { type: 'text-delta', index: primaryIndex, text: trimmedText };
      }
      if (!emittedPrimaryEnd) {
        emittedPrimaryEnd = true;
        yield {
          ...chunk,
          type: 'block-end',
          index: primaryIndex,
          block: {
            ...(primaryEntry?.endBlock ?? chunk.block),
            type: 'text',
            text: trimmedText,
          },
        };
      }
    }
  }
}

/**
 * Synchronous `llm/stream` Cordis waterfall handler.
 * - Non-compaction calls (`options.purpose !== 'compaction'`): 100% zero-overhead passthrough.
 * - Compaction calls: rewrites ONLY the trailing instruction message (keeping `messages.slice(0, -1)`
 *   object references intact for DeepSeek Prefix Cache), and wraps the returned AsyncIterable with
 *   the streaming volume convergence guardrail.
 *
 * @param {any} options
 * @param {Function} [next]
 * @returns {any}
 */
export function interceptCompactionStream(options, next) {
  if (!options || options.purpose !== 'compaction') {
    return typeof next === 'function' ? next() : options;
  }

  const rewritten = rewriteCompactionStreamOptions(options);
  const downstream = typeof next === 'function' ? next() : options;
  if (!rewritten || !downstream) {
    return downstream;
  }

  if (typeof downstream[Symbol.asyncIterator] === 'function') {
    return wrapCompactionStreamWithBudgetGuard(downstream, options);
  }
  if (typeof downstream.then === 'function') {
    return downstream.then((resolved) => {
      if (resolved && typeof resolved[Symbol.asyncIterator] === 'function') {
        return wrapCompactionStreamWithBudgetGuard(resolved, options);
      }
      return resolved;
    });
  }
  return downstream;
}

/**
 * Create a standalone Cordis plugin that upgrades all DSH automatic compactions
 * and `/compact` invocations to first-person anti-decay soul compaction with
 * streaming volume guardrails via `llm/stream` waterfall interception.
 *
 * @param {{ retainRatio?: number }} [pluginOptions]
 */
export function createSoulCompactionPlugin(pluginOptions = {}) {
  const retainRatio = typeof pluginOptions?.retainRatio === 'number'
    ? pluginOptions.retainRatio
    : DEFAULT_SOUL_RETAIN_RATIO;

  return {
    name: 'dsh-compaction-soul',
    retainRatio,
    async apply(ctx) {
      if (ctx && typeof ctx.on === 'function') {
        ctx.on('llm/stream', (options, next) => interceptCompactionStream(options, next));
      }
    },
  };
}

export default createSoulCompactionPlugin();
