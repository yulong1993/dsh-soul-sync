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

    // 3. Opus P1 Legacy Probe C: Un-timestamped legacy mapping ID `"文章"` MUST NOT be overwritten by peer's `"文章-xxxx"`!
    const legacyVault = path.join(caseDir, 'legacy-vault');
    const legWinHome = path.join(caseDir, 'leg-win');
    const legMacHome = path.join(caseDir, 'leg-mac');
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
    await legWinCtrl.syncGlobalWorkspaceMetadata();
    assert.deepEqual(
      legWinCtrl.config.workspaceMappings.map((m) => m.id),
      ['文章'],
      'Opus P1 Legacy Probe C: established legacy ID "文章" must be preserved against peer hashed ID',
    );

    // 4. Neon P1 #5: `withdrawUnselected` MUST NOT trap sessions when switching back to `syncScope: 'active'`!
    await writeLocalSession(
      legWinHome,
      { type: 'session', version: 4, id: 'sess-unselected-recover', createdAt: now - 2000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: now - 1900, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Recoverable session' }] } }],
    );
    await legWinCtrl.pushAll();
    await legWinCtrl.updateSettings({
      syncScope: 'selected',
      selectedSessionIds: [],
      selectedWorkspaces: [],
      withdrawUnselected: true,
    });
    assert.equal((legWinCtrl.config.withdrawnSessions ?? {})['sess-unselected-recover'], undefined, 'Neon P1 #5: withdrawUnselected must not write permanent withdrawnSessions tombstone');
    await legWinCtrl.updateSettings({ syncScope: 'active' });
    const backActivePush = await legWinCtrl.pushAll();
    const vaultAfterBackActive = await legWinCtrl.vault.listCommits('session');
    assert.ok(
      backActivePush.sessionPushedCount >= 1
      && vaultAfterBackActive.commits.some((c) => c.targetId === 'sess-unselected-recover'),
      'Neon P1 #5: switching back to syncScope=active must resume syncing previously unselected session',
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
