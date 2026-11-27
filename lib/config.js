import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_QUOTAS = Object.freeze({
  maxFileBytes: 30 * 1024 * 1024,
  maxWorkspaceBytes: 500 * 1024 * 1024,
  retainSnapshots: 10,
  stepSyncIntervalMs: 30000,
  trashRetentionDays: 14,
  maxAutoSessionsPerWorkspace: 25,
});

export const VALID_FOLDER_MATCH_MODES = Object.freeze(['auto-mirror', 'mapped-only']);
export const VALID_SYNC_SCOPES = Object.freeze(['active', 'selected']);

export const GLOBAL_AGENTS_RULES_MARKER = '<!-- dsh-soul-sync:cross-os-rules:v1 -->';
const GLOBAL_AGENTS_RULES_END_MARKER = '<!-- /dsh-soul-sync:cross-os-rules:v1 -->';

const DEFAULT_SCRYPT_SALT = Buffer.from('dsh-soul-sync:v1:scrypt-salt', 'utf8');
const LOCAL_PASSPHRASE_AAD = Buffer.from('dsh-soul-sync:local-secret-passphrase:v1', 'utf8');
const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const MAX_RENAME_RETRIES = 8;

/**
 * Trim whitespace and strip matching outer double/single quotes (e.g. from Windows
 * "Shift+Right-Click -> Copy as path").
 */
export function stripOuterQuotes(raw) {
  let s = String(raw ?? '').trim();
  while (
    s.length >= 2
    && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeHostForId(hostname) {
  const cleaned = String(hostname || 'device')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'device';
}

function defaultDeviceId() {
  return `${sanitizeHostForId(os.hostname())}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Atomically write a file by staging into a unique sibling `.tmp` file (`wx`),
 * calling `fsync`, and renaming with Windows transient lock retry backoff.
 *
 * @param {string} filePath
 * @param {string | Buffer | Uint8Array} data
 * @param {{ mode?: number }} [options]
 */
export async function writeFileAtomic(filePath, data, options = { mode: 0o600 }) {
  const mode = options?.mode ?? 0o600;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  await fs.mkdir(dir, { recursive: true });

  let tmpPath;
  let handle;
  for (let attempt = 0; attempt < 16; attempt++) {
    const token = crypto.randomBytes(8).toString('hex');
    tmpPath = path.join(dir, `.${base}.${process.pid}.${token}.tmp`);
    try {
      handle = await fs.open(tmpPath, 'wx', mode);
      break;
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }
  if (!handle) {
    throw new Error(`writeFileAtomic: failed to allocate temp file for ${filePath}`);
  }

  let closed = false;
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    await handle.writeFile(buf);
    await handle.sync();
    await handle.close();
    closed = true;

    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmpPath, filePath);
        return;
      } catch (err) {
        if (attempt < MAX_RENAME_RETRIES && RETRYABLE_RENAME_CODES.has(err?.code)) {
          const delayMs = Math.min(250, 10 * (2 ** attempt));
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (!closed) {
      await handle.close().catch(() => {});
    }
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export function resolveDshHome(customHome) {
  if (typeof customHome === 'string' && customHome.trim().length > 0) {
    return path.resolve(customHome);
  }
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0) {
    return path.resolve(process.env.DSH_HOME);
  }
  return path.join(os.homedir(), '.dsh');
}

export function soulSyncDir(dshHome) {
  return path.join(resolveDshHome(dshHome), 'soul-sync');
}

function normalizeStringList(raw, fallback = [], { nfc = false } = {}) {
  const source = Array.isArray(raw) ? raw : Array.isArray(fallback) ? fallback : [];
  const seen = new Set();
  const out = [];
  for (const item of source) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const normalized = nfc ? trimmed.normalize('NFC') : trimmed;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function normalizePathOverrides(raw, fallback = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      ? fallback
      : {};
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    const ck = k.trim().normalize('NFC');
    const cv = v.trim().normalize('NFC');
    if (ck && cv) {
      out[ck] = cv;
    }
  }
  return out;
}

function normalizeTimestampMap(raw, fallback = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      ? fallback
      : {};
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) {
      out[k.trim()] = Math.round(num);
    }
  }
  return out;
}

export function expandPosixHome(rawPath, targetPlatform = process.platform) {
  const s = String(rawPath ?? '').trim();
  if (!s) return '';
  if (s === '~' || s.startsWith('~/')) {
    if (targetPlatform === 'win32' || targetPlatform !== process.platform) {
      return s;
    }
    const home = os.homedir();
    return s === '~' ? home : path.posix.join(home.replace(/\\/g, '/'), s.slice(2));
  }
  return s;
}

export function extractDirBasename(rawPath) {
  if (!rawPath) return '';
  const cleaned = String(rawPath).trim().replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return (idx >= 0 ? cleaned.slice(idx + 1) : cleaned).normalize('NFC');
}

function normalizePathForIdHash(rawPath) {
  return String(rawPath ?? '')
    .trim()
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function deriveWorkspaceId(winPath, macPath) {
  const base = extractDirBasename(winPath) || extractDirBasename(macPath) || 'workspace';
  const safe = base
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const normWin = normalizePathForIdHash(winPath);
  const normMac = normalizePathForIdHash(macPath);
  const pairSeed = `${normWin}::${normMac}`;
  const hash4 = crypto.createHash('sha256').update(pairSeed).digest('hex').slice(0, 4);
  if (safe.length > 0) return `${safe}-${hash4}`;
  return `ws-${crypto.createHash('sha256').update(pairSeed).digest('hex').slice(0, 6)}`;
}

function buildDefaultConfig() {
  return {
    version: 1,
    deviceId: defaultDeviceId(),
    deviceLabel: os.hostname() || 'my-device',
    platform: process.platform,
    vaultDir: '',
    fallbackDir: '',
    autoMirrorRoot: '',
    encryptionEnabled: false,
    stepSyncEnabled: true,
    folderMatchMode: 'auto-mirror',
    syncScope: 'active',
    selectedWorkspaces: [],
    selectedSessionIds: [],
    excludedSessionIds: [],
    withdrawnSessions: {},
    restoredSessions: {},
    deletedMappingIds: {},
    autoMirrorAssignments: {},
    sessionTargetOverrides: {},
    workspaceTargetOverrides: {},
    workspaceMappings: [],
    quotas: { ...DEFAULT_QUOTAS },
  };
}

function normalizeConfig(raw, fallback) {
  const base = fallback ?? buildDefaultConfig();
  const mergedQuotas = {
    ...DEFAULT_QUOTAS,
    ...(base.quotas ?? {}),
    ...(raw?.quotas ?? {}),
  };
  const mappings = Array.isArray(raw?.workspaceMappings)
    ? raw.workspaceMappings.map((m) => ({
        id: String(m.id),
        title: m.title !== undefined ? String(m.title) : String(m.id),
        ...(m.win32 !== undefined ? { win32: String(m.win32).normalize('NFC') } : {}),
        ...(m.darwin !== undefined ? { darwin: String(m.darwin).normalize('NFC') } : {}),
        ...(m.linux !== undefined ? { linux: String(m.linux).normalize('NFC') } : {}),
        ...(typeof m.updatedAt === 'number' && Number.isFinite(m.updatedAt) ? { updatedAt: Math.round(m.updatedAt) } : {}),
      }))
    : base.workspaceMappings;

  const folderMatchMode = VALID_FOLDER_MATCH_MODES.includes(raw?.folderMatchMode)
    ? raw.folderMatchMode
    : VALID_FOLDER_MATCH_MODES.includes(base.folderMatchMode)
      ? base.folderMatchMode
      : 'auto-mirror';

  const syncScope = VALID_SYNC_SCOPES.includes(raw?.syncScope)
    ? raw.syncScope
    : VALID_SYNC_SCOPES.includes(base.syncScope)
      ? base.syncScope
      : 'active';

  return {
    version: 1,
    deviceId: typeof raw?.deviceId === 'string' && raw.deviceId.length > 0 ? raw.deviceId : base.deviceId,
    deviceLabel: typeof raw?.deviceLabel === 'string' && raw.deviceLabel.length > 0 ? raw.deviceLabel : base.deviceLabel,
    platform: typeof raw?.platform === 'string' && raw.platform.length > 0 ? raw.platform : base.platform,
    vaultDir: typeof raw?.vaultDir === 'string' ? raw.vaultDir.normalize('NFC') : base.vaultDir,
    fallbackDir: typeof raw?.fallbackDir === 'string' ? raw.fallbackDir.normalize('NFC') : (base.fallbackDir ?? ''),
    autoMirrorRoot: typeof raw?.autoMirrorRoot === 'string' ? raw.autoMirrorRoot.normalize('NFC') : (base.autoMirrorRoot ?? ''),
    encryptionEnabled: typeof raw?.encryptionEnabled === 'boolean' ? raw.encryptionEnabled : base.encryptionEnabled,
    stepSyncEnabled: typeof raw?.stepSyncEnabled === 'boolean'
      ? raw.stepSyncEnabled
      : (typeof base.stepSyncEnabled === 'boolean' ? base.stepSyncEnabled : true),
    folderMatchMode,
    syncScope,
    selectedWorkspaces: normalizeStringList(raw?.selectedWorkspaces, base.selectedWorkspaces, { nfc: true }),
    selectedSessionIds: normalizeStringList(raw?.selectedSessionIds, base.selectedSessionIds),
    excludedSessionIds: normalizeStringList(raw?.excludedSessionIds, base.excludedSessionIds),
    withdrawnSessions: normalizeTimestampMap(raw?.withdrawnSessions, base.withdrawnSessions),
    restoredSessions: normalizeTimestampMap(raw?.restoredSessions, base.restoredSessions),
    deletedMappingIds: normalizeTimestampMap(raw?.deletedMappingIds, base.deletedMappingIds),
    autoMirrorAssignments: normalizePathOverrides(raw?.autoMirrorAssignments, base.autoMirrorAssignments),
    sessionTargetOverrides: normalizePathOverrides(raw?.sessionTargetOverrides, base.sessionTargetOverrides),
    workspaceTargetOverrides: normalizePathOverrides(raw?.workspaceTargetOverrides, base.workspaceTargetOverrides),
    workspaceMappings: mappings,
    quotas: mergedQuotas,
  };
}

export async function loadConfig(dshHome) {
  const configPath = path.join(soulSyncDir(dshHome), 'config.json');
  try {
    const text = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(text);
    return normalizeConfig(parsed);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return buildDefaultConfig();
    }
    throw err;
  }
}

export async function saveConfig(dshHome, partial = {}) {
  const current = await loadConfig(dshHome);
  const merged = normalizeConfig(
    {
      ...current,
      ...partial,
      quotas: {
        ...current.quotas,
        ...(partial?.quotas ?? {}),
      },
    },
    current,
  );
  const configPath = path.join(soulSyncDir(dshHome), 'config.json');
  await writeFileAtomic(configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}

/**
 * Derive `{ saltHex, encKeyHex, hmacKeyHex, encKey, hmacKey }` (32 bytes each) via `scryptSync`
 * purely in memory without writing to disk (used for pre-write majority-device verification).
 */
export function derivePassphraseKey(passphrase, salt) {
  if (passphrase === null || passphrase === undefined || passphrase === '') {
    return null;
  }
  if (typeof passphrase !== 'string') {
    throw new TypeError('passphrase must be a string or empty');
  }
  const saltBuf = salt === undefined
    ? DEFAULT_SCRYPT_SALT
    : Buffer.isBuffer(salt)
      ? salt
      : Buffer.from(String(salt), 'utf8');

  const derived = crypto.scryptSync(passphrase, saltBuf, 64, { N: 16384, r: 8, p: 1 });
  const encKey = Buffer.from(derived.subarray(0, 32));
  const hmacKey = Buffer.from(derived.subarray(32, 64));

  return {
    saltHex: saltBuf.toString('hex'),
    encKeyHex: encKey.toString('hex'),
    hmacKeyHex: hmacKey.toString('hex'),
    encKey,
    hmacKey,
  };
}

function sealLocalPassphrase(passphrase, encKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(LOCAL_PASSPHRASE_AAD);
  const ct = Buffer.concat([cipher.update(Buffer.from(passphrase, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('hex');
}

function unsealLocalPassphrase(cipherHex, encKey) {
  if (typeof cipherHex !== 'string' || cipherHex.length < 56 || cipherHex.length % 2 !== 0) {
    return null;
  }
  try {
    const buf = Buffer.from(cipherHex, 'hex');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAAD(LOCAL_PASSPHRASE_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Derive `{ encKey, hmacKey }` (32 bytes each) via `scryptSync` and persist locally
 * inside `<dshHome>/soul-sync/secret.key` (never inside `vaultDir` or `config.json`).
 * Also seals the original passphrase with `encKey` locally so the user can view/copy
 * it via authenticated loopback UI when pairing a second computer.
 * Passing an empty passphrase clears the local key file (plaintext mode).
 */
export async function savePassphraseKey(dshHome, passphrase, salt) {
  const keyPath = path.join(soulSyncDir(dshHome), 'secret.key');
  const derived = derivePassphraseKey(passphrase, salt);
  if (derived === null) {
    await fs.rm(keyPath, { force: true });
    return null;
  }

  const passphraseCipherHex = sealLocalPassphrase(passphrase, derived.encKey);
  const payload = {
    saltHex: derived.saltHex,
    encKeyHex: derived.encKeyHex,
    hmacKeyHex: derived.hmacKeyHex,
    passphraseCipherHex,
  };
  await writeFileAtomic(keyPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });

  return {
    ...derived,
    passphrase,
    hasRevealablePassphrase: true,
  };
}

export async function loadPassphraseKey(dshHome) {
  const keyPath = path.join(soulSyncDir(dshHome), 'secret.key');
  let text;
  try {
    text = await fs.readFile(keyPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }

  const parsed = JSON.parse(text);
  if (
    typeof parsed?.saltHex !== 'string'
    || typeof parsed?.encKeyHex !== 'string'
    || typeof parsed?.hmacKeyHex !== 'string'
  ) {
    throw new Error(`Invalid secret.key format at ${keyPath}`);
  }
  const encKey = Buffer.from(parsed.encKeyHex, 'hex');
  const hmacKey = Buffer.from(parsed.hmacKeyHex, 'hex');
  if (encKey.length !== 32 || hmacKey.length !== 32) {
    throw new Error(`Invalid key length in ${keyPath}`);
  }

  let revealed = null;
  if (typeof parsed.passphraseCipherHex === 'string') {
    revealed = unsealLocalPassphrase(parsed.passphraseCipherHex, encKey);
  } else if (typeof parsed.passphrase === 'string' && parsed.passphrase.length > 0) {
    revealed = parsed.passphrase;
  }

  return {
    saltHex: parsed.saltHex,
    encKeyHex: parsed.encKeyHex,
    hmacKeyHex: parsed.hmacKeyHex,
    encKey,
    hmacKey,
    passphrase: revealed,
    hasRevealablePassphrase: typeof revealed === 'string' && revealed.length > 0,
  };
}

function normalizePosixSlashes(raw) {
  let s = String(raw).normalize('NFC').replace(/\\/g, '/');
  // Collapse multiple slashes except a leading UNC //
  if (s.startsWith('//')) {
    s = '//' + s.slice(2).replace(/\/+/g, '/');
  } else {
    s = s.replace(/\/+/g, '/');
  }
  // Strip trailing slash unless root '/' or drive root 'C:/'
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) {
    s = s.replace(/\/+$/, '');
  }
  return s;
}

function formatTargetPath(targetRoot, relativePosixPath, targetPlatform) {
  const rootPosix = normalizePosixSlashes(targetRoot);
  if (targetPlatform === 'win32') {
    const winRoot = rootPosix.replace(/\//g, '\\');
    if (!relativePosixPath) return winRoot.normalize('NFC');
    const relWin = relativePosixPath.split('/').join('\\');
    const sep = winRoot.endsWith('\\') ? '' : '\\';
    return `${winRoot}${sep}${relWin}`.normalize('NFC');
  }
  if (!relativePosixPath) return rootPosix.normalize('NFC');
  const sep = rootPosix.endsWith('/') ? '' : '/';
  return `${rootPosix}${sep}${relativePosixPath}`.normalize('NFC');
}

const SOURCE_OS_KEYS = ['win32', 'darwin', 'linux'];

/**
 * Bidirectionally map a file or directory path across OSes using workspace mappings.
 * Windows drive letters & prefixes (and macOS APFS prefixes) match case-insensitively,
 * while preserving the original relative path casing and normalizing to NFC.
 */
export function mapPathAcrossOs(rawPath, workspaceMappings = [], targetPlatform = process.platform) {
  const expandedRaw = targetPlatform !== 'win32'
    ? expandPosixHome(String(rawPath ?? ''), targetPlatform)
    : String(rawPath ?? '');
  const nfcRaw = expandedRaw.normalize('NFC');
  if (!nfcRaw || !Array.isArray(workspaceMappings) || workspaceMappings.length === 0) {
    return {
      mappedPath: nfcRaw,
      workspaceId: null,
      relativePosixPath: null,
      matched: false,
    };
  }

  const rawPosix = normalizePosixSlashes(nfcRaw);
  const rawPosixLower = rawPosix.toLowerCase();

  let bestMatch = null;

  for (const mapping of workspaceMappings) {
    if (!mapping || typeof mapping !== 'object') continue;
    for (const srcOs of SOURCE_OS_KEYS) {
      const rawSrcRoot = mapping[srcOs];
      if (typeof rawSrcRoot !== 'string' || rawSrcRoot.length === 0) continue;
      const srcRoot = srcOs !== 'win32' && srcOs === process.platform
        ? expandPosixHome(rawSrcRoot, srcOs)
        : rawSrcRoot;

      const rootPosix = normalizePosixSlashes(srcRoot);
      const caseInsensitive = srcOs === 'win32' || srcOs === 'darwin';
      const cmpRaw = caseInsensitive ? rawPosixLower : rawPosix;
      const cmpRoot = caseInsensitive ? rootPosix.toLowerCase() : rootPosix;

      let relativePosixPath = null;
      if (cmpRaw === cmpRoot) {
        relativePosixPath = '';
      } else {
        const prefixWithSlash = cmpRoot.endsWith('/') ? cmpRoot : `${cmpRoot}/`;
        if (cmpRaw.startsWith(prefixWithSlash)) {
          relativePosixPath = rawPosix.slice(prefixWithSlash.length).normalize('NFC');
        }
      }

      if (relativePosixPath !== null) {
        if (!bestMatch || rootPosix.length > bestMatch.rootLength) {
          bestMatch = {
            mapping,
            relativePosixPath,
            rootLength: rootPosix.length,
          };
        }
      }
    }
  }

  if (!bestMatch) {
    return {
      mappedPath: nfcRaw,
      workspaceId: null,
      relativePosixPath: null,
      matched: false,
    };
  }

  const rawTargetRoot = bestMatch.mapping[targetPlatform];
  if (typeof rawTargetRoot !== 'string' || rawTargetRoot.length === 0) {
    return {
      mappedPath: nfcRaw,
      workspaceId: bestMatch.mapping.id ?? null,
      relativePosixPath: bestMatch.relativePosixPath,
      matched: false,
    };
  }
  const targetRoot = targetPlatform !== 'win32'
    ? expandPosixHome(rawTargetRoot, targetPlatform)
    : rawTargetRoot;

  return {
    mappedPath: formatTargetPath(targetRoot, bestMatch.relativePosixPath, targetPlatform),
    workspaceId: bestMatch.mapping.id ?? null,
    relativePosixPath: bestMatch.relativePosixPath,
    matched: true,
  };
}

/**
 * Canonicalize an existing path (or its nearest existing ancestor + trailing segments)
 * using `fs.realpath` and Unicode NFC normalization.
 */
export async function canonicalizeLocalPath(targetPath) {
  const expanded = process.platform !== 'win32'
    ? expandPosixHome(String(targetPath), process.platform)
    : String(targetPath);
  const resolved = path.resolve(expanded);
  try {
    const real = await fs.realpath(resolved);
    return real.normalize('NFC');
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
      throw err;
    }
  }

  const missingSegments = [];
  let cursor = resolved;
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      // Reached filesystem root without finding an existing ancestor
      return resolved.normalize('NFC');
    }
    missingSegments.push(path.basename(cursor));
    cursor = parent;
    try {
      const realAncestor = await fs.realpath(cursor);
      missingSegments.reverse();
      return path.join(realAncestor, ...missingSegments).normalize('NFC');
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        throw err;
      }
    }
  }
}

function buildGlobalAgentsRulesBlock() {
  return [
    GLOBAL_AGENTS_RULES_MARKER,
    '## 跨平台工作流规范（Windows ⇄ macOS / Soul Sync）',
    '',
    '1. **最终产出统一归入 `outputs/`**：所有需要保留或跨设备复用的报告、图表、估值表与清洗后结果，统一输出至工作区下的 `outputs/` 目录，避免散落在根目录。',
    '2. **中间临时文件归入 `.work/`**：调试脚本、中间缓存、抓包与草稿统一放入 `.work/` 目录，严禁污染主工作区或混入同步产出。',
    '3. **Python 脚本跨平台路径与中文字体自适应**：禁止硬编码绝对路径或反斜杠，统一使用 `from pathlib import Path; BASE_DIR = Path(__file__).resolve().parent` 构建相对路径；绘图时配置跨平台中文字体回退列表 `["Microsoft YaHei", "PingFang SC", "Heiti SC", "SimHei", "sans-serif"]` 并设置 `axes.unicode_minus = False`。',
    '4. **保护人工 Excel 模板与 CSV 编码**：严禁整本覆写人工精心排版的 Excel 模板文件（优先另存衍生产出表或仅更新指定数据区域）；导出供 Excel 打开的 CSV 文件一律使用 `utf-8-sig` 编码防止中文乱码。',
    '5. **单机独有原始大库诚实声明缺口**：若分析依赖仅存于某一台电脑的本地原始大数据库，在另一台设备无法直接重跑上游取数步骤时，必须显式输出《不可重跑步骤与信息缺口清单》，严禁凭空编造数据或静默跳过。',
    GLOBAL_AGENTS_RULES_END_MARKER,
  ].join('\n');
}

/**
 * Idempotently ensure the 5 cross-OS engineering rules exist inside `<dshHome>/AGENTS.md`.
 */
export async function ensureGlobalAgentsRules(dshHome) {
  const homeDir = resolveDshHome(dshHome);
  const agentsPath = path.join(homeDir, 'AGENTS.md');
  const block = buildGlobalAgentsRulesBlock();

  let existing = null;
  try {
    existing = await fs.readFile(agentsPath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  if (existing === null) {
    await writeFileAtomic(agentsPath, `${block}\n`, { mode: 0o644 });
    return { path: agentsPath, updated: true, created: true };
  }

  const startIdx = existing.indexOf(GLOBAL_AGENTS_RULES_MARKER);
  if (startIdx !== -1) {
    const endIdx = existing.indexOf(GLOBAL_AGENTS_RULES_END_MARKER, startIdx);
    if (endIdx !== -1) {
      const currentBlock = existing.slice(startIdx, endIdx + GLOBAL_AGENTS_RULES_END_MARKER.length);
      if (currentBlock === block) {
        return { path: agentsPath, updated: false, created: false };
      }
      const nextContent =
        existing.slice(0, startIdx) + block + existing.slice(endIdx + GLOBAL_AGENTS_RULES_END_MARKER.length);
      await writeFileAtomic(agentsPath, nextContent, { mode: 0o644 });
      return { path: agentsPath, updated: true, created: false };
    }
    // Start marker exists without end marker: treat as already installed to avoid duplication
    return { path: agentsPath, updated: false, created: false };
  }

  const separator = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  await writeFileAtomic(agentsPath, `${existing}${separator}${block}\n`, { mode: 0o644 });
  return { path: agentsPath, updated: true, created: false };
}

/**
 * Strip only the `dsh-soul-sync` cross-OS rules block from `<dshHome>/AGENTS.md`
 * while preserving all other user-authored rules intact.
 */
export async function removeGlobalAgentsRules(dshHome) {
  const homeDir = resolveDshHome(dshHome);
  const agentsPath = path.join(homeDir, 'AGENTS.md');
  let existing;
  try {
    existing = await fs.readFile(agentsPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { path: agentsPath, updated: false };
    throw err;
  }

  const startIdx = existing.indexOf(GLOBAL_AGENTS_RULES_MARKER);
  if (startIdx === -1) {
    return { path: agentsPath, updated: false };
  }
  const endIdx = existing.indexOf(GLOBAL_AGENTS_RULES_END_MARKER, startIdx);
  if (endIdx === -1) {
    return { path: agentsPath, updated: false };
  }

  const before = existing.slice(0, startIdx).replace(/\n+$/, '');
  const after = existing.slice(endIdx + GLOBAL_AGENTS_RULES_END_MARKER.length).replace(/^\n+/, '');
  let nextContent = '';
  if (before && after) {
    nextContent = `${before}\n\n${after}`;
  } else if (before) {
    nextContent = `${before}\n`;
  } else if (after) {
    nextContent = after.endsWith('\n') ? after : `${after}\n`;
  }
  await writeFileAtomic(agentsPath, nextContent, { mode: 0o644 });
  return { path: agentsPath, updated: true };
}

const BARE_PERSONAL_FOLDER_NAMES = new Set([
  'desktop',
  '桌面',
  'documents',
  '文档',
  '文稿',
  'downloads',
  '下载',
  'pictures',
  '图片',
  'movies',
  '影片',
  'videos',
  '视频',
  'music',
  '音乐',
]);

const BARE_CLOUD_ROOT_EXACT = new Set([
  'onedrive',
  'icloud drive',
  'com~apple~clouddocs',
  'nutstore files',
  'nutstore',
  '我的坚果云',
  'dropbox',
  'baidunetdisk',
  'baidunetdiskworkspace',
  '百度网盘',
  'google drive',
  'googledrive',
  'cloudstorage',
]);

function isBareCloudRootSegment(segLower) {
  if (!segLower) return false;
  if (BARE_CLOUD_ROOT_EXACT.has(segLower)) return true;
  if (/^onedrive(?:\s*[-—–]\s*|\s+).+/.test(segLower)) return true;
  return false;
}

function isWinAbsPath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
}

function isPosixAbsPath(p) {
  return typeof p === 'string' && p.startsWith('/');
}

function normalizeAbsolutePlatformPath(cleaned, targetPlatform) {
  if (targetPlatform === 'win32') {
    let norm = path.win32.normalize(cleaned);
    // Keep drive root `D:\`, strip trailing slashes on non-root paths
    if (!/^[A-Za-z]:\\$/.test(norm) && !/^\\\\[^\\]+\\[^\\]+\\?$/.test(norm)) {
      norm = norm.replace(/\\+$/, '');
    } else if (/^\\\\[^\\]+\\[^\\]+\\$/.test(norm)) {
      norm = norm.slice(0, -1);
    }
    return norm.normalize('NFC');
  }
  let norm = path.posix.normalize(cleaned);
  if (norm.length > 1) {
    norm = norm.replace(/\/+$/, '');
  }
  return norm.normalize('NFC');
}

function parseNormalizedPathSegments(cleanedPath, targetPlatform) {
  const posix = normalizePosixSlashes(cleanedPath);
  if (targetPlatform === 'win32') {
    if (/^[A-Za-z]:\//.test(posix)) {
      const rest = posix.slice(3);
      const segments = rest ? rest.split('/').filter(Boolean) : [];
      return { posix, cmp: posix.toLowerCase(), segments, segLower: segments.map((s) => s.toLowerCase()), isUnc: false };
    }
    if (posix.startsWith('//')) {
      const parts = posix.slice(2).split('/').filter(Boolean);
      const segments = parts.slice(2); // after //server/share
      return { posix, cmp: posix.toLowerCase(), segments, segLower: segments.map((s) => s.toLowerCase()), isUnc: true };
    }
  }
  const rest = posix.startsWith('/') ? posix.slice(1) : posix;
  const segments = rest ? rest.split('/').filter(Boolean) : [];
  const cmp = targetPlatform === 'darwin' ? posix.toLowerCase() : posix;
  return { posix, cmp, segments, segLower: segments.map((s) => s.toLowerCase()), isUnc: false };
}

function sameOsFamily(pathA, pathB) {
  const aWin = isWinAbsPath(pathA);
  const bWin = isWinAbsPath(pathB);
  const aPosix = isPosixAbsPath(pathA);
  const bPosix = isPosixAbsPath(pathB);
  return (aWin && bWin) || (aPosix && bPosix);
}

function normCmpPath(p) {
  return normalizePosixSlashes(stripOuterQuotes(p)).toLowerCase();
}

function isSameOrInsidePath(childPath, parentPath) {
  if (!childPath || !parentPath || !sameOsFamily(childPath, parentPath)) return false;
  const c = normCmpPath(childPath);
  const p = normCmpPath(parentPath);
  if (!c || !p) return false;
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

function isUserHomeDir(segments, segLower, targetPlatform, cleanedPath) {
  if (targetPlatform === 'win32') {
    if (segments.length === 2 && segLower[0] === 'users') return true;
  } else {
    if (segments.length === 2 && (segLower[0] === 'users' || segLower[0] === 'home')) return true;
  }
  if (targetPlatform === process.platform) {
    try {
      const home = os.homedir();
      if (home && sameOsFamily(cleanedPath, home) && normCmpPath(cleanedPath) === normCmpPath(home)) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

function isSystemOrDriveRoot(segments, segLower, targetPlatform) {
  if (segments.length === 0) return true;
  if (targetPlatform === 'win32') {
    const first = segLower[0];
    if (first === 'windows' || first === 'program files' || first === 'program files (x86)' || first === 'programdata') {
      return true;
    }
    if (first === 'users' && segments.length === 1) return true;
    return false;
  }
  const first = segLower[0];
  if (first === 'system' || first === 'library' || first === 'applications') {
    return true;
  }
  if (segments.length === 1 && (first === 'users' || first === 'home' || first === 'volumes' || first === 'etc' || first === 'usr' || first === 'bin' || first === 'sbin' || first === 'var')) {
    return true;
  }
  return false;
}

function isDshDefaultWorkspaceDir(segLower) {
  const idx = segLower.indexOf('deepseek-harness');
  if (idx === -1) return false;
  const after = segLower.slice(idx + 1);
  // Block `.../deepseek-harness`, `.../deepseek-harness/default-workspace` (and its subdirs),
  // and bare `.../deepseek-harness/workspaces` root
  if (after.length === 0) return true;
  if (after[0] === 'default-workspace') return true;
  if (after.length === 1 && after[0] === 'workspaces') return true;
  return false;
}

/**
 * Non-blocking heuristic checking whether a path looks like a common cloud drive or NAS folder.
 */
export function looksLikeCloudDrivePath(rawPath) {
  const cleaned = stripOuterQuotes(rawPath);
  if (!cleaned) return false;
  const posix = cleaned.replace(/\\/g, '/');
  if (posix.startsWith('//')) return true;
  return /(?:onedrive|icloud|cloudstorage|clouddocs|nutstore|坚果云|dropbox|baidunetdisk|百度网盘|googledrive|google\s+drive|synology|nextcloud|seafile|wps|quark|\bnas\b|mobile\s+documents)/i.test(posix);
}

/**
 * Validate a candidate project workspace directory before binding or saving as a pull override.
 * Rejects drive roots, OS system directories, user home directories, `.dsh` / `dshHome`,
 * `vaultDir` (exact/parent/child), `.../deepseek-harness` (`default-workspace`),
 * and bare personal/cloud folder roots (while ALLOWING specific project subfolders inside them!).
 *
 * @returns {{ ok: true, normalizedPath: string } | { ok: false, error: string, code: string }}
 */
export function validateWorkspaceDirectory(rawPath, targetPlatform = process.platform, { dshHome, vaultDir } = {}) {
  let cleaned = stripOuterQuotes(rawPath).normalize('NFC');
  if (!cleaned) {
    return { ok: false, code: 'empty', error: '工作区目录路径不能为空。' };
  }

  if (targetPlatform === 'win32') {
    if (cleaned === '~' || cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
      return {
        ok: false,
        code: 'tilde-win32',
        error: 'Windows 路径不能使用 `~/`，请填写完整绝对路径（例如 `D:\\美股分析`）。',
      };
    }
    if (!isWinAbsPath(cleaned)) {
      return {
        ok: false,
        code: 'invalid-format',
        error: `Windows 路径格式无效（\`${cleaned}\`），应以盘符开头（例如 \`D:\\美股分析\`）。`,
      };
    }
  } else {
    if (cleaned === '~' || cleaned.startsWith('~/')) {
      if (targetPlatform !== process.platform) {
        return {
          ok: false,
          code: 'tilde-cross-os',
          error: '在 Windows 上无法自动展开 macOS 的 `~/`，请填写完整路径（例如 `/Users/你的用户名/美股分析`）。',
        };
      }
      cleaned = expandPosixHome(cleaned, targetPlatform).normalize('NFC');
    }
    if (!isPosixAbsPath(cleaned)) {
      return {
        ok: false,
        code: 'invalid-format',
        error: `macOS 路径格式无效（\`${cleaned}\`），应以 \`/\` 开头（例如 \`/Users/me/美股分析\`）。`,
      };
    }
  }

  // Collapse `.` and `..` segments before all root/system/personal/vault security checks!
  cleaned = normalizeAbsolutePlatformPath(cleaned, targetPlatform);

  // 1. Vault directory exact / child / parent check (highest priority for clear vault guidance)
  if (vaultDir && String(vaultDir).trim()) {
    const cleanVault = stripOuterQuotes(vaultDir).normalize('NFC');
    if (isSameOrInsidePath(cleaned, cleanVault)) {
      return {
        ok: false,
        code: 'vault-dir',
        error: `路径 \`${cleaned}\` 是当前的「防灾金库目录（vaultDir）」，专门用于存放加密同步快照，不需要也不能绑定为日常项目工作区。如果您是想更换金库目录，请在最上方「🔑 金库连接与加密基础设置」中点击「更换金库 / 修改口令」。`,
      };
    }
    if (isSameOrInsidePath(cleanVault, cleaned)) {
      return {
        ok: false,
        code: 'vault-parent',
        error: `路径 \`${cleaned}\` 包含了当前的「防灾金库目录（\`${cleanVault}\`）」，不能直接将金库的上级目录绑定为项目工作区（避免把金库密文当作项目产出扫描）。请为日常项目与防灾金库使用互不嵌套的独立目录。`,
      };
    }
  }

  const { segments, segLower } = parseNormalizedPathSegments(cleaned, targetPlatform);

  // 2. DSH internal data directory (`<dshHome>` or any `/.dsh` segment)
  if (
    (dshHome && isSameOrInsidePath(cleaned, dshHome))
    || segLower.includes('.dsh')
  ) {
    return {
      ok: false,
      code: 'dsh-internal',
      error: `路径 \`${cleaned}\` 是 DeepSeek Harness 内部数据目录（.dsh），禁止绑定为项目工作区。请绑定具体的项目子文件夹（例如 \`${targetPlatform === 'win32' ? 'D:\\美股分析' : '/Users/你的名字/美股分析'}\`）。`,
    };
  }

  // 3. Drive root & OS system directories
  if (isSystemOrDriveRoot(segments, segLower, targetPlatform)) {
    return {
      ok: false,
      code: 'system-or-root',
      error: `路径 \`${cleaned}\` 是磁盘根目录或系统目录，不能直接绑定为项目工作区（会导致全盘扫描并混入系统文件）。请绑定具体的单个项目子文件夹（例如 \`${targetPlatform === 'win32' ? 'D:\\美股分析' : '/Users/你的名字/美股分析'}\`）。`,
    };
  }

  // 4. User home directory itself
  if (isUserHomeDir(segments, segLower, targetPlatform, cleaned)) {
    return {
      ok: false,
      code: 'user-home',
      error: `路径 \`${cleaned}\` 是用户主目录，范围过大不能直接绑定为项目工作区。请在主目录下选择具体的项目子文件夹（例如 \`${targetPlatform === 'win32' ? 'C:\\Users\\你的名字\\美股分析' : '/Users/你的名字/美股分析'}\`）。`,
    };
  }

  // 5. DSH default-workspace / deepseek-harness internal root
  if (isDshDefaultWorkspaceDir(segLower)) {
    return {
      ok: false,
      code: 'dsh-default-workspace',
      error: `路径 \`${cleaned}\` 是 DeepSeek Harness 默认通用工作区目录，不建议直接绑定全目录追踪。请绑定您自己的具体项目子文件夹（例如 \`${targetPlatform === 'win32' ? 'D:\\美股分析' : '/Users/你的名字/Documents/美股分析'}\`）。`,
    };
  }

  // 6. Bare personal broad folder roots (ONLY the root itself; specific child project folders pass!)
  const leafLower = segLower[segLower.length - 1] || '';
  if (BARE_PERSONAL_FOLDER_NAMES.has(leafLower)) {
    return {
      ok: false,
      code: 'bare-personal-dir',
      error: `路径 \`${cleaned}\` 是整个个人大目录（桌面/文档/下载等），直接绑定会递归监听并同步无关私人文件。请绑定其下一层的具体项目子文件夹（例如 \`${targetPlatform === 'win32' ? `${cleaned.replace(/[\\/]+$/, '')}\\我的项目` : `${cleaned.replace(/\/+$/, '')}/我的项目`}\`）。`,
    };
  }

  // 7. Bare cloud drive roots (ONLY the root itself; specific child folders pass!)
  if (isBareCloudRootSegment(leafLower)) {
    return {
      ok: false,
      code: 'bare-cloud-root',
      error: `路径 \`${cleaned}\` 是网盘根目录，不能直接绑定为项目工作区（否则会扫描整个网盘并与云同步冲突）。请绑定本地独立的项目子文件夹，例如 \`${targetPlatform === 'win32' ? 'D:\\美股分析' : '/Users/你的名字/美股分析'}\`。`,
    };
  }

  return { ok: true, normalizedPath: cleaned };
}

/**
 * Convenience helper to test whether a local workspace path is an unsafe broad/system directory
 * (used to filter quick-pick dropdowns in the migration UI).
 */
export function isBroadWorkspaceDirectory(rawPath, targetPlatform = process.platform, opts = {}) {
  if (!rawPath || !String(rawPath).trim()) return false;
  const res = validateWorkspaceDirectory(rawPath, targetPlatform, opts);
  return !res.ok;
}

/**
 * Validate a candidate vault directory (`vaultDir`) for the target host OS.
 * Strips outer quotes, enforces host-OS absolute path format (preventing Windows `path.resolve`
 * from silently turning `/Users/...` into `D:\Users\...`), rejects roots/home/`.dsh`/bare personal dirs,
 * and prevents nesting with any existing `workspaceMappings`.
 *
 * @returns {{ ok: true, normalizedPath: string, looksLikeCloudDrive: boolean } | { ok: false, error: string, code: string }}
 */
export function validateVaultDirectory(rawPath, platform = process.platform, { dshHome, workspaceMappings = [] } = {}) {
  let cleaned = stripOuterQuotes(rawPath).normalize('NFC');
  if (!cleaned) {
    return { ok: false, code: 'empty', error: '请先填写网盘防灾金库目录路径。' };
  }

  if (platform === 'win32') {
    if (cleaned === '~' || cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
      return {
        ok: false,
        code: 'tilde-win32',
        error: 'Windows 金库路径不能使用 `~/`，请填写完整路径（例如 `D:\\OneDrive\\dsh-vault`）。',
      };
    }
    if (isPosixAbsPath(cleaned)) {
      return {
        ok: false,
        code: 'cross-os-path',
        error: `当前是 Windows 电脑，不能直接填写以 \`/\` 开头的 Mac 路径（\`${cleaned}\`）。请填写这台 Windows 电脑上的网盘文件夹路径（例如 \`D:\\OneDrive\\dsh-vault\`）。`,
      };
    }
    if (!isWinAbsPath(cleaned)) {
      return {
        ok: false,
        code: 'invalid-format',
        error: `Windows 金库路径格式无效（\`${cleaned}\`），请填写带盘符的完整路径（例如 \`D:\\OneDrive\\dsh-vault\`）。`,
      };
    }
  } else {
    if (cleaned === '~' || cleaned.startsWith('~/')) {
      if (platform !== process.platform) {
        return {
          ok: false,
          code: 'tilde-cross-os',
          error: '请填写完整的绝对路径（例如 `/Users/你的用户名/Nutstore Files/dsh-vault`）。',
        };
      }
      cleaned = expandPosixHome(cleaned, platform).normalize('NFC');
    }
    if (isWinAbsPath(cleaned)) {
      return {
        ok: false,
        code: 'cross-os-path',
        error: `当前是 macOS/Linux 电脑，不能直接填写带盘符的 Windows 路径（\`${cleaned}\`）。请填写这台电脑上的网盘文件夹路径（例如 \`/Users/你的名字/Library/CloudStorage/OneDrive-Personal/dsh-vault\`）。`,
      };
    }
    if (!isPosixAbsPath(cleaned)) {
      return {
        ok: false,
        code: 'invalid-format',
        error: `金库路径格式无效（\`${cleaned}\`），应以 \`/\` 开头（例如 \`/Users/你的名字/Nutstore Files/dsh-vault\`）。`,
      };
    }
  }

  // Collapse `.` and `..` segments before all root/system/personal/cloud security checks!
  cleaned = normalizeAbsolutePlatformPath(cleaned, platform);

  const { segments, segLower } = parseNormalizedPathSegments(cleaned, platform);

  if ((dshHome && isSameOrInsidePath(cleaned, dshHome)) || segLower.includes('.dsh')) {
    return {
      ok: false,
      code: 'dsh-internal',
      error: `防灾金库目录不能放在 DeepSeek Harness 内部目录（\`${cleaned}\`）中，请改选网盘同步目录下的专用空文件夹。`,
    };
  }

  if (isSystemOrDriveRoot(segments, segLower, platform)) {
    return {
      ok: false,
      code: 'system-or-root',
      error: `防灾金库目录不能设为磁盘根目录或系统目录（\`${cleaned}\`），请在网盘中新建专门的空子文件夹（例如 \`dsh-vault\`）。`,
    };
  }

  if (isUserHomeDir(segments, segLower, platform, cleaned)) {
    return {
      ok: false,
      code: 'user-home',
      error: `防灾金库目录不能设为整个用户主目录（\`${cleaned}\`），请在网盘同步文件夹内新建专门的空子文件夹（例如 \`dsh-vault\`）。`,
    };
  }

  if (isDshDefaultWorkspaceDir(segLower)) {
    return {
      ok: false,
      code: 'dsh-default-workspace',
      error: `防灾金库目录不能设为 DeepSeek Harness 默认工作区（\`${cleaned}\`），请改选网盘同步目录下的专用空文件夹。`,
    };
  }

  const leafLower = segLower[segLower.length - 1] || '';
  if (BARE_PERSONAL_FOLDER_NAMES.has(leafLower)) {
    return {
      ok: false,
      code: 'bare-personal-dir',
      error: `防灾金库目录不能直接设为整个「桌面/文档/下载」大目录（\`${cleaned}\`），请改选网盘同步目录中的专用空子文件夹（例如 \`dsh-vault\`）。`,
    };
  }

  if (isBareCloudRootSegment(leafLower)) {
    const exampleSub = platform === 'win32'
      ? `${cleaned.replace(/[\\/]+$/, '')}\\DSH`
      : `${cleaned.replace(/\/+$/, '')}/DSH`;
    return {
      ok: false,
      code: 'bare-cloud-root',
      error: `防灾金库目录不能直接设为网盘根目录（\`${cleaned}\`），否则会把金库文件直接散落到网盘顶层。请在网盘内新建一个专用空子文件夹作为金库（例如 \`${exampleSub}\`）。`,
    };
  }

  for (const m of Array.isArray(workspaceMappings) ? workspaceMappings : []) {
    const localWs = m?.[platform];
    if (!localWs) continue;
    if (isSameOrInsidePath(cleaned, localWs) || isSameOrInsidePath(localWs, cleaned)) {
      return {
        ok: false,
        code: 'workspace-overlap',
        error: `防灾金库目录（\`${cleaned}\`）不能与已绑定的项目工作区「${m.title || m.id}」（\`${localWs}\`）相同或互相嵌套。请为网盘金库选择独立的空文件夹。`,
      };
    }
  }

  return {
    ok: true,
    normalizedPath: cleaned,
    looksLikeCloudDrive: looksLikeCloudDrivePath(cleaned),
  };
}

async function safeRemoveProfilePluginSymlink(linkPath) {
  let stat;
  try {
    stat = await fs.lstat(linkPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { removed: false, reason: 'absent' };
    throw err;
  }
  if (!stat.isSymbolicLink()) {
    // NEVER recursively remove a real directory! Only unlink symlinks / Windows junctions.
    return { removed: false, reason: 'not-symlink' };
  }
  try {
    await fs.unlink(linkPath);
    return { removed: true, method: 'unlink' };
  } catch (err) {
    // On Windows, directory junctions may require fs.rmdir instead of fs.unlink
    if (err?.code === 'EPERM' || err?.code === 'EISDIR' || err?.code === 'EACCES') {
      await fs.rmdir(linkPath);
      return { removed: true, method: 'rmdir' };
    }
    throw err;
  }
}

/**
 * Safely uninstall `dsh-soul-sync` from a `<dshHome>` directory without touching
 * user sessions, storages, attachments, `.credentials.yaml`, vault data, or the plugin source repo!
 */
export async function uninstallPluginFromDshHome(dshHome) {
  const homeDir = resolveDshHome(dshHome);
  const removedProfiles = [];
  const removedLinks = [];

  for (const profileName of ['desktop', 'web']) {
    const profileDir = path.join(homeDir, 'profiles', profileName);
    const pkgPath = path.join(profileDir, 'package.json');
    try {
      const raw = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      let changed = false;
      if (pkg?.dependencies && Object.hasOwn(pkg.dependencies, 'dsh-soul-sync')) {
        delete pkg.dependencies['dsh-soul-sync'];
        changed = true;
      }
      if (Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('dsh-soul-sync')) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== 'dsh-soul-sync');
        changed = true;
      }
      if (changed) {
        await writeFileAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, { mode: 0o644 });
        removedProfiles.push(profileName);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const linkPath = path.join(profileDir, 'node_modules', 'dsh-soul-sync');
    const linkRes = await safeRemoveProfilePluginSymlink(linkPath);
    if (linkRes.removed) {
      removedLinks.push(linkPath);
    }
  }

  // Also check shared `<dshHome>/profiles/node_modules/dsh-soul-sync` symlink if present
  const sharedLink = path.join(homeDir, 'profiles', 'node_modules', 'dsh-soul-sync');
  const sharedLinkRes = await safeRemoveProfilePluginSymlink(sharedLink);
  if (sharedLinkRes.removed) {
    removedLinks.push(sharedLink);
  }

  // Remove installed skill directory
  const skillDir = path.join(homeDir, 'skills', 'soul-handoff');
  let removedSkill = false;
  try {
    await fs.stat(skillDir);
    await fs.rm(skillDir, { recursive: true, force: true });
    removedSkill = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  // Strip only the Soul Sync cross-OS rules block from `<dshHome>/AGENTS.md`
  const agentsRes = await removeGlobalAgentsRules(homeDir);

  // Remove `<dshHome>/soul-sync/` config/state/key directory
  const syncDir = soulSyncDir(homeDir);
  let removedSoulSyncDir = false;
  try {
    await fs.stat(syncDir);
    await fs.rm(syncDir, { recursive: true, force: true });
    removedSoulSyncDir = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  return {
    ok: true,
    dshHome: homeDir,
    removedProfiles,
    removedLinks,
    removedSkill,
    updatedAgentsMd: agentsRes.updated,
    removedSoulSyncDir,
  };
}
