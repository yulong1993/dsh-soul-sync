import crypto from 'node:crypto';
import fs from 'node:fs/promises';
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

/**
 * Normalize a path into a cross-OS logical representation (`{{WS:<id>}}/<relPosix>`)
 * so Win <-> Mac roundtrips produce identical event hash chains.
 *
 * @param {string} rawPath
 * @param {Array<Record<string, any>>} [workspaceMappings]
 * @returns {string}
 */
export function normalizeLogicalPath(rawPath, workspaceMappings = []) {
  const nfc = String(rawPath ?? '').normalize('NFC');
  if (!nfc) return '';
  const mapped = mapPathAcrossOs(nfc, workspaceMappings, 'darwin');
  if (mapped.workspaceId !== null && mapped.relativePosixPath !== null) {
    return mapped.relativePosixPath
      ? `{{WS:${mapped.workspaceId}}}/${mapped.relativePosixPath}`
      : `{{WS:${mapped.workspaceId}}}`;
  }
  return normalizePosixSlashes(nfc);
}

function normalizeEventForHash(event, workspaceMappings) {
  if (!event || typeof event !== 'object') return event;
  if (event.type === 'working-directory/change' && typeof event.data?.cwd === 'string') {
    return {
      ...event,
      data: {
        ...event.data,
        cwd: normalizeLogicalPath(event.data.cwd, workspaceMappings),
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
              path: normalizeLogicalPath(item.path, workspaceMappings),
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
 * @returns {{ headHash: string, chainHashes: string[] }}
 */
export function computeEventHashChain(events = [], workspaceMappings = []) {
  const chainHashes = [];
  let prev = GENESIS_CHAIN_HASH;
  for (const ev of events) {
    const normalized = normalizeEventForHash(ev, workspaceMappings);
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

/**
 * Export a root session and its complete recursive subagent lineage closure
 * (including children stored under different `projectKey` directories) plus attachments
 * into the encrypted VaultStore.
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
    const { headHash, chainHashes } = computeEventHashChain(rec.events, workspaceMappings);
    allEvents.push(...rec.events);

    nodes.push({
      sessionId: rec.sessionId,
      header: normalizedHeader,
      eventCount: rec.events.length,
      inheritedEventCount: rec.inheritedEventCount,
      headChainHash: headHash,
      chainHashes,
      logBlob,
    });
  }

  const attachments = await packAttachmentsForEvents(resolvedHome, allEvents, vault);
  const modelTriple = extractModelTriple(rootRecord.events);

  const payload = {
    schemaVersion: 1,
    dshFormatVersion: rootRecord.header.version ?? 4,
    rootSessionId: rootId,
    deviceLabel: deviceLabel ?? vault.deviceId,
    modelTriple,
    nodes,
    attachments,
  };

  const commit = await vault.publishCommit('session', rootId, payload);
  return {
    rootSessionId: rootId,
    deferred: false,
    deferredCompactionSessions: [],
    commit,
    nodeCount: nodes.length,
    attachmentCount: attachments.length,
  };
}

/**
 * Export all top-level (non-subagent) local sessions and their lineage closures.
 */
export async function exportAllLocalSessions({
  dshHome,
  vault,
  workspaceMappings = [],
  deviceLabel = undefined,
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

  const roots = [];
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
    roots.push(rec);
  }

  const exported = [];
  const deferredCompactionSessions = [];
  for (const root of roots) {
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

  return { exported, deferredCompactionSessions, totalLocalSessions: localMap.size };
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
}) {
  const newHeader = { ...header };
  let headerWorkspaceId = null;

  if (typeof header?.cwd === 'string' && header.cwd.length > 0) {
    const res = await resolveMappedPathForTargetOs(header.cwd, {
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      dshHome,
      ensureDir: true,
    });
    newHeader.cwd = res.path;
    headerWorkspaceId = res.workspaceId;
  }

  const newEvents = [];
  for (const ev of events) {
    if (ev?.type === 'working-directory/change' && typeof ev.data?.cwd === 'string') {
      const res = await resolveMappedPathForTargetOs(ev.data.cwd, {
        workspaceMappings,
        targetPlatform,
        fallbackRoot,
        dshHome,
        ensureDir: true,
      });
      newEvents.push({
        ...ev,
        data: {
          ...ev.data,
          cwd: res.path,
        },
      });
      continue;
    }

    if (ev?.type === 'deliverables/presented' && Array.isArray(ev.data?.files)) {
      const rewrittenFiles = [];
      for (const fileItem of ev.data.files) {
        if (fileItem && typeof fileItem === 'object' && typeof fileItem.path === 'string' && isAnyAbsolutePath(fileItem.path)) {
          const res = await resolveMappedPathForTargetOs(fileItem.path, {
            workspaceMappings,
            targetPlatform,
            fallbackRoot,
            dshHome,
            ensureDir: false,
          });
          rewrittenFiles.push({
            ...fileItem,
            path: res.path,
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
 * before writing `<newProjKey>/<encodedId>` so a sessionId can NEVER exist in two projectKey dirs.
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
    const oldDir = path.join(sessionsRoot, proj.name, encodedId);
    try {
      const st = await fs.stat(oldDir);
      if (st.isDirectory()) {
        await fs.rm(oldDir, { recursive: true, force: true });
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
    if (!targetRec.sessionIds.includes(entry.sessionId)) {
      targetRec.sessionIds = [entry.sessionId, ...targetRec.sessionIds];
      targetRec.updatedAt = nowIso;
    }
  }

  await writeFileAtomic(wsPath, `${JSON.stringify(wsData, null, 2)}\n`, { mode: 0o600 });
}

async function reconcileOnlineWorkspaceAndCache(dshHome, cordisCtx, visibleEntries, allTouchedIds, { workspaceMappings, targetPlatform }) {
  for (const entry of visibleEntries) {
    if (!entry.cwd) continue;
    if (targetPlatform === process.platform && path.isAbsolute(entry.cwd)) {
      await fs.mkdir(entry.cwd, { recursive: true }).catch(() => {});
    }
    const title = entry.title || findWorkspaceTitleForCwd(entry.cwd, workspaceMappings, targetPlatform);
    const ws = await cordisCtx.workspaceRegistry?.create?.(entry.cwd, title);
    if (ws && typeof ws.attachSession === 'function') {
      await ws.attachSession(entry.sessionId);
    } else if (ws?.id && typeof cordisCtx.workspaceRegistry?.attachSession === 'function') {
      await cordisCtx.workspaceRegistry.attachSession(ws.id, entry.sessionId);
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
  { dshHome, localMap, workspaceMappings, targetPlatform, fallbackRoot, parentRemap = new Map(), isForkedBranch = false, remoteDeviceId = '' },
) {
  const writtenIds = [];
  const childIdMap = new Map();

  // Rewrite all children once so hash comparisons match rewritten local fallback paths
  const preparedChildren = [];
  for (const child of childNodes) {
    const rewritten = await rewriteSessionForTargetOs({
      header: child.decoded.header,
      events: child.decoded.events,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      dshHome,
    });
    preparedChildren.push({ child, rewritten });
  }

  // First pass: determine target IDs for each child (avoid clobbering existing local child of origSessionId during fork)
  for (const { child, rewritten } of preparedChildren) {
    const origChildId = child.decoded.header.id;
    let targetChildId = origChildId;
    if (isForkedBranch && localMap.has(origChildId)) {
      const childChain = computeEventHashChain(rewritten.events, workspaceMappings);
      const localChild = localMap.get(origChildId);
      const localChildChain = computeEventHashChain(localChild.events, workspaceMappings);
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
      const localChain = computeEventHashChain(localChild.events, workspaceMappings);
      const remoteChain = computeEventHashChain(events, workspaceMappings);
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
 *  - Attachment reconstruction
 *  - Minimal exact OS path rewrite
 *  - Import / Lossless Fast-Forward / Zero-Shift Split-Brain Fork
 *  - Dual-mode (online Cordis vs offline disk) workspace & projection-cache reconciliation
 */
export async function importSessionCommit({
  dshHome,
  vault,
  commit,
  workspaceMappings = [],
  targetPlatform = process.platform,
  fallbackRoot = undefined,
  cordisCtx = null,
  maxSupportedFormatVersion = DEFAULT_MAX_FORMAT_VERSION,
}) {
  if (!vault) throw new TypeError('importSessionCommit requires vault');
  if (!commit || !commit.payload) throw new TypeError('importSessionCommit requires commit with payload');

  const resolvedHome = resolveDshHome(dshHome);
  const payload = commit.payload;
  const rootSessionId = payload.rootSessionId ?? commit.targetId;
  const remoteFormatVersion = payload.dshFormatVersion ?? 4;

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

  // 2. Hydration pre-flight check across ALL log blobs & attachments
  const allBlobRefs = [
    ...nodes.map((n) => n.logBlob),
    ...attachments.map((a) => ({ storageKey: a.storageKey, sha256: a.sha256, size: a.size })),
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

  const rootNodeMeta = nodes.find((n) => n.sessionId === rootSessionId) ?? nodes[0];
  if (!rootNodeMeta) {
    return { status: 'up-to-date', sessionId: rootSessionId };
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

  const localMap = await scanLocalSessions(resolvedHome);
  const localRoot = localMap.get(rootSessionId);

  const rewrittenRoot = await rewriteSessionForTargetOs({
    header: rootDecodedEntry.decoded.header,
    events: rootDecodedEntry.decoded.events,
    workspaceMappings,
    targetPlatform,
    fallbackRoot,
    dshHome: resolvedHome,
  });
  const remoteRootChain = computeEventHashChain(rewrittenRoot.events, workspaceMappings);

  const isCrossPlatform = Boolean(commit.platform && commit.platform !== targetPlatform);
  const remoteLabel = payload.deviceLabel || commit.deviceId;
  const origRemoteCwd = rootDecodedEntry.decoded.header.cwd ?? null;

  async function maybeRecordMigration(targetId, toCwd) {
    if (!isCrossPlatform) return;
    await recordPendingMigration(resolvedHome, targetId, {
      fromDeviceId: commit.deviceId,
      fromDeviceLabel: remoteLabel,
      fromPlatform: commit.platform,
      toPlatform: targetPlatform,
      fromCwd: origRemoteCwd,
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

  // Case A: Local root session does not exist -> Direct Import
  if (!localRoot) {
    const attachmentsRestored = await restoreAttachments(resolvedHome, attachments, vault);
    await writeSessionLogToDisk(resolvedHome, rewrittenRoot.header, rewrittenRoot.events);
    const { writtenIds: childWritten } = await syncSubagentChildren(childEntries, {
      dshHome: resolvedHome,
      localMap,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
    });

    await maybeRecordMigration(rootSessionId, rewrittenRoot.header.cwd);
    const touchedIds = [rootSessionId, ...childWritten];
    const visibleEntries = rewrittenRoot.header.origin === 'subagent'
      ? []
      : [{ sessionId: rootSessionId, cwd: rewrittenRoot.header.cwd }];
    await reconcileRegistries(visibleEntries, touchedIds);

    return {
      status: 'imported',
      sessionId: rootSessionId,
      writtenSessions: touchedIds,
      attachmentsRestored,
    };
  }

  // Case B: Local root session exists -> Compare logical hash chains
  const localRootChain = computeEventHashChain(localRoot.events, workspaceMappings);
  const L = localRoot.events.length;
  const R = rootDecodedEntry.decoded.events.length;

  const isIdentical = L === R && localRootChain.headHash === remoteRootChain.headHash;
  const remoteIsOlderPrefix = R < L && (R === 0 || localRootChain.chainHashes[R - 1] === remoteRootChain.headHash);

  if (isIdentical || remoteIsOlderPrefix) {
    // Still ensure any missing/newer subagent children & attachments are present
    const { writtenIds: childWritten } = await syncSubagentChildren(childEntries, {
      dshHome: resolvedHome,
      localMap,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
    });
    if (childWritten.length > 0 && attachments.length > 0) {
      await restoreAttachments(resolvedHome, attachments, vault);
    }
    return {
      status: 'up-to-date',
      sessionId: rootSessionId,
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

    if (cordisCtx?.sessionPersistence?.open) {
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

    const { writtenIds: childWritten } = await syncSubagentChildren(childEntries, {
      dshHome: resolvedHome,
      localMap,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
    });

    await maybeRecordMigration(rootSessionId, rewrittenRoot.header.cwd);
    const touchedIds = [rootSessionId, ...childWritten];
    const visibleEntries = rewrittenRoot.header.origin === 'subagent'
      ? []
      : [{ sessionId: rootSessionId, cwd: rewrittenRoot.header.cwd }];
    await reconcileRegistries(visibleEntries, touchedIds);

    return {
      status: 'fast-forwarded',
      sessionId: rootSessionId,
      previousEventCount: L,
      newEventCount: R,
      appendedCount: deltaEvents.length,
      attachmentsRestored,
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
    const existingChain = computeEventHashChain(unremappedExisting, workspaceMappings);

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
        dshHome: resolvedHome,
        localMap,
        workspaceMappings,
        targetPlatform,
        fallbackRoot,
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
      await reconcileRegistries([{ sessionId: targetBranchId, cwd: branchHeader.cwd }], touchedIds);

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
    dshHome: resolvedHome,
    localMap,
    workspaceMappings,
    targetPlatform,
    fallbackRoot,
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
  await reconcileRegistries([{ sessionId: branchId, cwd: branchHeader.cwd }], touchedIds);

  return {
    status: 'forked-branch',
    sessionId: rootSessionId,
    branchId,
    writtenSessions: touchedIds,
    attachmentsRestored,
  };
}

/**
 * Pull all remote session commits from VaultStore and reconcile them into local `<dshHome>`.
 */
export async function pullSessionsFromVault({
  dshHome,
  vault,
  workspaceMappings = [],
  targetPlatform = process.platform,
  fallbackRoot = undefined,
  cordisCtx = null,
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
  const effectiveCommits = [...latestByDeviceTarget.values()].sort(
    (a, b) => (a.timestamp - b.timestamp) || (a.seq - b.seq) || String(a.deviceId).localeCompare(String(b.deviceId)),
  );

  const results = [];
  const summary = {
    imported: 0,
    fastForwarded: 0,
    forkedBranches: 0,
    upToDate: 0,
    pendingHydration: 0,
    deferredBusy: 0,
    versionMismatch: 0,
  };

  for (const commit of effectiveCommits) {
    const res = await importSessionCommit({
      dshHome,
      vault,
      commit,
      workspaceMappings,
      targetPlatform,
      fallbackRoot,
      cordisCtx,
      maxSupportedFormatVersion,
    });
    results.push(res);

    switch (res.status) {
      case 'imported': summary.imported += 1; break;
      case 'fast-forwarded': summary.fastForwarded += 1; break;
      case 'forked-branch': summary.forkedBranches += 1; break;
      case 'up-to-date': summary.upToDate += 1; break;
      case 'pending-hydration': summary.pendingHydration += 1; break;
      case 'deferred-busy': summary.deferredBusy += 1; break;
      case 'version-mismatch': summary.versionMismatch += 1; break;
      default: break;
    }
  }

  return {
    results,
    pendingCount,
    summary,
  };
}
