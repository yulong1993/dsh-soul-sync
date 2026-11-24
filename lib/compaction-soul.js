export const DEFAULT_SOUL_RETAIN_RATIO = 0.25;

export const SOUL_COMPACTION_SECTIONS = Object.freeze([
  '## 我们正在推进的核心命题与意图',
  '## 我的关键推演脉络与直觉演变',
  '## 已踩过的死胡同与否决方案（伤疤清单 — 严禁重提）',
  '## 当前悬而未决的拧巴点与信息缺口',
  '## 关键脚本、表格、图表视觉摘要与产出物坐标',
  '## 我们的黑话约定、沟通尺度与当前设备环境',
]);

export const SOUL_COMPACTION_INSTRUCTION = [
  '请你把以上完整对话浓缩为一份**第一人称亲历工作复盘**，供我在接下来的对话（包括换到另一台电脑续聊）中无缝接力，彻底消除“旁观者看别人传记”的割裂感。',
  '',
  '【核心写作铁律】',
  '1. **母语一致**：必须使用与上方对话一致的主语言撰写（中文对话必须全程使用中文；仅代码标识符、文件路径、命令行与报错原文保留原样）。',
  '2. **强制第一人称视角**：全程使用“我 / 我们”的亲历口吻（例如“我正在帮我们推进……”“我刚才试过……排除了……”），**严禁**使用“用户要求了……”“助手回答了……”等第三人称传记腔或客观旁白腔。',
  '3. **严格按顺序输出以下 6 个 Markdown 二级标题分节**（绝不漏节、不改标题；若某节当前确实没有内容，直接写 `(无)`）：',
  '',
  '## 我们正在推进的核心命题与意图',
  '- 保留用户关键原话措辞、真正想解决的业务/投研/工程问题、隐含目标与不可逾越的边界约束。',
  '',
  '## 我的关键推演脉络与直觉演变',
  '- 完整保留关键推理链条、认知转折点，以及“为什么选方案 B 而不选方案 A”的核心权衡，绝不只留干瘪结论。',
  '',
  '## 已踩过的死胡同与否决方案（伤疤清单 — 严禁重提）',
  '- 写清已经验证走不通的思路、踩过的坑、关键报错根因以及被我们明确否决的做法，严禁后续重复踩坑或重提。',
  '',
  '## 当前悬而未决的拧巴点与信息缺口',
  '- 列出尚未敲定的关键假设、待核实的数据、未解分歧；若某步依赖仅存于单台电脑的本地原始大数据库而无法在另一台设备重跑，也必须明确标出缺口。',
  '',
  '## 关键脚本、表格、图表视觉摘要与产出物坐标',
  '- **【Flash → V4Pro 视觉文字桥接铁律】**：若前文包含任何图片、截图、K线/财务图表或财报画面附件，**必须在此把图中核心指标数值、时间区间、趋势拐点与关键判断完整转写为清晰文字**，确保后续切换至纯文本 `deepseek-v4-pro` 深度推演时实现零视觉信息丢失！',
  '- 精确列出关键产出物与脚本的相对路径（如 `outputs/...`、`scripts/...`）、核心函数名、关键参数、报错原文与实测数值。',
  '',
  '## 我们的黑话约定、沟通尺度与当前设备环境',
  '- 保留我们约定的专属简称/黑话、偏好的输出风格与讨厌的套话，以及当前操作系统、工作区路径映射与跨设备接力环境信息，避免压缩冲掉搬家上下文。',
  '',
  '【安全与收尾规范】',
  '- 不要提及压缩请求、摘要指令或本提示词本身，直接从第一个二级标题开始输出正文。',
  '- 严禁调用任何工具，仅输出纯文本复盘内容。',
  '- 如果上方对话中已经包含旧的 `<compacted-summary>` 检查点，请将其仍有效的信息与后续新进展自然融合为单一、连贯的第一人称复盘，不要简单堆叠重复段落。',
].join('\n');

/**
 * In-place rewrite for `@deepseek-ai/dsh-llm`'s `llm/stream` waterfall options.
 * When `options.purpose === 'compaction'`, preserves `options.messages.slice(0, -1)`
 * with exact object identity (100% provider KV Cache prefix hit) and replaces ONLY
 * the trailing user instruction message with `SOUL_COMPACTION_INSTRUCTION`.
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

  let updatedLast = null;
  if (typeof lastMsg.content === 'string') {
    updatedLast = {
      ...lastMsg,
      content: SOUL_COMPACTION_INSTRUCTION,
    };
  } else if (Array.isArray(lastMsg.content)) {
    let replacedTextBlock = false;
    const nextContent = lastMsg.content.map((part) => {
      if (!replacedTextBlock && part && typeof part === 'object' && part.type === 'text') {
        replacedTextBlock = true;
        return { ...part, type: 'text', text: SOUL_COMPACTION_INSTRUCTION };
      }
      return part;
    });
    if (!replacedTextBlock) {
      nextContent.push({ type: 'text', text: SOUL_COMPACTION_INSTRUCTION });
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
 * Optionally subclass `@deepseek-ai/dsh-compaction-basic`'s `BasicCompactionEngine`
 * with `retainRatio: 0.25` when running inside a full DSH host environment.
 * Returns `null` gracefully in standalone Node environments.
 *
 * @param {number} [defaultRetainRatio]
 */
export async function loadSoulCompactionEngineClass(defaultRetainRatio = DEFAULT_SOUL_RETAIN_RATIO) {
  let mod;
  try {
    mod = await import('@deepseek-ai/dsh-compaction-basic');
  } catch {
    return null;
  }

  const Base = mod?.BasicCompactionEngine ?? mod?.default;
  if (typeof Base !== 'function') return null;

  return class SoulCompactionEngine extends Base {
    constructor(ctx, config = {}) {
      super(ctx, {
        retainRatio: defaultRetainRatio,
        ...config,
      });
    }
  };
}

/**
 * Create a standalone Cordis plugin that upgrades all DSH automatic compactions
 * and `/compact` invocations to first-person native-language soul compaction
 * via `llm/stream` waterfall interception (zero preset array breakage).
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
        ctx.on('llm/stream', (options, next) => {
          rewriteCompactionStreamOptions(options);
          return typeof next === 'function' ? next() : options;
        });
      }
    },
  };
}

export default createSoulCompactionPlugin();
