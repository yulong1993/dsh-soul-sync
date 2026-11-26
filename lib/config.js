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
const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const MAX_RENAME_RETRIES = 8;

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

export function deriveWorkspaceId(winPath, macPath) {
  const base = extractDirBasename(winPath) || extractDirBasename(macPath) || 'workspace';
  const safe = base
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (safe.length > 0) return safe;
  return `ws-${crypto.createHash('sha256').update(`${winPath}::${macPath}`).digest('hex').slice(0, 6)}`;
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
 * Derive `{ encKey, hmacKey }` (32 bytes each) via `scryptSync` and persist locally
 * inside `<dshHome>/soul-sync/secret.key` (never inside `vaultDir`).
 * Passing an empty passphrase clears the local key file (plaintext mode).
 */
export async function savePassphraseKey(dshHome, passphrase, salt) {
  const keyPath = path.join(soulSyncDir(dshHome), 'secret.key');
  if (passphrase === null || passphrase === undefined || passphrase === '') {
    await fs.rm(keyPath, { force: true });
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

  const payload = {
    saltHex: saltBuf.toString('hex'),
    encKeyHex: encKey.toString('hex'),
    hmacKeyHex: hmacKey.toString('hex'),
  };
  await writeFileAtomic(keyPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });

  return {
    ...payload,
    encKey,
    hmacKey,
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
  return {
    saltHex: parsed.saltHex,
    encKeyHex: parsed.encKeyHex,
    hmacKeyHex: parsed.hmacKeyHex,
    encKey,
    hmacKey,
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
  const nfcRaw = String(rawPath ?? '').normalize('NFC');
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
      const srcRoot = mapping[srcOs];
      if (typeof srcRoot !== 'string' || srcRoot.length === 0) continue;

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

  const targetRoot = bestMatch.mapping[targetPlatform];
  if (typeof targetRoot !== 'string' || targetRoot.length === 0) {
    return {
      mappedPath: nfcRaw,
      workspaceId: bestMatch.mapping.id ?? null,
      relativePosixPath: bestMatch.relativePosixPath,
      matched: false,
    };
  }

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
  const resolved = path.resolve(String(targetPath));
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
