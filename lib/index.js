import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_QUOTAS,
  resolveDshHome,
  soulSyncDir,
  loadConfig,
  saveConfig,
  savePassphraseKey,
  loadPassphraseKey,
  mapPathAcrossOs,
  ensureGlobalAgentsRules,
  writeFileAtomic,
} from './config.js';
import { VaultStore } from './crypto-vault.js';
import {
  exportSessionClosure,
  exportAllLocalSessions,
  pullSessionsFromVault,
  consumePendingMigration,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const name = 'dsh-soul-sync';

/**
 * Dynamically import a `@deepseek-ai/*` package from the active DSH host runtime.
 * Falls back cleanly to `null` in standalone pure-Node CLI / unit test environments,
 * while resolving into Electron DSH's `app.asar/dsh` even when `dsh-soul-sync` is
 * mounted via `link:` outside `app.asar/dsh/node_modules`.
 */
async function importHostPackage(specifier) {
  try {
    return await import(specifier);
  } catch {
    // External linked plugin outside app.asar/dsh/node_modules -> probe DSH host runtime roots
  }

  const candidatePkgJsons = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidatePkgJsons.push(
      path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'),
      path.join(process.resourcesPath, 'dsh', 'package.json'),
    );
  }
  const execDir = path.dirname(process.execPath);
  candidatePkgJsons.push(
    path.join(execDir, 'resources', 'app.asar', 'dsh', 'package.json'),
    path.join(execDir, '..', 'Resources', 'app.asar', 'dsh', 'package.json'),
  );

  for (const anchor of candidatePkgJsons) {
    try {
      if (!fsSync.existsSync(anchor)) continue;
      const req = createRequire(anchor);
      const resolved = req.resolve(specifier);
      return await import(pathToFileURL(resolved).href);
    } catch {
      // Try next host anchor
    }
  }
  return null;
}

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
  'sync',
  'help',
  'help-with-status',
  'config',
  'set-step-sync',
  'add-mapping',
]);

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
 * Construct a DSH-compatible persistent `UserMessage`.
 * Dynamically uses `@deepseek-ai/dsh-llm`'s `createUserMessage` when available,
 * and falls back to a deeply frozen structural equivalent in standalone environments.
 */
export async function createPersistentUserMessage(text) {
  const mod = await tryLoadDshLlmMod();
  const createUserMessage = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null;
  const payload = {
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
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
    source: { kind: 'user' },
  });
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
  const collect = (obj) => {
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
    this._lastStepSyncAt = new Map();
    this._pendingToolCalls = new Map();
    this._pendingHandoffSessions = new Set();
    this._pendingAlerts = [];
    this._lastBackupAt = null;
    this._lastPullAt = null;
    this._baton = { state: 'active', holder: null, updatedAt: null };
    this._lastVolatileSnapshot = this._readVolatileSettings();
    this._disposed = false;
    this._startupErrors = [];
    this.readyPromise = Promise.resolve();
  }

  _readVolatileSettings() {
    const rawVaultDir = unwrapVolatile(this.pluginConfig?.vaultDir);
    const rawPassphrase = unwrapVolatile(this.pluginConfig?.passphrase);
    const rawStepSync = unwrapVolatile(this.pluginConfig?.stepSyncEnabled);
    const rawDeviceLabel = unwrapVolatile(this.pluginConfig?.deviceLabel);
    return {
      vaultDir: typeof rawVaultDir === 'string' ? rawVaultDir.trim() : '',
      passphrase: typeof rawPassphrase === 'string' ? rawPassphrase : '',
      stepSyncEnabled: typeof rawStepSync === 'boolean' ? rawStepSync : undefined,
      deviceLabel: typeof rawDeviceLabel === 'string' ? rawDeviceLabel.trim() : '',
    };
  }

  async syncVolatileSettings({ triggerPull = true, isStartup = false } = {}) {
    if (this._disposed) return { updated: false };
    if (!this.config) await this.reloadConfig();
    const current = this._readVolatileSettings();
    const prev = this._lastVolatileSnapshot ?? {};
    const patch = {};
    let passphraseChanged = false;

    if (current.vaultDir) {
      const resolvedVault = path.resolve(current.vaultDir);
      const vaultChanged = isStartup
        ? resolvedVault !== this.config.vaultDir
        : (current.vaultDir !== prev.vaultDir || resolvedVault !== this.config.vaultDir);
      if (vaultChanged) {
        patch.vaultDir = resolvedVault;
      }
    }

    if (current.deviceLabel) {
      const labelChanged = isStartup
        ? current.deviceLabel !== this.config.deviceLabel
        : (current.deviceLabel !== prev.deviceLabel || current.deviceLabel !== this.config.deviceLabel);
      if (labelChanged) {
        patch.deviceLabel = current.deviceLabel;
      }
    }

    if (!isStartup && typeof current.stepSyncEnabled === 'boolean') {
      if (current.stepSyncEnabled !== prev.stepSyncEnabled && current.stepSyncEnabled !== this.config.stepSyncEnabled) {
        patch.stepSyncEnabled = current.stepSyncEnabled;
      }
    }

    if (current.passphrase && (isStartup ? current.passphrase.length > 0 : current.passphrase !== prev.passphrase)) {
      await savePassphraseKey(this.dshHome, current.passphrase);
      patch.encryptionEnabled = true;
      passphraseChanged = true;
    }

    this._lastVolatileSnapshot = current;

    if (Object.keys(patch).length === 0 && !passphraseChanged) {
      return { updated: false };
    }

    if (Object.keys(patch).length > 0) {
      await saveConfig(this.dshHome, patch);
    }
    if (passphraseChanged) {
      this._startupErrors = this._startupErrors.filter((m) => !m.includes('secret.key'));
    }
    await this.reloadConfig();

    if (triggerPull && this.vault && !this._disposed) {
      await this.pullAll({ silent: true }).catch(() => {});
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
      for (const sub of ['session-commits', 'workspace-commits']) {
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
      || (res?.sessions?.pendingCount ?? 0) > 0;
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

  _buildCordisAdapter() {
    if (!this.ctx) return null;
    const workspaceRegistry = getCtxService(this.ctx, 'workspaceRegistry');
    const sessionPersistence = getCtxService(this.ctx, 'sessionPersistence');
    const storageDomain = getCtxService(this.ctx, 'storageDomain');
    if (!workspaceRegistry && !sessionPersistence && !storageDomain) {
      return null;
    }
    const customBusy = getCtxService(this.ctx, 'isSessionBusy');
    const agentsSvc = getCtxService(this.ctx, 'agents');
    return {
      workspaceRegistry,
      sessionPersistence,
      storageDomain,
      isSessionBusy: typeof customBusy === 'function'
        ? (id) => customBusy.call(this.ctx, id)
        : typeof agentsSvc?.get === 'function'
          ? (id) => agentsSvc.get(id)?.status === 'running'
          : undefined,
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
        const missingKeyMsg = '已开启加密模式但缺少本机 secret.key，请重新运行 dsh-soul init 配置口令';
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

    if (this.vault && !this._disposed) {
      this._startBackgroundPoller();
    } else {
      this._stopBackgroundPoller();
    }

    return this.config;
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

  async syncGlobalAgentsMd() {
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
            this._pendingAlerts.push({
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

    if (localSha !== state.lastPublishedSha && localSha !== latestRemoteSha) {
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
    const pullRes = await this.pullAll({ silent: true });
    if (
      pullRes?.ok
      && (pullRes.sessions?.summary?.pendingHydration ?? 0) === 0
      && (pullRes.sessions?.summary?.deferredBusy ?? 0) === 0
      && (pullRes.sessions?.pendingCount ?? 0) === 0
    ) {
      const files = await this._scanRemoteCommitFingerprints();
      for (const k of files) this._seenRemoteCommitFiles.add(k);
    }
    await this.updateHeartbeat({ status: 'active' });
    this._startBackgroundPoller();
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

  async handleToolsResult(payload) {
    if (this._disposed || !this.config) return;
    const toolName = String(payload?.toolName ?? payload?.name ?? payload?.tool ?? '').toLowerCase();
    if (!FILE_MODIFY_TOOLS.has(toolName)) return;

    if (payload?.isError || payload?.error || payload?.result?.isError === true || payload?.result?.ok === false) {
      return;
    }

    const cwd = payload?.cwd ?? payload?.session?.cwd ?? payload?.session?.header?.cwd ?? '';
    const sessionId = payload?.session?.id ?? payload?.session?.header?.id ?? null;
    const source = toolName.includes('present') ? 'present' : 'tool';
    const rawPaths = extractToolPaths(payload);

    for (const rawPath of rawPaths) {
      const resolvedPath = path.isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath)
        ? rawPath
        : cwd
          ? path.resolve(cwd, rawPath)
          : rawPath;
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

  async _exportSessionSafely(session, { allowFlush }) {
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

    // If allowFlush is true and disk already has the session, prefer snapshot if present;
    // otherwise exportSessionClosure reads from disk automatically.
    const res = await exportSessionClosure({
      dshHome: this.dshHome,
      vault: this.vault,
      sessionId,
      workspaceMappings: this.config.workspaceMappings,
      deviceLabel: this.config.deviceLabel,
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
    if (sessionId && this._syntheticTurnSessions.has(sessionId)) {
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
        if (sessionId) {
          await this._exportSessionSafely(session, { allowFlush: true });
        }
        if (matchedWs && (await pathExists(matchedWs.localRoot))) {
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
    }
  }

  async handleSessionDisposed(sessionOrPayload) {
    if (this._disposed) return;
    const session = sessionOrPayload?.session ?? sessionOrPayload;
    const sessionId = session?.id ?? session?.header?.id ?? null;

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
    if (!decision || decision.kind === 'reject' || signal?.aborted) {
      return decision;
    }

    const sessionId = agent?.session?.id ?? agent?.sessionId ?? null;
    const mig = sessionId ? await consumePendingMigration(this.dshHome, sessionId) : null;
    const unreadAlerts = this._pendingAlerts.length > 0 ? this._pendingAlerts.splice(0) : [];

    if (!mig && unreadAlerts.length === 0) {
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
    if (unreadAlerts.length > 0) {
      const alertSummary = unreadAlerts.map((a) => a.text).join('；');
      noteParts.push(`【同步提醒】${alertSummary}`);
    }

    const msg = await createPersistentUserMessage(noteParts.join('\n'));
    return {
      ...decision,
      messages: [...(Array.isArray(decision.messages) ? decision.messages : []), msg],
    };
  }

  async pullAll({ silent = false } = {}) {
    return this._withSyncLock(async () => {
      if (!this.config) await this.reloadConfig();
      if (!this.vault) {
        return { ok: false, reason: 'no-vault' };
      }

      const globalRes = await this.syncGlobalAgentsMd();
      const sessionRes = await pullSessionsFromVault({
        dshHome: this.dshHome,
        vault: this.vault,
        workspaceMappings: this.config.workspaceMappings,
        targetPlatform: this.platform,
        fallbackRoot: this.config.fallbackDir || undefined,
        cordisCtx: this._buildCordisAdapter(),
      });

      if (sessionRes.summary.forkedBranches > 0) {
        this._pendingAlerts.push({
          kind: 'session-fork',
          text: `检测到 ${sessionRes.summary.forkedBranches} 个双端并发编辑产生的会话分叉分支，均已无损保留在侧边栏中`,
        });
      }

      const { commits: remoteWsCommits } = await this.vault.listCommits('workspace', { includeSelf: false });
      const remoteWsIds = new Set(remoteWsCommits.map((c) => c.targetId));

      const workspaceResults = [];
      for (const mapping of this.config.workspaceMappings ?? []) {
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

        if (wsRes.conflicts.length > 0) {
          this._pendingAlerts.push({
            kind: 'file-conflict',
            text: `工作区「${mapping.title || mapping.id}」有 ${wsRes.conflicts.length} 个双边同改冲突副本（已保留本机文件并并列落盘远端副本）`,
          });
        }
        if (wsRes.stagedIncoming.length > 0) {
          const names = wsRes.stagedIncoming.map((s) => s.path).join('、');
          this._pendingAlerts.push({
            kind: 'incoming-staged',
            text: `工作区「${mapping.title || mapping.id}」有 ${wsRes.stagedIncoming.length} 个文件因本地占锁已暂存于 .dsh-incoming/（${names}），关闭 Excel 后执行 /soul pull 即可自动落位`,
          });
        }
      }

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

  async pushAll({ agent = null } = {}) {
    return this._withSyncLock(async () => {
      if (!this.config) await this.reloadConfig();
      if (!this.vault) {
        return { ok: false, reason: 'no-vault' };
      }

      const globalRes = await this.syncGlobalAgentsMd();

      let sessionPushedCount = 0;
      const deferredCompactionSessions = [];
      const activeSession = agent?.session ?? null;
      if (activeSession?.id || activeSession?.header?.id) {
        const expRes = await this._exportSessionSafely(activeSession, { allowFlush: true });
        if (expRes?.deferred && expRes.reason === 'unclosed-compaction') {
          deferredCompactionSessions.push(...(expRes.deferredCompactionSessions ?? [activeSession.id ?? activeSession.header?.id]));
        } else if (expRes) {
          sessionPushedCount = 1;
        }
      } else {
        const allRes = await exportAllLocalSessions({
          dshHome: this.dshHome,
          vault: this.vault,
          workspaceMappings: this.config.workspaceMappings,
          deviceLabel: this.config.deviceLabel,
        });
        sessionPushedCount = allRes.exported.length;
        if (Array.isArray(allRes.deferredCompactionSessions)) {
          deferredCompactionSessions.push(...allRes.deferredCompactionSessions);
        }
        if (sessionPushedCount > 0) {
          this._lastBackupAt = Date.now();
        }
      }

      const workspaceResults = [];
      for (const mapping of this.config.workspaceMappings ?? []) {
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
      await this.vault.pruneHistory('workspace', keepN).catch(() => {});

      return {
        ok: true,
        global: globalRes,
        sessionPushedCount,
        deferredCompactionSessions,
        workspaces: workspaceResults,
      };
    });
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
      lines.push('- **金库状态**：尚未配置 `vaultDir`（请运行 `dsh-soul init` 完成初始化）');
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
          `- \`deviceLabel\`: ${this.config.deviceLabel}`,
          `- \`maxFileMB\`: ${(q.maxFileBytes / (1024 * 1024)).toFixed(1)} MB`,
          `- \`maxWorkspaceMB\`: ${(q.maxWorkspaceBytes / (1024 * 1024)).toFixed(1)} MB`,
          `- \`retainSnapshots\`: ${q.retainSnapshots}`,
          `- \`stepSyncIntervalMs\`: ${q.stepSyncIntervalMs} ms`,
          `- \`trashRetentionDays\`: ${q.trashRetentionDays} 天`,
          '',
          '修改示例：`/soul config maxFileMB=50 maxWorkspaceMB=1000 retainSnapshots=15 stepSync=off`',
        ].join('\n'),
      };
    }

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const quotaPatch = {};
    const topPatch = {};

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
        if (!rawVal) return { kind: 'error', text: '`vaultDir` 不能为空。' };
        topPatch.vaultDir = path.resolve(rawVal);
        continue;
      }

      if (key === 'fallbackDir') {
        topPatch.fallbackDir = rawVal ? path.resolve(rawVal) : '';
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
        default:
          return {
            kind: 'error',
            text: `不支持的配置项 \`${key}\`。支持：stepSync, stepSyncEnabled, maxFileMB, maxWorkspaceMB, retainSnapshots, stepSyncIntervalMs, stepSyncSeconds, trashRetentionDays, deviceLabel, vaultDir, fallbackDir`,
          };
      }
    }

    const updated = await saveConfig(this.dshHome, {
      ...topPatch,
      quotas: quotaPatch,
    });
    await this.reloadConfig();

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

  async handleAddMapping({ winPath, macPath }) {
    if (!this.config) await this.reloadConfig();
    const cleanWin = String(winPath ?? '').trim().normalize('NFC');
    const cleanMac = String(macPath ?? '').trim().normalize('NFC');
    if (!cleanWin || !cleanMac) {
      return { kind: 'error', text: '绑定工作区映射需要同时提供 Windows 路径和 macOS 路径。' };
    }

    const baseName = (p) => {
      const s = String(p).replace(/[\\/]+$/, '');
      const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return (idx >= 0 ? s.slice(idx + 1) : s).normalize('NFC');
    };
    const title = baseName(cleanWin) || baseName(cleanMac) || 'workspace';
    const safeId = title.replace(/[<>:"/\\|?*\s]+/g, '-').replace(/^-+|-+$/g, '')
      || `ws-${crypto.createHash('sha256').update(`${cleanWin}::${cleanMac}`).digest('hex').slice(0, 6)}`;

    const existing = [...(this.config.workspaceMappings ?? [])];
    const matchIdx = existing.findIndex(
      (m) =>
        m.id === safeId
        || (m.win32 && m.win32.toLowerCase() === cleanWin.toLowerCase())
        || (m.darwin && m.darwin.toLowerCase() === cleanMac.toLowerCase()),
    );

    let savedEntry;
    if (matchIdx !== -1) {
      savedEntry = { ...existing[matchIdx], win32: cleanWin, darwin: cleanMac };
      existing[matchIdx] = savedEntry;
    } else {
      savedEntry = { id: safeId, title, win32: cleanWin, darwin: cleanMac };
      existing.push(savedEntry);
    }

    await saveConfig(this.dshHome, { workspaceMappings: existing });
    await this.reloadConfig();

    return {
      kind: 'success',
      text: `已绑定跨系统工作区映射并立即生效：\n- [${savedEntry.id}] Win=\`${savedEntry.win32}\` ⇄ Mac=\`${savedEntry.darwin}\``,
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

  formatHelpCard() {
    return [
      '### Soul Sync 速查指南（日常已每 15 秒后台自动静默同步，无需记命令）',
      '',
      '- **一键双向同步**：`/soul 同步`、`/soul 接力`、`/soul 刷新` 或 `/soul sync`',
      '- **看状态 / 查 Excel 锁**：`/soul`、`/soul 同步正常吗` 或 `/soul status`',
      '- **保尾无损压缩（不断魂）**：`/soul 帮我无损压缩一下` 或 `/soul compact [保留轮数]`',
      '- **下班换电脑写交接日记**：`/soul 我准备下班回家用Mac继续了` 或 `/soul handoff`',
      '- **把手工文件加进同步**：`/soul 帮我把 outputs/估值模型.xlsx 同步上` 或 `/soul keep <路径>`',
      '- **开关 30 秒防断电快照**：`/soul 关闭30秒快照` / `/soul 开启30秒快照`',
      '- **单独拉取 / 推送**：`/soul pull` / `/soul push`',
      '- **改配置 / 绑目录**：直接在 DSH「设置 → 插件 → Soul Sync」修改，或发送 `/soul 把单文件上限改成 100M`',
    ].join('\n');
  }

  async handleSync({ agent = null } = {}) {
    const pullRes = await this.pullAll({ silent: false });
    if (!pullRes.ok) {
      return { kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请在「设置 → 插件 → Soul Sync」填写金库路径或运行 `dsh-soul init`。' };
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
      const userMsg = await createPersistentUserMessage(cmdLine);
      const assistantMsg = await createPersistentAssistantMessage(cardText, this.defaultModelTriple);

      if (sessionId) this._syntheticTurnSessions.add(sessionId);
      try {
        // V4 lifecycle requires 1-based sequential turn & step indices (`dsh-session-format-v3-to-v4`)
        session.append('turn/start', { turn: 1 });
        session.append('user/message', userMsg, { surfaceOp: 'append' });
        session.append('step/start', { turn: 1, step: 1 });
        session.append(
          'assistant/message',
          { turn: 1, step: 1, message: assistantMsg },
          { surfaceOp: 'append' },
        );
        session.append('step/end', { turn: 1, step: 1 });
        session.append('turn/end', { turn: 1 });

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
        await this._renderCardInBlankSession(agent, rawInput, res.text);
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

    if (intent.kind === 'pull') {
      const res = await this.pullAll({ silent: false });
      if (!res.ok) {
        return finish({ kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请先在「设置 → 插件 → Soul Sync」填写金库路径或运行 `dsh-soul init`。' });
      }
      const s = res.sessions.summary;
      const totalApplied = res.workspaces.reduce((acc, w) => acc + w.applied.length, 0);
      const totalDrained = res.workspaces.reduce((acc, w) => acc + w.drainedIncoming.length, 0);
      const totalConflicts = res.workspaces.reduce((acc, w) => acc + w.conflicts.length, 0);
      const totalStaged = res.workspaces.reduce((acc, w) => acc + w.stagedIncoming.length, 0);

      const lines = [
        `拉取完成：会话新增 ${s.imported} / 快进 ${s.fastForwarded} / 孤儿归位 ${s.migrated ?? 0} / 分叉 ${s.forkedBranches}；产出更新 ${totalApplied} 个（含 \`.dsh-incoming/\` 排空落位 ${totalDrained} 个），冲突 ${totalConflicts} 个。`,
      ];
      if (totalStaged > 0) {
        lines.push(`⚠️ 仍有 ${totalStaged} 个文件因本地占锁暂存于 \`.dsh-incoming/\`，关闭 Excel 后再次执行 \`/soul pull\` 即可自动落位。`);
      }
      return finish({ kind: 'success', text: lines.join('\n') });
    }

    if (intent.kind === 'push') {
      const res = await this.pushAll({ agent });
      if (!res.ok) {
        return finish({ kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请先在「设置 → 插件 → Soul Sync」填写金库路径或运行 `dsh-soul init`。' });
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
    ctx.on('tools/result', async (payload, maybeNext) => {
      await controller.handleToolsResult(payload);
      if (typeof maybeNext === 'function') return maybeNext();
    });

    // 3. Session lifecycle events (deliverables/presented, tool/result, job/settled, step/end 30s RPO, turn/end full sync)
    ctx.on('session/event', async (arg1, arg2) => {
      await controller.handleSessionEvent(arg1, arg2);
    });

    // 4. Session disposal (NEVER calls ctx.sessions.flush)
    ctx.on('session/disposed', async (sessionOrPayload) => {
      await controller.handleSessionDisposed(sessionOrPayload);
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
