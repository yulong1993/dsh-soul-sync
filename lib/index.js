import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_QUOTAS,
  resolveDshHome,
  soulSyncDir,
  loadConfig,
  saveConfig,
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
  scanLocalSessions,
} from './session-plane.js';
import {
  recordDeliverableCandidate,
  createActiveWorkspaceWatcher,
  detectOpenOfficeLocks,
  pushWorkspaceDeliverables,
  pullWorkspaceDeliverables,
  loadWorkspaceDeliverableState,
} from './deliverable-plane.js';
import { rewriteCompactionStreamOptions } from './compaction-soul.js';

export const name = 'dsh-soul-sync';

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

let cachedDshLlmLoader = null;

async function tryLoadCreateUserMessage() {
  if (!cachedDshLlmLoader) {
    cachedDshLlmLoader = import('@deepseek-ai/dsh-llm')
      .then((mod) => (typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null))
      .catch(() => null);
  }
  return cachedDshLlmLoader;
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
  const createUserMessage = await tryLoadCreateUserMessage();
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
    this.dshHome = resolveDshHome(
      this.pluginConfig.dshHome ?? ctx?.dshHome ?? ctx?.config?.dshHome,
    );
    this.platform = this.pluginConfig.platform ?? process.platform;
    this.dshVersion =
      this.pluginConfig.dshVersion
      ?? ctx?.dshVersion
      ?? ctx?.app?.version
      ?? process.env.DSH_VERSION
      ?? '0.2.2';
    this.minQuietMs = typeof this.pluginConfig.minQuietMs === 'number'
      ? this.pluginConfig.minQuietMs
      : 1500;

    this.config = null;
    this.secretKeys = null;
    this.vault = null;
    this.defaultModelTriple = null;

    this._watchers = new Map();
    this._timers = new Set();
    this._lastStepSyncAt = new Map();
    this._pendingHandoffSessions = new Set();
    this._pendingAlerts = [];
    this._lastBackupAt = null;
    this._lastPullAt = null;
    this._baton = { state: 'active', holder: null, updatedAt: null };
    this._disposed = false;
    this._startupErrors = [];
    this.readyPromise = Promise.resolve();
  }

  _buildCordisAdapter() {
    if (!this.ctx) return null;
    if (!this.ctx.workspaceRegistry && !this.ctx.sessionPersistence && !this.ctx.storageDomain) {
      return null;
    }
    return {
      workspaceRegistry: this.ctx.workspaceRegistry,
      sessionPersistence: this.ctx.sessionPersistence,
      storageDomain: this.ctx.storageDomain,
      isSessionBusy: typeof this.ctx.isSessionBusy === 'function'
        ? (id) => this.ctx.isSessionBusy(id)
        : undefined,
    };
  }

  async _detectDefaultModelTriple() {
    if (this.pluginConfig.defaultModelTriple) {
      return this.pluginConfig.defaultModelTriple;
    }
    if (this.ctx?.llm?.defaultConfig && typeof this.ctx.llm.defaultConfig === 'object') {
      const c = this.ctx.llm.defaultConfig;
      return {
        provider: c.provider ?? null,
        model: c.model ?? null,
        reasoningEffort: c.reasoningEffort ?? null,
      };
    }
    if (this.config?.defaultModelTriple) {
      return this.config.defaultModelTriple;
    }

    // Safely inspect non-secret DSH profile cordis.patch.yml / cordis.yml files (NEVER touches .credentials.yaml)
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
            if (scoped) return scoped;
          }
          const parsed = parseModelTriple(text);
          if (parsed) return parsed;
        } catch {
          // Profile file absent
        }
      }
    }

    // Fallback: inspect latest local session request/header if any exists
    try {
      const localMap = await scanLocalSessions(this.dshHome);
      for (const rec of localMap.values()) {
        for (let i = rec.events.length - 1; i >= 0; i--) {
          const ev = rec.events[i];
          if (ev?.type === 'request/header') {
            const cfg = ev.data?.header?.config ?? ev.data?.config;
            if (cfg && (cfg.provider || cfg.model)) {
              return {
                provider: cfg.provider ?? null,
                model: cfg.model ?? null,
                reasoningEffort: cfg.reasoningEffort ?? null,
              };
            }
          }
        }
      }
    } catch {
      // Ignore scan error
    }

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
      this._startupErrors.push(err instanceof Error ? err.message : String(err));
    });
    return this.readyPromise;
  }

  async _runStartup() {
    await this.reloadConfig();
    await ensureGlobalAgentsRules(this.dshHome);

    if (!this.vault || this._disposed) return;

    await this.syncGlobalAgentsMd();
    await this.pullAll({ silent: true });
    await this.updateHeartbeat({ status: 'active' });
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

    if (allowFlush && typeof this.ctx?.sessions?.flush === 'function') {
      await this.ctx.sessions.flush(session);
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
    this._lastBackupAt = Date.now();
    return res;
  }

  async handleSessionEvent(arg1, arg2) {
    if (this._disposed) return;
    if (!this.config) await this.readyPromise;
    if (!this.config) return;

    const { session, event } = unpackSessionEventArgs(arg1, arg2);
    if (!event || typeof event.type !== 'string') return;

    const sessionId = session?.id ?? session?.header?.id ?? event?.sessionId ?? null;
    const sessionCwd = session?.cwd ?? session?.header?.cwd ?? event?.data?.cwd ?? null;
    const matchedWs = sessionCwd ? this._matchWorkspaceForPath(sessionCwd) : null;

    if (matchedWs) {
      await this._ensureWorkspaceWatcher(matchedWs.mapping.id, matchedWs.localRoot, sessionId);
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

    if (!this.vault) return;

    if (event.type === 'step/end') {
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

    const workspaceResults = [];
    for (const mapping of this.config.workspaceMappings ?? []) {
      const localRoot = mapping[this.platform];
      if (!localRoot || !(await pathExists(localRoot))) continue;
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
  }

  async pushAll({ agent = null } = {}) {
    if (!this.config) await this.reloadConfig();
    if (!this.vault) {
      return { ok: false, reason: 'no-vault' };
    }

    const globalRes = await this.syncGlobalAgentsMd();

    let sessionPushedCount = 0;
    const activeSession = agent?.session ?? null;
    if (activeSession?.id || activeSession?.header?.id) {
      await this._exportSessionSafely(activeSession, { allowFlush: true });
      sessionPushedCount = 1;
    } else {
      const allRes = await exportAllLocalSessions({
        dshHome: this.dshHome,
        vault: this.vault,
        workspaceMappings: this.config.workspaceMappings,
        deviceLabel: this.config.deviceLabel,
      });
      sessionPushedCount = allRes.exported.length;
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
      workspaces: workspaceResults,
    };
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

    if (!this.config.vaultDir) {
      lines.push('- **金库状态**：尚未配置 `vaultDir`（请运行 `dsh-soul init` 完成初始化）');
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
          `- \`deviceLabel\`: ${this.config.deviceLabel}`,
          `- \`maxFileMB\`: ${(q.maxFileBytes / (1024 * 1024)).toFixed(1)} MB`,
          `- \`maxWorkspaceMB\`: ${(q.maxWorkspaceBytes / (1024 * 1024)).toFixed(1)} MB`,
          `- \`retainSnapshots\`: ${q.retainSnapshots}`,
          `- \`stepSyncIntervalMs\`: ${q.stepSyncIntervalMs} ms`,
          `- \`trashRetentionDays\`: ${q.trashRetentionDays} 天`,
          '',
          '修改示例：`/soul config maxFileMB=50 maxWorkspaceMB=1000 retainSnapshots=15`',
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
            text: `不支持的配置项 \`${key}\`。支持：maxFileMB, maxWorkspaceMB, retainSnapshots, stepSyncIntervalMs, stepSyncSeconds, trashRetentionDays, deviceLabel, vaultDir, fallbackDir`,
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
      text: `配置已更新：maxFileMB=${(updated.quotas.maxFileBytes / (1024 * 1024)).toFixed(1)}MB, maxWorkspaceMB=${(updated.quotas.maxWorkspaceBytes / (1024 * 1024)).toFixed(1)}MB, retainSnapshots=${updated.quotas.retainSnapshots}, stepSyncIntervalMs=${updated.quotas.stepSyncIntervalMs}ms`,
    };
  }

  async handleSlashCommand({ agent = null, rawInput = '' } = {}) {
    const trimmed = String(rawInput ?? '').trim();
    const spaceIdx = trimmed.search(/\s/);
    const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx).trim();

    if (!sub || sub === 'status') {
      const text = await this.formatStatusCard({ agent });
      return { kind: 'success', text };
    }

    if (sub === 'handoff') {
      return this.handleHandoff({ agent, extraNote: rest });
    }

    if (sub === 'pull') {
      const res = await this.pullAll({ silent: false });
      if (!res.ok) {
        return { kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请先运行 `dsh-soul init`。' };
      }
      const s = res.sessions.summary;
      const totalApplied = res.workspaces.reduce((acc, w) => acc + w.applied.length, 0);
      const totalDrained = res.workspaces.reduce((acc, w) => acc + w.drainedIncoming.length, 0);
      const totalConflicts = res.workspaces.reduce((acc, w) => acc + w.conflicts.length, 0);
      const totalStaged = res.workspaces.reduce((acc, w) => acc + w.stagedIncoming.length, 0);

      const lines = [
        `拉取完成：会话新增 ${s.imported} / 快进 ${s.fastForwarded} / 分叉 ${s.forkedBranches}；产出更新 ${totalApplied} 个（含 \`.dsh-incoming/\` 排空落位 ${totalDrained} 个），冲突 ${totalConflicts} 个。`,
      ];
      if (totalStaged > 0) {
        lines.push(`⚠️ 仍有 ${totalStaged} 个文件因本地占锁暂存于 \`.dsh-incoming/\`，关闭 Excel 后再次执行 \`/soul pull\` 即可自动落位。`);
      }
      return { kind: 'success', text: lines.join('\n') };
    }

    if (sub === 'push') {
      const res = await this.pushAll({ agent });
      if (!res.ok) {
        return { kind: 'error', text: '尚未配置防灾金库 `vaultDir`，请先运行 `dsh-soul init`。' };
      }
      const uploaded = res.workspaces.reduce((acc, w) => acc + w.uploaded.length, 0);
      const deleted = res.workspaces.reduce((acc, w) => acc + w.deleted.length, 0);
      const deferred = res.workspaces.reduce((acc, w) => acc + w.deferred.length, 0);
      const blocked = res.workspaces.reduce((acc, w) => acc + w.blocked.length, 0);
      const openLocks = res.workspaces.flatMap((w) => w.openLocks ?? []);

      const lines = [
        `推送完成：同步会话 ${res.sessionPushedCount} 个；产出上传 ${uploaded} / 删除 ${deleted} / 延后重试 ${deferred} / 拦截 ${blocked}。`,
      ];
      if (openLocks.length > 0) {
        lines.push(`⚠️ 检测到未关闭的 Office 锁文件：${openLocks.map((l) => `\`${l.lockPath}\``).join('、')}`);
      }
      return { kind: 'success', text: lines.join('\n') };
    }

    if (sub === 'keep') {
      return this.handleKeep({ agent, rawTarget: rest });
    }

    if (sub === 'config') {
      return this.handleConfig({ argsText: rest });
    }

    return {
      kind: 'error',
      text: `未知子命令 \`${sub}\`。可用：\`/soul [status|handoff|pull|push|keep <path>|config [key=value]]\``,
    };
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (const timer of this._timers) {
      clearTimeout(timer);
    }
    this._timers.clear();

    const closing = [];
    for (const entry of this._watchers.values()) {
      closing.push(entry.watcher.close().catch(() => {}));
    }
    this._watchers.clear();
    await Promise.allSettled(closing);
  }
}

export async function apply(ctx, pluginConfig = {}) {
  const controller = new SoulSyncController(ctx, pluginConfig);

  if (ctx && typeof ctx.on === 'function') {
    // 1. Zero-breakage first-person native-language compaction upgrade via llm/stream waterfall
    ctx.on('llm/stream', (options, next) => {
      rewriteCompactionStreamOptions(options);
      return typeof next === 'function' ? next() : options;
    });

    // 2. First-party file modification tools -> provenance ledger
    ctx.on('tools/result', async (payload, maybeNext) => {
      await controller.handleToolsResult(payload);
      if (typeof maybeNext === 'function') return maybeNext();
    });

    // 3. Session lifecycle events (deliverables/presented, step/end 30s RPO, turn/end full sync)
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
  }

  // 7. Register /soul slash command
  const registerSoulCommand = (targetCtx) => {
    targetCtx?.commands?.register?.({
      name: 'soul',
      description: '跨设备防灾同步与灵魂接力 (/soul [status|handoff|pull|push|keep|config])',
      input: { hint: '[status|handoff|pull|push|keep <path>]' },
      handler: async ({ agent, rawInput, signal }) =>
        controller.handleSlashCommand({ agent, rawInput, signal }),
    });
  };
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (cmdCtx) => registerSoulCommand(cmdCtx));
  } else if (ctx?.commands?.register) {
    registerSoulCommand(ctx);
  }

  // 8. Idempotent HMR / unload cleanup
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void controller.dispose();
    });
  } else if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', () => controller.dispose());
  }

  // Non-blocking startup initialization (callers/tests can await controller.readyPromise)
  void controller.start();

  return controller;
}
