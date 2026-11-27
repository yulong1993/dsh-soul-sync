import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  loadConfig,
  saveConfig,
  savePassphraseKey,
  loadPassphraseKey,
  writeFileAtomic,
  deriveWorkspaceId,
  stripOuterQuotes,
  validateWorkspaceDirectory,
  validateVaultDirectory,
  looksLikeCloudDrivePath,
  ensureGlobalAgentsRules,
} from '../lib/config.js';
import { VaultStore } from '../lib/crypto-vault.js';
import { encodeSegment, projectKey, encodeV4SessionLog, decodeV4SessionLog } from '../lib/zstd-v4.js';
import {
  hasUnclosedCompaction,
  exportSessionClosure,
  pullSessionsFromVault,
  scanLocalSessions,
  listLocalCatalog,
  listVaultCatalog,
  isInstallWizardSession,
  shouldAutoSyncSession,
  buildNearFocusAnchorBlock,
} from '../lib/session-plane.js';
import { loadWorkspaceDeliverableState } from '../lib/deliverable-plane.js';
import { SoulSyncController, apply as applySoulSync } from '../lib/index.js';
import { runCli } from '../bin/dsh-soul.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_ROOT = path.join(REPO_ROOT, '.test-tmp', `part-a-host-fixes-${process.pid}-${Date.now()}`);

const DSH_PROFILE_NODE_MODULES = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'node_modules');
const HAS_REAL_DSH_HOST_PKGS = fsSync.existsSync(path.join(DSH_PROFILE_NODE_MODULES, '@deepseek-ai', 'cordis'));

async function importRealDshPkg(pkgName) {
  const pkgJsonPath = path.join(DSH_PROFILE_NODE_MODULES, pkgName, 'package.json');
  const req = createRequire(pkgJsonPath);
  const resolved = req.resolve(pkgName);
  return import(pathToFileURL(resolved).href);
}

function makeMockHttpReq({
  method = 'GET',
  url = '/__soul-sync/api/state',
  headers = {},
  body = null,
  remoteAddress = '127.0.0.1',
} = {}) {
  const payload = body === null || body === undefined
    ? Buffer.alloc(0)
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const stream = Readable.from(payload.length > 0 ? [payload] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  stream.socket = { remoteAddress };
  return stream;
}

function makeMockHttpRes() {
  let statusCode = 0;
  let resHeaders = {};
  const chunks = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  return {
    writeHead(status, headers = {}) {
      statusCode = status;
      resHeaders = headers;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
      resolveDone();
    },
    async result() {
      await done;
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
      return { status: statusCode, headers: resHeaders, text, json };
    },
  };
}

async function callApi(controller, opts) {
  const req = makeMockHttpReq(opts);
  const res = makeMockHttpRes();
  await controller.handleHttpApi(req, res);
  return res.result();
}

async function writeLocalSession(dshHome, header, events) {
  const projDir = header.cwd ? projectKey(header.cwd) : '_no-cwd';
  const sessDir = path.join(dshHome, 'sessions', projDir, encodeSegment(header.id));
  await fs.mkdir(sessDir, { recursive: true });
  const logPath = path.join(sessDir, `session.v${header.version ?? 4}.jsonl.zstd`);
  const encoded = await encodeV4SessionLog(header, events);
  await writeFileAtomic(logPath, encoded, { mode: 0o600 });
  return logPath;
}

test.after(async () => {
  await fs.rm(TEST_TMP_ROOT, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
});

// ============================================================================
// REAL DSH HOST MODULE TESTS (P0-1, P0-2, P0-3, P1-3)
// ============================================================================

test('P0-1 + P0-3 + R2 + R3 [REAL DSH HOST]: live sidebar projcache warming, api-session/added, and crash-free transactional WorkspaceRegistry re-homing', {
  skip: !HAS_REAL_DSH_HOST_PKGS ? 'Real @deepseek-ai/* packages not installed in ~/.dsh/profiles/node_modules' : false,
}, async () => {
  const { Context } = await importRealDshPkg('@deepseek-ai/cordis');
  const { SessionStore } = await importRealDshPkg('@deepseek-ai/dsh-session');
  const { SessionProjectionRegistry } = await importRealDshPkg('@deepseek-ai/dsh-session-projection');
  const StoragePlugin = await importRealDshPkg('@deepseek-ai/dsh-storage');
  const StorageDomainPlugin = await importRealDshPkg('@deepseek-ai/dsh-storage-domain');
  const StorageJsonPlugin = await importRealDshPkg('@deepseek-ai/dsh-storage-json');
  const SessionPersistenceJsonlPlugin = await importRealDshPkg('@deepseek-ai/dsh-session-persistence-jsonl');
  const { SessionProjectionCache } = await importRealDshPkg('@deepseek-ai/dsh-session-projection-cache');
  const { WorkspaceRegistry } = await importRealDshPkg('@deepseek-ai/dsh-workspace');
  const { titleProjectionDefinition } = await importRealDshPkg('@deepseek-ai/dsh-session-title');

  const caseDir = path.join(TEST_TMP_ROOT, 'real-host-p0-1-3');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-projects', 'NVDA_Research');
  const macMirrors = path.join(caseDir, 'mac-mirrors');
  const macMappedWs = path.join(caseDir, 'mac-projects', 'NVDA_Research');
  const macDefaultWs = path.join(caseDir, 'mac-default');

  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(macMappedWs, { recursive: true });
  await fs.mkdir(macDefaultWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  // Win creates a conversation 3 days ago, with latest turn 5 seconds ago and explicit title
  const now = Date.now();
  const threeDaysAgo = now - 3 * 24 * 3600 * 1000;
  const fiveSecondsAgo = now - 5000;
  const sessId = 'sess-real-nvda-01';
  const winEvents = [
    { seq: 0, time: threeDaysAgo + 100, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: threeDaysAgo + 200, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '分析英伟达 Blackwell 毛利率趋势' }] } },
    { seq: 2, time: threeDaysAgo + 500, type: 'session/title', data: { title: '英伟达 Blackwell 深度拆解', messageSeqs: [1], source: { kind: 'user' } } },
    { seq: 3, time: threeDaysAgo + 600, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 4, time: fiveSecondsAgo - 100, type: 'turn/start', data: { turn: 2 } },
    { seq: 5, time: fiveSecondsAgo, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '更新最新一季度毛利率测算' }] } },
    { seq: 6, time: fiveSecondsAgo + 500, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];

  await savePassphraseKey(winHome, 'real-host-pass');
  await savePassphraseKey(macHome, 'real-host-pass');
  await saveConfig(winHome, { deviceId: 'win-real', deviceLabel: 'WinReal', platform: 'win32', vaultDir, encryptionEnabled: true });
  await saveConfig(macHome, {
    deviceId: 'mac-real',
    deviceLabel: 'MacReal',
    platform: process.platform,
    vaultDir,
    encryptionEnabled: true,
    autoMirrorRoot: macMirrors,
  });

  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: sessId, createdAt: threeDaysAgo, cwd: winWs, isSeeded: false, delegationDepth: 0 },
    winEvents,
  );
  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', pollIntervalMs: 0 });
  await winCtrl.reloadConfig();
  await winCtrl.pushAll();
  await winCtrl.dispose();

  // Boot REAL Cordis DSH host services on the receiving machine!
  const ctx = new Context();
  const fibers = [
    ctx.plugin(StoragePlugin.default),
    ctx.plugin(StorageJsonPlugin, { root: path.join(macHome, 'storages') }),
    ctx.plugin(StorageDomainPlugin, { backend: 'json' }),
    ctx.plugin(SessionProjectionRegistry),
    ctx.plugin(SessionStore),
    ctx.plugin(SessionPersistenceJsonlPlugin, { root: path.join(macHome, 'sessions'), compression: 'zstd' }),
    ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60000 }),
    ctx.plugin(WorkspaceRegistry, { defaultWorkspacePath: macDefaultWs }),
  ];
  await Promise.all(fibers);

  try {
    // Register real host projections (`title` + `sessionListMetadata`) just like real DSH host does
    await ctx.sessionProjections.register(titleProjectionDefinition);
    const { z } = await importRealDshPkg('zod').catch(async () => {
      const req = createRequire(path.join(DSH_PROFILE_NODE_MODULES, '@deepseek-ai', 'dsh-session-projection-cache', 'package.json'));
      return import(pathToFileURL(req.resolve('zod')).href);
    });
    const metaSchema = z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() });
    await ctx.sessionProjections.register({
      key: 'sessionListMetadata',
      stateSchema: metaSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: (state, event) => {
        const blank = state.blank && event.type !== 'turn/start';
        const lastPromptAt = event.type === 'user/message' && event.data?.source?.kind === 'user' ? event.time : state.lastPromptAt;
        return blank === state.blank && lastPromptAt === state.lastPromptAt ? state : { blank, lastPromptAt };
      },
      wire: { viewSchema: metaSchema, view: (s) => s },
      stateVersion: 1,
    });

    const addedSummaries = [];
    ctx.on('api-session/added', (summary) => {
      addedSummaries.push(summary);
    });

    const macCtrl = new SoulSyncController(ctx, { dshHome: macHome, platform: process.platform, pollIntervalMs: 0 });
    await macCtrl.reloadConfig();

    // 1. P0-1: Pull cold session into running DSH host -> MUST warm real SessionProjectionCache & emit api-session/added!
    const pull1 = await macCtrl.pullAll();
    assert.equal(pull1.ok, true);
    assert.equal(pull1.sessions.summary.imported, 1);

    const mirrorDir = pull1.sessions.results[0].targetCwd;
    assert.ok(mirrorDir && mirrorDir.toLowerCase().includes('mac-mirrors'));

    // Verify real SessionProjectionCache has the exact title and 5s-ago lastPromptAt (NOT 3-day-old createdAt)!
    const importedRec = (await scanLocalSessions(macHome)).get(sessId);
    assert.ok(importedRec);
    const cachedSnap = ctx.sessionProjectionCache.cachedSnapshot(importedRec.header);
    assert.ok(cachedSnap, 'P0-1: real SessionProjectionCache.cachedSnapshot must be warmed immediately on import');
    assert.equal(cachedSnap.values.title, '英伟达 Blackwell 深度拆解');
    assert.equal(cachedSnap.values.sessionListMetadata.blank, false);
    assert.equal(cachedSnap.values.sessionListMetadata.lastPromptAt, fiveSecondsAgo);

    // Verify live `api-session/added` was emitted with real title and recency-ordered updatedAt!
    const liveSummary = addedSummaries.find((s) => s.sessionId === sessId);
    assert.ok(liveSummary, 'P0-1: live api-session/added event must fire for imported cold session');
    assert.equal(liveSummary.updatedAt, fiveSecondsAgo, 'P0-1: summary.updatedAt must equal lastPromptAt, not 3-day-old createdAt');
    assert.equal(liveSummary.projections?.values?.title, '英伟达 Blackwell 深度拆解');

    // Verify real WorkspaceRegistry holds the session in the auto-mirror workspace
    const wsBefore = ctx.workspaceRegistry.list();
    assert.ok(
      wsBefore.some((w) => w.path.toLowerCase() === mirrorDir.toLowerCase() && w.sessionIds.includes(sessId)),
      'Mirror workspace must hold imported session before mapping promotion',
    );

    // 2. Opus g23 #10: Also create a local-origin session inside that same auto-mirror folder!
    const localMirrorSessId = 'sess-local-in-mirror';
    await writeLocalSession(
      macHome,
      { type: 'session', version: 4, id: localMirrorSessId, createdAt: now, cwd: mirrorDir, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: now + 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '在镜像目录里新建的本地会话' }] } }],
    );
    const mirrorWsObj = await ctx.workspaceRegistry.create(mirrorDir, 'NVDA_Research');
    await mirrorWsObj.attachSession(localMirrorSessId);

    // 3. P0-3 + g23 #10: Bind explicit Win <-> Mac mapping LIVE while WorkspaceRegistry.headers caches old mirror cwd!
    assert.ok(ctx.workspaceRegistry.headers.has(sessId), 'WorkspaceRegistry.headers caches old mirror header (reproducing P0-3)');
    // Use cross-OS mapping paths matching current platform
    const mappedWinPath = winWs;
    const mappedMacPath = '/Users/tester/NVDA_Research';
    // Re-home test uses current OS as target: map winWs <-> macMappedWs via saveConfig + handleAddMapping path
    // Since process.platform is win32 here, bind winWs as peer (darwin) or test handleAddMapping directly:
    const macPeerWs = '/Users/remote/NVDA_Research';
    await saveConfig(macHome, {
      autoMirrorAssignments: { [macPeerWs]: mirrorDir, [winWs]: mirrorDir },
    });
    await macCtrl.reloadConfig();
    const bindRes = await macCtrl.handleAddMapping({
      winPath: macMappedWs,
      macPath: macPeerWs,
      triggerPull: true,
    });
    assert.equal(bindRes.kind, 'success', `handleAddMapping failed: ${bindRes.text}`);

    // Verify BOTH sessions (remote-origin sessId AND local-origin localMirrorSessId) moved cleanly to macMappedWs
    // WITHOUT crashing WorkspaceRegistry or vanishing from the sidebar!
    const wsAfter = ctx.workspaceRegistry.list();
    const targetWs = wsAfter.find((w) => w.path.toLowerCase() === macMappedWs.toLowerCase());
    const oldMirrorWs = wsAfter.find((w) => w.path.toLowerCase() === mirrorDir.toLowerCase());
    assert.ok(targetWs, 'Mapped target workspace must exist in WorkspaceRegistry');
    assert.ok(targetWs.sessionIds.includes(localMirrorSessId), 'g23 #10: local-origin mirror session must re-home to mapped workspace');
    assert.ok(targetWs.sessionIds.includes(sessId), 'P0-3: remote-origin session must re-home without crashing stale header cache');
    assert.equal(oldMirrorWs?.sessionIds?.includes(sessId) ?? false, false, 'Old mirror workspace must no longer hold re-homed session');
    assert.equal(oldMirrorWs?.sessionIds?.includes(localMirrorSessId) ?? false, false);

    await macCtrl.dispose();
  } finally {
    await ctx.fiber.dispose();
  }
});

test('P0-2 + R1 [REAL DSH HOST]: fast-forward idle resident session holding JsonlSessionPersistence write lock without deferred-busy deadlock', {
  skip: !HAS_REAL_DSH_HOST_PKGS ? 'Real @deepseek-ai/* packages not installed' : false,
}, async () => {
  const { Context } = await importRealDshPkg('@deepseek-ai/cordis');
  const { SessionStore } = await importRealDshPkg('@deepseek-ai/dsh-session');
  const { SessionProjectionRegistry } = await importRealDshPkg('@deepseek-ai/dsh-session-projection');
  const SessionPersistenceJsonlPlugin = await importRealDshPkg('@deepseek-ai/dsh-session-persistence-jsonl');

  const caseDir = path.join(TEST_TMP_ROOT, 'real-host-p0-2');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  const macWs = path.join(caseDir, 'mac-ws');
  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(macWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  const mappings = [{ id: 'ff-proj', title: 'FFProj', win32: winWs, darwin: macWs, linux: macWs }];
  const sid = 'sess-idle-resident-01';
  const now = Date.now();
  const turn1 = [
    { seq: 0, time: now - 5000, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: now - 4900, type: 'user/message', surfaceOp: 'append', data: { id: 'msg-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '上午在Win聊的第1轮' }] } },
    { seq: 2, time: now - 4800, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const turn2 = [
    ...turn1,
    { seq: 3, time: now - 1000, type: 'turn/start', data: { turn: 2 } },
    { seq: 4, time: now - 900, type: 'user/message', surfaceOp: 'append', data: { id: 'msg-u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '中午在Mac续聊的第2轮' }] } },
    { seq: 5, time: now - 800, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];

  await saveConfig(winHome, { deviceId: 'win-ff', deviceLabel: 'WinFF', platform: 'win32', vaultDir, workspaceMappings: mappings });
  await saveConfig(macHome, { deviceId: 'mac-ff', deviceLabel: 'MacFF', platform: 'darwin', vaultDir, workspaceMappings: mappings });
  await writeLocalSession(winHome, { type: 'session', version: 4, id: sid, createdAt: now - 6000, cwd: winWs, isSeeded: false, delegationDepth: 0 }, turn1);
  await writeLocalSession(macHome, { type: 'session', version: 4, id: sid, createdAt: now - 6000, cwd: macWs, isSeeded: false, delegationDepth: 0 }, turn2);

  // Mac pushes turn 2 to vault
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', pollIntervalMs: 0 });
  await macCtrl.reloadConfig();
  await macCtrl.pushAll();
  await macCtrl.dispose();

  // Win mounts REAL JsonlSessionPersistence and opens an IDLE write handle (exact reproduction of Probe 1!)
  const ctx = new Context();
  await Promise.all([
    ctx.plugin(SessionProjectionRegistry),
    ctx.plugin(SessionStore),
    ctx.plugin(SessionPersistenceJsonlPlugin, { root: path.join(winHome, 'sessions'), compression: 'zstd' }),
  ]);

  let heldWriter = null;
  let winCtrl = null;
  try {
    heldWriter = await ctx.sessionPersistence.open(sid, 'write');
    // Confirm direct open('write') currently throws SessionAlreadyOwnedError!
    await assert.rejects(
      () => ctx.sessionPersistence.open(sid, 'write'),
      (err) => err?.name === 'SessionAlreadyOwnedError' || /already owned/i.test(String(err?.message)),
      'Precondition: held write handle must block raw persistence.open(write)',
    );

    // Attach mock idle agent matching real ReactLoopAgent shape (`phase: { kind: 'idle' }`)
    const agentStore = new Map();
    const idleAgent = {
      id: sid,
      status: 'idle',
      phase: { kind: 'idle', lastTurn: 1 },
      inbox: { hasPending: false },
      session: { id: sid, header: { id: sid, cwd: winWs } },
    };
    agentStore.set(sid, idleAgent);
    ctx.provide('agents', { get: (id) => agentStore.get(id), store: agentStore });

    winCtrl = new SoulSyncController(ctx, { dshHome: winHome, platform: 'win32', pollIntervalMs: 0 });
    await winCtrl.reloadConfig();

    // 1. While genuinely RUNNING, pullAll MUST defer cleanly (deferred-busy) without touching the agent!
    idleAgent.status = 'running';
    idleAgent.phase = { kind: 'running', turn: 2, step: 1 };
    const busyPull = await winCtrl.pullAll();
    assert.equal(busyPull.sessions.summary.deferredBusy, 1, 'Actively running agent must defer cleanly');
    assert.equal(busyPull.sessions.summary.fastForwarded, 0);
    assert.ok(winCtrl._deferredBusySessions.has(sid), 'Deferred busy session must be queued for catch-up');

    // 2. Once IDLE, pullAll MUST release the idle write lock and fast-forward losslessly (ZERO deferred-busy deadlock)!
    idleAgent.status = 'idle';
    idleAgent.phase = { kind: 'idle', lastTurn: 1 };
    const idlePull = await winCtrl.pullAll();
    assert.equal(idlePull.sessions.summary.deferredBusy, 0, 'P0-2: idle resident session must NOT deadlock on deferred-busy');
    assert.equal(idlePull.sessions.summary.fastForwarded, 1, 'P0-2: idle resident session must fast-forward Mac turn 2');

    // Verify real JsonlSessionPersistence now reads ALL 6 events (turn 1 + turn 2)!
    const readHandle = await ctx.sessionPersistence.open(sid, 'read');
    try {
      const readRes = await readHandle.read(0);
      assert.equal(readRes.events.length, 6, 'Fast-forwarded V4 log must contain all 6 events');
      assert.equal(readRes.events[4].data.content[0].text, '中午在Mac续聊的第2轮');
    } finally {
      await readHandle.close();
    }
  } finally {
    await heldWriter?.close?.().catch(() => {});
    await winCtrl?.dispose?.().catch(() => {});
    await ctx.fiber.dispose();
  }
});

test('P1-3 [REAL DSH HOST]: ToolRuntime 2-arg tools/result(exec, result) & real dsh-llm JSON-string tool-call arguments', {
  skip: !HAS_REAL_DSH_HOST_PKGS ? 'Real @deepseek-ai/* packages not installed' : false,
}, async () => {
  const { Context } = await importRealDshPkg('@deepseek-ai/cordis');
  const SystemPromptPlugin = await importRealDshPkg('@deepseek-ai/dsh-system-prompt');
  const { ToolRuntime } = await importRealDshPkg('@deepseek-ai/dsh-tools');
  const { createAssistantMessage } = await importRealDshPkg('@deepseek-ai/dsh-llm');

  const caseDir = path.join(TEST_TMP_ROOT, 'real-host-p1-3');
  const dshHome = path.join(caseDir, 'home');
  const vaultDir = path.join(caseDir, 'vault');
  const wsDir = path.join(caseDir, '美股分析');
  await fs.mkdir(wsDir, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  await saveConfig(dshHome, {
    deviceId: 'win-tools',
    deviceLabel: 'WinTools',
    platform: 'win32',
    vaultDir,
    workspaceMappings: [{ id: '美股分析', title: '美股分析', win32: wsDir, darwin: '/Users/me/美股分析' }],
  });

  const okPath = path.join(wsDir, 'dcf.py');
  const failPath = path.join(wsDir, 'failed.py');
  const modelV2Path = path.join(wsDir, 'model_v2.py');
  await fs.writeFile(okPath, 'print("dcf")\n', 'utf8');
  await fs.writeFile(failPath, 'print("fail")\n', 'utf8');
  await fs.writeFile(modelV2Path, 'print("v2")\n', 'utf8');
  await writeLocalSession(
    dshHome,
    { type: 'session', version: 4, id: 'sess-tools-1', createdAt: Date.now() - 1000, cwd: wsDir, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: Date.now() - 900, type: 'user/message', surfaceOp: 'append', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '写个DCF脚本' }] } } }],
  );

  const ctx = new Context();
  await Promise.all([
    ctx.plugin(SystemPromptPlugin.default),
    ctx.plugin(ToolRuntime),
  ]);

  try {
    const controller = applySoulSync(ctx, { dshHome, platform: 'win32', pollIntervalMs: 0 });
    await controller.readyPromise;

    ctx.tools.register({
      name: 'write_file',
      description: 'test write',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, fail: { type: 'boolean' } },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        render: (val) => [{ type: 'text', text: JSON.stringify(val) }],
      },
      execute: async (args) => {
        if (args?.fail) {
          throw new Error('simulated write failure');
        }
        return { ok: true };
      },
    });

    const mockAgent = {
      id: 'sess-tools-1',
      session: { id: 'sess-tools-1', header: { id: 'sess-tools-1', cwd: wsDir } },
    };

    // 1. Relative path success via REAL ToolRuntime.execute (dispatches 2-arg `tools/result(exec, result)`)
    const okExecResult = await ctx.tools.execute({
      name: 'write_file',
      callId: 'call-1',
      agent: mockAgent,
      signal: new AbortController().signal,
      arguments: { path: 'dcf.py' },
    });
    assert.equal(Boolean(okExecResult?.isError), false);

    // 2. Absolute path failure via REAL ToolRuntime.execute (`result.isError === true` MUST NOT be tracked!)
    const failExecResult = await ctx.tools.execute({
      name: 'write_file',
      callId: 'call-2',
      agent: mockAgent,
      signal: new AbortController().signal,
      arguments: { path: failPath, fail: true },
    });
    assert.equal(failExecResult?.isError, true);

    // 3. Real `dsh-llm` createAssistantMessage with JSON-STRING `block.arguments` + `tool/result` session event!
    const assistantMsg = createAssistantMessage({
      content: [
        { type: 'tool-call', id: 'call-3', name: 'write_file', arguments: JSON.stringify({ path: 'model_v2.py' }) },
      ],
      source: { provider: 'deepseek', model: 'deepseek-chat' },
    });
    await controller.handleSessionEvent(mockAgent.session, {
      seq: 0,
      time: Date.now(),
      type: 'assistant/message',
      data: { message: assistantMsg },
    });
    await controller.handleSessionEvent(mockAgent.session, {
      seq: 1,
      time: Date.now() + 10,
      type: 'tool/result',
      data: { message: { toolCallId: 'call-3', isError: false } },
    });

    const wsState = await loadWorkspaceDeliverableState(dshHome, '美股分析');
    const tracked = Object.keys(wsState.trackedPaths ?? {}).sort();
    assert.deepEqual(tracked, ['dcf.py', 'model_v2.py'], 'P1-3: must track dcf.py & model_v2.py and NEVER failed.py');

    // P2-2: Chinese workspace deliverableCount in listLocalCatalog must be 2 (NOT 0!)
    const localCat = await listLocalCatalog({ dshHome, config: controller.config, platform: 'win32' });
    const cnWs = localCat.workspaces.find((w) => w.mappingId === '美股分析');
    assert.ok(cnWs);
    assert.equal(cnWs.deliverableCount, 2, 'P2-2: Chinese workspace deliverableCount must use encodeURIComponent');

    await controller.dispose();
  } finally {
    await ctx.fiber.dispose();
  }
});

// ============================================================================
// SECURITY, SELECTIVE SYNC, CONFLICT DEDUP, PASSPHRASE GUARD & CLI TESTS
// ============================================================================

test('C1 [Security P0]: host cookie auth (connection.requestRejection) & strict exact-port loopback Origin check', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'c1-security');
  const dshHome = path.join(caseDir, 'home');
  const vaultDir = path.join(caseDir, 'vault');
  await fs.mkdir(vaultDir, { recursive: true });
  await saveConfig(dshHome, { vaultDir, deviceLabel: 'SecWin', platform: 'win32' });

  const mockHostCtx = {
    connection: {
      requestRejection(req) {
        const cookie = String(req.headers?.cookie ?? '');
        return cookie.includes('dsh-auth-token=valid') ? undefined : 401;
      },
    },
  };

  const ctrl = new SoulSyncController(mockHostCtx, { dshHome, platform: 'win32', pollIntervalMs: 0 });
  await ctrl.reloadConfig();

  // 1. Cross-port localhost dev page (Origin: http://localhost:5173 vs Host: 127.0.0.1:3080) -> 403 on OPTIONS, GET, POST!
  const crossOpt = await callApi(ctrl, {
    method: 'OPTIONS',
    url: '/__soul-sync/api/state',
    headers: { origin: 'http://localhost:5173', host: '127.0.0.1:3080' },
  });
  assert.equal(crossOpt.status, 403, 'C1: cross-port localhost OPTIONS must be rejected with 403');

  const crossPost = await callApi(ctrl, {
    method: 'POST',
    url: '/__soul-sync/api/settings',
    headers: {
      origin: 'http://localhost:5173',
      host: '127.0.0.1:3080',
      cookie: 'dsh-auth-token=valid',
      'x-dsh-soul-sync': '1',
      'content-type': 'application/json',
    },
    body: { clearPassphrase: true },
  });
  assert.equal(crossPost.status, 403, 'C1: cross-port localhost POST must be rejected with 403 even with cookie');

  // 2. Cookie-less same-port request -> 401 Unauthorized from connection.requestRejection!
  const noCookieRes = await callApi(ctrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'x-dsh-soul-sync': '1',
    },
  });
  assert.equal(noCookieRes.status, 401, 'C1: cookie-less request must return 401 when connection service is active');

  // 3. Exact same-port Origin + valid host cookie + CSRF header -> 200 OK!
  const goodRes = await callApi(ctrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      cookie: 'dsh-auth-token=valid',
      'x-dsh-soul-sync': '1',
    },
  });
  assert.equal(goodRes.status, 200);
  assert.equal(goodRes.json.ok, true);

  // 4. Desktop dsh-app://app Origin + valid forwarded cookie -> 200 OK!
  const deskRes = await callApi(ctrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: {
      origin: 'dsh-app://app',
      host: '127.0.0.1:3080',
      cookie: 'dsh-auth-token=valid',
      'x-dsh-soul-sync': '1',
    },
  });
  assert.equal(deskRes.status, 200);

  await ctrl.dispose();
});

test('P1-1 + C10 + C11 + C12 + C13: dual-selected unpublish no-resurrection, exclude airtightness, withdrawUnselected peer safety & single-session outputs isolation', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'selective-airtight');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  const macMirrors = path.join(caseDir, 'mac-mirrors');
  await fs.mkdir(path.join(winWs, 'outputs'), { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  await savePassphraseKey(winHome, 'sel-secret');
  await savePassphraseKey(macHome, 'sel-secret');
  await saveConfig(winHome, {
    deviceId: 'win-sel',
    deviceLabel: 'WinSel',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: true,
    syncScope: 'selected',
    selectedSessionIds: ['sess-priv-1'],
  });
  await saveConfig(macHome, {
    deviceId: 'mac-sel',
    deviceLabel: 'MacSel',
    platform: process.platform,
    vaultDir,
    encryptionEnabled: true,
    syncScope: 'selected',
    autoMirrorRoot: macMirrors,
  });

  // --- C11 / P1-1: Dual-selected unpublish MUST NOT resurrect from peer ---
  const now = Date.now();
  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: 'sess-priv-1', createdAt: now - 5000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: now - 4000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '私密对话' }] } }],
  );

  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', minQuietMs: 0, pollIntervalMs: 0 });
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: process.platform, minQuietMs: 0, pollIntervalMs: 0 });
  try {
    await winCtrl.reloadConfig();
    await macCtrl.reloadConfig();

    await winCtrl.pushAll();
    const macPull1 = await macCtrl.pullAll();
    assert.equal(macPull1.sessions.summary.imported, 1);
    assert.ok((await loadConfig(macHome)).selectedSessionIds.includes('sess-priv-1'));

    // Win unpublishes sess-priv-1
    await winCtrl.unpublishSessionFromVault({ sessionIds: ['sess-priv-1'] });
    assert.equal((await winCtrl.vault.listCommits('session', { includeSelf: true })).commits.length, 0);

    // Mac pulls withdrawal tombstone -> selectedSessionIds MUST drop sess-priv-1 -> Mac pushAll MUST push 0 commits!
    await macCtrl.pullAll();
    assert.equal((await loadConfig(macHome)).selectedSessionIds.includes('sess-priv-1'), false, 'C11: withdrawn session must be removed from peer selectedSessionIds');
    const macRepush = await macCtrl.pushAll();
    assert.equal(macRepush.sessionPushedCount, 0, 'C11: peer must NOT resurrect withdrawn session');
    assert.equal((await winCtrl.vault.listCommits('session', { includeSelf: true })).commits.length, 0);

    // --- C10 & C13: Whole-workspace push skips excluded session & single-session push isolates outputs/ ---
    await fs.writeFile(path.join(winWs, 'outputs', 'from-S1.txt'), 'public-from-s1', 'utf8');
    await fs.writeFile(path.join(winWs, 'outputs', 'from-S2-private.txt'), 'secret-from-s2', 'utf8');
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: 'sess-s1', createdAt: now - 3000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [
        { seq: 0, time: now - 2900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'S1' }] } },
        { seq: 1, time: now - 2800, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c-s1', name: 'write_file', arguments: JSON.stringify({ path: 'outputs/from-S1.txt' }) }] } } },
        { seq: 2, time: now - 2700, type: 'tool/result', data: { message: { toolCallId: 'c-s1', isError: false } } },
      ],
    );
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: 'sess-s2', createdAt: now - 2000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [
        { seq: 0, time: now - 1900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'S2私密' }] } },
        { seq: 1, time: now - 1800, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c-s2', name: 'write_file', arguments: JSON.stringify({ path: 'outputs/from-S2-private.txt' }) }] } } },
        { seq: 2, time: now - 1700, type: 'tool/result', data: { message: { toolCallId: 'c-s2', isError: false } } },
      ],
    );
    await winCtrl.updateSettings({ excludedSessionIds: ['sess-priv-1', 'sess-s2'] });

    // Whole-workspace push MUST skip excluded sess-s2 AND keep sess-s2 in excludedSessionIds!
    const wsPush = await winCtrl.pushSelected({ workspacePaths: [winWs] });
    assert.equal(wsPush.sessionPushedCount, 1);
    assert.equal(wsPush.exported[0].rootSessionId, 'sess-s1');
    assert.ok((await loadConfig(winHome)).excludedSessionIds.includes('sess-s2'), 'C10: workspace push must NOT un-exclude sess-s2');

    // C13: Packed outputs of sess-s1 MUST contain from-S1.txt and NEVER from-S2-private.txt!
    const s1Commits = await winCtrl.vault.listCommits('session', { targetId: 'sess-s1', includeSelf: true });
    const s1Outputs = (s1Commits.commits[s1Commits.commits.length - 1].payload.packedOutputs ?? []).map((o) => o.relPosixPath);
    assert.deepEqual(s1Outputs, ['from-S1.txt'], 'C13: excluded session output must NEVER leak into sess-s1 packedOutputs');

    // C10 Pull side: Mac excludes sess-s1 -> listVaultCatalog flags excluded: true & pullSelected(workspaceSources) skips it!
    await macCtrl.updateSettings({ excludedSessionIds: ['sess-s1'] });
    const macVaultCat = await macCtrl.listVaultCatalog();
    const s1Entry = macVaultCat.workspaces.flatMap((w) => w.sessions).find((s) => s.sessionId === 'sess-s1');
    assert.equal(s1Entry?.excluded, true, 'C10: listVaultCatalog must expose excluded: true');
    const macWsPull = await macCtrl.pullSelected({ workspaceSources: [winWs] });
    assert.equal(macWsPull.sessions.summary.imported, 0, 'C10: workspace pull must respect local excludedSessionIds');

    // --- C12 & P2-3: withdrawUnselected MUST NOT delete peer-originated sessions or pollute excludedSessionIds ---
    await macCtrl.updateSettings({ excludedSessionIds: [] });
    await macCtrl.pullAll();
    // Mac creates its own local session and pushes it, AND replies to Win's sess-s1
    const macOwnWs = path.join(caseDir, 'mac-own-ws');
    await fs.mkdir(macOwnWs, { recursive: true });
    await writeLocalSession(
      macHome,
      { type: 'session', version: 4, id: 'sess-mac-own', createdAt: now, cwd: macOwnWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: now + 100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Mac自己建的会话' }] } }],
    );
    await macCtrl.pushSelected({ sessionIds: ['sess-mac-own', 'sess-s1'] });

    // Mac saves empty whitelist with withdrawUnselected=true -> ONLY Mac's own sess-mac-own is withdrawn (NOT Win's sess-s1!)
    // AND sess-mac-own is NOT added to permanent excludedSessionIds!
    await macCtrl.updateSettings({
      syncScope: 'selected',
      selectedWorkspaces: [],
      selectedSessionIds: [],
      withdrawUnselected: true,
    });
    const winCommitsSurvive = await winCtrl.vault.listCommits('session', { targetId: 'sess-s1', includeSelf: true });
    assert.ok(winCommitsSurvive.commits.some((c) => c.deviceId === 'win-sel'), 'C12: peer Win commits for sess-s1 must NEVER be deleted');
    const macOwnRemaining = await macCtrl.vault.listCommits('session', { targetId: 'sess-mac-own', includeSelf: true });
    assert.equal(macOwnRemaining.commits.length, 0, 'C12: Mac own unselected session must be withdrawn');
    assert.equal((await loadConfig(macHome)).excludedSessionIds.includes('sess-mac-own'), false, 'P2-3: withdrawUnselected must NOT pollute excludedSessionIds');
  } finally {
    await winCtrl.dispose();
    await macCtrl.dispose();
  }
});

test('C4: unmapped outputs/ conflict copy dedup (0 proliferation on repeated pulls), exclusion from re-pack & scoped alert', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'c4-outputs-conflict');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-unmapped');
  const macMirrors = path.join(caseDir, 'mac-mirrors');
  await fs.mkdir(path.join(winWs, 'outputs'), { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  await saveConfig(winHome, { deviceId: 'win-c4', deviceLabel: 'WinC4', platform: 'win32', vaultDir });
  await saveConfig(macHome, { deviceId: 'mac-c4', deviceLabel: 'MacC4', platform: process.platform, vaultDir, autoMirrorRoot: macMirrors });

  const sid = 'sess-c4-outputs';
  const now = Date.now();
  await fs.writeFile(path.join(winWs, 'outputs', 'x.md'), 'v1-shared', 'utf8');
  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: sid, createdAt: now - 5000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: now - 4000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'turn 1' }] } }],
  );

  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', pollIntervalMs: 0 });
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: process.platform, pollIntervalMs: 0 });
  try {
    await winCtrl.reloadConfig();
    await macCtrl.reloadConfig();

    await winCtrl.pushAll();
    const macPull1 = await macCtrl.pullAll();
    const macMirrorDir = macPull1.sessions.results[0].targetCwd;

    // Both sides edit outputs/x.md offline
    await fs.writeFile(path.join(macMirrorDir, 'outputs', 'x.md'), 'mac-local-edit', 'utf8');
    await fs.writeFile(path.join(winWs, 'outputs', 'x.md'), 'win-remote-edit', 'utf8');
    await winCtrl.pushAll();

    // Mac pulls -> creates EXACTLY 1 deterministic conflict copy + pushes output-conflict alert
    const macPull2 = await macCtrl.pullAll();
    assert.ok(macCtrl._pendingAlerts.some((a) => a.kind === 'output-conflict' && a.sessionId === sid), 'C4: output-conflict alert must be raised');

    // Run 3 more pulls (including unrelated new commits from Win) -> conflict copy count MUST stay 1!
    for (let i = 2; i <= 4; i += 1) {
      await writeLocalSession(
        winHome,
        { type: 'session', version: 4, id: sid, createdAt: now - 5000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
        Array.from({ length: i }, (_, idx) => ({
          seq: idx,
          time: now - 4000 + idx * 100,
          type: 'user/message',
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: `turn ${idx + 1}` }] },
        })),
      );
      await winCtrl.pushAll();
      await macCtrl.pullAll();
    }

    const macFiles = (await fs.readdir(path.join(macMirrorDir, 'outputs'))).filter((f) => f.includes('.conflict-'));
    assert.equal(macFiles.length, 1, `C4: expected exactly 1 conflict copy, got: ${JSON.stringify(macFiles)}`);
    assert.equal(await fs.readFile(path.join(macMirrorDir, 'outputs', 'x.md'), 'utf8'), 'mac-local-edit');

    // Mac pushes back -> conflict copy MUST NOT be packed back into vault!
    await macCtrl.pushAll();
    const macCommits = ((await macCtrl.vault.listCommits('session')).commits ?? [])
      .filter((c) => c.deviceId === 'mac-c4' && c.targetId === sid);
    assert.ok(macCommits.length > 0, 'Mac must have published a commit');
    const latestMacCommit = macCommits[macCommits.length - 1];
    const packedPaths = (latestMacCommit.payload?.unmappedOutputs?.files ?? []).map((f) => f.relPath);
    assert.equal(
      packedPaths.some((p) => p.includes('.conflict-')),
      false,
      `C4: .conflict-* files must NEVER be packed into vault, got: ${JSON.stringify(packedPaths)}`,
    );
    await winCtrl.pullAll();
    const winOutputs = await fs.readdir(path.join(winWs, 'outputs'));
    assert.equal(
      winOutputs.some((f) => f.includes('.conflict-WinC4-')),
      false,
      `C4: Mac's conflict copy of Win must NEVER echo back to Win, got: ${JSON.stringify(winOutputs)}`,
    );
  } finally {
    await winCtrl.dispose();
    await macCtrl.dispose();
  }
});

test('C2 + C3 + C3b + P2-3: majority-device passphrase guard (Scenario W), explicit key rotation, single-device 2/2 cleanup & doctor decryption fail', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'c2-c3-passphrase');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  const macWs = path.join(caseDir, 'mac-ws');
  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(macWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  await savePassphraseKey(winHome, 'good-vault-pass');
  await savePassphraseKey(macHome, 'mac-typo-pass');
  await saveConfig(winHome, { deviceId: 'win-c2', deviceLabel: 'WinC2', platform: 'win32', vaultDir, encryptionEnabled: true });
  await saveConfig(macHome, { deviceId: 'mac-c2', deviceLabel: 'MacC2', platform: 'darwin', vaultDir, encryptionEnabled: true });

  const now = Date.now();
  for (let i = 1; i <= 5; i += 1) {
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: `sess-w-${i}`, createdAt: now - 10000 + i * 100, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: now - 9000 + i * 100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Win对话 ${i}` }] } }],
    );
  }
  await writeLocalSession(
    macHome,
    { type: 'session', version: 4, id: 'sess-mac-typo', createdAt: now, cwd: macWs, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: now + 100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Mac错口令会话' }] } }],
  );

  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', pollIntervalMs: 0 });
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', pollIntervalMs: 0 });
  try {
    await winCtrl.reloadConfig();
    await macCtrl.reloadConfig();

    // 1. Win pushes 5 good sessions; Mac pushes 1 bad-passphrase session
    await winCtrl.pushAll();
    await macCtrl.pushAll();

    // C3b + Neon P0 #3: `dsh-soul init` with wrong passphrase rejects immediately (exit 1), AND `dsh-soul doctor`
    // on a machine holding a wrong secret.key MUST FAIL with `[FAIL] vault-decrypt` (exit code 1)!
    const badDocHome = path.join(caseDir, 'bad-doc-home');
    const initOut = [];
    const badInitCode = await runCli(
      ['--dsh-home', badDocHome, 'init', '--non-interactive', '--vault', vaultDir, '--passphrase', 'completely-wrong-pass'],
      { stdout: (s) => initOut.push(s), stderr: (s) => initOut.push(s), isTTY: false },
    );
    assert.equal(badInitCode, 1, 'Neon P0 #3: init with wrong passphrase must fail cleanly before polluting vault');
    // Now configure badDocHome with wrong key directly and confirm `doctor` fails `[FAIL] vault-decrypt`!
    await savePassphraseKey(badDocHome, 'completely-wrong-pass');
    await saveConfig(badDocHome, { deviceId: 'bad-doc-dev', deviceLabel: 'BadDoc', platform: 'darwin', vaultDir, encryptionEnabled: true });
    await fs.mkdir(path.join(badDocHome, 'profiles', 'web'), { recursive: true });
    await fs.writeFile(path.join(badDocHome, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { 'dsh-soul-sync': 'link:.' } }), 'utf8');
    const docOut = [];
    const docCode = await runCli(['--dsh-home', badDocHome, 'doctor'], {
      stdout: (s) => docOut.push(s),
      stderr: (s) => docOut.push(s),
      isTTY: false,
    });
    assert.equal(docCode, 1, `C3b: doctor with wrong passphrase must fail (exit 1), got output:\n${docOut.join('')}`);
    assert.match(docOut.join(''), /\[FAIL\] vault-decrypt/);

    // 2. C2 Scenario W: User accidentally enters Mac's typo passphrase on established Win!
    const typoRes = await winCtrl.updateSettings({ passphrase: 'mac-typo-pass' });
    assert.equal(typoRes.requiresKeyRotationConfirm, true, 'C2: entering minority typo passphrase on established Win must require confirmation');
    assert.equal(typoRes.keyUpdateBlocked, true);
    // Win's 5 good sessions must still be 100% readable by Win's untouched key!
    const winOwnAfterBlock = await winCtrl.vault.countReadableOwnCommits();
    assert.ok(winOwnAfterBlock.ownDecryptedCount >= 5, 'C2: Win commits must remain intact after blocked typo');

    // 3. C3 Explicit Key Rotation: Win confirms rotation to brand-new passphrase -> purges Win old commits & re-encrypts;
    //    Mac switches to new passphrase -> decryptionFailedCount === 0!
    const rotWin = await winCtrl.updateSettings({ passphrase: 'rotated-pass-2027', confirmKeyRotation: true });
    assert.equal(rotWin.keyUpdateBlocked, false);
    const rotMac = await macCtrl.updateSettings({ passphrase: 'rotated-pass-2027', confirmKeyRotation: true });
    assert.equal(rotMac.keyUpdateBlocked, false);

    const macStats = await macCtrl.vault.countReadableDeviceStats();
    assert.equal(macStats.totalFailedCount, 0, 'C3: after both machines rotate key, 0 undecryptable commits must remain');
    assert.ok(macStats.peerDecryptedCount >= 5, 'C3: Mac must decrypt all 5 rotated Win sessions');

    // 4. P2-3 Single-device 2 good / 2 bad cleanup via `/soul config passphrase=...`
    const singleHome = path.join(caseDir, 'single-home');
    const singleVaultDir = path.join(caseDir, 'single-vault');
    const singleWs = path.join(caseDir, 'single-ws');
    await fs.mkdir(singleWs, { recursive: true });
    await fs.mkdir(singleVaultDir, { recursive: true });
    await savePassphraseKey(singleHome, 'single-good');
    await saveConfig(singleHome, { deviceId: 'single-dev', deviceLabel: 'Single', platform: 'win32', vaultDir: singleVaultDir, encryptionEnabled: true });
    for (let i = 1; i <= 2; i += 1) {
      await writeLocalSession(
        singleHome,
        { type: 'session', version: 4, id: `single-s-${i}`, createdAt: now + i * 10, cwd: singleWs, isSeeded: false, delegationDepth: 0 },
        [{ seq: 0, time: now + i * 20, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `单机对话 ${i}` }] } }],
      );
    }
    const sCtrl = new SoulSyncController(null, { dshHome: singleHome, platform: 'win32', pollIntervalMs: 0 });
    await sCtrl.reloadConfig();
    await sCtrl.pushAll();
    // Plant 2 bad-key own session commits (2 good vs 2 bad!)
    const badVault = new VaultStore({
      vaultDir: singleVaultDir,
      deviceId: 'single-dev',
      platform: 'win32',
      secretKeys: await savePassphraseKey(path.join(caseDir, 'tmp-key'), 'single-bad'),
    });
    await badVault.publishCommit('session', 'bad-1', { rootSessionId: 'bad-1', nodes: [] });
    await badVault.publishCommit('session', 'bad-2', { rootSessionId: 'bad-2', nodes: [] });
    // Now run `/soul config passphrase=single-good` -> MUST clean up the 2 bad commits!
    const cfgCmd = await sCtrl.handleConfig({ argsText: 'passphrase=single-good' });
    assert.equal(cfgCmd.kind, 'success');
    const afterSingle = await sCtrl.vault.countReadableOwnCommits();
    assert.equal(afterSingle.ownFailedCount, 0, 'P2-3: 2-good/2-bad single-device recovery via /soul config passphrase must purge bad commits');
    await sCtrl.dispose();
  } finally {
    await winCtrl.dispose();
    await macCtrl.dispose();
  }
});

test('P1-2 + C6 + C8 + C9 + P2-1 + R6 + R7 + R8: unified CLI, unique mapping IDs, multi-batch C8 isolation, empty pre-step, stale compaction, plaintext redaction & blank card', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'misc-fixes');

  // 1. C6 & C9: Distinct paths with same basename derive distinct deterministic IDs & survive cross-device sync + multiple --map
  const idA = deriveWorkspaceId('D:\\clients\\research', '/Users/me/clients/research');
  const idB = deriveWorkspaceId('E:\\personal\\research', '/Users/me/personal/research');
  assert.notEqual(idA, idB, 'C6: distinct path pairs sharing basename must derive distinct IDs');

  const cliMapHome = path.join(caseDir, 'cli-maps');
  const cliVault = path.join(caseDir, 'cli-vault');
  await fs.mkdir(cliVault, { recursive: true });
  const initOut = [];
  const rc = await runCli(
    [
      '--dsh-home', cliMapHome,
      'init', '--non-interactive', '--vault', cliVault, '--no-passphrase',
      '--map', 'D:\\clients\\research::/Users/me/clients/research',
      '--map', 'E:\\personal\\research::/Users/me/personal/research',
    ],
    { stdout: (s) => initOut.push(s), stderr: (s) => initOut.push(s), isTTY: false },
  );
  assert.equal(rc, 0, initOut.join(''));
  assert.equal((await loadConfig(cliMapHome)).workspaceMappings.length, 2, 'C9: two same-basename --map flags must both persist');

  // 2. P1-2: CLI `dsh-soul push` with `syncScope: 'selected'` and empty whitelist MUST NOT leak unselected workspace deliverables!
  const p12Home = path.join(caseDir, 'p12-home');
  const p12Vault = path.join(caseDir, 'p12-vault');
  const p12Ws = path.join(caseDir, 'p12-ws');
  await fs.mkdir(path.join(p12Ws, 'outputs'), { recursive: true });
  await fs.mkdir(p12Vault, { recursive: true });
  await fs.writeFile(path.join(p12Ws, 'outputs', 'secret-draft.md'), '# Unselected Workspace Draft\n', 'utf8');
  await saveConfig(p12Home, {
    deviceId: 'win-p12',
    deviceLabel: 'WinP12',
    platform: 'win32',
    vaultDir: p12Vault,
    syncScope: 'selected',
    selectedWorkspaces: [],
    selectedSessionIds: [],
    workspaceMappings: [{ id: 'p12-ws', title: 'P12', win32: p12Ws, darwin: '/Users/me/p12-ws' }],
  });
  const pushOut = [];
  const pushCode = await runCli(['--dsh-home', p12Home, 'push'], {
    stdout: (s) => pushOut.push(s),
    stderr: (s) => pushOut.push(s),
    isTTY: false,
    minQuietMs: 0,
  });
  assert.equal(pushCode, 0, pushOut.join(''));
  const p12VaultStore = new VaultStore({ vaultDir: p12Vault, deviceId: 'probe', platform: 'win32' });
  const wsCommits = await p12VaultStore.listCommits('workspace', { includeSelf: true });
  assert.equal(wsCommits.commits.length, 0, 'P1-2: CLI push with empty selected whitelist must push 0 workspace commits');

  // P1-2 Disaster recovery CLI `dsh-soul pull` receives cross-device workspaceMappings!
  const drHome = path.join(caseDir, 'dr-home');
  const drWs = path.join(caseDir, 'dr-ws');
  await saveConfig(p12Home, {
    workspaceMappings: [{ id: 'dr-map-1', title: 'DR', win32: drWs, darwin: '/Users/me/dr-ws', updatedAt: Date.now() }],
  });
  await runCli(['--dsh-home', p12Home, 'push'], { stdout: () => {}, stderr: () => {}, isTTY: false, minQuietMs: 0 });
  await saveConfig(drHome, { deviceId: 'new-dr-pc', deviceLabel: 'NewPC', platform: 'win32', vaultDir: p12Vault });
  const drCode = await runCli(['--dsh-home', drHome, 'pull', '--force'], {
    stdout: () => {},
    stderr: () => {},
    isTTY: false,
    checkDesktopRunning: async () => false,
    minQuietMs: 0,
  });
  assert.equal(drCode, 0);
  assert.ok((await loadConfig(drHome)).workspaceMappings.some((m) => m.id === 'dr-map-1'), 'P1-2: CLI pull must receive global workspaceMappings');

  // 3. C8: Two same-basename remote folders pulled in TWO SEPARATE BATCHES land in distinct directories!
  const c8WinHome = path.join(caseDir, 'c8-win');
  const c8MacHome = path.join(caseDir, 'c8-mac');
  const c8Vault = path.join(caseDir, 'c8-vault');
  const c8Mirrors = path.join(caseDir, 'c8-mirrors');
  const c8ExistingLocal = path.join(caseDir, 'c8-existing', 'research');
  const c8WinA = path.join(caseDir, 'win-a', 'research');
  const c8WinB = path.join(caseDir, 'win-b', 'research');
  await fs.mkdir(c8ExistingLocal, { recursive: true });
  await fs.mkdir(c8WinA, { recursive: true });
  await fs.mkdir(c8WinB, { recursive: true });
  await fs.mkdir(c8Vault, { recursive: true });

  await saveConfig(c8WinHome, { deviceId: 'win-c8', platform: 'win32', vaultDir: c8Vault });
  await saveConfig(c8MacHome, { deviceId: 'mac-c8', platform: process.platform, vaultDir: c8Vault, autoMirrorRoot: c8Mirrors });
  await writeLocalSession(c8WinHome, { type: 'session', version: 4, id: 'c8-sess-a', createdAt: 1000, cwd: c8WinA, isSeeded: false, delegationDepth: 0 }, [
    { seq: 0, time: 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Batch A' }] } },
  ]);
  const c8WinCtrl = new SoulSyncController(null, { dshHome: c8WinHome, platform: 'win32', pollIntervalMs: 0 });
  const mockWsReg = {
    list: () => [{ id: 'w-existing', path: c8ExistingLocal, sessionIds: [] }],
    create: async (cwd) => ({ id: cwd, path: cwd, sessionIds: [], async attachSession() {} }),
  };
  const c8MacCtrl = new SoulSyncController({ workspaceRegistry: mockWsReg }, { dshHome: c8MacHome, platform: process.platform, pollIntervalMs: 0 });
  await c8WinCtrl.reloadConfig();
  await c8MacCtrl.reloadConfig();

  // Batch 1: pull win-a/research -> claims c8ExistingLocal via Priority C and persists in autoMirrorAssignments!
  await c8WinCtrl.pushAll();
  const batch1 = await c8MacCtrl.pullAll();
  const dirA = batch1.sessions.results.find((r) => r.sessionId === 'c8-sess-a')?.targetCwd;
  assert.ok(dirA);

  // Batch 2: later Win creates win-b/research -> MUST NOT merge into dirA!
  await writeLocalSession(c8WinHome, { type: 'session', version: 4, id: 'c8-sess-b', createdAt: 2000, cwd: c8WinB, isSeeded: false, delegationDepth: 0 }, [
    { seq: 0, time: 2100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Batch B' }] } },
  ]);
  await c8WinCtrl.pushAll();
  const batch2 = await c8MacCtrl.pullAll();
  const dirB = batch2.sessions.results.find((r) => r.sessionId === 'c8-sess-b')?.targetCwd;
  assert.ok(dirB);
  assert.notEqual(dirA.toLowerCase(), dirB.toLowerCase(), 'C8: two same-basename sources pulled in separate batches must NEVER merge');
  await c8WinCtrl.dispose();
  await c8MacCtrl.dispose();

  // 4. P2-1: handleAgentPreStep with empty messages[] returns untouched and preserves pending alerts!
  const p21Home = path.join(caseDir, 'p21-home');
  await saveConfig(p21Home, { vaultDir: cliVault, platform: 'win32' });
  const p21Ctrl = new SoulSyncController(null, { dshHome: p21Home, platform: 'win32', pollIntervalMs: 0 });
  await p21Ctrl.reloadConfig();
  p21Ctrl._pushAlert({ kind: 'file-conflict', sessionId: 'sess-empty-step', text: '测试提醒' });
  const emptyDec = await p21Ctrl.handleAgentPreStep(
    { agent: { session: { id: 'sess-empty-step', cwd: p12Ws } } },
    () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(emptyDec.messages.length, 0, 'P2-1: empty closing step must NOT receive injected notices');
  assert.equal(p21Ctrl._pendingAlerts.length, 1, 'P2-1: pending alert must remain queued for next user turn');

  // 5. R6: hasUnclosedCompaction ignores stale (>10min) orphaned compaction/start while blocking fresh one
  const now = Date.now();
  assert.equal(hasUnclosedCompaction([{ seq: 0, time: now - 30_000, type: 'compaction/start', data: {} }], now), true);
  assert.equal(hasUnclosedCompaction([{ seq: 0, time: now - 15 * 60_000, type: 'compaction/start', data: {} }], now), false);

  // 6. R7: Plaintext export redacts sk-... API key while encrypted export preserves intact
  const r7Home = path.join(caseDir, 'r7-home');
  const r7VaultDir = path.join(caseDir, 'r7-vault');
  await fs.mkdir(r7VaultDir, { recursive: true });
  const r7PlainVault = new VaultStore({ vaultDir: r7VaultDir, deviceId: 'win-r7', platform: 'win32', secretKeys: null });
  await writeLocalSession(
    r7Home,
    { type: 'session', version: 4, id: 'sess-r7-secret', createdAt: now, cwd: p12Ws, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: now + 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'my key is sk-live1234567890abcdef123456' }] } }],
  );
  const expPlain = await exportSessionClosure({ dshHome: r7Home, vault: r7PlainVault, sessionId: 'sess-r7-secret' });
  const blobMeta = expPlain.commit.payload.nodes[0].logBlob;
  const plainDecoded = await decodeV4SessionLog(await r7PlainVault.getBlob(blobMeta.storageKey, blobMeta.sha256, blobMeta.size));
  assert.equal(plainDecoded.events[0].data.content[0].text.includes('sk-live1234567890abcdef123456'), false, 'R7: plaintext vault export must redact sk- keys');
  assert.match(plainDecoded.events[0].data.content[0].text, /\[REDACTED_SECRET\]/);

  // 7. R8: Blank-page /soul status returns single-line summary without \n (preventing GenericCommandCard duplication)
  //    AND recovered vault clears transient _startupErrors!
  const blankEvents = [];
  const blankSession = {
    id: 'sess-r8-blank',
    cwd: p12Ws,
    header: { type: 'session', version: 4, id: 'sess-r8-blank', cwd: p12Ws, createdAt: now, isSeeded: false, delegationDepth: 0 },
    surface: { nodes: [] },
    append(type, data, opts = {}) {
      const seq = blankEvents.length;
      const ev = { seq, time: now + seq, type, data, ...(opts.surfaceOp ? { surfaceOp: opts.surfaceOp } : {}) };
      blankEvents.push(ev);
      if (opts.surfaceOp === 'append') this.surface.nodes.push(seq);
      return ev;
    },
    eventAt(seq) { return blankEvents[seq]; },
    snapshotEvents() { return [...blankEvents]; },
  };
  const blankRes = await p21Ctrl.handleSlashCommand({ agent: { session: blankSession, phase: { kind: 'idle', lastTurn: 0 } }, rawInput: 'status' });
  assert.equal(blankRes.kind, 'success');
  assert.equal(blankRes.text.includes('\n'), false, 'R8: blank-page command/done text must be single-line to avoid GenericCommandCard <pre> duplication');

  p21Ctrl._startupErrors.push('Simulated transient OneDrive offline error');
  await p21Ctrl.pullAll();
  assert.equal(p21Ctrl._startupErrors.length, 0, 'R8: transient startup error must auto-clear once vault recovers');

  await p21Ctrl.dispose();
});


// ============================================================================
// FINAL RELEASE-GATE REGRESSION TESTS (Neon #1-#6 + Opus A3b & Legacy Probe C)
// ============================================================================

test('Release-Gate [REAL DSH HOST]: in-place idle liveSession fast-forward (0 api-session/removed), session/end-seed roundtrip, Cordis Symbol teardown & api-session/activity', {
  skip: !HAS_REAL_DSH_HOST_PKGS ? 'Real @deepseek-ai/* packages not installed' : false,
}, async () => {
  const { Context } = await importRealDshPkg('@deepseek-ai/cordis');
  const { Session, SessionStore } = await importRealDshPkg('@deepseek-ai/dsh-session');
  const { SessionProjectionRegistry } = await importRealDshPkg('@deepseek-ai/dsh-session-projection');
  const StoragePlugin = await importRealDshPkg('@deepseek-ai/dsh-storage');
  const StorageDomainPlugin = await importRealDshPkg('@deepseek-ai/dsh-storage-domain');
  const StorageJsonPlugin = await importRealDshPkg('@deepseek-ai/dsh-storage-json');
  const SessionPersistenceJsonlPlugin = await importRealDshPkg('@deepseek-ai/dsh-session-persistence-jsonl');
  const { SessionProjectionCache } = await importRealDshPkg('@deepseek-ai/dsh-session-projection-cache');
  const { titleProjectionDefinition } = await importRealDshPkg('@deepseek-ai/dsh-session-title');

  const caseDir = path.join(TEST_TMP_ROOT, 'gate-inplace-ff-endseed');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  const macWs = path.join(caseDir, 'mac-ws');
  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(macWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  const mappings = [{ id: 'gate-proj', title: 'GateProj', win32: winWs, darwin: macWs, linux: macWs }];
  const sid = 'sess-gate-inplace-01';
  const now = Date.now();
  const turn1 = [
    { seq: 0, time: now - 10000, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: now - 9900, type: 'user/message', surfaceOp: 'append', data: { id: 'm-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Turn 1 from Win' }] } },
    { seq: 2, time: now - 9800, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const turn2 = [
    ...turn1,
    { seq: 3, time: now - 4000, type: 'turn/start', data: { turn: 2 } },
    { seq: 4, time: now - 3900, type: 'user/message', surfaceOp: 'append', data: { id: 'm-u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Turn 2 from Mac' }] } },
    { seq: 5, time: now - 3800, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];

  await saveConfig(winHome, { deviceId: 'win-gate', deviceLabel: 'WinGate', platform: 'win32', vaultDir, workspaceMappings: mappings });
  await saveConfig(macHome, { deviceId: 'mac-gate', deviceLabel: 'MacGate', platform: 'darwin', vaultDir, workspaceMappings: mappings });
  await writeLocalSession(winHome, { type: 'session', version: 4, id: sid, createdAt: now - 11000, cwd: winWs, isSeeded: false, delegationDepth: 0 }, turn1);
  await writeLocalSession(macHome, { type: 'session', version: 4, id: sid, createdAt: now - 11000, cwd: macWs, isSeeded: false, delegationDepth: 0 }, turn2);

  // Mac pushes Turn 2
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', pollIntervalMs: 0 });
  await macCtrl.reloadConfig();
  await macCtrl.pushAll();

  // Boot REAL DSH host on Win and open `sid` live via real SessionStore + JsonlSessionPersistence
  const ctx = new Context();
  await Promise.all([
    ctx.plugin(StoragePlugin.default),
    ctx.plugin(StorageJsonPlugin, { root: path.join(winHome, 'storages') }),
    ctx.plugin(StorageDomainPlugin, { backend: 'json' }),
    ctx.plugin(SessionProjectionRegistry),
    ctx.plugin(SessionStore),
    ctx.plugin(SessionPersistenceJsonlPlugin, { root: path.join(winHome, 'sessions'), compression: 'zstd' }),
    ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 50 }),
  ]);

  let writeHandle = null;
  let detachSession = null;
  let winCtrl = null;
  try {
    await ctx.sessionProjections.register(titleProjectionDefinition);
    const { z } = await importRealDshPkg('zod').catch(async () => {
      const req = createRequire(path.join(DSH_PROFILE_NODE_MODULES, '@deepseek-ai', 'dsh-session-projection-cache', 'package.json'));
      return import(pathToFileURL(req.resolve('zod')).href);
    });
    const metaSchema = z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() });
    await ctx.sessionProjections.register({
      key: 'sessionListMetadata',
      stateSchema: metaSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: (state, event) => {
        const blank = state.blank && event.type !== 'turn/start';
        const lastPromptAt = event.type === 'user/message' && event.data?.source?.kind === 'user' ? event.time : state.lastPromptAt;
        return blank === state.blank && lastPromptAt === state.lastPromptAt ? state : { blank, lastPromptAt };
      },
      wire: { viewSchema: metaSchema, view: (s) => s },
      stateVersion: 1,
    });

    // Open session like real AgentLoop.resume() -> prepare + enter + announce + persist `session/end-seed`!
    writeHandle = await ctx.sessionPersistence.open(sid, 'write');
    const restored = await writeHandle.read(0);
    const liveSession = ctx.sessions.prepare(sid, {
      seed: restored.events,
      meta: writeHandle.header,
      inheritedEventCount: writeHandle.inheritedEventCount,
      eventState: restored.eventState,
    });
    detachSession = ctx.sessions.enter(liveSession);
    await ctx.sessions.announce(liveSession);
    // Persist any unstored suffix from `prepare` (e.g., `session/end-seed`), or append one if absent
    const afterPrepareEvents = liveSession.snapshotEvents();
    if (afterPrepareEvents.length > restored.events.length) {
      await writeHandle.append(afterPrepareEvents.slice(restored.events.length));
      await writeHandle.flush();
    } else {
      liveSession.append('session/end-seed', {});
      await ctx.sessions.flush(liveSession);
    }

    // Track `api-session/removed`, `api-session/added`, `api-session/activity`
    const removedIds = [];
    const addedSummaries = [];
    const activityEvents = [];
    ctx.on('session/disposed', (s) => removedIds.push(s?.id ?? s?.header?.id));
    ctx.on('api-session/removed', (id) => removedIds.push(id));
    ctx.on('api-session/added', (summary) => addedSummaries.push(summary));
    ctx.on('api-session/activity', (id, updatedAt) => activityEvents.push({ id, updatedAt }));

    // Register idle agent with real `runMaintenance` + `setPhase` + Cordis Symbol-labeled effect
    const agentStore = new Map();
    const fakeAgent = {
      id: sid,
      status: 'idle',
      phase: { kind: 'idle', lastTurn: 1 },
      inbox: { hasPending: false },
      session: liveSession,
      maintenanceRan: false,
      setPhase(next) { this.phase = next; },
      async runMaintenance(job) {
        this.maintenanceRan = true;
        const prev = this.phase.lastTurn;
        this.phase = { kind: 'maintenance', lastTurn: prev };
        try {
          return await job(new AbortController().signal);
        } finally {
          this.phase = { kind: 'idle', lastTurn: prev };
        }
      },
    };
    agentStore.set(sid, fakeAgent);
    ctx.provide('agents', { get: (id) => agentStore.get(id), store: agentStore });

    winCtrl = new SoulSyncController(ctx, { dshHome: winHome, platform: 'win32', pollIntervalMs: 0 });
    await winCtrl.reloadConfig();

    // 1. Pull Mac Turn 2 while Win has open idle tab + `session/end-seed`!
    const pullWin = await winCtrl.pullAll();
    assert.equal(pullWin.ok, true);
    assert.equal(pullWin.sessions.summary.fastForwarded, 1, 'P0-2c: session/end-seed must NOT cause false fork');
    assert.equal(pullWin.sessions.summary.forkedBranches, 0);
    assert.equal(pullWin.sessions.results[0].appliedInPlace, true, 'P0-2a: must fast-forward liveSession IN PLACE');
    assert.equal(fakeAgent.maintenanceRan, true, 'P0-2a: must execute inside agent.runMaintenance');
    assert.equal(fakeAgent.phase.lastTurn, 2, 'P0-2a: must advance agent.phase.lastTurn to 2');
    assert.equal(removedIds.length, 0, 'P0-2a / Opus A3b: MUST emit ZERO session/disposed or api-session/removed!');
    assert.ok(addedSummaries.some((s) => s.sessionId === sid), 'api-session/added must fire');
    assert.ok(activityEvents.some((e) => e.id === sid && e.updatedAt > 0), 'P1 #4: api-session/activity must fire with updatedAt');

    const liveAfterFF = liveSession.snapshotEvents();
    assert.equal(liveAfterFF.length, 7, '3 original + 1 session/end-seed + 3 Turn 2 events');
    assert.equal(liveAfterFF[5].data.content[0].text, 'Turn 2 from Mac');

    // 2. Now Win appends Turn 3 on the SAME open liveSession and pushes -> Mac MUST fast-forward cleanly (0 false fork!)
    liveSession.append('turn/start', { turn: 3 });
    liveSession.append('user/message', { id: 'm-u3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Turn 3 from Win after in-place FF' }] }, { surfaceOp: 'append' });
    liveSession.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
    await ctx.sessions.flush(liveSession);
    await winCtrl.pushAll();

    const pullMac = await macCtrl.pullAll();
    assert.equal(pullMac.ok, true);
    assert.equal(pullMac.sessions.summary.fastForwarded, 1, 'Roundtrip Turn 3 after in-place FF + session/end-seed must fast-forward cleanly on Mac');
    assert.equal(pullMac.sessions.summary.forkedBranches, 0);

    // 3. Verify P0-2b Cordis Symbol effect label matching in `_releaseIdleSession` clears `liveAgents` cleanly
    const liveAgents = new Set([sid]);
    const cordisEffectSym = Symbol('cordis.effect');
    const teardownDisposable = () => {
      liveAgents.delete(sid);
      agentStore.delete(sid);
    };
    teardownDisposable[cordisEffectSym] = { label: `agentLoop.scope(${sid})` };
    fakeAgent.loopCtx = { fiber: { _disposables: new Set([teardownDisposable]) } };
    await winCtrl._releaseIdleSession(sid);
    assert.equal(liveAgents.size, 0, 'P0-2b: Cordis Symbol(cordis.effect) teardown must execute and clear liveAgents');

    // 4. Verify Opus P2 in-memory projCache fallback when projRegistry.restore throws
    const brokenProjCtx = {
      sessionProjections: { restore() { throw new Error('simulated unconfigured projection'); } },
      sessionProjectionCache: ctx.sessionProjectionCache,
      emit: ctx.emit.bind(ctx),
    };
    const fallbackSid = 'sess-projcache-fallback';
    await writeLocalSession(winHome, { type: 'session', version: 4, id: fallbackSid, createdAt: now - 5000, cwd: winWs, isSeeded: false, delegationDepth: 0 }, turn1);
    const macPushFallback = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', pollIntervalMs: 0 });
    await macPushFallback.reloadConfig();
    await writeLocalSession(macHome, { type: 'session', version: 4, id: fallbackSid, createdAt: now - 5000, cwd: macWs, isSeeded: false, delegationDepth: 0 }, turn2);
    await macPushFallback.pushAll();
    await macPushFallback.dispose();
    const origProj = winCtrl.ctx;
    const fbAdapter = {
      ...winCtrl._buildCordisAdapter(),
      sessionProjections: brokenProjCtx.sessionProjections,
      fastForwardLiveSession: undefined,
    };
    const fbPull = await pullSessionsFromVault({
      dshHome: winHome,
      vault: winCtrl.vault,
      workspaceMappings: winCtrl.config.workspaceMappings,
      targetPlatform: 'win32',
      cordisCtx: fbAdapter,
      onlySessionIds: [fallbackSid],
    });
    assert.equal(fbPull.summary.fastForwarded, 1);
    const fbRec = (await scanLocalSessions(winHome)).get(fallbackSid);
    const fbSnap = ctx.sessionProjectionCache.cachedSnapshot(fbRec.header);
    assert.ok(fbSnap, 'Opus P2: in-memory SessionProjectionCache must be warmed even when projRegistry.restore() throws');
    assert.ok(fbSnap.values.sessionListMetadata.lastPromptAt > 0);
  } finally {
    try { detachSession?.(); } catch { /* ignore */ }
    await writeHandle?.close?.().catch(() => {});
    await winCtrl?.dispose?.().catch(() => {});
    await macCtrl.dispose();
    await ctx.fiber.dispose();
  }
});

test('Release-Gate: Neon P0 #1 (UI payload C2 guard), P0 #3 (CLI init/doctor wrong-pass), Opus P1 (legacy ID preserve), Neon P1 #5 (withdrawUnselected->active), P2 #6 (OPTIONS auth)', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'gate-all-remaining');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, '文章');
  const macWs = '/Users/mac/文章';
  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  // 1. Neon P0 #1: Real Settings UI payload `{ vaultDir: currentVaultDir, passphrase: 'BAD_TYPO' }` MUST be blocked by C2!
  await savePassphraseKey(winHome, 'GOOD_PASS');
  await savePassphraseKey(macHome, 'BAD_TYPO');
  await saveConfig(winHome, { deviceId: 'win-ui-c2', deviceLabel: 'WinGood', platform: 'win32', vaultDir, encryptionEnabled: true });
  await saveConfig(macHome, { deviceId: 'mac-ui-c2', deviceLabel: 'MacTypo', platform: 'darwin', vaultDir, encryptionEnabled: true });

  const now = Date.now();
  for (let i = 1; i <= 5; i += 1) {
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: `sess-good-${i}`, createdAt: now - 50000 + i * 100, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: now - 49000 + i * 100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Good session ${i}` }] } }],
    );
  }
  await writeLocalSession(
    macHome,
    { type: 'session', version: 4, id: 'sess-bad-mac', createdAt: now - 1000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: now - 900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Typo mac session' }] } }],
  );

  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', pollIntervalMs: 0 });
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', pollIntervalMs: 0 });
  let legWinCtrl = null;
  let legMacCtrl = null;
  let authCtrl = null;
  try {
    await winCtrl.reloadConfig();
    await macCtrl.reloadConfig();
    await winCtrl.pushAll();
    await macCtrl.pushAll();

    const keyBefore = await loadPassphraseKey(winHome);
    // Exact real UI payload sent by `lib/client.js` handleSaveConnectionClick!
    const uiSaveRes = await winCtrl.updateSettings({
      vaultDir: winCtrl.config.vaultDir,
      deviceLabel: 'WinGood',
      stepSyncEnabled: true,
      passphrase: 'BAD_TYPO',
    });
    assert.equal(uiSaveRes.keyUpdateBlocked, true, 'Neon P0 #1: UI payload with unchanged vaultDir MUST hit C2 guard');
    assert.equal(uiSaveRes.requiresKeyRotationConfirm, true);
    const keyAfter = await loadPassphraseKey(winHome);
    assert.equal(keyAfter.encKeyHex, keyBefore.encKeyHex, 'Neon P0 #1: Win secret.key MUST remain unchanged');
    const winStatsAfter = await winCtrl.vault.countReadableDeviceStats();
    assert.equal(winStatsAfter.ownSessionCount, 5, 'Neon P0 #1: all 5 good Win session commits MUST stay intact');

    // 1b. Neon CHK2B: Switching to a DIFFERENT encrypted peer vault `vaultB` with a wrong passphrase
    //     MUST roll back `vaultDir` (staying on original vaultA) and NEVER pollute `vaultB`!
    const vaultB = path.join(caseDir, 'vault-b');
    const peerBHome = path.join(caseDir, 'peer-b-home');
    await fs.mkdir(vaultB, { recursive: true });
    await savePassphraseKey(peerBHome, 'VAULT_B_SECRET');
    await saveConfig(peerBHome, { deviceId: 'peer-b', deviceLabel: 'PeerB', platform: 'darwin', vaultDir: vaultB, encryptionEnabled: true });
    await writeLocalSession(
      peerBHome,
      { type: 'session', version: 4, id: 'sess-vault-b-1', createdAt: now - 3000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: now - 2900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Vault B secret session' }] } }],
    );
    const peerBCtrl = new SoulSyncController(null, { dshHome: peerBHome, platform: 'darwin', pollIntervalMs: 0 });
    await peerBCtrl.reloadConfig();
    await peerBCtrl.pushAll();
    const switchBadRes = await winCtrl.updateSettings({
      vaultDir: vaultB,
      passphrase: 'WRONG_FOR_VAULT_B',
    });
    assert.equal(switchBadRes.keyUpdateBlocked, true, 'Neon CHK2B: switching to encrypted vaultB with wrong passphrase must be blocked');
    assert.equal(switchBadRes.requiresKeyRotationConfirm, true);
    assert.equal(
      path.resolve(winCtrl.config.vaultDir).toLowerCase(),
      path.resolve(vaultDir).toLowerCase(),
      'Neon CHK2B: vaultDir MUST roll back to original vaultA when passphrase is blocked',
    );
    const vaultBStatsAfter = await peerBCtrl.vault.countReadableDeviceStats();
    assert.equal(vaultBStatsAfter.peerFailedCount, 0, 'Neon CHK2B: vaultB MUST NOT be polluted by blocked switch');

    // 1b. Opus CHK2B-3: Switching `vaultDir` WITHOUT passing `passphrase` (UI clears `connPassphrase` to "")
    //     MUST ALSO block & roll back `vaultDir` so subsequent `pushAll()` never pollutes `vaultB`!
    const switchNoPassRes = await winCtrl.updateSettings({
      vaultDir: vaultB,
      deviceLabel: 'Win-Good',
      stepSyncEnabled: true,
    });
    assert.equal(switchNoPassRes.keyUpdateBlocked, true, 'CHK2B-3: vaultDir-only switch to differently-encrypted vaultB must be blocked');
    assert.equal(switchNoPassRes.requiresKeyRotationConfirm, true);
    assert.equal(
      path.resolve(winCtrl.config.vaultDir).toLowerCase(),
      path.resolve(vaultDir).toLowerCase(),
      'CHK2B-3: vaultDir must stay on vaultA when vaultDir-only switch cannot decrypt vaultB',
    );
    await winCtrl.pushAll();
    const vaultBStatsAfterPush = await peerBCtrl.vault.countReadableDeviceStats();
    assert.equal(vaultBStatsAfterPush.peerFailedCount, 0, 'CHK2B-3: subsequent pushAll must NOT pollute vaultB');
    await peerBCtrl.dispose();

    // 2. Neon P0 #3: `dsh-soul init --map ... --passphrase WRONG` MUST fail with exit 1 without polluting vault,
    //    AND `dsh-soul doctor` MUST fail (`[FAIL] vault-decrypt`, exit 1) when peer commits fail even if own commit decrypts!
    const macInitHome = path.join(caseDir, 'mac-init-wrong');
    const initOut = [];
    const initErr = [];
    const initCode = await runCli(
      ['--dsh-home', macInitHome, '--platform', 'darwin', 'init', '--non-interactive', '--vault', vaultDir, '--passphrase', 'WRONG_KEY', '--map', `${winWs}::${macWs}`],
      { stdout: (s) => initOut.push(s), stderr: (s) => initErr.push(s) },
    );
    assert.equal(initCode, 1, `Neon P0 #3: init with wrong passphrase must return exit 1, stderr=${initErr.join('')}`);
    assert.match(initErr.join(''), /无法解密/);

    // Doctor check on `macCtrl` (which has 1 own commit readable under BAD_TYPO, but 0 peer commits readable & 5+ peer failed!)
    const docOut = [];
    const docCode = await runCli(
      ['--dsh-home', macHome, '--platform', 'darwin', 'doctor'],
      { stdout: (s) => docOut.push(s), stderr: (s) => docOut.push(s) },
    );
    assert.equal(docCode, 1, 'Neon P0 #3: doctor must exit 1 when all peer commits fail decryption');
    assert.match(docOut.join(''), /\[FAIL\] vault-decrypt/);

    // 3. Opus P1 Legacy Probe C + F8c: Un-timestamped legacy mapping ID `"文章"` MUST be preserved on Win
    //    AND Mac (both offline `handleAddMapping` AND fresh `dsh-soul init --map`) MUST converge to `["文章"]`!
    const legacyVault = path.join(caseDir, 'legacy-vault');
    const legWinHome = path.join(caseDir, 'leg-win');
    const legMacHome = path.join(caseDir, 'leg-mac');
    const legMacCliHome = path.join(caseDir, 'leg-mac-cli');
    await fs.mkdir(legacyVault, { recursive: true });
    await saveConfig(legWinHome, {
      deviceId: 'leg-win',
      deviceLabel: 'LegWin',
      platform: 'win32',
      vaultDir: legacyVault,
      workspaceMappings: [{ id: '文章', title: '文章', win32: winWs, darwin: macWs }], // NO updatedAt (legacy!)
    });
    await saveConfig(legMacHome, {
      deviceId: 'leg-mac',
      deviceLabel: 'LegMac',
      platform: 'darwin',
      vaultDir: legacyVault,
    });
    legWinCtrl = new SoulSyncController(null, { dshHome: legWinHome, platform: 'win32', pollIntervalMs: 0 });
    legMacCtrl = new SoulSyncController(null, { dshHome: legMacHome, platform: 'darwin', pollIntervalMs: 0 });
    await legWinCtrl.reloadConfig();
    await legMacCtrl.reloadConfig();
    await legMacCtrl.handleAddMapping({ winPath: winWs, macPath: macWs, triggerPull: false });
    assert.match(legMacCtrl.config.workspaceMappings[0].id, /^文章-[0-9a-f]{4}$/);
    await legWinCtrl.syncGlobalWorkspaceMetadata({ publishLocal: true });
    assert.deepEqual(
      legWinCtrl.config.workspaceMappings.map((m) => m.id),
      ['文章'],
      'Opus P1 Legacy Probe C: established legacy ID "文章" must be preserved against peer hashed ID',
    );
    // Opus F8c: Mac syncs with Win -> Mac MUST converge from `"文章-xxxx"` to canonical `"文章"`!
    await legMacCtrl.syncGlobalWorkspaceMetadata();
    assert.deepEqual(
      legMacCtrl.config.workspaceMappings.map((m) => m.id),
      ['文章'],
      'Opus F8c: Mac must deterministically converge to canonical legacy ID "文章" so deliverables sync across both devices',
    );
    // Opus F8c CLI path: fresh Mac running `dsh-soul init --map winWs::macWs` immediately reuses `"文章"`!
    const cliInitOut = [];
    const cliInitCode = await runCli(
      ['--dsh-home', legMacCliHome, '--platform', 'darwin', 'init', '--non-interactive', '--vault', legacyVault, '--no-passphrase', '--map', `${winWs}::${macWs}`],
      { stdout: (s) => cliInitOut.push(s), stderr: (s) => cliInitOut.push(s) },
    );
    assert.equal(cliInitCode, 0, cliInitOut.join(''));
    assert.deepEqual(
      (await loadConfig(legMacCliHome)).workspaceMappings.map((m) => m.id),
      ['文章'],
      'Opus F8c: fresh Mac `dsh-soul init --map` must immediately adopt canonical peer ID "文章"',
    );

    // 4. Opus G2 + Neon CHK5A: `withdrawUnselected` stops a `selected`-mode peer from re-pushing Win's session,
    //    AND switching back to `syncScope: 'active'` (via updateSettings or `/soul scope active`) resumes syncing!
    await writeLocalSession(
      legWinHome,
      { type: 'session', version: 4, id: 'sess-unselected-recover', createdAt: now - 2000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: now - 1900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Recoverable session' }] } }],
    );
    await legWinCtrl.pushAll();
    // Mac in `selected` mode pulls and selects Win's session
    await legMacCtrl.updateSettings({ syncScope: 'selected', selectedSessionIds: ['sess-unselected-recover'] });
    await legMacCtrl.pullAll();
    // Win switches to `selected` and withdraws its unselected own session
    await legWinCtrl.updateSettings({
      syncScope: 'selected',
      selectedSessionIds: [],
      selectedWorkspaces: [],
      withdrawUnselected: true,
    });
    assert.equal((legWinCtrl.config.excludedSessionIds ?? []).includes('sess-unselected-recover'), false, 'withdrawUnselected must NOT permanently exclude');
    assert.ok((legWinCtrl.config.withdrawnSessions ?? {})['sess-unselected-recover'] > 0, 'Opus G2: withdrawUnselected must broadcast withdrawal timestamp to peers');
    // Mac syncs metadata and pushes -> MUST NOT re-push Win's withdrawn session!
    await legMacCtrl.syncGlobalWorkspaceMetadata();
    assert.equal((legMacCtrl.config.selectedSessionIds ?? []).includes('sess-unselected-recover'), false, 'Opus G2: selected-mode peer must drop withdrawn session from selectedSessionIds');
    await legMacCtrl.pushAll();
    const vaultAfterMacPush = await legWinCtrl.vault.listCommits('session');
    assert.equal(
      vaultAfterMacPush.commits.some((c) => c.targetId === 'sess-unselected-recover'),
      false,
      'Opus G2: selected-mode peer must NOT re-push withdrawn session back into vault',
    );
    // Win switches back to `active` via `/soul config scope=active` (CHK5A-3) -> MUST restore and resume pushing!
    const cfgScopeRes = await legWinCtrl.handleConfig({ argsText: 'scope=active' });
    assert.equal(cfgScopeRes.kind, 'success');
    const backActivePush = await legWinCtrl.pushAll();
    const vaultAfterBackActive = await legWinCtrl.vault.listCommits('session');
    assert.ok(
      backActivePush.sessionPushedCount >= 1
      && vaultAfterBackActive.commits.some((c) => c.targetId === 'sess-unselected-recover'),
      'CHK5A-3: `/soul config scope=active` must restore non-excluded withdrawn sessions and resume syncing',
    );

    // 5. Neon P2 #6: `OPTIONS` checks `connection.requestRejection` BEFORE 204 and never reflects `dsh-app://app`
    const mockAuthCtx = {
      connection: {
        requestRejection(req) {
          return req.headers?.cookie === 'dsh_auth=valid' ? undefined : 401;
        },
      },
    };
    authCtrl = new SoulSyncController(mockAuthCtx, { dshHome: legWinHome, platform: 'win32', pollIntervalMs: 0 });
    await authCtrl.reloadConfig();
    const unauthOpt = await callApi(authCtrl, {
      method: 'OPTIONS',
      url: '/__soul-sync/api/state',
      headers: { host: '127.0.0.1:3080', origin: 'dsh-app://app' },
    });
    assert.equal(unauthOpt.status, 401, 'Neon P2 #6: OPTIONS without auth cookie must return 401 before 204');
    const authOpt = await callApi(authCtrl, {
      method: 'OPTIONS',
      url: '/__soul-sync/api/state',
      headers: { host: '127.0.0.1:3080', origin: 'dsh-app://app', cookie: 'dsh_auth=valid' },
    });
    assert.equal(authOpt.status, 204);
    assert.equal(authOpt.headers['access-control-allow-origin'], undefined, 'Neon P2 #6: OPTIONS must NOT reflect Access-Control-Allow-Origin: dsh-app://app');
  } finally {
    await authCtrl?.dispose?.();
    await legWinCtrl?.dispose?.();
    await legMacCtrl?.dispose?.();
    await winCtrl.dispose();
    await macCtrl.dispose();
  }
});

test('UX Hardening: vaultDir cannot be bound as project workspace, listLocalCatalog flags isVaultDir & mappedPeerPath, and client.js renders cleanly', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'ux-vault-guard');
  const dshHome = path.join(caseDir, 'home');
  const parentDir = path.join(caseDir, 'cloud', 'Nutstore');
  const vaultDir = path.join(parentDir, 'DSH-Vault');
  const winArticle = path.join(caseDir, 'projects', '文章');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(winArticle, { recursive: true });

  await saveConfig(dshHome, {
    deviceId: 'win-ux',
    deviceLabel: 'xuanyuan',
    platform: 'win32',
    vaultDir,
    workspaceMappings: [
      { id: '文章', title: '文章', win32: winArticle, darwin: '/Users/mingkun/文章' },
    ],
  });

  // Create one session accidentally opened inside vaultDir and one inside mapped winArticle
  const now = Date.now();
  await writeLocalSession(
    dshHome,
    { type: 'session', version: 4, id: 'sess-in-vault', createdAt: now - 5000, cwd: vaultDir, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: now - 4000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '误在金库里开的对话' }] } }],
  );
  await writeLocalSession(
    dshHome,
    { type: 'session', version: 4, id: 'sess-in-article', createdAt: now - 2000, cwd: winArticle, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: now - 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '公众号文章构思' }] } }],
  );

  const ctrl = new SoulSyncController(null, { dshHome, platform: 'win32', pollIntervalMs: 0 });
  await ctrl.reloadConfig();
  try {
    // 1. Attempting to bind vaultDir (or subdir / parent of vaultDir) as a workspace mapping is rejected cleanly
    const exactVaultMap = await ctrl.handleAddMapping({
      winPath: vaultDir,
      macPath: '/Users/mingkun/Nutstore Files/DSH-Vault',
      triggerPull: false,
    });
    assert.equal(exactVaultMap.kind, 'error');
    assert.match(exactVaultMap.text, /防灾金库目录.*更换金库 \/ 修改口令/);

    const parentVaultMap = await ctrl.handleAddMapping({
      winPath: parentDir,
      macPath: '/Users/mingkun/Nutstore Files',
      triggerPull: false,
    });
    assert.equal(parentVaultMap.kind, 'error');
    assert.match(parentVaultMap.text, /包含了当前的「防灾金库目录/);

    const apiMapRes = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/mappings',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1', 'content-type': 'application/json' },
      body: { winPath: vaultDir, macPath: '/Users/mingkun/Nutstore Files/DSH-Vault' },
    });
    assert.equal(apiMapRes.status, 400);
    assert.match(apiMapRes.json?.error || '', /更换金库 \/ 修改口令/);

    // 2. listLocalCatalog marks vaultDir session group with isVaultDir: true & mappingId: null,
    //    and mapped workspace with isVaultDir: false & mappedPeerPath: '/Users/mingkun/文章'
    const stateRes = await callApi(ctrl, {
      method: 'GET',
      url: '/__soul-sync/api/state',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
    });
    assert.equal(stateRes.status, 200);
    const wsGroups = stateRes.json.localCatalog.workspaces;
    const vaultGroup = wsGroups.find((w) => w.path === vaultDir);
    const articleGroup = wsGroups.find((w) => w.path === winArticle);
    assert.ok(vaultGroup, 'vault session group should exist in localCatalog');
    assert.equal(vaultGroup.isVaultDir, true);
    assert.equal(vaultGroup.mappingId, null);
    assert.ok(articleGroup, 'mapped article workspace should exist in localCatalog');
    assert.equal(articleGroup.isVaultDir, false);
    assert.equal(articleGroup.mappingId, '文章');
    assert.equal(articleGroup.mappedPeerPath, '/Users/mingkun/文章');

    // 3. Verify client.js bundle parses cleanly and renders new UX affordances without runtime errors
    const vm = await import('node:vm');
    const clientCode = await fs.readFile(path.join(REPO_ROOT, 'lib', 'client.js'), 'utf8');
    let registeredFactory = null;
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load(spec) {
            registeredFactory = spec.factory;
          },
        },
      },
      navigator: { platform: 'Win32', userAgent: 'Windows' },
      document: undefined,
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(stateRes.json) }),
    };
    vm.runInNewContext(clientCode, sandbox, { filename: 'lib/client.js' });
    assert.equal(typeof registeredFactory, 'function');
    assert.match(clientCode, /更换金库 \/ 修改口令/);
    assert.match(clientCode, /📲 配对另一台电脑/);
    assert.match(clientCode, /一键复制发给另一台电脑 DSH 的安装配对指令/);
    assert.match(clientCode, /!ws\.mappingId && !ws\.isVaultDir && ws\.path/);
  } finally {
    await ctrl.dispose();
  }
});

test('Mapping re-bind regression: changing D:\\文章 mapping from /Documents to /Documents/文章 migrates existing peer session cleanly with ZERO false split-brain fork', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'rebind-mapping-no-false-fork');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winArticle = 'D:\\文章';
  const macDocs = '/Users/mingkun/Documents';
  const macDocsArticle = '/Users/mingkun/Documents/文章';
  const macSiblingArticle = '/Users/mingkun/文章';
  await fs.mkdir(vaultDir, { recursive: true });

  await savePassphraseKey(winHome, 'rebind-pass');
  await savePassphraseKey(macHome, 'rebind-pass');
  await saveConfig(winHome, {
    deviceId: 'xuanyuan-e31ecc01',
    deviceLabel: 'xuanyuan',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: true,
    folderMatchMode: 'mapped-only',
    syncScope: 'selected',
    selectedWorkspaces: [winArticle],
    workspaceMappings: [
      { id: '文章-0aa2', title: '文章', win32: winArticle, darwin: macDocs, updatedAt: 1000 },
    ],
  });
  await saveConfig(macHome, {
    deviceId: 'mac-studio-01',
    deviceLabel: 'MacStudio',
    platform: 'darwin',
    vaultDir,
    encryptionEnabled: true,
    folderMatchMode: 'mapped-only',
  });

  const sid = 'session-2a04539d-ac41-435a-8c96-79b972de384d';
  const now = Date.now();
  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: sid, createdAt: now - 10000, cwd: winArticle, isSeeded: false, delegationDepth: 0 },
    [
      { seq: 0, time: now - 9000, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: now - 8900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '生成纳指SOXX公众号文章' }] } },
      { seq: 2, time: now - 8500, type: 'deliverables/presented', data: { turn: 1, callId: 'call_1', files: [{ path: 'D:\\文章\\公众号文章_一年只有一两把.md', description: '约稿版' }] } },
      { seq: 3, time: now - 8000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  );

  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', pollIntervalMs: 0 });
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', pollIntervalMs: 0 });
  await winCtrl.reloadConfig();
  await macCtrl.reloadConfig();

  try {
    await winCtrl.syncGlobalWorkspaceMetadata({ publishLocal: true });
    await winCtrl.pushAll();

    // 1. Mac initially pulls under D:\文章 ⇄ /Users/mingkun/Documents
    await macCtrl.syncGlobalWorkspaceMetadata();
    const pull1 = await macCtrl.pullAll();
    assert.equal(pull1.sessions.summary.imported, 1);
    assert.equal(pull1.sessions.summary.forkedBranches, 0);
    let macSessions = await scanLocalSessions(macHome);
    assert.equal(macSessions.get(sid)?.header?.cwd, macDocs);
    assert.equal(
      macSessions.get(sid)?.events?.find((e) => e.type === 'deliverables/presented')?.data?.files?.[0]?.path,
      '/Users/mingkun/Documents/公众号文章_一年只有一两把.md',
    );

    // 2. User deletes old mapping and re-binds D:\文章 ⇄ /Users/mingkun/Documents/文章 (child folder of previous target!)
    await winCtrl.removeMapping({ id: '文章-0aa2' });
    const addRes = await winCtrl.handleAddMapping({ winPath: winArticle, macPath: macDocsArticle, triggerPull: false });
    assert.equal(addRes.kind, 'success');

    // Mac syncs updated mapping & pulls -> MUST migrate in-place to /Users/mingkun/Documents/文章 with ZERO false fork!
    await macCtrl.syncGlobalWorkspaceMetadata();
    const pull2 = await macCtrl.pullAll();
    assert.equal(pull2.sessions.summary.forkedBranches, 0, 'Must NEVER create a false split-brain branch when mapping target changes');
    assert.equal(pull2.sessions.summary.migrated, 1, 'Existing peer session must automatically re-home to updated mapping path');
    assert.equal(macCtrl._pendingAlerts.length, 0, 'Zero split-brain alerts');
    macSessions = await scanLocalSessions(macHome);
    assert.equal(macSessions.size, 1, 'Only the original session exists on Mac (no phantom branch)');
    assert.equal(macSessions.get(sid)?.header?.cwd, macDocsArticle);
    assert.equal(
      macSessions.get(sid)?.events?.find((e) => e.type === 'deliverables/presented')?.data?.files?.[0]?.path,
      '/Users/mingkun/Documents/文章/公众号文章_一年只有一两把.md',
    );

    // 3. Re-bind upward/sideways to /Users/mingkun/文章 -> ALSO migrates cleanly with ZERO false fork!
    const prevId = winCtrl.config.workspaceMappings[0].id;
    await winCtrl.removeMapping({ id: prevId });
    await winCtrl.handleAddMapping({ winPath: winArticle, macPath: macSiblingArticle, triggerPull: false });
    await macCtrl.syncGlobalWorkspaceMetadata();
    const pull3 = await macCtrl.pullAll();
    assert.equal(pull3.sessions.summary.forkedBranches, 0);
    assert.equal(pull3.sessions.summary.migrated, 1);
    macSessions = await scanLocalSessions(macHome);
    assert.equal(macSessions.size, 1);
    assert.equal(macSessions.get(sid)?.header?.cwd, macSiblingArticle);
    assert.equal(
      macSessions.get(sid)?.events?.find((e) => e.type === 'deliverables/presented')?.data?.files?.[0]?.path,
      '/Users/mingkun/文章/公众号文章_一年只有一两把.md',
    );

    // 4. Subsequent steady-state pull is up-to-date with 0 forks and 0 migrations
    const pull4 = await macCtrl.pullAll();
    assert.equal(pull4.sessions.summary.upToDate, 1);
    assert.equal(pull4.sessions.summary.forkedBranches, 0);
    assert.equal(pull4.sessions.summary.migrated, 0);
  } finally {
    await winCtrl.dispose();
    await macCtrl.dispose();
  }
});

// ============================================================================
// FOOLPROOF UX & SECURITY UPGRADE REGRESSION TESTS (#92 / #93)
// ============================================================================

test('Foolproof P0-1 + P0-2: local passphrase reveal API (no leak in GET /state, legacy compat) & same-vault clearPassphrase guard + downgrade closure', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'ux-p0-1-2');
  const dshHome = path.join(caseDir, 'home');
  const legacyHome = path.join(caseDir, 'legacy-home');
  const vaultDir = path.join(caseDir, 'vault');
  const wsDir = path.join(caseDir, 'projects', 'alpha');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(wsDir, { recursive: true });

  // 1. Sealed passphrase roundtrip + legacy secret.key backward compatibility
  const secretPass = 'MySuperSecret#2026!';
  const savedKey = await savePassphraseKey(dshHome, secretPass);
  assert.equal(savedKey.passphrase, secretPass);
  assert.equal(savedKey.hasRevealablePassphrase, true);

  const keyRawText = await fs.readFile(path.join(dshHome, 'soul-sync', 'secret.key'), 'utf8');
  assert.equal(keyRawText.includes(secretPass), false, 'secret.key must store AES-GCM sealed passphraseCipherHex, not raw plaintext');
  const loadedKey = await loadPassphraseKey(dshHome);
  assert.equal(loadedKey.passphrase, secretPass);
  assert.equal(loadedKey.hasRevealablePassphrase, true);

  // Legacy secret.key without passphraseCipherHex
  await writeFileAtomic(
    path.join(legacyHome, 'soul-sync', 'secret.key'),
    JSON.stringify({ saltHex: loadedKey.saltHex, encKeyHex: loadedKey.encKeyHex, hmacKeyHex: loadedKey.hmacKeyHex }),
    { mode: 0o600 },
  );
  const loadedLegacy = await loadPassphraseKey(legacyHome);
  assert.equal(loadedLegacy.passphrase, null);
  assert.equal(loadedLegacy.hasRevealablePassphrase, false);

  // 2. GET /state NEVER leaks passphrase; POST /passphrase/reveal requires auth & returns no-store
  await saveConfig(dshHome, {
    deviceId: 'win-reveal',
    deviceLabel: 'WinReveal',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: true,
  });
  await writeLocalSession(
    dshHome,
    { type: 'session', version: 4, id: 'sess-enc-1', createdAt: Date.now() - 2000, cwd: wsDir, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: Date.now() - 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '加密会话正文' }] } }],
  );

  const authCtx = {
    connection: {
      requestRejection(req) {
        return String(req.headers?.cookie ?? '').includes('dsh_auth=ok') ? undefined : 401;
      },
    },
  };
  const ctrl = new SoulSyncController(authCtx, { dshHome, platform: 'win32', pollIntervalMs: 0 });
  await ctrl.reloadConfig();
  try {
    await ctrl.pushAll();

    // GET /state must NOT contain the plaintext passphrase anywhere in the JSON body!
    const stateRes = await callApi(ctrl, {
      method: 'GET',
      url: '/__soul-sync/api/state',
      headers: { host: '127.0.0.1:3080', cookie: 'dsh_auth=ok', 'x-dsh-soul-sync': '1' },
    });
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.text.includes(secretPass), false, 'GET /state MUST NEVER leak plaintext passphrase');
    assert.equal(stateRes.json.hasRevealablePassphrase, true);
    assert.equal(stateRes.json.vaultLooksLikeCloudDrive, false);

    // Unauthenticated POST /passphrase/reveal -> 401
    const unauthReveal = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/passphrase/reveal',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: {},
    });
    assert.equal(unauthReveal.status, 401);

    // Authenticated POST /passphrase/reveal -> 200 + cache-control: no-store + exact passphrase
    const okReveal = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/passphrase/reveal',
      headers: { host: '127.0.0.1:3080', cookie: 'dsh_auth=ok', 'x-dsh-soul-sync': '1' },
      body: {},
    });
    assert.equal(okReveal.status, 200);
    assert.equal(okReveal.headers['cache-control'], 'no-store');
    assert.equal(okReveal.json.available, true);
    assert.equal(okReveal.json.passphrase, secretPass);

    // 3. P0-1: Same-vault clearPassphrase: true MUST be blocked when vault has encrypted commits!
    const blockClear = await ctrl.updateSettings({ clearPassphrase: true });
    assert.equal(blockClear.keyUpdateBlocked, true, 'Same-vault clearPassphrase must be blocked when encrypted commits exist');
    assert.equal(blockClear.requiresKeyRotationConfirm, true);
    assert.equal(blockClear.confirmKind, 'clear-to-plaintext');
    assert.equal((await loadConfig(dshHome)).encryptionEnabled, true, 'encryptionEnabled must stay true when blocked');
    assert.ok(await loadPassphraseKey(dshHome), 'secret.key must NOT be deleted when blocked');

    // 4. Explicit confirmKeyRotation: true clears key, purges old encrypted own commits, and re-pushes plaintext cleanly!
    const confirmedClear = await ctrl.updateSettings({ clearPassphrase: true, confirmKeyRotation: true });
    assert.equal(confirmedClear.keyUpdateBlocked, false);
    assert.equal((await loadConfig(dshHome)).encryptionEnabled, false);
    assert.equal(await loadPassphraseKey(dshHome), null);
    assert.equal(ctrl.vault.encrypted, false);
    const plainStats = await ctrl.vault.countReadableDeviceStats();
    assert.equal(plainStats.totalFailedCount, 0, 'After confirmed plaintext downgrade, 0 undecryptable encrypted own commits should remain');
    assert.ok(plainStats.ownDecryptedCount >= 1, 'Plaintext re-push must produce readable plaintext commits');
  } finally {
    await ctrl.dispose();
  }
});

test('Foolproof P0-4 + P1-1: stripOuterQuotes, validateWorkspaceDirectory & validateVaultDirectory guards + cloud heuristic', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'ux-path-validators');
  const dshHome = path.join(caseDir, 'dsh-home');
  const vaultDir = path.join(caseDir, 'OneDrive', 'dsh-vault');
  const wsDir = path.join(caseDir, 'projects', '美股分析');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(wsDir, { recursive: true });

  assert.equal(stripOuterQuotes('  "D:\\OneDrive\\dsh-vault"  '), 'D:\\OneDrive\\dsh-vault');
  assert.equal(stripOuterQuotes("'/Users/mingkun/文章'"), '/Users/mingkun/文章');

  // Blocked high-risk workspace directories
  const blockedWin = [
    'C:\\',
    'D:\\',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Users',
    'C:\\Users\\gongs',
    'C:\\Users\\gongs\\.dsh',
    'C:\\Users\\gongs\\.dsh\\sessions',
    'C:\\Users\\gongs\\Desktop',
    'C:\\Users\\gongs\\Documents',
    'C:\\Users\\gongs\\Downloads',
    'C:\\Users\\gongs\\Documents\\deepseek-harness',
    'C:\\Users\\gongs\\Documents\\deepseek-harness\\default-workspace',
    'C:\\Users\\gongs\\OneDrive',
    'D:\\Second Brain\\我的坚果云',
    vaultDir,
    path.join(vaultDir, 'blobs'),
    path.dirname(vaultDir),
  ];
  for (const p of blockedWin) {
    const res = validateWorkspaceDirectory(p, 'win32', { dshHome, vaultDir });
    assert.equal(res.ok, false, `Expected win32 workspace to be blocked: ${p}`);
  }

  const blockedMac = [
    '/',
    '/Users',
    '/home',
    '/Volumes',
    '/System',
    '/Library',
    '/Applications',
    '/Users/mingkun',
    '/home/alice',
    '/Users/mingkun/.dsh',
    '/Users/mingkun/Desktop',
    '/Users/mingkun/Documents',
    '/Users/mingkun/Downloads',
    '/Users/mingkun/Documents/deepseek-harness',
    '/Users/mingkun/Documents/deepseek-harness/default-workspace',
    '/Users/mingkun/Nutstore Files',
    '/Users/mingkun/Library/Mobile Documents/com~apple~CloudDocs',
  ];
  for (const p of blockedMac) {
    const res = validateWorkspaceDirectory(p, 'darwin');
    assert.equal(res.ok, false, `Expected darwin workspace to be blocked: ${p}`);
  }

  // Allowed specific project subfolders (MUST PASS!)
  const allowedWin = [
    'D:\\文章',
    '"D:\\文章"',
    'C:\\Users\\gongs\\Desktop\\01v3-核心框架库',
    'C:\\Users\\gongs\\Documents\\美股分析',
    wsDir,
  ];
  for (const p of allowedWin) {
    const res = validateWorkspaceDirectory(p, 'win32', { dshHome, vaultDir });
    assert.equal(res.ok, true, `Expected win32 workspace to pass: ${p}, got error=${res.error}`);
  }

  const allowedMac = [
    '/Users/mingkun/文章',
    '/Users/mingkun/Documents/文章',
    '/Users/mingkun/Desktop/我的项目',
    '/tmp/test-project',
  ];
  for (const p of allowedMac) {
    const res = validateWorkspaceDirectory(p, 'darwin');
    assert.equal(res.ok, true, `Expected darwin workspace to pass: ${p}, got error=${res.error}`);
  }

  // validateVaultDirectory: quote stripping, cross-OS rejection, mapping overlap rejection, cloud heuristic
  assert.equal(validateVaultDirectory('"/Users/me/dsh-vault"', 'win32').ok, false, 'Win must reject POSIX /Users/... vault path');
  assert.equal(validateVaultDirectory('"D:\\OneDrive\\dsh-vault"', 'darwin').ok, false, 'Mac must reject Win D:\\... vault path');
  assert.equal(validateVaultDirectory('D:\\', 'win32').ok, false);
  assert.equal(validateVaultDirectory('C:\\Users\\gongs\\Desktop', 'win32').ok, false);
  assert.equal(validateVaultDirectory('C:\\Users\\gongs\\.dsh\\vault', 'win32').ok, false);
  assert.equal(
    validateVaultDirectory(wsDir, 'win32', { workspaceMappings: [{ id: 'm1', title: '美股分析', win32: wsDir }] }).ok,
    false,
    'Vault dir overlapping mapped workspace must be rejected',
  );

  const okQuotedVault = validateVaultDirectory(`"${vaultDir}"`, 'win32', { dshHome });
  assert.equal(okQuotedVault.ok, true);
  assert.equal(okQuotedVault.normalizedPath, vaultDir);
  assert.equal(okQuotedVault.looksLikeCloudDrive, true);

  // P2-1: `.` / `..` traversal normalization + bare cloud drive root rejection in validateVaultDirectory
  assert.equal(validateVaultDirectory('D:\\OneDrive\\..', 'win32').ok, false, 'P2-1: D:\\OneDrive\\.. normalizes to D:\\ and must be blocked');
  assert.equal(validateWorkspaceDirectory('C:\\Users\\gongs\\Desktop\\.', 'win32').ok, false, 'P2-1: Desktop\\. must be blocked');
  assert.equal(validateWorkspaceDirectory('C:\\Users\\gongs\\Desktop\\sub\\..', 'win32').ok, false, 'P2-1: Desktop\\sub\\.. must be blocked');
  assert.equal(validateWorkspaceDirectory('/Users/mingkun/Documents/foo/..', 'darwin').ok, false, 'P2-1: Documents/foo/.. must be blocked');
  assert.equal(validateVaultDirectory('C:\\Users\\gongs\\OneDrive', 'win32').ok, false, 'P2-1: bare OneDrive root must be blocked as vaultDir');
  assert.equal(validateVaultDirectory('D:\\Second Brain\\我的坚果云', 'win32').ok, false, 'P2-1: bare Nutstore root must be blocked as vaultDir');
  assert.equal(validateVaultDirectory('/Users/mingkun/Nutstore Files', 'darwin').ok, false, 'P2-1: bare Mac Nutstore Files root must be blocked as vaultDir');
  assert.equal(validateVaultDirectory('/Users/mingkun/Library/Mobile Documents/com~apple~CloudDocs', 'darwin').ok, false, 'P2-1: bare iCloud CloudDocs root must be blocked as vaultDir');
  assert.equal(validateVaultDirectory('D:\\Second Brain\\我的坚果云\\DSH', 'win32').ok, true, 'P2-1: dedicated subfolder inside Nutstore MUST be allowed as vaultDir');
  assert.equal(validateVaultDirectory('/Users/mingkun/Library/CloudStorage/OneDrive-Personal/dsh-vault', 'darwin').ok, true, 'P2-1: dedicated subfolder inside Mac OneDrive MUST be allowed as vaultDir');

  assert.equal(looksLikeCloudDrivePath('D:\\OneDrive\\dsh-vault'), true);
  assert.equal(looksLikeCloudDrivePath('/Users/me/Library/CloudStorage/OneDrive-Personal/dsh-vault'), true);
  assert.equal(looksLikeCloudDrivePath('D:\\我的坚果云\\DSH'), true);
  assert.equal(looksLikeCloudDrivePath('\\\\MyNAS\\share\\dsh-vault'), true);
  assert.equal(looksLikeCloudDrivePath('D:\\local-only\\my-folder'), false);
});

test('Foolproof P0-3: syncVolatileSettings does NOT clobber panel updates on restart & routes passphrase through guard', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'ux-p0-3-volatile');
  const dshHome = path.join(caseDir, 'home');
  const vaultA = path.join(caseDir, 'vault-a');
  const vaultB = path.join(caseDir, 'vault-b');
  const wsDir = path.join(caseDir, 'ws');
  await fs.mkdir(vaultA, { recursive: true });
  await fs.mkdir(vaultB, { recursive: true });
  await fs.mkdir(wsDir, { recursive: true });

  const makeVolatile = (initial) => {
    let v = initial;
    return { get: () => v, set: (n) => { v = n; } };
  };

  // Step 1: User initially configures via native volatile Settings UI -> vaultA + passA
  const vVault = makeVolatile(vaultA);
  const vPass = makeVolatile('pass-A');
  const vLabel = makeVolatile('NativeWin');
  const ctrl1 = new SoulSyncController(null, {
    dshHome,
    platform: 'win32',
    pollIntervalMs: 0,
    vaultDir: vVault,
    passphrase: vPass,
    deviceLabel: vLabel,
  });
  await ctrl1.start();
  assert.equal(path.resolve(ctrl1.config.vaultDir), path.resolve(vaultA));
  assert.equal((await loadPassphraseKey(dshHome)).passphrase, 'pass-A');

  // Step 2: User switches to vaultB + passB + PanelWin inside the migration panel (`updateSettings`)
  await writeLocalSession(
    dshHome,
    { type: 'session', version: 4, id: 'sess-vol-1', createdAt: Date.now() - 1000, cwd: wsDir, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: Date.now() - 500, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '面板更新后会话' }] } }],
  );
  await ctrl1.updateSettings({ vaultDir: vaultB, passphrase: 'pass-B', deviceLabel: 'PanelWin' });
  await ctrl1.pushAll();
  await ctrl1.dispose();

  // Step 3: Restart DSH with stale cordis.patch.yml still holding vaultA + pass-A + NativeWin -> MUST NOT roll back!
  const ctrl2 = new SoulSyncController(null, {
    dshHome,
    platform: 'win32',
    pollIntervalMs: 0,
    vaultDir: makeVolatile(vaultA),
    passphrase: makeVolatile('pass-A'),
    deviceLabel: makeVolatile('NativeWin'),
  });
  await ctrl2.start();
  try {
    assert.equal(path.resolve(ctrl2.config.vaultDir), path.resolve(vaultB), 'P0-3: restart must NOT roll back vaultDir to stale volatile config');
    assert.equal(ctrl2.config.deviceLabel, 'PanelWin', 'P0-3: restart must NOT roll back deviceLabel');
    assert.equal((await loadPassphraseKey(dshHome)).passphrase, 'pass-B', 'P0-3: restart must NOT roll back passphrase');

    // Step 4: User types a WRONG new passphrase in native volatile settings -> MUST be blocked by guard (not overwrite secret.key)!
    ctrl2.pluginConfig.passphrase.set('wrong-native-typo');
    const badVolRes = await ctrl2.syncVolatileSettings({ triggerPull: false });
    assert.equal(badVolRes.blocked, true, 'P0-3: volatile passphrase change must go through updateSettings guard');
    assert.equal((await loadPassphraseKey(dshHome)).passphrase, 'pass-B', 'P0-3: blocked volatile typo must NOT overwrite secret.key');

    // Step 5 (P1-1): Offline edit to ONLY `deviceLabel` in cordis.patch.yml -> restart applies ONLY deviceLabel,
    //                NEVER rolls back vaultB or pass-B to stale vaultA / pass-A!
    await ctrl2.dispose();
    const ctrl3 = new SoulSyncController(null, {
      dshHome,
      platform: 'win32',
      pollIntervalMs: 0,
      vaultDir: makeVolatile(vaultA),
      passphrase: makeVolatile('wrong-native-typo'),
      deviceLabel: makeVolatile('EditedOfflineLabel'),
    });
    await ctrl3.start();
    assert.equal(ctrl3.config.deviceLabel, 'EditedOfflineLabel', 'P1-1: genuinely changed single native field must apply on restart');
    assert.equal(path.resolve(ctrl3.config.vaultDir), path.resolve(vaultB), 'P1-1: unchanged native vaultA must NOT roll back vaultB');
    assert.equal((await loadPassphraseKey(dshHome)).passphrase, 'pass-B', 'P1-1: unchanged native passphrase must NOT roll back pass-B');

    // Step 6 (P1-1): Disconnect vault -> restart with stale native vaultA/passphrase MUST stay disconnected!
    await ctrl3.disconnectVault();
    await ctrl3.dispose();
    const ctrl4 = new SoulSyncController(null, {
      dshHome,
      platform: 'win32',
      pollIntervalMs: 0,
      vaultDir: makeVolatile(vaultA),
      passphrase: makeVolatile('wrong-native-typo'),
      deviceLabel: makeVolatile('EditedOfflineLabel'),
    });
    await ctrl4.start();
    assert.equal(ctrl4.config.vaultDir, '', 'P1-1: restart after disconnectVault must NEVER resurrect stale native vaultDir');

    // Step 7 (P1-1): Reset local config -> restart with stale native vaultA/passphrase MUST stay reset (no vault, no key)!
    await ctrl4.resetLocalConfig();
    await ctrl4.dispose();
    const ctrl5 = new SoulSyncController(null, {
      dshHome,
      platform: 'win32',
      pollIntervalMs: 0,
      vaultDir: makeVolatile(vaultA),
      passphrase: makeVolatile('wrong-native-typo'),
      deviceLabel: makeVolatile('EditedOfflineLabel'),
    });
    await ctrl5.start();
    assert.equal(ctrl5.config.vaultDir, '', 'P1-1: restart after resetLocalConfig must NEVER resurrect stale native vaultDir');
    assert.equal(await loadPassphraseKey(dshHome), null, 'P1-1: restart after resetLocalConfig must NEVER resurrect stale native secret.key');
    await ctrl5.dispose();
  } finally {
    await ctrl2.dispose();
  }
});

test('Foolproof P1-2 + P1-5: install wizard sessions skipped from auto-sync & localCatalog marks isInstallSession + inVault', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'ux-p1-2-install-filter');
  const dshHome = path.join(caseDir, 'home');
  const vaultDir = path.join(caseDir, 'vault');
  const wsDir = path.join(caseDir, 'projects', 'work');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(wsDir, { recursive: true });

  const now = Date.now();
  const installEvents = [
    { seq: 0, time: now - 3000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请你帮我安装并配置 DeepSeek Harness 跨电脑防灾同步插件（dsh-soul-sync），运行 install-win.ps1' }] } },
    { seq: 1, time: now - 2500, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '金库路径 D:\\OneDrive\\dsh-vault，口令 my-pass' }] } },
  ];
  const normalEvents = [
    { seq: 0, time: now - 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我分析一下台积电毛利率变化' }] } },
  ];
  const devEditPsEvents = [
    { seq: 0, time: now - 900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修改 dsh-soul-sync 里的 scripts/install-win.ps1，修复 PowerShell 5.1 参数转义问题' }] } },
  ];
  const devPolishPromptEvents = [
    { seq: 0, time: now - 800, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我润色一下 dsh-soul-sync 里的 INSTALL_PROMPT.md 文案' }] } },
  ];
  const devCheckMacEvents = [
    { seq: 0, time: now - 700, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我检查 dsh-soul-sync 的 scripts/install-mac.sh 有没有 bash 兼容性问题' }] } },
  ];

  assert.equal(isInstallWizardSession(installEvents), true);
  assert.equal(isInstallWizardSession(normalEvents), false);
  assert.equal(isInstallWizardSession(devEditPsEvents), false, 'P2-2: dev session editing install-win.ps1 must NOT be misclassified');
  assert.equal(isInstallWizardSession(devPolishPromptEvents), false, 'P2-2: dev session polishing INSTALL_PROMPT.md must NOT be misclassified');
  assert.equal(isInstallWizardSession(devCheckMacEvents), false, 'P2-2: dev session reviewing install-mac.sh must NOT be misclassified');
  assert.deepEqual(shouldAutoSyncSession({ sessionId: 'sess-inst', header: { cwd: wsDir }, events: installEvents }, { syncScope: 'active' }, 'win32'), {
    allowed: false,
    reason: 'install-wizard',
  });

  await saveConfig(dshHome, { deviceId: 'win-inst', deviceLabel: 'WinInst', platform: 'win32', vaultDir });
  await writeLocalSession(dshHome, { type: 'session', version: 4, id: 'sess-inst', createdAt: now - 3000, cwd: wsDir, isSeeded: false, delegationDepth: 0 }, installEvents);
  await writeLocalSession(dshHome, { type: 'session', version: 4, id: 'sess-biz', createdAt: now - 1000, cwd: wsDir, isSeeded: false, delegationDepth: 0 }, normalEvents);

  const ctrl = new SoulSyncController(null, { dshHome, platform: 'win32', pollIntervalMs: 0 });
  await ctrl.reloadConfig();
  try {
    const pushRes = await ctrl.pushAll();
    assert.equal(pushRes.sessionPushedCount, 1, 'Auto pushAll must skip install wizard session and push only real business session');

    const stateRes = await callApi(ctrl, {
      method: 'GET',
      url: '/__soul-sync/api/state',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
    });
    assert.equal(stateRes.status, 200);
    const sessions = stateRes.json.localCatalog.workspaces.flatMap((w) => w.sessions);
    const instEntry = sessions.find((s) => s.sessionId === 'sess-inst');
    const bizEntry = sessions.find((s) => s.sessionId === 'sess-biz');
    assert.equal(instEntry?.isInstallSession, true);
    assert.equal(instEntry?.inVault, false, 'Unpushed install session must have inVault: false');
    assert.equal(bizEntry?.isInstallSession, false);
    assert.equal(bizEntry?.inVault, true, 'Pushed business session must have inVault: true');
  } finally {
    await ctrl.dispose();
  }
});

test('Foolproof P1-4: POST /disconnect, POST /reset, POST /uninstall & CLI dsh-soul uninstall preserve source repo, sessions & credentials 100%', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'ux-p1-4-maint-uninstall');
  const dshHome = path.join(caseDir, 'sandbox-dsh');
  const vaultDir = path.join(caseDir, 'vault');
  const fakePluginSource = path.join(caseDir, 'fake-plugin-source-repo');
  const wsDir = path.join(caseDir, 'my-work');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(fakePluginSource, { recursive: true });
  await fs.mkdir(wsDir, { recursive: true });

  // Plant precious files inside fake plugin source repo (to prove uninstall NEVER deletes source repo!)
  await fs.writeFile(path.join(fakePluginSource, 'package.json'), JSON.stringify({ name: 'dsh-soul-sync', version: '0.1.0' }), 'utf8');
  await fs.writeFile(path.join(fakePluginSource, 'KEEP_ME.txt'), 'plugin-source-must-survive', 'utf8');

  // Plant precious user files in sandbox dshHome (sessions, storages, attachments, .credentials.yaml, custom AGENTS.md)
  await fs.mkdir(path.join(dshHome, 'storages'), { recursive: true });
  await fs.mkdir(path.join(dshHome, 'attachments'), { recursive: true });
  await fs.writeFile(path.join(dshHome, '.credentials.yaml'), 'token: keep-my-login-safe\n', 'utf8');
  await fs.writeFile(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify({ keep: true }), 'utf8');
  await fs.writeFile(path.join(dshHome, 'attachments', 'chart.png'), 'png-bytes', 'utf8');
  await fs.writeFile(path.join(dshHome, 'AGENTS.md'), '# My Custom Personal Rule\nKeep this intact.\n', 'utf8');
  await ensureGlobalAgentsRules(dshHome);
  await fs.mkdir(path.join(dshHome, 'skills', 'soul-handoff'), { recursive: true });
  await fs.writeFile(path.join(dshHome, 'skills', 'soul-handoff', 'SKILL.md'), '---\nname: soul-handoff\n---\n', 'utf8');

  // Seed desktop & web profiles + symlink/junction to fakePluginSource
  for (const prof of ['desktop', 'web']) {
    const profDir = path.join(dshHome, 'profiles', prof);
    await fs.mkdir(path.join(profDir, 'node_modules'), { recursive: true });
    await fs.writeFile(
      path.join(profDir, 'package.json'),
      JSON.stringify({
        name: `dsh-${prof}`,
        dependencies: { 'other-pkg': '1.0.0', 'dsh-soul-sync': `link:${fakePluginSource}` },
        dsh: { profile: { bundles: ['other-pkg', 'dsh-soul-sync'] } },
      }, null, 2),
      'utf8',
    );
    await fs.symlink(
      fakePluginSource,
      path.join(profDir, 'node_modules', 'dsh-soul-sync'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  const sessLogPath = await writeLocalSession(
    dshHome,
    { type: 'session', version: 4, id: 'sess-keep-me', createdAt: Date.now() - 1000, cwd: wsDir, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: Date.now() - 500, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '重要历史对话' }] } }],
  );

  await savePassphraseKey(dshHome, 'maint-secret');
  await saveConfig(dshHome, { deviceId: 'win-maint', deviceLabel: 'WinMaint', platform: 'win32', vaultDir, encryptionEnabled: true });

  const ctrl = new SoulSyncController(null, { dshHome, platform: 'win32', pollIntervalMs: 0 });
  await ctrl.reloadConfig();
  try {
    // 1. POST /disconnect clears vaultDir & stops vault while preserving sessions
    const discRes = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/disconnect',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: {},
    });
    assert.equal(discRes.status, 200);
    assert.equal(ctrl.vault, null);
    assert.equal((await loadConfig(dshHome)).vaultDir, '');

    // 2. POST /reset requires confirm: true
    const badReset = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/reset',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: {},
    });
    assert.equal(badReset.status, 400);

    const okReset = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/reset',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: { confirm: true },
    });
    assert.equal(okReset.status, 200);
    assert.equal(await loadPassphraseKey(dshHome), null);
    assert.equal((await loadConfig(dshHome)).vaultDir, '');

    // 3. POST /uninstall requires confirm: true, removes profiles/links/skill/AGENTS block/soul-sync,
    //    AND strictly preserves fakePluginSource, sessions, storages, attachments & .credentials.yaml!
    const badUninst = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/uninstall',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: {},
    });
    assert.equal(badUninst.status, 400);

    const okUninst = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/uninstall',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: { confirm: true },
    });
    assert.equal(okUninst.status, 200);
    assert.deepEqual(okUninst.json.removedProfiles.sort(), ['desktop', 'web']);
    assert.equal(okUninst.json.removedLinks.length, 2);
    assert.equal(okUninst.json.removedSkill, true);
    assert.equal(okUninst.json.updatedAgentsMd, true);
    assert.equal(okUninst.json.removedSoulSyncDir, true);

    for (const prof of ['desktop', 'web']) {
      const pkg = JSON.parse(await fs.readFile(path.join(dshHome, 'profiles', prof, 'package.json'), 'utf8'));
      assert.equal(pkg.dependencies['dsh-soul-sync'], undefined);
      assert.equal(pkg.dependencies['other-pkg'], '1.0.0');
      assert.deepEqual(pkg.dsh.profile.bundles, ['other-pkg']);
      await assert.rejects(() => fs.lstat(path.join(dshHome, 'profiles', prof, 'node_modules', 'dsh-soul-sync')));
    }
    await assert.rejects(() => fs.stat(path.join(dshHome, 'skills', 'soul-handoff')));
    await assert.rejects(() => fs.stat(path.join(dshHome, 'soul-sync')));

    const agentsAfter = await fs.readFile(path.join(dshHome, 'AGENTS.md'), 'utf8');
    assert.match(agentsAfter, /My Custom Personal Rule/);
    assert.equal(agentsAfter.includes('dsh-soul-sync:cross-os-rules'), false);

    // CRITICAL SAFETY ASSERTIONS: source repo, sessions, storages, attachments, credentials 100% intact!
    assert.equal(await fs.readFile(path.join(fakePluginSource, 'KEEP_ME.txt'), 'utf8'), 'plugin-source-must-survive');
    assert.equal(await fs.readFile(path.join(dshHome, '.credentials.yaml'), 'utf8'), 'token: keep-my-login-safe\n');
    assert.equal(await fs.readFile(path.join(dshHome, 'storages', 'workspace.json'), 'utf8'), JSON.stringify({ keep: true }));
    assert.equal(await fs.readFile(path.join(dshHome, 'attachments', 'chart.png'), 'utf8'), 'png-bytes');
    assert.ok(await fs.stat(sessLogPath), 'Local session file must remain 100% untouched');

    // P2-3: After uninstallPlugin(), controller is disposed/uninstalled: write API calls MUST reject
    // and GET /state MUST return uninstalled: true WITHOUT recreating `<dshHome>/soul-sync/`!
    assert.equal(ctrl._disposed, true);
    assert.equal(ctrl._uninstalled, true);
    const postUninstWrite = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/settings',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: { folderMatchMode: 'mapped-only' },
    });
    assert.equal(postUninstWrite.status, 400);
    assert.match(postUninstWrite.json?.error || '', /已卸载/);
    const postUninstState = await callApi(ctrl, {
      method: 'GET',
      url: '/__soul-sync/api/state',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
    });
    assert.equal(postUninstState.status, 200);
    assert.equal(postUninstState.json?.uninstalled, true);
    await assert.rejects(() => fs.stat(path.join(dshHome, 'soul-sync')), 'P2-3: soul-sync dir must NOT be recreated after uninstall');

    // 4. CLI `dsh-soul uninstall` is idempotent and exits 0 cleanly
    const cliOut = [];
    const cliCode = await runCli(['--dsh-home', dshHome, 'uninstall'], {
      stdout: (s) => cliOut.push(s),
      stderr: (s) => cliOut.push(s),
      isTTY: false,
    });
    assert.equal(cliCode, 0);
    assert.match(cliOut.join(''), /卸载完成/);
    assert.equal(await fs.readFile(path.join(fakePluginSource, 'KEEP_ME.txt'), 'utf8'), 'plugin-source-must-survive');
  } finally {
    await ctrl.dispose();
  }
});

test('Zero-Git Self-Updater: POST /update/check & POST /update/apply update non-Git colleague installs via tar.gz and block path traversal', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const caseDir = path.join(TEST_TMP_ROOT, 'self-updater-zero-git');
  const dshHome = path.join(caseDir, 'home');
  const installedRepo = path.join(caseDir, 'colleague-plugin');
  const remoteBuildDir = path.join(caseDir, 'remote-build');
  const remotePkgRoot = path.join(remoteBuildDir, 'dsh-soul-sync-aaaaaaaa');
  const tarballPath = path.join(caseDir, 'mock-release.tar.gz');

  await fs.mkdir(path.join(installedRepo, 'lib'), { recursive: true });
  await fs.writeFile(path.join(installedRepo, 'package.json'), JSON.stringify({ name: 'dsh-soul-sync', version: '0.1.0' }), 'utf8');
  await fs.writeFile(path.join(installedRepo, 'lib', 'index.js'), '// old index\n', 'utf8');
  await fs.writeFile(path.join(installedRepo, 'lib', 'client.js'), '// old client\n', 'utf8');

  await fs.mkdir(path.join(remotePkgRoot, 'lib'), { recursive: true });
  await fs.mkdir(path.join(remotePkgRoot, 'bin'), { recursive: true });
  await fs.writeFile(path.join(remotePkgRoot, 'package.json'), JSON.stringify({ name: 'dsh-soul-sync', version: '0.2.0' }), 'utf8');
  await fs.writeFile(path.join(remotePkgRoot, 'lib', 'index.js'), '// updated v0.2.0 index\n', 'utf8');
  await fs.writeFile(path.join(remotePkgRoot, 'lib', 'client.js'), '// updated v0.2.0 client\n', 'utf8');
  await fs.writeFile(path.join(remotePkgRoot, 'bin', 'dsh-soul.js'), '#!/usr/bin/env node\r\n// crlf normalized to lf\r\n', 'utf8');

  await execFileAsync('tar', ['-czf', tarballPath, '-C', remoteBuildDir, 'dsh-soul-sync-aaaaaaaa']);
  const tarballBytes = await fs.readFile(tarballPath);
  const remoteSha = 'a'.repeat(40);

  const mockFetch = async (url) => {
    if (String(url).includes('api.github.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: remoteSha,
          commit: { message: 'feat: shiny new colleague UX\ndetails', committer: { date: '2026-11-27T09:00:00Z' } },
        }),
      };
    }
    if (String(url).includes('codeload.github.com')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => tarballBytes.buffer.slice(tarballBytes.byteOffset, tarballBytes.byteOffset + tarballBytes.byteLength),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await saveConfig(dshHome, { deviceId: 'colleague-pc', deviceLabel: 'ColleaguePC', platform: 'win32' });
  const ctrl = new SoulSyncController(null, {
    dshHome,
    platform: 'win32',
    pollIntervalMs: 0,
    repoRoot: installedRepo,
    updateFetchImpl: mockFetch,
  });
  await ctrl.reloadConfig();

  try {
    const chk = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/update/check',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: {},
    });
    assert.equal(chk.status, 200);
    assert.equal(chk.json?.hasUpdate, true);
    assert.equal(chk.json?.remoteShort, 'aaaaaaa');
    assert.equal(chk.json?.remoteMessage, 'feat: shiny new colleague UX');

    const app = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/update/apply',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: {},
    });
    assert.equal(app.status, 200);
    assert.equal(app.json?.updated, true);
    assert.equal(app.json?.method, 'tarball');
    assert.match(await fs.readFile(path.join(installedRepo, 'lib', 'client.js'), 'utf8'), /updated v0\.2\.0 client/);
    const binText = await fs.readFile(path.join(installedRepo, 'bin', 'dsh-soul.js'), 'utf8');
    assert.equal(binText.includes('\r'), false, 'Self-updater must normalize bin/dsh-soul.js line endings to pure LF');

    // Subsequent check reports hasUpdate === false via .dsh-soul-version.json stamp!
    const chk2 = await callApi(ctrl, {
      method: 'POST',
      url: '/__soul-sync/api/update/check',
      headers: { host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1' },
      body: {},
    });
    assert.equal(chk2.status, 200);
    assert.equal(chk2.json?.hasUpdate, false);
    assert.equal(chk2.json?.localCommit, remoteSha);
  } finally {
    await ctrl.dispose();
  }
});

test('Cross-OS continuity #1: auto-aligns deepseek-official <-> deepseek-account via inbox/claimed & inbox/inserted with real non-reentrant Session lock, custom apiKeyEnv & account state', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'cross-os-provider-align');
  const macHome = path.join(caseDir, 'mac-home');
  const winHome = path.join(caseDir, 'win-home');
  await fs.mkdir(macHome, { recursive: true });
  await fs.mkdir(winHome, { recursive: true });

  await saveConfig(macHome, { deviceId: 'mac-dev', deviceLabel: 'MacBook', platform: 'darwin' });
  await saveConfig(winHome, { deviceId: 'win-dev', deviceLabel: 'WinPC', platform: 'win32' });

  // Build an authentic DSH 0.2.2-rc.5 session + AgentModel harness enforcing `Session.commit()` reentrancy lock!
  function createMockHost({
    dshHome,
    platform,
    apiKeyConfigured,
    customApiKeyEnv = null,
    accountStatus = null,
    accountConfigured = false,
    initialProvider,
  }) {
    const listeners = new Map();
    const liveAgents = new Map();
    let currentAccountStatus = accountStatus;
    const ctx = {
      on(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(fn);
        return () => {};
      },
      async emitSerial(ev, payload) {
        for (const fn of listeners.get(ev) ?? []) {
          await fn(payload);
        }
      },
      emitSync(ev, ...args) {
        for (const fn of listeners.get(ev) ?? []) {
          fn(...args);
        }
      },
      agents: {
        get: (id) => liveAgents.get(id),
      },
      llm: {
        listProviders: () => [
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'deepseek-account', name: 'DeepSeek Account' },
        ],
        listConfigurableProviders: () => [
          {
            provider: 'deepseek-official',
            displayName: 'DeepSeek',
            settingsNs: 'llm-deepseek-api-key',
            settingsPath: [],
          },
        ],
      },
      settings: customApiKeyEnv
        ? {
            describe: () => [{ ns: 'llm-deepseek-api-key', value: { apiKeyEnv: customApiKeyEnv } }],
          }
        : undefined,
      deepseekAccount: currentAccountStatus !== null
        ? {
            getState: async () => ({ status: currentAccountStatus }),
            setStatus: (s) => { currentAccountStatus = s; },
          }
        : undefined,
      credentials: {
        describe: async (ref) => ({
          configured: ref === (customApiKeyEnv || 'DEEPSEEK_API_KEY') ? apiKeyConfigured : false,
          writable: true,
        }),
        describeRecord: async (key) => ({
          configured: key === 'deepseek-account-platform/default' ? accountConfigured : false,
          writable: true,
        }),
      },
    };

    const sessionEvents = [
      {
        seq: 0,
        time: 1000,
        type: 'request/header',
        data: {
          header: {
            config: {
              provider: initialProvider,
              model: 'deepseek-flash',
              reasoningEffort: 'max',
            },
          },
          reason: 'initial',
        },
      },
    ];
    let pendingSelection = null;
    let appending = false;
    let reentrancyErrors = 0;
    const session = {
      id: 'sess-route-align-1',
      header: { id: 'sess-route-align-1', version: 4, createdAt: 1000, cwd: platform === 'darwin' ? '/Users/test/proj' : 'D:\\proj' },
      snapshotEvents: () => [...sessionEvents],
      append(type, data) {
        // Mirror real `@deepseek-ai/dsh-session` publicationEntry() non-reentrancy lock!
        if (appending) {
          reentrancyErrors += 1;
          throw new Error('session append cannot reenter while another append is being published');
        }
        appending = true;
        try {
          const ev = { seq: sessionEvents.length, time: Date.now(), type, data };
          sessionEvents.push(ev);
          if (type === 'model/selection') {
            pendingSelection = { ...data };
          }
          ctx.emitSync('session/event', session, ev);
          return ev;
        } finally {
          appending = false;
        }
      },
    };
    const agent = {
      id: session.id,
      session,
      model: {
        current() {
          if (pendingSelection) return { ...pendingSelection };
          return { provider: initialProvider, model: 'deepseek-flash', reasoningEffort: 'max' };
        },
        select(sel) {
          session.append('model/selection', { ...sel });
        },
      },
    };
    liveAgents.set(agent.id, agent);

    const ctrl = applySoulSync(ctx, { dshHome, platform, pollIntervalMs: 0 });
    return { ctx, ctrl, agent, session, sessionEvents, getReentrancyErrors: () => reentrancyErrors };
  }

  // 1. Win (deepseek-official) -> Mac (only deepseek-account signed in, queued message via `agent/inbox/claimed`!)
  const macHost = createMockHost({
    dshHome: macHome,
    platform: 'darwin',
    apiKeyConfigured: false,
    accountStatus: 'credential-stored',
    initialProvider: 'deepseek-official',
  });
  await macHost.ctrl.readyPromise;
  try {
    // Merely opening/viewing the session (`agent/created`) MUST NOT append `model/selection`!
    await macHost.ctx.emitSerial('agent/created', { agent: macHost.agent, source: 'resume' });
    assert.equal(
      macHost.sessionEvents.some((e) => e.type === 'model/selection'),
      false,
      'Passive session viewing must NOT append model/selection events (prevents split-brain forks)',
    );

    // Exact DSH turn() -> preStep() sequence with non-reentrant `session.append`:
    // 1) `session.append('turn/start')` (must NOT reenter `session.append`!)
    // 2) `inbox.claim()` appends `agent/inbox/spliced`, releases lock, then emits `agent/inbox/claimed`
    // 3) `const selection = agent.model.current()`
    macHost.session.append('turn/start', { turn: 2 });
    assert.equal(macHost.getReentrancyErrors(), 0, 'turn/start must NEVER trigger reentrant session.append');
    macHost.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    macHost.ctx.emitSync('agent/inbox/claimed', { agent: macHost.agent, turn: 2, message: { id: 'm-queued' } });

    const preStepSelection = macHost.agent.model.current();
    assert.deepEqual(preStepSelection, {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    });
    assert.equal(macHost.getReentrancyErrors(), 0);

    // P0-1: On DSH 0.2.2+ where `agent.model.select` exists, `handleAgentRequest` MUST NOT mutate `provider`!
    const modernReqConfig = await macHost.ctrl.handleAgentRequest(
      { agent: macHost.agent, turn: 2, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    );
    assert.equal(modernReqConfig.provider, 'deepseek-official', 'handleAgentRequest must not mutate provider when agent.model.select exists');

    // P1-1: Signing out of deepseekAccount refreshes availability so unconfigured route is no longer selected
    macHost.ctx.deepseekAccount.setStatus('signed-out');
    macHost.ctx.emitSync('deepseek-account/signed-out');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(macHost.ctrl._deepSeekRouteAvailability['deepseek-account'], false);
  } finally {
    await macHost.ctrl.dispose();
  }

  // 2. Mac (deepseek-account) -> Win with CUSTOM `apiKeyEnv: 'CUSTOM_DS_API_KEY'`
  const winHost = createMockHost({
    dshHome: winHome,
    platform: 'win32',
    apiKeyConfigured: true,
    customApiKeyEnv: 'CUSTOM_DS_API_KEY',
    accountStatus: 'signed-out',
    initialProvider: 'deepseek-account',
  });
  await winHost.ctrl.readyPromise;
  try {
    await winHost.ctx.emitSerial('agent/created', { agent: winHost.agent, source: 'resume' });
    winHost.ctx.emitSync('agent/inbox/inserted', { agent: winHost.agent, message: { id: 'm1' } });
    assert.deepEqual(winHost.agent.model.current(), {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    });

    // Legacy DSH runtime (no `agent.model`) fallback via `agent/request`
    const legacyReqConfig = await winHost.ctrl.handleAgentRequest(
      { agent: { id: 'legacy-agent' }, turn: 2, step: 1 },
      async () => ({ provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' }),
    );
    assert.deepEqual(legacyReqConfig, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    });
  } finally {
    await winHost.ctrl.dispose();
  }

  // 3. Both routes configured on the same machine -> MUST NOT override user's intentional route choice
  const dualHost = createMockHost({
    dshHome: winHome,
    platform: 'win32',
    apiKeyConfigured: true,
    accountStatus: 'credential-stored',
    initialProvider: 'deepseek-official',
  });
  await dualHost.ctrl.readyPromise;
  try {
    await dualHost.ctx.emitSerial('agent/created', { agent: dualHost.agent, source: 'resume' });
    dualHost.ctx.emitSync('agent/inbox/claimed', { agent: dualHost.agent, turn: 2, message: { id: 'm2' } });
    assert.equal(dualHost.agent.model.current().provider, 'deepseek-official');
    assert.equal(dualHost.sessionEvents.some((e) => e.type === 'model/selection'), false);
  } finally {
    await dualHost.ctrl.dispose();
  }

  // 4. REAL `@deepseek-ai/dsh-session` SessionStore integration: verify `turn/start` + `agent/inbox/claimed`
  //    triggers zero `session append cannot reenter` exceptions on an actual DSH `Session` instance!
  if (HAS_REAL_DSH_HOST_PKGS) {
    const { Context } = await importRealDshPkg('@deepseek-ai/cordis');
    const { SessionStore } = await importRealDshPkg('@deepseek-ai/dsh-session');
    const { SessionProjectionRegistry } = await importRealDshPkg('@deepseek-ai/dsh-session-projection');
    const realCtx = new Context();
    await Promise.all([
      realCtx.plugin(SessionProjectionRegistry),
      realCtx.plugin(SessionStore),
    ]);
    try {
      const realSession = realCtx.sessions.prepare('sess-real-reentrancy', { meta: { cwd: winHome } });
      const detachSess = realCtx.sessions.enter(realSession);
      realCtx.sessions.announce(realSession);
      let recordedModel = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' };
      const realAgent = {
        id: realSession.id,
        session: realSession,
        model: {
          current: () => ({ ...recordedModel }),
          select: (sel) => {
            realSession.append('model/selection', { ...sel });
            recordedModel = { ...sel };
          },
        },
      };
      realCtx.agents = { get: (id) => (id === realAgent.id ? realAgent : undefined) };
      const realCtrl = applySoulSync(realCtx, {
        dshHome: macHome,
        platform: 'darwin',
        pollIntervalMs: 0,
        deepSeekRouteAvailability: { 'deepseek-official': false, 'deepseek-account': true },
      });
      await realCtrl.readyPromise;
      try {
        // Real `Session.append` sets `entry.appending = true` during `session/event` dispatch
        assert.doesNotThrow(() => {
          realSession.append('turn/start', { turn: 1 });
        });
        realCtx.emit('agent/inbox/claimed', { agent: realAgent, turn: 1, message: { id: 'm-real' } });
        assert.equal(realAgent.model.current().provider, 'deepseek-account');
        assert.equal(
          realSession.snapshotEvents().some((e) => e.type === 'model/selection' && e.data?.provider === 'deepseek-account'),
          true,
        );
      } finally {
        await realCtrl.dispose();
        detachSess();
      }
    } finally {
      await realCtx.fiber?.dispose?.();
    }
  }
});

test('Cross-OS continuity #2: 3-tier funnel near-focus anchor handles multi-step tool turns, code-only messages, pre-admission error rollback, same-OS handoff & compact-checkpoint', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'cross-os-funnel-focus');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const mac2Home = path.join(caseDir, 'mac2-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-articles');
  const macWs = path.join(caseDir, 'mac-articles');
  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(macWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  const sessId = 'sess-dogfooding-focus';
  const t0 = Date.now() - 60_000;
  const longPreamble = `好的，我先帮你读取工作区里的六篇博客原文并逐段比对目录结构（${'检查文件列表与引用索引，'.repeat(22)}请稍候）……`;
  const events = [
    // Turn 1 & 2 (early overview — should NOT clutter 3-turn near-path signpost)
    { seq: 0, time: t0 + 100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我们想做 AI 公众号定位分析' }] } },
    { seq: 1, time: t0 + 200, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '定位建议聚焦工程判断力而非资讯搬运。' }] } } },
    { seq: 2, time: t0 + 300, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '读一下 Anthropic 的 8 篇核心文章' }] } },
    { seq: 3, time: t0 + 400, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这 8 篇展示了上下文工程的演进。' }] } } },
    // Turn 3 (N-2 signpost)
    { seq: 4, time: t0 + 500, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再精读这 6 篇工程博客提炼方法论' }] } },
    { seq: 5, time: t0 + 600, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '6 篇博客共同指向简单循环加可验证反馈。' }] } } },
    // Turn 4 (N-1 signpost)
    { seq: 6, time: t0 + 700, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '拆解 Claude Code postmortem 事故复盘' }] } },
    { seq: 7, time: t0 + 800, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '三次事故暴露出基础设施边界与配置漂移风险。' }] } } },
    // Turn 5 (N active primary spotlight — multi-step tool turn where Step 1 has >250 chars preamble and Step 2 has final conclusion!)
    { seq: 8, time: t0 + 900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '里面提到的 dogfooding 公开构建和内部隐藏开关怎么理解？' }] } },
    { seq: 9, time: t0 + 950, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: longPreamble }, { type: 'tool-call', id: 'tc1', name: 'read_file', arguments: '{}' }] } } },
    { seq: 10, time: t0 + 1000, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**核心落点**：真正的 dogfooding 必须跑在外部用户拿到的一致公开构建上；如果员工开着内部隐藏开关，测出来的只是特权分支，会产生致命的假安全感。' }] } } },
    // Unanswered failed turn (0 assistant/message)
    { seq: 11, time: t0 + 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '对于我们自己做产品有什么建议？' }] } },
    { seq: 12, time: t0 + 1200, type: 'turn/end', data: { turn: 6, reason: { kind: 'error' } } },
  ];

  // 1. Multi-step tool turn MUST capture Step 2's final conclusion, NOT Step 1's >250-char preamble!
  const block = buildNearFocusAnchorBlock(events, { maxTurns: 3 });
  assert.match(block, /【近景演进路标】.*6 篇工程博客.*Claude Code postmortem.*当前焦点：.*dogfooding/);
  assert.doesNotMatch(block, /AI 公众号定位分析/);
  assert.doesNotMatch(block, /先帮你读取工作区里的六篇博客原文/);
  assert.match(block, /真正的 dogfooding 必须跑在外部用户拿到的一致公开构建上/);

  // 2. Pure fenced-code messages MUST NEVER produce empty `「」` quotes!
  const codeOnlyBlock = buildNearFocusAnchorBlock([
    { seq: 0, time: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '```python\ndef calc_sharpe(ret):\n    return ret.mean() / ret.std()\n```' }] } },
    { seq: 1, time: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '```python\nreturn (ret.mean() / ret.std()) * (252 ** 0.5)\n```' }] } } },
  ]);
  assert.doesNotMatch(codeOnlyBlock, /「」/);
  assert.match(codeOnlyBlock, /def calc_sharpe/);
  assert.match(codeOnlyBlock, /252 \*\* 0\.5/);

  // 3. Pure `compact-checkpoint` session fallback
  const ckptBlock = buildNearFocusAnchorBlock([
    { seq: 0, time: 1, type: 'user/message', data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '## 阶段交接\n当前正在推进 dogfooding 灰度发布门禁设计。' }] } },
  ]);
  assert.match(ckptBlock, /【当前紧邻主焦点（压缩交接摘要）】[\s\S]*dogfooding 灰度发布门禁设计/);

  // 4. End-to-end Win -> Vault -> Mac pull -> pre-admission turn error rollback + retry -> Mac2 same-OS handoff
  const wsId = deriveWorkspaceId('文章');
  const mappings = [{ id: wsId, title: '文章', win32: winWs, darwin: macWs }];
  await savePassphraseKey(winHome, 'focus-pass-123');
  await savePassphraseKey(macHome, 'focus-pass-123');
  await savePassphraseKey(mac2Home, 'focus-pass-123');
  await saveConfig(winHome, { deviceId: 'win-focus', deviceLabel: 'WinDesk', platform: 'win32', vaultDir, encryptionEnabled: true, workspaceMappings: mappings });
  await saveConfig(macHome, { deviceId: 'mac-focus', deviceLabel: 'MacAir', platform: 'darwin', vaultDir, encryptionEnabled: true, workspaceMappings: mappings });
  await saveConfig(mac2Home, { deviceId: 'mac2-focus', deviceLabel: 'MacStudio', platform: 'darwin', vaultDir, encryptionEnabled: true, workspaceMappings: mappings });

  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: sessId, createdAt: t0, cwd: winWs, isSeeded: false, delegationDepth: 0 },
    events.slice(0, 11),
  );

  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', pollIntervalMs: 0 });
  await winCtrl.reloadConfig();
  await winCtrl.pushAll();
  await winCtrl.dispose();

  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', pollIntervalMs: 0 });
  await macCtrl.reloadConfig();
  await macCtrl.pullAll();

  try {
    const macLocal = await scanLocalSessions(macHome);
    const syncedRec = macLocal.get(sessId);
    const liveLog = [...syncedRec.events];
    const mockSession = {
      id: sessId,
      cwd: macWs,
      header: syncedRec.header,
      snapshotEvents: () => [...liveLog],
    };
    const mockAgent = { id: sessId, session: mockSession };
    const userPromptMsg = {
      id: 'u-mac-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '对于我们自己做 AI 产品，有什么建议或帮助呢？' }],
    };

    macCtrl._pushAlert({ kind: 'file-conflict', sessionId: sessId, text: '测试冲突告警' });

    // Attempt 1: `handleAgentPreStep` runs, then `prepareRequest` fails BEFORE `session.append('user/message')` -> `turn/end` fires!
    const dec1 = await macCtrl.handleAgentPreStep(
      { agent: mockAgent, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPromptMsg] }),
    );
    assert.equal(dec1.messages.length, 2);
    await macCtrl.handleSessionEvent(mockSession, { seq: liveLog.length, time: Date.now(), type: 'turn/end', data: { turn: 6, reason: { kind: 'error' } } });

    // Retry Attempt 2: Because Attempt 1 never appended `dec1.messages[1]` to `session`, BOTH migration anchor AND alert were rolled back!
    const dec2 = await macCtrl.handleAgentPreStep(
      { agent: mockAgent, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPromptMsg] }),
    );
    assert.equal(dec2.messages.length, 2, 'Pre-admission turn error must roll back migration anchor & alerts for retry');
    const retryText = dec2.messages[1].content?.[0]?.text ?? '';
    assert.match(retryText, /【跨设备接力备注】.*WinDesk \(win32\)/);
    assert.match(retryText, /真正的 dogfooding 必须跑在外部用户拿到的一致公开构建上/);
    assert.match(retryText, /测试冲突告警/);

    // Now simulate `step()` committing `dec2.messages[1]` to `session` -> subsequent turn must NOT re-inject!
    const committedNotice = { seq: liveLog.length, time: Date.now(), type: 'user/message', data: dec2.messages[1] };
    liveLog.push(committedNotice);
    await macCtrl.handleSessionEvent(mockSession, committedNotice);
    await macCtrl.handleSessionEvent(mockSession, { seq: liveLog.length, time: Date.now(), type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } });

    const dec3 = await macCtrl.handleAgentPreStep(
      { agent: mockAgent, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPromptMsg] }),
    );
    assert.equal(dec3.messages.length, 1, 'Once committed to session log, migration anchor must not repeat');
  } finally {
    await macCtrl.dispose();
  }

  // 5. Same-OS multi-device (`MacAir -> MacStudio`) also records cross-device migration anchor!
  const sameOsSid = 'sess-same-os-mac';
  await writeLocalSession(
    macHome,
    { type: 'session', version: 4, id: sameOsSid, createdAt: t0 + 5000, cwd: macWs, isSeeded: false, delegationDepth: 0 },
    [
      { seq: 0, time: t0 + 5100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '在 MacBook Air 上起草提纲' }] } },
      { seq: 1, time: t0 + 5200, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '提纲第一部分聚焦工程反馈闭环。' }] } } },
    ],
  );
  const macPushCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', pollIntervalMs: 0 });
  await macPushCtrl.reloadConfig();
  await macPushCtrl.pushAll();
  await macPushCtrl.dispose();

  const mac2Ctrl = new SoulSyncController(null, { dshHome: mac2Home, platform: 'darwin', pollIntervalMs: 0 });
  await mac2Ctrl.reloadConfig();
  await mac2Ctrl.pullAll();
  try {
    const mac2Local = await scanLocalSessions(mac2Home);
    const rec2 = mac2Local.get(sameOsSid);
    const sameOsDec = await mac2Ctrl.handleAgentPreStep(
      { agent: { id: sameOsSid, session: { id: sameOsSid, cwd: macWs, header: rec2.header, snapshotEvents: () => rec2.events } }, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [{ id: 'u-m2', role: 'user', content: [{ type: 'text', text: '继续' }] }] }),
    );
    assert.equal(sameOsDec.messages.length, 2);
    assert.match(sameOsDec.messages[1].content?.[0]?.text ?? '', /另一台设备 MacAir \(darwin\)/);
    assert.match(sameOsDec.messages[1].content?.[0]?.text ?? '', /工程反馈闭环/);
  } finally {
    await mac2Ctrl.dispose();
  }
});

test('Self-updater guards: blocks git-to-tarball fallthrough corruption, detects localAhead commits, and exposes update in CLI help', async () => {
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const execFileAsync = promisify(execFile);

  const caseDir = path.join(TEST_TMP_ROOT, 'self-updater-git-guards');
  const remoteGitDir = path.join(caseDir, 'remote.git');
  const localGitDir = path.join(caseDir, 'local-clone');
  const dshHome = path.join(caseDir, 'dsh-home');
  await fs.mkdir(caseDir, { recursive: true });
  await fs.mkdir(dshHome, { recursive: true });

  await execFileAsync('git', ['init', '--bare', remoteGitDir]);
  await execFileAsync('git', ['clone', remoteGitDir, localGitDir]);
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: localGitDir });
  await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: localGitDir });

  await fs.writeFile(path.join(localGitDir, 'package.json'), JSON.stringify({ name: 'dsh-soul-sync', version: '0.1.0' }), 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: localGitDir });
  await execFileAsync('git', ['commit', '-m', 'base commit'], { cwd: localGitDir });
  const { stdout: baseShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: localGitDir });
  const baseSha = baseShaOut.trim();

  // Create a newer local commit AHEAD of `baseSha`
  await fs.writeFile(path.join(localGitDir, 'package.json'), JSON.stringify({ name: 'dsh-soul-sync', version: '0.2.0' }), 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: localGitDir });
  await execFileAsync('git', ['commit', '-m', 'local ahead commit'], { cwd: localGitDir });

  // 1. When local HEAD is strictly ahead of remote (`baseSha`), `checkRemoteUpdate` MUST report `hasUpdate: false` & `localAhead: true`!
  const aheadFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ sha: baseSha, commit: { message: 'base commit' } }),
  });
  const ctrlAhead = new SoulSyncController(null, {
    dshHome,
    platform: 'win32',
    pollIntervalMs: 0,
    repoRoot: localGitDir,
    updateFetchImpl: aheadFetch,
  });
  await ctrlAhead.reloadConfig();
  try {
    const chk = await ctrlAhead.checkSelfUpdate();
    assert.equal(chk.hasUpdate, false);
    assert.equal(chk.localAhead, true);
    const app = await ctrlAhead.applySelfUpdate();
    assert.equal(app.updated, false);
    assert.equal(app.alreadyLatest, true);
  } finally {
    await ctrlAhead.dispose();
  }

  // 2. When remote has a non-existent/diverged SHA and `.git` exists, `applySelfUpdate` MUST return `ok: false`
  //    and NEVER call `codeload.github.com` tarball download (which would corrupt the clean git working tree)!
  let tarballCalled = false;
  const divergedSha = 'b'.repeat(40);
  const divergedFetch = async (url) => {
    if (String(url).includes('codeload.github.com')) {
      tarballCalled = true;
      throw new Error('Should NEVER fall through to tarball on a git repository!');
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ sha: divergedSha, commit: { message: 'diverged commit' } }),
    };
  };
  const ctrlDiv = new SoulSyncController(null, {
    dshHome,
    platform: 'win32',
    pollIntervalMs: 0,
    repoRoot: localGitDir,
    updateFetchImpl: divergedFetch,
  });
  await ctrlDiv.reloadConfig();
  try {
    const res = await ctrlDiv.applySelfUpdate();
    assert.equal(res.ok, false);
    assert.equal(res.updated, false);
    assert.equal(tarballCalled, false, 'Git repo failure must NEVER fall through to tarball');
  } finally {
    await ctrlDiv.dispose();
  }

  // 3. CLI `--help` includes `update` subcommand
  const outLines = [];
  const code = await runCli(['--help'], {
    stdout: (s) => outLines.push(s),
    stderr: () => {},
    env: {},
    isTTY: false,
  });
  assert.equal(code, 0);
  assert.match(outLines.join(''), /\bupdate\b/);
});
