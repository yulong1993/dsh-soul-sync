import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isMainThread, parentPort } from 'node:worker_threads';

import { DEFAULT_QUOTAS } from './config.js';

export const BLACKLIST_DIRS = Object.freeze(new Set([
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'node_modules',
  '.work',
  '.dsh-incoming',
]));

const ILLEGAL_WIN_CHARS_RE = /[<>:"|?*\x00-\x1f]/;
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const LOCK_IO_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

const OOXML_EXTS = new Set(['.xlsx', '.xlsm', '.docx', '.pptx']);
const ZIP_LOCAL_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
const ZIP_EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);  // PK\x05\x06
const ZIP_EOCD_TAIL_WINDOW = 65557;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CRC = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const PARQUET_MAGIC = Buffer.from('PAR1', 'ascii');
const PDF_HEADER_TOKEN = Buffer.from('%PDF-', 'ascii');
const PDF_EOF_TOKEN = Buffer.from('%%EOF', 'ascii');

const SECRET_SCAN_EXTS = new Set([
  '.py', '.js', '.ts', '.mjs', '.cjs', '.json', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.sh', '.ps1', '.md', '.txt', '.sql', '.r',
]);

const SECRET_PATTERNS = [
  { name: 'sk-api-key', regex: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-pat', regex: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'private-key-pem', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'hardcoded-secret-assignment',
    regex: /(?:api[_-]?key|secret[_-]?key|access[_-]?token|password|passwd)\s*[:=]\s*['"][A-Za-z0-9+/=._-]{16,}['"]/i,
  },
];

function normalizeForContainment(absPath) {
  let normalized = path.resolve(absPath).normalize('NFC');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  const root = path.parse(normalized).root;
  if (normalized.length > root.length && normalized.endsWith(path.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function isStrictlyInsideRoot(realRoot, realTarget) {
  const normRoot = normalizeForContainment(realRoot);
  const normTarget = normalizeForContainment(realTarget);
  if (normTarget === normRoot) return false;
  const prefix = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`;
  return normTarget.startsWith(prefix);
}

/**
 * Validate a relative POSIX path for cross-OS (Windows + macOS + Linux) legality.
 * Rejects Windows-illegal characters, trailing spaces/periods, reserved device names,
 * empty/dot/traversal segments, and absolute paths.
 */
export function validateCrossOsRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { ok: false, reason: 'illegal-cross-os-filename', detail: 'empty-path' };
  }
  const normalized = relativePath.normalize('NFC').replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.endsWith('/')) {
    return { ok: false, reason: 'illegal-cross-os-filename', detail: normalized };
  }
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      return { ok: false, reason: 'illegal-cross-os-filename', detail: seg || 'empty-segment' };
    }
    if (ILLEGAL_WIN_CHARS_RE.test(seg)) {
      return { ok: false, reason: 'illegal-cross-os-filename', detail: seg };
    }
    if (seg.endsWith(' ') || seg.endsWith('.')) {
      return { ok: false, reason: 'illegal-cross-os-filename', detail: seg };
    }
    const dotIdx = seg.indexOf('.');
    const stem = (dotIdx === -1 ? seg : seg.slice(0, dotIdx)).replace(/[ .]+$/, '');
    if (WINDOWS_RESERVED_NAME_RE.test(stem)) {
      return { ok: false, reason: 'illegal-cross-os-filename', detail: seg };
    }
  }
  return { ok: true, normalized, segments };
}

/**
 * Hard path & filename blacklist (highest priority security & noise gate).
 */
export function checkBlockedRelativePath(relativePath) {
  const normalized = String(relativePath ?? '').normalize('NFC').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return { blocked: true, reason: 'blocked-path', detail: 'empty-path' };
  }

  for (const seg of segments) {
    if (BLACKLIST_DIRS.has(seg.toLowerCase())) {
      return { blocked: true, reason: 'blocked-directory', detail: seg };
    }
  }

  const base = segments[segments.length - 1];
  const lower = base.toLowerCase();

  // .env and .env.* (allowing only .env.example and .env.sample)
  if (lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example' && lower !== '.env.sample')) {
    return { blocked: true, reason: 'blocked-sensitive-file', detail: base };
  }

  // secret / credential in filename (case-insensitive)
  if (lower.includes('secret') || lower.includes('credential')) {
    return { blocked: true, reason: 'blocked-sensitive-file', detail: base };
  }

  // Certificates, private keys, and auth rc files
  if (
    lower.endsWith('.pem')
    || lower.endsWith('.key')
    || lower.endsWith('.p12')
    || lower.endsWith('.pfx')
    || lower.startsWith('id_rsa')
    || lower.startsWith('id_ed25519')
    || lower === '.npmrc'
    || lower === '.pypirc'
    || lower === '.netrc'
  ) {
    return { blocked: true, reason: 'blocked-sensitive-file', detail: base };
  }

  // Lock files and SQLite transient files
  if (
    base.startsWith('~$')
    || (base.startsWith('.~lock.') && base.endsWith('#'))
    || lower.endsWith('.sqlite-wal')
    || lower.endsWith('.sqlite-shm')
    || lower.endsWith('.sqlite-journal')
  ) {
    return { blocked: true, reason: 'blocked-lock-file', detail: base };
  }

  // OS junk files
  if (lower === '.ds_store' || lower === 'thumbs.db') {
    return { blocked: true, reason: 'blocked-system-junk', detail: base };
  }

  return { blocked: false };
}

/**
 * Gate 3: Container header & trailer integrity verification.
 */
export function verifyContainerTrailer(relativePath, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const ext = path.posix.extname(String(relativePath)).toLowerCase();

  if (OOXML_EXTS.has(ext)) {
    if (buf.length < 4) {
      return { ok: false, reason: 'torn-container', retryable: true, detail: `${ext}:too-short` };
    }
    const head = buf.subarray(0, 4);
    const validHeader = head.equals(ZIP_LOCAL_SIG) || head.equals(ZIP_EOCD_SIG);
    if (!validHeader) {
      return { ok: false, reason: 'torn-container', retryable: true, detail: `${ext}:bad-zip-header` };
    }
    const tailStart = Math.max(0, buf.length - ZIP_EOCD_TAIL_WINDOW);
    const eocdIdx = buf.lastIndexOf(ZIP_EOCD_SIG);
    if (eocdIdx === -1 || eocdIdx < tailStart) {
      return { ok: false, reason: 'torn-container', retryable: true, detail: `${ext}:missing-eocd` };
    }
    return { ok: true };
  }

  if (ext === '.pdf') {
    const head = buf.subarray(0, Math.min(1024, buf.length));
    const tail = buf.subarray(Math.max(0, buf.length - 1024));
    if (head.indexOf(PDF_HEADER_TOKEN) === -1 || tail.indexOf(PDF_EOF_TOKEN) === -1) {
      return { ok: false, reason: 'torn-container', retryable: true, detail: '.pdf:missing-header-or-eof' };
    }
    return { ok: true };
  }

  if (ext === '.png') {
    if (buf.length < 16) {
      return { ok: false, reason: 'torn-container', retryable: true, detail: '.png:too-short' };
    }
    const head = buf.subarray(0, 8);
    const tail = buf.subarray(buf.length - 8);
    if (!head.equals(PNG_MAGIC) || !tail.equals(PNG_IEND_CRC)) {
      return { ok: false, reason: 'torn-container', retryable: true, detail: '.png:missing-magic-or-iend' };
    }
    return { ok: true };
  }

  if (ext === '.parquet') {
    if (buf.length < 12) {
      return { ok: false, reason: 'torn-container', retryable: true, detail: '.parquet:too-short' };
    }
    const head = buf.subarray(0, 4);
    const tail = buf.subarray(buf.length - 4);
    if (!head.equals(PARQUET_MAGIC) || !tail.equals(PARQUET_MAGIC)) {
      return { ok: false, reason: 'torn-container', retryable: true, detail: '.parquet:missing-par1' };
    }
    return { ok: true };
  }

  return { ok: true };
}

/**
 * Gate 4b: Text credential & secret pattern scan.
 */
export function scanTextForSecrets(relativePath, bytes) {
  const ext = path.posix.extname(String(relativePath)).toLowerCase();
  if (!SECRET_SCAN_EXTS.has(ext)) {
    return { ok: true };
  }
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : Buffer.from(bytes).toString('utf8');
  for (const rule of SECRET_PATTERNS) {
    if (rule.regex.test(text)) {
      return { ok: false, reason: 'secret-detected', detail: rule.name };
    }
  }
  return { ok: true };
}

/**
 * Run all 4 safety gates against a workspace file before upload.
 *
 * @param {{
 *   workspaceRoot: string,
 *   relativePath: string,
 *   maxFileBytes?: number,
 *   minQuietMs?: number,
 * }} params
 */
export async function inspectWorkspaceFile({
  workspaceRoot,
  relativePath,
  maxFileBytes = DEFAULT_QUOTAS.maxFileBytes,
  minQuietMs = 1500,
}) {
  // Pre-stat Gate 4a: Cross-OS filename legality & hard path blacklist
  const nameCheck = validateCrossOsRelativePath(relativePath);
  if (!nameCheck.ok) {
    return nameCheck;
  }
  const { normalized: relPosix, segments } = nameCheck;

  const blockCheck = checkBlockedRelativePath(relPosix);
  if (blockCheck.blocked) {
    return { ok: false, reason: blockCheck.reason, detail: blockCheck.detail };
  }

  // Gate 1: Physical boundary, symlink/junction escape & hardlink guard
  let realWorkspaceRoot;
  try {
    realWorkspaceRoot = await fs.realpath(path.resolve(workspaceRoot));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: false, reason: 'not-found' };
    }
    throw err;
  }

  let cursor = path.resolve(workspaceRoot);
  let stBefore = null;
  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    let st;
    try {
      st = await fs.lstat(cursor, { bigint: true });
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        return { ok: false, reason: 'not-found' };
      }
      if (LOCK_IO_CODES.has(err?.code)) {
        return { ok: false, reason: 'file-locked', retryable: true };
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      return { ok: false, reason: 'symlink-escaped', detail: seg };
    }
    stBefore = st;
  }

  if (!stBefore || !stBefore.isFile()) {
    return { ok: false, reason: 'not-a-file' };
  }
  if (stBefore.nlink > 1n) {
    return { ok: false, reason: 'hardlink-rejected', nlink: Number(stBefore.nlink) };
  }

  let realTarget;
  try {
    realTarget = await fs.realpath(cursor);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: false, reason: 'not-found' };
    }
    if (LOCK_IO_CODES.has(err?.code)) {
      return { ok: false, reason: 'file-locked', retryable: true };
    }
    throw err;
  }
  if (!isStrictlyInsideRoot(realWorkspaceRoot, realTarget)) {
    return { ok: false, reason: 'symlink-escaped', detail: relPosix };
  }

  // Gate 2: File size quota & quiet-window / concurrent-write stability guard
  const size = Number(stBefore.size);
  if (size > maxFileBytes) {
    return { ok: false, reason: 'exceeds-max-file-bytes', size };
  }
  if (minQuietMs > 0 && Date.now() - Number(stBefore.mtimeMs) < minQuietMs) {
    return { ok: false, reason: 'file-still-changing', retryable: true };
  }

  let bytes;
  try {
    bytes = await fs.readFile(cursor);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: false, reason: 'not-found' };
    }
    if (LOCK_IO_CODES.has(err?.code)) {
      return { ok: false, reason: 'file-locked', retryable: true };
    }
    throw err;
  }

  let stAfter;
  try {
    stAfter = await fs.lstat(cursor, { bigint: true });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: false, reason: 'torn-concurrent-write', retryable: true };
    }
    if (LOCK_IO_CODES.has(err?.code)) {
      return { ok: false, reason: 'file-locked', retryable: true };
    }
    throw err;
  }

  if (stAfter.isSymbolicLink()) {
    return { ok: false, reason: 'symlink-escaped', detail: relPosix };
  }
  if (stAfter.nlink > 1n) {
    return { ok: false, reason: 'hardlink-rejected', nlink: Number(stAfter.nlink) };
  }
  if (
    !stAfter.isFile()
    || stAfter.dev !== stBefore.dev
    || stAfter.ino !== stBefore.ino
    || stAfter.size !== stBefore.size
    || stAfter.mtimeNs !== stBefore.mtimeNs
    || BigInt(bytes.length) !== stBefore.size
  ) {
    return { ok: false, reason: 'torn-concurrent-write', retryable: true };
  }

  // Gate 3: Container trailer integrity check
  const trailerCheck = verifyContainerTrailer(relPosix, bytes);
  if (!trailerCheck.ok) {
    return trailerCheck;
  }

  // Gate 4b: Text secret pattern scan
  const secretCheck = scanTextForSecrets(relPosix, bytes);
  if (!secretCheck.ok) {
    return secretCheck;
  }

  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    ok: true,
    sha256,
    size: bytes.length,
    executable: (Number(stBefore.mode) & 0o111) !== 0,
    bytes,
  };
}

// Worker thread message loop when spawned via node:worker_threads
if (!isMainThread && parentPort) {
  parentPort.on('message', async (message) => {
    const id = message?.id;
    const payload = message?.payload ?? message;
    try {
      const result = await inspectWorkspaceFile(payload);
      if (result?.ok && result.bytes instanceof Uint8Array) {
        const buf = result.bytes;
        const transferList =
          buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
            ? [buf.buffer]
            : [];
        parentPort.postMessage({ id, result }, transferList);
      } else {
        parentPort.postMessage({ id, result });
      }
    } catch (err) {
      parentPort.postMessage({
        id,
        result: {
          ok: false,
          reason: 'worker-error',
          detail: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });
}
