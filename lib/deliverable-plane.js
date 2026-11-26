import { execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

import {
  DEFAULT_QUOTAS,
  resolveDshHome,
  soulSyncDir,
  writeFileAtomic,
} from './config.js';
import {
  BLACKLIST_DIRS,
  checkBlockedRelativePath,
  isStrictlyInsideRoot,
  validateCrossOsRelativePath,
} from './artifact-worker.js';

const execFile = promisify(execFileCb);

const WORKER_SCRIPT_URL = new URL('./artifact-worker.js', import.meta.url);
const VALID_SOURCES = new Set(['tool', 'present', 'watcher', 'manual']);
const LOCK_IO_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const OFFICE_LOCK_EXTS = new Set(['.xlsx', '.xlsm', '.docx', '.pptx']);
const ATOMIC_TMP_RE = /^\..*\.\d+\.[0-9a-f]{16}\.tmp$/i;
const DELIVERABLE_CONFLICT_COPY_RE = / \(来自[^/\\()]+ \d{8}-\d{4}(?:-[0-9a-z]+)?\)(?:\.[^./\\]+)?$/i;
const DOT_CONFLICT_COPY_RE = /\.conflict-[^/\\]+$/i;
const MAX_WORKER_POOL = 2;

export function isConflictCopyPath(relPosix) {
  if (typeof relPosix !== 'string' || !relPosix) return false;
  const base = path.posix.basename(relPosix.replace(/\\/g, '/').normalize('NFC'));
  return DELIVERABLE_CONFLICT_COPY_RE.test(base) || DOT_CONFLICT_COPY_RE.test(base);
}

async function canonicalizeWorkspaceRoot(workspaceRoot) {
  if (!workspaceRoot) return '';
  const resolved = path.resolve(String(workspaceRoot)).normalize('NFC');
  let canonical = resolved;
  try {
    canonical = (await fs.realpath(resolved)).normalize('NFC');
  } catch {
    // Directory may not exist yet; fall back to resolved path
  }
  if (process.platform === 'win32') {
    canonical = canonical.toLowerCase();
  }
  const root = path.parse(canonical).root;
  if (canonical.length > root.length && canonical.endsWith(path.sep)) {
    canonical = canonical.slice(0, -1);
  }
  return canonical;
}

function reconcileWorkspaceRoot(state, canonicalRoot) {
  if (!canonicalRoot) return false;
  if (state.workspaceRoot && state.workspaceRoot !== canonicalRoot) {
    state.workspaceRoot = canonicalRoot;
    state.trackedPaths = {};
    state.baseTree = {};
    state.lastPublishedTree = {};
    state.hasPublished = false;
    state.pendingIncoming = {};
    state.resolvedConflicts = {};
    state.conflictOverrides = {};
    state.lastPulledCommits = {};
    return true;
  }
  if (!state.workspaceRoot) {
    state.workspaceRoot = canonicalRoot;
    return true;
  }
  return false;
}

const stateLocks = new Map();

function withStateLock(key, fn) {
  const prev = stateLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.finally(() => {
    if (stateLocks.get(key) === cleanup) {
      stateLocks.delete(key);
    }
  });
  stateLocks.set(key, cleanup);
  return next;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function workspaceStatePath(dshHome, workspaceId) {
  return path.join(soulSyncDir(dshHome), 'workspaces', `${encodeURIComponent(String(workspaceId))}.json`);
}

function createEmptyState(workspaceId) {
  return {
    version: 1,
    workspaceId: String(workspaceId),
    workspaceRoot: '',
    trackedPaths: {},
    baseTree: {},
    lastPublishedTree: {},
    hasPublished: false,
    vaultDir: '',
    vaultKeyFingerprint: '',
    pendingIncoming: {},
    resolvedConflicts: {},
    conflictOverrides: {},
    lastPulledCommits: {},
  };
}

function normalizeState(raw, workspaceId) {
  const base = createEmptyState(workspaceId);
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: 1,
    workspaceId: String(raw.workspaceId || workspaceId),
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : '',
    trackedPaths: raw.trackedPaths && typeof raw.trackedPaths === 'object' ? { ...raw.trackedPaths } : {},
    baseTree: raw.baseTree && typeof raw.baseTree === 'object' ? { ...raw.baseTree } : {},
    lastPublishedTree: raw.lastPublishedTree && typeof raw.lastPublishedTree === 'object' ? { ...raw.lastPublishedTree } : {},
    hasPublished: Boolean(raw.hasPublished),
    vaultDir: typeof raw.vaultDir === 'string' ? raw.vaultDir : '',
    vaultKeyFingerprint: typeof raw.vaultKeyFingerprint === 'string' ? raw.vaultKeyFingerprint : '',
    pendingIncoming: raw.pendingIncoming && typeof raw.pendingIncoming === 'object' ? { ...raw.pendingIncoming } : {},
    resolvedConflicts: raw.resolvedConflicts && typeof raw.resolvedConflicts === 'object' ? { ...raw.resolvedConflicts } : {},
    conflictOverrides: raw.conflictOverrides && typeof raw.conflictOverrides === 'object' ? { ...raw.conflictOverrides } : {},
    lastPulledCommits: raw.lastPulledCommits && typeof raw.lastPulledCommits === 'object' ? { ...raw.lastPulledCommits } : {},
  };
}

export async function loadWorkspaceDeliverableState(dshHome, workspaceId) {
  const filePath = workspaceStatePath(dshHome, workspaceId);
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return normalizeState(JSON.parse(text), workspaceId);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return createEmptyState(workspaceId);
    }
    throw err;
  }
}

export async function saveWorkspaceDeliverableState(dshHome, workspaceId, state) {
  const filePath = workspaceStatePath(dshHome, workspaceId);
  const normalized = normalizeState(state, workspaceId);
  await writeFileAtomic(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function toRelativePosixInWorkspace(workspaceRoot, targetPath) {
  const raw = String(targetPath ?? '').normalize('NFC');
  if (!raw) return null;

  const isWinAbs = /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]+\\[^\\]+/.test(raw);
  const isPosixAbs = raw.startsWith('/');

  if (isWinAbs || isPosixAbs || path.isAbsolute(raw)) {
    const absRoot = path.resolve(workspaceRoot);
    const absTarget = path.resolve(raw);
    const rel = path.relative(absRoot, absTarget);
    if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return null;
    }
    return rel.split(path.sep).join('/').normalize('NFC');
  }

  let posixRel = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!posixRel || posixRel === '.' || posixRel === '..' || posixRel.startsWith('../') || posixRel.includes('/../')) {
    return null;
  }
  return posixRel.normalize('NFC');
}

/**
 * Signal 1 & 4: Record a workspace deliverable candidate into `<dshHome>/soul-sync/workspaces/<id>.json`.
 * Zero files are written inside the user's workspace directory.
 */
export async function recordDeliverableCandidate(dshHome, workspaceId, workspaceRoot, targetPath, source = 'tool') {
  const effectiveSource = VALID_SOURCES.has(source) ? source : 'tool';
  const relPosix = toRelativePosixInWorkspace(workspaceRoot, targetPath);
  if (!relPosix) {
    return { recorded: false, reason: 'outside-workspace', relativePath: null };
  }

  const stateFile = workspaceStatePath(dshHome, workspaceId);
  return withStateLock(stateFile, async () => {
    const state = await loadWorkspaceDeliverableState(dshHome, workspaceId);
    const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot);
    reconcileWorkspaceRoot(state, canonicalRoot);
    const now = Date.now();
    const existing = state.trackedPaths[relPosix];
    // Preserve 'manual' (/soul keep) precedence over automated signals
    const nextSource = existing?.source === 'manual' ? 'manual' : effectiveSource;
    state.trackedPaths[relPosix] = {
      source: nextSource,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
    };
    await saveWorkspaceDeliverableState(dshHome, workspaceId, state);
    return { recorded: true, relativePath: relPosix, source: nextSource };
  });
}

function isIgnoredByWatcher(relPosix) {
  if (isConflictCopyPath(relPosix)) return true;
  const segments = relPosix.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  for (const seg of segments) {
    if (BLACKLIST_DIRS.has(seg.toLowerCase())) return true;
  }
  const base = segments[segments.length - 1];
  const lower = base.toLowerCase();
  if (
    base.startsWith('~$')
    || (base.startsWith('.~lock.') && base.endsWith('#'))
    || lower.endsWith('.sqlite-wal')
    || lower.endsWith('.sqlite-shm')
    || lower.endsWith('.sqlite-journal')
    || lower === '.ds_store'
    || lower === 'thumbs.db'
    || ATOMIC_TMP_RE.test(base)
  ) {
    return true;
  }
  return false;
}

/**
 * Signal 3: Lightweight active-session directory watcher.
 * Captures only files written during an active session, automatically filtering
 * blacklisted directories and Office/SQLite lock files without scanning legacy files.
 */
export function createActiveWorkspaceWatcher(workspaceRoot, onRelativePath) {
  const absRoot = path.resolve(workspaceRoot);
  let closed = false;
  const inflight = new Set();

  const handleEvent = (_eventType, filename) => {
    if (closed || !filename) return;
    const rawName = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename);
    const relPosix = rawName.replace(/\\/g, '/').replace(/^\.\//, '').normalize('NFC');
    if (!relPosix || isIgnoredByWatcher(relPosix)) return;

    const fullPath = path.join(absRoot, ...relPosix.split('/'));
    const job = (async () => {
      try {
        const st = await fs.lstat(fullPath);
        if (closed || !st.isFile() || st.isSymbolicLink()) return;
        await onRelativePath(relPosix);
      } catch {
        // Ignore transient ENOENT / EBUSY during writes
      }
    })();
    inflight.add(job);
    job.finally(() => inflight.delete(job));
  };

  let watcher;
  try {
    watcher = fsSync.watch(absRoot, { recursive: true }, handleEvent);
  } catch (err) {
    if (err?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
      watcher = fsSync.watch(absRoot, { recursive: false }, handleEvent);
    } else {
      throw err;
    }
  }
  watcher.on('error', () => {
    // Prevent unhandled error crashes if directory is temporarily unavailable
  });
  if (typeof watcher.unref === 'function') {
    watcher.unref();
  }

  return {
    watcher,
    async close() {
      if (closed) return;
      closed = true;
      try {
        watcher.close();
      } catch {
        // ignore
      }
      if (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}

/**
 * Signal 4: Query `git ls-files -z` (3s timeout) to avoid competing with Git for tracked code.
 */
export async function getGitTrackedFiles(workspaceRoot) {
  try {
    const { stdout } = await execFile('git', ['ls-files', '-z'], {
      cwd: path.resolve(workspaceRoot),
      timeout: 3000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'buffer',
    });
    const out = new Set();
    const raw = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout);
    for (const entry of raw.split('\0')) {
      if (!entry) continue;
      out.add(entry.replace(/\\/g, '/').normalize('NFC'));
    }
    return out;
  } catch {
    return new Set();
  }
}

function isPathInGitSet(relPosix, gitSet, gitLowerSet) {
  if (gitSet.size === 0) return false;
  if (gitSet.has(relPosix)) return true;
  if ((process.platform === 'win32' || process.platform === 'darwin') && gitLowerSet) {
    return gitLowerSet.has(relPosix.toLowerCase());
  }
  return false;
}

function globToRegExp(pattern) {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += '$';
  return new RegExp(re, process.platform === 'win32' ? 'i' : '');
}

async function loadDshSyncIgnore(workspaceRoot) {
  const ignorePath = path.join(path.resolve(workspaceRoot), '.dshsyncignore');
  let text;
  try {
    text = await fs.readFile(ignorePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return () => false;
    return () => false;
  }

  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.endsWith('/')) {
      const dirPrefix = normalized.slice(0, -1);
      const exactDirRe = globToRegExp(`${dirPrefix}/**`);
      rules.push((rel) => exactDirRe.test(rel));
    } else if (!normalized.includes('/')) {
      const baseRe = globToRegExp(normalized);
      const anyPathRe = globToRegExp(`**/${normalized}`);
      rules.push((rel) => baseRe.test(path.posix.basename(rel)) || anyPathRe.test(rel));
    } else {
      const fullRe = globToRegExp(normalized.replace(/^\//, ''));
      rules.push((rel) => fullRe.test(rel));
    }
  }

  return (relPosix) => rules.some((fn) => fn(relPosix));
}

async function collectOutputsCandidates(workspaceRoot, candidateMap) {
  const absRoot = path.resolve(workspaceRoot);
  const outputsDir = path.join(absRoot, 'outputs');
  let rootStat;
  try {
    rootStat = await fs.lstat(outputsDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (rootStat.isSymbolicLink()) {
    if (!candidateMap.has('outputs')) {
      candidateMap.set('outputs', { source: 'outputs' });
    }
    return;
  }
  if (!rootStat.isDirectory()) return;

  async function walk(absDir, relPrefix) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name.normalize('NFC');
      const relPosix = `${relPrefix}/${name}`;
      if (entry.isSymbolicLink()) {
        // Record symlink itself so Gate 1 explicitly blocks it (do NOT recurse outside!)
        if (!candidateMap.has(relPosix)) {
          candidateMap.set(relPosix, { source: 'outputs' });
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (BLACKLIST_DIRS.has(name.toLowerCase())) continue;
        await walk(path.join(absDir, entry.name), relPosix);
        continue;
      }
      if (entry.isFile()) {
        if (isConflictCopyPath(relPosix)) continue;
        if (!candidateMap.has(relPosix)) {
          candidateMap.set(relPosix, { source: 'outputs' });
        }
      }
    }
  }

  await walk(outputsDir, 'outputs');
}

function parseOfficeLockEntry(fileName) {
  if (fileName.startsWith('~$')) {
    const ext = path.extname(fileName).toLowerCase();
    if (OFFICE_LOCK_EXTS.has(ext)) {
      return { kind: 'msoffice', targetName: fileName.slice(2) };
    }
  }
  if (fileName.startsWith('.~lock.') && fileName.endsWith('#')) {
    return { kind: 'libreoffice', targetName: fileName.slice('.~lock.'.length, -1) };
  }
  return null;
}

/**
 * Detect active MS Office (`~$*.xlsx/xlsm/docx/pptx`) and LibreOffice (`.~lock.*#`) lock files
 * across workspace root, `outputs/**`, and all directories containing tracked deliverables.
 */
export async function detectOpenOfficeLocks(workspaceRoot, trackedRelPaths = []) {
  const absRoot = path.resolve(workspaceRoot);
  const dirsToScan = new Set(['']); // '' = workspaceRoot

  // Include outputs/ and its non-symlink subdirectories
  const outputsDir = path.join(absRoot, 'outputs');
  try {
    const st = await fs.lstat(outputsDir);
    if (!st.isSymbolicLink() && st.isDirectory()) {
      dirsToScan.add('outputs');
      const queue = [{ abs: outputsDir, rel: 'outputs' }];
      while (queue.length > 0) {
        const cur = queue.shift();
        let entries;
        try {
          entries = await fs.readdir(cur.abs, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.isSymbolicLink() || !e.isDirectory()) continue;
          if (BLACKLIST_DIRS.has(e.name.toLowerCase())) continue;
          const subRel = `${cur.rel}/${e.name.normalize('NFC')}`;
          dirsToScan.add(subRel);
          queue.push({ abs: path.join(cur.abs, e.name), rel: subRel });
        }
      }
    }
  } catch {
    // outputs/ absent
  }

  for (const rel of trackedRelPaths ?? []) {
    if (typeof rel !== 'string' || !rel) continue;
    const norm = rel.normalize('NFC').replace(/\\/g, '/');
    const dir = path.posix.dirname(norm);
    dirsToScan.add(dir === '.' ? '' : dir);
  }

  const locks = [];
  for (const relDir of [...dirsToScan].sort()) {
    const absDir = relDir ? path.join(absRoot, ...relDir.split('/')) : absRoot;
    let entries;
    try {
      entries = await fs.readdir(absDir);
    } catch {
      continue;
    }
    for (const rawName of entries) {
      const name = rawName.normalize('NFC');
      const parsed = parseOfficeLockEntry(name);
      if (!parsed) continue;
      const lockPath = relDir ? `${relDir}/${name}` : name;
      const targetPath = relDir ? `${relDir}/${parsed.targetName}` : parsed.targetName;
      locks.push({
        kind: parsed.kind,
        fileName: name,
        lockPath,
        targetPath,
      });
    }
  }

  return locks;
}

async function hasActiveOfficeLock(workspaceRoot, relPosix) {
  const targetFull = path.join(path.resolve(workspaceRoot), ...relPosix.split('/'));
  const dir = path.dirname(targetFull);
  const base = path.basename(targetFull);
  const ext = path.extname(base).toLowerCase();

  const candidates = [
    path.join(dir, `~$${base}`),
    path.join(dir, `.~lock.${base}#`),
  ];
  // MS Office shortens lock filename by replacing leading 2 chars on longer names
  if (OFFICE_LOCK_EXTS.has(ext) && base.length > 8) {
    candidates.push(path.join(dir, `~$${base.slice(2)}`));
  }

  for (const lockCandidate of candidates) {
    try {
      await fs.lstat(lockCandidate);
      return true;
    } catch {
      // absent
    }
  }
  return false;
}

/**
 * Bounded `node:worker_threads` pool (max 2 workers) running `artifact-worker.js`.
 */
export function createArtifactWorkerPool(maxWorkers = MAX_WORKER_POOL) {
  const cap = Math.max(1, Math.min(MAX_WORKER_POOL, Number(maxWorkers) || MAX_WORKER_POOL));
  const workers = [];
  const idle = [];
  const queue = [];
  let nextId = 1;
  let terminated = false;

  function spawnWorker() {
    const worker = new Worker(WORKER_SCRIPT_URL);
    const slot = { worker, active: null };

    worker.on('message', (msg) => {
      const current = slot.active;
      slot.active = null;
      if (current) {
        const res = msg?.result;
        if (res?.ok && res.bytes instanceof Uint8Array && !Buffer.isBuffer(res.bytes)) {
          res.bytes = Buffer.from(res.bytes.buffer, res.bytes.byteOffset, res.bytes.byteLength);
        }
        current.resolve(res);
      }
      if (!terminated) {
        idle.push(slot);
        pump();
      }
    });

    worker.on('error', (err) => {
      const current = slot.active;
      slot.active = null;
      if (current) {
        current.reject(err);
      }
    });

    worker.on('exit', (code) => {
      const idx = workers.indexOf(slot);
      if (idx !== -1) workers.splice(idx, 1);
      const idleIdx = idle.indexOf(slot);
      if (idleIdx !== -1) idle.splice(idleIdx, 1);
      const current = slot.active;
      slot.active = null;
      if (current) {
        current.reject(new Error(`artifact-worker exited unexpectedly with code ${code}`));
      }
    });

    workers.push(slot);
    idle.push(slot);
  }

  function pump() {
    if (terminated) return;
    while (queue.length > 0) {
      if (idle.length === 0 && workers.length < cap) {
        spawnWorker();
      }
      if (idle.length === 0) return;
      const slot = idle.pop();
      const job = queue.shift();
      slot.active = job;
      slot.worker.postMessage({ id: job.id, payload: job.payload });
    }
  }

  return {
    inspect(payload) {
      if (terminated) {
        return Promise.reject(new Error('ArtifactWorkerPool has been terminated'));
      }
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, payload, resolve, reject });
        pump();
      });
    },
    async terminate() {
      if (terminated) return;
      terminated = true;
      while (queue.length > 0) {
        const job = queue.shift();
        job.reject(new Error('ArtifactWorkerPool terminated'));
      }
      const toTerminate = [...workers];
      workers.length = 0;
      idle.length = 0;
      await Promise.allSettled(toTerminate.map((slot) => slot.worker.terminate()));
    },
  };
}

function treeEntrySignature(entry) {
  if (!entry) return null;
  if (entry.deleted) {
    return `DEL:${entry.previousSha256 ?? ''}`;
  }
  return `FILE:${entry.sha256}:${entry.storageKey}:${entry.size}:${entry.executable ? 1 : 0}`;
}

function treesEqual(treeA = {}, treeB = {}) {
  const keysA = Object.keys(treeA).sort();
  const keysB = Object.keys(treeB).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (k !== keysB[i]) return false;
    if (treeEntrySignature(treeA[k]) !== treeEntrySignature(treeB[k])) return false;
  }
  return true;
}

function cloneTree(tree = {}) {
  const out = {};
  for (const [k, v] of Object.entries(tree)) {
    out[k] = { ...v };
  }
  return out;
}

/**
 * Push managed workspace deliverables to the vault through the 4-gate Worker pool.
 */
export async function pushWorkspaceDeliverables({
  dshHome,
  vault,
  workspaceId,
  workspaceRoot,
  deviceLabel,
  minQuietMs = 1500,
  quotas,
}) {
  const stateFile = workspaceStatePath(dshHome, workspaceId);
  return withStateLock(stateFile, async () => {
    const absRoot = path.resolve(workspaceRoot);
    const effectiveQuotas = {
      ...DEFAULT_QUOTAS,
      ...(vault?.quotas ?? {}),
      ...(quotas ?? {}),
    };

    const state = await loadWorkspaceDeliverableState(dshHome, workspaceId);
    const canonicalRoot = await canonicalizeWorkspaceRoot(absRoot);
    const rootChanged = reconcileWorkspaceRoot(state, canonicalRoot);
    const candidateMap = new Map();

    // 1) Tracked paths from signals 1, 3, 4
    for (const [relPosix, meta] of Object.entries(state.trackedPaths)) {
      candidateMap.set(relPosix, { source: meta?.source || 'tool' });
    }
    // 2) Previously synced baseTree paths (to detect edits & deletions of pulled/published files)
    for (const relPosix of Object.keys(state.baseTree)) {
      if (!candidateMap.has(relPosix)) {
        candidateMap.set(relPosix, { source: 'base' });
      }
    }
    // 3) Auto-include outputs/**
    await collectOutputsCandidates(absRoot, candidateMap);

    // 4) Filter by git ls-files (except manual), conflict copies, and .dshsyncignore
    const gitTracked = await getGitTrackedFiles(absRoot);
    const gitLowerSet = new Set([...gitTracked].map((p) => p.toLowerCase()));
    const isIgnored = await loadDshSyncIgnore(absRoot);

    const warnings = [];
    const blocked = [];
    const deferred = [];
    const uploaded = [];
    const deleted = [];
    const filteredPaths = [];
    const seenCaseFold = new Map();

    for (const relPosix of [...candidateMap.keys()].sort()) {
      const meta = candidateMap.get(relPosix);
      if (meta.source !== 'manual' && isConflictCopyPath(relPosix)) {
        continue;
      }
      if (meta.source !== 'manual' && isPathInGitSet(relPosix, gitTracked, gitLowerSet)) {
        continue;
      }
      if (meta.source !== 'manual' && isIgnored(relPosix)) {
        continue;
      }

      // Case-folding collision guard (prevents Windows overwrite between Data.py and data.py)
      const lower = relPosix.toLowerCase();
      if (seenCaseFold.has(lower)) {
        const firstPath = seenCaseFold.get(lower);
        const warning = `Case-folding collision: skipping "${relPosix}" (collides with "${firstPath}")`;
        warnings.push(warning);
        blocked.push({ path: relPosix, reason: 'case-collision', detail: firstPath });
        continue;
      }
      seenCaseFold.set(lower, relPosix);
      filteredPaths.push(relPosix);
    }

    // 5) Inspect all candidates through bounded Worker pool (<= 2 workers)
    const inspectionResults = new Map();
    if (filteredPaths.length > 0) {
      const pool = createArtifactWorkerPool(Math.min(MAX_WORKER_POOL, filteredPaths.length));
      try {
        const jobs = filteredPaths.map(async (relPosix) => {
          const res = await pool.inspect({
            workspaceRoot: absRoot,
            relativePath: relPosix,
            maxFileBytes: effectiveQuotas.maxFileBytes,
            minQuietMs,
          });
          inspectionResults.set(relPosix, res);
        });
        await Promise.all(jobs);
      } finally {
        await pool.terminate();
      }
    }

    // 6) Build nextTree with strict quota, tombstone, and torn-file preservation semantics
    const nextTree = {};
    let totalWorkspaceBytes = 0;

    for (const relPosix of filteredPaths) {
      const res = inspectionResults.get(relPosix);
      const baseEntry = state.baseTree[relPosix];
      const lastPubEntry = state.lastPublishedTree[relPosix];

      if (res?.ok) {
        if (totalWorkspaceBytes + res.size > effectiveQuotas.maxWorkspaceBytes) {
          blocked.push({
            path: relPosix,
            reason: 'exceeds-max-workspace-bytes',
            size: res.size,
            maxWorkspaceBytes: effectiveQuotas.maxWorkspaceBytes,
          });
          if (baseEntry && !baseEntry.deleted) {
            nextTree[relPosix] = { ...baseEntry };
            totalWorkspaceBytes += baseEntry.size ?? 0;
          }
          continue;
        }
        totalWorkspaceBytes += res.size;

        const expectedStorageKey = typeof vault.storageKeyFor === 'function'
          ? vault.storageKeyFor(res.sha256)
          : null;
        const candidate =
          (lastPubEntry && !lastPubEntry.deleted && lastPubEntry.sha256 === res.sha256 && Boolean(lastPubEntry.executable) === Boolean(res.executable) && lastPubEntry.storageKey)
            ? lastPubEntry
            : (baseEntry && !baseEntry.deleted && baseEntry.sha256 === res.sha256 && Boolean(baseEntry.executable) === Boolean(res.executable) && baseEntry.storageKey)
              ? baseEntry
              : null;

        let reusable = null;
        if (
          candidate
          && (!expectedStorageKey || candidate.storageKey === expectedStorageKey)
          && (typeof vault.hasBlob !== 'function' || (await vault.hasBlob(candidate.storageKey)))
        ) {
          reusable = candidate;
        }

        if (reusable) {
          nextTree[relPosix] = {
            sha256: reusable.sha256,
            storageKey: reusable.storageKey,
            size: reusable.size,
            executable: Boolean(reusable.executable),
          };
        } else {
          const blob = await vault.putBlob(res.bytes);
          nextTree[relPosix] = {
            sha256: blob.sha256,
            storageKey: blob.storageKey,
            size: blob.size,
            executable: Boolean(res.executable),
          };
          uploaded.push(relPosix);
        }

        // Propagate unresolved Rule-3 conflict override lineage so the peer preserves its own
        // local version instead of silently overwriting it via Rule 2 on roundtrip.
        const override = state.conflictOverrides[relPosix];
        if (
          override
          && override.localSha === res.sha256
          && Array.isArray(override.overriddenShas)
          && override.overriddenShas.length > 0
        ) {
          nextTree[relPosix].conflictOverriddenSha = override.overriddenShas[override.overriddenShas.length - 1];
          nextTree[relPosix].conflictOverriddenShas = [...override.overriddenShas];
        } else if (override && override.localSha !== res.sha256) {
          delete state.conflictOverrides[relPosix];
        }
        continue;
      }

      if (res?.reason === 'not-found') {
        delete state.conflictOverrides[relPosix];
        if (baseEntry && !baseEntry.deleted) {
          nextTree[relPosix] = {
            deleted: true,
            previousSha256: baseEntry.sha256,
            deletedAt: Date.now(),
          };
          deleted.push(relPosix);
        } else if (lastPubEntry?.deleted) {
          nextTree[relPosix] = { ...lastPubEntry };
        }
        continue;
      }

      if (res?.retryable) {
        deferred.push({
          path: relPosix,
          reason: res.reason,
          retryable: true,
          ...(res.detail !== undefined ? { detail: res.detail } : {}),
        });
        // Preserve last intact version in baseTree — never emit false delete or overwrite good blob
        if (baseEntry && !baseEntry.deleted) {
          nextTree[relPosix] = { ...baseEntry };
          totalWorkspaceBytes += baseEntry.size ?? 0;
        }
        continue;
      }

      // Non-retryable security / filename / quota rejection
      blocked.push({
        path: relPosix,
        reason: res?.reason || 'blocked',
        ...(res?.detail !== undefined ? { detail: res.detail } : {}),
        ...(res?.size !== undefined ? { size: res.size } : {}),
      });
      if (baseEntry && !baseEntry.deleted) {
        nextTree[relPosix] = { ...baseEntry };
        totalWorkspaceBytes += baseEntry.size ?? 0;
      }
    }

    // Carry forward any previous tombstones for paths no longer in trackedPaths/baseTree
    for (const [relPosix, prevEntry] of Object.entries(state.lastPublishedTree)) {
      if (prevEntry?.deleted && !(relPosix in nextTree)) {
        nextTree[relPosix] = { ...prevEntry };
      }
    }

    const curVaultDir = typeof vault.vaultDir === 'string' ? vault.vaultDir : '';
    const curKeyFp = typeof vault._keyFingerprint === 'string' ? vault._keyFingerprint : '';
    const vaultContextChanged = Boolean(
      state.hasPublished
      && Object.keys(nextTree).length > 0
      && (
        (state.vaultDir && state.vaultDir !== curVaultDir)
        || (state.vaultKeyFingerprint && state.vaultKeyFingerprint !== curKeyFp)
      ),
    );
    let missingOwnCommit = false;
    if (
      state.hasPublished
      && !vaultContextChanged
      && treesEqual(nextTree, state.lastPublishedTree)
      && Object.keys(nextTree).length > 0
      && typeof vault.listCommits === 'function'
    ) {
      const ownListed = await vault.listCommits('workspace', { targetId: workspaceId, onlySelf: true }).catch(() => null);
      if (ownListed && ownListed.commits.length === 0) {
        missingOwnCommit = true;
      }
    }

    const hasSubstantiveChange =
      (!treesEqual(nextTree, state.lastPublishedTree) && (Object.keys(nextTree).length > 0 || state.hasPublished))
      || vaultContextChanged
      || missingOwnCommit;

    let commit = null;
    if (hasSubstantiveChange) {
      commit = await vault.publishCommit('workspace', workspaceId, {
        workspaceId,
        deviceLabel: deviceLabel || vault.deviceId,
        tree: nextTree,
      });
      state.lastPublishedTree = cloneTree(nextTree);
      state.hasPublished = true;
      state.vaultDir = curVaultDir;
      state.vaultKeyFingerprint = curKeyFp;
      for (const [p, entry] of Object.entries(nextTree)) {
        if (entry.deleted) {
          delete state.baseTree[p];
        } else {
          state.baseTree[p] = { ...entry };
        }
      }
      await saveWorkspaceDeliverableState(dshHome, workspaceId, state);
    } else if (rootChanged) {
      await saveWorkspaceDeliverableState(dshHome, workspaceId, state);
    }

    const openLocks = await detectOpenOfficeLocks(absRoot, filteredPaths);
    return {
      published: Boolean(commit),
      commit,
      tree: nextTree,
      uploaded,
      deleted,
      deferred,
      blocked,
      warnings,
      openLocks,
    };
  });
}

/**
 * Verify target write path has zero ancestor symlink/junction escape inside workspaceRoot.
 */
async function assertSafeWriteTarget(workspaceRoot, relPosix) {
  const absRoot = path.resolve(workspaceRoot);
  await fs.mkdir(absRoot, { recursive: true });
  const realRoot = await fs.realpath(absRoot);

  const segments = relPosix.split('/');
  let cursor = absRoot;

  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]);
    const isLeaf = i === segments.length - 1;
    let st;
    try {
      st = await fs.lstat(cursor);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        // Parent doesn't exist yet; nearest existing ancestor was already verified
        break;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      return { ok: false, reason: 'symlink-escaped', detail: segments[i] };
    }
    if (!isLeaf && !st.isDirectory()) {
      return { ok: false, reason: 'parent-not-directory', detail: segments[i] };
    }
    if (isLeaf && st.isDirectory()) {
      return { ok: false, reason: 'target-is-directory', detail: relPosix };
    }
    const realCursor = await fs.realpath(cursor);
    if (!isStrictlyInsideRoot(realRoot, realCursor)) {
      return { ok: false, reason: 'symlink-escaped', detail: relPosix };
    }
  }

  return { ok: true, targetPath: path.join(absRoot, ...segments) };
}

async function writeDeliverableAtomically(targetPath, bytes, executable = false) {
  await fs.chmod(targetPath, 0o666).catch(() => {});
  const mode = executable ? 0o755 : 0o644;
  await writeFileAtomic(targetPath, bytes, { mode });
  if (process.platform !== 'win32' && executable) {
    await fs.chmod(targetPath, 0o755).catch(() => {});
  }
}

async function pruneEmptyDirsUpward(startDir, stopDir) {
  const stopNorm = path.resolve(stopDir);
  let cursor = path.resolve(startDir);
  while (cursor !== stopNorm && cursor.startsWith(stopNorm)) {
    try {
      const entries = await fs.readdir(cursor);
      if (entries.length > 0) break;
      await fs.rmdir(cursor);
      cursor = path.dirname(cursor);
    } catch {
      break;
    }
  }
  // Also remove stopDir itself if completely empty
  try {
    const entries = await fs.readdir(stopNorm);
    if (entries.length === 0) {
      await fs.rmdir(stopNorm);
    }
  } catch {
    // ignore
  }
}

function extractConflictOverriddenShas(entry) {
  const out = new Set();
  if (typeof entry?.conflictOverriddenSha === 'string' && entry.conflictOverriddenSha) {
    out.add(entry.conflictOverriddenSha);
  }
  if (Array.isArray(entry?.conflictOverriddenShas)) {
    for (const s of entry.conflictOverriddenShas) {
      if (typeof s === 'string' && s) out.add(s);
    }
  }
  return out;
}

function recordConflictOverride(state, relPosix, localSha, remoteSha) {
  if (!localSha || !remoteSha) return;
  const prev = state.conflictOverrides[relPosix];
  const prevList = prev && prev.localSha === localSha && Array.isArray(prev.overriddenShas)
    ? prev.overriddenShas
    : [];
  const merged = [...new Set([...prevList, remoteSha])];
  state.conflictOverrides[relPosix] = {
    localSha,
    overriddenShas: merged,
  };
}

async function stageIncomingFile(workspaceRoot, relPosix, bytes, entryMeta, state, extraMeta = {}) {
  const incomingRoot = path.join(path.resolve(workspaceRoot), '.dsh-incoming');
  const incomingPath = path.join(incomingRoot, ...relPosix.split('/'));
  await writeFileAtomic(incomingPath, bytes, { mode: 0o644 });
  const baseEntry = state.baseTree[relPosix] ?? null;
  const expectedBaseSha = extraMeta.expectedBaseSha !== undefined
    ? extraMeta.expectedBaseSha
    : (baseEntry && !baseEntry.deleted ? baseEntry.sha256 : null);
  const overriddenShas = [...extractConflictOverriddenShas(entryMeta)];
  state.pendingIncoming[relPosix] = {
    sha256: entryMeta.sha256,
    storageKey: entryMeta.storageKey,
    size: entryMeta.size,
    executable: Boolean(entryMeta.executable),
    remoteLabel: extraMeta.remoteLabel || 'remote',
    commitTimestamp: extraMeta.commitTimestamp || Date.now(),
    expectedBaseSha,
    ...(overriddenShas.length > 0 ? {
      conflictOverriddenSha: overriddenShas[overriddenShas.length - 1],
      conflictOverriddenShas: overriddenShas,
    } : {}),
    stagedAt: Date.now(),
  };
  return incomingPath;
}

async function collectFilesRecursive(dirPath, relPrefix = '') {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = relPrefix ? `${relPrefix}/${entry.name.normalize('NFC')}` : entry.name.normalize('NFC');
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectFilesRecursive(full, rel));
    } else if (entry.isFile()) {
      out.push({ relPosix: rel, fullPath: full });
    }
  }
  return out;
}

async function drainIncomingFiles(workspaceRoot, state) {
  const incomingRoot = path.join(path.resolve(workspaceRoot), '.dsh-incoming');
  const stagedFiles = await collectFilesRecursive(incomingRoot);
  const drained = [];
  const stillStaged = [];
  const blocked = [];
  const conflicts = [];

  for (const { relPosix, fullPath } of stagedFiles) {
    const nameCheck = validateCrossOsRelativePath(relPosix);
    if (!nameCheck.ok) {
      blocked.push({ path: relPosix, reason: nameCheck.reason });
      continue;
    }
    const safeTarget = await assertSafeWriteTarget(workspaceRoot, relPosix);
    if (!safeTarget.ok) {
      blocked.push({ path: relPosix, reason: safeTarget.reason });
      continue;
    }

    if (await hasActiveOfficeLock(workspaceRoot, relPosix)) {
      stillStaged.push({ path: relPosix, incomingPath: fullPath, reason: 'office-lock' });
      continue;
    }

    let bytes;
    try {
      bytes = await fs.readFile(fullPath);
    } catch {
      continue;
    }

    let localExists = false;
    let localSha = null;
    let localLockedOnRead = false;
    try {
      const localBytes = await fs.readFile(safeTarget.targetPath);
      localExists = true;
      localSha = sha256Hex(localBytes);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        localExists = false;
      } else if (LOCK_IO_CODES.has(err?.code)) {
        localExists = true;
        localLockedOnRead = true;
      } else {
        throw err;
      }
    }

    if (localLockedOnRead) {
      stillStaged.push({ path: relPosix, incomingPath: fullPath, reason: 'file-locked' });
      continue;
    }

    const meta = state.pendingIncoming[relPosix];
    const stagedSha = meta?.sha256 || sha256Hex(bytes);
    const baseEntry = state.baseTree[relPosix] ?? null;
    const baseSha = (baseEntry && !baseEntry.deleted ? baseEntry.sha256 : null) ?? (meta?.expectedBaseSha ?? null);

    // 3-way conflict protection: if user modified & saved the local file while it was locked,
    // or remote entry was published by overriding localSha in a concurrent edit,
    // NEVER overwrite it! Write the staged remote version as a side-by-side conflict copy instead.
    const stagedOverridden = extractConflictOverriddenShas(meta);
    const stagedOverrodeLocal = localExists && localSha !== null && stagedOverridden.has(localSha);
    if (localExists && localSha !== stagedSha && (localSha !== baseSha || stagedOverrodeLocal)) {
      const conflictKey = `${relPosix}|${localSha}|${stagedSha}`;
      if (!state.resolvedConflicts[conflictKey]) {
        const { relPath: conflictRelPath, absPath: conflictAbsPath } = await allocateConflictCopyRelPath(
          workspaceRoot,
          relPosix,
          meta?.remoteLabel || 'remote',
          meta?.commitTimestamp || meta?.stagedAt || Date.now(),
        );
        await writeDeliverableAtomically(conflictAbsPath, bytes, Boolean(meta?.executable));
        state.resolvedConflicts[conflictKey] = {
          conflictPath: conflictRelPath,
          createdAt: Date.now(),
        };
        conflicts.push({
          path: relPosix,
          kind: 'both-modified',
          conflictPath: conflictRelPath,
          localSha,
          remoteSha: stagedSha,
        });
      }
      recordConflictOverride(state, relPosix, localSha, stagedSha);
      await fs.rm(fullPath, { force: true });
      await pruneEmptyDirsUpward(path.dirname(fullPath), incomingRoot);
      state.baseTree[relPosix] = {
        sha256: stagedSha,
        storageKey: meta?.storageKey || stagedSha,
        size: bytes.length,
        executable: Boolean(meta?.executable),
      };
      delete state.pendingIncoming[relPosix];
      continue;
    }

    try {
      if (!localExists || localSha !== stagedSha) {
        await writeDeliverableAtomically(safeTarget.targetPath, bytes, Boolean(meta?.executable));
      } else if (process.platform !== 'win32' && meta?.executable) {
        await fs.chmod(safeTarget.targetPath, 0o755).catch(() => {});
      }
      await fs.rm(fullPath, { force: true });
      await pruneEmptyDirsUpward(path.dirname(fullPath), incomingRoot);

      state.baseTree[relPosix] = {
        sha256: stagedSha,
        storageKey: meta?.storageKey || stagedSha,
        size: bytes.length,
        executable: Boolean(meta?.executable),
      };
      delete state.conflictOverrides[relPosix];
      delete state.pendingIncoming[relPosix];
      drained.push(relPosix);
    } catch (err) {
      if (LOCK_IO_CODES.has(err?.code)) {
        stillStaged.push({ path: relPosix, incomingPath: fullPath, reason: 'file-locked' });
      } else {
        throw err;
      }
    }
  }

  // Clean up any stale pendingIncoming metadata whose file no longer exists
  for (const relPosix of Object.keys(state.pendingIncoming)) {
    const checkPath = path.join(incomingRoot, ...relPosix.split('/'));
    try {
      await fs.stat(checkPath);
    } catch {
      delete state.pendingIncoming[relPosix];
    }
  }

  return { drained, stillStaged, blocked, conflicts };
}

function formatConflictTimestamp(tsMs) {
  const d = new Date(tsMs || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function sanitizeDeviceLabelForFilename(label) {
  const cleaned = String(label || 'remote')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[ .]+$/g, '')
    .trim();
  return cleaned || 'remote';
}

async function allocateConflictCopyRelPath(workspaceRoot, relPosix, remoteLabel, timestampMs) {
  const dir = path.posix.dirname(relPosix);
  const base = path.posix.basename(relPosix);
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const safeLabel = sanitizeDeviceLabelForFilename(remoteLabel);
  const stamp = formatConflictTimestamp(timestampMs);

  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const candidateBase = `${stem} (来自${safeLabel} ${stamp}${suffix})${ext}`;
    const candidateRel = dir === '.' ? candidateBase : `${dir}/${candidateBase}`;
    const candidateAbs = path.join(path.resolve(workspaceRoot), ...candidateRel.split('/'));
    try {
      await fs.lstat(candidateAbs);
      // already exists, try next suffix
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { relPath: candidateRel, absPath: candidateAbs };
      }
      throw err;
    }
  }
  const fallbackBase = `${stem} (来自${safeLabel} ${stamp}-${crypto.randomBytes(3).toString('hex')})${ext}`;
  const fallbackRel = dir === '.' ? fallbackBase : `${dir}/${fallbackBase}`;
  return {
    relPath: fallbackRel,
    absPath: path.join(path.resolve(workspaceRoot), ...fallbackRel.split('/')),
  };
}

async function pruneExpiredTrash(dshHome, workspaceId, retentionDays, nowMs = Date.now()) {
  const wsTrashRoot = path.join(resolveDshHome(dshHome), 'trash', encodeURIComponent(String(workspaceId)));
  const maxAgeMs = Math.max(0, Number(retentionDays ?? DEFAULT_QUOTAS.trashRetentionDays)) * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = await fs.readdir(wsTrashRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }

  let pruned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(wsTrashRoot, entry.name);
    let ts = Number(entry.name);
    if (!Number.isFinite(ts) || ts <= 0) {
      try {
        const st = await fs.stat(full);
        ts = st.mtimeMs;
      } catch {
        continue;
      }
    }
    if (nowMs - ts > maxAgeMs) {
      await fs.rm(full, { recursive: true, force: true });
      pruned += 1;
    }
  }
  return pruned;
}

async function moveFileToTrash(dshHome, workspaceId, relPosix, sourceAbsPath, retentionDays) {
  const ts = Date.now();
  const trashPath = path.join(
    resolveDshHome(dshHome),
    'trash',
    encodeURIComponent(String(workspaceId)),
    String(ts),
    ...relPosix.split('/'),
  );
  await fs.mkdir(path.dirname(trashPath), { recursive: true });
  await fs.chmod(sourceAbsPath, 0o666).catch(() => {});

  try {
    await fs.rename(sourceAbsPath, trashPath);
  } catch (err) {
    if (err?.code === 'EXDEV') {
      await fs.copyFile(sourceAbsPath, trashPath);
      await fs.rm(sourceAbsPath, { force: true });
    } else {
      throw err;
    }
  }

  await pruneExpiredTrash(dshHome, workspaceId, retentionDays, ts);
  return trashPath;
}

async function seedBaseTreeFromSessionOutputsState(dshHome, absRoot, state) {
  const outputsStatePath = path.join(soulSyncDir(dshHome), 'session-outputs-state.json');
  let rawState;
  try {
    rawState = JSON.parse(await fs.readFile(outputsStatePath, 'utf8'));
  } catch {
    return;
  }
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) return;

  // Map relPath (under outputs/) -> Set of known previously-synced sha256 values
  const knownByRel = new Map();
  for (const sessEntry of Object.values(rawState)) {
    if (!sessEntry || typeof sessEntry !== 'object') continue;
    for (const [relUnderOutputs, sha] of Object.entries(sessEntry)) {
      if (typeof relUnderOutputs !== 'string' || typeof sha !== 'string') continue;
      const normRel = relUnderOutputs.replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFC');
      if (!knownByRel.has(normRel)) knownByRel.set(normRel, new Set());
      knownByRel.get(normRel).add(sha.toLowerCase());
    }
  }
  if (knownByRel.size === 0) return;

  for (const [relUnderOutputs, shaSet] of knownByRel.entries()) {
    const fullRel = `outputs/${relUnderOutputs}`;
    if (state.baseTree[fullRel]) continue;
    const absFile = path.join(absRoot, 'outputs', ...relUnderOutputs.split('/'));
    try {
      const lst = await fs.lstat(absFile);
      if (lst.isSymbolicLink() || !lst.isFile()) continue;
      const bytes = await fs.readFile(absFile);
      const localSha = sha256Hex(bytes);
      if (shaSet.has(localSha)) {
        state.baseTree[fullRel] = {
          sha256: localSha,
          storageKey: null,
          size: bytes.length,
          executable: false,
        };
      }
    } catch {
      // File absent on disk
    }
  }
}

/**
 * Pull peer workspace deliverables from the vault and execute strict Base/Local/Remote 3-way merge.
 */
export async function pullWorkspaceDeliverables({
  dshHome,
  vault,
  workspaceId,
  workspaceRoot,
  trashRetentionDays,
}) {
  const stateFile = workspaceStatePath(dshHome, workspaceId);
  return withStateLock(stateFile, async () => {
    const absRoot = path.resolve(workspaceRoot);
    await fs.mkdir(absRoot, { recursive: true });
    const retentionDays = trashRetentionDays ?? vault?.quotas?.trashRetentionDays ?? DEFAULT_QUOTAS.trashRetentionDays;

    const state = await loadWorkspaceDeliverableState(dshHome, workspaceId);
    const canonicalRoot = await canonicalizeWorkspaceRoot(absRoot);
    const rootChanged = reconcileWorkspaceRoot(state, canonicalRoot);

    // Seed empty workspace baseTree from prior unmapped session-outputs-state.json so promoting
    // an auto-mirror workspace to an explicit mapping never triggers false Rule-3 conflicts on outputs/.
    if (
      !state.hasPublished
      && Object.keys(state.baseTree).length === 0
      && Object.keys(state.lastPulledCommits).length === 0
    ) {
      await seedBaseTreeFromSessionOutputsState(dshHome, absRoot, state);
    }

    const applied = [];
    const conflicts = [];
    const trashed = [];
    const warnings = [];
    const blocked = [];

    // Step 0: Drain previously locked files from .dsh-incoming/**
    const drainRes = await drainIncomingFiles(absRoot, state);
    const drainedIncoming = [...drainRes.drained];
    applied.push(...drainRes.drained);
    blocked.push(...drainRes.blocked);
    conflicts.push(...drainRes.conflicts);
    const stagedMap = new Map(drainRes.stillStaged.map((s) => [s.path, s]));

    // Step 1: Discover latest commit per peer device
    const { commits, pendingCount } = await vault.listCommits('workspace', {
      targetId: workspaceId,
      includeSelf: false,
    });

    if (commits.length === 0) {
      if (rootChanged || drainedIncoming.length > 0 || drainRes.conflicts.length > 0) {
        await saveWorkspaceDeliverableState(dshHome, workspaceId, state);
      }
      return {
        status: pendingCount > 0 ? 'pending-hydration' : ((drainedIncoming.length > 0 || drainRes.conflicts.length > 0) ? 'synced' : 'up-to-date'),
        applied,
        drainedIncoming,
        stagedIncoming: [...stagedMap.values()],
        conflicts,
        trashed,
        blocked,
        warnings,
        pendingCount,
      };
    }

    // Keep only the latest commit per peer device, ordered oldest -> newest
    const latestByDevice = new Map();
    for (const c of commits) {
      latestByDevice.set(c.deviceId, c);
    }
    const orderedCommits = [...latestByDevice.values()].sort(
      (a, b) => (a.timestamp - b.timestamp) || (a.seq - b.seq) || String(a.deviceId).localeCompare(String(b.deviceId)),
    );

    let processedAnyCommit = false;

    for (const commit of orderedCommits) {
      if (state.lastPulledCommits[commit.deviceId] === commit.filename) {
        continue;
      }

      const remoteTree = commit.payload?.tree && typeof commit.payload.tree === 'object'
        ? commit.payload.tree
        : {};
      const remoteLabel = commit.payload?.deviceLabel || commit.deviceId;

      // Step 2: Verify all referenced blobs are hydrated & intact before touching local disk
      const blobRefs = [];
      for (const entry of Object.values(remoteTree)) {
        if (entry && !entry.deleted && entry.storageKey) {
          blobRefs.push({
            storageKey: entry.storageKey,
            sha256: entry.sha256,
            size: entry.size,
          });
        }
      }
      const verify = await vault.verifyCommitBlobs(blobRefs);
      if (!verify.ready) {
        await saveWorkspaceDeliverableState(dshHome, workspaceId, state);
        return {
          status: 'pending-hydration',
          reason: verify.reason,
          storageKey: verify.storageKey,
          detail: verify.detail,
          applied,
          drainedIncoming,
          stagedIncoming: [...stagedMap.values()],
          conflicts,
          trashed,
          blocked,
          warnings,
          pendingCount: pendingCount + 1,
        };
      }

      // Step 3: Base / Local / Remote 3-way merge
      let stagedInThisCommit = 0;

      for (const relPosix of Object.keys(remoteTree).sort()) {
        const remoteEntry = remoteTree[relPosix];
        if (!remoteEntry || typeof remoteEntry !== 'object') continue;

        const nameCheck = validateCrossOsRelativePath(relPosix);
        if (!nameCheck.ok) {
          blocked.push({ path: relPosix, reason: nameCheck.reason });
          continue;
        }
        const pathBlock = checkBlockedRelativePath(relPosix);
        if (pathBlock.blocked) {
          blocked.push({ path: relPosix, reason: pathBlock.reason });
          continue;
        }

        const safeTarget = await assertSafeWriteTarget(absRoot, relPosix);
        if (!safeTarget.ok) {
          blocked.push({ path: relPosix, reason: safeTarget.reason, detail: safeTarget.detail });
          continue;
        }
        const targetPath = safeTarget.targetPath;

        // Inspect local state
        let localExists = false;
        let localSha = null;
        let localLockedOnRead = false;
        try {
          const localBytes = await fs.readFile(targetPath);
          localExists = true;
          localSha = sha256Hex(localBytes);
        } catch (err) {
          if (err?.code === 'ENOENT') {
            localExists = false;
          } else if (LOCK_IO_CODES.has(err?.code)) {
            localExists = true;
            localLockedOnRead = true;
          } else {
            throw err;
          }
        }

        const baseEntry = state.baseTree[relPosix] ?? null;
        const baseSha = baseEntry && !baseEntry.deleted ? baseEntry.sha256 : null;

        // Rule 4: Remote Tombstone (Deletion)
        if (remoteEntry.deleted) {
          if (!localExists) {
            delete state.baseTree[relPosix];
            delete state.conflictOverrides[relPosix];
            continue;
          }
          if (!localLockedOnRead && baseSha !== null && localSha === baseSha) {
            // Unmodified locally -> soft-delete into <dshHome>/trash/
            const trashPath = await moveFileToTrash(dshHome, workspaceId, relPosix, targetPath, retentionDays);
            delete state.baseTree[relPosix];
            delete state.conflictOverrides[relPosix];
            trashed.push({ path: relPosix, trashPath });
          } else {
            // Modify-delete conflict -> conservatively preserve local modified file (idempotent across commits)
            delete state.baseTree[relPosix];
            delete state.conflictOverrides[relPosix];
            const delConflictKey = `${relPosix}|${localSha ?? 'locked'}|DELETED:${remoteEntry.previousSha256 ?? ''}`;
            if (!state.resolvedConflicts[delConflictKey]) {
              state.resolvedConflicts[delConflictKey] = {
                kind: 'modify-delete',
                createdAt: Date.now(),
              };
              conflicts.push({
                path: relPosix,
                kind: 'modify-delete',
                localSha,
                remoteDeleted: true,
              });
            }
          }
          continue;
        }

        // Rule 1: Remote === Base -> do not touch Local
        if (
          baseSha !== null
          && baseSha === remoteEntry.sha256
          && Boolean(baseEntry.executable) === Boolean(remoteEntry.executable)
        ) {
          continue;
        }

        // Convergent identical edit: Local already matches Remote
        if (localExists && !localLockedOnRead && localSha === remoteEntry.sha256) {
          if (process.platform !== 'win32' && remoteEntry.executable) {
            await fs.chmod(targetPath, 0o755).catch(() => {});
          }
          state.baseTree[relPosix] = {
            sha256: remoteEntry.sha256,
            storageKey: remoteEntry.storageKey,
            size: remoteEntry.size,
            executable: Boolean(remoteEntry.executable),
          };
          delete state.conflictOverrides[relPosix];
          continue;
        }

        // If local already preserved `localSha` over `remoteEntry.sha256` in a prior Rule-3 conflict,
        // never fast-forward backwards when the peer later publishes an unrelated file in the same workspace.
        const existingOverride = state.conflictOverrides[relPosix];
        const alreadyOverrodeRemote = Boolean(
          localExists
          && !localLockedOnRead
          && localSha !== null
          && existingOverride
          && existingOverride.localSha === localSha
          && Array.isArray(existingOverride.overriddenShas)
          && existingOverride.overriddenShas.includes(remoteEntry.sha256),
        );
        if (alreadyOverrodeRemote) {
          continue;
        }

        // Check whether this remote version was published by overriding our current local version
        // during an unresolved concurrent edit (Opus C5). If so, we MUST NOT fast-forward via Rule 2;
        // treat it as a Rule-3 conflict on our side too so our local version stays intact!
        const remoteOverriddenShas = extractConflictOverriddenShas(remoteEntry);
        const remoteOverrodeLocal = Boolean(
          localExists
          && !localLockedOnRead
          && localSha !== null
          && remoteOverriddenShas.has(localSha),
        );

        // Rule 2: Local === Base (or both absent / local absent) -> Fast-forward remote update
        const localUnmodified = (!localExists) || (!localLockedOnRead && baseSha !== null && localSha === baseSha);
        if (!remoteOverrodeLocal && (localUnmodified || localLockedOnRead)) {
          const bytes = await vault.getBlob(remoteEntry.storageKey, remoteEntry.sha256, remoteEntry.size);
          const locked = localLockedOnRead || await hasActiveOfficeLock(absRoot, relPosix);
          if (locked) {
            const incomingPath = await stageIncomingFile(absRoot, relPosix, bytes, remoteEntry, state, {
              remoteLabel,
              commitTimestamp: commit.timestamp,
              expectedBaseSha: baseSha,
            });
            stagedMap.set(relPosix, { path: relPosix, incomingPath, reason: 'office-lock' });
            stagedInThisCommit += 1;
            // Do NOT advance baseTree[relPosix] so unlock + next pull lands cleanly
            continue;
          }

          try {
            await writeDeliverableAtomically(targetPath, bytes, Boolean(remoteEntry.executable));
            state.baseTree[relPosix] = {
              sha256: remoteEntry.sha256,
              storageKey: remoteEntry.storageKey,
              size: remoteEntry.size,
              executable: Boolean(remoteEntry.executable),
            };
            delete state.conflictOverrides[relPosix];
            delete state.pendingIncoming[relPosix];
            stagedMap.delete(relPosix);
            applied.push(relPosix);
          } catch (err) {
            if (LOCK_IO_CODES.has(err?.code)) {
              const incomingPath = await stageIncomingFile(absRoot, relPosix, bytes, remoteEntry, state, {
                remoteLabel,
                commitTimestamp: commit.timestamp,
                expectedBaseSha: baseSha,
              });
              stagedMap.set(relPosix, { path: relPosix, incomingPath, reason: 'file-locked' });
              stagedInThisCommit += 1;
            } else {
              throw err;
            }
          }
          continue;
        }

        // Rule 3: Dual Modification Conflict (Local !== Base && Remote !== Base && Local !== Remote,
        // or Remote explicitly carries conflictOverriddenSha === localSha from a concurrent edit)
        // Preserve local file untouched; write remote copy alongside once per (path, localSha, remoteSha)
        const conflictKey = `${relPosix}|${localSha}|${remoteEntry.sha256}`;
        if (!state.resolvedConflicts[conflictKey]) {
          const bytes = await vault.getBlob(remoteEntry.storageKey, remoteEntry.sha256, remoteEntry.size);
          const { relPath: conflictRelPath, absPath: conflictAbsPath } = await allocateConflictCopyRelPath(
            absRoot,
            relPosix,
            remoteLabel,
            commit.timestamp,
          );
          await writeDeliverableAtomically(conflictAbsPath, bytes, Boolean(remoteEntry.executable));
          state.resolvedConflicts[conflictKey] = {
            conflictPath: conflictRelPath,
            createdAt: Date.now(),
          };
          conflicts.push({
            path: relPosix,
            kind: 'both-modified',
            conflictPath: conflictRelPath,
            localSha,
            remoteSha: remoteEntry.sha256,
          });
        }
        // Record override lineage so our next push informs peers (and prevents backwards overwrite)
        recordConflictOverride(state, relPosix, localSha, remoteEntry.sha256);
        // Advance baseTree[relPosix] to Remote so subsequent pulls do not regenerate duplicate conflict copies;
        // lastPublishedTree[relPosix] remains at localSha (when already published) so we do NOT infinitely re-push!
        state.baseTree[relPosix] = {
          sha256: remoteEntry.sha256,
          storageKey: remoteEntry.storageKey,
          size: remoteEntry.size,
          executable: Boolean(remoteEntry.executable),
        };
      }

      if (stagedInThisCommit === 0) {
        state.lastPulledCommits[commit.deviceId] = commit.filename;
      }
      processedAnyCommit = true;
    }

    await saveWorkspaceDeliverableState(dshHome, workspaceId, state);

    const changed = processedAnyCommit || drainedIncoming.length > 0 || drainRes.conflicts.length > 0;
    return {
      status: changed ? 'synced' : 'up-to-date',
      applied,
      drainedIncoming,
      stagedIncoming: [...stagedMap.values()],
      conflicts,
      trashed,
      blocked,
      warnings,
      pendingCount,
    };
  });
}
