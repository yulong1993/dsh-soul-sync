import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_QUOTAS, writeFileAtomic } from './config.js';

const ENVELOPE_MAGIC = Buffer.from('DSHSOUL1', 'ascii'); // 8 bytes
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_HEADER_BYTES = ENVELOPE_MAGIC.length + IV_BYTES + AUTH_TAG_BYTES; // 36 bytes

const VALID_COMMIT_KINDS = new Set(['session', 'workspace', 'global']);
const HEX_64_RE = /^[0-9a-f]{64}$/i;

export class VaultHydrationPendingError extends Error {
  constructor(message, { storageKey = null, reason = 'hydration-pending', cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'VaultHydrationPendingError';
    this.code = 'VAULT_HYDRATION_PENDING';
    this.storageKey = storageKey;
    this.reason = reason;
  }
}

export class VaultIntegrityError extends Error {
  constructor(message, { storageKey = null, reason = 'integrity-error', cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'VaultIntegrityError';
    this.code = 'VAULT_INTEGRITY_ERROR';
    this.storageKey = storageKey;
    this.reason = reason;
  }
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeSecretKeys(secretKeys) {
  if (!secretKeys) return null;
  const encKey = Buffer.isBuffer(secretKeys.encKey)
    ? secretKeys.encKey
    : typeof secretKeys.encKeyHex === 'string'
      ? Buffer.from(secretKeys.encKeyHex, 'hex')
      : null;
  const hmacKey = Buffer.isBuffer(secretKeys.hmacKey)
    ? secretKeys.hmacKey
    : typeof secretKeys.hmacKeyHex === 'string'
      ? Buffer.from(secretKeys.hmacKeyHex, 'hex')
      : null;

  if (!encKey || encKey.length !== 32 || !hmacKey || hmacKey.length !== 32) {
    throw new TypeError('secretKeys must provide 32-byte encKey and hmacKey');
  }
  return { encKey, hmacKey };
}

function collectReferencedStorageKeys(value, outSet) {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferencedStorageKeys(item, outSet);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if ((k === 'storageKey' || k === 'blobStorageKey') && typeof v === 'string' && HEX_64_RE.test(v)) {
      outSet.add(v.toLowerCase());
    } else if (v !== null && typeof v === 'object') {
      collectReferencedStorageKeys(v, outSet);
    }
  }
}

async function fileExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export class VaultStore {
  /**
   * @param {{
   *   vaultDir: string,
   *   deviceId: string,
   *   platform?: string,
   *   secretKeys?: { encKey?: Buffer, hmacKey?: Buffer, encKeyHex?: string, hmacKeyHex?: string } | null,
   *   quotas?: Partial<typeof DEFAULT_QUOTAS>,
   * }} options
   */
  constructor({ vaultDir, deviceId, platform = process.platform, secretKeys = null, quotas = DEFAULT_QUOTAS }) {
    if (typeof vaultDir !== 'string' || vaultDir.trim().length === 0) {
      throw new TypeError('VaultStore requires a non-empty vaultDir');
    }
    if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
      throw new TypeError('VaultStore requires a non-empty deviceId');
    }

    this.vaultDir = path.resolve(vaultDir);
    this.deviceId = deviceId;
    this.platform = platform;
    this.secretKeys = normalizeSecretKeys(secretKeys);
    this.encrypted = this.secretKeys !== null;
    this.quotas = { ...DEFAULT_QUOTAS, ...(quotas ?? {}) };
    this._seq = 0;
    this._keyFingerprint = this.secretKeys
      ? sha256Hex(Buffer.concat([this.secretKeys.encKey, this.secretKeys.hmacKey])).slice(0, 16)
      : 'plain';
    this._commitCache = new Map();
  }

  clearCommitCache() {
    this._commitCache.clear();
  }

  _encrypt(plainBuffer) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.secretKeys.encKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([ENVELOPE_MAGIC, iv, authTag, ciphertext]);
  }

  _decrypt(rawBuffer, storageKey = null) {
    if (rawBuffer.length < ENVELOPE_HEADER_BYTES) {
      throw new VaultIntegrityError('Encrypted blob is truncated below envelope header size', {
        storageKey,
        reason: 'truncated-envelope',
      });
    }
    if (!rawBuffer.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
      throw new VaultIntegrityError('Encrypted blob has invalid magic header', {
        storageKey,
        reason: 'invalid-magic',
      });
    }
    const iv = rawBuffer.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + IV_BYTES);
    const authTag = rawBuffer.subarray(ENVELOPE_MAGIC.length + IV_BYTES, ENVELOPE_HEADER_BYTES);
    const ciphertext = rawBuffer.subarray(ENVELOPE_HEADER_BYTES);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.secretKeys.encKey, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      throw new VaultIntegrityError('AES-256-GCM authentication or decryption failed', {
        storageKey,
        reason: 'gcm-auth-failed',
        cause: err,
      });
    }
  }

  _storageKeyFor(plainSha256) {
    const lower = String(plainSha256 ?? '').toLowerCase();
    if (!this.encrypted) return lower;
    return crypto
      .createHmac('sha256', this.secretKeys.hmacKey)
      .update(lower, 'utf8')
      .digest('hex');
  }

  /**
   * Public helper: compute the exact vault `storageKey` for a plaintext SHA-256 hex digest
   * under this VaultStore's current encryption mode & key.
   */
  storageKeyFor(plainSha256Hex) {
    return this._storageKeyFor(plainSha256Hex);
  }

  /**
   * Public helper: return true iff the content-addressed blob for `storageKey` exists on disk
   * with non-zero size and no `.icloud` evicted placeholder.
   */
  async hasBlob(storageKey) {
    if (typeof storageKey !== 'string' || !HEX_64_RE.test(storageKey)) {
      return false;
    }
    const targetPath = this._blobPath(storageKey);
    const icloudPath = this._icloudPlaceholderPath(targetPath);
    if (await fileExists(icloudPath)) {
      return false;
    }
    try {
      const st = await fs.stat(targetPath);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }

  _blobPath(storageKey) {
    if (typeof storageKey !== 'string' || !HEX_64_RE.test(storageKey)) {
      throw new VaultIntegrityError(`Invalid storageKey format: ${String(storageKey)}`, {
        storageKey: String(storageKey),
        reason: 'invalid-storage-key',
      });
    }
    const lower = storageKey.toLowerCase();
    return path.join(this.vaultDir, 'blobs', 'sha256', lower.slice(0, 2), lower);
  }

  _icloudPlaceholderPath(targetPath) {
    return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.icloud`);
  }

  /**
   * Store a content-addressed blob idempotently (encrypted when `secretKeys` is configured).
   *
   * @param {Buffer | Uint8Array} plainBuffer
   * @returns {Promise<{ sha256: string, storageKey: string, size: number }>}
   */
  async putBlob(plainBuffer) {
    const buf = Buffer.isBuffer(plainBuffer) ? plainBuffer : Buffer.from(plainBuffer);
    const sha256 = sha256Hex(buf);
    const storageKey = this._storageKeyFor(sha256);
    const size = buf.length;
    const targetPath = this._blobPath(storageKey);

    try {
      const st = await fs.stat(targetPath);
      if (st.isFile() && st.size > 0) {
        return { sha256, storageKey, size };
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const storedBytes = this.encrypted ? this._encrypt(buf) : buf;
    await writeFileAtomic(targetPath, storedBytes, { mode: 0o600 });
    return { sha256, storageKey, size };
  }

  /**
   * Read, decrypt (if enabled), and strictly verify a blob's size and SHA-256.
   * Throws `VaultHydrationPendingError` if evicted (`.icloud`), missing, or 0-byte stub.
   * Throws `VaultIntegrityError` on GCM tamper or SHA-256/size mismatch.
   */
  async getBlob(storageKey, expectedSha256, expectedSize) {
    const targetPath = this._blobPath(storageKey);
    const icloudPath = this._icloudPlaceholderPath(targetPath);

    if (await fileExists(icloudPath)) {
      throw new VaultHydrationPendingError(`Blob ${storageKey} is evicted in iCloud (.icloud placeholder present)`, {
        storageKey,
        reason: 'icloud-placeholder',
      });
    }

    let st;
    try {
      st = await fs.stat(targetPath);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new VaultHydrationPendingError(`Blob ${storageKey} is not yet hydrated locally`, {
          storageKey,
          reason: 'missing-blob',
        });
      }
      throw err;
    }

    if (!st.isFile() || (st.size === 0 && (this.encrypted || expectedSize !== 0))) {
      throw new VaultHydrationPendingError(`Blob ${storageKey} is a 0-byte unhydrated placeholder`, {
        storageKey,
        reason: 'zero-byte-stub',
      });
    }

    const raw = await fs.readFile(targetPath);
    if (raw.length === 0 && (this.encrypted || expectedSize !== 0)) {
      throw new VaultHydrationPendingError(`Blob ${storageKey} read 0 bytes`, {
        storageKey,
        reason: 'zero-byte-stub',
      });
    }

    const plain = this.encrypted ? this._decrypt(raw, storageKey) : raw;

    if (expectedSize !== undefined && plain.length !== expectedSize) {
      throw new VaultIntegrityError(
        `Blob ${storageKey} size mismatch: expected ${expectedSize}, got ${plain.length}`,
        { storageKey, reason: 'size-mismatch' },
      );
    }

    if (expectedSha256 !== undefined) {
      const actualSha256 = sha256Hex(plain);
      if (actualSha256 !== expectedSha256.toLowerCase()) {
        throw new VaultIntegrityError(
          `Blob ${storageKey} sha256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
          { storageKey, reason: 'sha256-mismatch' },
        );
      }
    }

    return plain;
  }

  /**
   * Stream-verify one blob without holding full plaintext in RAM.
   */
  async _verifySingleBlobStreaming({ storageKey, sha256, size }) {
    const targetPath = this._blobPath(storageKey);
    const icloudPath = this._icloudPlaceholderPath(targetPath);

    if (await fileExists(icloudPath)) {
      throw new VaultHydrationPendingError(`Blob ${storageKey} has .icloud placeholder`, {
        storageKey,
        reason: 'icloud-placeholder',
      });
    }

    let st;
    try {
      st = await fs.stat(targetPath);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new VaultHydrationPendingError(`Blob ${storageKey} not found locally`, {
          storageKey,
          reason: 'missing-blob',
        });
      }
      throw err;
    }

    if (!st.isFile() || (st.size === 0 && (this.encrypted || size !== 0))) {
      throw new VaultHydrationPendingError(`Blob ${storageKey} is 0-byte stub`, {
        storageKey,
        reason: 'zero-byte-stub',
      });
    }

    const hasher = crypto.createHash('sha256');
    let plainBytes = 0;

    if (this.encrypted) {
      if (st.size < ENVELOPE_HEADER_BYTES) {
        throw new VaultIntegrityError(`Blob ${storageKey} truncated below envelope header`, {
          storageKey,
          reason: 'truncated-envelope',
        });
      }
      const fh = await fs.open(targetPath, 'r');
      const header = Buffer.alloc(ENVELOPE_HEADER_BYTES);
      try {
        const { bytesRead } = await fh.read(header, 0, ENVELOPE_HEADER_BYTES, 0);
        if (bytesRead < ENVELOPE_HEADER_BYTES) {
          throw new VaultIntegrityError(`Blob ${storageKey} header short read`, {
            storageKey,
            reason: 'truncated-envelope',
          });
        }
      } finally {
        await fh.close();
      }

      if (!header.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
        throw new VaultIntegrityError(`Blob ${storageKey} invalid magic`, {
          storageKey,
          reason: 'invalid-magic',
        });
      }

      const iv = header.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + IV_BYTES);
      const authTag = header.subarray(ENVELOPE_MAGIC.length + IV_BYTES, ENVELOPE_HEADER_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.secretKeys.encKey, iv);
      decipher.setAuthTag(authTag);

      if (st.size > ENVELOPE_HEADER_BYTES) {
        const rs = fsSync.createReadStream(targetPath, { start: ENVELOPE_HEADER_BYTES });
        for await (const chunk of rs) {
          const dec = decipher.update(chunk);
          plainBytes += dec.length;
          hasher.update(dec);
        }
      }
      try {
        const finalChunk = decipher.final();
        plainBytes += finalChunk.length;
        hasher.update(finalChunk);
      } catch (err) {
        throw new VaultIntegrityError(`Blob ${storageKey} GCM authentication failed`, {
          storageKey,
          reason: 'gcm-auth-failed',
          cause: err,
        });
      }
    } else {
      const rs = fsSync.createReadStream(targetPath);
      for await (const chunk of rs) {
        plainBytes += chunk.length;
        hasher.update(chunk);
      }
    }

    if (size !== undefined && plainBytes !== size) {
      throw new VaultIntegrityError(`Blob ${storageKey} size mismatch: expected ${size}, got ${plainBytes}`, {
        storageKey,
        reason: 'size-mismatch',
      });
    }
    if (sha256 !== undefined) {
      const actual = hasher.digest('hex');
      if (actual !== sha256.toLowerCase()) {
        throw new VaultIntegrityError(`Blob ${storageKey} sha256 mismatch`, {
          storageKey,
          reason: 'sha256-mismatch',
        });
      }
    }
  }

  /**
   * Batch-verify that all blobs referenced by a commit are hydrated and intact on disk.
   *
   * @param {Iterable<{ storageKey: string, sha256?: string, size?: number }>} blobRefs
   * @returns {Promise<{ ready: true } | { ready: false, reason: string, storageKey?: string, detail?: string }>}
   */
  async verifyCommitBlobs(blobRefs) {
    const seen = new Set();
    for (const ref of blobRefs ?? []) {
      if (!ref || typeof ref.storageKey !== 'string') {
        return { ready: false, reason: 'invalid-ref', detail: 'Missing storageKey in blobRef' };
      }
      const dedupKey = `${ref.storageKey.toLowerCase()}:${ref.sha256 ?? ''}:${ref.size ?? ''}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      try {
        await this._verifySingleBlobStreaming(ref);
      } catch (err) {
        if (err instanceof VaultHydrationPendingError) {
          return {
            ready: false,
            reason: 'hydration-pending',
            storageKey: ref.storageKey,
            detail: err.message,
          };
        }
        if (err instanceof VaultIntegrityError) {
          return {
            ready: false,
            reason: err.reason || 'integrity-error',
            storageKey: ref.storageKey,
            detail: err.message,
          };
        }
        return {
          ready: false,
          reason: 'io-error',
          storageKey: ref.storageKey,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { ready: true };
  }

  /**
   * Manifest-Last atomic commit publication into this device's sharded folder.
   *
   * @param {'session' | 'workspace' | 'global'} kind
   * @param {string} targetId
   * @param {any} payload
   */
  async publishCommit(kind, targetId, payload) {
    if (!VALID_COMMIT_KINDS.has(kind)) {
      throw new TypeError(`Invalid commit kind "${kind}"; expected session | workspace | global`);
    }
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new TypeError('publishCommit requires a non-empty targetId');
    }

    const timestamp = Date.now();
    const seq = ++this._seq;
    const commit = {
      version: 1,
      kind,
      targetId,
      deviceId: this.deviceId,
      platform: this.platform,
      timestamp,
      seq,
      payload,
    };

    const plainBuf = Buffer.from(JSON.stringify(commit), 'utf8');
    const shortHash = sha256Hex(plainBuf).slice(0, 8);
    const storedBuf = this.encrypted ? this._encrypt(plainBuf) : plainBuf;

    const commitDir = path.join(this.vaultDir, 'devices', this.deviceId, `${kind}-commits`);
    const filename = `${timestamp}-${seq}-${shortHash}.commit`;
    const commitPath = path.join(commitDir, filename);

    await writeFileAtomic(commitPath, storedBuf, { mode: 0o600 });
    const record = {
      ...commit,
      filename,
      commitPath,
    };
    this._commitCache.set(`${commitPath}|${this._keyFingerprint}`, record);
    return record;
  }

  async _readDeviceCommits(deviceId, kind) {
    const commitDir = path.join(this.vaultDir, 'devices', deviceId, `${kind}-commits`);
    let entries;
    try {
      entries = await fs.readdir(commitDir);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { commits: [], pendingCount: 0, hydrationPendingCount: 0, decryptionFailedCount: 0 };
      }
      throw err;
    }

    const commits = [];
    let hydrationPendingCount = 0;
    let decryptionFailedCount = 0;
    const icloudSet = new Set();

    for (const entry of entries) {
      if (entry.startsWith('.') && entry.endsWith('.commit.icloud')) {
        icloudSet.add(entry.slice(1, -'.icloud'.length));
        hydrationPendingCount += 1;
      }
    }

    for (const entry of entries) {
      if (!entry.endsWith('.commit') || entry.startsWith('.')) continue;
      if (icloudSet.has(entry)) continue;

      const commitPath = path.join(commitDir, entry);
      const cacheKey = `${commitPath}|${this._keyFingerprint}`;
      const cached = this._commitCache.get(cacheKey);
      if (cached) {
        commits.push(cached);
        continue;
      }

      let raw;
      try {
        raw = await fs.readFile(commitPath);
      } catch {
        hydrationPendingCount += 1;
        continue;
      }
      if (raw.length === 0) {
        hydrationPendingCount += 1;
        continue;
      }

      let plain;
      if (this.encrypted) {
        try {
          plain = this._decrypt(raw);
        } catch (err) {
          if (err instanceof VaultIntegrityError && err.reason === 'gcm-auth-failed') {
            decryptionFailedCount += 1;
          } else if (err instanceof VaultIntegrityError && err.reason === 'invalid-magic') {
            // Plaintext JSON read under encrypted mode (encryption mismatch)
            const firstByte = raw[0];
            if (firstByte === 0x7b /* '{' */) {
              decryptionFailedCount += 1;
            } else {
              hydrationPendingCount += 1;
            }
          } else {
            hydrationPendingCount += 1;
          }
          continue;
        }
      } else {
        // Plaintext mode encountering an encrypted DSHSOUL1 envelope -> decryptionFailedCount
        if (raw.length >= ENVELOPE_MAGIC.length && raw.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
          decryptionFailedCount += 1;
          continue;
        }
        plain = raw;
      }

      let parsed;
      try {
        parsed = JSON.parse(plain.toString('utf8'));
      } catch {
        hydrationPendingCount += 1;
        continue;
      }

      if (
        typeof parsed !== 'object'
        || parsed === null
        || parsed.version !== 1
        || parsed.kind !== kind
        || typeof parsed.timestamp !== 'number'
        || typeof parsed.seq !== 'number'
      ) {
        hydrationPendingCount += 1;
        continue;
      }

      const record = {
        ...parsed,
        filename: entry,
        commitPath,
      };
      this._commitCache.set(cacheKey, record);
      commits.push(record);
    }

    return {
      commits,
      pendingCount: hydrationPendingCount,
      hydrationPendingCount,
      decryptionFailedCount,
    };
  }

  /**
   * Read and sort commits across devices by `(timestamp, seq)` ascending.
   * Separates `hydrationPendingCount` (unhydrated/partial cloud files; aliased as `pendingCount`
   * for backward compatibility) from `decryptionFailedCount` (wrong passphrase / encryption mismatch).
   */
  async listCommits(kind, options = {}) {
    if (!VALID_COMMIT_KINDS.has(kind)) {
      throw new TypeError(`Invalid commit kind "${kind}"`);
    }
    const { targetId = undefined, includeSelf = true, onlySelf = false } = options ?? {};

    const devicesDir = path.join(this.vaultDir, 'devices');
    let deviceDirs;
    try {
      deviceDirs = await fs.readdir(devicesDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { commits: [], pendingCount: 0, hydrationPendingCount: 0, decryptionFailedCount: 0, decryptionFailedDevices: {} };
      }
      throw err;
    }

    const commits = [];
    let hydrationPendingCount = 0;
    let decryptionFailedCount = 0;
    const decryptionFailedDevices = {};

    for (const dirent of deviceDirs) {
      if (!dirent.isDirectory()) continue;
      if (onlySelf && dirent.name !== this.deviceId) continue;
      if (!includeSelf && dirent.name === this.deviceId) continue;

      const res = await this._readDeviceCommits(dirent.name, kind);
      hydrationPendingCount += res.hydrationPendingCount;
      decryptionFailedCount += res.decryptionFailedCount;
      if (res.decryptionFailedCount > 0) {
        decryptionFailedDevices[dirent.name] = (decryptionFailedDevices[dirent.name] ?? 0) + res.decryptionFailedCount;
      }
      for (const c of res.commits) {
        if (targetId !== undefined && c.targetId !== targetId) continue;
        commits.push(c);
      }
    }

    commits.sort(
      (a, b) => (a.timestamp - b.timestamp) || (a.seq - b.seq) || String(a.deviceId).localeCompare(String(b.deviceId)),
    );
    return {
      commits,
      pendingCount: hydrationPendingCount,
      hydrationPendingCount,
      decryptionFailedCount,
      decryptionFailedDevices,
    };
  }

  /**
   * Scan peer devices (`deviceId !== this.deviceId`) across all commit kinds to determine
   * how many peer commits decrypt cleanly vs fail decryption under this VaultStore's current key.
   */
  async countReadablePeerCommits() {
    let peerDecryptedCount = 0;
    let peerFailedCount = 0;
    for (const kind of VALID_COMMIT_KINDS) {
      const res = await this.listCommits(kind, { includeSelf: false });
      peerDecryptedCount += res.commits.length;
      peerFailedCount += res.decryptionFailedCount;
    }
    return { peerDecryptedCount, peerFailedCount };
  }

  /**
   * Scan THIS device's own commits (`deviceId === this.deviceId`) across all commit kinds
   * to count how many decrypt cleanly vs fail decryption under the current key.
   */
  async countReadableOwnCommits() {
    let ownDecryptedCount = 0;
    let ownFailedCount = 0;
    for (const kind of VALID_COMMIT_KINDS) {
      const res = await this.listCommits(kind, { onlySelf: true });
      ownDecryptedCount += res.commits.length;
      ownFailedCount += res.decryptionFailedCount;
    }
    return { ownDecryptedCount, ownFailedCount };
  }

  /**
   * Scan ALL devices across all commit kinds to count distinct readable/failing peer devices
   * alongside per-device commit counts (used for majority-device passphrase guard & doctor checks).
   */
  async countReadableDeviceStats() {
    const peerReadableSet = new Set();
    const peerFailedSet = new Set();
    const peerSessionIds = new Set();
    const ownSessionIds = new Set();
    let peerDecryptedCount = 0;
    let peerFailedCount = 0;
    let ownDecryptedCount = 0;
    let ownFailedCount = 0;
    let peerEarliestTs = 0;
    let ownEarliestTs = 0;

    for (const kind of VALID_COMMIT_KINDS) {
      const peerRes = await this.listCommits(kind, { includeSelf: false });
      peerDecryptedCount += peerRes.commits.length;
      peerFailedCount += peerRes.decryptionFailedCount;
      for (const c of peerRes.commits) {
        if (c?.deviceId) peerReadableSet.add(c.deviceId);
        if (kind === 'session' && c?.targetId) peerSessionIds.add(c.targetId);
        if (typeof c?.timestamp === 'number' && c.timestamp > 0 && (peerEarliestTs === 0 || c.timestamp < peerEarliestTs)) {
          peerEarliestTs = c.timestamp;
        }
      }
      for (const [dev, cnt] of Object.entries(peerRes.decryptionFailedDevices ?? {})) {
        if (cnt > 0) peerFailedSet.add(dev);
      }

      const ownRes = await this.listCommits(kind, { onlySelf: true });
      ownDecryptedCount += ownRes.commits.length;
      ownFailedCount += ownRes.decryptionFailedCount;
      for (const c of ownRes.commits) {
        if (kind === 'session' && c?.targetId) ownSessionIds.add(c.targetId);
        if (typeof c?.timestamp === 'number' && c.timestamp > 0 && (ownEarliestTs === 0 || c.timestamp < ownEarliestTs)) {
          ownEarliestTs = c.timestamp;
        }
      }
    }

    return {
      peerReadableDevices: peerReadableSet.size,
      peerFailedDevices: peerFailedSet.size,
      peerDecryptedCount,
      peerFailedCount,
      peerSessionCount: peerSessionIds.size,
      peerEarliestTs,
      ownDecryptedCount,
      ownFailedCount,
      ownSessionCount: ownSessionIds.size,
      ownEarliestTs,
      totalDecryptedCount: peerDecryptedCount + ownDecryptedCount,
      totalFailedCount: peerFailedCount + ownFailedCount,
    };
  }

  /**
   * Purge any `.commit` files under THIS device's directory (`devices/<this.deviceId>/<kind>-commits/`)
   * that fail decryption under the current key (e.g., obsolete commits written while a wrong passphrase
   * was temporarily configured), evict them from `_commitCache`, and optionally run orphan blob GC.
   */
  async purgeUndecryptableOwnCommits({ runGc = false } = {}) {
    let removedCommits = 0;

    for (const kind of VALID_COMMIT_KINDS) {
      const commitDir = path.join(this.vaultDir, 'devices', this.deviceId, `${kind}-commits`);
      let entries;
      try {
        entries = await fs.readdir(commitDir);
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.commit') || entry.startsWith('.')) continue;
        const commitPath = path.join(commitDir, entry);
        let raw;
        try {
          raw = await fs.readFile(commitPath);
        } catch {
          continue;
        }
        if (raw.length === 0) continue;

        let undecryptable = false;
        if (this.encrypted) {
          try {
            this._decrypt(raw);
          } catch (err) {
            if (err instanceof VaultIntegrityError && err.reason === 'gcm-auth-failed') {
              undecryptable = true;
            } else if (err instanceof VaultIntegrityError && err.reason === 'invalid-magic' && raw[0] === 0x7b) {
              undecryptable = true;
            }
          }
        } else if (raw.length >= ENVELOPE_MAGIC.length && raw.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
          undecryptable = true;
        }

        if (undecryptable) {
          await fs.rm(commitPath, { force: true });
          for (const cacheKey of [...this._commitCache.keys()]) {
            if (cacheKey.startsWith(`${commitPath}|`)) {
              this._commitCache.delete(cacheKey);
            }
          }
          removedCommits += 1;
        }
      }
    }

    if (runGc) {
      const gc = await this._gcOrphanBlobs();
      return {
        removedCommits,
        prunedBlobs: gc.prunedBlobs,
        skippedBlobGc: gc.skippedBlobGc,
      };
    }

    return {
      removedCommits,
      prunedBlobs: 0,
      skippedBlobGc: false,
    };
  }

  /**
   * Remove all `.commit` files for a given `(kind, targetId)` across devices in the vault,
   * evict them from the in-memory commit cache, and garbage-collect now-unreferenced blobs.
   */
  async unpublishTarget(kind, targetId, { includeAllDevices = true } = {}) {
    if (!VALID_COMMIT_KINDS.has(kind)) {
      throw new TypeError(`Invalid commit kind "${kind}"`);
    }
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new TypeError('unpublishTarget requires a non-empty targetId');
    }

    const listed = await this.listCommits(kind, {
      targetId,
      includeSelf: true,
      onlySelf: !includeAllDevices,
    });
    let removedCommits = 0;
    for (const c of listed.commits) {
      await fs.rm(c.commitPath, { force: true });
      this._commitCache.delete(`${c.commitPath}|${this._keyFingerprint}`);
      removedCommits += 1;
    }

    const gc = await this._gcOrphanBlobs();
    return {
      targetId,
      removedCommits,
      prunedBlobs: gc.prunedBlobs,
      skippedBlobGc: gc.skippedBlobGc,
    };
  }

  /**
   * Write this device's heartbeat (including `baton` handoff state) into `devices/<deviceId>/heartbeat.json`.
   */
  async writeHeartbeat(meta = {}) {
    const record = {
      version: 1,
      deviceId: this.deviceId,
      platform: this.platform,
      updatedAt: Date.now(),
      ...meta,
    };
    const hbPath = path.join(this.vaultDir, 'devices', this.deviceId, 'heartbeat.json');
    await writeFileAtomic(hbPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return record;
  }

  /**
   * Read all devices' heartbeats across `<vaultDir>/devices/<id>/heartbeat.json`.
   */
  async readHeartbeats() {
    const devicesDir = path.join(this.vaultDir, 'devices');
    let deviceDirs;
    try {
      deviceDirs = await fs.readdir(devicesDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }

    const results = [];
    for (const dirent of deviceDirs) {
      if (!dirent.isDirectory()) continue;
      const hbPath = path.join(devicesDir, dirent.name, 'heartbeat.json');
      try {
        const text = await fs.readFile(hbPath, 'utf8');
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          results.push(parsed);
        }
      } catch {
        // Ignore missing or partially synced heartbeat files
      }
    }

    results.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return results;
  }

  /**
   * Retain the latest `keepPerTarget` commits per `targetId` for THIS device,
   * delete older commits of this device, and garbage-collect orphan blobs that
   * are no longer referenced by ANY surviving commit across ALL devices and kinds.
   * If any commit across the vault is pending/unreadable, orphan blob GC is safely skipped.
   */
  async pruneHistory(kind, keepPerTarget = this.quotas.retainSnapshots) {
    if (!VALID_COMMIT_KINDS.has(kind)) {
      throw new TypeError(`Invalid commit kind "${kind}"`);
    }
    if (!Number.isSafeInteger(keepPerTarget) || keepPerTarget < 1) {
      throw new RangeError('keepPerTarget must be a positive integer');
    }

    const selfResult = await this._readDeviceCommits(this.deviceId, kind);
    const byTarget = new Map();
    for (const c of selfResult.commits) {
      if (!byTarget.has(c.targetId)) byTarget.set(c.targetId, []);
      byTarget.get(c.targetId).push(c);
    }

    let prunedCommits = 0;
    for (const group of byTarget.values()) {
      group.sort((a, b) => (a.timestamp - b.timestamp) || (a.seq - b.seq));
      if (group.length <= keepPerTarget) continue;
      const toDelete = group.slice(0, group.length - keepPerTarget);
      for (const oldCommit of toDelete) {
        await fs.rm(oldCommit.commitPath, { force: true });
        this._commitCache.delete(`${oldCommit.commitPath}|${this._keyFingerprint}`);
        prunedCommits += 1;
      }
    }

    const gc = await this._gcOrphanBlobs();
    return { prunedCommits, prunedBlobs: gc.prunedBlobs, skippedBlobGc: gc.skippedBlobGc };
  }

  async _gcOrphanBlobs() {
    // Collect all referenced storageKeys across ALL devices and ALL commit kinds
    const referencedKeys = new Set();
    let totalUnreadable = 0;
    for (const k of VALID_COMMIT_KINDS) {
      const listed = await this.listCommits(k, { includeSelf: true });
      totalUnreadable += listed.hydrationPendingCount + listed.decryptionFailedCount;
      for (const c of listed.commits) {
        collectReferencedStorageKeys(c.payload, referencedKeys);
      }
    }

    if (totalUnreadable > 0) {
      return { prunedBlobs: 0, skippedBlobGc: true };
    }

    // Walk <vaultDir>/blobs/sha256/<2hex>/<storageKey> and delete unreferenced blobs
    let prunedBlobs = 0;
    const blobsRoot = path.join(this.vaultDir, 'blobs', 'sha256');
    let buckets;
    try {
      buckets = await fs.readdir(blobsRoot, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { prunedBlobs: 0, skippedBlobGc: false };
      }
      throw err;
    }

    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const bucketDir = path.join(blobsRoot, bucket.name);
      const entries = await fs.readdir(bucketDir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry.endsWith('.tmp') || entry.endsWith('.icloud')) continue;
        if (!HEX_64_RE.test(entry)) continue;
        if (!referencedKeys.has(entry.toLowerCase())) {
          await fs.rm(path.join(bucketDir, entry), { force: true });
          prunedBlobs += 1;
        }
      }
    }

    return { prunedBlobs, skippedBlobGc: false };
  }
}
