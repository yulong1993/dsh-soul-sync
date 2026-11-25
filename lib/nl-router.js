/**
 * Zero-dependency deterministic natural-language intent router for `/soul`.
 *
 * Every `/soul` invocation resolves instantaneously with zero LLM calls:
 *  - Exact subcommands (`status`, `sync`, `handoff`, `pull`, `push`, `keep`, `config`, `compact`, `help`)
 *  - Natural-language Chinese/English phrasing mapped directly to deterministic local actions
 *  - Any unrecognized input returns `help-with-status` (instant cheat-sheet + live status card,
 *    never hijacking the active AI session with open-ended prompts).
 */

const EXACT_SUBCOMMANDS = new Set([
  'status',
  'sync',
  'handoff',
  'pull',
  'push',
  'keep',
  'config',
  'compact',
  'help',
]);

const KNOWN_FILE_EXT_PATTERN =
  '(?:xlsx|xlsm|xls|csv|py|md|pdf|png|jpe?g|gif|webp|svg|docx?|pptx?|json|txt|ipynb|parquet|ya?ml|sql|html?|css|ts|tsx|js|jsx|mjs|cjs|sh|ps1|bat|r|rmd)';

const QUOTED_PATH_RE = /[`"'「『]([^`"'「『\r\n]+)[`"'」』]/g;
const EXPLICIT_EXT_PATH_RE = new RegExp(
  `(?:[A-Za-z]:[\\\\/]|~\\/|\\.\\.?[\\\\/]|\\/)?[^\\s"'` + '`' + `<>|，。；：！？（）()【】「」『』]+\\.${KNOWN_FILE_EXT_PATTERN}(?=$|[\\s"'` + '`' + `，。；：！？）)】」』])`,
  'i',
);
const SLASH_PATH_RE = /(?:[A-Za-z]:[\\/]|~\/|\.\.?[\\/]|\/|[A-Za-z0-9_\u4e00-\u9fa5.-]+[\\/])[^\s"'`<>|，。；：！？（）()【】「」『』]+/;

const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s"'`<>|，。；：！？（）()【】「」『』]+/;
const MAC_PATH_RE = /(?:~\/|\/(?:Users|Volumes|home|opt|var|tmp|mnt)\/)[^\s"'`<>|，。；：！？（）()【】「」『』]+/;

const STEP_SYNC_TARGET_RE =
  /(?:(?:每\s*)?(?:30\s*秒|三十秒)|步级|运行中|自动防灾|防断电|防灾|定时).{0,8}(?:快照|备份|同步)|step[\s_-]*sync/i;
const DISABLE_VERB_RE = /(?:关闭|关掉|关了|关一下|停用|禁用|取消|停止|不要|别开|别做|disable|\boff\b)/i;
const ENABLE_VERB_RE = /(?:开启|打开|开一下|启用|恢复|重新开|enable|\bon\b)/i;

const KEEP_VERB_RE = /(?:纳管|纳入|加进|加入|加到|放进|记入|保留|账本|同步上|同步上去|也同步|一起同步|帮我同步)/i;

const PULL_RE =
  /(?:拉下来|拉取|拉回|从金库恢复|排空|暂存.{0,8}落位|把.{0,12}落位|同步到本地|同步下来)/i;

const HANDOFF_RE =
  /(?:下班|换机|换电脑|换机器|换设备|换台电脑|换\s*mac|换\s*win|换\s*windows|回家用\s*(?:mac|电脑)|回公司用\s*(?:win|windows|电脑)|中场交接|做一下.{0,6}交接|交接一下|开始交接|释放接力棒|合盖)/i;

const PUSH_RE =
  /(?:立即备份|马上备份|备份一下|备份当前|备份进度|存进.{0,8}金库|推送到金库|推送一下|立即推送|马上推送|全量备份)/i;

const SYNC_RE =
  /^(?:同步|同步一下|双向同步|接力|恢复|恢复一下|恢复进度|刷新|刷新一下|立即同步|马上同步)$|(?:帮我|请|立刻|马上|立即)?(?:同步一下|双向同步|接力同步|刷新同步|同步当前进度|最新进度.{0,4}同步|进度.{0,4}同步一下|同步最新|刷新一下|恢复进度|恢复一下|接力一下)/i;

const AMBIGUOUS_SINGLE_FILE_REF_RE = /(?:刚才那个|刚才那张|刚才那份|这个|那个|那张|那份).{0,10}(?:表|文件|脚本|报告|文档|模型)/;

const STATUS_RE =
  /(?:同步正常吗|正常吗|体检卡|检查.{0,6}状态|看看.{0,6}状态|查看.{0,6}状态|同步状态|有没有.{0,6}锁|excel\s*锁|占锁|双机状态|心跳)/i;

const COMPACT_RE =
  /(?:无损压缩|保尾压缩|压缩(?:一下|对话|上下文|历史)|整理(?:一下)?(?:上下文|对话)|给上下文瘦身|上下文瘦身|帮我压缩)/i;

const KEEP_TURNS_RE = /(?:保留|留|留住|保尾)\s*(\d+)\s*(?:轮|回合|次)?/;

const HELP_RE =
  /^(?:help|-h|--help|\?|？)$|(?:怎么用|如何使用|用法|帮助|你能帮我干嘛|你能做什么|有哪些命令|指令列表)/i;

const MAPPING_HINT_RE = /(?:绑定|映射|对应|配对|添加目录|关联|::|⇄|<->|->|到|和|与)/;

function stripTrailingPunct(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^[`"'「『]+|[`"'」』.,;:!?，。；：！？]+$/g, '');
}

function toMegabytes(numStr, unit) {
  const num = Number(numStr);
  if (!Number.isFinite(num) || num <= 0) return null;
  const u = String(unit ?? '').toUpperCase();
  if (u === 'G' || u === 'GB') {
    const mb = num * 1024;
    return Number.isInteger(mb) ? String(mb) : String(Number(mb.toFixed(2)));
  }
  return Number.isInteger(num) ? String(num) : String(num);
}

function extractQuotaConfigTokens(text) {
  const tokens = [];

  const maxFileMatch = /(?:单文件|单个文件|文件大小)(?:上限|限制|配额)?[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(GB|G|MB|M|兆)/i.exec(text);
  if (maxFileMatch) {
    const mb = toMegabytes(maxFileMatch[1], maxFileMatch[2]);
    if (mb) tokens.push(`maxFileMB=${mb}`);
  }

  const maxWsMatch = /(?:工作区|项目)(?:总|容量)?(?:上限|限制|配额)?[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(GB|G|MB|M|兆)/i.exec(text);
  if (maxWsMatch) {
    const mb = toMegabytes(maxWsMatch[1], maxWsMatch[2]);
    if (mb) tokens.push(`maxWorkspaceMB=${mb}`);
  }

  const retainMatch = /(?:历史版本|快照|版本)(?:保留|留存)?[^0-9]{0,10}(\d+)\s*(?:份|个|版)/i.exec(text);
  if (retainMatch) {
    const n = Number(retainMatch[1]);
    if (Number.isInteger(n) && n > 0) tokens.push(`retainSnapshots=${n}`);
  }

  const intervalMatch = /(?:快照|步级|备份|同步)间隔[^0-9]{0,10}(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i.exec(text);
  if (intervalMatch) {
    const sec = Number(intervalMatch[1]);
    if (Number.isFinite(sec) && sec > 0) tokens.push(`stepSyncSeconds=${sec}`);
  }

  const trashMatch = /(?:回收站|软删除|垃圾箱)[^0-9]{0,10}(\d+)\s*天/i.exec(text);
  if (trashMatch) {
    const days = Number(trashMatch[1]);
    if (Number.isInteger(days) && days > 0) tokens.push(`trashRetentionDays=${days}`);
  }

  return tokens;
}

function looksLikeFilePath(candidate) {
  const cleaned = stripTrailingPunct(candidate);
  if (!cleaned) return false;
  if (EXPLICIT_EXT_PATH_RE.test(cleaned)) return true;
  if ((cleaned.includes('/') || cleaned.includes('\\')) && !/^https?:\/\//i.test(cleaned)) {
    return true;
  }
  return false;
}

function extractExplicitFilePath(text) {
  QUOTED_PATH_RE.lastIndex = 0;
  let m;
  while ((m = QUOTED_PATH_RE.exec(text)) !== null) {
    const cand = stripTrailingPunct(m[1]);
    if (looksLikeFilePath(cand)) {
      return cand;
    }
  }

  const extMatch = EXPLICIT_EXT_PATH_RE.exec(text);
  if (extMatch) {
    return stripTrailingPunct(extMatch[0]);
  }

  const slashMatch = SLASH_PATH_RE.exec(text);
  if (slashMatch) {
    const cand = stripTrailingPunct(slashMatch[0]);
    if (cand && !/^https?:\/\//i.test(cand) && !/^\/soul\b/i.test(cand)) {
      return cand;
    }
  }

  return null;
}

/**
 * Parse a boolean toggle string (`on|off|true|false|1|0|yes|no`).
 * Returns `true`, `false`, or `null` if invalid.
 */
export function parseBooleanToggle(rawVal) {
  const v = String(rawVal ?? '').trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

/**
 * Parse `/soul` command input into a deterministic zero-latency local intent.
 *
 * @param {string} rawInput
 * @returns {
 *   | { kind: 'status' }
 *   | { kind: 'sync' }
 *   | { kind: 'handoff', extraNote: string }
 *   | { kind: 'pull' }
 *   | { kind: 'push' }
 *   | { kind: 'keep', targetPath: string }
 *   | { kind: 'config', argsText: string }
 *   | { kind: 'set-step-sync', enabled: boolean }
 *   | { kind: 'add-mapping', winPath: string, macPath: string }
 *   | { kind: 'compact', keepTurns: number }
 *   | { kind: 'help' }
 *   | { kind: 'help-with-status', rawInput: string }
 * }
 */
export function parseNaturalSoulIntent(rawInput) {
  const trimmed = String(rawInput ?? '').trim();
  if (!trimmed) {
    return { kind: 'status' };
  }

  // 0. Exact subcommand compatibility (100% preserved)
  const spaceIdx = trimmed.search(/\s/);
  const firstToken = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx).trim();

  if (EXACT_SUBCOMMANDS.has(firstToken)) {
    switch (firstToken) {
      case 'status':
        return { kind: 'status' };
      case 'sync':
        return { kind: 'sync' };
      case 'handoff':
        return { kind: 'handoff', extraNote: rest };
      case 'pull':
        return { kind: 'pull' };
      case 'push':
        return { kind: 'push' };
      case 'keep':
        return { kind: 'keep', targetPath: rest };
      case 'config':
        return { kind: 'config', argsText: rest };
      case 'compact': {
        const parsedTurns = /^\d+$/.test(rest) ? Number.parseInt(rest, 10) : 3;
        return {
          kind: 'compact',
          keepTurns: Number.isInteger(parsedTurns) && parsedTurns >= 1 ? parsedTurns : 3,
        };
      }
      case 'help':
        return { kind: 'help' };
    }
  }

  if (firstToken === '-h' || firstToken === '--help' || firstToken === '?' || firstToken === '？') {
    return { kind: 'help' };
  }

  // 1. Cross-OS workspace mapping binding (contains both Win & Mac paths)
  const winMatch = WIN_PATH_RE.exec(trimmed);
  const macMatch = MAC_PATH_RE.exec(trimmed);
  if (winMatch && macMatch && MAPPING_HINT_RE.test(trimmed)) {
    const winPath = stripTrailingPunct(winMatch[0]).normalize('NFC');
    const macPath = stripTrailingPunct(macMatch[0]).normalize('NFC');
    if (winPath && macPath) {
      return { kind: 'add-mapping', winPath, macPath };
    }
  }

  // 2. Natural-language quota adjustments (before step-sync toggle so "快照间隔改成 60 秒" routes to config)
  const quotaTokens = extractQuotaConfigTokens(trimmed);
  if (quotaTokens.length > 0) {
    return { kind: 'config', argsText: quotaTokens.join(' ') };
  }

  // 3. Toggle 30s step-level disaster-recovery snapshots
  if (STEP_SYNC_TARGET_RE.test(trimmed)) {
    if (DISABLE_VERB_RE.test(trimmed)) {
      return { kind: 'set-step-sync', enabled: false };
    }
    if (ENABLE_VERB_RE.test(trimmed)) {
      return { kind: 'set-step-sync', enabled: true };
    }
  }

  // 4. Tail-preserving lossless compaction
  if (COMPACT_RE.test(trimmed)) {
    const m = KEEP_TURNS_RE.exec(trimmed);
    const parsedTurns = m ? Number.parseInt(m[1], 10) : 3;
    return {
      kind: 'compact',
      keepTurns: Number.isInteger(parsedTurns) && parsedTurns >= 1 ? parsedTurns : 3,
    };
  }

  // 5. Keep / track an explicit file path
  if (KEEP_VERB_RE.test(trimmed)) {
    const explicitPath = extractExplicitFilePath(trimmed);
    if (explicitPath) {
      return { kind: 'keep', targetPath: explicitPath };
    }
  }

  // 6. Pull remote updates / drain .dsh-incoming
  if (PULL_RE.test(trimmed)) {
    return { kind: 'pull' };
  }

  // 7. Handoff before switching computers
  if (HANDOFF_RE.test(trimmed)) {
    return { kind: 'handoff', extraNote: trimmed };
  }

  // 8. Immediate backup / push (explicit push phrases)
  if (PUSH_RE.test(trimmed) && !AMBIGUOUS_SINGLE_FILE_REF_RE.test(trimmed)) {
    return { kind: 'push' };
  }

  // 9. Deterministic bidirectional sync (pull + push) for "同步 / 同步一下 / 接力 / 恢复 / 刷新"
  if (SYNC_RE.test(trimmed) && !AMBIGUOUS_SINGLE_FILE_REF_RE.test(trimmed)) {
    return { kind: 'sync' };
  }

  // 10. Status / health check
  if (STATUS_RE.test(trimmed)) {
    return { kind: 'status' };
  }

  // 11. Help card
  if (HELP_RE.test(trimmed)) {
    return { kind: 'help' };
  }

  // Fallback: instant cheat-sheet + current live status card (ZERO LLM calls, ZERO hijacking)
  return { kind: 'help-with-status', rawInput: trimmed };
}
