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
const SKIPPED_OUTPUT_NAME_RE = /^(?:~\$|\.DS_Store$|Thumbs\.db$|desktop\.ini$)|\.(?:tmp|temp|part|crdownload|swp|swo)$/i;

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

/**
 * Count real user message turns in a session event log.
 */
export function countUserTurns(events = []) {
  if (!Array.isArray(events)) return 0;
  let turns = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'user/message') {
      const sourceKind = ev.data?.source?.kind ?? ev.data?.message?.source?.kind;
      if (sourceKind === 'compact-checkpoint') {
        turns += 1;
        continue;
      }
      if (extractTextFromUserEvent(ev).length > 0) {
        turns += 1;
      }
    }
  }
  return turns;
}

/**
 * Determine whether a session has real substantive content (vs a 0-turn blank shell window).
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
 *  2) First real `user/message` text (up to 48 chars)
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
    for (const ev of events) {
      if (ev?.type === 'user/message') {
        const text = extractTextFromUserEvent(ev);
        if (text) return text.slice(0, 48);
      }
    }
  }
  return fallbackId;
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

/**
 * Determine whether a local session should be automatically synced according to config
 * (`folderMatchMode`, `syncScope`, `selectedWorkspaces`, `selectedSessionIds`, `excludedSessionIds`).
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

  if (!explicitlySelected && !isSubstantiveSession(events, header)) {
    return { allowed: false, reason: 'empty-shell' };
  }

  const cwd = header?.cwd || '';
  const mappings = Array.isArray(config.workspaceMappings) ? config.workspaceMappings : [];
  const folderMatchMode = config.folderMatchMode === 'mapped-only' ? 'mapped-only' : 'auto-mirror';

  if (folderMatchMode === 'mapped-only' && !explicitlySelected) {
    const mapped = cwd ? mapPathAcrossOs(cwd, mappings, platform) : { matched: false };
    const hasOverride = Boolean(
      (sessionId && config.sessionTargetOverrides && Object.hasOwn(config.sessionTargetOverrides, sessionId))
      || (cwd && lookupPathOverride(config.workspaceTargetOverrides, cwd)),
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

function normalizeEventForHash(event, workspaceMappings, sessionRootCwd = '') {
  if (!event || typeof event !== 'object') return event;
  if (event.type === 'working-directory/change' && typeof event.data?.cwd === 'string') {
    return {
      ...event,
      data: {
        ...event.data,
        cwd: normalizeLogicalPath(event.data.cwd, workspaceMappings, sessionRootCwd),
      },
    };
  }
  if (event.type === 'deliverables/presented' && Array.isArray(event.data?.files)) {
    return {
      ...event,
      data: {
        ...event.data,
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
  return event;
}

/**
 * Compute an incremental SHA-256 hash chain over session events after normalizing
 * OS-rewritable paths (`working-directory/change` and `deliverables/presented`).
 *
 * @param {Array<Record<string, any>>} events
 * @param {Array<Record<string, any>>} [workspaceMappings]
 * @param {string} [sessionRootCwd]
 * @returns {{ headHash: string, chainHashes: string[] }}
 */
export function computeEventHashChain(events = [], workspaceMappings = [], sessionRootCwd = '') {
  const chainHashes = [];
  let prev = GENESIS_CHAIN_HASH;
  for (const ev of events) {
    const normalized = normalizeEventForHash(ev, workspaceMappings, sessionRootCwd);
    prev = sha256Hex(`${prev}\n${JSON.stringify(normalized)}`);
    chainHashes.push(prev);
  }
  return {
    headHash: prev,
    chainHashes,
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

/**
 * Scan `<dshHome>/sessions/<projKey>/<encodeSegment(sessionId)>/` for all local sessions.
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

      let decoded;
      try {
        const raw = await fs.readFile(best.logPath);
        decoded = await decodeV4SessionLog(raw);
      } catch {
        continue;
      }

      const id = decoded.header?.id;
      if (typeof id !== 'string' || id.length === 0) continue;

      const existing = map.get(id);
      const record = {
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
 * `compaction/end` or later `session/end-seed`, returns `true`.
 *
 * @param {Array<Record<string, any>>} events
 * @returns {boolean}
 */
export function hasUnclosedCompaction(events = []) {
  if (!Array.isArray(events) || events.length === 0) return false;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const type = events[i]?.type;
    if (type === 'compaction/end' || type === 'session/end-seed') {
      return false;
    }
    if (type === 'compaction/start') {
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

async function packUnmappedSessionOutputs({ sessionCwd, workspaceMappings = [], vault }) {
  if (!sessionCwd || typeof sessionCwd !== 'string' || !vault) return [];
  // Only pack lightweight outputs/ when sessionCwd is NOT mapped to a managed workspace and is NOT the vault itself
  const mapped = mapPathAcrossOs(sessionCwd, workspaceMappings, process.platform);
  if (mapped.matched) return [];
  if (isVaultPath(sessionCwd, [vault.vaultDir])) return [];

  const outputsRoot = path.join(sessionCwd, 'outputs');
  if (!(await isExistingLocalDir(outputsRoot))) return [];

  const packed = [];
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
      if (SKIPPED_OUTPUT_NAME_RE.test(name) || SENSITIVE_OUTPUT_NAME_RE.test(name)) {
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

      const relPosix = relPrefix ? `${relPrefix}/${name}` : name;
      if (lst.isDirectory()) {
        if (name === '.git' || name === 'node_modules' || name === '.work' || name === '.dsh-incoming') {
          continue;
        }
        await walk(fullPath, relPosix);
        continue;
      }

      if (!lst.isFile()) continue;
      if ((lst.nlink ?? 1) > 1) continue; // Skip hard links
      if (lst.size > UNMAPPED_OUTPUT_MAX_FILE_BYTES) continue;
      if (totalBytes + lst.size > UNMAPPED_OUTPUT_MAX_TOTAL_BYTES) continue;

      let bytes;
      try {
        bytes = await fs.readFile(fullPath);
      } catch {
        continue;
      }
      if (bytes.length > UNMAPPED_OUTPUT_MAX_FILE_BYTES) continue;
      if (totalBytes + bytes.length > UNMAPPED_OUTPUT_MAX_TOTAL_BYTES) continue;

      // Scan small text files for leaked API keys / private keys
      if (bytes.length <= UNMAPPED_OUTPUT_TEXT_SCAN_LIMIT && !bytes.includes(0x00)) {
        const textSample = bytes.toString('utf8');
        if (SENSITIVE_OUTPUT_CONTENT_RE.test(textSample)) {
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
  return packed;
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

function buildOutputConflictPath(targetPath, remoteLabel) {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const stem = path.basename(targetPath, ext);
  const safeLabel = String(remoteLabel || 'remote')
    .replace(/[<>:"/\\|?*\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'remote';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(dir, `${stem}.conflict-${safeLabel}-${ts}${ext}`);
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
  const sessState = state[sessionId] && typeof state[sessionId] === 'object' ? { ...state[sessionId] } : {};
  const outputsRoot = path.join(targetCwd, 'outputs');
  let restored = 0;
  const conflicts = [];
  let stateChanged = false;

  for (const item of packedOutputs) {
    if (!item || !isSafeRelativePosixPath(item.relPosixPath)) continue;
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
      continue;
    }

    const lastSyncedSha = sessState[item.relPosixPath] ?? null;
    const remoteIsNewer = typeof item.mtimeMs === 'number' && localStat && item.mtimeMs > localStat.mtimeMs + 1000;

    // Safe overwrite if local has NOT been modified since last sync (or remote is newer and no conflicting edit tracked)
    if (lastSyncedSha === localSha || (!lastSyncedSha && remoteIsNewer)) {
      await writeFileAtomic(targetPath, bytes, { mode: 0o644 });
      if (typeof item.mtimeMs === 'number' && Number.isFinite(item.mtimeMs)) {
        const t = new Date(item.mtimeMs);
        await fs.utimes(targetPath, t, t).catch(() => {});
      }
      sessState[item.relPosixPath] = remoteSha;
      stateChanged = true;
      restored += 1;
    } else {
      // Non-destructive conflict copy alongside local file (NEVER overwrite user's newer local edits)
      const conflictPath = buildOutputConflictPath(targetPath, remoteLabel);
      await writeFileAtomic(conflictPath, bytes, { mode: 0o644 });
      conflicts.push({ path: `outputs/${item.relPosixPath}`, conflictPath });
      restored += 1;
    }
  }

  if (stateChanged) {
    state[sessionId] = sessState;
    await saveSessionOutputsState(dshHome, state);
  }
  return { restored, conflicts };
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
      deferred: true,
      reason: 'unclosed-compaction',
      deferredCompactionSessions,
      commit: null,
      nodeCount: 0,
      attachmentCount: 0,
    };
  }

  const nodes = [];
  const allEvents = [];

  for (const rec of orderedRecords) {
    const normalizedHeader = toPhysicalV4HeaderLine(rec.header);
    const cleanBytes = await encodeV4SessionLog(normalizedHeader, rec.events);
    const logBlob = await vault.putBlob(cleanBytes);
    const { headHash, chainHashes } = computeEventHashChain(
      rec.events,
      workspaceMappings,
      normalizedHeader?.cwd || '',
    );
    allEvents.push(...rec.events);

    nodes.push({
      sessionId: rec.sessionId,
      header: normalizedHeader,
      title: extractSessionTitle(rec.events, rec.sessionId),
      lastActiveAt: extractLastActiveAt(rec.events, normalizedHeader),
      turnCount: countUserTurns(rec.events),
      eventCount: rec.events.length,
      inheritedEventCount: rec.inheritedEventCount,
      headChainHash: headHash,
      chainHashes,
      logBlob,
    });
  }

  const attachments = await packAttachmentsForEvents(resolvedHome, allEvents, vault);
  const packedOutputs = await packUnmappedSessionOutputs({
    sessionCwd: rootRecord.header?.cwd || '',
    workspaceMappings,
    vault,
  });
  const modelTriple = extractModelTriple(rootRecord.events);
  const rootCwd = rootRecord.header?.cwd || '';
  const rootPlatform = vault.platform || process.platform;
  const rootTitle = extractSessionTitle(rootRecord.events, rootId);
  const rootLastActiveAt = extractLastActiveAt(rootRecord.events, rootRecord.header);
  const rootTurnCount = countUserTurns(rootRecord.events);
  const sourceWorkspaceTitle = rootCwd
    ? findWorkspaceTitleForCwd(rootCwd, workspaceMappings, rootPlatform)
    : 'workspace';

  const payload = {
    schemaVersion: 1,
    dshFormatVersion: rootRecord.header.version ?? 4,
    rootSessionId: rootId,
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
    title: rootTitle,
    lastActiveAt: rootLastActiveAt,
    deferred: false,
    deferredCompactionSessions: [],
    commit,
    nodeCount: nodes.length,
    attachmentCount: attachments.length,
    packedOutputCount: packedOutputs.length,
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
  sessionTargetOverrides = {},
  workspaceTargetOverrides = {},
  maxAutoSessionsPerWorkspace = 25,
  skipEmptySessions = true,
  platform = process.platform,
  onlySessionIds = null,
  onlyWorkspacePaths = null,
}) {
  const resolvedHome = resolveDshHome(dshHome);
  const localMap = await scanLocalSessions(resolvedHome);

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
    for (const rec of allRoots) {
      const hitSession = explicitSessionSet ? explicitSessionSet.has(rec.sessionId) : false;
      const hitWorkspace = explicitWorkspaceList
        ? matchesWorkspaceSelector(rec.header?.cwd || '', explicitWorkspaceList, workspaceMappings, platform)
        : false;
      if (!hitSession && !hitWorkspace) {
        skippedUnselectedCount += 1;
        continue;
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
  const deferredCompactionSessions = [];
  for (const root of filteredRoots) {
    const res = await exportSessionClosure({
      dshHome: resolvedHome,
      vault,
      sessionId: root.sessionId,
      workspaceMappings,
      deviceLabel,
      allLocalSessions: localMap,
    });
    if (res.deferred && res.reason === 'unclosed-compaction') {
      deferredCompactionSessions.push(...(res.deferredCompactionSessions ?? [root.sessionId]));
      continue;
    }
    exported.push(res);
  }

  return {
    exported,
    deferredCompactionSessions,
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
  sessionTargetOverrides = {},
  workspaceTargetOverrides = {},
  dryRun = false,
}) {
  const vaultDirs = [vaultDir, remoteVaultDir].filter((v) => typeof v === 'string' && v.trim().length > 0);
  const explicitFallbackRoot = typeof fallbackRoot === 'string' && fallbackRoot.trim().length > 0;
  const sourceWasVault = Boolean(sourceCwd && isVaultPath(sourceCwd, vaultDirs));
  const mode = folderMatchMode === 'mapped-only' ? 'mapped-only' : 'auto-mirror';

  const canonicalizeIfLocal = async (p, ensureDir = false) => {
    let formatted = formatPathForPlatform(p, targetPlatform);
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
  const localHasEvents = Array.isArray(localRoot?.events) && localRoot.events.length > 0;

  // Priority 0: Explicit per-session or per-workspace target directory override (always honored, even in mapped-only)
  const explicitOverride =
    (sessionId && typeof sessionTargetOverrides?.[sessionId] === 'string' && sessionTargetOverrides[sessionId].trim()
      ? sessionTargetOverrides[sessionId].trim().normalize('NFC')
      : null)
    ?? lookupPathOverride(workspaceTargetOverrides, sourceCwd);

  if (explicitOverride && !isVaultPath(explicitOverride, vaultDirs)) {
    const mappedOvr = mapPathAcrossOs(explicitOverride, workspaceMappings, targetPlatform);
    return {
      path: await canonicalizeIfLocal(explicitOverride, true),
      workspaceId: mappedOvr.workspaceId,
      matchedBy: 'override',
      migratedFromUnmapped: localIsOrphan,
      oldUnmappedCwd: localIsOrphan ? localCwd : null,
      usedFallback: false,
      skipped: false,
    };
  }

  // Priority A: Preserve healthy existing local cwd; detect stranded unmapped/vault orphan for migration
  if (localCwd && !localIsOrphan && isAbsoluteForPlatform(localCwd, targetPlatform)) {
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
  if (!sourceWasVault && sourceCwd) {
    const mapped = mapPathAcrossOs(sourceCwd, workspaceMappings, targetPlatform);
    if (mapped.matched && !isVaultPath(mapped.mappedPath, vaultDirs)) {
      return {
        path: await canonicalizeIfLocal(mapped.mappedPath, false),
        workspaceId: mapped.workspaceId,
        matchedBy: 'mapping',
        migratedFromUnmapped: localIsOrphan,
        oldUnmappedCwd: localIsOrphan ? localCwd : null,
        usedFallback: false,
        skipped: false,
      };
    }
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
  const srcPlat = sourcePlatform || (isWin32Absolute(sourceCwd) ? 'win32' : 'darwin');
  const srcBaseRaw = sourceCwd ? basenameForPlatform(sourceCwd, srcPlat).normalize('NFC') : '';
  const srcBaseLower = srcBaseRaw.toLowerCase();

  if (
    !explicitFallbackRoot
    && sourceCwd
    && typeof cordisCtx?.workspaceRegistry?.list === 'function'
  ) {
    const registered = cordisCtx.workspaceRegistry.list() ?? [];
    for (const ws of registered) {
      if (!ws?.path || typeof ws.path !== 'string') continue;
      if (isVaultPath(ws.path, vaultDirs) || isUnmappedWorkspacePath(ws.path, dshHome)) continue;
      const wsBase = basenameForPlatform(ws.path, targetPlatform).normalize('NFC').toLowerCase();
      if (wsBase === srcBaseLower && (dryRun || (await dirExistsIfLocal(ws.path)))) {
        return {
          path: await canonicalizeIfLocal(ws.path, false),
          workspaceId: null,
          matchedBy: 'basename',
          migratedFromUnmapped: localIsOrphan,
          oldUnmappedCwd: localIsOrphan ? localCwd : null,
          usedFallback: false,
          skipped: false,
        };
      }
    }
  }

  // Priority D: Auto-mirror into independent named workspace <autoMirrorRoot>/<sourceWorkspaceName>
  // (or local default-workspace ONLY if the source itself was named `default-workspace` or empty)
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

    const mirrorBase = resolveAutoMirrorBaseDir({
      autoMirrorRoot,
      targetPlatform,
      cordisCtx,
      defaultWorkspaceDir,
      vaultDirs,
      dshHome,
    });
    const folderName = sanitizeMirrorFolderName(srcBaseRaw || 'workspace');
    const mirrorPath = joinFormattedPath(mirrorBase, folderName, targetPlatform);
    if (!isVaultPath(mirrorPath, vaultDirs)) {
      return {
        path: await canonicalizeIfLocal(mirrorPath, true),
        workspaceId: null,
        matchedBy: 'auto-mirror',
        migratedFromUnmapped: localIsOrphan,
        oldUnmappedCwd: localIsOrphan ? localCwd : null,
        usedFallback: false,
        skipped: false,
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
    if (mapped.matched) {
      let targetPath = formatPathForPlatform(mapped.mappedPath, targetPlatform);
      if (targetPlatform === process.platform) {
        targetPath = await canonicalizeLocalPath(targetPath);
      }
      return targetPath;
    }
    if (sourceRootCwd && newHeader.cwd) {
      const rel = extractRelativeUnderRoot(rawPath, sourceRootCwd);
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

async function reconcileOfflineWorkspaceAndCache(dshHome, visibleEntries, allTouchedIds, { workspaceMappings, targetPlatform }) {
  const home = resolveDshHome(dshHome);
  const wsPath = path.join(home, 'storages', 'workspace.json');

  // 1. Delete stale session_projcache files for every touched session (with path-traversal guard)
  await invalidateSessionProjCache(home, allTouchedIds);

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

    // If migrated from an old unmapped workspace, detach from any registered workspace matching oldUnmappedCwd
    if (entry.oldUnmappedCwd && typeof wsReg?.list === 'function') {
      for (const existingWs of wsReg.list() ?? []) {
        if (existingWs?.path && sameWorkspacePath(existingWs.path, entry.oldUnmappedCwd, targetPlatform)) {
          await existingWs.detachSession?.(entry.sessionId).catch(() => {});
        }
      }
    }

    if (targetPlatform === process.platform && path.isAbsolute(entry.cwd)) {
      await fs.mkdir(entry.cwd, { recursive: true }).catch(() => {});
    }
    const title = entry.title || findWorkspaceTitleForCwd(entry.cwd, workspaceMappings, targetPlatform);
    const ws = await wsReg?.create?.(entry.cwd, title);
    if (ws && typeof ws.attachSession === 'function') {
      await ws.attachSession(entry.sessionId);
      // Pin imported / fast-forwarded / migrated relay session to the top of the sidebar list
      if (entry.pinToTop && typeof ws.insertSessionBefore === 'function') {
        const currentIds = ws.sessionIds;
        if (Array.isArray(currentIds) && currentIds.length > 0 && currentIds[0] !== entry.sessionId) {
          await ws.insertSessionBefore(entry.sessionId, currentIds[0]).catch(() => {});
        }
      }
    } else if (ws?.id && typeof wsReg?.attachSession === 'function') {
      await wsReg.attachSession(ws.id, entry.sessionId);
    }

    // Promote newly updated workspace to position #1 in DSH's top-left workspace dropdown
    if (entry.pinToTop && ws?.id && typeof wsReg?.insertBefore === 'function' && typeof wsReg?.list === 'function') {
      const firstWs = wsReg.list()?.[0];
      if (firstWs?.id && firstWs.id !== ws.id) {
        await wsReg.insertBefore(ws.id, firstWs.id).catch(() => {});
      }
    }
  }

  let clearedViaDomain = false;
  try {
    const projCacheTable = cordisCtx.storageDomain?.get?.('session_projcache')?.table?.('sessions');
    if (projCacheTable && typeof projCacheTable.delete === 'function') {
      for (const id of allTouchedIds) {
        await projCacheTable.delete(id);
      }
      clearedViaDomain = true;
    }
  } catch {
    // Domain may not expose `.get()` or `session_projcache` may not be open yet in live host
  }
  if (!clearedViaDomain && dshHome) {
    await invalidateSessionProjCache(dshHome, allTouchedIds).catch(() => {});
  }
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
  sessionTargetOverrides = {},
  workspaceTargetOverrides = {},
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

  const localMap = await scanLocalSessions(resolvedHome);
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
  const remoteLabel = payload.deviceLabel || commit.deviceId;

  async function maybeRecordMigration(targetId, toCwd) {
    if (!isCrossPlatform) return;
    await recordPendingMigration(resolvedHome, targetId, {
      fromDeviceId: commit.deviceId,
      fromDeviceLabel: remoteLabel,
      fromPlatform: commit.platform,
      toPlatform: targetPlatform,
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

  // Case A: Local root session does not exist -> Direct Import
  if (!localRoot) {
    const attachmentsRestored = await restoreAttachments(resolvedHome, attachments, vault);
    await writeSessionLogToDisk(resolvedHome, rewrittenRoot.header, rewrittenRoot.events);
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
      : [{ sessionId: rootSessionId, cwd: rewrittenRoot.header.cwd, pinToTop: true }];
    await reconcileRegistries(visibleEntries, touchedIds);

    return {
      status: 'imported',
      sessionId: rootSessionId,
      targetCwd: rewrittenRoot.header.cwd,
      writtenSessions: touchedIds,
      attachmentsRestored,
      outputsRestored: outputRes.restored,
      outputConflicts: outputRes.conflicts,
    };
  }

  // Case B: Local root session exists -> Compare logical hash chains (normalized with each side's own sessionRootCwd)
  const localRootChain = computeEventHashChain(
    localRoot.events,
    workspaceMappings,
    localRoot.header?.cwd || '',
  );
  const L = localRoot.events.length;
  const R = rootDecodedEntry.decoded.events.length;

  const isIdentical = L === R && localRootChain.headHash === remoteRootChain.headHash;
  const remoteIsOlderPrefix = R < L && (R === 0 || localRootChain.chainHashes[R - 1] === remoteRootChain.headHash);

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

    // Rescue stranded `_unmapped` / vault orphan session into real target workspace & sidebar!
    if (shouldRescueOrphan) {
      if (cordisCtx?.isSessionBusy?.(rootSessionId)) {
        return {
          status: 'deferred-busy',
          sessionId: rootSessionId,
        };
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
            pinToTop: true,
          }];
      await reconcileRegistries(visibleEntries, touchedIds);
      return {
        status: 'migrated',
        sessionId: rootSessionId,
        fromCwd: localRoot.header.cwd,
        toCwd: migrated.header.cwd,
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
    });
    return {
      status: 'up-to-date',
      sessionId: rootSessionId,
      outputsRestored: outputRes.restored,
      outputConflicts: outputRes.conflicts,
    };
  }

  const canFastForward = R > L && (L === 0 || remoteRootChain.chainHashes[L - 1] === localRootChain.headHash);
  if (canFastForward) {
    if (cordisCtx?.isSessionBusy?.(rootSessionId)) {
      return {
        status: 'deferred-busy',
        sessionId: rootSessionId,
      };
    }

    const attachmentsRestored = await restoreAttachments(resolvedHome, attachments, vault);
    const deltaEvents = rewrittenRoot.events.slice(L);

    // If rescuing from unmapped-workspaces, write full relocated V4 log to the new projectKey dir
    // (cannot append to old unmapped projectKey via persistence.open)
    if (shouldRescueOrphan) {
      await writeSessionLogToDisk(resolvedHome, rewrittenRoot.header, rewrittenRoot.events);
    } else if (cordisCtx?.sessionPersistence?.open) {
      let handle;
      try {
        handle = await cordisCtx.sessionPersistence.open(rootSessionId, 'write');
        await handle.append(deltaEvents);
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
    } else if (cordisCtx?.sessionPersistence?.writeImportedSessionLog) {
      try {
        await cordisCtx.sessionPersistence.writeImportedSessionLog(
          rootSessionId,
          rewrittenRoot.header,
          rewrittenRoot.events,
        );
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
    } else {
      await writeSessionLogToDisk(resolvedHome, rewrittenRoot.header, rewrittenRoot.events);
    }

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
          ...(shouldRescueOrphan ? { oldUnmappedCwd: localRoot.header.cwd } : {}),
          pinToTop: true,
        }];
    await reconcileRegistries(visibleEntries, touchedIds);

    return {
      status: 'fast-forwarded',
      sessionId: rootSessionId,
      targetCwd: rewrittenRoot.header.cwd,
      migratedFromUnmapped: shouldRescueOrphan,
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

    const branchCanFastForward =
      R > strippedExisting.length
      && (strippedExisting.length === 0 || remoteRootChain.chainHashes[strippedExisting.length - 1] === existingChain.headHash);

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
      await reconcileRegistries([{ sessionId: targetBranchId, cwd: branchHeader.cwd, pinToTop: true }], touchedIds);

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
  await maybeRecordMigration(branchId, branchHeader.cwd);

  const touchedIds = [branchId, ...childWritten];
  await reconcileRegistries([{ sessionId: branchId, cwd: branchHeader.cwd, pinToTop: true }], touchedIds);

  return {
    status: 'forked-branch',
    sessionId: rootSessionId,
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
  syncScope = 'active',
  selectedWorkspaces = [],
  selectedSessionIds = [],
  excludedSessionIds = [],
  sessionTargetOverrides = {},
  workspaceTargetOverrides = {},
  onlySessionIds = null,
  onlyWorkspaceSources = null,
  includeSelf = false,
  maxSupportedFormatVersion = DEFAULT_MAX_FORMAT_VERSION,
}) {
  if (!vault) throw new TypeError('pullSessionsFromVault requires vault');

  const { commits, pendingCount } = await vault.listCommits('session', { includeSelf });

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
  const selectedSessionSet = new Set(Array.isArray(selectedSessionIds) ? selectedSessionIds : []);
  const excludedSessionSet = new Set(Array.isArray(excludedSessionIds) ? excludedSessionIds : []);

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
      filteredCommits.push(commit);
      continue;
    }

    if (excludedSessionSet.has(sid)) {
      summary.skippedUnselected += 1;
      continue;
    }

    if (syncScope === 'selected') {
      const hitSid = selectedSessionSet.has(sid);
      const hitWs = matchesWorkspaceSelector(srcCwd, selectedWorkspaces, workspaceMappings, targetPlatform);
      if (!hitSid && !hitWs) {
        summary.skippedUnselected += 1;
        continue;
      }
    }

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

  const results = [];
  for (const commit of effectiveCommits) {
    const res = await importSessionCommit({
      dshHome,
      vault,
      commit,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      cordisCtx,
      defaultWorkspaceDir,
      folderMatchMode,
      autoMirrorRoot,
      sessionTargetOverrides,
      workspaceTargetOverrides,
      maxSupportedFormatVersion,
    });
    results.push(res);

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
      if (SKIPPED_OUTPUT_NAME_RE.test(e.name) || SENSITIVE_OUTPUT_NAME_RE.test(e.name)) continue;
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
}) {
  const resolvedHome = resolveDshHome(dshHome);
  const localMap = await scanLocalSessions(resolvedHome);
  const mappings = Array.isArray(config.workspaceMappings) ? config.workspaceMappings : [];
  const selectedWorkspaces = Array.isArray(config.selectedWorkspaces) ? config.selectedWorkspaces : [];
  const selectedSessionSet = new Set(Array.isArray(config.selectedSessionIds) ? config.selectedSessionIds : []);
  const excludedSessionSet = new Set(Array.isArray(config.excludedSessionIds) ? config.excludedSessionIds : []);

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
      const mapped = cleanPath ? mapPathAcrossOs(cleanPath, mappings, platform) : { workspaceId: null, matched: false };
      const mapping = mapped.workspaceId ? mappings.find((m) => m.id === mapped.workspaceId) : null;
      const peerOs = platform === 'win32' ? 'darwin' : 'win32';
      const title = mapping?.title || explicitTitle || (cleanPath ? basenameForPlatform(cleanPath, platform) : '未指定目录');
      groups.set(key, {
        workspaceKey: key,
        path: cleanPath,
        title,
        mappingId: mapping?.id ?? null,
        mappedPeerPath: mapping?.[peerOs] ?? null,
        sessionCount: 0,
        deliverableCount: 0,
        selected: matchesWorkspaceSelector(cleanPath, selectedWorkspaces, mappings, platform),
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

    group.sessions.push({
      sessionId: rec.sessionId,
      shortId: makeShortId(rec.sessionId),
      title,
      turnCount,
      eventCount: rec.events.length,
      lastActiveAt,
      selected: selectedSessionSet.has(rec.sessionId),
      excluded: excludedSessionSet.has(rec.sessionId),
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
        const wsStatePath = path.join(soulSyncDir(resolvedHome), 'workspaces', `${group.mappingId}.json`);
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
}) {
  if (!vault) {
    return { workspaces: [], totalSessions: 0, pendingCount: 0 };
  }

  const resolvedHome = resolveDshHome(dshHome);
  const { commits, pendingCount } = await vault.listCommits('session', { includeSelf });
  const localMap = await scanLocalSessions(resolvedHome);
  const mappings = Array.isArray(config.workspaceMappings) ? config.workspaceMappings : [];
  const folderMatchMode = config.folderMatchMode === 'mapped-only' ? 'mapped-only' : 'auto-mirror';
  const effectiveAutoMirrorRoot = autoMirrorRoot || config.autoMirrorRoot || undefined;
  const sessionTargetOverrides = config.sessionTargetOverrides ?? {};
  const workspaceTargetOverrides = config.workspaceTargetOverrides ?? {};

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
    let localStatus = 'new';
    const remoteCount = typeof rootNode.eventCount === 'number' ? rootNode.eventCount : 0;
    const remoteHead = typeof rootNode.headChainHash === 'string' ? rootNode.headChainHash : '';
    const remoteChain = Array.isArray(rootNode.chainHashes) ? rootNode.chainHashes : [];

    if (localRoot) {
      const localChain = computeEventHashChain(localRoot.events, mappings, localRoot.header?.cwd || '');
      const L = localRoot.events.length;
      if (L === remoteCount && remoteHead && localChain.headHash === remoteHead) {
        localStatus = 'up-to-date';
      } else if (remoteCount < L && remoteHead && (remoteCount === 0 || localChain.chainHashes[remoteCount - 1] === remoteHead)) {
        localStatus = 'up-to-date';
      } else if (remoteCount > L && (L === 0 || (remoteChain[L - 1] && remoteChain[L - 1] === localChain.headHash))) {
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
    group.sessions.push({
      sessionId: sid,
      shortId: makeShortId(sid),
      title,
      turnCount: turnCount ?? Math.max(1, Math.floor(remoteCount / 2)),
      eventCount: remoteCount,
      lastActiveAt,
      localStatus,
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
  };
}
