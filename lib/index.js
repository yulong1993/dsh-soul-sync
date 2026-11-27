import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_QUOTAS,
  VALID_FOLDER_MATCH_MODES,
  VALID_SYNC_SCOPES,
  resolveDshHome,
  soulSyncDir,
  loadConfig,
  saveConfig,
  derivePassphraseKey,
  savePassphraseKey,
  loadPassphraseKey,
  mapPathAcrossOs,
  ensureGlobalAgentsRules,
  writeFileAtomic,
  expandPosixHome,
  deriveWorkspaceId,
  stripOuterQuotes,
  looksLikeCloudDrivePath,
  validateWorkspaceDirectory,
  validateVaultDirectory,
  uninstallPluginFromDshHome,
} from './config.js';
import { importHostPackage } from './host-loader.js';
import { VaultStore } from './crypto-vault.js';
import {
  AUTO_MIRROR_SENTINEL,
  scanLocalSessions,
  extractSessionTitle,
  exportSessionClosure,
  exportAllLocalSessions,
  pullSessionsFromVault,
  consumePendingMigration,
  listLocalCatalog,
  listVaultCatalog,
  shouldAutoSyncSession,
  matchesWorkspaceSelector,
  recordSessionProducedFile,
  rehomeLocalSessionsInWorkspace,
  remapEventSeqReferences,
} from './session-plane.js';
import {
  recordDeliverableCandidate,
  createActiveWorkspaceWatcher,
  detectOpenOfficeLocks,
  pushWorkspaceDeliverables,
  pullWorkspaceDeliverables,
  loadWorkspaceDeliverableState,
} from './deliverable-plane.js';
import { interceptCompactionStream } from './compaction-soul.js';
import { compactSessionPreservingTail } from './tail-compactor.js';
import { createSoulRecallTool } from './recall-tool.js';
import { parseNaturalSoulIntent, parseBooleanToggle } from './nl-router.js';
import { checkRemoteUpdate, applyRemoteUpdate } from './self-updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const name = 'dsh-soul-sync';

const schemasteryMod = await importHostPackage('@deepseek-ai/schemastery');
const SchemaZ = schemasteryMod?.default ?? schemasteryMod?.Schema ?? null;

export const Config = SchemaZ
  ? SchemaZ.object({
      vaultDir: SchemaZ.string()
        .default('')
        .description('同步金库文件夹路径（例如坚果云 / OneDrive / iCloud 同步目录，双机指向同一共享目录）')
        .volatile(),
      passphrase: SchemaZ.string()
        .role('secret')
        .default('')
        .description('端到端加密口令（AES-256-GCM，双机填同一口令；留空则保持现有密钥不变）')
        .volatile(),
      stepSyncEnabled: SchemaZ.boolean()
        .default(true)
        .description('运行中每 30 秒防断电快照开关（关闭后仅在每轮对话结束时安全同步）')
        .volatile(),
      deviceLabel: SchemaZ.string()
        .default('')
        .description('本机名称（例如「公司Win」「家里Mac」，留空则使用当前配置）')
        .volatile(),
    })
  : undefined;

function unwrapVolatile(val) {
  if (val && typeof val === 'object' && typeof val.get === 'function') {
    try {
      return val.get();
    } catch {
      return undefined;
    }
  }
  return val;
}

const DEFAULT_POLL_INTERVAL_MS = 15000;
const BLANK_PAGE_CARD_INTENTS = new Set([
  'status',
  'pull',
  'push',
  'unpublish',
  'sync',
  'list',
  'set-mode',
  'set-scope',
  'help',
  'help-with-status',
  'config',
  'set-step-sync',
  'add-mapping',
]);

function isLoopbackRemoteAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAllowedLoopbackHost(hostHeader) {
  if (hostHeader === undefined || hostHeader === null || hostHeader === '') return true;
  if (typeof hostHeader !== 'string') return false;
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return true;
  let hostname = trimmed;
  if (hostname.startsWith('[')) {
    const closeIdx = hostname.indexOf(']');
    if (closeIdx === -1) return false;
    hostname = hostname.slice(0, closeIdx + 1);
  } else {
    const colonIdx = hostname.lastIndexOf(':');
    if (colonIdx !== -1) {
      hostname = hostname.slice(0, colonIdx);
    }
  }
  return (
    hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1'
    || hostname === 'app'
  );
}

function isAllowedLoopbackOrigin(origin, hostHeader = '') {
  if (!origin || typeof origin !== 'string') return true;
  const trimmed = origin.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'dsh-app:' && parsed.hostname.toLowerCase() === 'app') return true;
    if (parsed.protocol === 'app:' || parsed.protocol === 'dsh:') return true;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
    if (!isLoopback) return false;
    // C1: NEVER allow arbitrary cross-port localhost origins (e.g., http://localhost:5173 -> Host: 127.0.0.1:3080)!
    // An http(s) loopback Origin MUST exactly match the request's Host (hostname + port).
    const trimmedHost = typeof hostHeader === 'string' ? hostHeader.trim() : '';
    if (!trimmedHost) return false;
    const hostUrl = new URL(`${parsed.protocol}//${trimmedHost}`);
    return parsed.host.toLowerCase() === hostUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function getCtxService(ctx, key) {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') {
    return ctx.get(key);
  }
  return ctx[key];
}

const FILE_MODIFY_TOOLS = new Set([
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

let cachedDshLlmModLoader = null;

async function tryLoadDshLlmMod() {
  if (!cachedDshLlmModLoader) {
    cachedDshLlmModLoader = importHostPackage('@deepseek-ai/dsh-llm');
  }
  return cachedDshLlmModLoader;
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (!Object.isFrozen(obj)) {
    Object.freeze(obj);
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Construct a DSH-compatible persistent `UserMessage` with a custom non-human `source`
 * (e.g. `{ kind: 'dsh-soul-sync', form: 'notice', summary: '...' }`) so DSH chat UI
 * renders it as a native collapsed `ContextInjectionRow` instead of a human chat bubble.
 */
export async function createPersistentContextMessage(text, source) {
  const mod = await tryLoadDshLlmMod();
  const createUserMessage = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null;
  const safeSource = source && typeof source === 'object'
    ? { ...source }
    : { kind: 'dsh-soul-sync', form: 'notice', summary: 'Soul Sync 上下文' };
  const payload = {
    content: [{ type: 'text', text: String(text) }],
    source: safeSource,
  };
  if (createUserMessage) {
    try {
      return createUserMessage(payload);
    } catch {
      // Fallback below if host signature differs
    }
  }
  return deepFreeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: safeSource,
  });
}

/**
 * Construct a DSH-compatible persistent `UserMessage`.
 * Dynamically uses `@deepseek-ai/dsh-llm`'s `createUserMessage` when available,
 * and falls back to a deeply frozen structural equivalent in standalone environments.
 */
export async function createPersistentUserMessage(text) {
  return createPersistentContextMessage(text, { kind: 'user' });
}

/**
 * Construct a DSH-compatible persistent `AssistantMessage` (without `replayState`,
 * verified 100% compatible with `Session`, `dsh-token-meter`, and `dsh-llm-deepseek` `serialize()`).
 */
export async function createPersistentAssistantMessage(text, modelTriple = null) {
  const mod = await tryLoadDshLlmMod();
  const createAssistantMessage = typeof mod?.createAssistantMessage === 'function' ? mod.createAssistantMessage : null;
  const provider = modelTriple?.provider || 'deepseek';
  const model = modelTriple?.model || 'deepseek-chat';
  const content = [{ type: 'text', text: String(text) }];
  if (createAssistantMessage) {
    try {
      return createAssistantMessage({
        content,
        source: { provider, model },
      });
    } catch {
      // Fallback below if host signature differs
    }
  }
  return deepFreeze({
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    source: { kind: 'model', provider, model },
  });
}

function isBlankLiveSession(session) {
  if (!session || typeof session !== 'object') return false;
  if (typeof session.append !== 'function') return false;
  if (!session.surface || !Array.isArray(session.surface.nodes)) return false;
  for (const node of session.surface.nodes) {
    const ev = typeof node === 'number' && typeof session.eventAt === 'function'
      ? session.eventAt(node)
      : (node?.event ?? node);
    if (ev?.type === 'user/message' || ev?.type === 'assistant/message') {
      return false;
    }
  }
  if (typeof session.snapshotEvents === 'function') {
    const evs = session.snapshotEvents();
    if (Array.isArray(evs) && evs.some((ev) => ev?.type === 'turn/start' || ev?.type === 'user/message' || ev?.type === 'assistant/message')) {
      return false;
    }
  }
  return true;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function pathExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function unpackSessionEventArgs(arg1, arg2) {
  if (arg2 && typeof arg2 === 'object' && typeof arg2.type === 'string') {
    return { session: arg1 ?? null, event: arg2 };
  }
  if (arg1 && typeof arg1 === 'object') {
    if (arg1.event && typeof arg1.event.type === 'string') {
      return { session: arg1.session ?? null, event: arg1.event };
    }
    if (typeof arg1.type === 'string') {
      return { session: arg1.session ?? null, event: arg1 };
    }
  }
  return { session: null, event: null };
}

function extractToolPaths(payload) {
  const paths = [];
  const collect = (raw) => {
    let obj = raw;
    if (typeof obj === 'string') {
      const trimmed = obj.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
    }
    if (!obj || typeof obj !== 'object') return;
    for (const key of ['path', 'file_path', 'filePath', 'targetPath', 'TargetFile', 'file']) {
      if (typeof obj[key] === 'string' && obj[key].trim().length > 0) {
        paths.push(obj[key].trim());
      }
    }
    if (Array.isArray(obj.paths)) {
      for (const p of obj.paths) {
        if (typeof p === 'string' && p.trim().length > 0) paths.push(p.trim());
      }
    }
    if (Array.isArray(obj.files)) {
      for (const f of obj.files) {
        if (typeof f === 'string' && f.trim().length > 0) {
          paths.push(f.trim());
        } else if (f && typeof f === 'object' && typeof f.path === 'string' && f.path.trim().length > 0) {
          paths.push(f.path.trim());
        }
      }
    }
  };
  collect(payload?.input);
  collect(payload?.args);
  collect(payload?.arguments);
  collect(payload?.result);
  collect(payload?.meta);
  collect(payload?.result?.meta);
  return [...new Set(paths)];
}

function normalizeModelTier(modelName) {
  if (typeof modelName !== 'string' || !modelName.trim()) return 'unknown';
  const lower = modelName.toLowerCase();
  if (lower.includes('flash')) return 'flash';
  if (lower.includes('v4-pro') || lower.includes('v4pro') || lower.includes('reasoner')) return 'v4pro';
  return lower;
}

function formatModelTriple(triple) {
  if (!triple || (!triple.provider && !triple.model)) return '未检测到';
  const parts = [];
  if (triple.provider) parts.push(triple.provider);
  if (triple.model) parts.push(triple.model);
  const base = parts.join('/');
  return triple.reasoningEffort ? `${base} (effort: ${triple.reasoningEffort})` : base;
}

function formatAgeSeconds(tsMs, nowMs = Date.now()) {
  if (!tsMs || !Number.isFinite(tsMs)) return '尚未备份';
  const sec = Math.max(0, Math.round((nowMs - tsMs) / 1000));
  if (sec < 60) return `距今 ${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `距今 ${min} 分 ${rem} 秒 (${sec} 秒前)`;
}

function buildHandoffPrompt(extraNote) {
  const lines = [
    '请以**第一人称“我 / 我们”视角**，直接在当前对话中写一段 150~250 字的《中场交接心路日记》，方便我换到另一台设备继续推进时零割裂接手：',
    '1. 我们当前正在攻克的核心命题与最新进展；',
    '2. 我刚才已经验证走不通、排除了哪个死胡同（伤疤防重踩）；',
    '3. 【Flash → V4Pro 视觉文字桥接】如果前文看过任何图片、截图或图表，必须把图里的核心指标数值、趋势与判断完整写成文字，防止换机后切到纯文本 `deepseek-v4-pro` 失明；',
    '4. 如果有依赖当前单机独有本地原始大库的步骤，请顺带注明缺口；最后写明换机后的第一步行动建议。',
  ];
  if (extraNote) {
    lines.push('', `【用户补充交接说明】${extraNote}`);
  }
  return lines.join('\n');
}

export class SoulSyncController {
  constructor(ctx = null, pluginConfig = {}) {
    this.ctx = ctx;
    this.pluginConfig = pluginConfig ?? {};
    const ctxConfig = getCtxService(ctx, 'config');
    const ctxApp = getCtxService(ctx, 'app');
    this.dshHome = resolveDshHome(
      this.pluginConfig.dshHome ?? getCtxService(ctx, 'dshHome') ?? ctxConfig?.dshHome,
    );
    this.platform = this.pluginConfig.platform ?? process.platform;
    this.dshVersion =
      this.pluginConfig.dshVersion
      ?? getCtxService(ctx, 'dshVersion')
      ?? ctxApp?.version
      ?? process.env.DSH_VERSION
      ?? '0.2.2';
    this.minQuietMs = typeof this.pluginConfig.minQuietMs === 'number'
      ? this.pluginConfig.minQuietMs
      : 1500;
    const rawPollMs = unwrapVolatile(this.pluginConfig.pollIntervalMs);
    this.pollIntervalMs = typeof rawPollMs === 'number'
      ? rawPollMs
      : DEFAULT_POLL_INTERVAL_MS;

    this.config = null;
    this.secretKeys = null;
    this.vault = null;
    this.defaultModelTriple = null;
    this._cachedModelTriple = null;
    this._modelTripleDetected = false;

    this._watchers = new Map();
    this._timers = new Set();
    this._pollTimer = null;
    this._syncInFlight = false;
    this._syncChain = Promise.resolve();
    this._seenRemoteCommitFiles = new Set();
    this._syntheticTurnSessions = new Set();
    this._releasingForFastForward = new Set();
    this._fastForwardingSessionIds = new Set();
    this._deferredBusySessions = new Set();
    this._lastStepSyncAt = new Map();
    this._pendingToolCalls = new Map();
    this._pendingHandoffSessions = new Set();
    this._pendingAlerts = [];
    this._lastBackupAt = null;
    this._lastPullAt = null;
    this._baton = { state: 'active', holder: null, updatedAt: null };
    this._lastVolatileSnapshot = this._readVolatileSettings();
    this._disposed = false;
    this._uninstalled = false;
    this._startupErrors = [];
    this.readyPromise = Promise.resolve();
  }

  _readVolatileSettings() {
    const rawVaultDir = unwrapVolatile(this.pluginConfig?.vaultDir);
    const rawPassphrase = unwrapVolatile(this.pluginConfig?.passphrase);
    const rawStepSync = unwrapVolatile(this.pluginConfig?.stepSyncEnabled);
    const rawDeviceLabel = unwrapVolatile(this.pluginConfig?.deviceLabel);
    return {
      vaultDir: typeof rawVaultDir === 'string' ? stripOuterQuotes(rawVaultDir) : '',
      passphrase: typeof rawPassphrase === 'string' ? rawPassphrase : '',
      stepSyncEnabled: typeof rawStepSync === 'boolean' ? rawStepSync : undefined,
      deviceLabel: typeof rawDeviceLabel === 'string' ? rawDeviceLabel.trim() : '',
    };
  }

  _computeVolatileFieldHashes(snapshot) {
    return {
      vaultHash: snapshot?.vaultDir ? sha256Hex(snapshot.vaultDir) : '',
      passHash: snapshot?.passphrase ? sha256Hex(snapshot.passphrase) : '',
      labelHash: snapshot?.deviceLabel ? sha256Hex(snapshot.deviceLabel) : '',
      stepSync: typeof snapshot?.stepSyncEnabled === 'boolean' ? snapshot.stepSyncEnabled : null,
    };
  }

  async _loadVolatileState() {
    const statePath = path.join(soulSyncDir(this.dshHome), 'volatile-state.json');
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
      const hasPerField =
        typeof parsed?.vaultHash === 'string'
        || typeof parsed?.passHash === 'string'
        || typeof parsed?.labelHash === 'string';
      return {
        exists: true,
        hasPerField,
        vaultHash: typeof parsed?.vaultHash === 'string' ? parsed.vaultHash : '',
        passHash: typeof parsed?.passHash === 'string' ? parsed.passHash : '',
        labelHash: typeof parsed?.labelHash === 'string' ? parsed.labelHash : '',
        stepSync: typeof parsed?.stepSync === 'boolean' ? parsed.stepSync : null,
        lastConsumedSig: typeof parsed?.lastConsumedSig === 'string' ? parsed.lastConsumedSig : null,
      };
    } catch {
      return {
        exists: false,
        hasPerField: false,
        vaultHash: '',
        passHash: '',
        labelHash: '',
        stepSync: null,
        lastConsumedSig: null,
      };
    }
  }

  async _saveVolatileState(fields) {
    const statePath = path.join(soulSyncDir(this.dshHome), 'volatile-state.json');
    const payload = {
      vaultHash: typeof fields?.vaultHash === 'string' ? fields.vaultHash : '',
      passHash: typeof fields?.passHash === 'string' ? fields.passHash : '',
      labelHash: typeof fields?.labelHash === 'string' ? fields.labelHash : '',
      stepSync: typeof fields?.stepSync === 'boolean' ? fields.stepSync : null,
      updatedAt: Date.now(),
    };
    await writeFileAtomic(statePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }

  async syncVolatileSettings({ triggerPull = true, isStartup = false } = {}) {
    if (this._disposed || this._uninstalled) return { updated: false };
    if (!this.config) await this.reloadConfig();
    const current = this._readVolatileSettings();
    const prev = this._lastVolatileSnapshot ?? {};
    const curHashes = this._computeVolatileFieldHashes(current);
    const volatileState = await this._loadVolatileState();
    const configPath = path.join(soulSyncDir(this.dshHome), 'config.json');
    const configExists = await pathExists(configPath);

    // P0-3 / P1-1: Track consumed native plugin volatile settings PER FIELD so:
    // - disconnect / reset + restart NEVER resurrects stale vaultDir/passphrase;
    // - editing a single native field (e.g. deviceLabel) offline NEVER rolls back untouched vaultDir/passphrase!
    const patch = {};
    let passphraseChanged = false;

    if (isStartup) {
      if (volatileState.exists && volatileState.hasPerField) {
        if (current.vaultDir && curHashes.vaultHash !== volatileState.vaultHash && current.vaultDir !== this.config.vaultDir) {
          patch.vaultDir = current.vaultDir;
        }
        if (current.deviceLabel && curHashes.labelHash !== volatileState.labelHash && current.deviceLabel !== this.config.deviceLabel) {
          patch.deviceLabel = current.deviceLabel;
        }
        if (
          typeof current.stepSyncEnabled === 'boolean'
          && volatileState.stepSync !== null
          && current.stepSyncEnabled !== volatileState.stepSync
          && current.stepSyncEnabled !== this.config.stepSyncEnabled
        ) {
          patch.stepSyncEnabled = current.stepSyncEnabled;
        }
        if (current.passphrase && curHashes.passHash !== volatileState.passHash) {
          patch.passphrase = current.passphrase;
          passphraseChanged = true;
        }
      } else {
        if (current.vaultDir && current.vaultDir !== this.config.vaultDir) {
          patch.vaultDir = current.vaultDir;
        }
        if (current.deviceLabel && current.deviceLabel !== this.config.deviceLabel) {
          patch.deviceLabel = current.deviceLabel;
        }
        if (current.passphrase) {
          patch.passphrase = current.passphrase;
          passphraseChanged = true;
        }
      }
    } else {
      if (current.vaultDir && current.vaultDir !== prev.vaultDir) {
        patch.vaultDir = current.vaultDir;
      }
      if (current.deviceLabel && current.deviceLabel !== prev.deviceLabel) {
        patch.deviceLabel = current.deviceLabel;
      }
      if (
        typeof current.stepSyncEnabled === 'boolean'
        && current.stepSyncEnabled !== prev.stepSyncEnabled
        && current.stepSyncEnabled !== this.config.stepSyncEnabled
      ) {
        patch.stepSyncEnabled = current.stepSyncEnabled;
      }
      if (current.passphrase && current.passphrase !== prev.passphrase) {
        patch.passphrase = current.passphrase;
        passphraseChanged = true;
      }
    }

    this._lastVolatileSnapshot = current;

    if (Object.keys(patch).length === 0) {
      const fieldsDifferFromDisk =
        !volatileState.exists
        || !volatileState.hasPerField
        || curHashes.vaultHash !== volatileState.vaultHash
        || curHashes.passHash !== volatileState.passHash
        || curHashes.labelHash !== volatileState.labelHash
        || curHashes.stepSync !== volatileState.stepSync;
      if (configExists && fieldsDifferFromDisk && (current.vaultDir || current.passphrase || current.deviceLabel || volatileState.exists)) {
        await this._saveVolatileState(curHashes).catch(() => {});
      }
      return { updated: false };
    }

    // Route ALL volatile updates through `updateSettings` so they enjoy identical path validation
    // and majority-device passphrase guards instead of blindly overwriting `secret.key`!
    let updatedRes;
    try {
      updatedRes = await this.updateSettings(patch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this._startupErrors.includes(msg)) {
        this._startupErrors.push(msg);
      }
      this._pushAlert({ kind: 'settings-error', text: msg });
      await this._saveVolatileState(curHashes).catch(() => {});
      return { updated: false, blocked: true, error: msg };
    }

    await this._saveVolatileState(curHashes).catch(() => {});

    if (updatedRes?.keyUpdateBlocked) {
      const warnText = updatedRes.warning || '原生插件页输入的加密口令与金库已有设备不一致，已拦截未覆盖本地密钥。';
      if (!this._startupErrors.includes(warnText)) {
        this._startupErrors.push(warnText);
      }
      this._pushAlert({ kind: 'passphrase-guard', text: warnText });
      return { updated: false, blocked: true, warning: warnText };
    }

    if (triggerPull && this.vault && !this._disposed) {
      if (!patch.vaultDir && !passphraseChanged) {
        await this.pullAll({ silent: true }).catch(() => {});
      }
      await this.updateHeartbeat({ status: 'active' }).catch(() => {});
    }

    return { updated: true, patch, passphraseChanged };
  }

  _withSyncLock(fn) {
    const run = async () => {
      this._syncInFlight = true;
      try {
        return await fn();
      } finally {
        this._syncInFlight = false;
      }
    };
    const next = this._syncChain.then(run, run);
    this._syncChain = next.catch(() => {});
    return next;
  }

  async _scanRemoteCommitFingerprints() {
    const found = new Set();
    if (!this.vault || !this.config) return found;
    const devicesDir = path.join(this.vault.vaultDir, 'devices');
    let deviceDirs;
    try {
      deviceDirs = await fs.readdir(devicesDir, { withFileTypes: true });
    } catch {
      return found;
    }

    for (const dirent of deviceDirs) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name === this.config.deviceId) continue;
      for (const sub of ['session-commits', 'workspace-commits', 'global-commits']) {
        const dirPath = path.join(devicesDir, dirent.name, sub);
        let entries;
        try {
          entries = await fs.readdir(dirPath);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.endsWith('.commit') || entry.startsWith('.')) continue;
          found.add(`${dirent.name}/${sub}/${entry}`);
        }
      }
    }
    return found;
  }

  _pushAlert({ kind, text, workspaceId = null, workspacePath = null, sessionId = null } = {}) {
    if (!text) return null;
    const dedup = this._pendingAlerts.find(
      (a) => a.kind === kind && a.workspaceId === workspaceId && a.workspacePath === workspacePath && a.text === text,
    );
    if (dedup) return dedup;
    const alert = {
      id: crypto.randomUUID(),
      kind: kind || 'info',
      workspaceId: workspaceId || null,
      workspacePath: workspacePath || null,
      sessionId: sessionId || null,
      text: String(text),
      createdAt: Date.now(),
    };
    this._pendingAlerts.push(alert);
    if (this._pendingAlerts.length > 50) {
      this._pendingAlerts.splice(0, this._pendingAlerts.length - 50);
    }
    return alert;
  }

  dismissAlerts({ id = null, all = false } = {}) {
    if (all) {
      const removed = this._pendingAlerts.length;
      this._pendingAlerts = [];
      return { removed, remaining: 0 };
    }
    if (id) {
      const prevLen = this._pendingAlerts.length;
      this._pendingAlerts = this._pendingAlerts.filter((a) => a.id !== id);
      return { removed: prevLen - this._pendingAlerts.length, remaining: this._pendingAlerts.length };
    }
    return { removed: 0, remaining: this._pendingAlerts.length };
  }

  async _pollTick() {
    if (this._disposed || !this.vault || !this.config || this._syncInFlight) {
      return { polled: false, pulled: false };
    }
    const currentFiles = await this._scanRemoteCommitFingerprints();
    let hasNewRemote = false;
    for (const key of currentFiles) {
      if (!this._seenRemoteCommitFiles.has(key)) {
        hasNewRemote = true;
        break;
      }
    }
    if (!hasNewRemote) {
      return { polled: true, pulled: false };
    }

    const res = await this.pullAll({ silent: true });
    const hasPending =
      (res?.sessions?.summary?.pendingHydration ?? 0) > 0
      || (res?.sessions?.summary?.deferredBusy ?? 0) > 0
      || (res?.sessions?.hydrationPendingCount ?? res?.sessions?.pendingCount ?? 0) > 0;
    if (res?.ok && !hasPending) {
      for (const key of currentFiles) {
        this._seenRemoteCommitFiles.add(key);
      }
    }
    return { polled: true, pulled: Boolean(res?.ok), result: res };
  }

  _stopBackgroundPoller() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _startBackgroundPoller() {
    this._stopBackgroundPoller();
    if (this._disposed || !this.vault || !(this.pollIntervalMs > 0)) {
      return;
    }
    this._pollTimer = setInterval(() => {
      void this._pollTick().catch(() => {});
    }, this.pollIntervalMs);
    if (typeof this._pollTimer.unref === 'function') {
      this._pollTimer.unref();
    }
  }

  _isSessionGenuinelyBusy(id) {
    if (!id || !this.ctx) return false;
    const customBusy = getCtxService(this.ctx, 'isSessionBusy');
    if (typeof customBusy === 'function') {
      return Boolean(customBusy.call(this.ctx, id));
    }
    const agentsSvc = getCtxService(this.ctx, 'agents');
    const agent = typeof agentsSvc?.get === 'function' ? agentsSvc.get(id) : null;
    if (!agent) return false;
    if (agent.status === 'running') return true;
    if (agent.phase && typeof agent.phase === 'object' && agent.phase.kind && agent.phase.kind !== 'idle') {
      return true;
    }
    if (agent.inbox?.hasPending === true) return true;
    return false;
  }

  /**
   * P0-2A / Opus A3b: Fast-forward an OPEN idle resident `Session` IN PLACE via `liveSession.append(...)`
   * (under `agent.runMaintenance` when available), updating `agent.phase.lastTurn` and flushing to disk —
   * with ZERO `session/disposed` / `api-session/removed` events so open UI tabs NEVER lock (`removed: true`)!
   */
  async _fastForwardLiveSession(id, deltaEvents = [], { localSubstantive = [], remoteSubstantive = [] } = {}) {
    if (!id || !this.ctx || !Array.isArray(deltaEvents) || deltaEvents.length === 0) {
      return { applied: false };
    }
    if (this._isSessionGenuinelyBusy(id)) {
      return { applied: false, busy: true };
    }

    const agentsSvc = getCtxService(this.ctx, 'agents');
    const sessionsSvc = getCtxService(this.ctx, 'sessions');
    const persistenceSvc = getCtxService(this.ctx, 'sessionPersistence');
    const agent = typeof agentsSvc?.get === 'function' ? agentsSvc.get(id) : null;
    const liveSession = agent?.session ?? (typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(id) : null);
    if (!liveSession || typeof liveSession.append !== 'function') {
      return { applied: false };
    }

    // Build mapping from remote raw seq -> local liveSession seq
    const seqMap = new Map();
    const liveEvents = typeof liveSession.snapshotEvents === 'function'
      ? liveSession.snapshotEvents()
      : Array.isArray(liveSession.log)
        ? liveSession.log
        : null;
    const liveSubstantive = Array.isArray(liveEvents)
      ? liveEvents.filter((ev) => ev && ev.type !== 'session/end-seed')
      : localSubstantive;
    const prefixLen = Math.min(liveSubstantive.length, remoteSubstantive.length);
    for (let i = 0; i < prefixLen; i += 1) {
      if (typeof remoteSubstantive[i]?.seq === 'number' && typeof liveSubstantive[i]?.seq === 'number') {
        seqMap.set(remoteSubstantive[i].seq, liveSubstantive[i].seq);
      }
    }

    let dshSessionMod = null;
    const needsPluginRecord = deltaEvents.some((ev) => ev?.ignorable === true);
    if (needsPluginRecord) {
      dshSessionMod = await importHostPackage('@deepseek-ai/dsh-session').catch(() => null);
    }

    this._fastForwardingSessionIds.add(id);
    let appendedAny = false;
    let maxTurn = 0;
    try {
      const runAppend = async () => {
        for (const ev of deltaEvents) {
          if (!ev || typeof ev.type !== 'string') continue;
          const remapped = remapEventSeqReferences(ev, seqMap);
          let assignedSeq;
          if (remapped.ignorable === true && typeof dshSessionMod?.appendPluginRecord === 'function') {
            assignedSeq = dshSessionMod.appendPluginRecord(liveSession, remapped.type, remapped.data ?? {});
          } else {
            const opts = {};
            if (remapped.surfaceOp !== undefined) opts.surfaceOp = remapped.surfaceOp;
            if (remapped.sourceEventSeqs !== undefined) opts.sourceEventSeqs = remapped.sourceEventSeqs;
            const appended = Object.keys(opts).length > 0
              ? liveSession.append(remapped.type, remapped.data ?? {}, opts)
              : liveSession.append(remapped.type, remapped.data ?? {});
            assignedSeq = typeof appended?.seq === 'number' ? appended.seq : undefined;
          }
          appendedAny = true;
          if (typeof ev.seq === 'number' && typeof assignedSeq === 'number') {
            seqMap.set(ev.seq, assignedSeq);
          }
          if (remapped.type === 'turn/start' && typeof remapped.data?.turn === 'number') {
            if (remapped.data.turn > maxTurn) maxTurn = remapped.data.turn;
          }
        }
      };

      if (agent && typeof agent.runMaintenance === 'function' && agent.phase?.kind === 'idle') {
        await agent.runMaintenance(runAppend);
      } else {
        await runAppend();
      }

      // Sync AgentLoop `phase.lastTurn` so the next user turn increments cleanly from the fast-forwarded turn!
      if (agent && agent.phase?.kind === 'idle') {
        const projSvc = getCtxService(this.ctx, 'sessionProjections');
        const projLastTurn = typeof projSvc?.stateOf === 'function'
          ? Number(projSvc.stateOf(liveSession, 'turnBoundary')?.lastTurn ?? 0)
          : 0;
        const nextLastTurn = Math.max(maxTurn, projLastTurn, Number(agent.phase.lastTurn ?? 0));
        if (nextLastTurn > Number(agent.phase.lastTurn ?? 0)) {
          if (typeof agent.setPhase === 'function') {
            agent.setPhase({ kind: 'idle', lastTurn: nextLastTurn });
          } else {
            agent.phase = { ...agent.phase, kind: 'idle', lastTurn: nextLastTurn };
          }
        }
      }

      if (typeof sessionsSvc?.flush === 'function') {
        await sessionsSvc.flush(liveSession);
      } else if (typeof persistenceSvc?.flush === 'function') {
        await persistenceSvc.flush();
      }

      const updatedEvents = typeof liveSession.snapshotEvents === 'function'
        ? liveSession.snapshotEvents()
        : Array.isArray(liveSession.log)
          ? [...liveSession.log]
          : null;
      return {
        applied: true,
        events: updatedEvents,
        header: liveSession.header ?? null,
      };
    } catch (err) {
      if (!appendedAny) {
        return { applied: false, error: err instanceof Error ? err.message : String(err) };
      }
      throw err;
    } finally {
      this._fastForwardingSessionIds.delete(id);
    }
  }

  /**
   * P0-2 / R1 / R3: Safely release an IDLE resident agent/session write handle before cold fast-forward
   * or orphan re-homing so `sessionPersistence.open(id, 'write')` and directory relocation succeed
   * cleanly without `deferred-busy` deadlocks or open-handle races.
   */
  async _releaseIdleSession(id) {
    if (!id || !this.ctx) return false;
    if (this._isSessionGenuinelyBusy(id)) return false;

    const customRelease = getCtxService(this.ctx, 'releaseIdleSession');
    const agentsSvc = getCtxService(this.ctx, 'agents');
    const sessionsSvc = getCtxService(this.ctx, 'sessions');
    const persistenceSvc = getCtxService(this.ctx, 'sessionPersistence');
    const agent = typeof agentsSvc?.get === 'function' ? agentsSvc.get(id) : null;
    const session = agent?.session ?? (typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(id) : null);
    const writersMap = persistenceSvc?.tracker?.writers ?? persistenceSvc?.writers ?? null;
    const hasOpenWriter = Boolean(writersMap?.has?.(id));

    if (!agent && !session && !hasOpenWriter && typeof customRelease !== 'function') {
      return false;
    }

    this._releasingForFastForward.add(id);
    try {
      if (typeof customRelease === 'function') {
        await customRelease.call(this.ctx, id);
        return true;
      }

      // 1. Flush any buffered live events before releasing so disk state is 100% durable
      if (session && typeof sessionsSvc?.flush === 'function') {
        await sessionsSvc.flush(session).catch(() => {});
      }

      // 2. Prefer official disposal hooks if exposed on agent / registry / loop
      if (typeof agent?.dispose === 'function') {
        await agent.dispose().catch(() => {});
      } else if (typeof agentsSvc?.dispose === 'function') {
        await agentsSvc.dispose(id).catch(() => {});
      }

      // 3. Real dsh-agent-loop teardown: locate and invoke the Cordis effect disposer bound to
      //    `agentLoop.lifecycle(id)` or `agentLoop.scope(id)`. Real cordis@4 stores effect metadata
      //    at `d[Symbol(cordis.effect)].label` (`d.name === ""`, `d.label === undefined`), so inspect
      //    BOTH direct properties AND own symbol properties so `teardown()` cleanly clears `liveAgents`!
      if (agent && agentsSvc?.get?.(id) === agent) {
        const readDisposableLabel = (d) => {
          if (!d) return '';
          try {
            for (const sym of Object.getOwnPropertySymbols(d)) {
              const meta = d[sym];
              if (meta && typeof meta === 'object' && typeof meta.label === 'string' && meta.label) {
                return meta.label;
              }
            }
          } catch {
            // ignore symbol inspection errors
          }
          if (typeof d.label === 'string' && d.label) return d.label;
          if (typeof d.name === 'string' && d.name) return d.name;
          return '';
        };
        const disposeMatchingEffect = (fiber) => {
          const disposables = fiber?._disposables ?? fiber?.disposables;
          if (!disposables) return null;
          let fallback = null;
          for (const d of [...disposables]) {
            if (typeof d !== 'function') continue;
            const label = readDisposableLabel(d);
            if (!label.includes(`(${id})`)) continue;
            if (label.includes('agentLoop.lifecycle') || label.includes('agentLoop.scope')) {
              return d;
            }
            if (!fallback) fallback = d;
          }
          return fallback;
        };
        const scopeEffect =
          disposeMatchingEffect(agent.loopCtx?.fiber)
          ?? disposeMatchingEffect(agent.ctx?.fiber)
          ?? disposeMatchingEffect(this.ctx?.root?.fiber);
        if (scopeEffect) {
          await Promise.resolve(scopeEffect()).catch(() => {});
        } else if (typeof agent.scope?.dispose === 'function') {
          await agent.scope.dispose().catch(() => {});
        }
      }

      // 4. Fallback: if a write handle or registry entry is STILL held by an idle session, drain & close cleanly
      if (writersMap?.has?.(id)) {
        const writer = writersMap.get(id);
        if (writer) {
          await writer.drainLive?.().catch(() => {});
          await writer.flush?.().catch(() => {});
          await writer.close?.().catch(() => {});
        }
        if (writersMap.has(id)) {
          writersMap.delete(id);
        }
      }
      if (agent && agentsSvc?.get?.(id) === agent && agentsSvc.store instanceof Map) {
        agentsSvc.store.delete(id);
        if (typeof this.ctx?.emit === 'function') {
          this.ctx.emit('agent/disposed', { agent });
        }
      }
      if (session && sessionsSvc?.get?.(id) === session && sessionsSvc.store instanceof Map) {
        sessionsSvc.store.delete(id);
        if (typeof this.ctx?.emit === 'function') {
          this.ctx.emit('session/disposed', session);
        }
      }
      return true;
    } finally {
      this._releasingForFastForward.delete(id);
    }
  }

  _scheduleDeferredBusyCatchup(sessionId) {
    if (!sessionId || this._disposed || !this.vault) return;
    if (!this._deferredBusySessions.has(sessionId)) return;
    this._deferredBusySessions.delete(sessionId);
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      if (this._disposed || !this.vault) return;
      void this.pullAll({ silent: true }).catch(() => {});
    }, 50);
    if (typeof timer.unref === 'function') timer.unref();
    this._timers.add(timer);
  }

  _buildCordisAdapter() {
    if (!this.ctx) return null;
    const workspaceRegistry = getCtxService(this.ctx, 'workspaceRegistry');
    const sessionPersistence = getCtxService(this.ctx, 'sessionPersistence');
    const storageDomain = getCtxService(this.ctx, 'storageDomain');
    const sessionProjectionCache = getCtxService(this.ctx, 'sessionProjectionCache');
    const sessionProjections = getCtxService(this.ctx, 'sessionProjections');
    const sessionController = getCtxService(this.ctx, 'sessionController');
    const agents = getCtxService(this.ctx, 'agents');
    const sessions = getCtxService(this.ctx, 'sessions');
    if (
      !workspaceRegistry
      && !sessionPersistence
      && !storageDomain
      && !sessionProjectionCache
      && !sessionController
      && !agents
      && !sessions
    ) {
      return null;
    }
    return {
      workspaceRegistry,
      sessionPersistence,
      storageDomain,
      sessionProjectionCache,
      sessionProjections,
      sessionController,
      agents,
      sessions,
      emit: typeof this.ctx.emit === 'function' ? this.ctx.emit.bind(this.ctx) : undefined,
      isSessionBusy: (id) => this._isSessionGenuinelyBusy(id),
      fastForwardLiveSession: (id, deltaEvents, ctxInfo) => this._fastForwardLiveSession(id, deltaEvents, ctxInfo),
      releaseIdleSession: (id) => this._releaseIdleSession(id),
    };
  }

  async _detectDefaultModelTriple({ forceRefresh = false } = {}) {
    if (this.pluginConfig.defaultModelTriple) {
      return this.pluginConfig.defaultModelTriple;
    }
    const agentDefaultModel = getCtxService(this.ctx, 'agentDefaultModel');
    if (typeof agentDefaultModel?.currentSelection === 'function') {
      try {
        const sel = agentDefaultModel.currentSelection();
        if (sel && (sel.provider || sel.model)) {
          this._cachedModelTriple = {
            provider: sel.provider ?? null,
            model: sel.model ?? null,
            reasoningEffort: sel.reasoningEffort ?? null,
          };
          this._modelTripleDetected = true;
          return this._cachedModelTriple;
        }
      } catch {
        // Fallback below
      }
    }
    const llmSvc = getCtxService(this.ctx, 'llm');
    if (llmSvc?.defaultConfig && typeof llmSvc.defaultConfig === 'object') {
      const c = llmSvc.defaultConfig;
      this._cachedModelTriple = {
        provider: c.provider ?? null,
        model: c.model ?? null,
        reasoningEffort: c.reasoningEffort ?? null,
      };
      this._modelTripleDetected = true;
      return this._cachedModelTriple;
    }
    if (this.config?.defaultModelTriple) {
      this._cachedModelTriple = this.config.defaultModelTriple;
      this._modelTripleDetected = true;
      return this._cachedModelTriple;
    }

    if (!forceRefresh && this._modelTripleDetected) {
      return this._cachedModelTriple;
    }

    // Safely inspect lightweight non-secret DSH profile cordis.patch.yml / cordis.yml files
    // (NEVER touches .credentials.yaml and NEVER scans Zstd session logs on disk)
    const parseModelTriple = (text) => {
      const modelMatch = /^\s*model:\s*['"]?([^\s'"#]+)['"]?/m.exec(text);
      const providerMatch = /^\s*provider:\s*['"]?([^\s'"#]+)['"]?/m.exec(text);
      const effortMatch = /^\s*reasoningEffort:\s*['"]?([^\s'"#]+)['"]?/m.exec(text);
      if (!modelMatch && !providerMatch) return null;
      return {
        provider: providerMatch ? providerMatch[1] : null,
        model: modelMatch ? modelMatch[1] : null,
        reasoningEffort: effortMatch ? effortMatch[1] : null,
      };
    };

    for (const profile of ['desktop', 'web']) {
      for (const fileName of ['cordis.patch.yml', 'cordis.yml']) {
        const ymlPath = path.join(this.dshHome, 'profiles', profile, fileName);
        try {
          const text = await fs.readFile(ymlPath, 'utf8');
          const sectionIdx = text.indexOf('agent-default-model');
          if (sectionIdx !== -1) {
            const scoped = parseModelTriple(text.slice(sectionIdx));
            if (scoped) {
              this._cachedModelTriple = scoped;
              this._modelTripleDetected = true;
              return scoped;
            }
          }
          const parsed = parseModelTriple(text);
          if (parsed) {
            this._cachedModelTriple = parsed;
            this._modelTripleDetected = true;
            return parsed;
          }
        } catch {
          // Profile file absent
        }
      }
    }

    this._cachedModelTriple = null;
    this._modelTripleDetected = true;
    return null;
  }

  async reloadConfig() {
    this.config = await loadConfig(this.dshHome);
    this.secretKeys = await loadPassphraseKey(this.dshHome);
    this.defaultModelTriple = await this._detectDefaultModelTriple();

    if (this.config.vaultDir && this.config.vaultDir.trim().length > 0) {
      const useKeys = this.config.encryptionEnabled ? this.secretKeys : null;
      if (this.config.encryptionEnabled && !this.secretKeys) {
        const missingKeyMsg = '已开启加密模式但缺少本机密钥（secret.key），请在左下角「设置 → Soul Sync 跨机迁移」重新输入加密口令并保存';
        if (!this._startupErrors.includes(missingKeyMsg)) {
          this._startupErrors.push(missingKeyMsg);
        }
        this.vault = null;
      } else {
        this.vault = new VaultStore({
          vaultDir: this.config.vaultDir,
          deviceId: this.config.deviceId,
          platform: this.platform,
          secretKeys: useKeys,
          quotas: this.config.quotas,
        });
        // Restore _lastBackupAt from local device heartbeat.json so status card stays accurate across restarts
        if (!this._lastBackupAt) {
          try {
            const selfHbPath = path.join(this.vault.vaultDir, 'devices', this.config.deviceId, 'heartbeat.json');
            const parsedHb = JSON.parse(await fs.readFile(selfHbPath, 'utf8'));
            const restoredTs = parsedHb?.lastBackupAt ?? parsedHb?.updatedAt ?? null;
            if (typeof restoredTs === 'number' && Number.isFinite(restoredTs) && restoredTs > 0) {
              this._lastBackupAt = restoredTs;
            }
          } catch {
            // No prior heartbeat yet
          }
        }
      }
    } else {
      this.vault = null;
    }

    if (!this._baton.holder) {
      this._baton = {
        state: 'active',
        holder: this.config.deviceLabel || this.config.deviceId,
        updatedAt: Date.now(),
      };
    }

    this._seenRemoteCommitFiles.clear();

    if (this.vault && !this._disposed) {
      this._startBackgroundPoller();
      if (this.ctx) {
        for (const m of this.config.workspaceMappings ?? []) {
          const localRoot = m[this.platform];
          if (localRoot && (await pathExists(localRoot))) {
            await this._ensureWorkspaceWatcher(m.id, localRoot, null).catch(() => {});
          }
        }
      }
    } else {
      this._stopBackgroundPoller();
    }

    return this.config;
  }

  _clearRecoveredVaultStartupErrors() {
    if (!this.vault || this._startupErrors.length === 0) return;
    // Retain only missing secret.key error if key is still genuinely missing; clear transient vault I/O startup errors
    const missingKey = Boolean(this.config?.encryptionEnabled && !this.secretKeys);
    this._startupErrors = this._startupErrors.filter((m) => missingKey && m.includes('secret.key'));
  }

  async _loadGlobalState() {
    const statePath = path.join(soulSyncDir(this.dshHome), 'global-state.json');
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
      return {
        baseSha: typeof parsed?.baseSha === 'string' ? parsed.baseSha : null,
        lastPublishedSha: typeof parsed?.lastPublishedSha === 'string' ? parsed.lastPublishedSha : null,
        lastPulledCommits: parsed?.lastPulledCommits && typeof parsed.lastPulledCommits === 'object'
          ? { ...parsed.lastPulledCommits }
          : {},
      };
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { baseSha: null, lastPublishedSha: null, lastPulledCommits: {} };
      }
      throw err;
    }
  }

  async _saveGlobalState(state) {
    const statePath = path.join(soulSyncDir(this.dshHome), 'global-state.json');
    await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  async syncGlobalAgentsMd({ forcePublish = false } = {}) {
    await ensureGlobalAgentsRules(this.dshHome);
    if (!this.vault) return { synced: false, reason: 'no-vault' };

    const agentsPath = path.join(this.dshHome, 'AGENTS.md');
    const state = await this._loadGlobalState();
    let localBytes = await fs.readFile(agentsPath);
    let localSha = sha256Hex(localBytes);

    let pulled = false;
    let published = false;
    let conflict = false;

    const { commits } = await this.vault.listCommits('global', {
      targetId: 'AGENTS.md',
      includeSelf: false,
    });

    let latestRemoteSha = null;
    if (commits.length > 0) {
      const latest = commits[commits.length - 1];
      const payload = latest.payload;
      if (payload?.storageKey && payload?.sha256) {
        latestRemoteSha = payload.sha256;
        const verify = await this.vault.verifyCommitBlobs([
          { storageKey: payload.storageKey, sha256: payload.sha256, size: payload.size },
        ]);
        if (verify.ready && payload.sha256 !== localSha) {
          if (!state.baseSha || localSha === state.baseSha) {
            const remoteBytes = await this.vault.getBlob(payload.storageKey, payload.sha256, payload.size);
            await writeFileAtomic(agentsPath, remoteBytes, { mode: 0o644 });
            await ensureGlobalAgentsRules(this.dshHome);
            localBytes = await fs.readFile(agentsPath);
            localSha = sha256Hex(localBytes);
            state.baseSha = payload.sha256;
            state.lastPulledCommits[latest.deviceId] = latest.filename;
            pulled = true;
          } else if (payload.sha256 !== state.baseSha && state.lastPulledCommits[latest.deviceId] !== latest.filename) {
            conflict = true;
            this._pushAlert({
              kind: 'global-agents-conflict',
              text: `全局 AGENTS.md 与 ${payload.deviceLabel || latest.deviceId} 存在双边修改，已保留本机版本。`,
            });
            state.lastPulledCommits[latest.deviceId] = latest.filename;
          }
        } else if (payload.sha256 === localSha) {
          state.baseSha = localSha;
          state.lastPulledCommits[latest.deviceId] = latest.filename;
        }
      }
    }

    if (forcePublish || (localSha !== state.lastPublishedSha && localSha !== latestRemoteSha)) {
      const blob = await this.vault.putBlob(localBytes);
      await this.vault.publishCommit('global', 'AGENTS.md', {
        file: 'AGENTS.md',
        sha256: blob.sha256,
        storageKey: blob.storageKey,
        size: blob.size,
        deviceLabel: this.config?.deviceLabel || this.vault.deviceId,
      });
      state.baseSha = blob.sha256;
      state.lastPublishedSha = blob.sha256;
      published = true;
    }

    await this._saveGlobalState(state);
    return { synced: true, pulled, published, conflict };
  }

  /**
   * Synchronize encrypted `workspace-mappings` & `withdrawnSessions` global metadata
   * across devices so bindings made on Windows automatically propagate to macOS (and vice versa),
   * keeping consistent `workspaceId`s and preventing peers from auto-re-pushing withdrawn sessions.
   */
  async syncGlobalWorkspaceMetadata({ publishLocal = false } = {}) {
    if (!this.config) await this.reloadConfig();
    if (!this.vault) return { synced: false, reason: 'no-vault' };

    const normCmp = (p) => String(p ?? '').normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

    const { commits: remoteCommits } = await this.vault.listCommits('global', {
      targetId: 'workspace-mappings',
      includeSelf: false,
    });

    // Build merged maps starting from local config
    const mergedDeleted = { ...(this.config.deletedMappingIds ?? {}) };
    const mergedWithdrawn = { ...(this.config.withdrawnSessions ?? {}) };
    const mergedRestored = { ...(this.config.restoredSessions ?? {}) };
    const prevMappingIds = new Set((this.config.workspaceMappings ?? []).map((m) => m?.id).filter(Boolean));
    const byId = new Map();
    for (const m of this.config.workspaceMappings ?? []) {
      if (!m?.id) continue;
      byId.set(m.id, { ...m });
    }

    let remoteChangedLocal = false;

    // Apply latest commit per peer device in ascending timestamp order
    const latestByDevice = new Map();
    for (const c of remoteCommits) {
      latestByDevice.set(c.deviceId, c);
    }
    const orderedRemote = [...latestByDevice.values()].sort(
      (a, b) => (a.timestamp - b.timestamp) || (a.seq - b.seq),
    );

    for (const commit of orderedRemote) {
      const payload = commit.payload ?? {};
      const remoteDeleted = payload.deletedMappingIds && typeof payload.deletedMappingIds === 'object'
        ? payload.deletedMappingIds
        : {};
      for (const [id, ts] of Object.entries(remoteDeleted)) {
        const num = Number(ts);
        if (Number.isFinite(num) && num > (mergedDeleted[id] ?? 0)) {
          mergedDeleted[id] = Math.round(num);
        }
      }

      const remoteWithdrawn = payload.withdrawnSessions && typeof payload.withdrawnSessions === 'object'
        ? payload.withdrawnSessions
        : {};
      for (const [sid, ts] of Object.entries(remoteWithdrawn)) {
        const num = Number(ts);
        if (Number.isFinite(num) && num > (mergedWithdrawn[sid] ?? 0)) {
          mergedWithdrawn[sid] = Math.round(num);
        }
      }

      const remoteRestored = payload.restoredSessions && typeof payload.restoredSessions === 'object'
        ? payload.restoredSessions
        : {};
      for (const [sid, ts] of Object.entries(remoteRestored)) {
        const num = Number(ts);
        if (Number.isFinite(num) && num > (mergedRestored[sid] ?? 0)) {
          mergedRestored[sid] = Math.round(num);
        }
      }

      const remoteMappings = Array.isArray(payload.workspaceMappings) ? payload.workspaceMappings : [];
      for (const rm of remoteMappings) {
        if (!rm?.id) continue;
        const hasExplicitRmTs = typeof rm.updatedAt === 'number' && Number.isFinite(rm.updatedAt);
        const rmOriginTs = hasExplicitRmTs ? rm.updatedAt : 0;
        const rmTombstoneTs = hasExplicitRmTs && rm.updatedAt > 0 ? rm.updatedAt : Number(commit.timestamp ?? 0);
        const delTs = mergedDeleted[rm.id] ?? 0;
        if (delTs > rmTombstoneTs) continue;

        let targetId = rm.id;
        // Opus F8c: Deterministic canonical ID convergence across devices when two entries match
        // on the same path pair (and have no conflicting non-empty path on the other OS).
        // Oldest `(originTs, id)` wins (missing `updatedAt` = 0 so legacy `"文章"` beats `"文章-b3d3"` on BOTH devices!).
        if (!byId.has(targetId)) {
          for (const [existingId, em] of byId.entries()) {
            const sameWin = Boolean(rm.win32 && em.win32 && normCmp(rm.win32) === normCmp(em.win32));
            const sameMac = Boolean(rm.darwin && em.darwin && normCmp(rm.darwin) === normCmp(em.darwin));
            const conflictWin = Boolean(rm.win32 && em.win32 && !sameWin);
            const conflictMac = Boolean(rm.darwin && em.darwin && !sameMac);
            if ((sameWin || sameMac) && !conflictWin && !conflictMac) {
              const emOriginTs = typeof em.updatedAt === 'number' && Number.isFinite(em.updatedAt) ? em.updatedAt : 0;
              const emDeleted = (mergedDeleted[existingId] ?? 0) > emOriginTs;
              const remoteWinsId =
                emDeleted
                || rmOriginTs < emOriginTs
                || (rmOriginTs === emOriginTs && rm.id.localeCompare(existingId) < 0);
              if (remoteWinsId) {
                const winningTs = emDeleted ? rmOriginTs : Math.min(emOriginTs, rmOriginTs);
                byId.delete(existingId);
                byId.set(rm.id, {
                  ...em,
                  ...rm,
                  id: rm.id,
                  title: rm.title || em.title || rm.id,
                  win32: rm.win32 || em.win32,
                  darwin: rm.darwin || em.darwin,
                  ...(rm.linux || em.linux ? { linux: rm.linux || em.linux } : {}),
                  updatedAt: winningTs,
                });
                targetId = rm.id;
                // Migrate workspace deliverable state file if old ID state exists and new ID state does not
                const wsDir = path.join(this.dshHome, 'soul-sync', 'workspaces');
                const oldWsFile = path.join(wsDir, `${encodeURIComponent(existingId)}.json`);
                const newWsFile = path.join(wsDir, `${encodeURIComponent(rm.id)}.json`);
                if ((await pathExists(oldWsFile)) && !(await pathExists(newWsFile))) {
                  await fs.copyFile(oldWsFile, newWsFile).catch(() => {});
                }
              } else {
                targetId = existingId;
              }
              break;
            }
          }
        }

        const existing = byId.get(targetId);
        if (!existing) {
          byId.set(targetId, {
            id: rm.id,
            title: rm.title || rm.id,
            ...(rm.win32 ? { win32: String(rm.win32).normalize('NFC') } : {}),
            ...(rm.darwin ? { darwin: String(rm.darwin).normalize('NFC') } : {}),
            ...(rm.linux ? { linux: String(rm.linux).normalize('NFC') } : {}),
            updatedAt: rmOriginTs,
          });
        } else {
          // C6: Guard against two distinct path pairs colliding on a legacy bare-basename id!
          const winDiffers = Boolean(rm.win32 && existing.win32 && normCmp(rm.win32) !== normCmp(existing.win32));
          const macDiffers = Boolean(rm.darwin && existing.darwin && normCmp(rm.darwin) !== normCmp(existing.darwin));
          const sameAnyPath = Boolean(
            (rm.win32 && existing.win32 && normCmp(rm.win32) === normCmp(existing.win32))
            || (rm.darwin && existing.darwin && normCmp(rm.darwin) === normCmp(existing.darwin)),
          );
          if (!sameAnyPath && (winDiffers || macDiffers)) {
            const disambigId = deriveWorkspaceId(rm.win32 || '', rm.darwin || '');
            if (!byId.has(disambigId)) {
              byId.set(disambigId, {
                id: disambigId,
                title: rm.title || disambigId,
                ...(rm.win32 ? { win32: String(rm.win32).normalize('NFC') } : {}),
                ...(rm.darwin ? { darwin: String(rm.darwin).normalize('NFC') } : {}),
                ...(rm.linux ? { linux: String(rm.linux).normalize('NFC') } : {}),
                updatedAt: rmOriginTs,
              });
            }
          } else {
            const exOriginTs = typeof existing.updatedAt === 'number' && Number.isFinite(existing.updatedAt) ? existing.updatedAt : 0;
            const mergedTs = targetId === rm.id ? Math.min(exOriginTs, rmOriginTs) : exOriginTs;
            const merged = rmOriginTs >= exOriginTs
              ? {
                  ...existing,
                  ...rm,
                  id: targetId,
                  title: rm.title || existing.title || targetId,
                  win32: rm.win32 || existing.win32,
                  darwin: rm.darwin || existing.darwin,
                  ...(rm.linux || existing.linux ? { linux: rm.linux || existing.linux } : {}),
                  updatedAt: mergedTs,
                }
              : {
                  ...rm,
                  ...existing,
                  id: targetId,
                  win32: existing.win32 || rm.win32,
                  darwin: existing.darwin || rm.darwin,
                  ...(existing.linux || rm.linux ? { linux: existing.linux || rm.linux } : {}),
                  updatedAt: mergedTs,
                };
            byId.set(targetId, merged);
          }
        }
      }
    }

    // LWW resolution: any session whose restoredAt >= withdrawnAt is no longer withdrawn
    for (const [sid, rTs] of Object.entries(mergedRestored)) {
      if ((mergedWithdrawn[sid] ?? 0) <= rTs) {
        delete mergedWithdrawn[sid];
      }
    }

    // P1-1 / C11: Remove any actively withdrawn session (withdrawnAt > restoredAt) from local `selectedSessionIds`
    // so a peer in `syncScope: 'selected'` NEVER resurrects a session unpublished on another device!
    const prevSelectedSids = Array.isArray(this.config.selectedSessionIds) ? this.config.selectedSessionIds : [];
    const nextSelectedSids = prevSelectedSids.filter((sid) => {
      const wTs = Number(mergedWithdrawn[sid] ?? 0);
      const rTs = Number(mergedRestored[sid] ?? 0);
      return !(wTs > rTs);
    });
    const selectedSidsChanged = nextSelectedSids.length !== prevSelectedSids.length;

    // Apply tombstones to remove explicitly deleted mappings
    for (const [id, m] of [...byId.entries()]) {
      const delTs = mergedDeleted[id] ?? 0;
      const mTs = Number(m.updatedAt ?? 0);
      if (delTs > mTs) {
        byId.delete(id);
      }
    }

    const nextMappings = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    const nextMappingIds = new Set(nextMappings.map((m) => m.id));
    const prevMappingsJson = JSON.stringify([...(this.config.workspaceMappings ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
    const nextMappingsJson = JSON.stringify(nextMappings);
    const prevDeletedJson = JSON.stringify(this.config.deletedMappingIds ?? {});
    const nextDeletedJson = JSON.stringify(mergedDeleted);
    const prevWithdrawnJson = JSON.stringify(this.config.withdrawnSessions ?? {});
    const nextWithdrawnJson = JSON.stringify(mergedWithdrawn);
    const prevRestoredJson = JSON.stringify(this.config.restoredSessions ?? {});
    const nextRestoredJson = JSON.stringify(mergedRestored);

    if (
      prevMappingsJson !== nextMappingsJson
      || prevDeletedJson !== nextDeletedJson
      || prevWithdrawnJson !== nextWithdrawnJson
      || prevRestoredJson !== nextRestoredJson
      || selectedSidsChanged
    ) {
      remoteChangedLocal = true;
      await saveConfig(this.dshHome, {
        workspaceMappings: nextMappings,
        deletedMappingIds: mergedDeleted,
        withdrawnSessions: mergedWithdrawn,
        restoredSessions: mergedRestored,
        ...(selectedSidsChanged ? { selectedSessionIds: nextSelectedSids } : {}),
      });
      this.config = await loadConfig(this.dshHome);

      // P2-C: Close active watchers for any mapping removed by remote deletion tombstones
      for (const oldId of prevMappingIds) {
        if (!nextMappingIds.has(oldId)) {
          await this._closeWorkspaceWatcher(oldId);
        }
      }

      // Start deliverable watchers for any newly discovered local mapped paths that exist on disk
      for (const m of nextMappings) {
        const localRoot = m[this.platform];
        if (localRoot && (await pathExists(localRoot))) {
          await this._ensureWorkspaceWatcher(m.id, localRoot, null).catch(() => {});
        }
      }
    }

    let published = false;
    const hasDataToShare =
      nextMappings.length > 0
      || Object.keys(mergedDeleted).length > 0
      || Object.keys(mergedWithdrawn).length > 0
      || Object.keys(mergedRestored).length > 0;

    if (publishLocal || hasDataToShare) {
      const selfListed = await this.vault.listCommits('global', {
        targetId: 'workspace-mappings',
        onlySelf: true,
      });
      const latestSelf = selfListed.commits.length > 0
        ? selfListed.commits[selfListed.commits.length - 1]
        : null;
      const selfSig = latestSelf?.payload
        ? JSON.stringify({
            m: [...(latestSelf.payload.workspaceMappings ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
            d: latestSelf.payload.deletedMappingIds ?? {},
            w: latestSelf.payload.withdrawnSessions ?? {},
            r: latestSelf.payload.restoredSessions ?? {},
          })
        : '';
      const curSig = JSON.stringify({
        m: nextMappings,
        d: mergedDeleted,
        w: mergedWithdrawn,
        r: mergedRestored,
      });
      if (publishLocal || selfSig !== curSig) {
        await this.vault.publishCommit('global', 'workspace-mappings', {
          schemaVersion: 1,
          workspaceMappings: nextMappings,
          deletedMappingIds: mergedDeleted,
          withdrawnSessions: mergedWithdrawn,
          restoredSessions: mergedRestored,
          deviceLabel: this.config?.deviceLabel || this.vault.deviceId,
          updatedAt: Date.now(),
        });
        published = true;
      }
    }

    return {
      synced: true,
      pulled: remoteChangedLocal,
      published,
      mappingCount: nextMappings.length,
    };
  }

  async updateHeartbeat(extra = {}) {
    if (!this.vault || !this.config) return null;
    if (extra.baton) {
      this._baton = {
        ...this._baton,
        ...extra.baton,
        updatedAt: Date.now(),
      };
    }
    const sanitizedBaton = { ...this._baton };
    if (this.config.encryptionEnabled) {
      delete sanitizedBaton.note;
    }
    const { baton: _ignoredBaton, ...restExtra } = extra;
    return this.vault.writeHeartbeat({
      deviceLabel: this.config.deviceLabel || this.config.deviceId,
      dshVersion: this.dshVersion,
      defaultModelTriple: this.defaultModelTriple,
      status: extra.status ?? 'active',
      lastBackupAt: this._lastBackupAt,
      ...restExtra,
      baton: sanitizedBaton,
    });
  }

  async start() {
    this.readyPromise = this._runStartup().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this._startupErrors.push(msg);
      try {
        this.ctx?.logger?.warn?.(`[dsh-soul-sync] startup error: ${msg}`);
      } catch {
        // Ignore if ctx is a strict mock without logger accessor
      }
    });
    return this.readyPromise;
  }

  async _runStartup() {
    await this.reloadConfig();
    await this.syncVolatileSettings({ triggerPull: false, isStartup: true });
    await ensureGlobalAgentsRules(this.dshHome);

    if (!this.vault || this._disposed) return;

    await this.syncGlobalAgentsMd();
    await this.syncGlobalWorkspaceMetadata().catch(() => {});
    const pullRes = await this.pullAll({ silent: true });
    if (
      pullRes?.ok
      && (pullRes.sessions?.summary?.pendingHydration ?? 0) === 0
      && (pullRes.sessions?.summary?.deferredBusy ?? 0) === 0
      && (pullRes.sessions?.hydrationPendingCount ?? pullRes.sessions?.pendingCount ?? 0) === 0
    ) {
      const files = await this._scanRemoteCommitFingerprints();
      for (const k of files) this._seenRemoteCommitFiles.add(k);
    }
    await this.updateHeartbeat({ status: 'active' });
    this._startBackgroundPoller();
  }

  async _closeWorkspaceWatcher(workspaceId) {
    if (!workspaceId) return;
    const entry = this._watchers.get(workspaceId);
    if (!entry) return;
    this._watchers.delete(workspaceId);
    try {
      await entry.watcher.close();
    } catch {
      // ignore close errors
    }
  }

  _matchWorkspaceForPath(rawPath) {
    if (!rawPath || !this.config?.workspaceMappings?.length) return null;
    const mapped = mapPathAcrossOs(rawPath, this.config.workspaceMappings, this.platform);
    if (!mapped.workspaceId) return null;
    const mapping = this.config.workspaceMappings.find((m) => m.id === mapped.workspaceId);
    if (!mapping) return null;
    const localRoot = mapping[this.platform];
    if (!localRoot) return null;
    return { mapping, localRoot, relativePosixPath: mapped.relativePosixPath };
  }

  async _ensureWorkspaceWatcher(workspaceId, workspaceRoot, sessionId) {
    if (this._disposed) return;
    if (!workspaceId || !workspaceRoot) return;
    const existing = this._watchers.get(workspaceId);
    if (existing) {
      if (sessionId) existing.sessions.add(sessionId);
      return;
    }
    if (!(await pathExists(workspaceRoot))) return;

    try {
      const handle = createActiveWorkspaceWatcher(workspaceRoot, async (relPosix) => {
        if (this._disposed) return;
        await recordDeliverableCandidate(this.dshHome, workspaceId, workspaceRoot, relPosix, 'watcher');
      });
      const sessions = new Set();
      if (sessionId) sessions.add(sessionId);
      this._watchers.set(workspaceId, { watcher: handle, root: workspaceRoot, sessions });
    } catch {
      // Ignore watcher startup failures on restricted directories
    }
  }

  async _releaseWatcherForSession(sessionId) {
    if (!sessionId) return;
    for (const [wsId, entry] of [...this._watchers.entries()]) {
      entry.sessions.delete(sessionId);
      if (entry.sessions.size === 0) {
        this._watchers.delete(wsId);
        await entry.watcher.close().catch(() => {});
      }
    }
  }

  async handleToolsResult(exec, result = null) {
    if (this._disposed || !this.config) return;
    const payload = exec && typeof exec === 'object' ? exec : {};
    const toolName = String(payload.toolName ?? payload.name ?? payload.tool ?? '').toLowerCase();
    if (!FILE_MODIFY_TOOLS.has(toolName)) return;

    // P1-3: Real DSH `ToolRuntime` emits `tools/result(exec, result)` where `isError` lives on 2nd arg `result`!
    if (
      result?.isError === true
      || result?.ok === false
      || payload.isError === true
      || payload.error
      || payload.result?.isError === true
      || payload.result?.ok === false
    ) {
      return;
    }

    const cwd =
      payload.cwd
      ?? payload.agent?.session?.header?.cwd
      ?? payload.agent?.session?.cwd
      ?? payload.session?.header?.cwd
      ?? payload.session?.cwd
      ?? '';
    const sessionId =
      payload.agent?.session?.id
      ?? payload.agent?.session?.header?.id
      ?? payload.session?.id
      ?? payload.session?.header?.id
      ?? payload.agent?.id
      ?? null;
    const source = toolName.includes('present') ? 'present' : 'tool';
    const rawPaths = extractToolPaths(
      result && typeof result === 'object' ? { ...payload, result } : payload,
    );

    for (const rawPath of rawPaths) {
      const resolvedPath = path.isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath)
        ? rawPath
        : cwd
          ? path.resolve(cwd, rawPath)
          : rawPath;
      // C13: Track per-session produced files (for both mapped & unmapped workspaces)
      if (sessionId) {
        await recordSessionProducedFile(this.dshHome, sessionId, resolvedPath, cwd);
      }
      const matched = this._matchWorkspaceForPath(resolvedPath);
      if (!matched) continue;
      await recordDeliverableCandidate(
        this.dshHome,
        matched.mapping.id,
        matched.localRoot,
        resolvedPath,
        source,
      );
      await this._ensureWorkspaceWatcher(matched.mapping.id, matched.localRoot, sessionId);
    }
  }

  async _exportSessionSafely(session, { allowFlush, force = false } = {}) {
    if (!this.vault || !this.config || this._disposed) return null;
    const sessionId = session?.id ?? session?.header?.id;
    if (!sessionId) return null;

    const sessionsSvc = getCtxService(this.ctx, 'sessions');
    if (allowFlush && typeof sessionsSvc?.flush === 'function') {
      await sessionsSvc.flush(session);
    }

    let snapshot = null;
    if (session?.header && typeof session.snapshotEvents === 'function') {
      const snapEvents = session.snapshotEvents();
      if (Array.isArray(snapEvents)) {
        snapshot = { header: session.header, events: snapEvents };
      }
    }

    if (!force && snapshot) {
      const decision = shouldAutoSyncSession(
        { sessionId, header: snapshot.header, events: snapshot.events },
        this.config,
        this.platform,
      );
      if (!decision.allowed) {
        return { rootSessionId: sessionId, skipped: true, reason: decision.reason, deferred: false };
      }
    } else if (!force && !snapshot) {
      const sessionCwd = session?.cwd ?? session?.header?.cwd ?? '';
      if (sessionCwd && this.config.syncScope === 'selected') {
        const selectedIds = new Set(this.config.selectedSessionIds ?? []);
        if (
          !selectedIds.has(sessionId)
          && !matchesWorkspaceSelector(sessionCwd, this.config.selectedWorkspaces ?? [], this.config.workspaceMappings ?? [], this.platform)
        ) {
          return { rootSessionId: sessionId, skipped: true, reason: 'unselected', deferred: false };
        }
      }
      if ((this.config.excludedSessionIds ?? []).includes(sessionId)) {
        return { rootSessionId: sessionId, skipped: true, reason: 'excluded', deferred: false };
      }
    }

    // If allowFlush is true and disk already has the session, prefer snapshot if present;
    // otherwise exportSessionClosure reads from disk automatically.
    const res = await exportSessionClosure({
      dshHome: this.dshHome,
      vault: this.vault,
      sessionId,
      workspaceMappings: this.config.workspaceMappings,
      deviceLabel: this.config.deviceLabel,
      excludedSessionIds: this.config.excludedSessionIds,
      snapshot,
    });
    if (!res?.deferred) {
      this._lastBackupAt = Date.now();
    }
    return res;
  }

  async handleSessionEvent(arg1, arg2) {
    if (this._disposed) return;
    if (!this.config) await this.readyPromise;
    if (!this.config) return;

    const { session, event } = unpackSessionEventArgs(arg1, arg2);
    if (!event || typeof event.type !== 'string') return;

    const sessionId = session?.id ?? session?.header?.id ?? event?.sessionId ?? null;
    if (sessionId && (this._syntheticTurnSessions.has(sessionId) || this._fastForwardingSessionIds.has(sessionId))) {
      return;
    }
    const sessionCwd = session?.cwd ?? session?.header?.cwd ?? event?.data?.cwd ?? null;
    const matchedWs = sessionCwd ? this._matchWorkspaceForPath(sessionCwd) : null;

    if (matchedWs) {
      await this._ensureWorkspaceWatcher(matchedWs.mapping.id, matchedWs.localRoot, sessionId);
    }

    // Track assistant tool-call arguments so real DSH `tool/result` session events map back to modified file paths
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content ?? event.data?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool-call' && typeof block.id === 'string') {
            const toolName = String(block.name ?? '').toLowerCase();
            if (FILE_MODIFY_TOOLS.has(toolName)) {
              this._pendingToolCalls.set(block.id, {
                toolName,
                input: block.input ?? block.arguments ?? null,
              });
            }
          }
        }
      }
      return;
    }

    if (event.type === 'tool/result') {
      const msg = event.data?.message ?? event.data;
      const callId = msg?.toolCallId ?? msg?.source?.callId ?? event.data?.callId ?? null;
      const pending = callId ? this._pendingToolCalls.get(callId) : null;
      if (callId) this._pendingToolCalls.delete(callId);
      if (pending && msg?.isError !== true) {
        await this.handleToolsResult({
          toolName: pending.toolName,
          input: pending.input,
          result: msg,
          cwd: sessionCwd,
          session,
        });
      }
      return;
    }

    if (event.type === 'deliverables/presented') {
      const files = Array.isArray(event.data?.files) ? event.data.files : [];
      for (const item of files) {
        const p = typeof item === 'string' ? item : item?.path;
        if (!p) continue;
        if (sessionId) {
          await recordSessionProducedFile(this.dshHome, sessionId, p, sessionCwd || '');
        }
        const ws = this._matchWorkspaceForPath(p) ?? matchedWs;
        if (!ws) continue;
        await recordDeliverableCandidate(this.dshHome, ws.mapping.id, ws.localRoot, p, 'present');
      }
      return;
    }

    if (event.type === 'job/settled') {
      this.handleJobSettled({ cwd: sessionCwd, session });
      return;
    }

    if (!this.vault) return;

    if (event.type === 'step/end') {
      if (this.config.stepSyncEnabled === false || (this.config.quotas?.stepSyncIntervalMs ?? DEFAULT_QUOTAS.stepSyncIntervalMs) <= 0) {
        return;
      }
      if (!sessionId) return;
      const intervalMs = this.config.quotas?.stepSyncIntervalMs ?? DEFAULT_QUOTAS.stepSyncIntervalMs;
      const now = Date.now();
      const last = this._lastStepSyncAt.get(sessionId) ?? 0;
      if (now - last < intervalMs) {
        return;
      }
      this._lastStepSyncAt.set(sessionId, now);
      // Lightweight session-only disaster-recovery push (NEVER scan workspace deliverables on step/end)
      await this._exportSessionSafely(session, { allowFlush: true });
      await this.updateHeartbeat({ status: 'active' });
      return;
    }

    if (event.type === 'turn/end') {
      await this._withSyncLock(async () => {
        if (this._disposed || !this.vault) return;
        const isSessionExcluded = Boolean(sessionId && (this.config.excludedSessionIds ?? []).includes(sessionId));
        let sessionExported = false;
        if (sessionId) {
          const expRes = await this._exportSessionSafely(session, { allowFlush: true });
          sessionExported = Boolean(expRes && !expRes.skipped && !expRes.deferred);
        }
        // C13: NEVER auto-push workspace deliverables when the active session is in `excludedSessionIds`!
        const allowWsPush =
          !isSessionExcluded
          && matchedWs
          && (await pathExists(matchedWs.localRoot))
          && (
            this.config.syncScope !== 'selected'
            || sessionExported
            || matchesWorkspaceSelector(matchedWs.localRoot, this.config.selectedWorkspaces ?? [], this.config.workspaceMappings ?? [], this.platform)
          );
        if (allowWsPush) {
          await pushWorkspaceDeliverables({
            dshHome: this.dshHome,
            vault: this.vault,
            workspaceId: matchedWs.mapping.id,
            workspaceRoot: matchedWs.localRoot,
            deviceLabel: this.config.deviceLabel,
            minQuietMs: this.minQuietMs,
            quotas: this.config.quotas,
          });
        }

        if (sessionId && this._pendingHandoffSessions.has(sessionId)) {
          this._pendingHandoffSessions.delete(sessionId);
          await this.updateHeartbeat({
            status: 'handoff-ready',
            baton: {
              state: 'released-for-handoff',
              holder: this.config.deviceLabel || this.config.deviceId,
              sessionId,
              releasedAt: Date.now(),
            },
          });
        } else {
          await this.updateHeartbeat({ status: 'active' });
        }

        const keepN = this.config.quotas?.retainSnapshots ?? DEFAULT_QUOTAS.retainSnapshots;
        await this.vault.pruneHistory('session', keepN).catch(() => {});
        if (matchedWs) {
          await this.vault.pruneHistory('workspace', keepN).catch(() => {});
        }
      });
      // P0-2: Trigger one-shot catch-up pull if this session was previously deferred while mid-generation
      if (sessionId) {
        this._scheduleDeferredBusyCatchup(sessionId);
      }
    }
  }

  async handleSessionDisposed(sessionOrPayload) {
    if (this._disposed) return;
    const session = sessionOrPayload?.session ?? sessionOrPayload;
    const sessionId = session?.id ?? session?.header?.id ?? null;

    if (sessionId && this._releasingForFastForward.has(sessionId)) {
      return;
    }

    try {
      if (this.vault && this.config && sessionId) {
        // CRITICAL: NEVER invoke ctx.sessions.flush(session) on session/disposed!
        await this._exportSessionSafely(session, { allowFlush: false }).catch(() => {});
        await this.updateHeartbeat({ status: 'idle' }).catch(() => {});
      }
    } finally {
      await this._releaseWatcherForSession(sessionId);
      if (sessionId) {
        this._lastStepSyncAt.delete(sessionId);
        this._scheduleDeferredBusyCatchup(sessionId);
      }
    }
  }

  handleJobSettled(payload) {
    if (this._disposed || !this.vault || !this.config) return;
    const cwd = payload?.cwd ?? payload?.workspaceRoot ?? payload?.session?.cwd ?? null;
    const targetMappings = [];
    if (cwd) {
      const m = this._matchWorkspaceForPath(cwd);
      if (m) targetMappings.push(m);
    } else {
      for (const mapping of this.config.workspaceMappings ?? []) {
        if (mapping[this.platform]) {
          targetMappings.push({ mapping, localRoot: mapping[this.platform] });
        }
      }
    }
    if (targetMappings.length === 0) return;

    const timer = setTimeout(async () => {
      this._timers.delete(timer);
      if (this._disposed || !this.vault) return;
      for (const { mapping, localRoot } of targetMappings) {
        if (!(await pathExists(localRoot))) continue;
        await pushWorkspaceDeliverables({
          dshHome: this.dshHome,
          vault: this.vault,
          workspaceId: mapping.id,
          workspaceRoot: localRoot,
          deviceLabel: this.config.deviceLabel,
          minQuietMs: this.minQuietMs,
          quotas: this.config.quotas,
        }).catch(() => {});
      }
    }, 300);
    if (typeof timer.unref === 'function') timer.unref();
    this._timers.add(timer);
  }

  async handleAgentPreStep({ agent, signal } = {}, next) {
    const decision = typeof next === 'function' ? await next() : { kind: 'continue', messages: [] };
    // P2-1: Match DSH's `modelSwitchNotice` guard — NEVER inject into an empty closing step (`messages.length === 0`)
    // or else `dsh-agent-loop` will trigger an unintended extra LLM round!
    if (
      !decision
      || decision.kind === 'reject'
      || signal?.aborted
      || !Array.isArray(decision.messages)
      || decision.messages.length === 0
    ) {
      return decision;
    }

    const sessionId = agent?.session?.id ?? agent?.sessionId ?? null;
    const sessionCwd = agent?.session?.cwd ?? agent?.session?.header?.cwd ?? '';
    const matchedWs = sessionCwd ? this._matchWorkspaceForPath(sessionCwd) : null;
    const normPath = (p) => String(p ?? '').normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const normSessionCwd = sessionCwd ? normPath(sessionCwd) : '';

    const mig = sessionId ? await consumePendingMigration(this.dshHome, sessionId) : null;

    // F5: ONLY consume alerts that explicitly belong to THIS active session or its workspace!
    // Unrelated workspace conflicts & global alerts stay in `_pendingAlerts` for Settings UI / `/soul status`.
    const matchedAlerts = [];
    if (this._pendingAlerts.length > 0 && (sessionId || matchedWs || normSessionCwd)) {
      const remaining = [];
      for (const alert of this._pendingAlerts) {
        const hitSession = Boolean(alert.sessionId && sessionId && alert.sessionId === sessionId);
        const hitWsId = Boolean(alert.workspaceId && matchedWs?.mapping?.id && alert.workspaceId === matchedWs.mapping.id);
        const hitWsPath = Boolean(alert.workspacePath && normSessionCwd && normPath(alert.workspacePath) === normSessionCwd);
        if (hitSession || hitWsId || hitWsPath) {
          matchedAlerts.push(alert);
        } else {
          remaining.push(alert);
        }
      }
      if (matchedAlerts.length > 0) {
        this._pendingAlerts = remaining;
      }
    }

    if (!mig && matchedAlerts.length === 0) {
      return decision;
    }

    const noteParts = [];
    if (mig) {
      noteParts.push(
        `【跨设备接力备注】以上对话与工具操作是我在 ${mig.fromDeviceLabel} (${mig.fromPlatform}) 上的真实亲历记录；`
        + `现在我已切换至当前设备 (${this.platform}) 继续推进同一任务，`
        + `项目工作目录已从 ${mig.fromCwd} 映射为 ${mig.toCwd}，`
        + `请顺着我们刚才的脉络以第一人称直接往下接，命令与路径按当前系统执行。`,
      );
    }
    if (matchedAlerts.length > 0) {
      const alertSummary = matchedAlerts.map((a) => a.text).join('；');
      noteParts.push(`【同步提醒】${alertSummary}`);
    }

    // F4: Use DSH native non-user context notice source so chat UI renders a collapsed
    // ContextInjectionRow (NOT a fake human user bubble) and tail-compactor/countUserTurns ignore it!
    const msg = await createPersistentContextMessage(noteParts.join('\n'), {
      kind: name,
      form: 'notice',
      summary: mig ? '已同步跨设备上下文' : '同步状态提醒',
    });
    return {
      ...decision,
      messages: [...(Array.isArray(decision.messages) ? decision.messages : []), msg],
    };
  }

  async pullAll({ silent = false, skipSessions = false, workspaceTargetOverrides = null } = {}) {
    return this._withSyncLock(async () => {
      if (!this.config) await this.reloadConfig();
      if (!this.vault) {
        return { ok: false, reason: 'no-vault' };
      }

      const globalRes = await this.syncGlobalAgentsMd();
      await this.syncGlobalWorkspaceMetadata().catch(() => {});

      const effectiveWsOverrides = workspaceTargetOverrides && typeof workspaceTargetOverrides === 'object'
        ? { ...(this.config.workspaceTargetOverrides ?? {}), ...workspaceTargetOverrides }
        : this.config.workspaceTargetOverrides;

      const sessionRes = skipSessions
        ? {
            results: [],
            pendingCount: 0,
            hydrationPendingCount: 0,
            decryptionFailedCount: 0,
            decryptionFailedDevices: {},
            newAutoMirrorAssignments: {},
            summary: {
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
            },
          }
        : await pullSessionsFromVault({
            dshHome: this.dshHome,
            vault: this.vault,
            workspaceMappings: this.config.workspaceMappings,
            targetPlatform: this.platform,
            fallbackRoot: this.config.fallbackDir || undefined,
            cordisCtx: this._buildCordisAdapter(),
            folderMatchMode: this.config.folderMatchMode,
            autoMirrorRoot: this.config.autoMirrorRoot || undefined,
            autoMirrorAssignments: this.config.autoMirrorAssignments,
            syncScope: this.config.syncScope,
            selectedWorkspaces: this.config.selectedWorkspaces,
            selectedSessionIds: this.config.selectedSessionIds,
            excludedSessionIds: this.config.excludedSessionIds,
            withdrawnSessions: this.config.withdrawnSessions,
            restoredSessions: this.config.restoredSessions,
            sessionTargetOverrides: this.config.sessionTargetOverrides,
            workspaceTargetOverrides: effectiveWsOverrides,
          });

      // P0-2: Track genuinely mid-generation deferred-busy sessions for one-shot catch-up on turn/end or agent/disposed
      const needTitleLookup = (sessionRes.results ?? []).some(
        (r) => (Array.isArray(r.outputConflicts) && r.outputConflicts.length > 0) || r.status === 'forked-branch',
      );
      const alertLocalMap = needTitleLookup ? await scanLocalSessions(this.dshHome).catch(() => new Map()) : null;
      const resolveAlertTitle = (sid) => {
        const rec = alertLocalMap?.get(sid);
        if (rec) {
          const t = extractSessionTitle(rec.events, '');
          if (t) return `对话「${t}」`;
        }
        return `会话 ${String(sid || '').slice(0, 8)}`;
      };

      for (const r of sessionRes.results ?? []) {
        if (r.status === 'deferred-busy' && r.sessionId) {
          this._deferredBusySessions.add(r.sessionId);
        } else if (r.sessionId && (r.status === 'imported' || r.status === 'fast-forwarded' || r.status === 'migrated' || r.status === 'up-to-date')) {
          this._deferredBusySessions.delete(r.sessionId);
        }
        // C4: Surface scoped alert when unmapped outputs/ produces a new conflict copy!
        if (Array.isArray(r.outputConflicts) && r.outputConflicts.length > 0) {
          const matchedWs = r.targetCwd ? this._matchWorkspaceForPath(r.targetCwd) : null;
          const names = r.outputConflicts.map((c) => c.path).join('、');
          this._pushAlert({
            kind: 'output-conflict',
            workspaceId: matchedWs?.mapping?.id ?? null,
            workspacePath: r.targetCwd ?? null,
            sessionId: r.sessionId,
            text: `${resolveAlertTitle(r.sessionId)} 的 outputs/ 产出存在双边修改冲突（${names}），已保留本机文件并并列保存远端冲突副本`,
          });
        }
      }

      // P1-1 / P1-A: Persist mirror assignments AND when syncScope==='selected', auto-track
      // all imported/fast-forwarded/migrated peer sessions in selectedSessionIds so replies
      // written on this machine seamlessly auto-push back without splitting!
      const pullConfigPatch = {};
      if (sessionRes.newAutoMirrorAssignments && Object.keys(sessionRes.newAutoMirrorAssignments).length > 0) {
        pullConfigPatch.autoMirrorAssignments = {
          ...(this.config.autoMirrorAssignments ?? {}),
          ...sessionRes.newAutoMirrorAssignments,
        };
      }
      if (this.config.syncScope === 'selected') {
        const excludedSet = new Set(this.config.excludedSessionIds ?? []);
        const withdrawnMap = this.config.withdrawnSessions ?? {};
        const restoredMap = this.config.restoredSessions ?? {};
        const nextSelectedSids = new Set(this.config.selectedSessionIds ?? []);
        let selectedAdded = false;
        for (const r of sessionRes.results ?? []) {
          if (r.status !== 'imported' && r.status !== 'fast-forwarded' && r.status !== 'migrated') continue;
          if (!r.sessionId || excludedSet.has(r.sessionId)) continue;
          const wTs = Number(withdrawnMap[r.sessionId] ?? 0);
          const rTs = Number(restoredMap[r.sessionId] ?? 0);
          if (wTs > rTs) continue;
          if (!nextSelectedSids.has(r.sessionId)) {
            nextSelectedSids.add(r.sessionId);
            selectedAdded = true;
          }
        }
        if (selectedAdded) {
          pullConfigPatch.selectedSessionIds = [...nextSelectedSids];
        }
      }
      if (Object.keys(pullConfigPatch).length > 0) {
        await saveConfig(this.dshHome, pullConfigPatch);
        this.config = await loadConfig(this.dshHome);
      }

      if (sessionRes.summary.forkedBranches > 0) {
        const forkedItems = (sessionRes.results ?? []).filter((r) => r.status === 'forked-branch');
        for (const f of forkedItems) {
          const matchedWs = f.targetCwd ? this._matchWorkspaceForPath(f.targetCwd) : null;
          this._pushAlert({
            kind: 'session-fork',
            workspaceId: matchedWs?.mapping?.id ?? null,
            workspacePath: f.targetCwd ?? null,
            sessionId: f.sessionId,
            text: `${resolveAlertTitle(f.sessionId)} 存在双端并发编辑分叉，已无损保留分支副本在侧边栏中`,
          });
        }
      }

      const { commits: remoteWsCommits } = await this.vault.listCommits('workspace', { includeSelf: false });
      const remoteWsIds = new Set(remoteWsCommits.map((c) => c.targetId));

      const workspaceResults = [];
      for (const mapping of this.config.workspaceMappings ?? []) {
        const localRoot = mapping[this.platform];
        if (!localRoot) continue;
        // F6: inbound pullAll receives mapped workspaces published by peers (even when local syncScope==='selected')
        const exists = await pathExists(localRoot);
        if (!exists && !remoteWsIds.has(mapping.id)) continue;
        if (!exists) {
          await fs.mkdir(localRoot, { recursive: true });
        }
        const wsRes = await pullWorkspaceDeliverables({
          dshHome: this.dshHome,
          vault: this.vault,
          workspaceId: mapping.id,
          workspaceRoot: localRoot,
          trashRetentionDays: this.config.quotas?.trashRetentionDays,
        });
        workspaceResults.push({ workspaceId: mapping.id, title: mapping.title, ...wsRes });

        if (wsRes.conflicts.length > 0) {
          this._pushAlert({
            kind: 'file-conflict',
            workspaceId: mapping.id,
            workspacePath: localRoot,
            text: `工作区「${mapping.title || mapping.id}」有 ${wsRes.conflicts.length} 个双边同改冲突副本（已保留本机文件并并列落盘远端副本）`,
          });
        }
        if (wsRes.stagedIncoming.length > 0) {
          const names = wsRes.stagedIncoming.map((s) => s.path).join('、');
          this._pushAlert({
            kind: 'incoming-staged',
            workspaceId: mapping.id,
            workspacePath: localRoot,
            text: `工作区「${mapping.title || mapping.id}」有 ${wsRes.stagedIncoming.length} 个文件因本地占锁已暂存于 .dsh-incoming/（${names}），关闭 Excel 后执行 /soul pull 即可自动落位`,
          });
        }
      }

      // R8: Auto-clear transient vault offline startup errors once vault operations succeed
      this._clearRecoveredVaultStartupErrors();
      this._lastPullAt = Date.now();
      return {
        ok: true,
        silent,
        global: globalRes,
        sessions: sessionRes,
        workspaces: workspaceResults,
      };
    });
  }

  async pushAll({ agent = null, force = false } = {}) {
    return this._withSyncLock(async () => {
      if (!this.config) await this.reloadConfig();
      if (!this.vault) {
        return { ok: false, reason: 'no-vault' };
      }

      const globalRes = await this.syncGlobalAgentsMd({ forcePublish: force });
      await this.syncGlobalWorkspaceMetadata({ publishLocal: force }).catch(() => {});

      let sessionPushedCount = 0;
      const deferredCompactionSessions = [];
      const skippedOutputs = [];
      const exportedOrSelectedCwds = [];
      const activeSession = agent?.session ?? null;
      if (activeSession?.id || activeSession?.header?.id) {
        const expRes = await this._exportSessionSafely(activeSession, { allowFlush: true, force: true });
        if (expRes?.deferred && expRes.reason === 'unclosed-compaction') {
          deferredCompactionSessions.push(...(expRes.deferredCompactionSessions ?? [activeSession.id ?? activeSession.header?.id]));
        } else if (expRes && !expRes.skipped) {
          sessionPushedCount = 1;
          if (expRes.sourceCwd) exportedOrSelectedCwds.push(expRes.sourceCwd);
          if (Array.isArray(expRes.skippedOutputs) && expRes.skippedOutputs.length > 0) {
            skippedOutputs.push(...expRes.skippedOutputs.map((o) => ({ sessionId: expRes.rootSessionId, ...o })));
          }
        }
      } else {
        const allRes = await exportAllLocalSessions({
          dshHome: this.dshHome,
          vault: this.vault,
          workspaceMappings: this.config.workspaceMappings,
          deviceLabel: this.config.deviceLabel,
          syncScope: this.config.syncScope,
          folderMatchMode: this.config.folderMatchMode,
          selectedWorkspaces: this.config.selectedWorkspaces,
          selectedSessionIds: this.config.selectedSessionIds,
          excludedSessionIds: this.config.excludedSessionIds,
          withdrawnSessions: this.config.withdrawnSessions,
          restoredSessions: this.config.restoredSessions,
          sessionTargetOverrides: this.config.sessionTargetOverrides,
          workspaceTargetOverrides: this.config.workspaceTargetOverrides,
          maxAutoSessionsPerWorkspace: this.config.quotas?.maxAutoSessionsPerWorkspace ?? DEFAULT_QUOTAS.maxAutoSessionsPerWorkspace,
          platform: this.platform,
          force,
        });
        sessionPushedCount = allRes.exported.length;
        for (const exp of [...(allRes.exported ?? []), ...(allRes.unchangedSessions ?? [])]) {
          if (exp?.sourceCwd) exportedOrSelectedCwds.push(exp.sourceCwd);
        }
        if (Array.isArray(allRes.deferredCompactionSessions)) {
          deferredCompactionSessions.push(...allRes.deferredCompactionSessions);
        }
        if (Array.isArray(allRes.skippedOutputs)) {
          skippedOutputs.push(...allRes.skippedOutputs);
        }
        if (sessionPushedCount > 0) {
          this._lastBackupAt = Date.now();
        }
      }

      // P1-1: When syncScope === 'selected', push deliverables for mapped workspaces matching
      // BOTH selectedWorkspaces AND the cwd of any selectedSessionIds!
      const selectedSessionMappedWsIds = new Set();
      if (this.config.syncScope === 'selected') {
        for (const cwd of exportedOrSelectedCwds) {
          const matched = this._matchWorkspaceForPath(cwd);
          if (matched?.mapping?.id) selectedSessionMappedWsIds.add(matched.mapping.id);
        }
        if ((this.config.selectedSessionIds ?? []).length > 0 && exportedOrSelectedCwds.length === 0) {
          const localMap = await scanLocalSessions(this.dshHome);
          for (const sid of this.config.selectedSessionIds ?? []) {
            const rec = localMap.get(sid);
            if (rec?.header?.cwd) {
              const matched = this._matchWorkspaceForPath(rec.header.cwd);
              if (matched?.mapping?.id) selectedSessionMappedWsIds.add(matched.mapping.id);
            }
          }
        }
      }

      const workspaceResults = [];
      for (const mapping of this.config.workspaceMappings ?? []) {
        const localRoot = mapping[this.platform];
        if (!localRoot || !(await pathExists(localRoot))) continue;
        if (
          this.config.syncScope === 'selected'
          && !selectedSessionMappedWsIds.has(mapping.id)
          && !matchesWorkspaceSelector(localRoot, this.config.selectedWorkspaces ?? [], this.config.workspaceMappings ?? [], this.platform)
        ) {
          continue;
        }
        const wsRes = await pushWorkspaceDeliverables({
          dshHome: this.dshHome,
          vault: this.vault,
          workspaceId: mapping.id,
          workspaceRoot: localRoot,
          deviceLabel: this.config.deviceLabel,
          minQuietMs: this.minQuietMs,
          quotas: this.config.quotas,
        });
        workspaceResults.push({ workspaceId: mapping.id, title: mapping.title, ...wsRes });
      }

      this._lastBackupAt = Date.now();
      await this.updateHeartbeat({ status: 'active' });

      const keepN = this.config.quotas?.retainSnapshots ?? DEFAULT_QUOTAS.retainSnapshots;
      await this.vault.pruneHistory('session', keepN).catch(() => {});
      await this.vault.pruneHistory('workspace', keepN).catch(() => {});

      return {
        ok: true,
        global: globalRes,
        sessionPushedCount,
        deferredCompactionSessions,
        skippedOutputs,
        workspaces: workspaceResults,
      };
    });
  }

  async listLocalCatalog({ localMap = null, vaultSessionIds = null } = {}) {
    if (!this.config) await this.reloadConfig();
    return listLocalCatalog({
      dshHome: this.dshHome,
      config: this.config,
      platform: this.platform,
      cordisCtx: this._buildCordisAdapter(),
      localMap,
      vaultSessionIds,
    });
  }

  async listVaultCatalog({ includeSelf = false, localMap = null } = {}) {
    if (!this.config) await this.reloadConfig();
    if (!this.vault) {
      return {
        workspaces: [],
        totalSessions: 0,
        pendingCount: 0,
        hydrationPendingCount: 0,
        decryptionFailedCount: 0,
      };
    }
    return listVaultCatalog({
      dshHome: this.dshHome,
      vault: this.vault,
      config: this.config,
      targetPlatform: this.platform,
      cordisCtx: this._buildCordisAdapter(),
      autoMirrorRoot: this.config.autoMirrorRoot || undefined,
      includeSelf,
      localMap,
    });
  }

  async pushSelected({ workspacePaths = [], sessionIds = [], rememberSelection = false } = {}) {
    return this._withSyncLock(async () => {
      if (!this.config) await this.reloadConfig();
      if (!this.vault) {
        return { ok: false, reason: 'no-vault' };
      }

      const cleanWs = Array.isArray(workspacePaths)
        ? workspacePaths.map((s) => String(s ?? '').trim().normalize('NFC')).filter(Boolean)
        : [];
      const cleanSids = Array.isArray(sessionIds)
        ? sessionIds.map((s) => String(s ?? '').trim()).filter(Boolean)
        : [];

      if (cleanWs.length === 0 && cleanSids.length === 0) {
        return { ok: false, reason: 'empty-selection' };
      }

      // Explicitly pushing a previously excluded/withdrawn session re-enables it cleanly via LWW restoredSessions
      const nowTs = Date.now();
      const configPatch = {};
      let metadataChanged = false;
      if (cleanSids.length > 0) {
        const pushedSidSet = new Set(cleanSids);
        const prevExcluded = this.config.excludedSessionIds ?? [];
        const nextExcluded = prevExcluded.filter((id) => !pushedSidSet.has(id));
        if (nextExcluded.length !== prevExcluded.length) {
          configPatch.excludedSessionIds = nextExcluded;
        }
        const nextWithdrawn = { ...(this.config.withdrawnSessions ?? {}) };
        const nextRestored = { ...(this.config.restoredSessions ?? {}) };
        for (const sid of cleanSids) {
          const prevW = Number(nextWithdrawn[sid] ?? 0);
          if (prevW > 0 || prevExcluded.includes(sid)) {
            delete nextWithdrawn[sid];
            nextRestored[sid] = Math.max(nowTs, prevW + 1, Number(nextRestored[sid] ?? 0) + 1);
            metadataChanged = true;
          }
        }
        if (metadataChanged) {
          configPatch.withdrawnSessions = nextWithdrawn;
          configPatch.restoredSessions = nextRestored;
        }
      }

      if (rememberSelection) {
        configPatch.selectedWorkspaces = [...new Set([...(this.config.selectedWorkspaces ?? []), ...cleanWs])];
        configPatch.selectedSessionIds = [...new Set([...(this.config.selectedSessionIds ?? []), ...cleanSids])];
      }

      if (Object.keys(configPatch).length > 0) {
        await saveConfig(this.dshHome, configPatch);
        await this.reloadConfig();
      }

      const globalRes = await this.syncGlobalAgentsMd();

      const sessRes = await exportAllLocalSessions({
        dshHome: this.dshHome,
        vault: this.vault,
        workspaceMappings: this.config.workspaceMappings,
        deviceLabel: this.config.deviceLabel,
        excludedSessionIds: this.config.excludedSessionIds,
        withdrawnSessions: this.config.withdrawnSessions,
        restoredSessions: this.config.restoredSessions,
        platform: this.platform,
        onlyWorkspacePaths: cleanWs.length > 0 ? cleanWs : null,
        onlySessionIds: cleanSids.length > 0 ? cleanSids : null,
        force: true,
      });

      // C10: NEVER auto-remove excluded sessions when swept in via `workspacePaths`!
      // Only sessions explicitly named in `cleanSids` were un-excluded/restored above.

      await this.syncGlobalWorkspaceMetadata({ publishLocal: metadataChanged }).catch(() => {});

      // P1-2B: Push deliverables for mapped workspaces matching BOTH explicitly selected workspaces
      // AND the cwd of any individually selected & exported session!
      const wsIdsToPush = new Set();
      for (const mapping of this.config.workspaceMappings ?? []) {
        const localRoot = mapping[this.platform];
        if (!localRoot) continue;
        if (cleanWs.length > 0 && matchesWorkspaceSelector(localRoot, cleanWs, this.config.workspaceMappings, this.platform)) {
          wsIdsToPush.add(mapping.id);
        }
      }
      for (const exp of [...(sessRes.exported ?? []), ...(sessRes.unchangedSessions ?? [])]) {
        if (exp?.sourceCwd) {
          const matched = this._matchWorkspaceForPath(exp.sourceCwd);
          if (matched?.mapping?.id) {
            wsIdsToPush.add(matched.mapping.id);
          }
        }
      }

      const workspaceResults = [];
      for (const mapping of this.config.workspaceMappings ?? []) {
        if (!wsIdsToPush.has(mapping.id)) continue;
        const localRoot = mapping[this.platform];
        if (!localRoot || !(await pathExists(localRoot))) continue;
        const wsRes = await pushWorkspaceDeliverables({
          dshHome: this.dshHome,
          vault: this.vault,
          workspaceId: mapping.id,
          workspaceRoot: localRoot,
          deviceLabel: this.config.deviceLabel,
          minQuietMs: this.minQuietMs,
          quotas: this.config.quotas,
        });
        workspaceResults.push({ workspaceId: mapping.id, title: mapping.title, ...wsRes });
      }

      this._lastBackupAt = Date.now();
      await this.updateHeartbeat({ status: 'active' });

      const keepN = this.config.quotas?.retainSnapshots ?? DEFAULT_QUOTAS.retainSnapshots;
      await this.vault.pruneHistory('session', keepN).catch(() => {});
      if (workspaceResults.length > 0) {
        await this.vault.pruneHistory('workspace', keepN).catch(() => {});
      }

      return {
        ok: true,
        global: globalRes,
        exported: sessRes.exported,
        sessionPushedCount: sessRes.exported.length,
        deferredCompactionSessions: sessRes.deferredCompactionSessions,
        skippedOutputs: sessRes.skippedOutputs ?? [],
        skippedEmptyCount: sessRes.skippedEmptyCount,
        workspaces: workspaceResults,
        remembered: Boolean(rememberSelection),
      };
    });
  }

  async pullSelected({
    workspaceSources = [],
    sessionIds = [],
    targetOverrides = {},
    saveMappings = false,
  } = {}) {
    return this._withSyncLock(async () => {
      if (!this.config) await this.reloadConfig();
      if (!this.vault) {
        return { ok: false, reason: 'no-vault' };
      }

      const cleanWsSources = Array.isArray(workspaceSources)
        ? workspaceSources.map((s) => String(s ?? '').trim().normalize('NFC')).filter(Boolean)
        : [];
      const cleanSids = Array.isArray(sessionIds)
        ? sessionIds.map((s) => String(s ?? '').trim()).filter(Boolean)
        : [];

      if (cleanWsSources.length === 0 && cleanSids.length === 0) {
        return { ok: false, reason: 'empty-selection' };
      }

      const sessionOverrides = { ...(this.config.sessionTargetOverrides ?? {}) };
      const workspaceOverrides = { ...(this.config.workspaceTargetOverrides ?? {}) };
      const permanentMappingsToAdd = [];
      const sameOsWorkspaceOverridesToSave = {};
      const explicitOverrideKeys = new Set();

      if (targetOverrides && typeof targetOverrides === 'object') {
        for (const [k, v] of Object.entries(targetOverrides)) {
          if (typeof v !== 'string' || !v.trim()) continue;
          const cleanKey = String(k).trim().normalize('NFC');
          let cleanTarget = stripOuterQuotes(v).normalize('NFC');
          if (!cleanTarget) continue;
          if (cleanTarget !== AUTO_MIRROR_SENTINEL) {
            cleanTarget = expandPosixHome(cleanTarget, this.platform).normalize('NFC');
            const targetCheckPlatform = this.platform === process.platform
              ? this.platform
              : (/^[A-Za-z]:[\\/]/.test(cleanTarget) || /^\\\\/.test(cleanTarget))
                ? 'win32'
                : this.platform;
            const targetValidation = validateWorkspaceDirectory(cleanTarget, targetCheckPlatform, {
              dshHome: targetCheckPlatform === process.platform ? this.dshHome : undefined,
              vaultDir: targetCheckPlatform === process.platform ? this.config.vaultDir : undefined,
            });
            if (!targetValidation.ok) {
              return { ok: false, reason: 'invalid-target', error: targetValidation.error };
            }
            cleanTarget = targetValidation.normalizedPath;
          }
          explicitOverrideKeys.add(cleanKey);
          const looksLikePath = cleanKey.includes('/') || cleanKey.includes('\\') || /^[A-Za-z]:/.test(cleanKey);
          if (looksLikePath) {
            workspaceOverrides[cleanKey] = cleanTarget;
            if (saveMappings && cleanTarget !== AUTO_MIRROR_SENTINEL) {
              permanentMappingsToAdd.push({ sourceCwd: cleanKey, localTarget: cleanTarget });
            }
          } else {
            sessionOverrides[cleanKey] = cleanTarget;
          }
        }
      }

      if (saveMappings && permanentMappingsToAdd.length > 0) {
        for (const { sourceCwd, localTarget } of permanentMappingsToAdd) {
          const isSrcWin = /^[A-Za-z]:[\\/]/.test(sourceCwd) || /^\\\\/.test(sourceCwd);
          const isLocalWin = this.platform === 'win32';
          if (isSrcWin === isLocalWin) {
            // P2-2: Same-OS override -> persist in workspaceTargetOverrides without polluting cross-OS fields!
            sameOsWorkspaceOverridesToSave[sourceCwd] = localTarget;
          } else {
            // g4 #11: Check handleAddMapping result and surface error cleanly if invalid!
            const addRes = isLocalWin && !isSrcWin
              ? await this.handleAddMapping({ winPath: localTarget, macPath: sourceCwd, triggerPull: false })
              : await this.handleAddMapping({ winPath: sourceCwd, macPath: localTarget, triggerPull: false });
            if (addRes?.kind === 'error') {
              return { ok: false, reason: 'invalid-mapping', error: addRes.text };
            }
          }
        }
      }

      const globalRes = await this.syncGlobalAgentsMd();
      await this.syncGlobalWorkspaceMetadata().catch(() => {});

      const sessionRes = await pullSessionsFromVault({
        dshHome: this.dshHome,
        vault: this.vault,
        workspaceMappings: this.config.workspaceMappings,
        targetPlatform: this.platform,
        fallbackRoot: this.config.fallbackDir || undefined,
        cordisCtx: this._buildCordisAdapter(),
        folderMatchMode: this.config.folderMatchMode,
        autoMirrorRoot: this.config.autoMirrorRoot || undefined,
        autoMirrorAssignments: this.config.autoMirrorAssignments,
        excludedSessionIds: this.config.excludedSessionIds,
        withdrawnSessions: this.config.withdrawnSessions,
        restoredSessions: this.config.restoredSessions,
        sessionTargetOverrides: sessionOverrides,
        workspaceTargetOverrides: workspaceOverrides,
        onlySessionIds: cleanSids.length > 0 ? cleanSids : null,
        onlyWorkspaceSources: cleanWsSources.length > 0 ? cleanWsSources : null,
      });

      // C4 & P0-2: Surface output-conflict alerts & track deferred-busy sessions on selective pull too
      const needSelTitleLookup = (sessionRes.results ?? []).some(
        (r) => Array.isArray(r.outputConflicts) && r.outputConflicts.length > 0,
      );
      const selAlertLocalMap = needSelTitleLookup ? await scanLocalSessions(this.dshHome).catch(() => new Map()) : null;
      for (const r of sessionRes.results ?? []) {
        if (r.status === 'deferred-busy' && r.sessionId) {
          this._deferredBusySessions.add(r.sessionId);
        }
        if (Array.isArray(r.outputConflicts) && r.outputConflicts.length > 0) {
          const matchedWs = r.targetCwd ? this._matchWorkspaceForPath(r.targetCwd) : null;
          const names = r.outputConflicts.map((c) => c.path).join('、');
          const rec = selAlertLocalMap?.get(r.sessionId);
          const title = rec ? extractSessionTitle(rec.events, '') : '';
          const label = title ? `对话「${title}」` : `会话 ${String(r.sessionId || '').slice(0, 8)}`;
          this._pushAlert({
            kind: 'output-conflict',
            workspaceId: matchedWs?.mapping?.id ?? null,
            workspacePath: r.targetCwd ?? null,
            sessionId: r.sessionId,
            text: `${label} 的 outputs/ 产出存在双边修改冲突（${names}），已保留本机文件并并列保存远端冲突副本`,
          });
        }
      }

      // P1-2C: Persist bidirectional tracking so subsequent local replies in pulled sessions auto-push back!
      const nextSelectedSids = new Set(this.config.selectedSessionIds ?? []);
      const nextSessionOverrides = { ...(this.config.sessionTargetOverrides ?? {}) };
      const nextWorkspaceOverrides = { ...(this.config.workspaceTargetOverrides ?? {}), ...sameOsWorkspaceOverridesToSave };
      const nextMirrorAssignments = {
        ...(this.config.autoMirrorAssignments ?? {}),
        ...(sessionRes.newAutoMirrorAssignments ?? {}),
      };
      let trackingChanged = Object.keys(sameOsWorkspaceOverridesToSave).length > 0
        || Object.keys(sessionRes.newAutoMirrorAssignments ?? {}).length > 0;

      for (const r of sessionRes.results ?? []) {
        if (r.status === 'imported' || r.status === 'fast-forwarded' || r.status === 'migrated') {
          if (this.config.syncScope === 'selected' && !nextSelectedSids.has(r.sessionId)) {
            nextSelectedSids.add(r.sessionId);
            trackingChanged = true;
          }
          if (r.targetCwd) {
            const mapped = mapPathAcrossOs(r.targetCwd, this.config.workspaceMappings ?? [], this.platform);
            const usedCustomTarget = r.matchedBy === 'override'
              || r.matchedBy === 'auto-mirror'
              || (!mapped.matched && (this.config.folderMatchMode === 'mapped-only' || explicitOverrideKeys.size > 0));
            if (usedCustomTarget && nextSessionOverrides[r.sessionId] !== r.targetCwd) {
              nextSessionOverrides[r.sessionId] = r.targetCwd;
              trackingChanged = true;
            }
          }
        }
      }

      if (trackingChanged) {
        await saveConfig(this.dshHome, {
          selectedSessionIds: [...nextSelectedSids],
          sessionTargetOverrides: nextSessionOverrides,
          workspaceTargetOverrides: nextWorkspaceOverrides,
          autoMirrorAssignments: nextMirrorAssignments,
        });
        this.config = await loadConfig(this.dshHome);
      }

      // P1-2B: Pull deliverables for mapped workspaces matching BOTH selected workspaceSources
      // AND the targetCwd/sourceCwd of any individually selected & pulled session!
      const wsIdsToPull = new Set();
      for (const mapping of this.config.workspaceMappings ?? []) {
        const localRoot = mapping[this.platform];
        if (!localRoot) continue;
        const matchesSource = cleanWsSources.some((src) => {
          if (src.toLowerCase() === mapping.id.toLowerCase()) return true;
          if (mapping.title && src.toLowerCase() === mapping.title.toLowerCase()) return true;
          for (const osKey of ['win32', 'darwin', 'linux']) {
            if (mapping[osKey] && mapping[osKey].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
              === src.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()) {
              return true;
            }
          }
          return false;
        });
        if (matchesSource) wsIdsToPull.add(mapping.id);
      }
      for (const r of sessionRes.results ?? []) {
        if (r.status === 'unmapped-skipped' || r.status === 'pending-hydration' || r.status === 'version-mismatch') continue;
        for (const p of [r.targetCwd, r.sourceCwd]) {
          if (!p) continue;
          const matched = this._matchWorkspaceForPath(p);
          if (matched?.mapping?.id) wsIdsToPull.add(matched.mapping.id);
        }
      }

      const workspaceResults = [];
      if (wsIdsToPull.size > 0) {
        const { commits: remoteWsCommits } = await this.vault.listCommits('workspace', { includeSelf: false });
        const remoteWsIds = new Set(remoteWsCommits.map((c) => c.targetId));
        for (const mapping of this.config.workspaceMappings ?? []) {
          if (!wsIdsToPull.has(mapping.id)) continue;
          const localRoot = mapping[this.platform];
          if (!localRoot) continue;
          const exists = await pathExists(localRoot);
          if (!exists && !remoteWsIds.has(mapping.id)) continue;
          if (!exists) {
            await fs.mkdir(localRoot, { recursive: true });
          }
          const wsRes = await pullWorkspaceDeliverables({
            dshHome: this.dshHome,
            vault: this.vault,
            workspaceId: mapping.id,
            workspaceRoot: localRoot,
            trashRetentionDays: this.config.quotas?.trashRetentionDays,
          });
          workspaceResults.push({ workspaceId: mapping.id, title: mapping.title, ...wsRes });
        }
      }

      this._lastPullAt = Date.now();
      return {
        ok: true,
        global: globalRes,
        sessions: sessionRes,
        workspaces: workspaceResults,
      };
    });
  }

  /**
   * P1-3: Withdraw one or more sessions from the shared vault across all device folders,
   * prune orphan blobs, add them to local `excludedSessionIds`, and broadcast their
   * withdrawal timestamps via encrypted global `workspace-mappings` metadata so peers
   * do not auto-re-push unchanged withdrawn sessions.
   */
  async unpublishSessionFromVault({ sessionIds = [], addToExcluded = true, includeAllDevices = true } = {}) {
    return this._withSyncLock(async () => {
      if (!this.config) await this.reloadConfig();
      if (!this.vault) {
        return { ok: false, reason: 'no-vault' };
      }

      const cleanSids = Array.isArray(sessionIds)
        ? [...new Set(sessionIds.map((s) => String(s ?? '').trim()).filter(Boolean))]
        : [];
      if (cleanSids.length === 0) {
        return { ok: false, reason: 'empty-selection' };
      }

      let removedCommits = 0;
      let prunedBlobs = 0;
      const now = Date.now();
      const nextExcluded = new Set(this.config.excludedSessionIds ?? []);
      const nextSelected = new Set(this.config.selectedSessionIds ?? []);
      const nextWithdrawn = { ...(this.config.withdrawnSessions ?? {}) };
      const existingRestored = this.config.restoredSessions ?? {};

      for (const sid of cleanSids) {
        const res = await this.vault.unpublishTarget('session', sid, { includeAllDevices });
        removedCommits += res.removedCommits;
        prunedBlobs += res.prunedBlobs;
        if (addToExcluded) {
          nextExcluded.add(sid);
        }
        nextSelected.delete(sid);
        // Opus G2 + Neon CHK5A: Always record `withdrawnSessions[sid]` so `selected`-mode peers drop `sid`
        // from their `selectedSessionIds` and never resurrect it, while `addToExcluded: false` avoids permanent
        // shielding so switching back to `syncScope: 'active'` restores syncing cleanly!
        const prevRestored = Number(existingRestored[sid] ?? 0);
        nextWithdrawn[sid] = Math.max(now, prevRestored + 1);
      }

      await saveConfig(this.dshHome, {
        excludedSessionIds: [...nextExcluded],
        selectedSessionIds: [...nextSelected],
        withdrawnSessions: nextWithdrawn,
      });
      await this.reloadConfig();
      await this.syncGlobalWorkspaceMetadata({ publishLocal: true }).catch(() => {});

      return {
        ok: true,
        sessionIds: cleanSids,
        removedCommits,
        prunedBlobs,
      };
    });
  }

  async updateSettings(patch = {}) {
    if (!this.config) await this.reloadConfig();
    const nextPatch = {};
    let keyUpdated = false;
    let vaultDirUpdated = false;
    let restoredMetadataChanged = false;
    let pollerResetNeeded = false;

    if (patch.folderMatchMode !== undefined) {
      if (!VALID_FOLDER_MATCH_MODES.includes(patch.folderMatchMode)) {
        throw new Error(`无效 folderMatchMode：${patch.folderMatchMode}`);
      }
      nextPatch.folderMatchMode = patch.folderMatchMode;
      pollerResetNeeded = true;
    }
    if (patch.syncScope !== undefined) {
      if (!VALID_SYNC_SCOPES.includes(patch.syncScope)) {
        throw new Error(`无效 syncScope：${patch.syncScope}`);
      }
      nextPatch.syncScope = patch.syncScope;
      pollerResetNeeded = true;
      // Neon P1 #5: When returning from `selected` to `active`, restore any non-excluded sessions
      // that may have been placed in `withdrawnSessions` so they resume syncing cleanly!
      if (patch.syncScope === 'active' && this.config.syncScope === 'selected') {
        const effectiveExcludedSet = new Set(
          Array.isArray(patch.excludedSessionIds) ? patch.excludedSessionIds : (this.config.excludedSessionIds ?? []),
        );
        const nextWithdrawn = { ...(this.config.withdrawnSessions ?? {}) };
        const nextRestored = { ...(this.config.restoredSessions ?? {}) };
        const now = Date.now();
        let restoredAny = false;
        for (const [sid, wTs] of Object.entries(nextWithdrawn)) {
          if (effectiveExcludedSet.has(sid)) continue;
          const prevW = Number(wTs ?? 0);
          if (prevW > 0) {
            delete nextWithdrawn[sid];
            nextRestored[sid] = Math.max(now, prevW + 1, Number(nextRestored[sid] ?? 0) + 1);
            restoredAny = true;
          }
        }
        if (restoredAny) {
          nextPatch.withdrawnSessions = nextWithdrawn;
          nextPatch.restoredSessions = nextRestored;
          restoredMetadataChanged = true;
        }
      }
    }
    if (Array.isArray(patch.selectedWorkspaces)) {
      nextPatch.selectedWorkspaces = patch.selectedWorkspaces;
    }
    if (Array.isArray(patch.selectedSessionIds)) {
      nextPatch.selectedSessionIds = patch.selectedSessionIds;
    }
    if (Array.isArray(patch.excludedSessionIds)) {
      nextPatch.excludedSessionIds = patch.excludedSessionIds;
      pollerResetNeeded = true;
      // P1-2: Un-excluding（「取消屏蔽」）a previously withdrawn session records LWW restoredAt so it syncs again!
      const prevExcluded = new Set(this.config.excludedSessionIds ?? []);
      const nextExcludedSet = new Set(patch.excludedSessionIds);
      const unexcluded = [...prevExcluded].filter((sid) => !nextExcludedSet.has(sid));
      if (unexcluded.length > 0) {
        const nextWithdrawn = { ...(this.config.withdrawnSessions ?? {}) };
        const nextRestored = { ...(this.config.restoredSessions ?? {}) };
        const now = Date.now();
        for (const sid of unexcluded) {
          const prevW = Number(nextWithdrawn[sid] ?? 0);
          if (prevW > 0) {
            delete nextWithdrawn[sid];
            nextRestored[sid] = Math.max(now, prevW + 1, Number(nextRestored[sid] ?? 0) + 1);
            restoredMetadataChanged = true;
          }
        }
        if (restoredMetadataChanged) {
          nextPatch.withdrawnSessions = nextWithdrawn;
          nextPatch.restoredSessions = nextRestored;
        }
      }
    }
    if (patch.disconnectVault === true) {
      this._stopBackgroundPoller();
      for (const wsId of [...this._watchers.keys()]) {
        await this._closeWorkspaceWatcher(wsId);
      }
      await saveConfig(this.dshHome, { vaultDir: '' });
      // P1-1: Record current native volatile field hashes as consumed so restarting after disconnect NEVER resurrects old vaultDir!
      await this._saveVolatileState(this._computeVolatileFieldHashes(this._readVolatileSettings())).catch(() => {});
      this._startupErrors = this._startupErrors.filter((m) => !m.includes('vaultDir'));
      await this.reloadConfig();
      return {
        ...this.config,
        disconnected: true,
        withdrawnCount: 0,
        keyUpdateBlocked: false,
        requiresKeyRotationConfirm: false,
      };
    }

    if (typeof patch.autoMirrorRoot === 'string') {
      const cleanedMirror = stripOuterQuotes(patch.autoMirrorRoot);
      const expanded = expandPosixHome(cleanedMirror, this.platform);
      nextPatch.autoMirrorRoot = expanded ? path.resolve(expanded) : '';
    }
    if (typeof patch.vaultDir === 'string') {
      const trimmedVault = stripOuterQuotes(patch.vaultDir);
      if (trimmedVault) {
        const vaultHostPlatform = this.platform === process.platform ? this.platform : process.platform;
        const vaultCheck = validateVaultDirectory(trimmedVault, vaultHostPlatform, {
          dshHome: this.dshHome,
          workspaceMappings: this.config.workspaceMappings ?? [],
        });
        if (!vaultCheck.ok) {
          throw new Error(vaultCheck.error);
        }
        const resolvedNextVault = path.resolve(vaultCheck.normalizedPath);
        const resolvedPrevVault = this.config.vaultDir ? path.resolve(this.config.vaultDir) : '';
        const normVaultCmp = (p) => {
          const s = String(p || '').replace(/[\\/]+$/, '');
          return (this.platform === 'win32' || this.platform === 'darwin') ? s.toLowerCase() : s;
        };
        const actuallyChanged = normVaultCmp(resolvedNextVault) !== normVaultCmp(resolvedPrevVault);
        nextPatch.vaultDir = resolvedNextVault;
        if (actuallyChanged) {
          vaultDirUpdated = true;
          pollerResetNeeded = true;
        }
      }
    }
    if (typeof patch.deviceLabel === 'string' && patch.deviceLabel.trim()) {
      nextPatch.deviceLabel = patch.deviceLabel.trim();
    }
    if (typeof patch.stepSyncEnabled === 'boolean') {
      nextPatch.stepSyncEnabled = patch.stepSyncEnabled;
    }
    const confirmKeyRotation = patch.confirmKeyRotation === true;
    let keyUpdateBlocked = false;
    let requiresKeyRotationConfirm = false;
    let confirmKind = null;
    let keyWarning = null;
    const effectiveVaultDir = nextPatch.vaultDir || this.config.vaultDir || '';

    if (typeof patch.passphrase === 'string' && patch.passphrase.length > 0) {
      // C2 / C3 / Neon P0 #1: Majority-device passphrase guard BEFORE overwriting local `secret.key`!
      // Runs on BOTH same-vault saves (even when UI sends unchanged `vaultDir`) AND vault switches!
      let allowWriteKey = true;
      if (effectiveVaultDir && !confirmKeyRotation) {
        const candidateKeys = derivePassphraseKey(patch.passphrase);
        const oldVault = new VaultStore({
          vaultDir: effectiveVaultDir,
          deviceId: this.config.deviceId,
          platform: this.platform,
          secretKeys: this.config.encryptionEnabled ? this.secretKeys : null,
          quotas: this.config.quotas,
        });
        const newVault = new VaultStore({
          vaultDir: effectiveVaultDir,
          deviceId: this.config.deviceId,
          platform: this.platform,
          secretKeys: candidateKeys,
          quotas: this.config.quotas,
        });
        const oldStats = await oldVault.countReadableDeviceStats().catch(() => null);
        const newStats = await newVault.countReadableDeviceStats().catch(() => null);

        if (oldStats && newStats) {
          const oldTotal = oldStats.totalDecryptedCount;
          const newTotal = newStats.totalDecryptedCount;
          const oldDevices = oldStats.peerReadableDevices + (oldStats.ownDecryptedCount > 0 ? 1 : 0);
          const newDevices = newStats.peerReadableDevices + (newStats.ownDecryptedCount > 0 ? 1 : 0);
          const sameKeyAlready = Boolean(
            this.secretKeys?.encKeyHex
            && candidateKeys?.encKeyHex
            && this.secretKeys.encKeyHex === candidateKeys.encKeyHex,
          );

          if (!sameKeyAlready && oldTotal > 0) {
            let worseOrZero = false;
            if (newTotal === 0) {
              worseOrZero = true;
            } else if (newDevices < oldDevices) {
              worseOrZero = true;
            } else if (newDevices === oldDevices) {
              if (oldStats.peerReadableDevices === 0 && newStats.peerReadableDevices > 0) {
                // 1-vs-1 tie (own-only old key vs peer-used new key):
                // Protect an established original device (more sessions OR established earlier) from a newcomer's typo,
                // while letting a newcomer fix its own mistyped passphrase to join the established peer!
                const oldHasMoreSessions = oldStats.ownSessionCount > newStats.peerSessionCount;
                const tiedSessionsOldWasEarlier =
                  oldStats.ownSessionCount === newStats.peerSessionCount
                  && oldStats.ownEarliestTs > 0
                  && newStats.peerEarliestTs > 0
                  && oldStats.ownEarliestTs < newStats.peerEarliestTs;
                if (oldHasMoreSessions || tiedSessionsOldWasEarlier) {
                  worseOrZero = true;
                }
              } else if (newTotal < oldTotal) {
                worseOrZero = true;
              }
            }
            if (worseOrZero) {
              allowWriteKey = false;
              keyUpdateBlocked = true;
              requiresKeyRotationConfirm = true;
              keyWarning = newTotal === 0
                ? `新输入的口令无法解密金库中任何现有记录（当前口令可正常读取 ${oldDevices} 台设备的 ${oldTotal} 条记录）。为防止打错口令破坏金库，本次未覆盖本地密钥；如果您确实要将整个金库轮换为新口令，请点击「确认轮换整个金库口令」。`
                : `新口令仅能解密 ${newDevices} 台设备的 ${newTotal} 条记录，少于当前口令可读的 ${oldDevices} 台设备 ${oldTotal} 条记录（疑似将某台错口令设备的密码输到了正确设备上）。本次未覆盖本地密钥；如确需切换并重推，请点击「确认轮换整个金库口令」。`;
            }
          } else if (vaultDirUpdated && newTotal === 0 && newStats.peerFailedCount > 0) {
            // Switching to an existing encrypted peer vault with a passphrase that decrypts 0 peer commits
            allowWriteKey = false;
            keyUpdateBlocked = true;
            requiresKeyRotationConfirm = true;
            keyWarning = `新输入的口令无法解密目标金库中对端设备的 ${newStats.peerFailedCount} 条现有记录（0 条可读）。为防止误用错误口令污染金库，本次未覆盖本地密钥；请核对对端设备口令，或如确需强制轮换请点击「确认轮换整个金库口令」。`;
          }
        }
      }

      if (keyUpdateBlocked) {
        // Neon CHK2B: Roll back `vaultDir` switch when the accompanying passphrase was blocked
        // so we NEVER save the new `vaultDir` with an old key / plaintext or pollute `vaultB`!
        delete nextPatch.vaultDir;
        vaultDirUpdated = false;
        pollerResetNeeded = false;
      } else if (allowWriteKey) {
        await savePassphraseKey(this.dshHome, patch.passphrase);
        nextPatch.encryptionEnabled = true;
        keyUpdated = true;
        pollerResetNeeded = true;
      }
    } else if (patch.clearPassphrase === true) {
      let allowClearKey = true;
      // P0-1: Guard BOTH same-vault AND cross-vault clearPassphrase so switching an encrypted vault
      // to plaintext NEVER silently deletes `secret.key` or causes split-brain + broken GC!
      if (effectiveVaultDir && !confirmKeyRotation) {
        const plainVault = new VaultStore({
          vaultDir: effectiveVaultDir,
          deviceId: this.config.deviceId,
          platform: this.platform,
          secretKeys: null,
          quotas: this.config.quotas,
        });
        const plainStats = await plainVault.countReadableDeviceStats().catch(() => null);
        if (plainStats && plainStats.totalFailedCount > 0) {
          allowClearKey = false;
          keyUpdateBlocked = true;
          requiresKeyRotationConfirm = true;
          confirmKind = 'clear-to-plaintext';
          keyWarning = `当前金库中已有 ${plainStats.totalFailedCount} 条加密记录，不能直接清除密钥切为明文模式——切换明文后历史密文将全部无法读取，另一台开启加密的电脑也会报错！若只是想修改口令，请点击「取消」并在上方输入新口令点击「保存连接设置」；如确需彻底放弃加密并重推明文，请再次点击确认（同时需将另一台电脑切为明文或换用新空金库）。`;
          delete nextPatch.vaultDir;
          vaultDirUpdated = false;
          pollerResetNeeded = false;
        }
      }
      if (allowClearKey) {
        await savePassphraseKey(this.dshHome, '');
        nextPatch.encryptionEnabled = false;
        keyUpdated = true;
        pollerResetNeeded = true;
      }
    } else if (vaultDirUpdated && effectiveVaultDir && !confirmKeyRotation) {
      // CHK2B-3: Switching `vaultDir` WITHOUT providing a new `passphrase` (e.g. UI cleared `connPassphrase`
      // and user only edited `vaultDir` to point at `vaultC` encrypted under a different passphrase):
      // Verify existing local key (or plaintext) can actually decrypt `vaultC` BEFORE persisting `vaultC`!
      const checkVault = new VaultStore({
        vaultDir: effectiveVaultDir,
        deviceId: this.config.deviceId,
        platform: this.platform,
        secretKeys: this.config.encryptionEnabled ? this.secretKeys : null,
        quotas: this.config.quotas,
      });
      const checkStats = await checkVault.countReadableDeviceStats().catch(() => null);
      if (checkStats && checkStats.totalDecryptedCount === 0 && checkStats.totalFailedCount > 0) {
        keyUpdateBlocked = true;
        requiresKeyRotationConfirm = true;
        keyWarning = `本机当前密钥无法解密目标金库中的 ${checkStats.totalFailedCount} 条现有记录（0 条可读）。为防止误用旧密钥污染目标金库，本次未切换金库目录；请同时输入目标金库的正确加密口令后再保存，或如确需将本机数据强制推入目标金库请点击「确认轮换整个金库口令」。`;
        delete nextPatch.vaultDir;
        vaultDirUpdated = false;
        pollerResetNeeded = false;
      }
    }
    if (patch.maxAutoSessionsPerWorkspace !== undefined) {
      const n = Number(patch.maxAutoSessionsPerWorkspace);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error('maxAutoSessionsPerWorkspace 必须为正整数');
      }
      nextPatch.quotas = { ...(nextPatch.quotas ?? {}), maxAutoSessionsPerWorkspace: n };
    }

    if (Object.keys(nextPatch).length > 0) {
      await saveConfig(this.dshHome, nextPatch);
    }
    if (keyUpdated) {
      this._startupErrors = this._startupErrors.filter((m) => !m.includes('secret.key'));
    }
    if (vaultDirUpdated) {
      this._startupErrors = this._startupErrors.filter((m) => !m.includes('vaultDir'));
    }
    await this.reloadConfig();
    if (pollerResetNeeded) {
      this._seenRemoteCommitFiles.clear();
    }

    // Optional: withdraw unselected sessions ORIGINATED BY THIS DEVICE when switching to/saving whitelist
    // C12 & P2-3: Inspect LATEST commit per session, NEVER delete peer-originated sessions,
    // and do NOT add them to permanent `excludedSessionIds`!
    let withdrawnCount = 0;
    if (patch.withdrawUnselected === true && this.vault && this.config.syncScope === 'selected') {
      const selfListed = await this.vault.listCommits('session', { onlySelf: true });
      const allListed = await this.vault.listCommits('session', { includeSelf: true });

      const latestSelfBySid = new Map();
      for (const c of selfListed.commits) {
        const sid = c.payload?.rootSessionId ?? c.targetId;
        if (sid) latestSelfBySid.set(sid, c);
      }

      const earliestOriginBySid = new Map();
      for (const c of allListed.commits) {
        const sid = c.payload?.rootSessionId ?? c.targetId;
        if (!sid) continue;
        if (!earliestOriginBySid.has(sid)) {
          earliestOriginBySid.set(sid, c.payload?.originDeviceId || c.deviceId);
        }
      }

      const selectedSidSet = new Set(this.config.selectedSessionIds ?? []);
      const toWithdraw = [];
      for (const [sid, latestCommit] of latestSelfBySid.entries()) {
        if (selectedSidSet.has(sid)) continue;
        const originDev = latestCommit.payload?.originDeviceId || earliestOriginBySid.get(sid) || latestCommit.deviceId;
        if (originDev !== this.config.deviceId) {
          // NEVER withdraw or delete sessions originated by a peer device!
          continue;
        }
        const srcCwd = latestCommit?.payload?.sourceCwd ?? '';
        if (srcCwd && matchesWorkspaceSelector(srcCwd, this.config.selectedWorkspaces ?? [], this.config.workspaceMappings ?? [], this.platform)) {
          continue;
        }
        toWithdraw.push(sid);
      }
      if (toWithdraw.length > 0) {
        const res = await this.unpublishSessionFromVault({
          sessionIds: toWithdraw,
          addToExcluded: false,
          includeAllDevices: true,
        });
        withdrawnCount = res.ok ? toWithdraw.length : 0;
      }
    }

    if (restoredMetadataChanged && this.vault && !this._disposed) {
      await this.syncGlobalWorkspaceMetadata({ publishLocal: true }).catch(() => {});
    }

    // C2 / C3 / P2-3 / Neon CHK2B: Safe passphrase recovery & explicit key rotation!
    if (!keyUpdateBlocked && (keyUpdated || vaultDirUpdated) && this.vault && !this._disposed) {
      const clearedPassphrase = patch.clearPassphrase === true;
      if (keyUpdated) {
        const stats = await this.vault.countReadableDeviceStats().catch(() => ({
          peerReadableDevices: 0,
          peerFailedDevices: 0,
          peerDecryptedCount: 0,
          peerFailedCount: 0,
          ownDecryptedCount: 0,
          ownFailedCount: 0,
          totalDecryptedCount: 0,
          totalFailedCount: 0,
        }));
        const keyMatchesExistingVault = stats.totalDecryptedCount > 0;
        const canSafelyPurgeOwn =
          confirmKeyRotation
          || stats.peerDecryptedCount > 0
          || (stats.peerFailedCount === 0 && stats.ownDecryptedCount > 0 && stats.ownDecryptedCount >= stats.ownFailedCount);
        const vaultHasExistingCommits = stats.totalDecryptedCount > 0 || stats.totalFailedCount > 0;
        const likelyTypoKey = !confirmKeyRotation && !keyMatchesExistingVault && vaultHasExistingCommits;

        if ((!clearedPassphrase && this.vault.encrypted && canSafelyPurgeOwn) || (clearedPassphrase && confirmKeyRotation)) {
          const purgeRes = await this.vault.purgeUndecryptableOwnCommits({ runGc: false }).catch(() => ({ removedCommits: 0 }));
          if (!confirmKeyRotation) {
            await this.pullAll({ silent: true }).catch(() => {});
          }
          await this.pushAll({ force: confirmKeyRotation }).catch(() => {});
          await this.syncGlobalAgentsMd({ forcePublish: true }).catch(() => {});
          await this.syncGlobalWorkspaceMetadata({ publishLocal: true }).catch(() => {});
          if ((purgeRes?.removedCommits ?? 0) > 0) {
            const keepN = this.config.quotas?.retainSnapshots ?? DEFAULT_QUOTAS.retainSnapshots;
            await this.vault.pruneHistory('session', keepN).catch(() => {});
            await this.vault.pruneHistory('workspace', keepN).catch(() => {});
          }
        } else if (!likelyTypoKey) {
          await this.syncGlobalWorkspaceMetadata().catch(() => {});
          await this.pullAll({ silent: true }).catch(() => {});
          await this.pushAll().catch(() => {});
        }
      } else {
        // Neon CHK2B: Guard `vaultDir`-only switch — NEVER push into a differently-encrypted target vault!
        const switchStats = await this.vault.countReadableDeviceStats().catch(() => null);
        const mismatchedTargetVault = Boolean(
          switchStats && switchStats.totalDecryptedCount === 0 && switchStats.totalFailedCount > 0,
        );
        if (!mismatchedTargetVault) {
          await this.syncGlobalWorkspaceMetadata().catch(() => {});
          await this.pullAll({ silent: true }).catch(() => {});
          await this.pushAll().catch(() => {});
        }
      }
    }

    return {
      ...this.config,
      withdrawnCount,
      keyUpdateBlocked,
      requiresKeyRotationConfirm,
      ...(confirmKind ? { confirmKind } : {}),
      ...(keyWarning ? { warning: keyWarning } : {}),
    };
  }

  async disconnectVault() {
    return this.updateSettings({ disconnectVault: true });
  }

  async resetLocalConfig() {
    this._stopBackgroundPoller();
    for (const wsId of [...this._watchers.keys()]) {
      await this._closeWorkspaceWatcher(wsId);
    }
    return this._withSyncLock(async () => {
      const syncDir = soulSyncDir(this.dshHome);
      await fs.rm(syncDir, { recursive: true, force: true });
      await saveConfig(this.dshHome, {});
      // P1-1: Record current native volatile field hashes as consumed so restarting after reset NEVER resurrects old vaultDir/passphrase!
      await this._saveVolatileState(this._computeVolatileFieldHashes(this._readVolatileSettings())).catch(() => {});
      this._pendingAlerts = [];
      this._startupErrors = [];
      this._lastBackupAt = null;
      this._lastPullAt = null;
      await this.reloadConfig();
      return { ok: true, config: this.config };
    });
  }

  async uninstallPlugin() {
    this._stopBackgroundPoller();
    for (const wsId of [...this._watchers.keys()]) {
      await this._closeWorkspaceWatcher(wsId);
    }
    await this._syncChain.catch(() => {});
    const res = await uninstallPluginFromDshHome(this.dshHome);
    this._disposed = true;
    this._uninstalled = true;
    this.vault = null;
    this.secretKeys = null;
    this.config = null;
    this._pendingAlerts = [];
    this._startupErrors = [];
    return res;
  }

  async checkSelfUpdate(options = {}) {
    const repoRoot = options.repoRoot || this.pluginConfig?.repoRoot || REPO_ROOT;
    const fetchImpl = options.fetchImpl || this.pluginConfig?.updateFetchImpl || globalThis.fetch;
    return checkRemoteUpdate({ repoRoot, fetchImpl });
  }

  async applySelfUpdate(options = {}) {
    const repoRoot = options.repoRoot || this.pluginConfig?.repoRoot || REPO_ROOT;
    const fetchImpl = options.fetchImpl || this.pluginConfig?.updateFetchImpl || globalThis.fetch;
    return applyRemoteUpdate({
      repoRoot,
      dshHome: this.dshHome,
      fetchImpl,
      forceTarball: Boolean(options.forceTarball),
    });
  }

  async removeMapping({ id } = {}) {
    if (!this.config) await this.reloadConfig();
    const targetId = String(id ?? '').trim();
    if (!targetId) throw new Error('缺少要删除的映射 id');
    const prev = this.config.workspaceMappings ?? [];
    const next = prev.filter((m) => m.id !== targetId);
    const removed = prev.length !== next.length;
    const nextDeleted = { ...(this.config.deletedMappingIds ?? {}) };
    if (removed) {
      nextDeleted[targetId] = Date.now();
    }
    await saveConfig(this.dshHome, {
      workspaceMappings: next,
      deletedMappingIds: nextDeleted,
    });
    if (removed) {
      await this._closeWorkspaceWatcher(targetId);
    }
    await this.reloadConfig();
    this._seenRemoteCommitFiles.clear();
    if (removed && this.vault) {
      await this.syncGlobalWorkspaceMetadata({ publishLocal: true }).catch(() => {});
    }
    return { removed, workspaceMappings: next };
  }

  async handleHttpApi(req, res) {
    const remoteAddr = req.socket?.remoteAddress || '';
    if (!isLoopbackRemoteAddress(remoteAddr)) {
      sendJson(res, 403, { ok: false, error: 'loopback only' });
      return;
    }

    // F14: DNS rebinding protection — validate Host header hostname
    const hostHeader = req.headers?.host;
    if (hostHeader && !isAllowedLoopbackHost(hostHeader)) {
      sendJson(res, 403, { ok: false, error: 'forbidden host' });
      return;
    }

    // C1: Strict Origin fence — http(s) loopback Origin MUST match Host (hostname + port) exactly;
    // arbitrary cross-port http://localhost:5173 -> Host: 127.0.0.1:3080 is ALWAYS rejected with 403!
    const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : '';
    if (origin && !isAllowedLoopbackOrigin(origin, hostHeader || '')) {
      sendJson(res, 403, { ok: false, error: 'forbidden origin' });
      return;
    }

    // C1 Security P0 & Neon P2 #6: Enforce real DSH host cookie authentication (`connection.requestRejection` / `connection.admit`)
    // BEFORE handling `OPTIONS` preflight, and NEVER reflect `Access-Control-Allow-Origin: dsh-app://app`
    // (Electron Desktop `forwardWebRequest` strips `Origin` and never sends CORS preflights).
    const isHttpLoopbackOrigin = Boolean(origin && /^https?:\/\//i.test(origin.trim()));
    const corsHeaders = isHttpLoopbackOrigin
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, x-dsh-soul-sync',
          vary: 'Origin',
        }
      : {};

    const connectionSvc = getCtxService(this.ctx, 'connection');
    if (connectionSvc) {
      let rejection;
      if (typeof connectionSvc.requestRejection === 'function') {
        rejection = connectionSvc.requestRejection(req);
      } else if (typeof connectionSvc.admit === 'function') {
        const admission = connectionSvc.admit(req);
        if (admission && 'rejection' in admission) {
          rejection = admission.rejection;
        }
      }
      if (typeof rejection === 'number') {
        sendJson(
          res,
          rejection,
          { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' },
          corsHeaders,
        );
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Strict CSRF guard: require custom same-origin header on every GET/POST/DELETE request
    if (req.headers?.['x-dsh-soul-sync'] !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing required x-dsh-soul-sync header' }, corsHeaders);
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const subPath = url.pathname.replace(/^\/__soul-sync\/api\/?/, '');

    // P2-3: Once uninstalled, NEVER call reloadConfig() or recreate `<dshHome>/soul-sync/` before restart!
    if (this._uninstalled) {
      if (req.method === 'GET' && (subPath === '' || subPath === 'state')) {
        sendJson(res, 200, {
          ok: true,
          uninstalled: true,
          platform: this.platform,
          hasVault: false,
          vaultConfigured: false,
          vaultLooksLikeCloudDrive: false,
          hasSecretKey: false,
          hasRevealablePassphrase: false,
          encrypted: false,
          decryptionFailedCount: 0,
          decryptionFailedDevices: {},
          decryptionFailedDeviceLabels: {},
          hydrationPendingCount: 0,
          vaultError: null,
          deviceLabel: '',
          stepSyncEnabled: false,
          excludedSessionIds: [],
          withdrawnSessions: {},
          alerts: [],
          lastBackupAt: null,
          lastPullAt: null,
          startupErrors: [],
          config: { workspaceMappings: [] },
          localCatalog: { workspaces: [], totalSessions: 0, filteredEmptyCount: 0 },
          vaultCatalog: { workspaces: [], totalSessions: 0, pendingCount: 0, hydrationPendingCount: 0, decryptionFailedCount: 0, decryptionFailedDevices: {} },
        }, corsHeaders);
        return;
      }
      sendJson(res, 400, { ok: false, error: '插件已卸载，请退出并重启 DeepSeek Harness 完成移除。' }, corsHeaders);
      return;
    }

    try {
      if (req.method === 'GET' && (subPath === '' || subPath === 'state')) {
        if (!this.config) await this.reloadConfig();
        // P2-3: Single shared local session scan across both localCatalog and vaultCatalog
        const sharedLocalMap = await scanLocalSessions(this.dshHome);

        // P0-2 / P2-3: Isolate vault read errors so offline cloud drive still returns HTTP 200
        // and user can fix vaultDir/passphrase right inside the panel!
        let vaultCatalog = {
          workspaces: [],
          totalSessions: 0,
          pendingCount: 0,
          hydrationPendingCount: 0,
          decryptionFailedCount: 0,
          decryptionFailedDevices: {},
        };
        let vaultError = null;
        let totalDecryptionFailedCount = 0;
        const rawFailedDevices = {};
        const vaultSessionIds = new Set();
        const deviceLabelById = new Map();
        if (this.config?.deviceId && this.config?.deviceLabel) {
          deviceLabelById.set(this.config.deviceId, this.config.deviceLabel);
        }

        if (this.vault) {
          try {
            const [allSessCommits, heartbeats] = await Promise.all([
              this.vault.listCommits('session', { includeSelf: true }).catch(() => ({ commits: [] })),
              this.vault.readHeartbeats().catch(() => []),
            ]);
            for (const c of allSessCommits.commits ?? []) {
              const sid = c.payload?.rootSessionId ?? c.targetId;
              if (sid) vaultSessionIds.add(sid);
            }
            for (const hb of heartbeats ?? []) {
              if (hb?.deviceId && hb?.deviceLabel) {
                deviceLabelById.set(hb.deviceId, hb.deviceLabel);
              }
            }

            vaultCatalog = await this.listVaultCatalog({ localMap: sharedLocalMap });
            totalDecryptionFailedCount = vaultCatalog.decryptionFailedCount ?? 0;
            for (const [dev, cnt] of Object.entries(vaultCatalog.decryptionFailedDevices ?? {})) {
              rawFailedDevices[dev] = (rawFailedDevices[dev] ?? 0) + cnt;
            }
            for (const extraKind of ['workspace', 'global']) {
              const extraListed = await this.vault.listCommits(extraKind, { includeSelf: false }).catch(() => null);
              if (extraListed && extraListed.decryptionFailedCount > 0) {
                totalDecryptionFailedCount += extraListed.decryptionFailedCount;
                for (const [dev, cnt] of Object.entries(extraListed.decryptionFailedDevices ?? {})) {
                  rawFailedDevices[dev] = (rawFailedDevices[dev] ?? 0) + cnt;
                }
              }
            }
            // R8: Auto-clear transient vault offline startup errors once vault is readable again
            this._clearRecoveredVaultStartupErrors();
          } catch (err) {
            vaultError = err instanceof Error ? err.message : String(err);
          }
        }

        const totalDecryptionFailedDevices = { ...rawFailedDevices };
        const decryptionFailedDeviceLabels = {};
        for (const devId of Object.keys(rawFailedDevices)) {
          decryptionFailedDeviceLabels[devId] = deviceLabelById.get(devId) || devId;
        }

        const localCatalog = await this.listLocalCatalog({
          localMap: sharedLocalMap,
          vaultSessionIds: this.vault ? vaultSessionIds : null,
        });

        const vaultConfigured = Boolean(this.config.vaultDir && this.config.vaultDir.trim());
        sendJson(res, 200, {
          ok: true,
          platform: this.platform,
          hasVault: Boolean(this.vault),
          vaultConfigured,
          vaultLooksLikeCloudDrive: Boolean(vaultConfigured && looksLikeCloudDrivePath(this.config.vaultDir)),
          hasSecretKey: Boolean(this.secretKeys),
          hasRevealablePassphrase: Boolean(this.secretKeys?.hasRevealablePassphrase),
          encrypted: Boolean(this.vault?.encrypted),
          decryptionFailedCount: totalDecryptionFailedCount,
          decryptionFailedDevices: totalDecryptionFailedDevices,
          decryptionFailedDeviceLabels,
          hydrationPendingCount: vaultCatalog.hydrationPendingCount ?? vaultCatalog.pendingCount ?? 0,
          vaultError,
          deviceLabel: this.config.deviceLabel,
          stepSyncEnabled: this.config.stepSyncEnabled !== false,
          excludedSessionIds: this.config.excludedSessionIds ?? [],
          withdrawnSessions: this.config.withdrawnSessions ?? {},
          alerts: [...this._pendingAlerts],
          lastBackupAt: this._lastBackupAt,
          lastPullAt: this._lastPullAt,
          startupErrors: [...this._startupErrors],
          config: {
            deviceId: this.config.deviceId,
            deviceLabel: this.config.deviceLabel,
            vaultDir: this.config.vaultDir,
            encryptionEnabled: this.config.encryptionEnabled,
            stepSyncEnabled: this.config.stepSyncEnabled,
            folderMatchMode: this.config.folderMatchMode,
            syncScope: this.config.syncScope,
            selectedWorkspaces: this.config.selectedWorkspaces,
            selectedSessionIds: this.config.selectedSessionIds,
            excludedSessionIds: this.config.excludedSessionIds,
            autoMirrorRoot: this.config.autoMirrorRoot,
            workspaceMappings: this.config.workspaceMappings,
            quotas: this.config.quotas,
          },
          localCatalog,
          vaultCatalog,
        }, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'passphrase/reveal') {
        if (!this.config) await this.reloadConfig();
        const available = Boolean(this.secretKeys?.hasRevealablePassphrase && this.secretKeys?.passphrase);
        sendJson(res, 200, {
          ok: true,
          hasSecretKey: Boolean(this.secretKeys),
          available,
          passphrase: available ? this.secretKeys.passphrase : null,
        }, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'settings') {
        const body = await readJsonBody(req);
        const updated = await this.updateSettings(body);
        sendJson(
          res,
          200,
          {
            ok: true,
            config: updated,
            withdrawnCount: updated.withdrawnCount ?? 0,
            keyUpdateBlocked: Boolean(updated.keyUpdateBlocked),
            requiresKeyRotationConfirm: Boolean(updated.requiresKeyRotationConfirm),
            ...(updated.confirmKind ? { confirmKind: updated.confirmKind } : {}),
            ...(updated.warning ? { warning: updated.warning } : {}),
          },
          corsHeaders,
        );
        return;
      }

      if (req.method === 'POST' && subPath === 'disconnect') {
        const updated = await this.disconnectVault();
        sendJson(res, 200, { ok: true, config: updated }, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'reset') {
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
          sendJson(res, 400, { ok: false, error: '重置本机配置需要显式确认（confirm: true）' }, corsHeaders);
          return;
        }
        const result = await this.resetLocalConfig();
        sendJson(res, 200, { ok: true, config: result.config }, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'uninstall') {
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
          sendJson(res, 400, { ok: false, error: '卸载插件需要显式确认（confirm: true）' }, corsHeaders);
          return;
        }
        const result = await this.uninstallPlugin();
        sendJson(res, 200, { ok: true, ...result }, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'mappings') {
        const body = await readJsonBody(req);
        const result = await this.handleAddMapping({
          winPath: body.winPath ?? body.win32 ?? '',
          macPath: body.macPath ?? body.darwin ?? '',
        });
        if (result.kind === 'error') {
          sendJson(res, 400, { ok: false, error: result.text }, corsHeaders);
          return;
        }
        sendJson(res, 200, { ok: true, message: result.text, workspaceMappings: this.config.workspaceMappings }, corsHeaders);
        return;
      }

      if ((req.method === 'DELETE' && subPath === 'mappings') || (req.method === 'POST' && subPath === 'mappings/delete')) {
        const body = await readJsonBody(req);
        const id = body.id ?? url.searchParams.get('id') ?? '';
        const result = await this.removeMapping({ id });
        sendJson(res, 200, { ok: true, ...result }, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'push-selected') {
        const body = await readJsonBody(req);
        const result = await this.pushSelected({
          workspacePaths: body.workspacePaths ?? [],
          sessionIds: body.sessionIds ?? [],
          rememberSelection: Boolean(body.rememberSelection),
        });
        sendJson(res, result.ok ? 200 : 400, result, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'pull-selected') {
        const body = await readJsonBody(req);
        const result = await this.pullSelected({
          workspaceSources: body.workspaceSources ?? [],
          sessionIds: body.sessionIds ?? [],
          targetOverrides: body.targetOverrides ?? {},
          saveMappings: Boolean(body.saveMappings),
        });
        sendJson(res, result.ok ? 200 : 400, result, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'unpublish') {
        const body = await readJsonBody(req);
        const result = await this.unpublishSessionFromVault({
          sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds : (body.sessionId ? [body.sessionId] : []),
        });
        sendJson(res, result.ok ? 200 : 400, result, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'alerts/dismiss') {
        const body = await readJsonBody(req);
        const result = this.dismissAlerts({
          id: body.id ?? null,
          all: Boolean(body.all || !body.id),
        });
        sendJson(res, 200, { ok: true, ...result }, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'sync') {
        const result = await this.handleSync();
        sendJson(res, result.kind === 'error' ? 400 : 200, { ok: result.kind !== 'error', text: result.text }, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'update/check') {
        const result = await this.checkSelfUpdate();
        sendJson(res, 200, result, corsHeaders);
        return;
      }

      if (req.method === 'POST' && subPath === 'update/apply') {
        const result = await this.applySelfUpdate();
        sendJson(res, result.ok ? 200 : 400, result, corsHeaders);
        return;
      }

      sendJson(res, 404, { ok: false, error: `unknown api route: ${subPath}` }, corsHeaders);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) }, corsHeaders);
    }
  }

  async _collectWorkspaceHealth(activeCwd = null) {
    const locks = [];
    const stagedIncoming = [];
    const conflicts = [];

    const targets = [];
    if (activeCwd) {
      const matched = this._matchWorkspaceForPath(activeCwd);
      if (matched) targets.push(matched);
    }
    if (targets.length === 0) {
      for (const mapping of this.config?.workspaceMappings ?? []) {
        const localRoot = mapping[this.platform];
        if (localRoot) targets.push({ mapping, localRoot });
      }
    }

    for (const { mapping, localRoot } of targets) {
      const state = await loadWorkspaceDeliverableState(this.dshHome, mapping.id);
      const tracked = Object.keys(state.trackedPaths ?? {});
      if (await pathExists(localRoot)) {
        const wsLocks = await detectOpenOfficeLocks(localRoot, tracked);
        for (const l of wsLocks) {
          locks.push({ workspaceId: mapping.id, title: mapping.title, ...l });
        }
      }
      for (const [relPath, meta] of Object.entries(state.pendingIncoming ?? {})) {
        stagedIncoming.push({ workspaceId: mapping.id, title: mapping.title, path: relPath, ...meta });
      }
      for (const [key, meta] of Object.entries(state.resolvedConflicts ?? {})) {
        conflicts.push({
          workspaceId: mapping.id,
          title: mapping.title,
          key,
          conflictPath: meta?.conflictPath ?? null,
          kind: meta?.kind ?? 'both-modified',
        });
      }
    }

    return { locks, stagedIncoming, conflicts };
  }

  async formatStatusCard({ agent = null } = {}) {
    if (!this.config) await this.reloadConfig();
    const lines = ['### 《双机接力体检卡》'];
    const stepSyncLine = this.config.stepSyncEnabled === false
      ? '- **步级防断电快照（运行中每30秒）**：已关闭（仅在每轮对话结束时安全同步；可发 `/soul 开启30秒快照` 开启）'
      : '- **步级防断电快照（运行中每30秒）**：已开启（可发 `/soul 关闭30秒快照` 随时关掉）';

    if (!this.config.vaultDir) {
      lines.push('- **金库状态**：尚未配置防灾金库目录（请在左下角「设置 → Soul Sync 跨机迁移」完成连接配置）');
      lines.push(stepSyncLine);
      lines.push('- **抗失忆压缩**：已启用（第一人称母语 + Flash → V4Pro 视觉文字桥接）');
      return lines.join('\n');
    }

    const encLabel = this.vault?.encrypted
      ? '已开启 AES-256-GCM 端到端加密'
      : this.config.encryptionEnabled
        ? '加密已勾选但缺少本机 secret.key（待修复）'
        : '明文模式（未开启加密）';

    lines.push(`- **金库路径**：\`${this.config.vaultDir}\`（${encLabel}）`);
    lines.push(`- **本机身份**：${this.config.deviceLabel} (\`${this.config.deviceId}\` / ${this.platform})`);
    lines.push(`- **上次防灾备份**：${formatAgeSeconds(this._lastBackupAt)}`);
    lines.push(stepSyncLine);
    lines.push(
      `- **文件夹对应模式**：${this.config.folderMatchMode === 'mapped-only' ? '严格一一对应（仅同步已配对目录）' : '自动同名生成并对应（已配对优先，缺省自动生成独立同名工作区）'}`,
    );
    lines.push(
      `- **自动同步范围**：${this.config.syncScope === 'selected' ? `精选模式（已选 ${this.config.selectedWorkspaces.length} 个工作区 / ${this.config.selectedSessionIds.length} 条对话）` : `活跃对话智能同步（自动过滤空窗口，单工作区上限 ${this.config.quotas?.maxAutoSessionsPerWorkspace ?? DEFAULT_QUOTAS.maxAutoSessionsPerWorkspace} 条）`}`,
    );
    lines.push(`- **本机默认模型档位**：${formatModelTriple(this.defaultModelTriple)}`);

    let heartbeats = [];
    if (this.vault) {
      heartbeats = await this.vault.readHeartbeats();
    }

    const peers = heartbeats.filter((h) => h.deviceId !== this.config.deviceId);
    const batonHolder = heartbeats.find((h) => h.baton)?.baton;
    if (batonHolder) {
      const stateLabel = batonHolder.state === 'released-for-handoff'
        ? '已释放待接力 (released-for-handoff)'
        : '活跃持有 (active)';
      lines.push(`- **当前接力棒**：${batonHolder.holder || '本机'} — ${stateLabel}`);
    } else {
      lines.push(`- **当前接力棒**：${this._baton.holder || this.config.deviceLabel} — ${this._baton.state}`);
    }

    if (peers.length === 0) {
      lines.push('- **对端设备心跳**：暂无其他设备心跳记录');
    } else {
      lines.push('- **对端设备心跳**：');
      for (const peer of peers) {
        const peerAge = formatAgeSeconds(peer.updatedAt);
        const peerBaton = peer.baton?.state ? ` | 接力棒: ${peer.baton.state}` : '';
        lines.push(
          `  - ${peer.deviceLabel || peer.deviceId} (${peer.platform || '?'})：${peerAge} | 模型: ${formatModelTriple(peer.defaultModelTriple)}${peerBaton}`,
        );
      }
    }

    // Flash <-> V4Pro gentle model-tier comparison notice
    const localTier = normalizeModelTier(this.defaultModelTriple?.model);
    let sawFlashV4ProPair = false;
    for (const peer of peers) {
      const peerTier = normalizeModelTier(peer.defaultModelTriple?.model);
      if (
        (localTier === 'flash' && peerTier === 'v4pro')
        || (localTier === 'v4pro' && peerTier === 'flash')
      ) {
        sawFlashV4ProPair = true;
        break;
      }
    }
    if (sawFlashV4ProPair) {
      lines.push(
        '- **双端模型档位提示**：检测到双端默认模型档位不同（Flash 支持看图 / V4Pro 纯文本深度推理），已启用视觉文字桥接保护，可放心按需混用。',
      );
    }

    const activeCwd = agent?.session?.cwd ?? agent?.session?.header?.cwd ?? null;
    const health = await this._collectWorkspaceHealth(activeCwd);

    if (health.locks.length > 0) {
      const lockList = health.locks.map((l) => `\`${l.lockPath}\``).join('、');
      lines.push(`- **⚠️ Office 占锁预警**：检测到未关闭的 Office 锁文件（${lockList}），换机前请先 Ctrl+S 保存并关闭 Excel！`);
    } else {
      lines.push('- **Office 占锁检查**：正常（未检测到 `~$*.xlsx` 锁文件）');
    }

    if (health.stagedIncoming.length > 0) {
      const stagedList = health.stagedIncoming.map((s) => `\`${s.path}\``).join('、');
      lines.push(`- **待落位文件（\`.dsh-incoming/\`）**：${stagedList}（关闭占锁软件后运行 \`/soul pull\` 自动落位）`);
    }

    if (health.conflicts.length > 0) {
      const conflictList = health.conflicts
        .map((c) => (c.conflictPath ? `\`${c.conflictPath}\`` : c.key))
        .join('、');
      lines.push(`- **历史冲突副本**：${conflictList}`);
    }

    if (this._pendingAlerts.length > 0) {
      lines.push(`- **未读同步提醒（${this._pendingAlerts.length} 条）**：${this._pendingAlerts.slice(-3).map((a) => a.text).join('；')}`);
    }

    if (this._startupErrors.length > 0) {
      lines.push(`- **异常提示**：${this._startupErrors.join('；')}`);
    }

    return lines.join('\n');
  }

  async handleHandoff({ agent = null, extraNote = '' } = {}) {
    if (!this.config) await this.reloadConfig();

    const activeCwd = agent?.session?.cwd ?? agent?.session?.header?.cwd ?? null;
    const sessionId = agent?.session?.id ?? agent?.session?.header?.id ?? null;
    const health = await this._collectWorkspaceHealth(activeCwd);

    const noticeLines = [];
    if (health.locks.length > 0) {
      const lockList = health.locks.map((l) => `\`${l.lockPath}\``).join('、');
      noticeLines.push(`⚠️ 检测到当前工作区存在未关闭的 Excel/Office 锁文件（${lockList}），请务必先 Ctrl+S 保存并关闭 Excel，避免表格未落盘或锁冲突！`);
    }

    const batonPayload = {
      state: 'released-for-handoff',
      holder: this.config.deviceLabel || this.config.deviceId,
      sessionId,
      ...(extraNote && !this.config.encryptionEnabled ? { note: extraNote } : {}),
      releasedAt: Date.now(),
    };

    const hasSteerRoute = Boolean(
      agent && (typeof agent.steer === 'function' || typeof agent.inbox?.append === 'function'),
    );

    if (hasSteerRoute) {
      if (sessionId) {
        this._pendingHandoffSessions.add(sessionId);
      }
      const promptText = buildHandoffPrompt(extraNote);
      const userMsg = await createPersistentUserMessage(promptText);
      if (typeof agent.steer === 'function') {
        await agent.steer(userMsg);
      } else {
        await agent.inbox.append('prompt', userMsg);
      }
      await this.updateHeartbeat({ status: 'handoff-ready', baton: batonPayload });
      noticeLines.push('已触发第一人称《中场交接心路日记》生成；本轮回复结束后将自动全量备份会话与产出物，并保持接力棒处于 `released-for-handoff` 状态。');
    } else {
      if (this.vault) {
        await this.pushAll({ agent });
        await this.updateHeartbeat({ status: 'handoff-ready', baton: batonPayload });
      }
      noticeLines.push('当前无活跃对话路由，已立即执行全量防灾推送并释放接力棒（`released-for-handoff`），可安心换机。');
    }

    return { kind: 'success', text: noticeLines.join('\n') };
  }

  async handleKeep({ agent = null, rawTarget = '' } = {}) {
    const target = rawTarget.trim().replace(/^["']|["']$/g, '');
    if (!target) {
      return { kind: 'error', text: '用法：`/soul keep <相对路径或绝对路径>`' };
    }
    if (!this.config) await this.reloadConfig();

    const activeCwd = agent?.session?.cwd ?? agent?.session?.header?.cwd ?? null;
    let matched = this._matchWorkspaceForPath(target);
    let resolvedTarget = target;

    if (!matched && activeCwd) {
      matched = this._matchWorkspaceForPath(activeCwd);
      if (matched) {
        resolvedTarget = path.isAbsolute(target) ? target : path.resolve(matched.localRoot, target);
      }
    }
    if (!matched && this.config.workspaceMappings.length === 1) {
      const only = this.config.workspaceMappings[0];
      const localRoot = only[this.platform];
      if (localRoot) {
        matched = { mapping: only, localRoot };
        resolvedTarget = path.isAbsolute(target) ? target : path.resolve(localRoot, target);
      }
    }

    if (!matched) {
      return { kind: 'error', text: `路径 \`${target}\` 不在任何已映射的工作区内，请先确认工作区映射配置。` };
    }

    const rec = await recordDeliverableCandidate(
      this.dshHome,
      matched.mapping.id,
      matched.localRoot,
      resolvedTarget,
      'manual',
    );
    if (!rec.recorded) {
      return { kind: 'error', text: `无法将 \`${target}\` 加入产出账本（原因：${rec.reason}）。` };
    }

    let pushSummary = '（尚未配置金库，已先记入本地产出账本）';
    if (this.vault) {
      const pushRes = await pushWorkspaceDeliverables({
        dshHome: this.dshHome,
        vault: this.vault,
        workspaceId: matched.mapping.id,
        workspaceRoot: matched.localRoot,
        deviceLabel: this.config.deviceLabel,
        minQuietMs: this.minQuietMs,
        quotas: this.config.quotas,
      });
      this._lastBackupAt = Date.now();
      await this.updateHeartbeat({ status: 'active' });
      const blockedItem = pushRes.blocked.find((b) => b.path === rec.relativePath);
      const deferredItem = pushRes.deferred.find((d) => d.path === rec.relativePath);
      if (blockedItem) {
        pushSummary = `但本次校验被拦截（原因：${blockedItem.reason}）`;
      } else if (deferredItem) {
        pushSummary = `但文件正在写入中已延后重试（原因：${deferredItem.reason}）`;
      } else {
        pushSummary = '并已立即加密同步至防灾金库。';
      }
    }

    return {
      kind: 'success',
      text: `已将 \`${rec.relativePath}\` 手动纳管至工作区「${matched.mapping.title || matched.mapping.id}」产出账本，${pushSummary}`,
    };
  }

  async handleConfig({ argsText = '' } = {}) {
    if (!this.config) await this.reloadConfig();
    const trimmed = argsText.trim();

    if (!trimmed) {
      const q = this.config.quotas;
      return {
        kind: 'success',
        text: [
          '### Soul Sync 当前配置',
          `- \`vaultDir\`: ${this.config.vaultDir || '(未配置)'}`,
          `- \`encryptionEnabled\`: ${this.config.encryptionEnabled}`,
          `- \`stepSyncEnabled\`: ${this.config.stepSyncEnabled !== false}`,
          `- \`folderMatchMode\`: ${this.config.folderMatchMode}`,
          `- \`syncScope\`: ${this.config.syncScope}`,
          `- \`autoMirrorRoot\`: ${this.config.autoMirrorRoot || '(默认 ~/Documents/deepseek-harness/workspaces)'}`,
          `- \`deviceLabel\`: ${this.config.deviceLabel}`,
          `- \`maxFileMB\`: ${(q.maxFileBytes / (1024 * 1024)).toFixed(1)} MB`,
          `- \`maxWorkspaceMB\`: ${(q.maxWorkspaceBytes / (1024 * 1024)).toFixed(1)} MB`,
          `- \`retainSnapshots\`: ${q.retainSnapshots}`,
          `- \`stepSyncIntervalMs\`: ${q.stepSyncIntervalMs} ms`,
          `- \`trashRetentionDays\`: ${q.trashRetentionDays} 天`,
          `- \`maxAutoSessionsPerWorkspace\`: ${q.maxAutoSessionsPerWorkspace ?? DEFAULT_QUOTAS.maxAutoSessionsPerWorkspace}`,
          '',
          '修改示例：`/soul config maxFileMB=50 folderMatchMode=mapped-only syncScope=selected stepSync=off`',
        ].join('\n'),
      };
    }

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const quotaPatch = {};
    const topPatch = {};
    let passphraseArg = undefined;
    let clearPassphraseArg = false;

    for (const token of tokens) {
      const eqIdx = token.indexOf('=');
      if (eqIdx <= 0) {
        return { kind: 'error', text: `无效配置项 \`${token}\`，请使用 \`key=value\` 格式。` };
      }
      const key = token.slice(0, eqIdx).trim();
      const rawVal = token.slice(eqIdx + 1).trim();

      if (key === 'stepSync' || key === 'stepSyncEnabled') {
        const parsedBool = parseBooleanToggle(rawVal);
        if (parsedBool === null) {
          return {
            kind: 'error',
            text: `配置项 \`${key}\` 仅支持 on/off/true/false/1/0，当前收到 \`${rawVal}\`。`,
          };
        }
        topPatch.stepSyncEnabled = parsedBool;
        continue;
      }

      if (key === 'deviceLabel') {
        if (!rawVal) return { kind: 'error', text: '`deviceLabel` 不能为空。' };
        topPatch.deviceLabel = rawVal;
        continue;
      }

      if (key === 'vaultDir') {
        const cleanedVault = stripOuterQuotes(rawVal);
        if (!cleanedVault) return { kind: 'error', text: '`vaultDir` 不能为空。' };
        topPatch.vaultDir = cleanedVault;
        continue;
      }

      if (key === 'passphrase') {
        if (!rawVal) {
          clearPassphraseArg = true;
          passphraseArg = undefined;
        } else {
          passphraseArg = rawVal;
          clearPassphraseArg = false;
        }
        continue;
      }

      if (key === 'fallbackDir') {
        const expanded = rawVal ? expandPosixHome(rawVal, this.platform) : '';
        topPatch.fallbackDir = expanded ? path.resolve(expanded) : '';
        continue;
      }

      if (key === 'autoMirrorRoot') {
        const expanded = rawVal ? expandPosixHome(rawVal, this.platform) : '';
        topPatch.autoMirrorRoot = expanded ? path.resolve(expanded) : '';
        continue;
      }

      if (key === 'folderMatchMode' || key === 'mode') {
        const norm = rawVal.toLowerCase();
        const mappedMode = norm === 'auto' ? 'auto-mirror' : norm === 'mapped' ? 'mapped-only' : norm;
        if (!VALID_FOLDER_MATCH_MODES.includes(mappedMode)) {
          return { kind: 'error', text: '`folderMatchMode` 仅支持 auto-mirror / mapped-only（或 auto / mapped）。' };
        }
        topPatch.folderMatchMode = mappedMode;
        continue;
      }

      if (key === 'syncScope' || key === 'scope') {
        const norm = rawVal.toLowerCase();
        if (!VALID_SYNC_SCOPES.includes(norm)) {
          return { kind: 'error', text: '`syncScope` 仅支持 active / selected。' };
        }
        topPatch.syncScope = norm;
        continue;
      }

      const num = Number(rawVal);
      if (!Number.isFinite(num) || num <= 0) {
        return { kind: 'error', text: `配置项 \`${key}\` 必须为正数，当前收到 \`${rawVal}\`。` };
      }

      switch (key) {
        case 'maxFileMB':
          quotaPatch.maxFileBytes = Math.round(num * 1024 * 1024);
          break;
        case 'maxWorkspaceMB':
          quotaPatch.maxWorkspaceBytes = Math.round(num * 1024 * 1024);
          break;
        case 'retainSnapshots':
          if (!Number.isInteger(num)) {
            return { kind: 'error', text: '`retainSnapshots` 必须为正整数。' };
          }
          quotaPatch.retainSnapshots = num;
          break;
        case 'stepSyncIntervalMs':
          quotaPatch.stepSyncIntervalMs = Math.round(num);
          break;
        case 'stepSyncSeconds':
          quotaPatch.stepSyncIntervalMs = Math.round(num * 1000);
          break;
        case 'trashRetentionDays':
          quotaPatch.trashRetentionDays = Math.round(num);
          break;
        case 'maxAutoSessionsPerWorkspace':
          if (!Number.isInteger(num)) {
            return { kind: 'error', text: '`maxAutoSessionsPerWorkspace` 必须为正整数。' };
          }
          quotaPatch.maxAutoSessionsPerWorkspace = num;
          break;
        default:
          return {
            kind: 'error',
            text: `不支持的配置项 \`${key}\`。支持：stepSync, stepSyncEnabled, folderMatchMode, mode, syncScope, scope, passphrase, maxFileMB, maxWorkspaceMB, retainSnapshots, maxAutoSessionsPerWorkspace, stepSyncIntervalMs, stepSyncSeconds, trashRetentionDays, deviceLabel, vaultDir, fallbackDir, autoMirrorRoot`,
          };
      }
    }

    // P2-3 & CHK5A-3: Route all non-quota config updates (`passphrase`, `vaultDir`, `syncScope`/`scope`,
    // `folderMatchMode`/`mode`, `stepSyncEnabled`, `deviceLabel`, `autoMirrorRoot`) through `updateSettings`
    // so `/soul config` and `dsh-soul config` get the exact same C2 guard, LWW withdrawal restoration, and re-sync!
    let settingsResult = null;
    const settingsPatch = { ...topPatch };
    delete settingsPatch.fallbackDir;
    if (passphraseArg !== undefined) settingsPatch.passphrase = passphraseArg;
    if (clearPassphraseArg) settingsPatch.clearPassphrase = true;

    if (Object.keys(quotaPatch).length > 0 || topPatch.fallbackDir !== undefined) {
      await saveConfig(this.dshHome, {
        ...(topPatch.fallbackDir !== undefined ? { fallbackDir: topPatch.fallbackDir } : {}),
        ...(Object.keys(quotaPatch).length > 0 ? { quotas: quotaPatch } : {}),
      });
      await this.reloadConfig();
    }
    if (Object.keys(settingsPatch).length > 0) {
      settingsResult = await this.updateSettings(settingsPatch);
      if (settingsResult?.requiresKeyRotationConfirm) {
        return { kind: 'error', text: settingsResult.warning || '口令校验未通过，未覆盖本地密钥。' };
      }
    }

    const updated = this.config;
    return {
      kind: 'success',
      text: `配置已更新：stepSyncEnabled=${updated.stepSyncEnabled}, maxFileMB=${(updated.quotas.maxFileBytes / (1024 * 1024)).toFixed(1)}MB, maxWorkspaceMB=${(updated.quotas.maxWorkspaceBytes / (1024 * 1024)).toFixed(1)}MB, retainSnapshots=${updated.quotas.retainSnapshots}, stepSyncIntervalMs=${updated.quotas.stepSyncIntervalMs}ms`,
    };
  }

  async handleSetStepSync({ enabled }) {
    if (!this.config) await this.reloadConfig();
    const nextEnabled = Boolean(enabled);
    await saveConfig(this.dshHome, { stepSyncEnabled: nextEnabled });
    await this.reloadConfig();
    if (nextEnabled) {
      return {
        kind: 'success',
        text: '已开启「运行中每 30 秒步级防断电快照」：长任务运行期间将按节流自动保护进度；如需关闭随时发送 `/soul 关闭30秒快照`。',
      };
    }
    return {
      kind: 'success',
      text: '已关闭「运行中每 30 秒步级防断电快照」：任务执行过程中不再做步级备份，但每轮对话结束后的双平面防灾同步（会话 + 产出物）仍 100% 正常工作；如需重新开启随时发送 `/soul 开启30秒快照`。',
    };
  }

  async handleAddMapping({ winPath, macPath, triggerPull = true }) {
    if (!this.config) await this.reloadConfig();
    let cleanWin = stripOuterQuotes(winPath).normalize('NFC');
    let cleanMac = stripOuterQuotes(macPath).normalize('NFC');
    if (!cleanWin || !cleanMac) {
      return { kind: 'error', text: '绑定工作区映射需要同时提供 Windows 路径和 macOS 路径。' };
    }

    const isWinFmt = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
    const isPosixFmt = (p) => p.startsWith('/');

    if (isPosixFmt(cleanWin) && isWinFmt(cleanMac)) {
      return { kind: 'error', text: '看起来把 Windows 路径和 macOS 路径填反了，请交换后重试。' };
    }

    const winVal = validateWorkspaceDirectory(cleanWin, 'win32', {
      dshHome: this.platform === 'win32' ? this.dshHome : undefined,
      vaultDir: this.platform === 'win32' ? this.config.vaultDir : undefined,
    });
    if (!winVal.ok) {
      return { kind: 'error', text: winVal.error };
    }
    cleanWin = winVal.normalizedPath;

    const macVal = validateWorkspaceDirectory(cleanMac, 'darwin', {
      dshHome: this.platform !== 'win32' ? this.dshHome : undefined,
      vaultDir: this.platform !== 'win32' ? this.config.vaultDir : undefined,
    });
    if (!macVal.ok) {
      return { kind: 'error', text: macVal.error };
    }
    cleanMac = macVal.normalizedPath;

    const normCmp = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

    const baseName = (p) => {
      const s = String(p).replace(/[\\/]+$/, '');
      const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return (idx >= 0 ? s.slice(idx + 1) : s).normalize('NFC');
    };
    const title = baseName(cleanWin) || baseName(cleanMac) || 'workspace';
    const baseSafeId = deriveWorkspaceId(cleanWin, cleanMac);

    const existing = [...(this.config.workspaceMappings ?? [])];
    // Match ONLY by same actual path (never silently overwrite a different folder sharing the same basename!)
    const matchIdx = existing.findIndex(
      (m) =>
        (m.win32 && normCmp(m.win32) === normCmp(cleanWin))
        || (m.darwin && normCmp(m.darwin) === normCmp(cleanMac)),
    );

    const now = Date.now();
    let savedEntry;
    if (matchIdx !== -1) {
      savedEntry = { ...existing[matchIdx], win32: cleanWin, darwin: cleanMac, updatedAt: now };
      existing[matchIdx] = savedEntry;
    } else {
      let finalId = baseSafeId;
      if (existing.some((m) => m.id === finalId)) {
        const hash4 = crypto.createHash('sha256').update(`${normCmp(cleanWin)}::${normCmp(cleanMac)}`).digest('hex').slice(0, 4);
        finalId = `${baseSafeId}-${hash4}`;
      }
      savedEntry = { id: finalId, title, win32: cleanWin, darwin: cleanMac, updatedAt: now };
      existing.push(savedEntry);
    }

    // Clear deletion tombstone if this id was previously removed
    const nextDeleted = { ...(this.config.deletedMappingIds ?? {}) };
    delete nextDeleted[savedEntry.id];

    // Opus g23 #10: Identify any auto-mirror folder whose sourceCwd matches this newly bound mapping
    // so local-origin sessions sitting in that mirror folder are ALSO re-homed to the mapped directory!
    const localTargetDir = savedEntry[this.platform] || '';
    const peerSourcesToCheck = [savedEntry.win32, savedEntry.darwin, savedEntry.linux].filter(Boolean);
    const mirrorDirsToRehome = new Set();
    const nextMirrorAssignments = { ...(this.config.autoMirrorAssignments ?? {}) };
    let mirrorAssignmentsChanged = false;
    for (const [srcCwd, mirrorDir] of Object.entries(nextMirrorAssignments)) {
      if (!mirrorDir) continue;
      if (peerSourcesToCheck.some((p) => normCmp(p) === normCmp(srcCwd))) {
        if (localTargetDir && normCmp(mirrorDir) !== normCmp(localTargetDir)) {
          mirrorDirsToRehome.add(mirrorDir);
        }
        delete nextMirrorAssignments[srcCwd];
        mirrorAssignmentsChanged = true;
      }
    }

    await saveConfig(this.dshHome, {
      workspaceMappings: existing,
      deletedMappingIds: nextDeleted,
      ...(mirrorAssignmentsChanged ? { autoMirrorAssignments: nextMirrorAssignments } : {}),
    });
    await this.reloadConfig();
    this._seenRemoteCommitFiles.clear();

    const warnings = [];
    if (localTargetDir && mirrorDirsToRehome.size > 0) {
      const cordisAdapter = this._buildCordisAdapter();
      for (const oldMirrorDir of mirrorDirsToRehome) {
        const rehomeRes = await rehomeLocalSessionsInWorkspace({
          dshHome: this.dshHome,
          fromCwd: oldMirrorDir,
          toCwd: localTargetDir,
          workspaceMappings: this.config.workspaceMappings,
          targetPlatform: this.platform,
          cordisCtx: cordisAdapter,
        });
        if (rehomeRes.errors.length > 0) {
          warnings.push(`部分镜像会话迁回失败：${rehomeRes.errors.map((e) => `${e.sessionId}(${e.error})`).join('、')}`);
        }
        if (rehomeRes.deferredBusy.length > 0) {
          for (const sid of rehomeRes.deferredBusy) this._deferredBusySessions.add(sid);
          warnings.push(`有 ${rehomeRes.deferredBusy.length} 个会话正在生成中，本轮结束后将自动迁回新映射目录`);
        }
      }
    }

    if (this.vault) {
      await this.syncGlobalWorkspaceMetadata({ publishLocal: true }).catch((err) => {
        warnings.push(`全局映射同步金库失败：${err instanceof Error ? err.message : String(err)}`);
      });
      if (triggerPull && !this._disposed) {
        try {
          await this.pullAll({ silent: true });
        } catch (err) {
          warnings.push(`绑定后自动迁回拉取遇到异常（可稍后点击「立即双向同步」重试）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const baseText = `已绑定跨系统工作区映射并立即生效（已同步至金库供对端自动接收）：\n- [${savedEntry.id}] Win=\`${savedEntry.win32}\` ⇄ Mac=\`${savedEntry.darwin}\``;
    return {
      kind: 'success',
      text: warnings.length > 0 ? `${baseText}\n⚠️ ${warnings.join('；')}` : baseText,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async handleCompact({ agent = null, keepTurns = 3, signal = undefined } = {}) {
    if (!this.config) await this.reloadConfig();
    const res = await compactSessionPreservingTail({
      ctx: this.ctx,
      agent,
      session: agent?.session ?? null,
      keepTurns,
      signal,
      defaultModelTriple: this.defaultModelTriple,
    });

    if (res.status === 'noop') {
      return { kind: 'success', text: res.message };
    }
    if (res.status === 'busy' || res.status === 'degraded' || res.status === 'error') {
      return { kind: 'error', text: res.message };
    }

    let vaultSyncNote = '（尚未配置防灾金库，已落盘本地会话）';
    if (this.vault && agent?.session) {
      try {
        const expRes = await this._exportSessionSafely(agent.session, { allowFlush: false });
        if (expRes && !expRes.deferred) {
          await this.updateHeartbeat({ status: 'active' });
          vaultSyncNote = this.vault.encrypted
            ? '，并已同步至端到端加密防灾金库。'
            : '，并已同步至防灾金库。';
        }
      } catch {
        vaultSyncNote = '（本地压缩已落盘，金库后台备份稍后自动重试）。';
      }
    }

    return {
      kind: 'success',
      text:
        `保尾无损压缩完成（第 ${res.generation} 代）：折叠早期 ${res.shadowedCount} 条历史节点（~${res.shadowedTokenCount} → ~${res.framedSummaryTokenCount} tokens），完整保留末尾 ${res.keptTurns} 轮原装对话与原生思维链${vaultSyncNote}`
        + '\n如需回溯更早细节，模型可直接调用 `soul_recall_history` 检索底稿。',
    };
  }

  async handleSetMode({ mode, rawArg = '' } = {}) {
    if (!this.config) await this.reloadConfig();
    if (!mode || !VALID_FOLDER_MATCH_MODES.includes(mode)) {
      return {
        kind: 'error',
        text: `用法：\`/soul mode auto\`（自动同名生成并对应）或 \`/soul mode mapped\`（严格仅同步手动一一对应目录）。${rawArg ? `当前输入：\`${rawArg}\`` : ''}`,
      };
    }
    await this.updateSettings({ folderMatchMode: mode });
    if (mode === 'mapped-only') {
      return {
        kind: 'success',
        text: '已切换为「严格一一对应模式（`mapped-only`）」：自动拉取与推送仅处理已配好 `workspaceMappings` 一一对应关系的文件夹，不会在其他位置自动新建目录。',
      };
    }
    return {
      kind: 'success',
      text: '已切换为「自动同名生成并对应模式（`auto-mirror`）」：已配对目录走一一对应，未配对目录自动匹配同名工作区或在 `~/Documents/deepseek-harness/workspaces/<项目名>` 创建独立同名工作区。',
    };
  }

  async handleSetScope({ scope, rawArg = '' } = {}) {
    if (!this.config) await this.reloadConfig();
    if (!scope || !VALID_SYNC_SCOPES.includes(scope)) {
      return {
        kind: 'error',
        text: `用法：\`/soul scope active\`（自动同步活跃对话，过滤空窗口）或 \`/soul scope selected\`（精选模式，仅同步已勾选的工作区与对话）。${rawArg ? `当前输入：\`${rawArg}\`` : ''}`,
      };
    }
    await this.updateSettings({ syncScope: scope });
    if (scope === 'selected') {
      return {
        kind: 'success',
        text: `已切换为「精选白名单同步模式（\`selected\`）」：仅同步已勾选的 ${this.config.selectedWorkspaces.length} 个工作区与 ${this.config.selectedSessionIds.length} 条对话，其余对话 100% 留在单机本地（可在「设置 → Soul Sync 跨机迁移」图形面板勾选）。`,
      };
    }
    return {
      kind: 'success',
      text: '已切换为「活跃对话智能同步模式（`active`）」：自动同步非空活跃对话（自动过滤 0 轮空窗口）。',
    };
  }

  async handleListCatalog() {
    if (!this.config) await this.reloadConfig();
    const [localCat, vaultCat] = await Promise.all([
      this.listLocalCatalog(),
      this.listVaultCatalog(),
    ]);

    const lines = [
      '### 《跨机迁移工作区与对话清单》',
      `- **当前模式**：${this.config.folderMatchMode === 'mapped-only' ? '严格一一对应 (`mapped-only`)' : '自动同名生成 (`auto-mirror`)'} | 范围：${this.config.syncScope === 'selected' ? '精选白名单 (`selected`)' : '活跃自动 (`active`)'}`,
      '',
      `#### 📤 本机可推送工作区（共 ${localCat.workspaces.length} 个工作区 / ${localCat.totalSessions} 条有效对话，已自动过滤 ${localCat.filteredEmptyCount} 个空窗口）`,
    ];

    let localIdx = 0;
    if (localCat.workspaces.length === 0) {
      lines.push('- （本机暂无非空对话）');
    } else {
      for (const ws of localCat.workspaces) {
        const mapTag = ws.isVaultDir
          ? '🏦 当前防灾金库目录（非项目工作区）'
          : ws.mappingId
            ? `🔗 已对应 \`${ws.mappingId}\`${ws.mappedPeerPath ? ` ⇄ \`${ws.mappedPeerPath}\`` : ''}`
            : '✨ 未手动对应';
        lines.push(`- **${ws.title}**（\`${ws.path || '无目录'}\` | ${mapTag} | ${ws.sessionCount} 条对话）`);
        for (const s of ws.sessions.slice(0, 8)) {
          localIdx += 1;
          lines.push(`  - \`#${localIdx}\` [\`${s.shortId}\`] ${s.title}（${s.turnCount} 轮）`);
        }
        if (ws.sessions.length > 8) {
          lines.push(`  - ... 其余 ${ws.sessions.length - 8} 条可在「设置 → Soul Sync 跨机迁移」面板查看`);
        }
      }
    }

    lines.push('');
    lines.push(`#### 📥 金库可拉取工作区（共 ${vaultCat.workspaces.length} 个远端工作区 / ${vaultCat.totalSessions} 条对话）`);
    let vaultIdx = 0;
    if (!this.vault) {
      lines.push('- （尚未配置金库 `vaultDir`）');
    } else if (vaultCat.workspaces.length === 0) {
      lines.push('- （金库中暂无来自其他设备的对话）');
    } else {
      const statusLabel = {
        new: '新对话',
        behind: '有新回复',
        'up-to-date': '已最新',
        diverged: '双端分叉',
      };
      const matchLabel = {
        mapped: '🔗 已对应',
        'same-name': '📁 同名匹配',
        'auto-create': '✨ 自动新建',
        'unmapped-skipped': '⏭️ 未对应(自动跳过)',
      };
      for (const ws of vaultCat.workspaces) {
        const preview = ws.targetPreviewPath ? `→ \`${ws.targetPreviewPath}\`` : '→ (跳过)';
        lines.push(
          `- **${ws.sourceTitle}**（来自 ${ws.fromDeviceLabel} | ${matchLabel[ws.targetMatchKind] || ws.targetMatchKind} ${preview}）`,
        );
        for (const s of ws.sessions.slice(0, 8)) {
          vaultIdx += 1;
          lines.push(`  - \`#${vaultIdx}\` [\`${s.shortId}\`] ${s.title}（${statusLabel[s.localStatus] || s.localStatus}）`);
        }
        if (ws.sessions.length > 8) {
          lines.push(`  - ... 其余 ${ws.sessions.length - 8} 条可在「设置 → Soul Sync 跨机迁移」面板查看`);
        }
      }
    }

    lines.push('');
    lines.push('提示：可用 `/soul push <工作区名或短ID或#编号>` / `/soul pull <工作区名或短ID或#编号>` 按需迁移，或在左下角 **「设置 → Soul Sync 跨机迁移」** 可视化勾选。');
    return { kind: 'success', text: lines.join('\n') };
  }

  _resolveCatalogTargets(catalog, tokens = [], isVault = false) {
    const workspaceSelectors = [];
    const sessionIds = [];
    const flatSessions = [];
    for (const ws of catalog.workspaces ?? []) {
      for (const s of ws.sessions ?? []) {
        flatSessions.push({ ws, session: s });
      }
    }

    for (const rawTok of tokens) {
      const tok = String(rawTok ?? '').trim();
      if (!tok) continue;
      const lower = tok.toLowerCase();

      // 1. #index reference
      const numMatch = /^#(\d+)$/.exec(tok);
      if (numMatch) {
        const idx = Number.parseInt(numMatch[1], 10) - 1;
        if (idx >= 0 && idx < flatSessions.length) {
          sessionIds.push(flatSessions[idx].session.sessionId);
          continue;
        }
      }

      // 2. Exact workspace path, title, or mappingId match
      const wsMatch = (catalog.workspaces ?? []).find((ws) => {
        const wsTitle = (isVault ? ws.sourceTitle : ws.title) || '';
        const wsPath = (isVault ? ws.sourceCwd : ws.path) || '';
        return (
          wsTitle.toLowerCase() === lower
          || (ws.mappingId && ws.mappingId.toLowerCase() === lower)
          || (wsPath && wsPath.replace(/\\/g, '/').toLowerCase() === tok.replace(/\\/g, '/').toLowerCase())
        );
      });
      if (wsMatch) {
        const key = isVault ? wsMatch.sourceCwd : wsMatch.path;
        if (key) workspaceSelectors.push(key);
        continue;
      }

      // 3. Exact sessionId or shortId prefix match
      const sessMatches = flatSessions.filter(({ session }) =>
        session.sessionId.toLowerCase() === lower
        || session.shortId.toLowerCase() === lower
        || session.sessionId.toLowerCase().startsWith(lower),
      );
      if (sessMatches.length > 0) {
        for (const m of sessMatches) sessionIds.push(m.session.sessionId);
        continue;
      }

      // 4. Title keyword match
      const titleMatches = flatSessions.filter(({ session }) =>
        String(session.title ?? '').toLowerCase().includes(lower),
      );
      if (titleMatches.length > 0) {
        for (const m of titleMatches) sessionIds.push(m.session.sessionId);
      }
    }

    return {
      workspaceSelectors: [...new Set(workspaceSelectors)],
      sessionIds: [...new Set(sessionIds)],
    };
  }

  async handleSelectivePush({ targets = [] } = {}) {
    if (!this.config) await this.reloadConfig();
    if (!this.vault) {
      return { kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请先在「设置 → Soul Sync 跨机迁移」填写金库路径或运行 `dsh-soul init`。' };
    }
    const localCat = await this.listLocalCatalog();
    const resolved = this._resolveCatalogTargets(localCat, targets, false);
    if (resolved.workspaceSelectors.length === 0 && resolved.sessionIds.length === 0) {
      return {
        kind: 'error',
        text: `未在本机对话清单中匹配到「${targets.join(' ')}」，请先执行 \`/soul list\` 查看可用工作区名、短 ID 或 \`#编号\`。`,
      };
    }
    const res = await this.pushSelected({
      workspacePaths: resolved.workspaceSelectors,
      sessionIds: resolved.sessionIds,
    });
    if (!res.ok) {
      return { kind: 'error', text: `选择性推送失败：${res.reason}` };
    }
    const uploaded = res.workspaces.reduce((acc, w) => acc + w.uploaded.length, 0);
    const uploadVerb = this.vault.encrypted ? '已加密上传' : '已上传（明文模式）';
    const lines = [`选择性推送完成：${uploadVerb} ${res.sessionPushedCount} 条指定对话记录（工作区产出上传 ${uploaded} 个）。`];
    if (Array.isArray(res.skippedOutputs) && res.skippedOutputs.length > 0) {
      lines.push(`⚠️ 有 ${res.skippedOutputs.length} 个未映射工作区 outputs 文件被跳过（超限或含敏感信息）：${res.skippedOutputs.slice(0, 3).map((o) => `\`${o.path}\`(${o.reason})`).join('、')}`);
    }
    return {
      kind: 'success',
      text: lines.join('\n'),
    };
  }

  async handleSelectivePull({ targets = [], targetDir = '' } = {}) {
    if (!this.config) await this.reloadConfig();
    if (!this.vault) {
      return { kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请先在「设置 → Soul Sync 跨机迁移」填写金库路径或运行 `dsh-soul init`。' };
    }
    const vaultCat = await this.listVaultCatalog();
    const resolved = this._resolveCatalogTargets(vaultCat, targets, true);
    if (resolved.workspaceSelectors.length === 0 && resolved.sessionIds.length === 0) {
      return {
        kind: 'error',
        text: `未在金库清单中匹配到「${targets.join(' ')}」，请先执行 \`/soul list\` 查看远端工作区名、短 ID 或 \`#编号\`。`,
      };
    }

    const targetOverrides = {};
    const cleanTargetDir = targetDir ? expandPosixHome(targetDir.trim(), this.platform).normalize('NFC') : '';
    if (cleanTargetDir) {
      for (const ws of resolved.workspaceSelectors) targetOverrides[ws] = cleanTargetDir;
      for (const sid of resolved.sessionIds) targetOverrides[sid] = cleanTargetDir;
    } else if (this.config.folderMatchMode === 'mapped-only') {
      // Explicit `/soul pull <target>` on an unmapped item in mapped-only mode defaults to auto-mirror
      // so the user gets their requested session landed cleanly with an explicit destination report!
      for (const ws of vaultCat.workspaces ?? []) {
        const wsHasUnmapped = ws.targetMatchKind === 'unmapped-skipped'
          || (ws.sessions ?? []).some((s) => s.targetMatchKind === 'unmapped-skipped');
        if (wsHasUnmapped && resolved.workspaceSelectors.includes(ws.sourceCwd)) {
          targetOverrides[ws.sourceCwd] = AUTO_MIRROR_SENTINEL;
        }
        for (const s of ws.sessions ?? []) {
          if (s.targetMatchKind === 'unmapped-skipped' && resolved.sessionIds.includes(s.sessionId)) {
            targetOverrides[s.sessionId] = AUTO_MIRROR_SENTINEL;
          }
        }
      }
    }

    const res = await this.pullSelected({
      workspaceSources: resolved.workspaceSelectors,
      sessionIds: resolved.sessionIds,
      targetOverrides,
    });
    if (!res.ok) {
      return { kind: 'error', text: `选择性拉取失败：${res.reason}` };
    }
    const s = res.sessions.summary;
    const applied = res.workspaces.reduce((acc, w) => acc + w.applied.length, 0);
    const landed = (res.sessions.results ?? [])
      .filter((r) => (r.status === 'imported' || r.status === 'fast-forwarded' || r.status === 'migrated') && r.targetCwd)
      .map((r) => `\`${r.sessionId}\` → \`${r.targetCwd}\``);
    const lines = [
      `选择性拉取完成：会话新增 ${s.imported} / 快进 ${s.fastForwarded} / 分叉 ${s.forkedBranches} / 跳过未对应 ${s.skippedUnmapped ?? 0}；产出更新 ${applied} 个。`,
    ];
    if (landed.length > 0) {
      lines.push(`- 落位目录：${landed.slice(0, 5).join('、')}`);
    }
    return {
      kind: 'success',
      text: lines.join('\n'),
    };
  }

  async handleUnpublish({ targets = [] } = {}) {
    if (!this.config) await this.reloadConfig();
    if (!this.vault) {
      return { kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请先在「设置 → Soul Sync 跨机迁移」填写金库路径或运行 `dsh-soul init`。' };
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return { kind: 'error', text: '用法：`/soul unpublish <会话短ID或标题关键词>`（从金库撤回指定会话并加入本机屏蔽清单）。' };
    }
    const localCat = await this.listLocalCatalog();
    const vaultCat = await this.listVaultCatalog({ includeSelf: true });
    const resLocal = this._resolveCatalogTargets(localCat, targets, false);
    const resVault = this._resolveCatalogTargets(vaultCat, targets, true);
    const directIds = targets.filter((t) => typeof t === 'string' && t.length > 8 && !t.startsWith('#'));
    const sessionIds = [...new Set([...resLocal.sessionIds, ...resVault.sessionIds, ...directIds])];
    if (sessionIds.length === 0) {
      return { kind: 'error', text: `未匹配到要撤回的会话「${targets.join(' ')}」，请先执行 \`/soul list\` 查看会话 ID。` };
    }
    const res = await this.unpublishSessionFromVault({ sessionIds });
    if (!res.ok) {
      return { kind: 'error', text: `撤回失败：${res.reason}` };
    }
    return {
      kind: 'success',
      text: `已从金库撤回 ${sessionIds.length} 条会话（删除 ${res.removedCommits} 份提交、回收 ${res.prunedBlobs} 个历史快照块），并已加入本机屏蔽清单与全局撤回记录。`,
    };
  }

  formatHelpCard() {
    return [
      '### Soul Sync 速查指南（日常已每 15 秒后台自动静默同步，无需记命令）',
      '',
      '- **图形化跨机迁移与目录对应面板**：点击左下角 **「设置 → Soul Sync 跨机迁移」** 直接可视化切换模式与勾选迁移',
      '- **查看本机与金库工作区/对话清单**：`/soul list` 或 `/soul 看看有哪些对话可以迁移`',
      '- **按需选择性推送 / 拉取**：`/soul push <工作区名或短ID>` / `/soul pull <工作区名或短ID> [to <本机目录>]`',
      '- **从金库撤回指定会话**：`/soul unpublish <会话短ID或标题关键词>`（删除金库提交并加入屏蔽清单）',
      '- **切换文件夹对应模式**：`/soul mode auto`（自动同名生成） / `/soul mode mapped`（严格一一对应）',
      '- **切换同步范围**：`/soul scope active`（活跃自动过滤空窗口） / `/soul scope selected`（仅同步已勾选项）',
      '- **一键双向同步**：`/soul 同步`、`/soul 接力`、`/soul 刷新` 或 `/soul sync`',
      '- **看状态 / 查 Excel 锁**：`/soul`、`/soul 同步正常吗` 或 `/soul status`',
      '- **保尾无损压缩（不断魂）**：`/soul 帮我无损压缩一下` 或 `/soul compact [保留轮数]`',
      '- **下班换电脑写交接日记**：`/soul 我准备下班回家用Mac继续了` 或 `/soul handoff`',
      '- **把手工文件加进同步**：`/soul 帮我把 outputs/估值模型.xlsx 同步上` 或 `/soul keep <路径>`',
      '- **开关 30 秒防断电快照**：`/soul 关闭30秒快照` / `/soul 开启30秒快照`',
    ].join('\n');
  }

  async handleSync({ agent = null } = {}) {
    const pullRes = await this.pullAll({ silent: false });
    if (!pullRes.ok) {
      return { kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请在「设置 → Soul Sync 跨机迁移」填写金库路径或运行 `dsh-soul init`。' };
    }
    const pushRes = await this.pushAll({ agent });
    const s = pullRes.sessions.summary;
    const totalApplied = pullRes.workspaces.reduce((acc, w) => acc + w.applied.length, 0);
    const totalDrained = pullRes.workspaces.reduce((acc, w) => acc + w.drainedIncoming.length, 0);
    const totalConflicts = pullRes.workspaces.reduce((acc, w) => acc + w.conflicts.length, 0);
    const totalStaged = pullRes.workspaces.reduce((acc, w) => acc + w.stagedIncoming.length, 0);
    const uploaded = pushRes.ok ? pushRes.workspaces.reduce((acc, w) => acc + w.uploaded.length, 0) : 0;

    const touchedSessions = (pullRes.sessions.results ?? [])
      .filter((r) => r.status === 'imported' || r.status === 'fast-forwarded' || r.status === 'migrated')
      .map((r) => `\`${r.sessionId}\`（${r.status === 'imported' ? '新增' : r.status === 'migrated' ? '已归位到侧边栏' : '快进更新'}）`);

    const lines = [
      '### 双向同步完成',
      `- **拉取远端**：会话新增 ${s.imported} / 快进 ${s.fastForwarded} / 孤儿归位 ${s.migrated ?? 0} / 分叉 ${s.forkedBranches}；产出更新 ${totalApplied} 个（含 \`.dsh-incoming/\` 落位 ${totalDrained} 个），冲突 ${totalConflicts} 个。`,
      `- **推送本机**：同步会话 ${pushRes.ok ? pushRes.sessionPushedCount : 0} 个；产出上传 ${uploaded} 个。`,
    ];
    if (touchedSessions.length > 0) {
      lines.push(`- **最新就绪会话（已置顶至左侧边栏）**：${touchedSessions.slice(0, 5).join('、')}`);
    }
    if ((s.deferredBusy ?? 0) > 0) {
      lines.push(`- ⏳ 有 ${s.deferredBusy} 条会话正在生成回复中，已安全延后快进，待本轮结束后自动同步。`);
    }
    if (totalStaged > 0) {
      lines.push(`- ⚠️ 仍有 ${totalStaged} 个文件因本地占锁暂存于 \`.dsh-incoming/\`，关闭 Excel 后再发 \`/soul pull\` 即可自动落位。`);
    }
    if (Array.isArray(pushRes.deferredCompactionSessions) && pushRes.deferredCompactionSessions.length > 0) {
      lines.push(`- ⏳ 有 ${pushRes.deferredCompactionSessions.length} 个会话正在执行压缩事务，已自动延后上传。`);
    }
    return { kind: 'success', text: lines.join('\n') };
  }

  async _renderCardInBlankSession(agent, rawInput, cardText) {
    const session = agent?.session ?? null;
    if (!isBlankLiveSession(session) || !cardText) return false;
    // Never inject a synthetic turn if the agent is actively running
    if (agent?.phase && agent.phase.kind && agent.phase.kind !== 'idle') return false;
    const sessionId = session.id ?? session.header?.id ?? null;
    try {
      const trimmed = String(rawInput ?? '').trim();
      const cmdLine = trimmed ? `/soul ${trimmed}` : '/soul';
      // P1-4 / F10: Use dedicated non-human context source (`dsh-soul-sync-card`) so DSH renders the
      // card cleanly out of the blank welcome screen while countUserTurns === 0 & isSubstantiveSession === false!
      const userMsg = await createPersistentContextMessage(cmdLine, {
        kind: 'dsh-soul-sync-card',
        form: 'notice',
        summary: cmdLine,
        syntheticSoulCard: true,
      });
      const assistantMsg = await createPersistentAssistantMessage(cardText, this.defaultModelTriple);

      if (sessionId) this._syntheticTurnSessions.add(sessionId);
      try {
        // V4 lifecycle requires 1-based sequential turn & step indices and turn/end reason
        // (`dsh-session-format-v3-to-v4` & `dsh-client-ui-chat` reason.kind contract)
        session.append('turn/start', { turn: 1 });
        session.append('step/start', { turn: 1, step: 1 });
        session.append('user/message', userMsg, { surfaceOp: 'append' });
        session.append(
          'assistant/message',
          { turn: 1, step: 1, message: assistantMsg },
          { surfaceOp: 'append' },
        );
        session.append('step/end', { turn: 1, step: 1 });
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

        // Keep in-memory idle ReactLoopAgent turn counter aligned with session log so next prompt opens turn 2
        if (agent?.phase && typeof agent.phase === 'object' && agent.phase.kind === 'idle' && agent.phase.lastTurn === 0) {
          agent.phase.lastTurn = 1;
        }
      } finally {
        if (sessionId) this._syntheticTurnSessions.delete(sessionId);
      }
      return true;
    } catch {
      // Host validation rejected synthetic turn — cleanly fall back to standard command return
      return false;
    }
  }

  async handleSlashCommand({ agent = null, rawInput = '', signal = undefined } = {}) {
    const intent = parseNaturalSoulIntent(rawInput);

    const finish = async (res) => {
      if (BLANK_PAGE_CARD_INTENTS.has(intent.kind) && agent?.session && res?.text) {
        const rendered = await this._renderCardInBlankSession(agent, rawInput, res.text);
        if (rendered) {
          // Risk 1 / R8: Real DSH `dsh-commands` logs `command/done.text` which `GenericCommandCard` renders
          // as a multiline `<pre>` when `text` contains `\n`. Return a sleek 1-line summary (no `\n`) so
          // the blank page shows a compact command pill + the rich Markdown card below without duplication!
          const firstLine = String(res.text)
            .split(/\r?\n/)
            .map((l) => l.replace(/^#+\s*/, '').trim())
            .find((l) => l.length > 0) || 'Soul Sync 操作完成';
          return {
            ...res,
            text: `${firstLine}（详情已在下方卡片展开）`,
          };
        }
      }
      return res;
    };

    if (intent.kind === 'status') {
      const text = await this.formatStatusCard({ agent });
      return finish({ kind: 'success', text });
    }

    if (intent.kind === 'sync') {
      return finish(await this.handleSync({ agent }));
    }

    if (intent.kind === 'compact') {
      return this.handleCompact({ agent, keepTurns: intent.keepTurns, signal });
    }

    if (intent.kind === 'handoff') {
      return this.handleHandoff({ agent, extraNote: intent.extraNote });
    }

    if (intent.kind === 'list') {
      return finish(await this.handleListCatalog());
    }

    if (intent.kind === 'set-mode') {
      return finish(await this.handleSetMode({ mode: intent.mode, rawArg: intent.rawArg }));
    }

    if (intent.kind === 'set-scope') {
      return finish(await this.handleSetScope({ scope: intent.scope, rawArg: intent.rawArg }));
    }

    if (intent.kind === 'pull') {
      if (Array.isArray(intent.targets) && intent.targets.length > 0) {
        return finish(await this.handleSelectivePull({ targets: intent.targets, targetDir: intent.targetDir || '' }));
      }
      const res = await this.pullAll({ silent: false });
      if (!res.ok) {
        return finish({ kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请先在「设置 → Soul Sync 跨机迁移」填写金库路径或运行 `dsh-soul init`。' });
      }
      const s = res.sessions.summary;
      const totalApplied = res.workspaces.reduce((acc, w) => acc + w.applied.length, 0);
      const totalDrained = res.workspaces.reduce((acc, w) => acc + w.drainedIncoming.length, 0);
      const totalConflicts = res.workspaces.reduce((acc, w) => acc + w.conflicts.length, 0);
      const totalStaged = res.workspaces.reduce((acc, w) => acc + w.stagedIncoming.length, 0);

      const lines = [
        `拉取完成：会话新增 ${s.imported} / 快进 ${s.fastForwarded} / 孤儿归位 ${s.migrated ?? 0} / 分叉 ${s.forkedBranches}；产出更新 ${totalApplied} 个（含 \`.dsh-incoming/\` 排空落位 ${totalDrained} 个），冲突 ${totalConflicts} 个。`,
      ];
      if ((s.deferredBusy ?? 0) > 0) {
        lines.push(`⏳ 有 ${s.deferredBusy} 条会话正在生成回复中，已安全延后快进，待本轮结束后自动同步。`);
      }
      if ((s.skippedUnmapped ?? 0) > 0) {
        lines.push(`ℹ️ 严格一一对应模式下已跳过 ${s.skippedUnmapped} 条未配对工作区对话（可在「设置 → Soul Sync 跨机迁移」绑定目录或按需拉取）。`);
      }
      if (totalStaged > 0) {
        lines.push(`⚠️ 仍有 ${totalStaged} 个文件因本地占锁暂存于 \`.dsh-incoming/\`，关闭 Excel 后再次执行 \`/soul pull\` 即可自动落位。`);
      }
      return finish({ kind: 'success', text: lines.join('\n') });
    }

    if (intent.kind === 'push') {
      if (Array.isArray(intent.targets) && intent.targets.length > 0) {
        return finish(await this.handleSelectivePush({ targets: intent.targets }));
      }
      const res = await this.pushAll({ agent });
      if (!res.ok) {
        return finish({ kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请先在「设置 → Soul Sync 跨机迁移」填写金库路径或运行 `dsh-soul init`。' });
      }
      const uploaded = res.workspaces.reduce((acc, w) => acc + w.uploaded.length, 0);
      const deleted = res.workspaces.reduce((acc, w) => acc + w.deleted.length, 0);
      const deferred = res.workspaces.reduce((acc, w) => acc + w.deferred.length, 0);
      const blocked = res.workspaces.reduce((acc, w) => acc + w.blocked.length, 0);
      const openLocks = res.workspaces.flatMap((w) => w.openLocks ?? []);

      const lines = [
        `推送完成：同步会话 ${res.sessionPushedCount} 个；产出上传 ${uploaded} / 删除 ${deleted} / 延后重试 ${deferred} / 拦截 ${blocked}。`,
      ];
      if (Array.isArray(res.deferredCompactionSessions) && res.deferredCompactionSessions.length > 0) {
        lines.push(`⏳ 有 ${res.deferredCompactionSessions.length} 个会话正在执行压缩事务，已自动延后本次快照上传（压缩闭合后将自动同步）。`);
      }
      if (openLocks.length > 0) {
        lines.push(`⚠️ 检测到未关闭的 Office 锁文件：${openLocks.map((l) => `\`${l.lockPath}\``).join('、')}`);
      }
      return finish({ kind: 'success', text: lines.join('\n') });
    }

    if (intent.kind === 'unpublish') {
      return finish(await this.handleUnpublish({ targets: intent.targets }));
    }

    if (intent.kind === 'keep') {
      return this.handleKeep({ agent, rawTarget: intent.targetPath });
    }

    if (intent.kind === 'config') {
      return finish(await this.handleConfig({ argsText: intent.argsText }));
    }

    if (intent.kind === 'set-step-sync') {
      return finish(await this.handleSetStepSync({ enabled: intent.enabled }));
    }

    if (intent.kind === 'add-mapping') {
      return finish(await this.handleAddMapping({ winPath: intent.winPath, macPath: intent.macPath }));
    }

    if (intent.kind === 'help') {
      return finish({ kind: 'success', text: this.formatHelpCard() });
    }

    // Unrecognized `/soul ...` input: instantaneously return cheat-sheet + current status (0 LLM wait, never hijacks AI)
    const statusCard = await this.formatStatusCard({ agent });
    const text = [
      `未识别的 \`/soul\` 子指令「${intent.rawInput}」，以下是速查与当前实时状态（如需让 AI 处理业务文件，请直接在对话框提问，无需加 \`/soul\` 前缀）：`,
      '',
      this.formatHelpCard(),
      '',
      statusCard,
    ].join('\n');
    return finish({ kind: 'success', text });
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this._stopBackgroundPoller();

    for (const timer of this._timers) {
      clearTimeout(timer);
    }
    this._timers.clear();

    const closing = [];
    for (const entry of this._watchers.values()) {
      closing.push(entry.watcher.close().catch(() => {}));
    }
    this._watchers.clear();
    await Promise.allSettled([this._syncChain, ...closing]);
  }
}

export function apply(ctx, pluginConfig = {}) {
  const controller = new SoulSyncController(ctx, pluginConfig);

  if (ctx && typeof ctx.on === 'function') {
    // 1. Zero-breakage first-person anti-decay compaction upgrade + streaming budget guard via llm/stream waterfall
    ctx.on('llm/stream', (options, next) => interceptCompactionStream(options, next));

    // 2. First-party file modification tools -> provenance ledger
    // P1-3: Real DSH `ToolRuntime` emits `tools/result(exec, result)` with 2 arguments;
    // also stay compatible with legacy test harnesses passing `(payload, nextFn)`.
    ctx.on('tools/result', async (execOrPayload, resultOrNext) => {
      if (typeof resultOrNext === 'function') {
        await controller.handleToolsResult(execOrPayload);
        return resultOrNext();
      }
      await controller.handleToolsResult(execOrPayload, resultOrNext);
    });

    // 3. Session lifecycle events (deliverables/presented, tool/result, job/settled, step/end 30s RPO, turn/end full sync)
    ctx.on('session/event', async (arg1, arg2) => {
      await controller.handleSessionEvent(arg1, arg2);
    });

    // 4. Session & agent disposal (NEVER calls ctx.sessions.flush)
    ctx.on('session/disposed', async (sessionOrPayload) => {
      await controller.handleSessionDisposed(sessionOrPayload);
    });
    ctx.on('agent/disposed', (payload) => {
      const sid = payload?.agent?.id ?? payload?.agent?.session?.id ?? payload?.id ?? null;
      if (sid && !controller._releasingForFastForward.has(sid)) {
        controller._scheduleDeferredBusyCatchup(sid);
      }
    });

    // 5. Background long-running job settled -> debounced workspace deliverable push
    ctx.on('job/settled', (payload) => {
      controller.handleJobSettled(payload);
    });

    // 6. Cross-OS first-person handoff narrative + unread sync alerts injection on agent/pre-step
    ctx.on('agent/pre-step', async (payload, next) => {
      return controller.handleAgentPreStep(payload, next);
    });

    // 6b. Native DSH Settings -> Plugins volatile config live-sync to config.json & secret.key
    ctx.on('settings/document-updated', (ns) => {
      if (!ns || ns === name) {
        void controller.syncVolatileSettings({ triggerPull: true }).catch(() => {});
      }
    });
    ctx.on('app-boot/config-reload', () => {
      void controller.syncVolatileSettings({ triggerPull: true }).catch(() => {});
    });
  }

  // Subscribe to DSH JobRegistry event stream when present in host composition
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['jobs'], (jobCtx) => {
      const jobsSvc = jobCtx?.jobs ?? getCtxService(jobCtx, 'jobs');
      jobsSvc?.events?.subscribe?.({}, (ev) => {
        if (ev?.type === 'settled') {
          const ownerCwd = ev.job?.owner?.session?.header?.cwd ?? null;
          controller.handleJobSettled({ cwd: ownerCwd });
        }
      });
    });
  }

  // 7. Register /soul slash command (access `targetCtx.commands` directly when injected so Cordis binds traceable fiber!)
  const registerSoulCommand = (targetCtx, isInjected = false) => {
    const commandsSvc = isInjected ? targetCtx?.commands : getCtxService(targetCtx, 'commands');
    if (typeof commandsSvc?.register !== 'function') return;
    commandsSvc.register({
      name: 'soul',
      description: '跨设备防灾同步、保尾无损压缩与灵魂接力（日常已每 15 秒后台静默同步；支持 /soul 同步 /soul status /soul 帮我无损压缩一下）',
      input: { hint: '同步 | status | 帮我无损压缩一下 | 我要换电脑了 | 关闭30秒快照' },
      handler: async ({ agent, rawInput, signal }) =>
        controller.handleSlashCommand({ agent, rawInput, signal }),
    });
  };
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (cmdCtx) => registerSoulCommand(cmdCtx, true));
  } else if (getCtxService(ctx, 'commands')?.register) {
    registerSoulCommand(ctx, false);
  }

  // 7b. Statically register read-only concurrency-safe `soul_recall_history` tool (strict fault isolation)
  const registerRecallTool = (targetCtx, isInjected = false) => {
    try {
      const toolsSvc = isInjected ? targetCtx?.tools : getCtxService(targetCtx, 'tools');
      if (typeof toolsSvc?.register !== 'function') return;
      toolsSvc.register(createSoulRecallTool());
    } catch (err) {
      try {
        targetCtx?.logger?.warn?.(
          `[dsh-soul-sync] failed to register soul_recall_history tool: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // Never allow optional tool registration failure to disrupt main plugin lifecycle
      }
    }
  };
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => registerRecallTool(toolCtx, true));
  } else if (getCtxService(ctx, 'tools')?.register) {
    registerRecallTool(ctx, false);
  }

  // 7c. Register same-origin loopback JSON API on DSH WebServer for native Settings UI panel
  const registerWebApi = (targetCtx, isInjected = false) => {
    const webServerSvc = isInjected ? targetCtx?.webServer : getCtxService(targetCtx, 'webServer');
    if (typeof webServerSvc?.register !== 'function') return;
    const disposeRoute = webServerSvc.register({
      kind: 'prefix',
      path: '/__soul-sync/api',
      handler: (req, res) => controller.handleHttpApi(req, res),
    });
    if (typeof targetCtx?.effect === 'function') {
      targetCtx.effect(() => disposeRoute, 'dsh-soul-sync.web-api');
    }
  };
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => registerWebApi(webCtx, true));
  } else if (getCtxService(ctx, 'webServer')?.register) {
    registerWebApi(ctx, false);
  }

  // 8. Idempotent HMR / unload cleanup
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void controller.dispose();
    }, 'dsh-soul-sync.lifecycle');
  } else if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', () => controller.dispose());
  }

  // Non-blocking startup initialization (callers/tests can await controller.readyPromise)
  void controller.start();

  return controller;
}
