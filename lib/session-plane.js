import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolveDshHome,
  soulSyncDir,
  writeFileAtomic,
  mapPathAcrossOs,
  canonicalizeLocalPath,
  expandPosixHome,
  isBroadWorkspaceDirectory,
} from './config.js';
import {
  encodeSegment,
  projectKey,
  encodeV4SessionLog,
  decodeV4SessionLog,
} from './zstd-v4.js';

const GENESIS_CHAIN_HASH = '0'.repeat(64);
const DEFAULT_MAX_FORMAT_VERSION = 4;
const HEX_64_RE = /^(?:sha256:)?([0-9a-f]{64})$/i;
const VERSIONED_LOG_RE = /^session\.v([1-9][0-9]*)\.jsonl\.zstd$/;
const LEGACY_LOG_NAME = 'session.jsonl.zstd';
const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const UNMAPPED_OUTPUT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const UNMAPPED_OUTPUT_MAX_TOTAL_BYTES = 30 * 1024 * 1024; // 30 MB per session
const UNMAPPED_OUTPUT_TEXT_SCAN_LIMIT = 2 * 1024 * 1024; // 2 MB secret content scan cap
const SENSITIVE_OUTPUT_NAME_RE = /(?:^\.env(?:\..+)?$|credential|secret|\.pem$|\.key$|^id_(?:rsa|dsa|ed25519|ecdsa))/i;
const SENSITIVE_OUTPUT_CONTENT_RE = /(?:\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/;
const SENSITIVE_CONTENT_REDACT_RE = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b)/g;
const SKIPPED_OUTPUT_NAME_RE = /^(?:~\$|\.DS_Store$|Thumbs\.db$|desktop\.ini$)|\.(?:tmp|temp|part|crdownload|swp|swo)$/i;
const CONFLICT_OUTPUT_NAME_RE = /\.conflict-/i;
const STALE_COMPACTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const PROJ_CACHE_DOMAIN_VERSION = 7;
const SESSION_FILE_MODIFY_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'str_replace_editor',
  'multi_edit',
  'patch',
  'apply_patch',
  'create_file',
  'save_file',
  'present',
  'present_files',
  'deliverables_present',
]);

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function extractSha256(value) {
  if (typeof value !== 'string') return null;
  const match = HEX_64_RE.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

function normalizePosixSlashes(raw) {
  let s = String(raw).normalize('NFC').replace(/\\/g, '/');
  if (s.startsWith('//')) {
    s = '//' + s.slice(2).replace(/\/+/g, '/');
  } else {
    s = s.replace(/\/+/g, '/');
  }
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) {
    s = s.replace(/\/+$/, '');
  }
  return s;
}

function isWin32Absolute(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
}

function isPosixAbsolute(p) {
  return typeof p === 'string' && p.startsWith('/');
}

function isAbsoluteForPlatform(p, platform) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (platform === 'win32') return isWin32Absolute(p);
  return isPosixAbsolute(p);
}

function isAnyAbsolutePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  return isWin32Absolute(p) || isPosixAbsolute(p);
}

function formatPathForPlatform(rawPath, targetPlatform) {
  const posixForm = normalizePosixSlashes(rawPath);
  if (targetPlatform === 'win32') {
    return posixForm.replace(/\//g, '\\').normalize('NFC');
  }
  return posixForm.normalize('NFC');
}

function basenameForPlatform(p, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  return api.basename(p) || api.parse(p).root || 'workspace';
}

function sanitizeMirrorFolderName(rawName) {
  let clean = String(rawName ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '');
  if (!clean || clean === '.' || clean === '..') clean = 'workspace';
  const dot = clean.indexOf('.');
  const stem = (dot < 0 ? clean : clean.slice(0, dot)).replace(/[. ]+$/u, '');
  if (WINDOWS_DEVICE_NAME_RE.test(stem)) {
    clean = `_${clean}`;
  }
  return clean.normalize('NFC');
}

function extractTextFromUserEvent(ev) {
  if (!ev || ev.type !== 'user/message') return '';
  const content = ev.data?.content ?? ev.data?.message?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
    if (content.some((b) => b && (b.type === 'image' || b.type === 'image_ref' || b.type === 'file'))) {
      return '[附件消息]';
    }
  } else if (typeof content === 'string' && content.trim()) {
    return content.replace(/\s+/g, ' ').trim();
  }
  if (typeof ev.data?.text === 'string' && ev.data.text.trim()) {
    return ev.data.text.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function extractTextFromAssistantEvent(ev) {
  if (!ev || ev.type !== 'assistant/message') return '';
  const content = ev.data?.message?.content ?? ev.data?.content ?? ev.data?.stream;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim();
  }
  if (typeof content === 'string') return content.trim();
  if (typeof ev.data?.text === 'string') return ev.data.text.trim();
  return '';
}

const SOUL_CARD_SIGNATURE_RE = /(?:《双机接力体检卡》|Soul Sync 速查指南|《跨机迁移工作区与对话清单》|### 双向同步完成|拉取完成：会话新增|推送完成：同步会话|选择性(?:拉取|推送)完成|已切换为「|### Soul Sync 当前配置|已绑定跨系统工作区映射)/;

function isSyntheticSoulCommandTurn(events, userIdx) {
  const ev = events[userIdx];
  const text = extractTextFromUserEvent(ev);
  if (!/^\/soul(?:\s|$)/i.test(text)) return false;
  // Look ahead for the paired assistant card message in the same turn
  for (let j = userIdx + 1; j < events.length; j += 1) {
    const next = events[j];
    if (!next) continue;
    if (next.type === 'user/message') break;
    if (next.type === 'assistant/message') {
      const reply = extractTextFromAssistantEvent(next);
      if (SOUL_CARD_SIGNATURE_RE.test(reply)) {
        return true;
      }
      return false;
    }
  }
  return false;
}

export function isRealHumanUserMessage(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  const msg = ev.data?.message ?? ev.data;
  if (!msg || typeof msg !== 'object') return false;
  const source = msg.source;
  if (source && typeof source === 'object') {
    if (source.syntheticSoulCard === true) return false;
    if (source.kind !== 'user') return false;
    return extractTextFromUserEvent(ev).length > 0;
  }
  const text = extractTextFromUserEvent(ev);
  if (!text) return false;
  if (text.startsWith('【跨设备接力备注】') || text.startsWith('【同步提醒】')) return false;
  return true;
}

/**
 * Count real human user message turns in a session event log.
 * Excludes non-user context injections (`dsh-soul-sync`, `dsh-time-context`, `runtime-context`,
 * `compact-checkpoint`) and synthetic `/soul` blank-page card turns.
 */
export function countUserTurns(events = []) {
  if (!Array.isArray(events)) return 0;
  let turns = 0;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    if (!isRealHumanUserMessage(ev)) continue;
    if (isSyntheticSoulCommandTurn(events, i)) continue;
    turns += 1;
  }
  return turns;
}

const INSTALL_WIZARD_STRONG_RE = /(?:请你帮我安装并配置\s*DeepSeek\s*Harness|安装并配对\s*DeepSeek\s*Harness\s*跨机同步插件|请你帮我在这台电脑上安装并配对\s*DeepSeek\s*Harness|按里面的\s*4\s*步向导|我是非技术用户[\s\S]{0,40}不需要我敲命令行|我不需要手动敲命令行[\s\S]{0,40}请你全程替我执行)/i;
const INSTALL_WIZARD_SCRIPT_RE = /(?:install-win\.ps1|install-mac\.sh|INSTALL_PROMPT\.md)/i;
const INSTALL_WIZARD_ACTION_RE = /(?:安装并配置|帮我安装|替我安装|一键安装|配对另一台|4\s*步向导|-NonInteractive|--non-interactive)/i;
const INSTALL_WIZARD_DEV_INTENT_RE = /(?:修改|改动|修复|重构|优化|润色|检查|审查|review|转义|文案|兼容性|代码|脚本问题|单测|测试|bug|报错)/i;

/**
 * Detect short one-off installation / peer-pairing wizard conversations so they do not
 * auto-sync noise (or any passphrase typed in chat) to other devices by default,
 * while NEVER misclassifying normal dev conversations discussing `install-win.ps1` / `INSTALL_PROMPT.md`.
 */
export function isInstallWizardSession(events = []) {
  if (!Array.isArray(events) || events.length === 0) return false;
  let humanTurns = 0;
  let firstHumanText = '';
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    if (!isRealHumanUserMessage(ev)) continue;
    if (isSyntheticSoulCommandTurn(events, i)) continue;
    humanTurns += 1;
    if (humanTurns === 1) {
      firstHumanText = extractTextFromUserEvent(ev);
    }
    if (humanTurns > 6) return false;
  }
  if (humanTurns === 0 || !firstHumanText) return false;
  if (!/dsh-soul-sync/i.test(firstHumanText)) return false;
  if (INSTALL_WIZARD_STRONG_RE.test(firstHumanText)) return true;
  if (
    INSTALL_WIZARD_SCRIPT_RE.test(firstHumanText)
    && INSTALL_WIZARD_ACTION_RE.test(firstHumanText)
    && !INSTALL_WIZARD_DEV_INTENT_RE.test(firstHumanText)
  ) {
    return true;
  }
  return false;
}

/**
 * Determine whether a session has real substantive content (vs a 0-turn blank shell window
 * or a synthetic `/soul` status/help card window).
 */
export function isSubstantiveSession(events = [], header = null) {
  if (header?.isSeeded === true) return true;
  if (!Array.isArray(events) || events.length === 0) return false;
  if (countUserTurns(events) > 0) return true;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'compaction/end') return true;
    const sourceKind = ev.data?.source?.kind ?? ev.data?.message?.source?.kind;
    if (sourceKind === 'compact-checkpoint') return true;
  }
  return false;
}

/**
 * Extract human-readable session title:
 *  1) Latest non-empty `session/title` event
 *  2) First real human `user/message` text (up to 48 chars)
 *  3) `fallbackId`
 */
export function extractSessionTitle(events = [], fallbackId = 'session') {
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type === 'session/title' && typeof ev.data?.title === 'string' && ev.data.title.trim().length > 0) {
        return ev.data.title.trim();
      }
    }
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      if (isRealHumanUserMessage(ev) && !isSyntheticSoulCommandTurn(events, i)) {
        const text = extractTextFromUserEvent(ev);
        if (text) return text.slice(0, 48);
      }
    }
  }
  return fallbackId;
}

function cleanFocusSnippet(rawText, maxChars = 160) {
  if (typeof rawText !== 'string' || !rawText.trim()) return '';
  let cleaned = rawText
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // P1-2: If the message consisted solely of a fenced code block (note: `extractTextFromUserEvent`
  // collapses newlines into spaces before calling here!), strip fence markers (` ```lang ` and ` ``` `)
  // and keep a concise code preview rather than returning an empty `「」`!
  if (!cleaned) {
    cleaned = rawText
      .replace(/```[A-Za-z0-9_+-]*(?=\s|$)/g, ' ')
      .replace(/```/g, ' ')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) {
      cleaned = '[代码片段]';
    }
  }
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

const CONTINUITY_RULE_TEXT =
  '【跨机接力延续准则】请忽略换机时自动刷新的 <system-reminder> 环境/技能目录与 [model changed] 通道切换提示噪音：'
  + '若我本轮提问属于顺延追问、落地建议探讨或简短接续（如“对我们自己做产品有什么建议？”“怎么落地？”“继续”），请优先紧扣上述【当前紧邻主焦点】的具体子议题以第一人称直接深入回答，切勿因换机重刷系统提示而擅自拉远镜头做全篇综述；'
  + '仅当我明确要求“总结/回顾前面全部内容”或主动切换新话题时，才拉回全局视角。';

/**
 * Extract up to the last `maxTurns` completed substantive human-assistant turns from `events`
 * (ignoring non-user context injections, `/soul` synthetic cards, and errored/unanswered turns)
 * and format a compact 3-tier funnel near-focus anchor to counteract cross-OS `<system-reminder>`
 * recency dilution without drowning out the active sub-topic.
 */
export function buildNearFocusAnchorBlock(events = [], { maxTurns = 3 } = {}) {
  if (!Array.isArray(events) || events.length === 0) return '';

  const completedTurns = [];
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    if (!isRealHumanUserMessage(ev)) continue;
    if (isSyntheticSoulCommandTurn(events, i)) continue;

    const userText = extractTextFromUserEvent(ev);
    if (!userText) continue;

    const turnAssistantTexts = [];
    for (let j = i + 1; j < events.length; j += 1) {
      const next = events[j];
      if (!next || typeof next !== 'object') continue;
      if (isRealHumanUserMessage(next)) break;
      if (next.type === 'assistant/message') {
        const replyText = extractTextFromAssistantEvent(next);
        if (replyText) turnAssistantTexts.push(replyText);
      }
    }

    // P1-2: Walk assistant messages in the turn BACKWARDS so multi-step tool turns capture
    // the FINAL concluding synthesis rather than Step 1's "好的，我先读取文件..." preamble!
    let finalAssistantText = '';
    for (let k = turnAssistantTexts.length - 1; k >= 0; k -= 1) {
      if (cleanFocusSnippet(turnAssistantTexts[k], 220)) {
        finalAssistantText = turnAssistantTexts[k];
        break;
      }
    }
    if (!finalAssistantText) continue;
    completedTurns.push({ userText, assistantText: finalAssistantText });
  }

  // P2-1: Fallback for pure seeded `compact-checkpoint` sessions with 0 raw human turns
  if (completedTurns.length === 0) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (!ev || typeof ev !== 'object') continue;
      const srcKind = ev.data?.source?.kind ?? ev.data?.message?.source?.kind;
      if (srcKind !== 'compact-checkpoint') continue;
      const ckptText = extractTextFromUserEvent(ev) || extractTextFromAssistantEvent(ev);
      const snippet = cleanFocusSnippet(ckptText, 240);
      if (snippet) {
        return [
          '【当前紧邻主焦点（压缩交接摘要）】',
          `- 最近阶段进展摘要：${snippet}`,
          CONTINUITY_RULE_TEXT,
        ].join('\n');
      }
    }
    return '';
  }

  const windowSize = Math.max(1, Math.min(5, Math.trunc(maxTurns) || 3));
  const recent = completedTurns.slice(-windowSize);
  const lastTurn = recent[recent.length - 1];
  const priorTurns = recent.slice(0, -1);

  const lines = [];
  if (priorTurns.length > 0) {
    const trail = priorTurns.map((t) => `「${cleanFocusSnippet(t.userText, 36)}」`).join(' → ');
    lines.push(`【近景演进路标】${trail} → 当前焦点：「${cleanFocusSnippet(lastTurn.userText, 42)}」`);
  }
  lines.push(
    '【当前紧邻主焦点（换机前最后一轮特写）】',
    `- 上一轮我的提问：「${cleanFocusSnippet(lastTurn.userText, 140)}」`,
    `- 上一轮核心落点：${cleanFocusSnippet(lastTurn.assistantText, 220)}`,
    CONTINUITY_RULE_TEXT,
  );
  return lines.join('\n');
}

const ACTIVE_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
  'turn/end',
  'step/end',
  'compaction/end',
]);

/**
 * Extract the last real activity timestamp (ms) of a session.
 */
export function extractLastActiveAt(events = [], header = null) {
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!ev || typeof ev !== 'object') continue;
      if (!ACTIVE_EVENT_TYPES.has(ev.type)) continue;
      const ts = typeof ev.time === 'number' && Number.isFinite(ev.time)
        ? ev.time
        : typeof ev.timestamp === 'number' && Number.isFinite(ev.timestamp)
          ? ev.timestamp
          : null;
      if (ts !== null) return ts;
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const ts = typeof ev?.time === 'number' && Number.isFinite(ev.time)
        ? ev.time
        : typeof ev?.timestamp === 'number' && Number.isFinite(ev.timestamp)
          ? ev.timestamp
          : null;
      if (ts !== null) return ts;
    }
  }
  if (typeof header?.createdAt === 'number' && Number.isFinite(header.createdAt)) {
    return header.createdAt;
  }
  return 0;
}

function normalizeWorkspaceMatchKey(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
  return normalizePosixSlashes(rawPath).toLowerCase();
}

/**
 * Check if a workspace path (`cwd`) matches any selector in `selectors`
 * (accepts exact path, mapping id, mapping title, or basename when unambiguous).
 */
export function matchesWorkspaceSelector(cwd, selectors = [], workspaceMappings = [], platform = process.platform) {
  if (!Array.isArray(selectors) || selectors.length === 0) return false;
  const cwdKey = normalizeWorkspaceMatchKey(cwd);
  const srcPlat = isWin32Absolute(cwd) ? 'win32' : isPosixAbsolute(cwd) ? 'darwin' : platform;
  const cwdBase = cwd ? basenameForPlatform(cwd, srcPlat).normalize('NFC').toLowerCase() : '';
  const mapped = cwd ? mapPathAcrossOs(cwd, workspaceMappings, platform) : { workspaceId: null, matched: false };
  const mappedEntry = mapped.workspaceId
    ? workspaceMappings.find((m) => m && m.id === mapped.workspaceId)
    : null;

  for (const rawSel of selectors) {
    if (typeof rawSel !== 'string') continue;
    const sel = rawSel.trim().normalize('NFC');
    if (!sel) continue;
    const selLower = sel.toLowerCase();

    if (mappedEntry) {
      if (mappedEntry.id.toLowerCase() === selLower) return true;
      if (mappedEntry.title && mappedEntry.title.toLowerCase() === selLower) return true;
      for (const osKey of ['win32', 'darwin', 'linux']) {
        if (mappedEntry[osKey] && normalizeWorkspaceMatchKey(mappedEntry[osKey]) === normalizeWorkspaceMatchKey(sel)) {
          return true;
        }
      }
    }

    if (cwdKey && normalizeWorkspaceMatchKey(sel) === cwdKey) {
      return true;
    }

    if (!sel.includes('/') && !sel.includes('\\') && cwdBase && cwdBase === selLower) {
      return true;
    }
  }
  return false;
}

function hasOverrideValueMatch(overrides, rawPath) {
  if (!overrides || typeof overrides !== 'object' || !rawPath) return false;
  const needle = normalizeWorkspaceMatchKey(rawPath);
  if (!needle) return false;
  for (const v of Object.values(overrides)) {
    if (typeof v !== 'string' || !v.trim()) continue;
    if (normalizeWorkspaceMatchKey(v) === needle) return true;
  }
  return false;
}

/**
 * Determine whether a local session should be automatically synced according to config
 * (`folderMatchMode`, `syncScope`, `selectedWorkspaces`, `selectedSessionIds`, `excludedSessionIds`, `withdrawnSessions`).
 */
export function shouldAutoSyncSession(
  { sessionId, header = null, events = [] },
  config = {},
  platform = process.platform,
) {
  const excluded = new Set(Array.isArray(config.excludedSessionIds) ? config.excludedSessionIds : []);
  if (sessionId && excluded.has(sessionId)) {
    return { allowed: false, reason: 'excluded' };
  }

  const selectedIds = new Set(Array.isArray(config.selectedSessionIds) ? config.selectedSessionIds : []);
  const explicitlySelected = Boolean(sessionId && selectedIds.has(sessionId));

  // Do not auto-re-push sessions withdrawn from the vault unless restored (restoredAt >= withdrawnAt)
  // or given newer activity after withdrawal. NEVER let selectedSessionIds bypass an active withdrawal!
  const withdrawnAt = sessionId && config.withdrawnSessions && typeof config.withdrawnSessions === 'object'
    ? Number(config.withdrawnSessions[sessionId] ?? 0)
    : 0;
  const restoredAt = sessionId && config.restoredSessions && typeof config.restoredSessions === 'object'
    ? Number(config.restoredSessions[sessionId] ?? 0)
    : 0;
  if (withdrawnAt > restoredAt) {
    const lastActive = extractLastActiveAt(events, header);
    if (lastActive <= withdrawnAt) {
      return { allowed: false, reason: 'withdrawn' };
    }
  }

  if (!explicitlySelected && !isSubstantiveSession(events, header)) {
    return { allowed: false, reason: 'empty-shell' };
  }

  if (!explicitlySelected && isInstallWizardSession(events)) {
    return { allowed: false, reason: 'install-wizard' };
  }

  const cwd = header?.cwd || '';
  const mappings = Array.isArray(config.workspaceMappings) ? config.workspaceMappings : [];
  const folderMatchMode = config.folderMatchMode === 'mapped-only' ? 'mapped-only' : 'auto-mirror';

  if (folderMatchMode === 'mapped-only' && !explicitlySelected) {
    const mapped = cwd ? mapPathAcrossOs(cwd, mappings, platform) : { matched: false };
    const hasOverride = Boolean(
      (sessionId && config.sessionTargetOverrides && Object.hasOwn(config.sessionTargetOverrides, sessionId))
      || (cwd && lookupPathOverride(config.workspaceTargetOverrides, cwd))
      || (cwd && hasOverrideValueMatch(config.workspaceTargetOverrides, cwd))
      || (cwd && hasOverrideValueMatch(config.sessionTargetOverrides, cwd)),
    );
    if (!mapped.matched && !hasOverride) {
      return { allowed: false, reason: 'unmapped-only' };
    }
  }

  const syncScope = config.syncScope === 'selected' ? 'selected' : 'active';
  if (syncScope === 'selected') {
    if (explicitlySelected) return { allowed: true, reason: 'selected-session' };
    if (matchesWorkspaceSelector(cwd, config.selectedWorkspaces ?? [], mappings, platform)) {
      return { allowed: true, reason: 'selected-workspace' };
    }
    return { allowed: false, reason: 'unselected' };
  }

  return { allowed: true, reason: 'active' };
}

function lookupPathOverride(overrides, rawPath) {
  if (!overrides || typeof overrides !== 'object' || !rawPath) return null;
  if (typeof overrides[rawPath] === 'string' && overrides[rawPath].trim()) {
    return overrides[rawPath].trim().normalize('NFC');
  }
  const needle = normalizeWorkspaceMatchKey(rawPath);
  if (!needle) return null;
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v !== 'string' || !v.trim()) continue;
    if (normalizeWorkspaceMatchKey(k) === needle) {
      return v.trim().normalize('NFC');
    }
  }
  return null;
}

function resolveAutoMirrorBaseDir({
  autoMirrorRoot = undefined,
  targetPlatform = process.platform,
  cordisCtx = null,
  defaultWorkspaceDir = undefined,
  vaultDirs = [],
  dshHome = undefined,
}) {
  if (typeof autoMirrorRoot === 'string' && autoMirrorRoot.trim().length > 0) {
    return formatPathForPlatform(autoMirrorRoot.trim(), targetPlatform);
  }
  const wsReg = cordisCtx?.workspaceRegistry;
  if (wsReg?.state?.defaultWorkspaceId && typeof wsReg.get === 'function') {
    const defWs = wsReg.get(wsReg.state.defaultWorkspaceId);
    if (defWs?.path && !isVaultPath(defWs.path, vaultDirs) && !isUnmappedWorkspacePath(defWs.path, dshHome)) {
      const api = targetPlatform === 'win32' ? path.win32 : path.posix;
      const defFormatted = formatPathForPlatform(defWs.path, targetPlatform);
      return formatPathForPlatform(api.join(api.dirname(defFormatted), 'workspaces'), targetPlatform);
    }
  }
  if (typeof defaultWorkspaceDir === 'string' && defaultWorkspaceDir.trim().length > 0) {
    const api = targetPlatform === 'win32' ? path.win32 : path.posix;
    const defFormatted = formatPathForPlatform(defaultWorkspaceDir.trim(), targetPlatform);
    return formatPathForPlatform(api.join(api.dirname(defFormatted), 'workspaces'), targetPlatform);
  }
  if (targetPlatform === process.platform) {
    return path.join(os.homedir(), 'Documents', 'deepseek-harness', 'workspaces').normalize('NFC');
  }
  if (targetPlatform === 'win32') {
    return 'C:\\Users\\dsh\\Documents\\deepseek-harness\\workspaces';
  }
  return '/Users/dsh/Documents/deepseek-harness/workspaces';
}

function sanitizeSourcePathSegments(rawPath) {
  const posixForm = normalizePosixSlashes(rawPath);
  const rawSegments = posixForm.split('/').filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
  const cleaned = rawSegments.map((seg) => {
    let s = seg
      .replace(/:/g, '')
      .replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_')
      .trim()
      .replace(/[. ]+$/u, '');
    if (!s || s === '.' || s === '..') s = '_';
    if (WINDOWS_DEVICE_NAME_RE.test(s.split('.')[0])) s = `_${s}`;
    return s;
  });
  return cleaned.length > 0 ? cleaned : ['root'];
}

function sanitizeAttachmentLeafName(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0) return 'file';
  const nfc = rawName.normalize('NFC');
  const base = nfc.slice(Math.max(nfc.lastIndexOf('/'), nfc.lastIndexOf('\\')) + 1);
  let clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '');
  const dot = clean.indexOf('.');
  const stem = (dot < 0 ? clean : clean.slice(0, dot)).replace(/[. ]+$/u, '');
  if (WINDOWS_DEVICE_NAME_RE.test(stem)) {
    clean = `_${clean}`;
  }
  if (!clean || clean === '.' || clean === '..') return 'file';
  return clean.normalize('NFC');
}

function projectDirNameForCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '_no-cwd';
  return projectKey(cwd);
}

function extractInheritedEventCount(header) {
  if (!header || typeof header !== 'object') return 0;
  if (typeof header.inheritedEventCount === 'number' && Number.isSafeInteger(header.inheritedEventCount) && header.inheritedEventCount >= 0) {
    return header.inheritedEventCount;
  }
  if (typeof header.seedLength === 'number' && Number.isSafeInteger(header.seedLength) && header.seedLength >= 0) {
    return header.seedLength;
  }
  return 0;
}

function extractRelativeUnderRoot(rawPath, rootPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim() || typeof rootPath !== 'string' || !rootPath.trim()) {
    return null;
  }
  const rawPosix = normalizePosixSlashes(rawPath);
  const rootPosix = normalizePosixSlashes(rootPath);
  const rawLower = rawPosix.toLowerCase();
  const rootLower = rootPosix.toLowerCase();
  if (rawLower === rootLower) {
    return '';
  }
  const prefix = rootLower.endsWith('/') ? rootLower : `${rootLower}/`;
  if (rawLower.startsWith(prefix)) {
    return rawPosix.slice(prefix.length).normalize('NFC');
  }
  return null;
}

function joinFormattedPath(baseDir, relPosix, targetPlatform) {
  const basePosix = normalizePosixSlashes(baseDir);
  const combined = relPosix
    ? `${basePosix.endsWith('/') ? basePosix.slice(0, -1) : basePosix}/${relPosix}`
    : basePosix;
  return formatPathForPlatform(combined, targetPlatform);
}

/**
 * Normalize a path into a cross-OS logical representation (`{{WS:<id>}}/<relPosix>`
 * or `{{SESSION_CWD}}/<relPosix>`) so Win <-> Mac roundtrips produce identical event
 * hash chains even without explicit `workspaceMappings`.
 *
 * @param {string} rawPath
 * @param {Array<Record<string, any>>} [workspaceMappings]
 * @param {string} [sessionRootCwd]
 * @returns {string}
 */
export function normalizeLogicalPath(rawPath, workspaceMappings = [], sessionRootCwd = '') {
  const nfc = String(rawPath ?? '').normalize('NFC');
  if (!nfc) return '';
  const mapped = mapPathAcrossOs(nfc, workspaceMappings, 'darwin');
  if (mapped.workspaceId !== null && mapped.relativePosixPath !== null) {
    return mapped.relativePosixPath
      ? `{{WS:${mapped.workspaceId}}}/${mapped.relativePosixPath}`
      : `{{WS:${mapped.workspaceId}}}`;
  }
  if (typeof sessionRootCwd === 'string' && sessionRootCwd.trim().length > 0) {
    const rel = extractRelativeUnderRoot(nfc, sessionRootCwd);
    if (rel !== null) {
      return rel ? `{{SESSION_CWD}}/${rel}` : '{{SESSION_CWD}}';
    }
  }
  return normalizePosixSlashes(nfc);
}

function isEphemeralResumeMarker(event) {
  return Boolean(event && typeof event === 'object' && event.type === 'session/end-seed');
}

export function filterSubstantiveLineageEvents(events = []) {
  if (!Array.isArray(events)) return [];
  return events.filter((ev) => !isEphemeralResumeMarker(ev));
}

function remapSeqArray(seqs, seqMap) {
  if (!Array.isArray(seqs) || !seqMap) return seqs;
  return seqs.map((s) => (typeof s === 'number' && seqMap.has(s) ? seqMap.get(s) : s));
}

function remapSurfaceOpSeqs(surfaceOp, seqMap) {
  if (!surfaceOp || typeof surfaceOp !== 'object' || !seqMap) return surfaceOp;
  const next = { ...surfaceOp };
  if (typeof next.startSeq === 'number' && seqMap.has(next.startSeq)) {
    next.startSeq = seqMap.get(next.startSeq);
  }
  if (typeof next.endSeq === 'number' && seqMap.has(next.endSeq)) {
    next.endSeq = seqMap.get(next.endSeq);
  }
  return next;
}

export function remapEventSeqReferences(event, seqMap) {
  if (!event || typeof event !== 'object' || !seqMap || seqMap.size === 0) return event;
  let next = event;
  if (event.surfaceOp && typeof event.surfaceOp === 'object') {
    const remapped = remapSurfaceOpSeqs(event.surfaceOp, seqMap);
    if (remapped !== event.surfaceOp) next = { ...next, surfaceOp: remapped };
  }
  if (Array.isArray(event.sourceEventSeqs)) {
    next = { ...next, sourceEventSeqs: remapSeqArray(event.sourceEventSeqs, seqMap) };
  }
  if (event.data && typeof event.data === 'object') {
    let nextData = null;
    if (Array.isArray(event.data.messageSeqs)) {
      nextData = { ...(nextData ?? event.data), messageSeqs: remapSeqArray(event.data.messageSeqs, seqMap) };
    }
    if (typeof event.data.startSeq === 'number' && seqMap.has(event.data.startSeq)) {
      nextData = { ...(nextData ?? event.data), startSeq: seqMap.get(event.data.startSeq) };
    }
    if (typeof event.data.endSeq === 'number' && seqMap.has(event.data.endSeq)) {
      nextData = { ...(nextData ?? event.data), endSeq: seqMap.get(event.data.endSeq) };
    }
    if (typeof event.data.headerSeq === 'number' && seqMap.has(event.data.headerSeq)) {
      nextData = { ...(nextData ?? event.data), headerSeq: seqMap.get(event.data.headerSeq) };
    }
    if (Array.isArray(event.data.sourceEventSeqs)) {
      nextData = { ...(nextData ?? event.data), sourceEventSeqs: remapSeqArray(event.data.sourceEventSeqs, seqMap) };
    }
    if (nextData) {
      next = { ...next, data: nextData };
    }
  }
  return next;
}

function normalizeEventForHash(event, workspaceMappings, sessionRootCwd = '', logicalSeq = null, rawToLogical = null) {
  if (!event || typeof event !== 'object') return event;
  let normalized = event;
  if (event.type === 'working-directory/change' && typeof event.data?.cwd === 'string') {
    normalized = {
      ...normalized,
      data: {
        ...normalized.data,
        cwd: normalizeLogicalPath(event.data.cwd, workspaceMappings, sessionRootCwd),
      },
    };
  } else if (event.type === 'deliverables/presented' && Array.isArray(event.data?.files)) {
    normalized = {
      ...normalized,
      data: {
        ...normalized.data,
        files: event.data.files.map((item) => {
          if (item && typeof item === 'object' && typeof item.path === 'string') {
            return {
              ...item,
              path: normalizeLogicalPath(item.path, workspaceMappings, sessionRootCwd),
            };
          }
          return item;
        }),
      },
    };
  }
  if (rawToLogical && rawToLogical.size > 0) {
    normalized = remapEventSeqReferences(normalized, rawToLogical);
  }
  // Exclude volatile wall-clock `time` and normalize `seq` to the logical substantive index
  // so `session/end-seed` resume markers and in-place `liveSession.append()` re-stamps NEVER cause false forks!
  const { time: _omitTime, ...rest } = normalized;
  if (typeof logicalSeq === 'number') {
    rest.seq = logicalSeq;
  }
  return rest;
}

function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJsonStringify(item))).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJsonStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Compute an incremental SHA-256 hash chain over substantive session events after
 * ignoring ephemeral `session/end-seed` resume markers, normalizing OS-rewritable paths
 * (`working-directory/change` and `deliverables/presented`), and normalizing `seq` to
 * logical substantive indices (excluding wall-clock `time`) with canonical key ordering.
 *
 * @param {Array<Record<string, any>>} events
 * @param {Array<Record<string, any>>} [workspaceMappings]
 * @param {string} [sessionRootCwd]
 * @returns {{ headHash: string, chainHashes: string[], substantiveCount: number }}
 */
export function computeEventHashChain(events = [], workspaceMappings = [], sessionRootCwd = '') {
  const substantive = filterSubstantiveLineageEvents(events);
  const rawToLogical = new Map();
  for (let i = 0; i < substantive.length; i += 1) {
    const rawSeq = substantive[i]?.seq;
    if (typeof rawSeq === 'number') {
      rawToLogical.set(rawSeq, i);
    }
  }
  const chainHashes = [];
  let prev = GENESIS_CHAIN_HASH;
  for (let i = 0; i < substantive.length; i += 1) {
    const normalized = normalizeEventForHash(substantive[i], workspaceMappings, sessionRootCwd, i, rawToLogical);
    prev = sha256Hex(`${prev}\n${canonicalJsonStringify(normalized)}`);
    chainHashes.push(prev);
  }
  return {
    headHash: prev,
    chainHashes,
    substantiveCount: substantive.length,
  };
}

/**
 * Recursively scan session events for image and file attachment references.
 *
 * @param {Array<Record<string, any>>} events
 * @returns {Array<{ kind: 'image' | 'file', sha256: string, name?: string }>}
 */
export function scanSessionAttachments(events = []) {
  const discovered = new Map();

  function recordRef(kind, sha256, name) {
    const cleanName = typeof name === 'string' && name.length > 0 ? name.normalize('NFC') : undefined;
    const key = `${kind}:${sha256}:${cleanName ?? ''}`;
    if (!discovered.has(key)) {
      discovered.set(key, cleanName ? { kind, sha256, name: cleanName } : { kind, sha256 });
    }
  }

  function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const type = node.type;
    const directSha =
      extractSha256(node.attachmentId)
      ?? extractSha256(node.sha256)
      ?? extractSha256(node.digest)
      ?? extractSha256(node.id);
    const nestedSourceSha =
      node.source && typeof node.source === 'object'
        ? (extractSha256(node.source.attachmentId)
          ?? extractSha256(node.source.sha256)
          ?? extractSha256(node.source.digest)
          ?? extractSha256(node.source.id))
        : null;
    const sha = directSha ?? nestedSourceSha;

    if (sha) {
      if (type === 'file') {
        const name = node.name ?? node.filename ?? node.fileName ?? node.source?.name;
        recordRef('file', sha, name);
      } else if (type === 'image' || type === 'image_ref' || typeof node.attachmentId === 'string') {
        const name = node.name ?? node.filename ?? node.fileName;
        const kind = type === 'image' || type === 'image_ref' ? 'image' : (typeof name === 'string' ? 'file' : 'image');
        recordRef(kind, sha, kind === 'file' ? name : undefined);
      }
    }

    for (const val of Object.values(node)) {
      if (val !== null && typeof val === 'object') {
        walk(val);
      }
    }
  }

  for (const ev of events) {
    walk(ev);
  }
  return [...discovered.values()];
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function discoverAttachmentNames(attachRoot, sha256) {
  const dir = path.join(attachRoot, 'files', sha256.slice(0, 2), sha256);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name.normalize('NFC'));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

async function packAttachmentsForEvents(dshHome, allEvents, vault) {
  const refs = scanSessionAttachments(allEvents);
  const attachRoot = path.join(resolveDshHome(dshHome), 'attachments', 'v1');
  const packed = [];
  const seenPacked = new Set();

  for (const ref of refs) {
    const bucket = ref.sha256.slice(0, 2);
    const objPath = path.join(attachRoot, 'objects', bucket, ref.sha256);
    const fileObjPath = path.join(attachRoot, 'file-objects', bucket, ref.sha256);

    let kind = ref.kind;
    let bytes = null;
    let names = ref.name ? [ref.name] : [];

    if (kind === 'file') {
      bytes = await readIfExists(fileObjPath);
      if (!bytes && names.length > 0) {
        bytes = await readIfExists(path.join(attachRoot, 'files', bucket, ref.sha256, sanitizeAttachmentLeafName(names[0])));
      }
      if (!bytes) {
        const diskNames = await discoverAttachmentNames(attachRoot, ref.sha256);
        if (names.length === 0) names = diskNames;
        for (const n of diskNames) {
          bytes = await readIfExists(path.join(attachRoot, 'files', bucket, ref.sha256, n));
          if (bytes) break;
        }
      }
      if (!bytes) {
        bytes = await readIfExists(objPath);
      }
      if (names.length === 0) {
        const diskNames = await discoverAttachmentNames(attachRoot, ref.sha256);
        if (diskNames.length > 0) names = diskNames;
      }
    } else {
      bytes = await readIfExists(objPath);
      if (!bytes) {
        bytes = await readIfExists(fileObjPath);
        if (bytes) {
          kind = 'file';
          const diskNames = await discoverAttachmentNames(attachRoot, ref.sha256);
          if (names.length === 0) names = diskNames;
        }
      }
    }

    if (!bytes) continue;

    const blobRef = await vault.putBlob(bytes);
    if (kind === 'file') {
      const effectiveNames = names.length > 0 ? names : ['file'];
      for (const name of effectiveNames) {
        const nfcName = sanitizeAttachmentLeafName(name);
        const dedup = `file:${blobRef.sha256}:${nfcName}`;
        if (seenPacked.has(dedup)) continue;
        seenPacked.add(dedup);
        packed.push({
          kind: 'file',
          sha256: blobRef.sha256,
          name: nfcName,
          storageKey: blobRef.storageKey,
          size: blobRef.size,
        });
      }
    } else {
      const dedup = `image:${blobRef.sha256}`;
      if (seenPacked.has(dedup)) continue;
      seenPacked.add(dedup);
      packed.push({
        kind: 'image',
        sha256: blobRef.sha256,
        storageKey: blobRef.storageKey,
        size: blobRef.size,
      });
    }
  }

  return packed;
}

async function writeAttachmentFileSafe(targetPath, bytes, expectedSha256) {
  try {
    const existing = await fs.readFile(targetPath);
    if (sha256Hex(existing) === expectedSha256) {
      return false; // Identical content already exists (avoids Windows EPERM on 0o400)
    }
    await fs.chmod(targetPath, 0o666).catch(() => {});
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      await fs.chmod(targetPath, 0o666).catch(() => {});
    }
  }
  await writeFileAtomic(targetPath, bytes, { mode: 0o600 });
  return true;
}

async function restoreAttachments(dshHome, attachments = [], vault) {
  const attachRoot = path.join(resolveDshHome(dshHome), 'attachments', 'v1');
  let restoredCount = 0;

  for (const att of attachments) {
    const bytes = await vault.getBlob(att.storageKey, att.sha256, att.size);
    const sha = att.sha256.toLowerCase();
    const bucket = sha.slice(0, 2);

    // Always reconstruct objects/<2hex>/<sha256>
    const objTarget = path.join(attachRoot, 'objects', bucket, sha);
    await writeAttachmentFileSafe(objTarget, bytes, sha);

    if (att.kind === 'file') {
      const fileObjTarget = path.join(attachRoot, 'file-objects', bucket, sha);
      await writeAttachmentFileSafe(fileObjTarget, bytes, sha);
      const leafName = sanitizeAttachmentLeafName(att.name || 'file');
      const namedTarget = path.join(attachRoot, 'files', bucket, sha, leafName);
      await writeAttachmentFileSafe(namedTarget, bytes, sha);
    }

    restoredCount += 1;
  }

  return restoredCount;
}

async function findHighestVersionLog(sessionDir) {
  let entries;
  try {
    entries = await fs.readdir(sessionDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }

  let best = null;
  for (const name of entries) {
    if (name === LEGACY_LOG_NAME) {
      if (!best || best.version < 0) {
        best = { version: 0, filename: name, logPath: path.join(sessionDir, name) };
      }
      continue;
    }
    const m = VERSIONED_LOG_RE.exec(name);
    if (!m) continue;
    const ver = Number.parseInt(m[1], 10);
    if (!best || ver > best.version) {
      best = { version: ver, filename: name, logPath: path.join(sessionDir, name) };
    }
  }
  return best;
}

const LOCAL_SESSION_DECODE_CACHE = new Map();

export function clearLocalSessionScanCache(logPath = null) {
  if (logPath) {
    LOCAL_SESSION_DECODE_CACHE.delete(logPath);
  } else {
    LOCAL_SESSION_DECODE_CACHE.clear();
  }
}

/**
 * Scan `<dshHome>/sessions/<projKey>/<encodeSegment(sessionId)>/` for all local sessions,
 * using `(logPath, mtimeMs, size)` caching to avoid redundant Zstd decompression.
 *
 * @param {string} dshHome
 * @returns {Promise<Map<string, any>>}
 */
export async function scanLocalSessions(dshHome) {
  const sessionsRoot = path.join(resolveDshHome(dshHome), 'sessions');
  const map = new Map();

  let projDirs;
  try {
    projDirs = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return map;
    throw err;
  }

  for (const proj of projDirs) {
    if (!proj.isDirectory()) continue;
    const projPath = path.join(sessionsRoot, proj.name);
    let sessDirs;
    try {
      sessDirs = await fs.readdir(projPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sess of sessDirs) {
      if (!sess.isDirectory()) continue;
      const sessionDir = path.join(projPath, sess.name);
      const best = await findHighestVersionLog(sessionDir);
      if (!best) continue;

      let st;
      try {
        st = await fs.stat(best.logPath);
      } catch {
        continue;
      }

      let record;
      const cached = LOCAL_SESSION_DECODE_CACHE.get(best.logPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        record = cached.record;
        // Refresh LRU position
        LOCAL_SESSION_DECODE_CACHE.delete(best.logPath);
        LOCAL_SESSION_DECODE_CACHE.set(best.logPath, cached);
      } else {
        let decoded;
        try {
          const raw = await fs.readFile(best.logPath);
          decoded = await decodeV4SessionLog(raw);
        } catch {
          continue;
        }

        const id = decoded.header?.id;
        if (typeof id !== 'string' || id.length === 0) continue;

        record = {
          sessionId: id,
          projKey: proj.name,
          sessionDir,
          logPath: best.logPath,
          formatVersion: decoded.header.version ?? best.version,
          header: decoded.header,
          events: decoded.events,
          inheritedEventCount: extractInheritedEventCount(decoded.header),
          recoveredTornTail: decoded.recoveredTornTail,
        };
        if (LOCAL_SESSION_DECODE_CACHE.has(best.logPath)) {
          LOCAL_SESSION_DECODE_CACHE.delete(best.logPath);
        } else if (LOCAL_SESSION_DECODE_CACHE.size >= 250) {
          const oldestKey = LOCAL_SESSION_DECODE_CACHE.keys().next().value;
          if (oldestKey !== undefined) LOCAL_SESSION_DECODE_CACHE.delete(oldestKey);
        }
        LOCAL_SESSION_DECODE_CACHE.set(best.logPath, {
          mtimeMs: st.mtimeMs,
          size: st.size,
          record,
        });
      }

      const id = record.sessionId;
      const existing = map.get(id);
      if (!existing || record.formatVersion > existing.formatVersion || record.events.length > existing.events.length) {
        map.set(id, record);
      }
    }
  }

  return map;
}

function extractModelTriple(events = []) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'request/header') {
      const cfg = ev.data?.header?.config ?? ev.data?.config;
      if (cfg && typeof cfg === 'object') {
        return {
          provider: cfg.provider ?? null,
          model: cfg.model ?? null,
          reasoningEffort: cfg.reasoningEffort ?? null,
        };
      }
    }
  }
  return null;
}

function extractCatalogChildIds(events = []) {
  const childIds = [];
  for (const ev of events) {
    if (ev?.type === 'subagent/catalog' || ev?.type === 'subagent/descriptor') {
      const cid = ev.data?.childId ?? ev.data?.childSessionId ?? ev.data?.sessionId;
      if (typeof cid === 'string' && cid.length > 0) {
        childIds.push(cid);
      }
    }
  }
  return childIds;
}

function isSplitBrainVisibleBranch(header) {
  return (
    typeof header?.id === 'string'
    && header.id.startsWith('session-branch-')
    && header.origin !== 'subagent'
  );
}

/**
 * Detect whether a session event log currently has an unclosed `compaction/start`
 * transaction (matching `@deepseek-ai/dsh-compaction-basic`'s durable lock rule):
 * scans backwards from the tail; if `compaction/start` is seen before any matching
 * `compaction/end` or later `session/end-seed`, returns `true` — UNLESS that
 * `compaction/start` is stale (> 10 minutes old, indicating a crashed process).
 *
 * @param {Array<Record<string, any>>} events
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function hasUnclosedCompaction(events = [], nowMs = Date.now()) {
  if (!Array.isArray(events) || events.length === 0) return false;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    const type = ev?.type;
    if (type === 'compaction/end' || type === 'session/end-seed') {
      return false;
    }
    if (type === 'compaction/start') {
      const startedAt =
        typeof ev.time === 'number' && Number.isFinite(ev.time)
          ? ev.time
          : typeof ev.timestamp === 'number' && Number.isFinite(ev.timestamp)
            ? ev.timestamp
            : typeof ev.data?.startedAt === 'number' && Number.isFinite(ev.data.startedAt)
              ? ev.data.startedAt
              : null;
      if (startedAt !== null && nowMs - startedAt > STALE_COMPACTION_TIMEOUT_MS) {
        return false;
      }
      return true;
    }
  }
  return false;
}

function isVaultPath(rawPath, vaultDirs = []) {
  if (!rawPath || typeof rawPath !== 'string') return false;
  for (const v of vaultDirs) {
    if (typeof v !== 'string' || !v.trim()) continue;
    if (extractRelativeUnderRoot(rawPath, v) !== null) {
      return true;
    }
  }
  return false;
}

function isUnmappedWorkspacePath(rawPath, dshHome) {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const posix = normalizePosixSlashes(rawPath).toLowerCase();
  if (
    posix.includes('/unmapped-workspaces/')
    || posix.endsWith('/unmapped-workspaces')
    || posix.includes('/fallback-workspaces/')
    || posix.endsWith('/fallback-workspaces')
  ) {
    return true;
  }
  if (dshHome) {
    const ssDir = soulSyncDir(dshHome);
    if (
      extractRelativeUnderRoot(rawPath, path.join(ssDir, 'unmapped-workspaces')) !== null
      || extractRelativeUnderRoot(rawPath, path.join(ssDir, 'fallback-workspaces')) !== null
    ) {
      return true;
    }
  }
  return false;
}

async function isExistingLocalDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    const st = await fs.stat(dirPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function sessionProducedFilesPath(dshHome) {
  return path.join(soulSyncDir(dshHome), 'session-produced-files.json');
}

export async function loadSessionProducedFiles(dshHome) {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionProducedFilesPath(dshHome), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    return {};
  }
}

export async function recordSessionProducedFile(dshHome, sessionId, filePath, sessionCwd = '') {
  if (!dshHome || !sessionId || !filePath) return;
  const rel = normalizeOutputRelPath(filePath, sessionCwd);
  if (!rel) return;
  const state = await loadSessionProducedFiles(dshHome);
  const existing = Array.isArray(state[sessionId]) ? state[sessionId] : [];
  if (existing.includes(rel)) return;
  state[sessionId] = [...existing, rel];
  await writeFileAtomic(sessionProducedFilesPath(dshHome), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
}

function sessionOriginsPath(dshHome) {
  return path.join(soulSyncDir(dshHome), 'session-origins.json');
}

export async function loadSessionOrigins(dshHome) {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionOriginsPath(dshHome), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    return {};
  }
}

async function recordSessionOrigin(dshHome, sessionId, originDeviceId) {
  if (!dshHome || !sessionId || !originDeviceId) return;
  const origins = await loadSessionOrigins(dshHome);
  if (origins[sessionId] === originDeviceId) return;
  origins[sessionId] = originDeviceId;
  await writeFileAtomic(sessionOriginsPath(dshHome), `${JSON.stringify(origins, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
}

function normalizeOutputRelPath(rawPath, sessionCwd = '') {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  let rel = null;
  if (sessionCwd && isAnyAbsolutePath(rawPath)) {
    rel = extractRelativeUnderRoot(rawPath, sessionCwd);
  } else if (!isAnyAbsolutePath(rawPath)) {
    rel = normalizePosixSlashes(rawPath).replace(/^\.\//, '');
  }
  if (!rel) return null;
  const lower = rel.toLowerCase();
  if (lower.startsWith('outputs/')) {
    return rel.slice('outputs/'.length).normalize('NFC');
  }
  return null;
}

function collectToolArgPathsForAttribution(rawArgs, out) {
  let obj = rawArgs;
  if (typeof obj === 'string') {
    const t = obj.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return;
    try {
      obj = JSON.parse(t);
    } catch {
      return;
    }
  }
  if (!obj || typeof obj !== 'object') return;
  for (const key of ['path', 'file_path', 'filePath', 'targetPath', 'TargetFile', 'file']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) {
      out.push(obj[key].trim());
    }
  }
  if (Array.isArray(obj.paths)) {
    for (const p of obj.paths) {
      if (typeof p === 'string' && p.trim()) out.push(p.trim());
    }
  }
  if (Array.isArray(obj.files)) {
    for (const f of obj.files) {
      if (typeof f === 'string' && f.trim()) out.push(f.trim());
      else if (f && typeof f === 'object' && typeof f.path === 'string' && f.path.trim()) out.push(f.path.trim());
    }
  }
}

function extractSessionProducedOutputRelPaths(events = [], sessionCwd = '') {
  const out = new Set();
  if (!Array.isArray(events)) return out;
  const pendingCalls = new Map();

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'assistant/message') {
      const content = ev.data?.message?.content ?? ev.data?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool-call') {
            const toolName = String(block.name ?? '').toLowerCase();
            if (!SESSION_FILE_MODIFY_TOOLS.has(toolName)) continue;
            const paths = [];
            collectToolArgPathsForAttribution(block.input, paths);
            collectToolArgPathsForAttribution(block.arguments, paths);
            if (typeof block.id === 'string' && block.id) {
              pendingCalls.set(block.id, paths);
            } else {
              for (const p of paths) {
                const rel = normalizeOutputRelPath(p, sessionCwd);
                if (rel) out.add(rel.toLowerCase());
              }
            }
          }
        }
      }
    } else if (ev.type === 'tool/result') {
      const msg = ev.data?.message ?? ev.data;
      const callId = msg?.toolCallId ?? msg?.source?.callId ?? ev.data?.callId ?? null;
      const paths = callId ? pendingCalls.get(callId) : null;
      if (callId) pendingCalls.delete(callId);
      if (paths && msg?.isError !== true) {
        for (const p of paths) {
          const rel = normalizeOutputRelPath(p, sessionCwd);
          if (rel) out.add(rel.toLowerCase());
        }
      }
    } else if (ev.type === 'deliverables/presented') {
      const files = Array.isArray(ev.data?.files) ? ev.data.files : [];
      for (const item of files) {
        const p = typeof item === 'string' ? item : item?.path;
        const rel = normalizeOutputRelPath(p, sessionCwd);
        if (rel) out.add(rel.toLowerCase());
      }
    }
  }

  // Also include unclosed/result-less tool-calls in synthetic test fixtures where only assistant/message was logged
  for (const paths of pendingCalls.values()) {
    for (const p of paths) {
      const rel = normalizeOutputRelPath(p, sessionCwd);
      if (rel) out.add(rel.toLowerCase());
    }
  }
  return out;
}

function redactPlaintextSecretsInValue(value) {
  if (typeof value === 'string') {
    if (!SENSITIVE_OUTPUT_CONTENT_RE.test(value)) return value;
    SENSITIVE_CONTENT_REDACT_RE.lastIndex = 0;
    return value.replace(SENSITIVE_CONTENT_REDACT_RE, '[REDACTED_SECRET]');
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = redactPlaintextSecretsInValue(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const next = redactPlaintextSecretsInValue(v);
      if (next !== v) changed = true;
      out[k] = next;
    }
    return changed ? out : value;
  }
  return value;
}

async function packUnmappedSessionOutputs({
  sessionCwd,
  workspaceMappings = [],
  vault,
  excludeRelPaths = null,
}) {
  if (!sessionCwd || typeof sessionCwd !== 'string' || !vault) return { packed: [], skipped: [] };
  // Only pack lightweight outputs/ when sessionCwd is NOT mapped to a managed workspace and is NOT the vault itself
  const mapped = mapPathAcrossOs(sessionCwd, workspaceMappings, process.platform);
  if (mapped.matched) return { packed: [], skipped: [] };
  if (isVaultPath(sessionCwd, [vault.vaultDir])) return { packed: [], skipped: [] };

  const outputsRoot = path.join(sessionCwd, 'outputs');
  if (!(await isExistingLocalDir(outputsRoot))) return { packed: [], skipped: [] };

  const packed = [];
  const skipped = [];
  let totalBytes = 0;

  async function walk(curDir, relPrefix) {
    let entries;
    try {
      entries = await fs.readdir(curDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const name = entry.name.normalize('NFC');
      if (SKIPPED_OUTPUT_NAME_RE.test(name) || CONFLICT_OUTPUT_NAME_RE.test(name)) {
        continue;
      }
      const relPosix = relPrefix ? `${relPrefix}/${name}` : name;
      if (excludeRelPaths && excludeRelPaths.has(relPosix.toLowerCase())) {
        continue;
      }
      if (SENSITIVE_OUTPUT_NAME_RE.test(name)) {
        skipped.push({ path: `outputs/${relPosix}`, reason: 'sensitive-filename' });
        continue;
      }
      const fullPath = path.join(curDir, entry.name);
      let lst;
      try {
        lst = await fs.lstat(fullPath);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;

      if (lst.isDirectory()) {
        if (name === '.git' || name === 'node_modules' || name === '.work' || name === '.dsh-incoming') {
          continue;
        }
        await walk(fullPath, relPosix);
        continue;
      }

      if (!lst.isFile()) continue;
      if ((lst.nlink ?? 1) > 1) continue; // Skip hard links
      if (lst.size > UNMAPPED_OUTPUT_MAX_FILE_BYTES) {
        skipped.push({ path: `outputs/${relPosix}`, reason: 'exceeds-10mb-limit', size: lst.size });
        continue;
      }
      if (totalBytes + lst.size > UNMAPPED_OUTPUT_MAX_TOTAL_BYTES) {
        skipped.push({ path: `outputs/${relPosix}`, reason: 'exceeds-30mb-session-limit', size: lst.size });
        continue;
      }

      let bytes;
      try {
        bytes = await fs.readFile(fullPath);
      } catch {
        continue;
      }
      if (bytes.length > UNMAPPED_OUTPUT_MAX_FILE_BYTES) {
        skipped.push({ path: `outputs/${relPosix}`, reason: 'exceeds-10mb-limit', size: bytes.length });
        continue;
      }
      if (totalBytes + bytes.length > UNMAPPED_OUTPUT_MAX_TOTAL_BYTES) {
        skipped.push({ path: `outputs/${relPosix}`, reason: 'exceeds-30mb-session-limit', size: bytes.length });
        continue;
      }

      // Scan small text files for leaked API keys / private keys
      if (bytes.length <= UNMAPPED_OUTPUT_TEXT_SCAN_LIMIT && !bytes.includes(0x00)) {
        const textSample = bytes.toString('utf8');
        if (SENSITIVE_OUTPUT_CONTENT_RE.test(textSample)) {
          skipped.push({ path: `outputs/${relPosix}`, reason: 'sensitive-content' });
          continue;
        }
      }

      const blobRef = await vault.putBlob(bytes);
      totalBytes += blobRef.size;
      packed.push({
        relPosixPath: relPosix.normalize('NFC'),
        sha256: blobRef.sha256,
        storageKey: blobRef.storageKey,
        size: blobRef.size,
        mtimeMs: Math.round(lst.mtimeMs),
      });
    }
  }

  await walk(outputsRoot, '');
  return { packed, skipped };
}

function sessionOutputsStatePath(dshHome) {
  return path.join(soulSyncDir(dshHome), 'session-outputs-state.json');
}

async function loadSessionOutputsState(dshHome) {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionOutputsStatePath(dshHome), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
}

async function saveSessionOutputsState(dshHome, state) {
  await writeFileAtomic(sessionOutputsStatePath(dshHome), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function isSafeRelativePosixPath(relPosix) {
  if (typeof relPosix !== 'string' || relPosix.length === 0) return false;
  if (relPosix.startsWith('/') || relPosix.includes('\\') || relPosix.includes('\u0000')) return false;
  const parts = relPosix.split('/');
  return parts.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

function buildOutputConflictPath(targetPath, remoteLabel, remoteSha = '') {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const stem = path.basename(targetPath, ext);
  const safeLabel = String(remoteLabel || 'remote')
    .replace(/[<>:"/\\|?*\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'remote';
  const sha8 = String(remoteSha || '').replace(/[^0-9a-f]/gi, '').slice(0, 8) || 'remote';
  return path.join(dir, `${stem}.conflict-${safeLabel}-${sha8}${ext}`);
}

async function restoreUnmappedSessionOutputs({
  dshHome,
  sessionId,
  targetCwd,
  packedOutputs = [],
  vault,
  remoteLabel = 'remote',
  targetPlatform = process.platform,
  vaultDirs = [],
  skipIfSigUnchanged = false,
}) {
  if (!Array.isArray(packedOutputs) || packedOutputs.length === 0) {
    return { restored: 0, conflicts: [] };
  }
  if (targetPlatform !== process.platform) {
    return { restored: 0, conflicts: [] };
  }
  if (!targetCwd || !isAbsoluteForPlatform(targetCwd, targetPlatform) || isVaultPath(targetCwd, vaultDirs)) {
    return { restored: 0, conflicts: [] };
  }

  const state = await loadSessionOutputsState(dshHome);
  const meta = state.__meta && typeof state.__meta === 'object' ? { ...state.__meta } : {};
  const allConflicts = meta.conflicts && typeof meta.conflicts === 'object' ? { ...meta.conflicts } : {};
  const appliedSigs = meta.appliedOutputsSig && typeof meta.appliedOutputsSig === 'object' ? { ...meta.appliedOutputsSig } : {};
  const curSig = outputsSignature(packedOutputs);

  if (skipIfSigUnchanged && appliedSigs[sessionId] === curSig) {
    return { restored: 0, conflicts: [] };
  }

  const sessState = state[sessionId] && typeof state[sessionId] === 'object' ? { ...state[sessionId] } : {};
  const sessConflicts = allConflicts[sessionId] && typeof allConflicts[sessionId] === 'object'
    ? { ...allConflicts[sessionId] }
    : {};
  const outputsRoot = path.join(targetCwd, 'outputs');
  let restored = 0;
  const conflicts = [];
  let stateChanged = false;

  for (const item of packedOutputs) {
    if (!item || !isSafeRelativePosixPath(item.relPosixPath)) continue;
    if (CONFLICT_OUTPUT_NAME_RE.test(item.relPosixPath)) continue;
    const relSegments = item.relPosixPath.split('/');
    const targetPath = path.join(outputsRoot, ...relSegments);

    const bytes = await vault.getBlob(item.storageKey, item.sha256, item.size);
    const remoteSha = item.sha256.toLowerCase();

    let localBytes = null;
    let localStat = null;
    try {
      localStat = await fs.lstat(targetPath);
      if (localStat.isSymbolicLink() || !localStat.isFile()) continue;
      localBytes = await fs.readFile(targetPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    if (localBytes === null) {
      await writeFileAtomic(targetPath, bytes, { mode: 0o644 });
      if (typeof item.mtimeMs === 'number' && Number.isFinite(item.mtimeMs)) {
        const t = new Date(item.mtimeMs);
        await fs.utimes(targetPath, t, t).catch(() => {});
      }
      sessState[item.relPosixPath] = remoteSha;
      delete sessConflicts[item.relPosixPath];
      stateChanged = true;
      restored += 1;
      continue;
    }

    const localSha = sha256Hex(localBytes);
    if (localSha === remoteSha) {
      if (sessState[item.relPosixPath] !== remoteSha) {
        sessState[item.relPosixPath] = remoteSha;
        stateChanged = true;
      }
      if (sessConflicts[item.relPosixPath]) {
        delete sessConflicts[item.relPosixPath];
        stateChanged = true;
      }
      continue;
    }

    const lastSyncedSha = typeof sessState[item.relPosixPath] === 'string' ? sessState[item.relPosixPath] : null;
    const remoteIsNewer = typeof item.mtimeMs === 'number' && localStat && item.mtimeMs > localStat.mtimeMs + 1000;

    // Safe overwrite if local has NOT been modified since last sync (or remote is newer and no conflicting edit tracked)
    if (lastSyncedSha === localSha || (!lastSyncedSha && remoteIsNewer)) {
      await writeFileAtomic(targetPath, bytes, { mode: 0o644 });
      if (typeof item.mtimeMs === 'number' && Number.isFinite(item.mtimeMs)) {
        const t = new Date(item.mtimeMs);
        await fs.utimes(targetPath, t, t).catch(() => {});
      }
      sessState[item.relPosixPath] = remoteSha;
      delete sessConflicts[item.relPosixPath];
      stateChanged = true;
      restored += 1;
    } else {
      // Non-destructive conflict copy alongside local file (NEVER overwrite user's newer local edits)
      // Deterministic content-hash filename + persisted lastConflictRemoteSha -> 0 duplicate copies on repeated pulls!
      if (sessConflicts[item.relPosixPath] === remoteSha) {
        continue;
      }
      const conflictPath = buildOutputConflictPath(targetPath, remoteLabel, remoteSha);
      await writeFileAtomic(conflictPath, bytes, { mode: 0o644 });
      sessConflicts[item.relPosixPath] = remoteSha;
      stateChanged = true;
      conflicts.push({ path: `outputs/${item.relPosixPath}`, conflictPath, remoteSha });
      restored += 1;
    }
  }

  if (appliedSigs[sessionId] !== curSig) {
    appliedSigs[sessionId] = curSig;
    stateChanged = true;
  }

  if (stateChanged) {
    state[sessionId] = sessState;
    allConflicts[sessionId] = sessConflicts;
    state.__meta = {
      ...meta,
      conflicts: allConflicts,
      appliedOutputsSig: appliedSigs,
    };
    await saveSessionOutputsState(dshHome, state);
  }
  return { restored, conflicts };
}

function outputsSignature(packedOutputs = []) {
  if (!Array.isArray(packedOutputs) || packedOutputs.length === 0) return '';
  return packedOutputs
    .map((o) => `${o.relPosixPath}:${o.sha256}`)
    .sort()
    .join('|');
}

/**
 * Export a root session and its complete recursive subagent lineage closure
 * (including children stored under different `projectKey` directories) plus attachments
 * and lightweight unmapped `outputs/` into the encrypted VaultStore.
 */
export async function exportSessionClosure({
  dshHome,
  vault,
  sessionId,
  workspaceMappings = [],
  snapshot = null,
  deviceLabel = undefined,
  allLocalSessions = null,
  excludedSessionIds = [],
  excludeOtherSessionOutputs = false,
  originDeviceId = null,
  force = false,
}) {
  if (!vault) throw new TypeError('exportSessionClosure requires vault');
  const resolvedHome = resolveDshHome(dshHome);
  const localMap = allLocalSessions ? new Map(allLocalSessions) : await scanLocalSessions(resolvedHome);

  const rootId = sessionId || snapshot?.header?.id;
  if (typeof rootId !== 'string' || rootId.length === 0) {
    throw new TypeError('exportSessionClosure requires sessionId or snapshot.header.id');
  }

  if (snapshot && snapshot.header) {
    localMap.set(rootId, {
      sessionId: rootId,
      projKey: projectDirNameForCwd(snapshot.header.cwd),
      sessionDir: null,
      logPath: null,
      formatVersion: snapshot.header.version ?? 4,
      header: snapshot.header,
      events: Array.isArray(snapshot.events) ? snapshot.events : [],
      inheritedEventCount: snapshot.inheritedEventCount ?? extractInheritedEventCount(snapshot.header),
      recoveredTornTail: false,
    });
  }

  const rootRecord = localMap.get(rootId);
  if (!rootRecord) {
    throw new Error(`exportSessionClosure: session "${rootId}" not found in ${resolvedHome}`);
  }

  // BFS recursive closure over header.parentSession & subagent/catalog references
  const queue = [rootId];
  const visited = new Set([rootId]);
  const orderedRecords = [];

  while (queue.length > 0) {
    const curId = queue.shift();
    const cur = localMap.get(curId);
    if (!cur) continue;
    orderedRecords.push(cur);

    // 1. Children referenced by subagent/catalog events
    for (const childId of extractCatalogChildIds(cur.events)) {
      if (!visited.has(childId) && localMap.has(childId)) {
        visited.add(childId);
        queue.push(childId);
      }
    }

    // 2. Children pointing header.parentSession === curId (across ANY projectKey)
    for (const candidate of localMap.values()) {
      if (visited.has(candidate.sessionId)) continue;
      if (candidate.header?.parentSession !== curId) continue;
      if (isSplitBrainVisibleBranch(candidate.header)) continue;
      visited.add(candidate.sessionId);
      queue.push(candidate.sessionId);
    }
  }

  // Cross-device compaction lock guard: defer export if any session in the closure
  // has an unclosed `compaction/start`, preventing the remote peer from pulling a live lock (`busy`).
  const deferredCompactionSessions = orderedRecords
    .filter((rec) => hasUnclosedCompaction(rec.events))
    .map((rec) => rec.sessionId);
  if (deferredCompactionSessions.length > 0) {
    return {
      rootSessionId: rootId,
      sourceCwd: rootRecord.header?.cwd || '',
      deferred: true,
      reason: 'unclosed-compaction',
      deferredCompactionSessions,
      commit: null,
      nodeCount: 0,
      attachmentCount: 0,
      packedOutputCount: 0,
      skippedOutputs: [],
      unchanged: false,
    };
  }

  // Compute chains and pack unmapped outputs first so we can skip redundant vault commits when unchanged
  const preparedNodes = [];
  const allEvents = [];
  for (const rec of orderedRecords) {
    const normalizedHeader = toPhysicalV4HeaderLine(rec.header);
    // R7: When exporting in plaintext mode (!vault.encrypted), redact obvious API keys / private keys
    const effectiveEvents = vault.encrypted ? rec.events : redactPlaintextSecretsInValue(rec.events);
    const { headHash, chainHashes } = computeEventHashChain(
      effectiveEvents,
      workspaceMappings,
      normalizedHeader?.cwd || '',
    );
    const relChain = computeEventHashChain(
      effectiveEvents,
      [],
      normalizedHeader?.cwd || '',
    );
    allEvents.push(...effectiveEvents);
    preparedNodes.push({
      rec,
      effectiveEvents,
      normalizedHeader,
      headHash,
      chainHashes,
      sessionRelativeHeadHash: relChain.headHash,
      sessionRelativeChainHashes: relChain.chainHashes,
    });
  }

  // C13: Exclude unmapped outputs/ files attributed to excluded sessions (and other sessions on single-session push)
  const rootCwd = rootRecord.header?.cwd || '';
  const excludeOutputRelPaths = new Set();
  if (rootCwd) {
    const excludedSet = new Set(Array.isArray(excludedSessionIds) ? excludedSessionIds : []);
    const producedMap = await loadSessionProducedFiles(resolvedHome);
    const ownProduced = new Set();
    for (const rec of orderedRecords) {
      for (const rel of extractSessionProducedOutputRelPaths(rec.events, rec.header?.cwd || rootCwd)) {
        ownProduced.add(rel);
      }
      for (const rel of Array.isArray(producedMap[rec.sessionId]) ? producedMap[rec.sessionId] : []) {
        if (typeof rel === 'string' && rel) ownProduced.add(rel.toLowerCase());
      }
    }

    const rootCwdKey = normalizeWorkspaceMatchKey(rootCwd);
    for (const candidate of localMap.values()) {
      if (visited.has(candidate.sessionId)) continue;
      if (normalizeWorkspaceMatchKey(candidate.header?.cwd || '') !== rootCwdKey) continue;
      const shouldExcludeCandidate = excludedSet.has(candidate.sessionId) || excludeOtherSessionOutputs;
      if (!shouldExcludeCandidate) continue;
      for (const rel of extractSessionProducedOutputRelPaths(candidate.events, candidate.header?.cwd || rootCwd)) {
        if (!ownProduced.has(rel)) excludeOutputRelPaths.add(rel);
      }
      for (const rel of Array.isArray(producedMap[candidate.sessionId]) ? producedMap[candidate.sessionId] : []) {
        if (typeof rel === 'string' && rel && !ownProduced.has(rel.toLowerCase())) {
          excludeOutputRelPaths.add(rel.toLowerCase());
        }
      }
    }
    // Also check producedMap entries for excluded sessions that might not be in localMap
    for (const exSid of excludedSet) {
      if (visited.has(exSid)) continue;
      for (const rel of Array.isArray(producedMap[exSid]) ? producedMap[exSid] : []) {
        if (typeof rel === 'string' && rel && !ownProduced.has(rel.toLowerCase())) {
          excludeOutputRelPaths.add(rel.toLowerCase());
        }
      }
    }
  }

  const outputPack = await packUnmappedSessionOutputs({
    sessionCwd: rootCwd,
    workspaceMappings,
    vault,
    excludeRelPaths: excludeOutputRelPaths.size > 0 ? excludeOutputRelPaths : null,
  });
  const packedOutputs = outputPack.packed;
  const skippedOutputs = outputPack.skipped;

  const rootTitle = extractSessionTitle(rootRecord.events, rootId);
  const rootLastActiveAt = extractLastActiveAt(rootRecord.events, rootRecord.header);

  // Skip redundant commit publishing when this device's latest vault commit has identical closure hashes & outputs
  if (!force) {
    try {
      const selfListed = await vault.listCommits('session', { targetId: rootId, onlySelf: true });
      if (selfListed.commits.length > 0) {
        const latestSelf = selfListed.commits[selfListed.commits.length - 1];
        const prevNodes = Array.isArray(latestSelf.payload?.nodes) ? latestSelf.payload.nodes : [];
        const prevOutputsSig = outputsSignature(latestSelf.payload?.packedOutputs ?? []);
        const curOutputsSig = outputsSignature(packedOutputs);
        if (
          prevNodes.length === preparedNodes.length
          && prevOutputsSig === curOutputsSig
          && preparedNodes.every((pn, idx) =>
            prevNodes[idx]?.sessionId === pn.rec.sessionId
            && prevNodes[idx]?.headChainHash === pn.headHash
            && prevNodes[idx]?.eventCount === pn.effectiveEvents.length,
          )
        ) {
          return {
            rootSessionId: rootId,
            sourceCwd: rootCwd,
            title: rootTitle,
            lastActiveAt: rootLastActiveAt,
            deferred: false,
            unchanged: true,
            deferredCompactionSessions: [],
            commit: latestSelf,
            nodeCount: prevNodes.length,
            attachmentCount: Array.isArray(latestSelf.payload?.attachments) ? latestSelf.payload.attachments.length : 0,
            packedOutputCount: packedOutputs.length,
            skippedOutputs,
          };
        }
      }
    } catch {
      // Proceed with publish if self-commit inspection fails
    }
  }

  const nodes = [];
  for (const pn of preparedNodes) {
    const cleanBytes = await encodeV4SessionLog(pn.normalizedHeader, pn.effectiveEvents);
    const logBlob = await vault.putBlob(cleanBytes);
    nodes.push({
      sessionId: pn.rec.sessionId,
      header: pn.normalizedHeader,
      title: extractSessionTitle(pn.effectiveEvents, pn.rec.sessionId),
      lastActiveAt: extractLastActiveAt(pn.effectiveEvents, pn.normalizedHeader),
      turnCount: countUserTurns(pn.effectiveEvents),
      eventCount: pn.effectiveEvents.length,
      inheritedEventCount: pn.rec.inheritedEventCount,
      headChainHash: pn.headHash,
      chainHashes: pn.chainHashes,
      sessionRelativeHeadHash: pn.sessionRelativeHeadHash,
      sessionRelativeChainHashes: pn.sessionRelativeChainHashes,
      logBlob,
    });
  }

  const attachments = await packAttachmentsForEvents(resolvedHome, allEvents, vault);
  const modelTriple = extractModelTriple(rootRecord.events);
  const rootPlatform = vault.platform || process.platform;
  const rootTurnCount = countUserTurns(rootRecord.events);
  const sourceWorkspaceTitle = rootCwd
    ? findWorkspaceTitleForCwd(rootCwd, workspaceMappings, rootPlatform)
    : 'workspace';

  const origins = await loadSessionOrigins(resolvedHome);
  const resolvedOriginDeviceId = originDeviceId || origins[rootId] || vault.deviceId;

  const payload = {
    schemaVersion: 1,
    dshFormatVersion: rootRecord.header.version ?? 4,
    rootSessionId: rootId,
    originDeviceId: resolvedOriginDeviceId,
    deviceLabel: deviceLabel ?? vault.deviceId,
    sourceVaultDir: vault.vaultDir,
    title: rootTitle,
    lastActiveAt: rootLastActiveAt,
    turnCount: rootTurnCount,
    sourceCwd: rootCwd,
    sourceWorkspaceTitle,
    modelTriple,
    nodes,
    attachments,
    ...(packedOutputs.length > 0 ? { packedOutputs } : {}),
  };

  const commit = await vault.publishCommit('session', rootId, payload);
  return {
    rootSessionId: rootId,
    sourceCwd: rootCwd,
    title: rootTitle,
    lastActiveAt: rootLastActiveAt,
    deferred: false,
    unchanged: false,
    deferredCompactionSessions: [],
    commit,
    nodeCount: nodes.length,
    attachmentCount: attachments.length,
    packedOutputCount: packedOutputs.length,
    skippedOutputs,
  };
}

/**
 * Export top-level (non-subagent) local sessions and their lineage closures,
 * with automatic empty-shell filtering, `syncScope` ('active' | 'selected'),
 * `folderMatchMode` ('auto-mirror' | 'mapped-only'), per-workspace recency cap,
 * and explicit selective export overrides (`onlySessionIds` / `onlyWorkspacePaths`).
 */
export async function exportAllLocalSessions({
  dshHome,
  vault,
  workspaceMappings = [],
  deviceLabel = undefined,
  syncScope = 'active',
  folderMatchMode = 'auto-mirror',
  selectedWorkspaces = [],
  selectedSessionIds = [],
  excludedSessionIds = [],
  withdrawnSessions = {},
  restoredSessions = {},
  sessionTargetOverrides = {},
  workspaceTargetOverrides = {},
  maxAutoSessionsPerWorkspace = 25,
  skipEmptySessions = true,
  platform = process.platform,
  onlySessionIds = null,
  onlyWorkspacePaths = null,
  force = false,
  allLocalSessions = null,
}) {
  const resolvedHome = resolveDshHome(dshHome);
  const localMap = allLocalSessions ? new Map(allLocalSessions) : await scanLocalSessions(resolvedHome);

  // Identify subagent children so they are exported within their parent's closure, not as standalone roots
  const catalogChildIds = new Set();
  for (const rec of localMap.values()) {
    for (const cid of extractCatalogChildIds(rec.events)) {
      catalogChildIds.add(cid);
    }
  }

  const allRoots = [];
  for (const rec of localMap.values()) {
    if (rec.header?.origin === 'subagent') continue;
    if (catalogChildIds.has(rec.sessionId)) continue;
    if (
      rec.header?.parentSession
      && localMap.has(rec.header.parentSession)
      && !isSplitBrainVisibleBranch(rec.header)
    ) {
      continue;
    }
    allRoots.push(rec);
  }

  const explicitSessionSet = Array.isArray(onlySessionIds) ? new Set(onlySessionIds) : null;
  const explicitWorkspaceList = Array.isArray(onlyWorkspacePaths) ? onlyWorkspacePaths : null;
  const isExplicitSelection = Boolean(
    (explicitSessionSet && explicitSessionSet.size > 0)
    || (explicitWorkspaceList && explicitWorkspaceList.length > 0),
  );

  const selectedSessionSet = new Set(Array.isArray(selectedSessionIds) ? selectedSessionIds : []);
  const excludedSessionSet = new Set(Array.isArray(excludedSessionIds) ? excludedSessionIds : []);

  let skippedEmptyCount = 0;
  let skippedUnselectedCount = 0;
  const filteredRoots = [];

  if (isExplicitSelection) {
    const withdrawnMap = withdrawnSessions && typeof withdrawnSessions === 'object' ? withdrawnSessions : {};
    const restoredMap = restoredSessions && typeof restoredSessions === 'object' ? restoredSessions : {};
    for (const rec of allRoots) {
      const hitSession = explicitSessionSet ? explicitSessionSet.has(rec.sessionId) : false;
      const hitWorkspace = explicitWorkspaceList
        ? matchesWorkspaceSelector(rec.header?.cwd || '', explicitWorkspaceList, workspaceMappings, platform)
        : false;
      if (!hitSession && !hitWorkspace) {
        skippedUnselectedCount += 1;
        continue;
      }
      // C10: Whole-workspace push (`onlyWorkspacePaths`) MUST always skip excluded sessions (and active withdrawals)!
      if (!hitSession && excludedSessionSet.has(rec.sessionId)) {
        skippedUnselectedCount += 1;
        continue;
      }
      if (!hitSession) {
        const wTs = Number(withdrawnMap[rec.sessionId] ?? 0);
        const rTs = Number(restoredMap[rec.sessionId] ?? 0);
        if (wTs > rTs && extractLastActiveAt(rec.events, rec.header) <= wTs) {
          skippedUnselectedCount += 1;
          continue;
        }
      }
      if (!hitSession && skipEmptySessions && !isSubstantiveSession(rec.events, rec.header)) {
        skippedEmptyCount += 1;
        continue;
      }
      filteredRoots.push(rec);
    }
  } else {
    const configView = {
      workspaceMappings,
      folderMatchMode,
      syncScope,
      selectedWorkspaces,
      selectedSessionIds,
      excludedSessionIds,
      withdrawnSessions,
      restoredSessions,
      sessionTargetOverrides,
      workspaceTargetOverrides,
    };

    const candidates = [];
    for (const rec of allRoots) {
      if (excludedSessionSet.has(rec.sessionId)) {
        skippedUnselectedCount += 1;
        continue;
      }
      const isSelectedDirect = selectedSessionSet.has(rec.sessionId);
      if (skipEmptySessions && !isSelectedDirect && !isSubstantiveSession(rec.events, rec.header)) {
        skippedEmptyCount += 1;
        continue;
      }
      const decision = shouldAutoSyncSession(
        { sessionId: rec.sessionId, header: rec.header, events: rec.events },
        configView,
        platform,
      );
      if (!decision.allowed) {
        if (decision.reason === 'empty-shell') {
          if (skipEmptySessions) {
            skippedEmptyCount += 1;
            continue;
          }
        } else {
          skippedUnselectedCount += 1;
          continue;
        }
      }
      candidates.push(rec);
    }

    const cap = typeof maxAutoSessionsPerWorkspace === 'number' && maxAutoSessionsPerWorkspace > 0
      ? maxAutoSessionsPerWorkspace
      : Infinity;

    if (syncScope === 'active' && Number.isFinite(cap)) {
      const byWs = new Map();
      for (const rec of candidates) {
        const wsKey = normalizeWorkspaceMatchKey(rec.header?.cwd || '') || '_no-cwd';
        if (!byWs.has(wsKey)) byWs.set(wsKey, []);
        byWs.get(wsKey).push(rec);
      }
      for (const group of byWs.values()) {
        group.sort((a, b) => extractLastActiveAt(b.events, b.header) - extractLastActiveAt(a.events, a.header));
        let autoCount = 0;
        for (const rec of group) {
          if (selectedSessionSet.has(rec.sessionId)) {
            filteredRoots.push(rec);
          } else if (autoCount < cap) {
            filteredRoots.push(rec);
            autoCount += 1;
          } else {
            skippedUnselectedCount += 1;
          }
        }
      }
    } else {
      filteredRoots.push(...candidates);
    }
  }

  // Sort oldest -> newest by lastActiveAt for deterministic commit ordering
  filteredRoots.sort((a, b) => extractLastActiveAt(a.events, a.header) - extractLastActiveAt(b.events, b.header));

  const exported = [];
  const unchangedSessions = [];
  const deferredCompactionSessions = [];
  const skippedOutputs = [];
  const excludeOtherSessionOutputs = Boolean(
    explicitSessionSet && explicitSessionSet.size > 0 && !(explicitWorkspaceList && explicitWorkspaceList.length > 0),
  );
  for (const root of filteredRoots) {
    const res = await exportSessionClosure({
      dshHome: resolvedHome,
      vault,
      sessionId: root.sessionId,
      workspaceMappings,
      deviceLabel,
      allLocalSessions: localMap,
      excludedSessionIds,
      excludeOtherSessionOutputs,
      force,
    });
    if (res.deferred && res.reason === 'unclosed-compaction') {
      deferredCompactionSessions.push(...(res.deferredCompactionSessions ?? [root.sessionId]));
      continue;
    }
    if (Array.isArray(res.skippedOutputs) && res.skippedOutputs.length > 0) {
      for (const item of res.skippedOutputs) {
        skippedOutputs.push({ sessionId: root.sessionId, ...item });
      }
    }
    if (res.unchanged) {
      unchangedSessions.push(res);
    } else {
      exported.push(res);
    }
  }

  return {
    exported,
    unchangedSessions,
    skippedUnchangedCount: unchangedSessions.length,
    deferredCompactionSessions,
    skippedOutputs,
    skippedEmptyCount,
    skippedUnselectedCount,
    totalLocalSessions: localMap.size,
  };
}

async function resolveMappedPathForTargetOs(
  rawPath,
  { workspaceMappings = [], targetPlatform = process.platform, fallbackRoot, dshHome, ensureDir = false },
) {
  const nfcRaw = String(rawPath).normalize('NFC');
  const mapped = mapPathAcrossOs(nfcRaw, workspaceMappings, targetPlatform);
  let targetPath = mapped.matched ? mapped.mappedPath : nfcRaw;
  let usedFallback = false;

  if (!mapped.matched && !isAbsoluteForPlatform(targetPath, targetPlatform)) {
    usedFallback = true;
    const baseFallback = fallbackRoot
      ? formatPathForPlatform(fallbackRoot, targetPlatform)
      : targetPlatform === process.platform
        ? path.join(soulSyncDir(dshHome), 'fallback-workspaces')
        : targetPlatform === 'win32'
          ? 'C:\\dsh-soul-sync-fallback'
          : '/tmp/dsh-soul-sync-fallback';

    const segments = sanitizeSourcePathSegments(nfcRaw);
    if (targetPlatform === 'win32') {
      targetPath = path.win32.join(baseFallback, ...segments).normalize('NFC');
    } else {
      targetPath = path.posix.join(baseFallback, ...segments).normalize('NFC');
    }
  } else {
    targetPath = formatPathForPlatform(targetPath, targetPlatform);
  }

  // Only invoke host filesystem mkdir / realpath when targetPlatform matches the running OS
  if (targetPlatform === process.platform) {
    if (usedFallback && ensureDir) {
      await fs.mkdir(targetPath, { recursive: true });
    }
    if (ensureDir || mapped.matched || usedFallback) {
      targetPath = await canonicalizeLocalPath(targetPath);
    }
  }

  return {
    path: targetPath,
    workspaceId: mapped.workspaceId,
    matched: mapped.matched,
    usedFallback,
  };
}

/**
 * Resolve the target local workspace `cwd` for an incoming session with dual folder-matching modes:
 *  - Explicit overrides (`sessionTargetOverrides` / `workspaceTargetOverrides`) always win (even in `mapped-only`).
 *  - Vault self-rescue guard: NEVER map a session into `vaultDir` (rescues into `default-workspace` in `auto-mirror`).
 *  - Priority A: Keep an existing healthy local session's `cwd` unchanged (preserves Win -> Mac -> Win roundtrip),
 *    while flagging any existing local copy stranded in `unmapped-workspaces` / `fallback-workspaces` / `vaultDir`
 *    for automatic orphan migration.
 *  - Priority B: Explicit `workspaceMappings` match.
 *  - `mapped-only` gate: If `folderMatchMode === 'mapped-only'` and unmatched, return `{ skipped: true, reason: 'unmapped-skipped' }`.
 *  - Priority C (`auto-mirror`): Same-basename match among registered workspaces in `cordisCtx.workspaceRegistry`.
 *  - Priority D (`auto-mirror`): Auto-create an independent named workspace directory
 *    `<autoMirrorRoot>/<sourceWorkspaceName>` so multiple unmapped remote workspaces NEVER collide
 *    in a single `default-workspace` (only `vaultDir` oops-sessions or remote `default-workspace` sessions
 *    fall into local `default-workspace`).
 */
export const AUTO_MIRROR_SENTINEL = '__AUTO_MIRROR__';

function isPathInsideAutoMirrorBase(rawPath, mirrorBase) {
  if (!rawPath || !mirrorBase) return false;
  const rel = extractRelativeUnderRoot(rawPath, mirrorBase);
  return rel !== null && rel.length > 0;
}

function allocateDisambiguatedMirrorPath({
  sourceCwd,
  srcBaseRaw,
  mirrorBase,
  targetPlatform,
  autoMirrorAssignments = {},
  mirrorSlotMap = null,
}) {
  // 1. Reuse persisted assignment for this exact sourceCwd if present
  const persisted = lookupPathOverride(autoMirrorAssignments, sourceCwd);
  if (persisted) {
    return { path: formatPathForPlatform(persisted, targetPlatform), newlyAllocated: false };
  }

  const normSrcKey = normalizeWorkspaceMatchKey(sourceCwd);
  const baseFolder = sanitizeMirrorFolderName(srcBaseRaw || 'workspace');
  const defaultCandidate = joinFormattedPath(mirrorBase, baseFolder, targetPlatform);
  const defaultCandKey = normalizeWorkspaceMatchKey(defaultCandidate);

  // Check whether defaultCandidate is already claimed by a DIFFERENT sourceCwd
  let claimedByOther = false;
  for (const [assignedSrc, assignedTarget] of Object.entries(autoMirrorAssignments ?? {})) {
    if (normalizeWorkspaceMatchKey(assignedTarget) === defaultCandKey && normalizeWorkspaceMatchKey(assignedSrc) !== normSrcKey) {
      claimedByOther = true;
      break;
    }
  }
  if (!claimedByOther && mirrorSlotMap) {
    const existingOwner = mirrorSlotMap.get(defaultCandKey);
    if (existingOwner && existingOwner !== normSrcKey) {
      claimedByOther = true;
    }
  }

  if (!claimedByOther) {
    if (mirrorSlotMap && normSrcKey) {
      mirrorSlotMap.set(defaultCandKey, normSrcKey);
    }
    return { path: defaultCandidate, newlyAllocated: Boolean(normSrcKey) };
  }

  const hash4 = sha256Hex(normSrcKey || srcBaseRaw || 'workspace').slice(0, 4);
  const disambiguated = joinFormattedPath(mirrorBase, `${baseFolder}-${hash4}`, targetPlatform);
  const disKey = normalizeWorkspaceMatchKey(disambiguated);
  if (mirrorSlotMap && normSrcKey) {
    mirrorSlotMap.set(disKey, normSrcKey);
  }
  return { path: disambiguated, newlyAllocated: Boolean(normSrcKey) };
}

export async function resolveTargetSessionCwd({
  sessionId = '',
  sourceCwd = '',
  sourcePlatform = null,
  localRoot = null,
  workspaceMappings = [],
  targetPlatform = process.platform,
  fallbackRoot = undefined,
  dshHome = undefined,
  cordisCtx = null,
  vaultDir = undefined,
  remoteVaultDir = undefined,
  defaultWorkspaceDir = undefined,
  folderMatchMode = 'auto-mirror',
  autoMirrorRoot = undefined,
  autoMirrorAssignments = {},
  mirrorSlotMap = null,
  sessionTargetOverrides = {},
  workspaceTargetOverrides = {},
  dryRun = false,
}) {
  const vaultDirs = [vaultDir, remoteVaultDir].filter((v) => typeof v === 'string' && v.trim().length > 0);
  const explicitFallbackRoot = typeof fallbackRoot === 'string' && fallbackRoot.trim().length > 0;
  const sourceWasVault = Boolean(sourceCwd && isVaultPath(sourceCwd, vaultDirs));

  // Priority 0-prep: detect explicit override (including __AUTO_MIRROR__ sentinel)
  const rawOverride =
    (sessionId && typeof sessionTargetOverrides?.[sessionId] === 'string' && sessionTargetOverrides[sessionId].trim()
      ? sessionTargetOverrides[sessionId].trim().normalize('NFC')
      : null)
    ?? lookupPathOverride(workspaceTargetOverrides, sourceCwd);

  const forceAutoMirror = rawOverride === AUTO_MIRROR_SENTINEL;
  const explicitOverride = forceAutoMirror ? null : rawOverride;
  const mode = !forceAutoMirror && folderMatchMode === 'mapped-only' ? 'mapped-only' : 'auto-mirror';

  const canonicalizeIfLocal = async (p, ensureDir = false) => {
    const expanded = targetPlatform !== 'win32' ? expandPosixHome(String(p ?? ''), targetPlatform) : String(p ?? '');
    let formatted = formatPathForPlatform(expanded, targetPlatform);
    if (targetPlatform === process.platform) {
      if (ensureDir && !dryRun) {
        await fs.mkdir(formatted, { recursive: true });
      }
      formatted = await canonicalizeLocalPath(formatted);
    }
    return formatted;
  };

  const dirExistsIfLocal = async (p) => {
    if (!p || typeof p !== 'string') return false;
    if (targetPlatform !== process.platform) return true;
    return isExistingLocalDir(p);
  };

  const mirrorBase = resolveAutoMirrorBaseDir({
    autoMirrorRoot,
    targetPlatform,
    cordisCtx,
    defaultWorkspaceDir,
    vaultDirs,
    dshHome,
  });

  const resolveDefaultWorkspacePath = async () => {
    const wsReg = cordisCtx?.workspaceRegistry;
    if (wsReg) {
      const defId = wsReg.state?.defaultWorkspaceId;
      const candidates = [];
      if (defId && typeof wsReg.get === 'function') {
        const defWs = wsReg.get(defId);
        if (defWs) candidates.push(defWs);
      }
      if (typeof wsReg.list === 'function') {
        for (const ws of wsReg.list() ?? []) {
          if (ws && !candidates.includes(ws)) candidates.push(ws);
        }
      }
      for (const ws of candidates) {
        if (!ws?.path || typeof ws.path !== 'string') continue;
        if (isVaultPath(ws.path, vaultDirs) || isUnmappedWorkspacePath(ws.path, dshHome)) continue;
        if (dryRun || (await dirExistsIfLocal(ws.path))) {
          return { path: await canonicalizeIfLocal(ws.path, false), matchedBy: 'default-workspace-online' };
        }
      }
    } else {
      const offlineCandidates = [];
      if (typeof defaultWorkspaceDir === 'string' && defaultWorkspaceDir.trim().length > 0) {
        offlineCandidates.push({ dir: defaultWorkspaceDir, requireExistOnDisk: !dryRun && targetPlatform === process.platform });
      } else if (targetPlatform === process.platform) {
        offlineCandidates.push({
          dir: path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace'),
          requireExistOnDisk: !dryRun,
        });
      }
      for (const cand of offlineCandidates) {
        if (isVaultPath(cand.dir, vaultDirs) || isUnmappedWorkspacePath(cand.dir, dshHome)) continue;
        const ok = cand.requireExistOnDisk ? await isExistingLocalDir(cand.dir) : true;
        if (ok) {
          return { path: await canonicalizeIfLocal(cand.dir, false), matchedBy: 'default-workspace-offline' };
        }
      }
    }
    return null;
  };

  // Priority A-prep: detect existing local cwd & orphan status
  const localCwd = typeof localRoot?.header?.cwd === 'string' ? localRoot.header.cwd : '';
  const localIsOrphan = Boolean(
    localCwd && (isUnmappedWorkspacePath(localCwd, dshHome) || isVaultPath(localCwd, vaultDirs)),
  );
  const localInAutoMirror = Boolean(localCwd && isPathInsideAutoMirrorBase(localCwd, mirrorBase));
  const localHasEvents = Array.isArray(localRoot?.events) && localRoot.events.length > 0;

  // Priority 0: Explicit per-session or per-workspace target directory override (always honored, even in mapped-only)
  if (explicitOverride && !isVaultPath(explicitOverride, vaultDirs)) {
    const mappedOvr = mapPathAcrossOs(explicitOverride, workspaceMappings, targetPlatform);
    const resolvedOvr = await canonicalizeIfLocal(explicitOverride, true);
    const relocatedFromAutoMirror = localInAutoMirror && !sameWorkspacePath(localCwd, resolvedOvr, targetPlatform);
    return {
      path: resolvedOvr,
      workspaceId: mappedOvr.workspaceId,
      matchedBy: 'override',
      migratedFromUnmapped: localIsOrphan || relocatedFromAutoMirror,
      oldUnmappedCwd: (localIsOrphan || relocatedFromAutoMirror) ? localCwd : null,
      usedFallback: false,
      skipped: false,
    };
  }

  // Check if an explicit workspaceMappings entry now binds sourceCwd to a different directory than autoMirrorRoot
  let explicitMappingHit = null;
  if (!sourceWasVault && sourceCwd) {
    const mapped = mapPathAcrossOs(sourceCwd, workspaceMappings, targetPlatform);
    if (mapped.matched && !isVaultPath(mapped.mappedPath, vaultDirs)) {
      explicitMappingHit = mapped;
    }
  }

  // Priority A: Preserve healthy existing local cwd; detect stranded unmapped/vault orphan
  // OR re-home when user bound or updated an explicit cross-OS `workspaceMappings` entry to a new target directory!
  const isCrossOsRemoteSource = Boolean(
    sourcePlatform
    && sourcePlatform !== targetPlatform,
  );
  const shouldRehomeToExplicitMapping = Boolean(
    explicitMappingHit
    && (localInAutoMirror || (Boolean(localCwd) && isCrossOsRemoteSource))
    && !sameWorkspacePath(localCwd, explicitMappingHit.mappedPath, targetPlatform),
  );
  if (localCwd && !localIsOrphan && !shouldRehomeToExplicitMapping && isAbsoluteForPlatform(localCwd, targetPlatform)) {
    if (!(explicitFallbackRoot && !localHasEvents)) {
      const mappedLocal = mapPathAcrossOs(localCwd, workspaceMappings, targetPlatform);
      return {
        path: await canonicalizeIfLocal(localCwd, false),
        workspaceId: mappedLocal.workspaceId,
        matchedBy: 'local-existing',
        migratedFromUnmapped: false,
        oldUnmappedCwd: null,
        usedFallback: false,
        skipped: false,
      };
    }
  }

  // Priority B: Explicit workspaceMappings match (never landing in vaultDir)
  if (explicitMappingHit) {
    return {
      path: await canonicalizeIfLocal(explicitMappingHit.mappedPath, !dryRun),
      workspaceId: explicitMappingHit.workspaceId,
      matchedBy: 'mapping',
      migratedFromUnmapped: localIsOrphan || shouldRehomeToExplicitMapping,
      oldUnmappedCwd: (localIsOrphan || shouldRehomeToExplicitMapping) ? localCwd : null,
      usedFallback: false,
      skipped: false,
    };
  }

  // Strict mapped-only mode: skip any remote session without explicit mapping or target override!
  if (mode === 'mapped-only') {
    return {
      path: null,
      workspaceId: null,
      matchedBy: 'unmapped-skipped',
      migratedFromUnmapped: false,
      oldUnmappedCwd: null,
      usedFallback: false,
      skipped: true,
      reason: 'unmapped-skipped',
    };
  }

  // Vault self-rescue (auto-mirror): rescue vault-dir sessions ONLY into default-workspace (or vault-fallback)
  if (sourceWasVault) {
    if (!explicitFallbackRoot) {
      const defHit = await resolveDefaultWorkspacePath();
      if (defHit) {
        return {
          path: defHit.path,
          workspaceId: null,
          matchedBy: defHit.matchedBy,
          migratedFromUnmapped: localIsOrphan,
          oldUnmappedCwd: localIsOrphan ? localCwd : null,
          usedFallback: false,
          skipped: false,
        };
      }
    }
    const baseFallback = explicitFallbackRoot
      ? formatPathForPlatform(fallbackRoot, targetPlatform)
      : targetPlatform === process.platform
        ? path.join(soulSyncDir(dshHome), 'unmapped-workspaces')
        : targetPlatform === 'win32'
          ? 'C:\\dsh-soul-sync-unmapped'
          : '/tmp/dsh-soul-sync-unmapped';
    const leaf = sanitizeAttachmentLeafName(sessionId || 'vault-rescued');
    const rescued = targetPlatform === 'win32'
      ? path.win32.join(baseFallback, 'vault-rescued', leaf).normalize('NFC')
      : path.posix.join(baseFallback, 'vault-rescued', leaf).normalize('NFC');
    return {
      path: await canonicalizeIfLocal(rescued, true),
      workspaceId: null,
      matchedBy: 'vault-fallback',
      migratedFromUnmapped: false,
      oldUnmappedCwd: null,
      usedFallback: true,
      skipped: false,
    };
  }

  // Priority C: Zero-config same-basename workspace match in live workspaceRegistry
  // C8: First check persisted autoMirrorAssignments for this exact sourceCwd so separate pull batches
  // ALWAYS land in the same directory and NEVER merge two distinct same-basename sources!
  const srcPlat = sourcePlatform || (isWin32Absolute(sourceCwd) ? 'win32' : 'darwin');
  const srcBaseRaw = sourceCwd ? basenameForPlatform(sourceCwd, srcPlat).normalize('NFC') : '';
  const srcBaseLower = srcBaseRaw.toLowerCase();
  const normSrcKey = normalizeWorkspaceMatchKey(sourceCwd);

  if (!explicitFallbackRoot && sourceCwd) {
    const persistedTarget = lookupPathOverride(autoMirrorAssignments, sourceCwd);
    if (persistedTarget && !isVaultPath(persistedTarget, vaultDirs) && !isUnmappedWorkspacePath(persistedTarget, dshHome)) {
      const finalPersisted = await canonicalizeIfLocal(persistedTarget, true);
      if (mirrorSlotMap && normSrcKey) {
        mirrorSlotMap.set(normalizeWorkspaceMatchKey(finalPersisted), normSrcKey);
      }
      return {
        path: finalPersisted,
        workspaceId: null,
        matchedBy: isPathInsideAutoMirrorBase(finalPersisted, mirrorBase) ? 'auto-mirror' : 'basename',
        migratedFromUnmapped: localIsOrphan,
        oldUnmappedCwd: localIsOrphan ? localCwd : null,
        usedFallback: false,
        skipped: false,
      };
    }
  }

  if (
    !explicitFallbackRoot
    && sourceCwd
    && typeof cordisCtx?.workspaceRegistry?.list === 'function'
  ) {
    const registered = cordisCtx.workspaceRegistry.list() ?? [];
    for (const ws of registered) {
      if (!ws?.path || typeof ws.path !== 'string') continue;
      if (isVaultPath(ws.path, vaultDirs) || isUnmappedWorkspacePath(ws.path, dshHome)) continue;
      if (isPathInsideAutoMirrorBase(ws.path, mirrorBase)) continue;
      const wsBase = basenameForPlatform(ws.path, targetPlatform).normalize('NFC').toLowerCase();
      if (wsBase === srcBaseLower && (dryRun || (await dirExistsIfLocal(ws.path)))) {
        const wsKey = normalizeWorkspaceMatchKey(ws.path);
        let claimedByOther = false;
        for (const [assignedSrc, assignedTarget] of Object.entries(autoMirrorAssignments ?? {})) {
          if (normalizeWorkspaceMatchKey(assignedTarget) === wsKey && normalizeWorkspaceMatchKey(assignedSrc) !== normSrcKey) {
            claimedByOther = true;
            break;
          }
        }
        if (claimedByOther) continue;
        const existingOwner = mirrorSlotMap?.get(wsKey);
        if (existingOwner && existingOwner !== normSrcKey) continue;
        const resolvedWsPath = await canonicalizeIfLocal(ws.path, false);
        if (mirrorSlotMap && normSrcKey) {
          mirrorSlotMap.set(wsKey, normSrcKey);
          mirrorSlotMap.set(normalizeWorkspaceMatchKey(resolvedWsPath), normSrcKey);
        }
        return {
          path: resolvedWsPath,
          workspaceId: null,
          matchedBy: 'basename',
          migratedFromUnmapped: localIsOrphan,
          oldUnmappedCwd: localIsOrphan ? localCwd : null,
          usedFallback: false,
          skipped: false,
          allocatedMirrorAssignment: normSrcKey
            ? { sourceCwd: sourceCwd.normalize('NFC'), targetPath: resolvedWsPath }
            : null,
        };
      }
    }
  }

  // Priority D: Auto-mirror into independent named workspace <autoMirrorRoot>/<sourceWorkspaceName>
  // (with deterministic <name>-<hash4> disambiguation when two distinct source paths share the same basename)
  if (!explicitFallbackRoot) {
    if (!srcBaseRaw || srcBaseLower === 'default-workspace') {
      const defHit = await resolveDefaultWorkspacePath();
      if (defHit) {
        return {
          path: defHit.path,
          workspaceId: null,
          matchedBy: defHit.matchedBy,
          migratedFromUnmapped: localIsOrphan,
          oldUnmappedCwd: localIsOrphan ? localCwd : null,
          usedFallback: false,
          skipped: false,
        };
      }
    }

    const allocated = allocateDisambiguatedMirrorPath({
      sourceCwd,
      srcBaseRaw,
      mirrorBase,
      targetPlatform,
      autoMirrorAssignments,
      mirrorSlotMap,
    });
    if (!isVaultPath(allocated.path, vaultDirs)) {
      const finalMirrorPath = await canonicalizeIfLocal(allocated.path, true);
      return {
        path: finalMirrorPath,
        workspaceId: null,
        matchedBy: 'auto-mirror',
        migratedFromUnmapped: localIsOrphan,
        oldUnmappedCwd: localIsOrphan ? localCwd : null,
        usedFallback: false,
        skipped: false,
        allocatedMirrorAssignment: allocated.newlyAllocated && sourceCwd
          ? { sourceCwd: sourceCwd.normalize('NFC'), targetPath: finalMirrorPath }
          : null,
      };
    }
  }

  // Explicit fallbackRoot path (used by legacy fallbackRoot tests or fallbackDir)
  const fb = await resolveMappedPathForTargetOs(sourceCwd, {
    workspaceMappings,
    targetPlatform,
    fallbackRoot,
    dshHome,
    ensureDir: !dryRun,
  });
  return {
    path: fb.path,
    workspaceId: fb.workspaceId,
    matchedBy: fb.usedFallback ? 'fallback' : 'same-os',
    migratedFromUnmapped: false,
    oldUnmappedCwd: null,
    usedFallback: fb.usedFallback,
    skipped: false,
  };
}

/**
 * Minimal exact OS path rewrite for a session.
 * ONLY rewrites:
 *  1. `header.cwd`
 *  2. `event.data.cwd` when `event.type === 'working-directory/change'`
 *  3. `event.data.files[].path` when `event.type === 'deliverables/presented'` and path is absolute
 * Every other event (`user/message`, `assistant/message` w/ reasoning & signatures, `tool/call`,
 * `tool/result`, etc.) is preserved byte-for-byte untouched.
 */
export async function rewriteSessionForTargetOs({
  header,
  events = [],
  workspaceMappings = [],
  targetPlatform = process.platform,
  fallbackRoot = undefined,
  dshHome = undefined,
  overrideTargetCwd = undefined,
}) {
  const newHeader = { ...header };
  const sourceRootCwd = typeof header?.cwd === 'string' ? header.cwd : '';
  let headerWorkspaceId = null;

  if (typeof overrideTargetCwd === 'string' && overrideTargetCwd.length > 0) {
    newHeader.cwd = overrideTargetCwd;
    headerWorkspaceId = mapPathAcrossOs(overrideTargetCwd, workspaceMappings, targetPlatform).workspaceId;
  } else if (sourceRootCwd.length > 0) {
    const res = await resolveMappedPathForTargetOs(sourceRootCwd, {
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      dshHome,
      ensureDir: true,
    });
    newHeader.cwd = res.path;
    headerWorkspaceId = res.workspaceId;
  }

  const rewritePathRelativeToSessionRoot = async (rawPath, ensureDir) => {
    const mapped = mapPathAcrossOs(rawPath, workspaceMappings, targetPlatform);
    const relUnderSourceRoot = sourceRootCwd ? extractRelativeUnderRoot(rawPath, sourceRootCwd) : null;
    // When `overrideTargetCwd` explicitly relocates the session root (`newHeader.cwd`), any path inside
    // `sourceRootCwd` must stay relative to `newHeader.cwd` (including re-homing into a child or parent directory!)
    // unless `mapped` hit a MORE specific nested sub-mapping strictly deeper than `sourceRootCwd`.
    const preferSessionRootRel = Boolean(
      overrideTargetCwd
      && newHeader.cwd
      && relUnderSourceRoot !== null
      && (
        !mapped.matched
        || (mapped.relativePosixPath !== null && mapped.relativePosixPath.length >= relUnderSourceRoot.length)
      ),
    );
    if (mapped.matched && !preferSessionRootRel) {
      let targetPath = formatPathForPlatform(mapped.mappedPath, targetPlatform);
      if (targetPlatform === process.platform) {
        targetPath = await canonicalizeLocalPath(targetPath);
      }
      return targetPath;
    }
    if (sourceRootCwd && newHeader.cwd && relUnderSourceRoot !== null) {
      const rel = relUnderSourceRoot;
      if (rel !== null) {
        let targetPath = joinFormattedPath(newHeader.cwd, rel, targetPlatform);
        if (targetPlatform === process.platform) {
          if (ensureDir && (await isExistingLocalDir(newHeader.cwd))) {
            await fs.mkdir(targetPath, { recursive: true }).catch(() => {});
          }
          targetPath = await canonicalizeLocalPath(targetPath);
        }
        return targetPath;
      }
    }
    const res = await resolveMappedPathForTargetOs(rawPath, {
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      dshHome,
      ensureDir,
    });
    return res.path;
  };

  const newEvents = [];
  for (const ev of events) {
    if (ev?.type === 'working-directory/change' && typeof ev.data?.cwd === 'string') {
      const nextCwd = await rewritePathRelativeToSessionRoot(ev.data.cwd, true);
      newEvents.push({
        ...ev,
        data: {
          ...ev.data,
          cwd: nextCwd,
        },
      });
      continue;
    }

    if (ev?.type === 'deliverables/presented' && Array.isArray(ev.data?.files)) {
      const rewrittenFiles = [];
      for (const fileItem of ev.data.files) {
        if (fileItem && typeof fileItem === 'object' && typeof fileItem.path === 'string' && isAnyAbsolutePath(fileItem.path)) {
          const nextFilePath = await rewritePathRelativeToSessionRoot(fileItem.path, false);
          rewrittenFiles.push({
            ...fileItem,
            path: nextFilePath,
          });
        } else {
          rewrittenFiles.push(fileItem);
        }
      }
      newEvents.push({
        ...ev,
        data: {
          ...ev.data,
          files: rewrittenFiles,
        },
      });
      continue;
    }

    // Strict zero-modification pass-through for all other events
    newEvents.push(ev);
  }

  return {
    header: newHeader,
    events: newEvents,
    workspaceId: headerWorkspaceId,
  };
}

/**
 * Anti-duplicate directory guard: remove any sibling `<dshHome>/sessions/<otherProjKey>/<encodedId>`
 * before writing `<newProjKey>/<encodedId>` so a sessionId can NEVER exist in two projectKey dirs,
 * and prune the now-empty old `projectKey` directory if nothing else lives in it.
 */
async function ensureUniqueSessionDirectory(dshHome, sessionId, newProjKey) {
  const sessionsRoot = path.join(resolveDshHome(dshHome), 'sessions');
  const encodedId = encodeSegment(sessionId);

  let projEntries;
  try {
    projEntries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }

  for (const proj of projEntries) {
    if (!proj.isDirectory()) continue;
    if (proj.name === newProjKey) continue;
    const oldProjDir = path.join(sessionsRoot, proj.name);
    const oldDir = path.join(oldProjDir, encodedId);
    try {
      const st = await fs.stat(oldDir);
      if (st.isDirectory()) {
        await fs.rm(oldDir, { recursive: true, force: true });
        // Clean up empty stale projectKey directory (e.g. old unmapped-workspaces orphan dir)
        const remaining = await fs.readdir(oldProjDir).catch(() => ['keep']);
        if (remaining.length === 0) {
          await fs.rmdir(oldProjDir).catch(() => {});
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
}

/**
 * Normalize an in-memory or imported V4 header object into DSH's exact physical `HeaderLine` schema
 * (`HEADER_REQUIRED_KEYS` + `HEADER_OPTIONAL_KEYS`), ensuring `JsonlSessionPersistence.isHeaderLine`
 * always accepts the log on every platform.
 */
export function toPhysicalV4HeaderLine(header) {
  if (!header || typeof header !== 'object') return header;
  const version = typeof header.version === 'number' && header.version >= 1 ? header.version : 4;
  if (version !== 4) return header;
  const createdAt = typeof header.createdAt === 'number' && Number.isSafeInteger(header.createdAt) && header.createdAt >= 0
    ? header.createdAt
    : Date.now();
  const delegationDepth = typeof header.delegationDepth === 'number' && Number.isSafeInteger(header.delegationDepth) && header.delegationDepth >= 0
    ? header.delegationDepth
    : 0;
  return {
    type: 'session',
    version: 4,
    id: String(header.id),
    createdAt,
    ...(typeof header.cwd === 'string' && header.cwd.length > 0 ? { cwd: header.cwd } : {}),
    ...(typeof header.parentSession === 'string' && header.parentSession.length > 0 ? { parentSession: header.parentSession } : {}),
    isSeeded: Boolean(header.isSeeded),
    ...(header.origin === 'subagent' ? { origin: 'subagent' } : {}),
    delegationDepth,
    ...(typeof header.agentPreset === 'string' && header.agentPreset.length > 0 ? { agentPreset: header.agentPreset } : {}),
  };
}

async function writeSessionLogToDisk(dshHome, header, events) {
  const normalizedHeader = toPhysicalV4HeaderLine(header);
  const projKey = projectDirNameForCwd(normalizedHeader.cwd);
  await ensureUniqueSessionDirectory(dshHome, normalizedHeader.id, projKey);

  const version = typeof normalizedHeader.version === 'number' && normalizedHeader.version >= 1 ? normalizedHeader.version : 4;
  const sessDir = path.join(resolveDshHome(dshHome), 'sessions', projKey, encodeSegment(normalizedHeader.id));
  const logPath = path.join(sessDir, `session.v${version}.jsonl.zstd`);
  const bytes = await encodeV4SessionLog(normalizedHeader, events);
  await writeFileAtomic(logPath, bytes, { mode: 0o600 });
  clearLocalSessionScanCache(logPath);
  return { projKey, sessDir, logPath };
}

function pendingMigrationsPath(dshHome) {
  return path.join(soulSyncDir(dshHome), 'pending-migrations.json');
}

export async function readPendingMigrations(dshHome) {
  const filePath = pendingMigrationsPath(dshHome);
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
}

async function recordPendingMigration(dshHome, sessionId, info) {
  const current = await readPendingMigrations(dshHome);
  current[sessionId] = info;
  await writeFileAtomic(pendingMigrationsPath(dshHome), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Read and atomically consume a pending cross-OS migration notice for `sessionId`
 * (called by the host plugin on `agent/pre-step`).
 */
export async function consumePendingMigration(dshHome, sessionId) {
  const current = await readPendingMigrations(dshHome);
  if (!Object.hasOwn(current, sessionId)) return null;
  const entry = current[sessionId];
  delete current[sessionId];
  await writeFileAtomic(pendingMigrationsPath(dshHome), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  return entry;
}

/**
 * Restore a previously consumed migration entry if the initial turn failed/aborted BEFORE
 * the injected context notice was durably appended to `session`, without overwriting any newer migration.
 */
export async function restorePendingMigration(dshHome, sessionId, info) {
  if (!sessionId || !info || typeof info !== 'object') return false;
  const current = await readPendingMigrations(dshHome);
  const existing = current[sessionId];
  if (existing && Number(existing.migratedAt ?? 0) > Number(info.migratedAt ?? 0)) {
    return false;
  }
  current[sessionId] = info;
  await writeFileAtomic(pendingMigrationsPath(dshHome), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  return true;
}

function findWorkspaceTitleForCwd(cwd, workspaceMappings, targetPlatform) {
  if (!cwd) return 'workspace';
  const mapped = mapPathAcrossOs(cwd, workspaceMappings, targetPlatform);
  if (mapped.workspaceId) {
    const found = workspaceMappings.find((m) => m && m.id === mapped.workspaceId);
    if (found?.title) return found.title;
  }
  return basenameForPlatform(cwd, targetPlatform);
}

function sameWorkspacePath(a, b, targetPlatform) {
  const normA = formatPathForPlatform(a, targetPlatform);
  const normB = formatPathForPlatform(b, targetPlatform);
  if (targetPlatform === 'win32' || targetPlatform === 'darwin') {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
}

export async function invalidateSessionProjCache(dshHome, sessionIds = []) {
  const home = resolveDshHome(dshHome);
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  for (const id of sessionIds) {
    if (typeof id !== 'string' || id.length === 0) continue;
    await fs.rm(path.join(cacheDir, `${encodeSegment(id)}.json`), { force: true }).catch(() => {});
    if (!/[/\\]|\.\./.test(id)) {
      await fs.rm(path.join(cacheDir, `${id}.json`), { force: true }).catch(() => {});
    }
  }
}

function extractLastPromptAtForProjCache(events = [], header = null) {
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev?.type === 'user/message' && ev.data?.source?.kind === 'user') {
        const ts = typeof ev.time === 'number' && Number.isFinite(ev.time)
          ? ev.time
          : typeof ev.timestamp === 'number' && Number.isFinite(ev.timestamp)
            ? ev.timestamp
            : null;
        if (ts !== null) return ts;
      }
    }
    const lastActive = extractLastActiveAt(events, header);
    if (lastActive > 0) return lastActive;
  }
  return null;
}

function buildOfflineProjCacheDoc(header, events = [], inheritedEventCount = 0) {
  const normalizedHeader = toPhysicalV4HeaderLine(header);
  const lastSeq = Array.isArray(events) && events.length > 0 ? events.length - 1 : -1;
  const hasTurn = Array.isArray(events) && events.some((ev) => ev?.type === 'turn/start' || ev?.type === 'user/message');
  const lastPromptAt = extractLastPromptAtForProjCache(events, normalizedHeader);
  const titleText = extractSessionTitle(events, '');
  const resolvedTitle = titleText && titleText.trim().length > 0 ? titleText.trim() : null;

  const identity = {
    formatVersion: normalizedHeader.version ?? 4,
    createdAt: normalizedHeader.createdAt,
    ...(typeof normalizedHeader.cwd === 'string' && normalizedHeader.cwd.length > 0 ? { cwd: normalizedHeader.cwd } : {}),
    isSeeded: Boolean(normalizedHeader.isSeeded),
    inheritedEventCount: Math.max(0, Number.isSafeInteger(inheritedEventCount) ? inheritedEventCount : 0),
  };

  return {
    version: PROJ_CACHE_DOMAIN_VERSION,
    record: {
      identity,
      rows: {
        sessionListMetadata: {
          ver: 1,
          seq: lastSeq,
          val: {
            blank: !hasTurn,
            lastPromptAt,
          },
        },
        title: {
          ver: 1,
          seq: lastSeq,
          val: resolvedTitle,
        },
      },
    },
  };
}

async function writeOfflineSessionProjCache(dshHome, entry) {
  if (!dshHome || !entry?.header?.id) return;
  const home = resolveDshHome(dshHome);
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  const doc = buildOfflineProjCacheDoc(entry.header, entry.events ?? [], entry.inheritedEventCount ?? 0);
  const targetFile = path.join(cacheDir, `${encodeSegment(entry.header.id)}.json`);
  await writeFileAtomic(targetFile, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
}

async function warmOnlineSessionProjCacheAndNotify(dshHome, cordisCtx, visibleEntries, allTouchedIds) {
  const warmedIds = new Set();
  const projCache = cordisCtx?.sessionProjectionCache ?? null;
  const projRegistry = cordisCtx?.sessionProjections ?? null;
  const sessionController = cordisCtx?.sessionController ?? null;

  for (const entry of visibleEntries) {
    if (!entry?.header?.id) continue;
    const normalizedHeader = toPhysicalV4HeaderLine(entry.header);
    const events = Array.isArray(entry.events) ? entry.events : [];
    const inheritedEventCount = Math.max(0, Number(entry.inheritedEventCount ?? extractInheritedEventCount(normalizedHeader)));

    // 1. Warm DSH sessionProjectionCache (online) so cachedSnapshot() has real title + lastPromptAt!
    let warmedOnline = false;
    if (projCache) {
      try {
        const identity = {
          formatVersion: normalizedHeader.version ?? 4,
          createdAt: normalizedHeader.createdAt,
          ...(typeof normalizedHeader.cwd === 'string' && normalizedHeader.cwd.length > 0 ? { cwd: normalizedHeader.cwd } : {}),
          isSeeded: Boolean(normalizedHeader.isSeeded),
          inheritedEventCount,
        };
        if (typeof projRegistry?.restore === 'function' && typeof projCache.put === 'function') {
          const restored = projRegistry.restore({}, events, 0, normalizedHeader, inheritedEventCount);
          const rows = { ...(restored?.checkpoint ?? {}) };
          // Ensure title projection has a human-readable fallback even if no explicit session/title event was logged yet
          if (!rows.title || rows.title.val === null) {
            const fallbackTitle = extractSessionTitle(events, '');
            if (fallbackTitle) {
              rows.title = { ver: 1, seq: events.length > 0 ? events.length - 1 : -1, val: fallbackTitle };
            }
          }
          // Ensure sessionListMetadata has accurate lastPromptAt for recency ordering
          if (!rows.sessionListMetadata || rows.sessionListMetadata.val?.lastPromptAt === null) {
            const lp = extractLastPromptAtForProjCache(events, normalizedHeader);
            if (lp !== null) {
              rows.sessionListMetadata = {
                ver: 1,
                seq: events.length > 0 ? events.length - 1 : -1,
                val: {
                  blank: false,
                  lastPromptAt: lp,
                },
              };
            }
          }
          await projCache.put(normalizedHeader.id, identity, rows);
          warmedOnline = true;
        } else if (typeof projCache.coldSnapshot === 'function') {
          projCache.coldSnapshot(normalizedHeader, inheritedEventCount, events);
          // Give fail-soft write-back promise a tick to land in domain table
          await new Promise((r) => setTimeout(r, 15));
          warmedOnline = true;
        }
      } catch {
        // Opus P2: If `projRegistry.restore()` throws (e.g., an optional projection unit isn't configured),
        // still populate the in-memory `SessionProjectionCache` via `projCache.put()` before disk fallback!
        try {
          if (typeof projCache.put === 'function') {
            const fallbackDoc = buildOfflineProjCacheDoc(normalizedHeader, events, inheritedEventCount);
            await projCache.put(normalizedHeader.id, fallbackDoc.record.identity, fallbackDoc.record.rows);
            warmedOnline = true;
          } else {
            warmedOnline = false;
          }
        } catch {
          warmedOnline = false;
        }
      }
    }

    if (!warmedOnline) {
      // If `sessionProjectionCache` service is not mounted, still evict any stale in-memory record
      // from `storageDomain` before writing the fresh v7 record to disk!
      try {
        const projCacheTable = cordisCtx?.storageDomain?.get?.('session_projcache')?.table?.('sessions');
        if (projCacheTable && typeof projCacheTable.delete === 'function') {
          await projCacheTable.delete(normalizedHeader.id);
        }
      } catch {
        // Ignore if domain is not open yet
      }
      if (dshHome) {
        await writeOfflineSessionProjCache(dshHome, {
          header: normalizedHeader,
          events,
          inheritedEventCount,
        });
      }
    }
    warmedIds.add(normalizedHeader.id);

    // 2. Push live sidebar update via DSH's `api-session/added` + `api-session/activity` events so running Web/Desktop UI updates immediately!
    if (typeof cordisCtx?.emit === 'function') {
      try {
        let summary = null;
        if (typeof sessionController?.listState?.summarizeCold === 'function') {
          summary = sessionController.listState.summarizeCold({
            header: normalizedHeader,
            formatStatus: 'current',
          });
        }
        if (!summary) {
          const summaryKeys = typeof projRegistry?.summaryKeys === 'function' ? projRegistry.summaryKeys() : undefined;
          const cachedBlock = typeof projCache?.cachedSnapshot === 'function'
            ? projCache.cachedSnapshot(normalizedHeader, summaryKeys)
            : undefined;
          const lastPromptAt = cachedBlock?.values?.sessionListMetadata?.lastPromptAt
            ?? extractLastPromptAtForProjCache(events, normalizedHeader);
          const fallbackTitle = extractSessionTitle(events, '');
          const values = {
            ...(cachedBlock?.values ?? {}),
            sessionListMetadata: cachedBlock?.values?.sessionListMetadata ?? {
              blank: false,
              lastPromptAt,
            },
            ...(cachedBlock?.values?.title !== undefined
              ? {}
              : fallbackTitle
                ? { title: fallbackTitle }
                : {}),
          };
          summary = {
            sessionId: normalizedHeader.id,
            updatedAt: Math.max(normalizedHeader.createdAt ?? 0, lastPromptAt ?? 0),
            agentAvailable: false,
            formatStatus: 'current',
            running: false,
            blank: values.sessionListMetadata?.blank ?? false,
            ...(normalizedHeader.parentSession ? { parentSessionId: normalizedHeader.parentSession } : {}),
            ...(normalizedHeader.origin ? { origin: normalizedHeader.origin } : {}),
            ...(normalizedHeader.cwd ? { cwd: normalizedHeader.cwd } : {}),
            projections: {
              kind: 'cached',
              asOfSeq: cachedBlock?.asOfSeq ?? (events.length > 0 ? events.length - 1 : -1),
              values,
            },
          };
        }
        // Neon P1 #4: On cold re-homing (`oldUnmappedCwd` changed and session is NOT open in `cordisCtx.sessions`),
        // emit `api-session/removed` immediately before `api-session/added` so `ClientSessions.list` refreshes `summary.cwd`!
        const isLiveOpen = Boolean(cordisCtx?.sessions?.get?.(normalizedHeader.id));
        if (entry.oldUnmappedCwd && !isLiveOpen) {
          cordisCtx.emit('api-session/removed', normalizedHeader.id);
        }
        cordisCtx.emit('api-session/added', summary);
        // Neon P1 #4: Emit `api-session/activity` so `ClientSessions` `applyMutation` updates `existing.updatedAt`!
        if (typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt) && summary.updatedAt > 0) {
          cordisCtx.emit('api-session/activity', normalizedHeader.id, summary.updatedAt);
        }
      } catch {
        // Non-fatal: workspace & projcache are already durable
      }
    }
  }

  // Delete stale cache for any remaining touched IDs (e.g. subagent children without visibleEntries)
  const unwarmedIds = (allTouchedIds ?? []).filter((id) => !warmedIds.has(id));
  if (unwarmedIds.length > 0) {
    let clearedViaDomain = false;
    try {
      const projCacheTable = cordisCtx?.storageDomain?.get?.('session_projcache')?.table?.('sessions');
      if (projCacheTable && typeof projCacheTable.delete === 'function') {
        for (const id of unwarmedIds) {
          await projCacheTable.delete(id);
        }
        clearedViaDomain = true;
      }
    } catch {
      // Ignore if domain is not open yet
    }
    if (!clearedViaDomain && dshHome) {
      await invalidateSessionProjCache(dshHome, unwarmedIds).catch(() => {});
    }
  }
}

async function reconcileOfflineWorkspaceAndCache(dshHome, visibleEntries, allTouchedIds, { workspaceMappings, targetPlatform }) {
  const home = resolveDshHome(dshHome);
  const wsPath = path.join(home, 'storages', 'workspace.json');

  // 1. Warm session_projcache for visible entries with events, and clear stale cache for any other touched IDs
  const warmedIds = new Set();
  for (const entry of visibleEntries) {
    if (entry?.header?.id && Array.isArray(entry.events)) {
      await writeOfflineSessionProjCache(home, entry);
      warmedIds.add(entry.header.id);
    }
  }
  const unwarmedIds = (allTouchedIds ?? []).filter((id) => !warmedIds.has(id));
  if (unwarmedIds.length > 0) {
    await invalidateSessionProjCache(home, unwarmedIds);
  }

  if (visibleEntries.length === 0) return;

  // 2. Load or initialize workspace.json v2
  let wsData;
  try {
    wsData = JSON.parse(await fs.readFile(wsPath, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    wsData = null;
  }

  if (!wsData || typeof wsData !== 'object') {
    wsData = {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: [],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
      tables: {
        workspaces: {},
      },
    };
  }

  wsData.unit = { name: 'workspace', version: 2 };
  wsData.global = {
    initialized: true,
    workspaceIds: Array.isArray(wsData.global?.workspaceIds) ? [...wsData.global.workspaceIds] : [],
    archivedSessionIds: Array.isArray(wsData.global?.archivedSessionIds) ? [...wsData.global.archivedSessionIds] : [],
    pinnedSessionIds: Array.isArray(wsData.global?.pinnedSessionIds) ? [...wsData.global.pinnedSessionIds] : [],
    ...(wsData.global?.defaultWorkspaceId !== undefined ? { defaultWorkspaceId: wsData.global.defaultWorkspaceId } : {}),
  };
  wsData.tables = {
    ...(wsData.tables && typeof wsData.tables === 'object' ? wsData.tables : {}),
    workspaces: wsData.tables?.workspaces && typeof wsData.tables.workspaces === 'object'
      ? { ...wsData.tables.workspaces }
      : {},
  };

  // Enforce 1:1 invariant between global.workspaceIds and tables.workspaces
  const workspaces = wsData.tables.workspaces;
  const dedupOrder = [];
  const seenWsIds = new Set();
  for (const wid of wsData.global.workspaceIds) {
    if (!seenWsIds.has(wid) && Object.hasOwn(workspaces, wid)) {
      seenWsIds.add(wid);
      dedupOrder.push(wid);
    }
  }
  for (const wid of Object.keys(workspaces)) {
    if (!seenWsIds.has(wid)) {
      seenWsIds.add(wid);
      dedupOrder.push(wid);
    }
  }
  wsData.global.workspaceIds = dedupOrder;

  const nowIso = new Date().toISOString();

  for (const entry of visibleEntries) {
    if (!entry.cwd) continue;
    let targetWsId = null;
    for (const wid of wsData.global.workspaceIds) {
      const rec = workspaces[wid];
      if (rec && typeof rec.path === 'string' && sameWorkspacePath(rec.path, entry.cwd, targetPlatform)) {
        targetWsId = wid;
        break;
      }
    }

    if (!targetWsId) {
      targetWsId = crypto.randomUUID();
      workspaces[targetWsId] = {
        path: entry.cwd,
        title: entry.title || findWorkspaceTitleForCwd(entry.cwd, workspaceMappings, targetPlatform),
        sessionIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      wsData.global.workspaceIds.unshift(targetWsId);
    }

    // Ensure sessionId belongs to AT MOST ONE workspace
    for (const [wid, rec] of Object.entries(workspaces)) {
      if (wid === targetWsId || !Array.isArray(rec.sessionIds)) continue;
      if (rec.sessionIds.includes(entry.sessionId)) {
        rec.sessionIds = rec.sessionIds.filter((s) => s !== entry.sessionId);
        rec.updatedAt = nowIso;
      }
    }

    const targetRec = workspaces[targetWsId];
    if (!Array.isArray(targetRec.sessionIds)) targetRec.sessionIds = [];
    if (entry.pinToTop) {
      targetRec.sessionIds = [entry.sessionId, ...targetRec.sessionIds.filter((s) => s !== entry.sessionId)];
      targetRec.updatedAt = nowIso;
      // Promote updated workspace to top of workspace dropdown order
      wsData.global.workspaceIds = [
        targetWsId,
        ...wsData.global.workspaceIds.filter((wid) => wid !== targetWsId),
      ];
    } else if (!targetRec.sessionIds.includes(entry.sessionId)) {
      targetRec.sessionIds = [entry.sessionId, ...targetRec.sessionIds];
      targetRec.updatedAt = nowIso;
    }
  }

  await writeFileAtomic(wsPath, `${JSON.stringify(wsData, null, 2)}\n`, { mode: 0o600 });
}

async function reconcileOnlineWorkspaceAndCache(dshHome, cordisCtx, visibleEntries, allTouchedIds, { workspaceMappings, targetPlatform }) {
  const wsReg = cordisCtx.workspaceRegistry;
  for (const entry of visibleEntries) {
    if (!entry.cwd) continue;

    if (targetPlatform === process.platform && path.isAbsolute(entry.cwd)) {
      await fs.mkdir(entry.cwd, { recursive: true }).catch(() => {});
    }

    // P0-3: Evict stale cached header & path maps on WorkspaceRegistry BEFORE attachSession so
    // live re-homing (auto-mirror -> explicit mapping) reads the newly updated disk header!
    wsReg?.headers?.delete?.(entry.sessionId);
    wsReg?.sessionPaths?.delete?.(entry.sessionId);
    wsReg?.missingSessionPaths?.delete?.(entry.sessionId);
    wsReg?.invalidSessionPaths?.delete?.(entry.sessionId);

    const title = entry.title || findWorkspaceTitleForCwd(entry.cwd, workspaceMappings, targetPlatform);
    const ws = await wsReg?.create?.(entry.cwd, title);

    // P0-3 Transactional Order: Attach to target workspace FIRST; ONLY detach from old workspaces AFTER attach succeeds!
    if (ws && typeof ws.attachSession === 'function') {
      await ws.attachSession(entry.sessionId);
      if (entry.pinToTop && typeof ws.insertSessionBefore === 'function') {
        const currentIds = ws.sessionIds;
        if (Array.isArray(currentIds) && currentIds.length > 0 && currentIds[0] !== entry.sessionId) {
          await ws.insertSessionBefore(entry.sessionId, currentIds[0]).catch(() => {});
        }
      }
    } else if (ws?.id && typeof wsReg?.attachSession === 'function') {
      await wsReg.attachSession(ws.id, entry.sessionId);
    }

    // Detach from old unmapped/mirror workspace (and any other workspace holding this sessionId) ONLY AFTER attach succeeded
    if (typeof wsReg?.list === 'function') {
      for (const existingWs of wsReg.list() ?? []) {
        if (!existingWs?.path) continue;
        if (sameWorkspacePath(existingWs.path, entry.cwd, targetPlatform)) continue;
        const matchesOld = Boolean(entry.oldUnmappedCwd && sameWorkspacePath(existingWs.path, entry.oldUnmappedCwd, targetPlatform));
        const holdsSession = Array.isArray(existingWs.sessionIds) && existingWs.sessionIds.includes(entry.sessionId);
        if (matchesOld || holdsSession) {
          await existingWs.detachSession?.(entry.sessionId).catch(() => {});
        }
      }
    }

    // Promote newly updated workspace to position #1 in DSH's top-left workspace dropdown
    if (entry.pinToTop && ws?.id && typeof wsReg?.insertBefore === 'function' && typeof wsReg?.list === 'function') {
      const firstWs = wsReg.list()?.[0];
      if (firstWs?.id && firstWs.id !== ws.id) {
        await wsReg.insertBefore(ws.id, firstWs.id).catch(() => {});
      }
    }
  }

  // P0-1: Warm online sessionProjectionCache & emit live `api-session/added` event to update running sidebar!
  await warmOnlineSessionProjCacheAndNotify(dshHome, cordisCtx, visibleEntries, allTouchedIds);
}

/**
 * Opus g23 #10: Re-home local-origin (and any remaining) sessions sitting inside a promoted
 * `auto-mirror` directory into the newly bound explicit mapped directory, transactionally updating
 * disk logs, WorkspaceRegistry, and sessionProjectionCache.
 */
export async function rehomeLocalSessionsInWorkspace({
  dshHome,
  fromCwd,
  toCwd,
  workspaceMappings = [],
  targetPlatform = process.platform,
  cordisCtx = null,
}) {
  if (!fromCwd || !toCwd || sameWorkspacePath(fromCwd, toCwd, targetPlatform)) {
    return { migrated: [], deferredBusy: [], errors: [] };
  }
  const resolvedHome = resolveDshHome(dshHome);
  const localMap = await scanLocalSessions(resolvedHome);
  const migrated = [];
  const deferredBusy = [];
  const errors = [];

  for (const rec of localMap.values()) {
    if (!rec.header?.cwd || !sameWorkspacePath(rec.header.cwd, fromCwd, targetPlatform)) continue;
    if (cordisCtx?.isSessionBusy?.(rec.sessionId)) {
      deferredBusy.push(rec.sessionId);
      continue;
    }
    try {
      if (typeof cordisCtx?.releaseIdleSession === 'function') {
        await cordisCtx.releaseIdleSession(rec.sessionId);
      }
      const rewritten = await rewriteSessionForTargetOs({
        header: rec.header,
        events: rec.events,
        workspaceMappings,
        targetPlatform,
        dshHome: resolvedHome,
        overrideTargetCwd: toCwd,
      });
      await writeSessionLogToDisk(resolvedHome, rewritten.header, rewritten.events);
      const visibleEntries = rewritten.header.origin === 'subagent'
        ? []
        : [{
            sessionId: rec.sessionId,
            cwd: rewritten.header.cwd,
            oldUnmappedCwd: fromCwd,
            header: rewritten.header,
            events: rewritten.events,
            inheritedEventCount: rec.inheritedEventCount,
            pinToTop: true,
          }];
      if (cordisCtx) {
        await reconcileOnlineWorkspaceAndCache(resolvedHome, cordisCtx, visibleEntries, [rec.sessionId], {
          workspaceMappings,
          targetPlatform,
        });
      } else {
        await reconcileOfflineWorkspaceAndCache(resolvedHome, visibleEntries, [rec.sessionId], {
          workspaceMappings,
          targetPlatform,
        });
      }
      migrated.push(rec.sessionId);
    } catch (err) {
      errors.push({ sessionId: rec.sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { migrated, deferredBusy, errors };
}

function inferSessionTitle(events = [], fallbackId = 'session') {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'session/title' && typeof ev.data?.title === 'string' && ev.data.title.trim().length > 0) {
      return ev.data.title.trim();
    }
  }
  for (const ev of events) {
    if (ev?.type === 'user/message') {
      const content = ev.data?.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) return text.slice(0, 40);
      } else if (typeof ev.data?.text === 'string' && ev.data.text.trim()) {
        return ev.data.text.trim().slice(0, 40);
      }
    }
  }
  return fallbackId;
}

function isSyntheticBranchTitleEvent(ev) {
  return (
    ev?.type === 'session/title'
    && ev?.data?.source?.kind === 'user'
    && typeof ev?.data?.title === 'string'
    && /^\[来自.+分支\]\s/.test(ev.data.title)
  );
}

function stripTrailingSyntheticBranchTitle(events = []) {
  if (events.length > 0 && isSyntheticBranchTitleEvent(events[events.length - 1])) {
    return events.slice(0, -1);
  }
  return events;
}

function remapDeliveryAccepted(events, fromSessionId, toSessionId, inheritedEventCount = 0) {
  return events.map((ev, idx) => {
    const evSeq = typeof ev?.seq === 'number' ? ev.seq : idx;
    if (
      evSeq >= inheritedEventCount
      && ev?.type === 'session-log-deepseek/delivery-accepted'
      && ev?.data?.sessionId === fromSessionId
    ) {
      return {
        ...ev,
        data: {
          ...ev.data,
          sessionId: toSessionId,
        },
      };
    }
    return ev;
  });
}

function remapSubagentCatalogChildIds(events, childIdMap, inheritedEventCount = 0) {
  if (childIdMap.size === 0) return events;
  return events.map((ev, idx) => {
    const evSeq = typeof ev?.seq === 'number' ? ev.seq : idx;
    if (evSeq < inheritedEventCount) return ev;
    if (ev?.type === 'subagent/catalog' && typeof ev.data?.childId === 'string' && childIdMap.has(ev.data.childId)) {
      return {
        ...ev,
        data: {
          ...ev.data,
          childId: childIdMap.get(ev.data.childId),
        },
      };
    }
    return ev;
  });
}

function appendBranchTitleEvent(events, { remoteLabel, origSessionId, commitTimestamp }) {
  const inferred = inferSessionTitle(events, origSessionId);
  const titleText = `[来自${remoteLabel}分支] ${inferred}`;
  const hasSeq = events.length === 0 || events.some((e) => typeof e?.seq === 'number');
  const lastEvent = events[events.length - 1];
  const baseTime = typeof lastEvent?.time === 'number'
    ? lastEvent.time + 1
    : typeof lastEvent?.timestamp === 'number'
      ? lastEvent.timestamp + 1
      : (commitTimestamp ?? Date.now());

  const titleEvent = {
    ...(hasSeq ? { seq: events.length } : {}),
    time: baseTime,
    type: 'session/title',
    data: {
      title: titleText,
      messageSeqs: [],
      source: { kind: 'user' },
    },
  };
  return [...events, titleEvent];
}

function isSessionAlreadyOwnedError(err) {
  return Boolean(
    err
    && (
      err.name === 'SessionAlreadyOwnedError'
      || err.code === 'SessionAlreadyOwnedError'
      || /already owned/i.test(String(err.message ?? ''))
    ),
  );
}

async function syncSubagentChildren(
  childNodes,
  {
    dshHome,
    localMap,
    workspaceMappings,
    targetPlatform,
    fallbackRoot,
    cordisCtx = null,
    vaultDir = undefined,
    remoteVaultDir = undefined,
    defaultWorkspaceDir = undefined,
    autoMirrorRoot = undefined,
    rootTargetCwd = undefined,
    parentRemap = new Map(),
    isForkedBranch = false,
    remoteDeviceId = '',
  },
) {
  const writtenIds = [];
  const childIdMap = new Map();

  // Rewrite all children once so hash comparisons match rewritten local paths
  const preparedChildren = [];
  for (const child of childNodes) {
    const origChildId = child.decoded.header.id;
    const localChild = localMap.get(origChildId);
    let overrideChildCwd;
    if (typeof child.decoded.header?.cwd === 'string' && child.decoded.header.cwd.length > 0) {
      const childTarget = await resolveTargetSessionCwd({
        sessionId: origChildId,
        sourceCwd: child.decoded.header.cwd,
        localRoot: localChild,
        workspaceMappings,
        targetPlatform,
        fallbackRoot,
        dshHome,
        cordisCtx,
        vaultDir,
        remoteVaultDir,
        defaultWorkspaceDir,
        autoMirrorRoot,
        folderMatchMode: 'auto-mirror',
      });
      overrideChildCwd = childTarget.path || rootTargetCwd;
    }
    const rewritten = await rewriteSessionForTargetOs({
      header: child.decoded.header,
      events: child.decoded.events,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      dshHome,
      overrideTargetCwd: overrideChildCwd,
    });
    preparedChildren.push({ child, rewritten });
  }

  // First pass: determine target IDs for each child (avoid clobbering existing local child of origSessionId during fork)
  for (const { child, rewritten } of preparedChildren) {
    const origChildId = child.decoded.header.id;
    let targetChildId = origChildId;
    if (isForkedBranch && localMap.has(origChildId)) {
      const childChain = computeEventHashChain(rewritten.events, workspaceMappings, rewritten.header?.cwd || '');
      const localChild = localMap.get(origChildId);
      const localChildChain = computeEventHashChain(localChild.events, workspaceMappings, localChild.header?.cwd || '');
      if (localChildChain.headHash !== childChain.headHash) {
        targetChildId = `session-branch-${String(remoteDeviceId).slice(0, 8)}-${childChain.headHash.slice(0, 10)}`;
        childIdMap.set(origChildId, targetChildId);
      }
    }
  }

  for (const { child, rewritten } of preparedChildren) {
    const origChildId = child.decoded.header.id;
    const targetChildId = childIdMap.get(origChildId) ?? origChildId;

    const header = { ...rewritten.header, id: targetChildId };
    if (header.parentSession && parentRemap.has(header.parentSession)) {
      header.parentSession = parentRemap.get(header.parentSession);
    } else if (header.parentSession && childIdMap.has(header.parentSession)) {
      header.parentSession = childIdMap.get(header.parentSession);
    }

    let events = rewritten.events;
    if (targetChildId !== origChildId) {
      events = remapDeliveryAccepted(events, origChildId, targetChildId, child.inheritedEventCount);
    }
    events = remapSubagentCatalogChildIds(events, childIdMap, child.inheritedEventCount);

    const localChild = localMap.get(targetChildId);
    if (!localChild) {
      await writeSessionLogToDisk(dshHome, header, events);
      writtenIds.push(targetChildId);
    } else {
      const localChain = computeEventHashChain(localChild.events, workspaceMappings, localChild.header?.cwd || '');
      const remoteChain = computeEventHashChain(events, workspaceMappings, header?.cwd || '');
      const canFastForward =
        events.length > localChild.events.length
        && (localChild.events.length === 0 || remoteChain.chainHashes[localChild.events.length - 1] === localChain.headHash);
      if (canFastForward) {
        await writeSessionLogToDisk(dshHome, header, events);
        writtenIds.push(targetChildId);
      }
    }
  }

  return { writtenIds, childIdMap };
}

/**
 * Import one session commit from VaultStore into local `<dshHome>`, performing:
 *  - Version & blob hydration pre-flight checks
 *  - Smart zero-config target workspace homing + `_unmapped` orphan rescue + vault self-rescue
 *  - Attachment & unmapped `outputs/` reconstruction
 *  - Minimal exact OS path rewrite
 *  - Import / Lossless Fast-Forward / Orphan Migration / Zero-Shift Split-Brain Fork
 *  - Dual-mode (online Cordis vs offline disk) workspace & projection-cache reconciliation with pin-to-top
 */
export async function importSessionCommit({
  dshHome,
  vault,
  commit,
  workspaceMappings = [],
  targetPlatform = process.platform,
  fallbackRoot = undefined,
  cordisCtx = null,
  defaultWorkspaceDir = undefined,
  folderMatchMode = 'auto-mirror',
  autoMirrorRoot = undefined,
  autoMirrorAssignments = {},
  mirrorSlotMap = null,
  sessionTargetOverrides = {},
  workspaceTargetOverrides = {},
  localMap: sharedLocalMap = null,
  maxSupportedFormatVersion = DEFAULT_MAX_FORMAT_VERSION,
}) {
  if (!vault) throw new TypeError('importSessionCommit requires vault');
  if (!commit || !commit.payload) throw new TypeError('importSessionCommit requires commit with payload');

  const resolvedHome = resolveDshHome(dshHome);
  const payload = commit.payload;
  const rootSessionId = payload.rootSessionId ?? commit.targetId;
  const remoteFormatVersion = payload.dshFormatVersion ?? 4;
  const remoteVaultDir = typeof payload.sourceVaultDir === 'string' ? payload.sourceVaultDir : undefined;
  const vaultDirs = [vault.vaultDir, remoteVaultDir].filter(Boolean);

  // 1. Format version guard (refuse downgrade/corruption)
  if (remoteFormatVersion > maxSupportedFormatVersion) {
    return {
      status: 'version-mismatch',
      sessionId: rootSessionId,
      remoteFormatVersion,
      maxSupportedFormatVersion,
    };
  }

  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const packedOutputs = Array.isArray(payload.packedOutputs) ? payload.packedOutputs : [];

  const rootNodeMeta = nodes.find((n) => n.sessionId === rootSessionId) ?? nodes[0];
  if (!rootNodeMeta) {
    return { status: 'up-to-date', sessionId: rootSessionId };
  }

  const localMap = sharedLocalMap ?? await scanLocalSessions(resolvedHome);
  const localRoot = localMap.get(rootSessionId);

  // Early mapped-only pre-flight check BEFORE reading blobs or creating directories
  const metaSourceCwd = typeof rootNodeMeta.header?.cwd === 'string'
    ? rootNodeMeta.header.cwd
    : typeof payload.sourceCwd === 'string'
      ? payload.sourceCwd
      : '';

  if (folderMatchMode === 'mapped-only' && metaSourceCwd) {
    const preCheck = await resolveTargetSessionCwd({
      sessionId: rootSessionId,
      sourceCwd: metaSourceCwd,
      sourcePlatform: commit.platform ?? null,
      localRoot,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      dshHome: resolvedHome,
      cordisCtx,
      vaultDir: vault.vaultDir,
      remoteVaultDir,
      defaultWorkspaceDir,
      folderMatchMode,
      autoMirrorRoot,
      autoMirrorAssignments,
      mirrorSlotMap,
      sessionTargetOverrides,
      workspaceTargetOverrides,
      dryRun: true,
    });
    if (preCheck.skipped) {
      return {
        status: 'unmapped-skipped',
        sessionId: rootSessionId,
        sourceCwd: metaSourceCwd,
      };
    }
  }

  // 2. Hydration pre-flight check across ALL log blobs, attachments, and packed outputs
  const allBlobRefs = [
    ...nodes.map((n) => n.logBlob),
    ...attachments.map((a) => ({ storageKey: a.storageKey, sha256: a.sha256, size: a.size })),
    ...packedOutputs.map((o) => ({ storageKey: o.storageKey, sha256: o.sha256, size: o.size })),
  ];
  const hydration = await vault.verifyCommitBlobs(allBlobRefs);
  if (!hydration.ready) {
    return {
      status: 'pending-hydration',
      sessionId: rootSessionId,
      reason: hydration.reason,
      storageKey: hydration.storageKey,
      detail: hydration.detail,
    };
  }

  // Decode all closure nodes from verified vault blobs
  const decodedNodes = [];
  for (const node of nodes) {
    const raw = await vault.getBlob(node.logBlob.storageKey, node.logBlob.sha256, node.logBlob.size);
    const decoded = await decodeV4SessionLog(raw);
    decodedNodes.push({
      meta: node,
      decoded,
      inheritedEventCount: node.inheritedEventCount ?? extractInheritedEventCount(decoded.header),
    });
  }

  const rootDecodedEntry = decodedNodes.find((n) => n.decoded.header.id === rootSessionId) ?? decodedNodes[0];
  const childEntries = decodedNodes.filter((n) => n !== rootDecodedEntry);

  const origRemoteCwd = rootDecodedEntry.decoded.header.cwd ?? '';
  let targetResolution = null;
  if (typeof origRemoteCwd === 'string' && origRemoteCwd.length > 0) {
    targetResolution = await resolveTargetSessionCwd({
      sessionId: rootSessionId,
      sourceCwd: origRemoteCwd,
      sourcePlatform: commit.platform ?? null,
      localRoot,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      dshHome: resolvedHome,
      cordisCtx,
      vaultDir: vault.vaultDir,
      remoteVaultDir,
      defaultWorkspaceDir,
      folderMatchMode,
      autoMirrorRoot,
      autoMirrorAssignments,
      mirrorSlotMap,
      sessionTargetOverrides,
      workspaceTargetOverrides,
    });
    if (targetResolution?.skipped) {
      return {
        status: 'unmapped-skipped',
        sessionId: rootSessionId,
        sourceCwd: origRemoteCwd,
      };
    }
  }

  const updateLocalMapRecord = (header, events) => {
    const normalizedHeader = toPhysicalV4HeaderLine(header);
    localMap.set(normalizedHeader.id, {
      sessionId: normalizedHeader.id,
      projKey: projectDirNameForCwd(normalizedHeader.cwd),
      sessionDir: null,
      logPath: null,
      formatVersion: normalizedHeader.version ?? 4,
      header: normalizedHeader,
      events,
      inheritedEventCount: extractInheritedEventCount(normalizedHeader),
      recoveredTornTail: false,
    });
  };

  const rewrittenRoot = await rewriteSessionForTargetOs({
    header: rootDecodedEntry.decoded.header,
    events: rootDecodedEntry.decoded.events,
    workspaceMappings,
    targetPlatform,
    fallbackRoot,
    dshHome: resolvedHome,
    overrideTargetCwd: targetResolution?.path,
  });
  const remoteRootChain = computeEventHashChain(
    rewrittenRoot.events,
    workspaceMappings,
    rewrittenRoot.header?.cwd || '',
  );

  const isCrossPlatform = Boolean(commit.platform && commit.platform !== targetPlatform);
  const isCrossDevice = Boolean(commit.deviceId && vault.deviceId && commit.deviceId !== vault.deviceId);
  const remoteLabel = payload.deviceLabel || commit.deviceId;

  async function maybeRecordMigration(targetId, toCwd) {
    if (!isCrossPlatform && !isCrossDevice) return;
    await recordPendingMigration(resolvedHome, targetId, {
      fromDeviceId: commit.deviceId,
      fromDeviceLabel: remoteLabel,
      fromPlatform: commit.platform || targetPlatform,
      toPlatform: targetPlatform,
      isCrossPlatform,
      fromCwd: origRemoteCwd || null,
      toCwd: toCwd ?? null,
      migratedAt: Date.now(),
    });
  }

  async function reconcileRegistries(visibleEntries, touchedIds) {
    if (cordisCtx) {
      await reconcileOnlineWorkspaceAndCache(resolvedHome, cordisCtx, visibleEntries, touchedIds, { workspaceMappings, targetPlatform });
    } else {
      await reconcileOfflineWorkspaceAndCache(resolvedHome, visibleEntries, touchedIds, { workspaceMappings, targetPlatform });
    }
  }

  const childSyncCommonOpts = {
    dshHome: resolvedHome,
    localMap,
    workspaceMappings,
    targetPlatform,
    fallbackRoot,
    cordisCtx,
    vaultDir: vault.vaultDir,
    remoteVaultDir,
    defaultWorkspaceDir,
    autoMirrorRoot,
    rootTargetCwd: rewrittenRoot.header?.cwd,
  };

  const commitOriginDeviceId = payload.originDeviceId || commit.deviceId;

  // Case A: Local root session does not exist -> Direct Import
  if (!localRoot) {
    const attachmentsRestored = await restoreAttachments(resolvedHome, attachments, vault);
    await writeSessionLogToDisk(resolvedHome, rewrittenRoot.header, rewrittenRoot.events);
    await recordSessionOrigin(resolvedHome, rootSessionId, commitOriginDeviceId);
    updateLocalMapRecord(rewrittenRoot.header, rewrittenRoot.events);
    const { writtenIds: childWritten } = await syncSubagentChildren(childEntries, childSyncCommonOpts);
    const outputRes = await restoreUnmappedSessionOutputs({
      dshHome: resolvedHome,
      sessionId: rootSessionId,
      targetCwd: rewrittenRoot.header.cwd,
      packedOutputs,
      vault,
      remoteLabel,
      targetPlatform,
      vaultDirs,
    });

    await maybeRecordMigration(rootSessionId, rewrittenRoot.header.cwd);
    const touchedIds = [rootSessionId, ...childWritten];
    const visibleEntries = rewrittenRoot.header.origin === 'subagent'
      ? []
      : [{
          sessionId: rootSessionId,
          cwd: rewrittenRoot.header.cwd,
          header: rewrittenRoot.header,
          events: rewrittenRoot.events,
          inheritedEventCount: rootDecodedEntry.inheritedEventCount,
          pinToTop: true,
        }];
    await reconcileRegistries(visibleEntries, touchedIds);

    return {
      status: 'imported',
      sessionId: rootSessionId,
      sourceCwd: origRemoteCwd,
      targetCwd: rewrittenRoot.header.cwd,
      matchedBy: targetResolution?.matchedBy ?? null,
      allocatedMirrorAssignment: targetResolution?.allocatedMirrorAssignment ?? null,
      writtenSessions: touchedIds,
      attachmentsRestored,
      outputsRestored: outputRes.restored,
      outputConflicts: outputRes.conflicts,
    };
  }

  // Case B: Local root session exists -> Compare logical substantive hash chains (ignoring ephemeral
  // `session/end-seed` resume markers & volatile wall-clock `time`, normalized with each side's own sessionRootCwd,
  // with mapping-independent session-relative fallback so differing workspaceId across machines never false-forks)
  const localSubstantive = filterSubstantiveLineageEvents(localRoot.events);
  const remoteSubstantive = filterSubstantiveLineageEvents(rewrittenRoot.events);
  const localRootChain = computeEventHashChain(
    localRoot.events,
    workspaceMappings,
    localRoot.header?.cwd || '',
  );
  const localRelChain = computeEventHashChain(
    localRoot.events,
    [],
    localRoot.header?.cwd || '',
  );
  const remoteRelChain = computeEventHashChain(
    rewrittenRoot.events,
    [],
    rewrittenRoot.header?.cwd || '',
  );
  const remoteOrigRelChain = computeEventHashChain(
    rootDecodedEntry.decoded.events,
    [],
    origRemoteCwd || '',
  );
  const L = localSubstantive.length;
  const R = remoteSubstantive.length;

  const isIdentical = L === R && (
    localRootChain.headHash === remoteRootChain.headHash
    || localRelChain.headHash === remoteRelChain.headHash
    || localRelChain.headHash === remoteOrigRelChain.headHash
  );
  const remoteIsOlderPrefix = R < L && (
    R === 0
    || localRootChain.chainHashes[R - 1] === remoteRootChain.headHash
    || localRelChain.chainHashes[R - 1] === remoteRelChain.headHash
    || localRelChain.chainHashes[R - 1] === remoteOrigRelChain.headHash
  );

  const shouldRescueOrphan = Boolean(
    targetResolution?.migratedFromUnmapped
    && rewrittenRoot.header.cwd
    && localRoot.header.cwd
    && !sameWorkspacePath(localRoot.header.cwd, rewrittenRoot.header.cwd, targetPlatform),
  );

  if (isIdentical || remoteIsOlderPrefix) {
    const { writtenIds: childWritten } = await syncSubagentChildren(childEntries, childSyncCommonOpts);
    if (childWritten.length > 0 && attachments.length > 0) {
      await restoreAttachments(resolvedHome, attachments, vault);
    }

    // Rescue stranded `_unmapped` / vault / auto-mirror orphan session into real target workspace & sidebar!
    if (shouldRescueOrphan) {
      if (cordisCtx?.isSessionBusy?.(rootSessionId)) {
        return {
          status: 'deferred-busy',
          sessionId: rootSessionId,
          reason: 'agent-running',
        };
      }
      // P0-3 / R3: Release any idle resident agent/session write handle BEFORE rm -r + rewriting session dir!
      if (typeof cordisCtx?.releaseIdleSession === 'function') {
        await cordisCtx.releaseIdleSession(rootSessionId);
      }
      const migrated = await rewriteSessionForTargetOs({
        header: localRoot.header,
        events: localRoot.events,
        workspaceMappings,
        targetPlatform,
        fallbackRoot,
        dshHome: resolvedHome,
        overrideTargetCwd: rewrittenRoot.header.cwd,
      });
      await writeSessionLogToDisk(resolvedHome, migrated.header, migrated.events);
      updateLocalMapRecord(migrated.header, migrated.events);
      const outputRes = await restoreUnmappedSessionOutputs({
        dshHome: resolvedHome,
        sessionId: rootSessionId,
        targetCwd: migrated.header.cwd,
        packedOutputs,
        vault,
        remoteLabel,
        targetPlatform,
        vaultDirs,
      });
      const touchedIds = [rootSessionId, ...childWritten];
      const visibleEntries = migrated.header.origin === 'subagent'
        ? []
        : [{
            sessionId: rootSessionId,
            cwd: migrated.header.cwd,
            oldUnmappedCwd: localRoot.header.cwd,
            header: migrated.header,
            events: migrated.events,
            inheritedEventCount: localRoot.inheritedEventCount,
            pinToTop: true,
          }];
      await reconcileRegistries(visibleEntries, touchedIds);
      return {
        status: 'migrated',
        sessionId: rootSessionId,
        sourceCwd: origRemoteCwd,
        fromCwd: localRoot.header.cwd,
        toCwd: migrated.header.cwd,
        targetCwd: migrated.header.cwd,
        matchedBy: targetResolution?.matchedBy ?? null,
        allocatedMirrorAssignment: targetResolution?.allocatedMirrorAssignment ?? null,
        writtenSessions: touchedIds,
        outputsRestored: outputRes.restored,
        outputConflicts: outputRes.conflicts,
      };
    }

    const outputRes = await restoreUnmappedSessionOutputs({
      dshHome: resolvedHome,
      sessionId: rootSessionId,
      targetCwd: localRoot.header.cwd,
      packedOutputs,
      vault,
      remoteLabel,
      targetPlatform,
      vaultDirs,
      skipIfSigUnchanged: true,
    });
    return {
      status: 'up-to-date',
      sessionId: rootSessionId,
      sourceCwd: origRemoteCwd,
      targetCwd: localRoot.header.cwd,
      outputsRestored: outputRes.restored,
      outputConflicts: outputRes.conflicts,
    };
  }

  const canFastForward = R > L && (
    L === 0
    || remoteRootChain.chainHashes[L - 1] === localRootChain.headHash
    || remoteRelChain.chainHashes[L - 1] === localRelChain.headHash
    || remoteOrigRelChain.chainHashes[L - 1] === localRelChain.headHash
  );
  if (canFastForward) {
    if (cordisCtx?.isSessionBusy?.(rootSessionId)) {
      return {
        status: 'deferred-busy',
        sessionId: rootSessionId,
        reason: 'agent-running',
      };
    }

    const attachmentsRestored = await restoreAttachments(resolvedHome, attachments, vault);
    const deltaEvents = remoteSubstantive.slice(L);
    let finalEvents = rewrittenRoot.events;
    let finalHeader = rewrittenRoot.header;
    let appliedInPlace = false;

    // P0-2A / Opus A3b: When an idle session is currently live/open in `cordisCtx.sessions`,
    // fast-forward IT IN PLACE via `liveSession.append(...)` (NEVER emitting `session/disposed` /
    // `api-session/removed` which would irreversibly latch `openTab.removed = true`!).
    if (!shouldRescueOrphan && typeof cordisCtx?.fastForwardLiveSession === 'function') {
      const liveRes = await cordisCtx.fastForwardLiveSession(rootSessionId, deltaEvents, {
        localSubstantive,
        remoteSubstantive,
      });
      if (liveRes?.applied) {
        appliedInPlace = true;
        if (Array.isArray(liveRes.events) && liveRes.events.length > 0) {
          finalEvents = liveRes.events;
        }
        if (liveRes.header) {
          finalHeader = liveRes.header;
        }
        clearLocalSessionScanCache(localRoot.logPath || null);
      } else if (liveRes?.busy) {
        return {
          status: 'deferred-busy',
          sessionId: rootSessionId,
          reason: 'agent-running',
        };
      }
    }

    if (!appliedInPlace) {
      // P0-2B / R1: If an idle resident handle (without live Session.append) or orphan re-home
      // holds the persistence write lock, safely release it BEFORE opening the write handle!
      if (typeof cordisCtx?.releaseIdleSession === 'function') {
        await cordisCtx.releaseIdleSession(rootSessionId);
      }

      // Build seq-remapped delta events when local/remote raw seqs diverge due to `session/end-seed` markers
      const localRawLen = localRoot.events.length;
      const rawSeqAligned = localRawLen === L && rewrittenRoot.events.length === R;
      let appendableDelta = deltaEvents;
      if (!rawSeqAligned) {
        const seqMap = new Map();
        for (let i = 0; i < L; i += 1) {
          if (typeof remoteSubstantive[i]?.seq === 'number' && typeof localSubstantive[i]?.seq === 'number') {
            seqMap.set(remoteSubstantive[i].seq, localSubstantive[i].seq);
          }
        }
        appendableDelta = deltaEvents.map((ev, idx) => {
          const targetSeq = localRawLen + idx;
          if (typeof ev.seq === 'number') {
            seqMap.set(ev.seq, targetSeq);
          }
          const remapped = remapEventSeqReferences(ev, seqMap);
          return { ...remapped, seq: targetSeq };
        });
        finalEvents = [...localRoot.events, ...appendableDelta];
      }

      // If rescuing from unmapped-workspaces, write full relocated V4 log to the new projectKey dir
      // (cannot append to old unmapped projectKey via persistence.open)
      if (shouldRescueOrphan) {
        await writeSessionLogToDisk(resolvedHome, rewrittenRoot.header, rewrittenRoot.events);
        finalEvents = rewrittenRoot.events;
      } else if (cordisCtx?.sessionPersistence?.open) {
        let handle;
        try {
          handle = await cordisCtx.sessionPersistence.open(rootSessionId, 'write');
          await handle.append(appendableDelta);
          await handle.flush();
        } catch (err) {
          if (isSessionAlreadyOwnedError(err)) {
            return {
              status: 'deferred-busy',
              sessionId: rootSessionId,
              reason: 'session-already-owned',
            };
          }
          throw err;
        } finally {
          if (handle && typeof handle.close === 'function') {
            await handle.close();
          }
        }
        clearLocalSessionScanCache(localRoot.logPath || null);
      } else if (cordisCtx?.sessionPersistence?.writeImportedSessionLog) {
        try {
          await cordisCtx.sessionPersistence.writeImportedSessionLog(
            rootSessionId,
            rewrittenRoot.header,
            rewrittenRoot.events,
          );
          finalEvents = rewrittenRoot.events;
        } catch (err) {
          if (isSessionAlreadyOwnedError(err)) {
            return {
              status: 'deferred-busy',
              sessionId: rootSessionId,
              reason: 'session-already-owned',
            };
          }
          throw err;
        }
        clearLocalSessionScanCache(localRoot.logPath || null);
      } else {
        await writeSessionLogToDisk(resolvedHome, rewrittenRoot.header, rewrittenRoot.events);
        finalEvents = rewrittenRoot.events;
      }
    }

    const { writtenIds: childWritten } = await syncSubagentChildren(childEntries, childSyncCommonOpts);
    const outputRes = await restoreUnmappedSessionOutputs({
      dshHome: resolvedHome,
      sessionId: rootSessionId,
      targetCwd: finalHeader.cwd,
      packedOutputs,
      vault,
      remoteLabel,
      targetPlatform,
      vaultDirs,
    });

    await maybeRecordMigration(rootSessionId, finalHeader.cwd);
    updateLocalMapRecord(finalHeader, finalEvents);
    const touchedIds = [rootSessionId, ...childWritten];
    const visibleEntries = finalHeader.origin === 'subagent'
      ? []
      : [{
          sessionId: rootSessionId,
          cwd: finalHeader.cwd,
          ...(shouldRescueOrphan ? { oldUnmappedCwd: localRoot.header.cwd } : {}),
          header: finalHeader,
          events: finalEvents,
          inheritedEventCount: rootDecodedEntry.inheritedEventCount,
          pinToTop: true,
        }];
    await reconcileRegistries(visibleEntries, touchedIds);

    return {
      status: 'fast-forwarded',
      sessionId: rootSessionId,
      sourceCwd: origRemoteCwd,
      targetCwd: finalHeader.cwd,
      matchedBy: targetResolution?.matchedBy ?? null,
      allocatedMirrorAssignment: targetResolution?.allocatedMirrorAssignment ?? null,
      migratedFromUnmapped: shouldRescueOrphan,
      appliedInPlace,
      previousEventCount: L,
      newEventCount: R,
      appendedCount: deltaEvents.length,
      attachmentsRestored,
      outputsRestored: outputRes.restored,
      outputConflicts: outputRes.conflicts,
    };
  }

  // Case C: True Split-Brain -> Zero-Shift Split-Brain Fork!
  const remotePrefix = String(commit.deviceId).slice(0, 8);
  const deterministicBranchId = `session-branch-${remotePrefix}-${remoteRootChain.headHash.slice(0, 10)}`;

  // Check for idempotent skip or existing diverged branch growth
  for (const candidate of localMap.values()) {
    const isExactBranch = candidate.sessionId === deterministicBranchId;
    const isSiblingBranchFromSameDevice =
      candidate.header?.parentSession === rootSessionId
      && candidate.sessionId.startsWith(`session-branch-${remotePrefix}-`);

    if (!isExactBranch && !isSiblingBranchFromSameDevice) continue;

    const strippedExisting = stripTrailingSyntheticBranchTitle(candidate.events);
    const unremappedExisting = remapDeliveryAccepted(
      strippedExisting,
      candidate.sessionId,
      rootSessionId,
      candidate.inheritedEventCount,
    );
    const existingChain = computeEventHashChain(
      unremappedExisting,
      workspaceMappings,
      candidate.header?.cwd || '',
    );

    if (existingChain.headHash === remoteRootChain.headHash) {
      return {
        status: 'up-to-date',
        sessionId: rootSessionId,
        branchId: candidate.sessionId,
      };
    }

    const existingSubLen = existingChain.chainHashes.length;
    const branchCanFastForward =
      R > existingSubLen
      && (existingSubLen === 0 || remoteRootChain.chainHashes[existingSubLen - 1] === existingChain.headHash);

    if (branchCanFastForward) {
      const attachmentsRestored = await restoreAttachments(resolvedHome, attachments, vault);
      const targetBranchId = candidate.sessionId;
      const parentRemap = new Map([[rootSessionId, targetBranchId]]);
      const { writtenIds: childWritten, childIdMap } = await syncSubagentChildren(childEntries, {
        ...childSyncCommonOpts,
        parentRemap,
        isForkedBranch: true,
        remoteDeviceId: commit.deviceId,
      });

      const branchHeader = {
        ...rewrittenRoot.header,
        id: targetBranchId,
        parentSession: rootSessionId,
      };
      delete branchHeader.origin;

      let branchEvents = remapDeliveryAccepted(
        rewrittenRoot.events,
        rootSessionId,
        targetBranchId,
        rootDecodedEntry.inheritedEventCount,
      );
      branchEvents = remapSubagentCatalogChildIds(branchEvents, childIdMap, rootDecodedEntry.inheritedEventCount);
      branchEvents = appendBranchTitleEvent(branchEvents, {
        remoteLabel,
        origSessionId: rootSessionId,
        commitTimestamp: commit.timestamp,
      });

      await writeSessionLogToDisk(resolvedHome, branchHeader, branchEvents);
      await maybeRecordMigration(targetBranchId, branchHeader.cwd);
      const touchedIds = [targetBranchId, ...childWritten];
      await reconcileRegistries([{
        sessionId: targetBranchId,
        cwd: branchHeader.cwd,
        header: branchHeader,
        events: branchEvents,
        inheritedEventCount: rootDecodedEntry.inheritedEventCount,
        pinToTop: true,
      }], touchedIds);

      return {
        status: 'fast-forwarded',
        sessionId: rootSessionId,
        branchId: targetBranchId,
        previousEventCount: strippedExisting.length,
        newEventCount: R,
        attachmentsRestored,
      };
    }
  }

  // Create brand-new deterministic zero-shift split-brain branch
  const attachmentsRestored = await restoreAttachments(resolvedHome, attachments, vault);
  const branchId = deterministicBranchId;
  const parentRemap = new Map([[rootSessionId, branchId]]);

  const { writtenIds: childWritten, childIdMap } = await syncSubagentChildren(childEntries, {
    ...childSyncCommonOpts,
    parentRemap,
    isForkedBranch: true,
    remoteDeviceId: commit.deviceId,
  });

  const branchHeader = {
    ...rewrittenRoot.header,
    id: branchId,
    parentSession: rootSessionId,
  };
  delete branchHeader.origin;

  let branchEvents = remapDeliveryAccepted(
    rewrittenRoot.events,
    rootSessionId,
    branchId,
    rootDecodedEntry.inheritedEventCount,
  );
  branchEvents = remapSubagentCatalogChildIds(branchEvents, childIdMap, rootDecodedEntry.inheritedEventCount);
  branchEvents = appendBranchTitleEvent(branchEvents, {
    remoteLabel,
    origSessionId: rootSessionId,
    commitTimestamp: commit.timestamp,
  });

  await writeSessionLogToDisk(resolvedHome, branchHeader, branchEvents);
  updateLocalMapRecord(branchHeader, branchEvents);
  await maybeRecordMigration(branchId, branchHeader.cwd);

  const touchedIds = [branchId, ...childWritten];
  await reconcileRegistries([{
    sessionId: branchId,
    cwd: branchHeader.cwd,
    header: branchHeader,
    events: branchEvents,
    inheritedEventCount: rootDecodedEntry.inheritedEventCount,
    pinToTop: true,
  }], touchedIds);

  return {
    status: 'forked-branch',
    sessionId: rootSessionId,
    sourceCwd: origRemoteCwd,
    targetCwd: branchHeader.cwd,
    branchId,
    writtenSessions: touchedIds,
    attachmentsRestored,
  };
}

function commitRootNodeMeta(commit) {
  const payload = commit?.payload ?? {};
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const rootId = payload.rootSessionId ?? commit?.targetId;
  return nodes.find((n) => n.sessionId === rootId) ?? nodes[0] ?? null;
}

function commitLastActiveAt(commit) {
  const payload = commit?.payload ?? {};
  if (typeof payload.lastActiveAt === 'number' && Number.isFinite(payload.lastActiveAt) && payload.lastActiveAt > 0) {
    return payload.lastActiveAt;
  }
  const rootNode = commitRootNodeMeta(commit);
  if (typeof rootNode?.lastActiveAt === 'number' && Number.isFinite(rootNode.lastActiveAt) && rootNode.lastActiveAt > 0) {
    return rootNode.lastActiveAt;
  }
  if (typeof rootNode?.header?.createdAt === 'number' && Number.isFinite(rootNode.header.createdAt) && rootNode.header.createdAt > 0) {
    return rootNode.header.createdAt;
  }
  return typeof commit?.timestamp === 'number' && Number.isFinite(commit.timestamp) ? commit.timestamp : 0;
}

function commitSourceCwd(commit) {
  const payload = commit?.payload ?? {};
  if (typeof payload.sourceCwd === 'string' && payload.sourceCwd.length > 0) {
    return payload.sourceCwd;
  }
  const rootNode = commitRootNodeMeta(commit);
  return typeof rootNode?.header?.cwd === 'string' ? rootNode.header.cwd : '';
}

/**
 * Pull remote session commits from VaultStore and reconcile them into local `<dshHome>`,
 * respecting `folderMatchMode`, `syncScope`, selection lists, overrides, and strict
 * `lastActiveAt` ascending pin order (so the newest conversation ALWAYS lands #1 in sidebar).
 */
export async function pullSessionsFromVault({
  dshHome,
  vault,
  workspaceMappings = [],
  targetPlatform = process.platform,
  fallbackRoot = undefined,
  cordisCtx = null,
  defaultWorkspaceDir = undefined,
  folderMatchMode = 'auto-mirror',
  autoMirrorRoot = undefined,
  autoMirrorAssignments = {},
  syncScope = 'active',
  selectedWorkspaces = [],
  selectedSessionIds = [],
  excludedSessionIds = [],
  withdrawnSessions = {},
  restoredSessions = {},
  sessionTargetOverrides = {},
  workspaceTargetOverrides = {},
  onlySessionIds = null,
  onlyWorkspaceSources = null,
  includeSelf = false,
  localMap: sharedLocalMap = null,
  maxSupportedFormatVersion = DEFAULT_MAX_FORMAT_VERSION,
}) {
  if (!vault) throw new TypeError('pullSessionsFromVault requires vault');

  const resolvedHome = resolveDshHome(dshHome);
  const { commits, pendingCount, hydrationPendingCount, decryptionFailedCount, decryptionFailedDevices } = await vault.listCommits('session', { includeSelf });

  // Keep only the latest commit per (deviceId, targetId) since each session commit is a complete closure snapshot
  const latestByDeviceTarget = new Map();
  for (const commit of commits) {
    const key = `${commit.deviceId}::${commit.targetId}`;
    latestByDeviceTarget.set(key, commit);
  }

  const explicitSessionSet = Array.isArray(onlySessionIds) ? new Set(onlySessionIds) : null;
  const explicitWorkspaceList = Array.isArray(onlyWorkspaceSources) ? onlyWorkspaceSources : null;
  const isExplicitSelection = Boolean(
    (explicitSessionSet && explicitSessionSet.size > 0)
    || (explicitWorkspaceList && explicitWorkspaceList.length > 0),
  );
  const excludedSessionSet = new Set(Array.isArray(excludedSessionIds) ? excludedSessionIds : []);
  const withdrawnMap = withdrawnSessions && typeof withdrawnSessions === 'object' ? withdrawnSessions : {};
  const restoredMap = restoredSessions && typeof restoredSessions === 'object' ? restoredSessions : {};

  const summary = {
    imported: 0,
    fastForwarded: 0,
    migrated: 0,
    forkedBranches: 0,
    upToDate: 0,
    pendingHydration: 0,
    deferredBusy: 0,
    versionMismatch: 0,
    skippedUnmapped: 0,
    skippedUnselected: 0,
  };

  const filteredCommits = [];
  for (const commit of latestByDeviceTarget.values()) {
    const sid = commit.payload?.rootSessionId ?? commit.targetId;
    const srcCwd = commitSourceCwd(commit);
    if (isExplicitSelection) {
      const hitSid = explicitSessionSet ? explicitSessionSet.has(sid) : false;
      const hitWs = explicitWorkspaceList
        ? matchesWorkspaceSelector(srcCwd, explicitWorkspaceList, workspaceMappings, targetPlatform)
        : false;
      if (!hitSid && !hitWs) {
        summary.skippedUnselected += 1;
        continue;
      }
      // C10: Whole-workspace pull (`onlyWorkspaceSources`) MUST respect local `excludedSessionIds`!
      // Only an explicit `onlySessionIds` hit overrides local exclusion.
      if (!hitSid && excludedSessionSet.has(sid)) {
        summary.skippedUnselected += 1;
        continue;
      }
      filteredCommits.push(commit);
      continue;
    }

    if (excludedSessionSet.has(sid)) {
      summary.skippedUnselected += 1;
      continue;
    }

    const withdrawnAt = Number(withdrawnMap[sid] ?? 0);
    const restoredAt = Number(restoredMap[sid] ?? 0);
    if (withdrawnAt > restoredAt && commitLastActiveAt(commit) <= withdrawnAt) {
      summary.skippedUnselected += 1;
      continue;
    }

    // NOTE (F6): `syncScope === 'selected'` filters OUTBOUND auto-push only;
    // inbound pull receives what peers intentionally published to the vault (respecting
    // `excludedSessionIds`, `withdrawnSessions`, and `folderMatchMode`).
    filteredCommits.push(commit);
  }

  // Sort OLDEST -> NEWEST by lastActiveAt so pinning each updated session to top leaves the newest #1!
  const effectiveCommits = filteredCommits.sort(
    (a, b) =>
      (commitLastActiveAt(a) - commitLastActiveAt(b))
      || (a.timestamp - b.timestamp)
      || (a.seq - b.seq)
      || String(a.deviceId).localeCompare(String(b.deviceId)),
  );

  // Single O(N) local scan shared across all incoming commits -> eliminates O(N x M) Zstd re-decoding!
  const localMap = sharedLocalMap ?? await scanLocalSessions(resolvedHome);
  const mirrorSlotMap = new Map();
  const workingMirrorAssignments = { ...(autoMirrorAssignments ?? {}) };
  for (const [src, dst] of Object.entries(workingMirrorAssignments)) {
    if (src && dst) {
      mirrorSlotMap.set(normalizeWorkspaceMatchKey(dst), normalizeWorkspaceMatchKey(src));
    }
  }
  const newAutoMirrorAssignments = {};

  const results = [];
  for (const commit of effectiveCommits) {
    const res = await importSessionCommit({
      dshHome: resolvedHome,
      vault,
      commit,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      cordisCtx,
      defaultWorkspaceDir,
      folderMatchMode,
      autoMirrorRoot,
      autoMirrorAssignments: workingMirrorAssignments,
      mirrorSlotMap,
      sessionTargetOverrides,
      workspaceTargetOverrides,
      localMap,
      maxSupportedFormatVersion,
    });
    results.push(res);

    if (res.allocatedMirrorAssignment?.sourceCwd && res.allocatedMirrorAssignment?.targetPath) {
      workingMirrorAssignments[res.allocatedMirrorAssignment.sourceCwd] = res.allocatedMirrorAssignment.targetPath;
      newAutoMirrorAssignments[res.allocatedMirrorAssignment.sourceCwd] = res.allocatedMirrorAssignment.targetPath;
    }

    switch (res.status) {
      case 'imported': summary.imported += 1; break;
      case 'fast-forwarded': summary.fastForwarded += 1; break;
      case 'migrated': summary.migrated += 1; break;
      case 'forked-branch': summary.forkedBranches += 1; break;
      case 'up-to-date': summary.upToDate += 1; break;
      case 'pending-hydration': summary.pendingHydration += 1; break;
      case 'deferred-busy': summary.deferredBusy += 1; break;
      case 'version-mismatch': summary.versionMismatch += 1; break;
      case 'unmapped-skipped': summary.skippedUnmapped += 1; break;
      default: break;
    }
  }

  return {
    results,
    pendingCount,
    hydrationPendingCount: hydrationPendingCount ?? pendingCount,
    decryptionFailedCount: decryptionFailedCount ?? 0,
    decryptionFailedDevices: decryptionFailedDevices ?? {},
    newAutoMirrorAssignments,
    summary,
  };
}

function makeShortId(sessionId) {
  const s = String(sessionId ?? '');
  if (s.length <= 10) return s;
  return s.slice(0, 8);
}

async function countOutputsFilesQuick(wsPath) {
  if (!wsPath) return 0;
  const outputsDir = path.join(wsPath, 'outputs');
  let count = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIPPED_OUTPUT_NAME_RE.test(e.name) || SENSITIVE_OUTPUT_NAME_RE.test(e.name) || CONFLICT_OUTPUT_NAME_RE.test(e.name)) continue;
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '.work') continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        count += 1;
      }
    }
  }
  await walk(outputsDir);
  return count;
}

async function readRegisteredLocalWorkspaces(dshHome, cordisCtx) {
  const out = [];
  if (typeof cordisCtx?.workspaceRegistry?.list === 'function') {
    for (const ws of cordisCtx.workspaceRegistry.list() ?? []) {
      if (ws?.path && typeof ws.path === 'string') {
        out.push({ path: ws.path, title: ws.title || '' });
      }
    }
    return out;
  }
  try {
    const wsJson = JSON.parse(await fs.readFile(path.join(resolveDshHome(dshHome), 'storages', 'workspace.json'), 'utf8'));
    const workspaces = wsJson?.tables?.workspaces ?? {};
    const ids = Array.isArray(wsJson?.global?.workspaceIds) ? wsJson.global.workspaceIds : Object.keys(workspaces);
    for (const id of ids) {
      const rec = workspaces[id];
      if (rec?.path && typeof rec.path === 'string') {
        out.push({ path: rec.path, title: rec.title || '' });
      }
    }
  } catch {
    // workspace.json absent
  }
  return out;
}

/**
 * Inspect local workspaces & non-empty sessions (filtering 0-turn blank shells) for UI, `/soul list`, and CLI.
 */
export async function listLocalCatalog({
  dshHome,
  config = {},
  platform = process.platform,
  cordisCtx = null,
  localMap: sharedLocalMap = null,
  vaultSessionIds = null,
}) {
  const resolvedHome = resolveDshHome(dshHome);
  const localMap = sharedLocalMap ?? await scanLocalSessions(resolvedHome);
  const mappings = Array.isArray(config.workspaceMappings) ? config.workspaceMappings : [];
  const selectedWorkspaces = Array.isArray(config.selectedWorkspaces) ? config.selectedWorkspaces : [];
  const selectedSessionSet = new Set(Array.isArray(config.selectedSessionIds) ? config.selectedSessionIds : []);
  const excludedSessionSet = new Set(Array.isArray(config.excludedSessionIds) ? config.excludedSessionIds : []);
  const inVaultSet = vaultSessionIds instanceof Set
    ? vaultSessionIds
    : Array.isArray(vaultSessionIds)
      ? new Set(vaultSessionIds)
      : null;

  const catalogChildIds = new Set();
  for (const rec of localMap.values()) {
    for (const cid of extractCatalogChildIds(rec.events)) {
      catalogChildIds.add(cid);
    }
  }

  let filteredEmptyCount = 0;
  const groups = new Map();

  const ensureGroup = (rawPath, explicitTitle = '') => {
    const cleanPath = rawPath ? String(rawPath).normalize('NFC') : '';
    const key = normalizeWorkspaceMatchKey(cleanPath) || '_no-cwd';
    if (!groups.has(key)) {
      const isVaultWorkspace = Boolean(cleanPath && config.vaultDir && isVaultPath(cleanPath, [config.vaultDir]));
      const isBroadSystemDir = Boolean(
        cleanPath
        && !isVaultWorkspace
        && isBroadWorkspaceDirectory(cleanPath, platform, { dshHome: resolvedHome, vaultDir: config.vaultDir }),
      );
      const mapped = cleanPath && !isVaultWorkspace
        ? mapPathAcrossOs(cleanPath, mappings, platform)
        : { workspaceId: null, matched: false };
      const mapping = mapped.workspaceId ? mappings.find((m) => m.id === mapped.workspaceId) : null;
      const peerOs = platform === 'win32' ? 'darwin' : 'win32';
      const title = mapping?.title || explicitTitle || (cleanPath ? basenameForPlatform(cleanPath, platform) : '未指定目录');
      groups.set(key, {
        workspaceKey: key,
        path: cleanPath,
        title,
        isVaultDir: isVaultWorkspace,
        isBroadSystemDir,
        mappingId: mapping?.id ?? null,
        mappedPeerPath: mapping?.[peerOs] ?? null,
        sessionCount: 0,
        deliverableCount: 0,
        selected: !isVaultWorkspace && matchesWorkspaceSelector(cleanPath, selectedWorkspaces, mappings, platform),
        lastActiveAt: 0,
        sessions: [],
      });
    }
    return groups.get(key);
  };

  // Seed with registered local workspaces (so empty workspaces still appear as mapping targets)
  const registered = await readRegisteredLocalWorkspaces(resolvedHome, cordisCtx);
  for (const ws of registered) {
    if (isUnmappedWorkspacePath(ws.path, resolvedHome)) continue;
    if (config.vaultDir && isVaultPath(ws.path, [config.vaultDir])) continue;
    ensureGroup(ws.path, ws.title);
  }

  for (const rec of localMap.values()) {
    if (rec.header?.origin === 'subagent') continue;
    if (catalogChildIds.has(rec.sessionId)) continue;
    if (
      rec.header?.parentSession
      && localMap.has(rec.header.parentSession)
      && !isSplitBrainVisibleBranch(rec.header)
    ) {
      continue;
    }

    if (!isSubstantiveSession(rec.events, rec.header)) {
      filteredEmptyCount += 1;
      continue;
    }

    const cwd = rec.header?.cwd || '';
    const group = ensureGroup(cwd);
    const lastActiveAt = extractLastActiveAt(rec.events, rec.header);
    const title = extractSessionTitle(rec.events, rec.sessionId);
    const turnCount = countUserTurns(rec.events);
    const isInstallSession = isInstallWizardSession(rec.events);

    group.sessions.push({
      sessionId: rec.sessionId,
      shortId: makeShortId(rec.sessionId),
      title,
      turnCount,
      eventCount: rec.events.length,
      lastActiveAt,
      selected: selectedSessionSet.has(rec.sessionId),
      excluded: excludedSessionSet.has(rec.sessionId),
      isInstallSession,
      inVault: inVaultSet ? inVaultSet.has(rec.sessionId) : false,
    });
    if (lastActiveAt > group.lastActiveAt) {
      group.lastActiveAt = lastActiveAt;
    }
  }

  const workspaces = [];
  let totalSessions = 0;

  for (const group of groups.values()) {
    group.sessions.sort((a, b) => (b.lastActiveAt - a.lastActiveAt) || a.sessionId.localeCompare(b.sessionId));
    group.sessionCount = group.sessions.length;
    totalSessions += group.sessionCount;

    if (group.mappingId) {
      try {
        const wsStatePath = path.join(soulSyncDir(resolvedHome), 'workspaces', `${encodeURIComponent(group.mappingId)}.json`);
        const parsed = JSON.parse(await fs.readFile(wsStatePath, 'utf8'));
        group.deliverableCount = Object.keys(parsed?.trackedPaths ?? {}).length;
      } catch {
        group.deliverableCount = await countOutputsFilesQuick(group.path);
      }
    } else if (group.path && platform === process.platform) {
      group.deliverableCount = await countOutputsFilesQuick(group.path);
    }

    workspaces.push(group);
  }

  workspaces.sort((a, b) => (b.lastActiveAt - a.lastActiveAt) || (b.sessionCount - a.sessionCount) || a.title.localeCompare(b.title));

  return {
    workspaces,
    totalSessions,
    filteredEmptyCount,
  };
}

/**
 * Preview remote workspaces & sessions available in the Vault WITHOUT writing to disk
 * or creating directories (`dryRun: true`). Reads commit metadata directly (with fallback
 * for legacy commits that predate title/lastActiveAt fields).
 */
export async function listVaultCatalog({
  dshHome,
  vault,
  config = {},
  targetPlatform = process.platform,
  cordisCtx = null,
  autoMirrorRoot = undefined,
  defaultWorkspaceDir = undefined,
  includeSelf = false,
  localMap: sharedLocalMap = null,
}) {
  if (!vault) {
    return {
      workspaces: [],
      totalSessions: 0,
      pendingCount: 0,
      hydrationPendingCount: 0,
      decryptionFailedCount: 0,
      decryptionFailedDevices: {},
    };
  }

  const resolvedHome = resolveDshHome(dshHome);
  const { commits, pendingCount, hydrationPendingCount, decryptionFailedCount, decryptionFailedDevices } = await vault.listCommits('session', { includeSelf });
  const localMap = sharedLocalMap ?? await scanLocalSessions(resolvedHome);
  const mappings = Array.isArray(config.workspaceMappings) ? config.workspaceMappings : [];
  const folderMatchMode = config.folderMatchMode === 'mapped-only' ? 'mapped-only' : 'auto-mirror';
  const effectiveAutoMirrorRoot = autoMirrorRoot || config.autoMirrorRoot || undefined;
  const sessionTargetOverrides = config.sessionTargetOverrides ?? {};
  const workspaceTargetOverrides = config.workspaceTargetOverrides ?? {};
  const autoMirrorAssignments = config.autoMirrorAssignments ?? {};
  const excludedSessionSet = new Set(Array.isArray(config.excludedSessionIds) ? config.excludedSessionIds : []);
  const mirrorSlotMap = new Map();
  for (const [src, dst] of Object.entries(autoMirrorAssignments)) {
    if (src && dst) {
      mirrorSlotMap.set(normalizeWorkspaceMatchKey(dst), normalizeWorkspaceMatchKey(src));
    }
  }

  // Keep latest commit per rootSessionId (preferring higher lastActiveAt / eventCount / timestamp)
  const latestBySession = new Map();
  for (const commit of commits) {
    const sid = commit.payload?.rootSessionId ?? commit.targetId;
    const prev = latestBySession.get(sid);
    if (!prev) {
      latestBySession.set(sid, commit);
      continue;
    }
    const prevTs = commitLastActiveAt(prev);
    const curTs = commitLastActiveAt(commit);
    const prevCount = commitRootNodeMeta(prev)?.eventCount ?? 0;
    const curCount = commitRootNodeMeta(commit)?.eventCount ?? 0;
    if (curTs > prevTs || (curTs === prevTs && (curCount > prevCount || commit.timestamp >= prev.timestamp))) {
      latestBySession.set(sid, commit);
    }
  }

  const groups = new Map();
  let totalSessions = 0;

  for (const [sid, commit] of latestBySession.entries()) {
    const payload = commit.payload ?? {};
    const rootNode = commitRootNodeMeta(commit);
    if (!rootNode) continue;

    let title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : typeof rootNode.title === 'string' && rootNode.title.trim()
        ? rootNode.title.trim()
        : '';
    let lastActiveAt = commitLastActiveAt(commit);
    let turnCount = typeof payload.turnCount === 'number'
      ? payload.turnCount
      : typeof rootNode.turnCount === 'number'
        ? rootNode.turnCount
        : null;

    // Legacy commit fallback: decode root blob only if metadata fields are missing and blob is hydrated
    if (!title && rootNode.logBlob) {
      try {
        const ready = await vault.verifyCommitBlobs([rootNode.logBlob]);
        if (ready.ready) {
          const raw = await vault.getBlob(rootNode.logBlob.storageKey, rootNode.logBlob.sha256, rootNode.logBlob.size);
          const decoded = await decodeV4SessionLog(raw);
          title = extractSessionTitle(decoded.events, sid);
          lastActiveAt = extractLastActiveAt(decoded.events, decoded.header) || lastActiveAt;
          turnCount = countUserTurns(decoded.events);
        }
      } catch {
        // Fallback to sessionId when legacy blob is pending hydration
      }
    }
    if (!title) title = sid;

    const sourceCwd = commitSourceCwd(commit);
    const fromPlatform = commit.platform || (isWin32Absolute(sourceCwd) ? 'win32' : 'darwin');
    const fromDeviceLabel = payload.deviceLabel || commit.deviceId;
    const sourceTitle = typeof payload.sourceWorkspaceTitle === 'string' && payload.sourceWorkspaceTitle.trim()
      ? payload.sourceWorkspaceTitle.trim()
      : sourceCwd
        ? findWorkspaceTitleForCwd(sourceCwd, mappings, fromPlatform)
        : 'workspace';

    const localRoot = localMap.get(sid) ?? null;
    const targetRes = await resolveTargetSessionCwd({
      sessionId: sid,
      sourceCwd,
      sourcePlatform: fromPlatform,
      localRoot,
      workspaceMappings: mappings,
      targetPlatform,
      fallbackRoot: config.fallbackDir || undefined,
      dshHome: resolvedHome,
      cordisCtx,
      vaultDir: vault.vaultDir,
      remoteVaultDir: typeof payload.sourceVaultDir === 'string' ? payload.sourceVaultDir : undefined,
      defaultWorkspaceDir,
      folderMatchMode,
      autoMirrorRoot: effectiveAutoMirrorRoot,
      autoMirrorAssignments,
      mirrorSlotMap,
      sessionTargetOverrides,
      workspaceTargetOverrides,
      dryRun: true,
    });

    let targetMatchKind = 'auto-create';
    if (targetRes.skipped) {
      targetMatchKind = 'unmapped-skipped';
    } else if (targetRes.matchedBy === 'mapping' || targetRes.matchedBy === 'override' || targetRes.matchedBy === 'local-existing') {
      targetMatchKind = targetRes.workspaceId || targetRes.matchedBy === 'override' ? 'mapped' : 'same-name';
    } else if (targetRes.matchedBy === 'basename') {
      targetMatchKind = 'same-name';
    } else {
      targetMatchKind = 'auto-create';
    }

    // Determine local sync status without decoding full Zstd log
    // (compares both mapping-normalized and session-relative hash chains to avoid false "diverged"
    // when two machines used different mapping IDs for the same folder!)
    let localStatus = 'new';
    const remoteCount = typeof rootNode.eventCount === 'number' ? rootNode.eventCount : 0;
    const remoteHead = typeof rootNode.headChainHash === 'string' ? rootNode.headChainHash : '';
    const remoteChain = Array.isArray(rootNode.chainHashes) ? rootNode.chainHashes : [];
    const remoteRelHead = typeof rootNode.sessionRelativeHeadHash === 'string' ? rootNode.sessionRelativeHeadHash : '';
    const remoteRelChain = Array.isArray(rootNode.sessionRelativeChainHashes) ? rootNode.sessionRelativeChainHashes : [];

    if (localRoot) {
      const localChain = computeEventHashChain(localRoot.events, mappings, localRoot.header?.cwd || '');
      const localRelChain = computeEventHashChain(localRoot.events, [], localRoot.header?.cwd || '');
      const L = localRoot.events.length;
      const headMatches = (remoteHead && localChain.headHash === remoteHead)
        || (remoteRelHead && localRelChain.headHash === remoteRelHead);
      const olderPrefixMatches = remoteCount < L && (
        remoteCount === 0
        || (remoteHead && localChain.chainHashes[remoteCount - 1] === remoteHead)
        || (remoteRelHead && localRelChain.chainHashes[remoteCount - 1] === remoteRelHead)
      );
      const behindMatches = remoteCount > L && (
        L === 0
        || (remoteChain[L - 1] && remoteChain[L - 1] === localChain.headHash)
        || (remoteRelChain[L - 1] && remoteRelChain[L - 1] === localRelChain.headHash)
      );

      if (L === remoteCount && headMatches) {
        localStatus = 'up-to-date';
      } else if (olderPrefixMatches) {
        localStatus = 'up-to-date';
      } else if (behindMatches) {
        localStatus = 'behind';
      } else {
        localStatus = 'diverged';
      }
    }

    const sourceKey = `${commit.deviceId}::${normalizeWorkspaceMatchKey(sourceCwd) || '_no-cwd'}`;
    if (!groups.has(sourceKey)) {
      const mapped = sourceCwd ? mapPathAcrossOs(sourceCwd, mappings, targetPlatform) : { workspaceId: null };
      groups.set(sourceKey, {
        sourceKey,
        sourceCwd,
        sourceTitle,
        fromDeviceId: commit.deviceId,
        fromDeviceLabel,
        fromPlatform,
        mappingId: mapped.workspaceId ?? null,
        targetPreviewPath: targetRes.path ?? null,
        targetMatchKind,
        lastActiveAt: 0,
        sessionCount: 0,
        sessions: [],
      });
    }

    const group = groups.get(sourceKey);
    if (targetMatchKind === 'unmapped-skipped' && !group.mappingId) {
      group.targetMatchKind = 'unmapped-skipped';
    }
    group.sessions.push({
      sessionId: sid,
      shortId: makeShortId(sid),
      title,
      turnCount: turnCount ?? Math.max(1, Math.floor(remoteCount / 2)),
      eventCount: remoteCount,
      lastActiveAt,
      localStatus,
      excluded: excludedSessionSet.has(sid),
      fromDeviceId: commit.deviceId,
      fromDeviceLabel,
      fromPlatform,
      sourceCwd,
      targetPreviewPath: targetRes.path ?? null,
      targetMatchKind,
    });
    if (lastActiveAt > group.lastActiveAt) {
      group.lastActiveAt = lastActiveAt;
    }
    totalSessions += 1;
  }

  const workspaces = [];
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => (b.lastActiveAt - a.lastActiveAt) || a.sessionId.localeCompare(b.sessionId));
    group.sessionCount = group.sessions.length;
    workspaces.push(group);
  }

  workspaces.sort((a, b) => (b.lastActiveAt - a.lastActiveAt) || a.sourceTitle.localeCompare(b.sourceTitle));

  return {
    workspaces,
    totalSessions,
    pendingCount,
    hydrationPendingCount: hydrationPendingCount ?? pendingCount,
    decryptionFailedCount: decryptionFailedCount ?? 0,
    decryptionFailedDevices: decryptionFailedDevices ?? {},
  };
}
