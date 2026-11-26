import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  saveConfig,
  savePassphraseKey,
  writeFileAtomic,
} from '../lib/config.js';
import { VaultStore } from '../lib/crypto-vault.js';
import { encodeSegment, projectKey, encodeV4SessionLog, decodeV4SessionLog } from '../lib/zstd-v4.js';
import {
  AUTO_MIRROR_SENTINEL,
  countUserTurns,
  isSubstantiveSession,
  exportSessionClosure,
  exportAllLocalSessions,
  pullSessionsFromVault,
  scanLocalSessions,
  listLocalCatalog,
  listVaultCatalog,
  shouldAutoSyncSession,
} from '../lib/session-plane.js';
import {
  pushWorkspaceDeliverables,
  pullWorkspaceDeliverables,
  loadWorkspaceDeliverableState,
} from '../lib/deliverable-plane.js';
import { isRealHumanUserEvent, selectTailPreservingSpan } from '../lib/tail-compactor.js';
import { SoulSyncController } from '../lib/index.js';
import { runCli } from '../bin/dsh-soul.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_ROOT = path.join(REPO_ROOT, '.test-tmp', `demand-fixes-${process.pid}-${Date.now()}`);

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

test('P0-1 / F1 + F14: Origin dsh-app://app preflight/GET/POST, Host header DNS-rebinding block & client.js relative fetch', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'p0-1-origin-host');
  const dshHome = path.join(caseDir, 'home');
  const vaultDir = path.join(caseDir, 'vault');
  await fs.mkdir(vaultDir, { recursive: true });

  await saveConfig(dshHome, { vaultDir, deviceLabel: 'WinDesktop', platform: 'win32' });
  const ctrl = new SoulSyncController(null, { dshHome, platform: 'win32', pollIntervalMs: 0 });
  await ctrl.reloadConfig();

  // 1. Electron desktop Origin: dsh-app://app -> OPTIONS 204, GET 200, POST 200
  const optRes = await callApi(ctrl, {
    method: 'OPTIONS',
    url: '/__soul-sync/api/state',
    headers: { origin: 'dsh-app://app', host: '127.0.0.1:3080' },
  });
  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers['access-control-allow-origin'], 'dsh-app://app');

  const getRes = await callApi(ctrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: { origin: 'dsh-app://app', host: 'app', 'x-dsh-soul-sync': '1' },
  });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.json.ok, true);

  const postRes = await callApi(ctrl, {
    method: 'POST',
    url: '/__soul-sync/api/settings',
    headers: { origin: 'dsh-app://app', host: '127.0.0.1:3080', 'x-dsh-soul-sync': '1', 'content-type': 'application/json' },
    body: { deviceLabel: 'DesktopUpdated' },
  });
  assert.equal(postRes.status, 200);
  assert.equal(postRes.json.config.deviceLabel, 'DesktopUpdated');

  // 2. Host header DNS rebinding guard: evil host rejected with 403; loopback hosts accepted
  const rebindRes = await callApi(ctrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: { host: 'attacker.rebind.test:3080', 'x-dsh-soul-sync': '1' },
  });
  assert.equal(rebindRes.status, 403);
  assert.equal(rebindRes.json.error, 'forbidden host');

  for (const goodHost of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080', 'app']) {
    const okHost = await callApi(ctrl, {
      method: 'GET',
      url: '/__soul-sync/api/state',
      headers: { host: goodHost, 'x-dsh-soul-sync': '1' },
    });
    assert.equal(okHost.status, 200, `Expected Host ${goodHost} to be allowed`);
  }

  // 3. client.js uses relative '/__soul-sync/api' without streamBaseUrl splicing & zero obsolete "设置 → 插件 → Soul Sync" strings
  const clientJs = await fs.readFile(path.join(REPO_ROOT, 'lib', 'client.js'), 'utf8');
  assert.equal(clientJs.includes('streamBaseUrl'), false, 'client.js must not splice cross-origin streamBaseUrl');
  assert.match(clientJs, /fetch\('\/__soul-sync\/api'\s*\+\s*path/);
  assert.match(clientJs, /resp\.text\(\)/);
  assert.match(clientJs, /detectInitialPlatform/);
  assert.match(clientJs, /金库连接与加密基础设置/);

  for (const rel of ['lib/client.js', 'lib/index.js', 'README.md', 'INSTALL_PROMPT.md']) {
    const text = await fs.readFile(path.join(REPO_ROOT, rel), 'utf8');
    assert.equal(text.includes('设置 → 插件 → Soul Sync'), false, `${rel} must not reference non-existent Settings->Plugins->Soul Sync`);
    assert.equal(text.includes('设置 → 插件'), false, `${rel} must not tell users to configure via Settings->Plugins`);
  }

  await ctrl.dispose();
});

test('P0-2 / F2: wrong passphrase decryptionFailedCount vs hydrationPendingCount, vaultError isolation & self-recovery via POST /settings', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'p0-2-recovery');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  // Win pushes an encrypted session with passphrase A
  const winKeys = await savePassphraseKey(winHome, 'correct-passphrase-2026');
  const winVault = new VaultStore({ vaultDir, deviceId: 'win-enc', platform: 'win32', secretKeys: winKeys });
  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: 'sess-enc-01', createdAt: 1000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '机密财报分析' }] } }],
  );
  await exportSessionClosure({ dshHome: winHome, vault: winVault, sessionId: 'sess-enc-01' });

  // Also plant a .icloud placeholder commit to verify hydrationPendingCount is counted separately
  const icloudPath = path.join(vaultDir, 'devices', 'win-enc', 'session-commits', '.9999-1-abcd1234.commit.icloud');
  await fs.writeFile(icloudPath, 'icloud-placeholder');

  // Mac configured with WRONG passphrase B
  await savePassphraseKey(macHome, 'wrong-passphrase-9999');
  await saveConfig(macHome, {
    deviceId: 'mac-wrong',
    deviceLabel: 'MacWrong',
    platform: 'darwin',
    vaultDir,
    encryptionEnabled: true,
  });

  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', pollIntervalMs: 0 });
  await macCtrl.reloadConfig();

  const badState = await callApi(macCtrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: { 'x-dsh-soul-sync': '1' },
  });
  assert.equal(badState.status, 200);
  assert.equal(badState.json.vaultConfigured, true);
  assert.equal(badState.json.hasSecretKey, true);
  assert.equal(badState.json.decryptionFailedCount, 1, 'Wrong passphrase must report decryptionFailedCount=1');
  assert.equal(badState.json.hydrationPendingCount, 1, 'Cloud placeholder must report hydrationPendingCount=1 separately');
  assert.equal(badState.json.vaultCatalog.totalSessions, 0);

  // Simulate missing secret.key -> startupErrors includes secret.key, then recover via POST /settings with correct passphrase!
  await savePassphraseKey(macHome, '');
  await macCtrl.reloadConfig();
  assert.ok(macCtrl._startupErrors.some((e) => e.includes('secret.key')));

  const fixResp = await callApi(macCtrl, {
    method: 'POST',
    url: '/__soul-sync/api/settings',
    headers: { 'x-dsh-soul-sync': '1', 'content-type': 'application/json' },
    body: { passphrase: 'correct-passphrase-2026' },
  });
  assert.equal(fixResp.status, 200);

  const goodState = await callApi(macCtrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: { 'x-dsh-soul-sync': '1' },
  });
  assert.equal(goodState.status, 200);
  assert.equal(goodState.json.decryptionFailedCount, 0);
  assert.equal(goodState.json.startupErrors.length, 0, 'Stale secret.key startupError must be cleared after saving passphrase');
  assert.equal(goodState.json.vaultCatalog.totalSessions, 1);

  // Verify /soul config passphrase=... also works
  const cfgPass = await macCtrl.handleConfig({ argsText: 'passphrase=correct-passphrase-2026' });
  assert.equal(cfgPass.kind, 'success');

  // Verify vaultError isolation: even if listVaultCatalog throws, GET /state returns 200 with vaultError!
  const origListVault = macCtrl.listVaultCatalog.bind(macCtrl);
  macCtrl.listVaultCatalog = async () => { throw new Error('Simulated OneDrive EACCES offline'); };
  const offlineState = await callApi(macCtrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: { 'x-dsh-soul-sync': '1' },
  });
  assert.equal(offlineState.status, 200);
  assert.match(offlineState.json.vaultError, /OneDrive EACCES/);
  macCtrl.listVaultCatalog = origListVault;

  await macCtrl.dispose();
});

test('P1-1 / F3 + P1-3: tri-state uncheck exclusion, whitelist prefill, vault unpublish, peer suppression & --scope selected', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'p1-1-3-unpublish');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  await fs.mkdir(winWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  await savePassphraseKey(winHome, 'unpub-secret');
  await savePassphraseKey(macHome, 'unpub-secret');
  await saveConfig(winHome, { deviceId: 'win-u', deviceLabel: 'WinU', platform: 'win32', vaultDir, encryptionEnabled: true });
  await saveConfig(macHome, { deviceId: 'mac-u', deviceLabel: 'MacU', platform: process.platform, vaultDir, encryptionEnabled: true, autoMirrorRoot: path.join(caseDir, 'mac-mirrors') });

  for (let i = 1; i <= 5; i += 1) {
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: `sess-tri-${i}`, createdAt: 1000 + i * 100, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 1000 + i * 100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `对话 #${i}` }] } }],
    );
  }

  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', minQuietMs: 0, pollIntervalMs: 0 });
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: process.platform, minQuietMs: 0, pollIntervalMs: 0 });
  await winCtrl.reloadConfig();
  await macCtrl.reloadConfig();

  // 1. Tri-state uncheck: user selects 4 of 5 sessions (unchecks #5) -> workspacePaths MUST be empty so #5 is NOT pushed!
  const push4 = await winCtrl.pushSelected({
    workspacePaths: [],
    sessionIds: ['sess-tri-1', 'sess-tri-2', 'sess-tri-3', 'sess-tri-4'],
  });
  assert.equal(push4.ok, true);
  assert.equal(push4.sessionPushedCount, 4);
  const vaultAfter4 = await macCtrl.listVaultCatalog();
  const sidsAfter4 = vaultAfter4.workspaces.flatMap((w) => w.sessions.map((s) => s.sessionId)).sort();
  assert.deepEqual(sidsAfter4, ['sess-tri-1', 'sess-tri-2', 'sess-tri-3', 'sess-tri-4']);
  assert.equal(sidsAfter4.includes('sess-tri-5'), false, 'Unchecked 5th session must never be pushed');

  // 2. Unpublish sess-tri-3 & sess-tri-4 via HTTP API -> commits deleted, blobs pruned, excluded locally, withdrawnSessions propagated!
  const unpubResp = await callApi(winCtrl, {
    method: 'POST',
    url: '/__soul-sync/api/unpublish',
    headers: { 'x-dsh-soul-sync': '1', 'content-type': 'application/json' },
    body: { sessionIds: ['sess-tri-3', 'sess-tri-4'] },
  });
  assert.equal(unpubResp.status, 200);
  assert.equal(unpubResp.json.removedCommits, 2);

  const winCfgAfterUnpub = await loadConfig(winHome);
  assert.ok(winCfgAfterUnpub.excludedSessionIds.includes('sess-tri-3'));
  assert.ok(winCfgAfterUnpub.withdrawnSessions['sess-tri-3'] > 0);

  // Mac pulls -> ONLY surviving sess-tri-1 and sess-tri-2 arrive (3 & 4 were withdrawn!)
  const macPull = await macCtrl.pullAll();
  assert.equal(macPull.sessions.summary.imported, 2);
  const macCfgAfterPull = await loadConfig(macHome);
  assert.ok(macCfgAfterPull.withdrawnSessions['sess-tri-3'] > 0, 'withdrawnSessions must propagate to peer via global commit');

  // Even if Win runs pushAll() in active mode, withdrawn sessions #3 and #4 must NOT be auto-re-pushed!
  const winRepush = await winCtrl.pushAll();
  const vaultAfterRepush = await macCtrl.listVaultCatalog();
  const vaultSidsAfterRepush = vaultAfterRepush.workspaces.flatMap((w) => w.sessions.map((s) => s.sessionId));
  assert.equal(vaultSidsAfterRepush.includes('sess-tri-3'), false);
  assert.equal(vaultSidsAfterRepush.includes('sess-tri-4'), false);
  assert.equal(winRepush.ok, true);

  // Explicit pushSelected on sess-tri-3 re-publishes it cleanly (overrides withdrawal)!
  const explicitRepush = await winCtrl.pushSelected({ sessionIds: ['sess-tri-3'] });
  assert.equal(explicitRepush.ok, true);
  assert.equal(explicitRepush.sessionPushedCount, 1);

  // 3. CLI `--scope selected` sets syncScope='selected' before first startup
  const freshHome = path.join(caseDir, 'fresh-selected-home');
  const out = [];
  const initCode = await runCli(
    ['--dsh-home', freshHome, 'init', '--non-interactive', '--vault', vaultDir, '--no-passphrase', '--scope', 'selected'],
    { stdout: (s) => out.push(s), stderr: (s) => out.push(s), isTTY: false },
  );
  assert.equal(initCode, 0, out.join(''));
  assert.equal((await loadConfig(freshHome)).syncScope, 'selected');

  await winCtrl.dispose();
  await macCtrl.dispose();
});

test('P1-2 / F6 + F7: both-machines selected sync, pullSelected roundtrip reply, mapped-only overrides, single-session mapped deliverables', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'p1-2-selected-mapped');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winMappedWs = path.join(caseDir, 'win-mapped');
  const macMappedWs = path.join(caseDir, 'mac-mapped');
  const winUnmappedWs = path.join(caseDir, 'win-unmapped');
  const macMirrorRoot = path.join(caseDir, 'mac-mirrors');

  await fs.mkdir(path.join(winMappedWs, 'outputs'), { recursive: true });
  await fs.mkdir(macMappedWs, { recursive: true });
  await fs.mkdir(winUnmappedWs, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  const mappings = [{ id: 'proj-m', title: 'MappedProj', win32: winMappedWs, darwin: macMappedWs, linux: macMappedWs }];
  await savePassphraseKey(winHome, 'p12-secret');
  await savePassphraseKey(macHome, 'p12-secret');

  // BOTH machines in syncScope='selected'!
  await saveConfig(winHome, {
    deviceId: 'win-s',
    deviceLabel: 'WinS',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: true,
    syncScope: 'selected',
    selectedSessionIds: ['sess-mapped-1'],
    workspaceMappings: mappings,
  });
  await saveConfig(macHome, {
    deviceId: 'mac-s',
    deviceLabel: 'MacS',
    platform: 'darwin',
    vaultDir,
    encryptionEnabled: true,
    syncScope: 'selected',
    folderMatchMode: 'mapped-only',
    selectedWorkspaces: [],
    selectedSessionIds: [],
    autoMirrorRoot: macMirrorRoot,
    workspaceMappings: mappings,
  });

  // Create mapped session + deliverable AND unmapped session on Win
  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: 'sess-mapped-1', createdAt: 1000, cwd: winMappedWs, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '单选已映射对话' }] } }],
  );
  await fs.writeFile(path.join(winMappedWs, 'outputs', 'report.md'), '# Mapped Deliverable\n', 'utf8');

  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: 'sess-unmapped-1', createdAt: 1200, cwd: winUnmappedWs, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: 1300, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '未映射对话' }] } }],
  );

  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', minQuietMs: 0, pollIntervalMs: 0 });
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', minQuietMs: 0, pollIntervalMs: 0 });
  try {
    await winCtrl.reloadConfig();
    await macCtrl.reloadConfig();

    // 1. P1-2B: Push ONLY single sessionId (empty workspacePaths) -> mapped workspace deliverables MUST still be pushed!
    const singlePush = await winCtrl.pushSelected({ workspacePaths: [], sessionIds: ['sess-mapped-1'] });
    assert.equal(singlePush.ok, true);
    assert.equal(singlePush.workspaces.length, 1);
    assert.ok(singlePush.workspaces[0].uploaded.includes('outputs/report.md'));

    // 2. F6: Mac is ALSO in syncScope='selected' with empty whitelist, yet pullAll() receives Win's published mapped session & deliverable!
    const macAutoPull = await macCtrl.pullAll();
    assert.equal(macAutoPull.sessions.summary.imported, 1);
    assert.equal(await fs.readFile(path.join(macMappedWs, 'outputs', 'report.md'), 'utf8'), '# Mapped Deliverable\n');

    // 3. P1-2C + F7: Win pushes unmapped session; Mac (in mapped-only + selected) pulls it with __AUTO_MIRROR__
    await winCtrl.pushSelected({ workspacePaths: [], sessionIds: ['sess-unmapped-1'] });
    const macPullUnmapped = await macCtrl.pullSelected({
      sessionIds: ['sess-unmapped-1'],
      targetOverrides: { [winUnmappedWs]: AUTO_MIRROR_SENTINEL },
    });
    assert.equal(macPullUnmapped.ok, true);
    assert.equal(macPullUnmapped.sessions.summary.imported, 1);

    // Verify Mac persisted selectedSessionIds & sessionTargetOverrides so subsequent local reply auto-pushes back!
    const macCfgAfter = await loadConfig(macHome);
    assert.ok(macCfgAfter.selectedSessionIds.includes('sess-unmapped-1'));
    const landedDir = macCfgAfter.sessionTargetOverrides['sess-unmapped-1'];
    assert.ok(landedDir && landedDir.toLowerCase().includes('mac-mirrors'));

    const macReplyEvents = [
      { seq: 0, time: 1300, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '未映射对话' }] } },
      { seq: 1, time: 2000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Mac续聊回复回推' }] } },
    ];
    const decision = shouldAutoSyncSession(
      { sessionId: 'sess-unmapped-1', header: { cwd: landedDir }, events: macReplyEvents },
      macCfgAfter,
      'darwin',
    );
    assert.equal(decision.allowed, true, 'Subsequent local reply in pulled session must auto-push even under mapped-only + selected');

    // 4. Verify /soul pull <id> in mapped-only mode defaults to auto-mirror and lands cleanly
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: 'sess-slash-pull', createdAt: 1500, cwd: winUnmappedWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 1600, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '命令拉取测试' }] } }],
    );
    await winCtrl.pushSelected({ sessionIds: ['sess-slash-pull'] });
    const slashPullRes = await macCtrl.handleSlashCommand({ rawInput: 'pull sess-slash-pull' });
    assert.equal(slashPullRes.kind, 'success');
    assert.match(slashPullRes.text, /会话新增 1/);
    assert.match(slashPullRes.text, /落位目录/);
  } finally {
    await winCtrl.dispose();
    await macCtrl.dispose();
  }
});

test('P1-4 / F10 + P1-5 / F4 + F5 + F12: blank-page /soul status non-sync, collapsed context source & workspace-scoped alerts', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'p1-4-5-context');
  const dshHome = path.join(caseDir, 'home');
  const vaultDir = path.join(caseDir, 'vault');
  const wsA = path.join(caseDir, 'ws-a');
  const wsB = path.join(caseDir, 'ws-b');
  await fs.mkdir(wsA, { recursive: true });
  await fs.mkdir(wsB, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  const mappings = [
    { id: 'ws-a', title: '项目A', win32: wsA, darwin: '/Users/me/ws-a' },
    { id: 'ws-b', title: '项目B', win32: wsB, darwin: '/Users/me/ws-b' },
  ];
  await saveConfig(dshHome, {
    deviceId: 'win-ctx',
    deviceLabel: 'WinCtx',
    platform: 'win32',
    vaultDir,
    workspaceMappings: mappings,
  });

  const ctrl = new SoulSyncController(null, { dshHome, platform: 'win32', pollIntervalMs: 0 });
  await ctrl.reloadConfig();

  // 1. P1-4 / F10: Execute `/soul status` in a blank session -> renders card cleanly, but NOT substantive & NOT synced!
  const blankEvents = [];
  const blankSession = {
    id: 'sess-blank-soul-status',
    cwd: wsA,
    header: { type: 'session', version: 4, id: 'sess-blank-soul-status', cwd: wsA, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 },
    surface: { nodes: [] },
    append(type, data, opts = {}) {
      const seq = blankEvents.length;
      const ev = { seq, time: Date.now(), type, data, ...(opts.surfaceOp ? { surfaceOp: opts.surfaceOp } : {}) };
      blankEvents.push(ev);
      if (opts.surfaceOp === 'append') this.surface.nodes.push(seq);
      return ev;
    },
    eventAt(seq) { return blankEvents[seq]; },
    snapshotEvents() { return [...blankEvents]; },
  };
  const blankAgent = { session: blankSession, phase: { kind: 'idle', lastTurn: 0 } };
  const cmdRes = await ctrl.handleSlashCommand({ agent: blankAgent, rawInput: 'status' });
  assert.equal(cmdRes.kind, 'success');
  assert.equal(blankEvents.length, 6, 'Blank session should receive synthetic card turn');
  assert.equal(blankEvents[0].type, 'turn/start');
  assert.equal(blankEvents[1].type, 'step/start', 'step/start must precede user/message');
  assert.equal(blankEvents[2].type, 'user/message');
  assert.equal(blankEvents[2].data.source.kind, 'dsh-soul-sync-card');
  assert.equal(blankEvents[2].data.source.form, 'notice');
  assert.equal(blankEvents[3].type, 'assistant/message');
  assert.equal(blankEvents[4].type, 'step/end');
  assert.equal(blankEvents[5].type, 'turn/end');
  assert.equal(blankEvents[5].data.reason?.kind, 'completed', 'turn/end MUST include reason.kind=completed so dsh-client-ui-chat never crashes');
  assert.equal(countUserTurns(blankEvents), 0);
  assert.equal(isSubstantiveSession(blankEvents, blankSession.header), false);

  await writeLocalSession(dshHome, blankSession.header, blankEvents);
  const localCat = await ctrl.listLocalCatalog();
  assert.equal(localCat.totalSessions, 0, 'Blank-page /soul status session must not pollute localCatalog');
  const expAll = await exportAllLocalSessions({ dshHome, vault: ctrl.vault, workspaceMappings: mappings });
  assert.equal(expAll.exported.length, 0, 'Blank-page /soul status session must never upload to vault');

  // 2. P1-5 / F12: Context injections (dsh-soul-sync, dsh-time-context, runtime-context) do NOT count as human turns!
  const mixedEvents = [
    { seq: 0, time: 1000, type: 'user/message', data: { source: { kind: 'dsh-soul-sync', form: 'notice', summary: '已同步跨设备上下文' }, content: [{ type: 'text', text: '【跨设备接力备注】...' }] } },
    { seq: 1, time: 1001, type: 'user/message', data: { source: { kind: 'dsh-time-context', form: 'snapshot', sections: [] }, content: [{ type: 'text', text: 'Current time: ...' }] } },
    { seq: 2, time: 1002, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '唯一一条真实人类提问' }] } },
  ];
  assert.equal(countUserTurns(mixedEvents), 1);
  assert.equal(isRealHumanUserEvent(mixedEvents[0]), false);
  assert.equal(isRealHumanUserEvent(mixedEvents[1]), false);
  assert.equal(isRealHumanUserEvent(mixedEvents[2]), true);

  // 3. F5: Workspace-scoped alerts — alert for Workspace B must NOT leak into Session A!
  ctrl._pushAlert({
    kind: 'file-conflict',
    workspaceId: 'ws-b',
    workspacePath: wsB,
    text: '工作区「项目B」有 1 个双边同改冲突副本',
  });

  const decA = await ctrl.handleAgentPreStep(
    { agent: { session: { id: 'sess-in-a', cwd: wsA } } },
    () => ({ kind: 'continue', messages: [{ id: 'u-a', role: 'user', content: [{ type: 'text', text: 'A的问题' }] }] }),
  );
  assert.equal(decA.messages.length, 1, 'Workspace B alert must NEVER leak into Session A');
  assert.equal(ctrl._pendingAlerts.length, 1, 'Unrelated alert must remain unread');

  // Session B receives Workspace B's alert appended AFTER the user message as a collapsed dsh-soul-sync notice
  const decB = await ctrl.handleAgentPreStep(
    { agent: { session: { id: 'sess-in-b', cwd: wsB } } },
    () => ({ kind: 'continue', messages: [{ id: 'u-b', role: 'user', content: [{ type: 'text', text: 'B的问题' }] }] }),
  );
  assert.equal(decB.messages.length, 2);
  assert.equal(decB.messages[0].id, 'u-b');
  assert.equal(decB.messages[1].source.kind, 'dsh-soul-sync');
  assert.equal(decB.messages[1].source.form, 'notice');
  assert.match(decB.messages[1].content[0].text, /项目B/);
  assert.equal(ctrl._pendingAlerts.length, 0);

  // Alerts can also be dismissed via HTTP API
  ctrl._pushAlert({ kind: 'global-agents-conflict', text: 'AGENTS 冲突' });
  const dismissResp = await callApi(ctrl, {
    method: 'POST',
    url: '/__soul-sync/api/alerts/dismiss',
    headers: { 'x-dsh-soul-sync': '1', 'content-type': 'application/json' },
    body: { all: true },
  });
  assert.equal(dismissResp.status, 200);
  assert.equal(ctrl._pendingAlerts.length, 0);

  await ctrl.dispose();
});

test('P2-1 / F8 + F9 + P2-2 / F11: global mapping auto-propagation, colliding auto-mirror basenames, mapping validation & baseTree seeding', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'p2-mappings-mirrors');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winProj = path.join(caseDir, 'win-proj');
  const macProj = '/Users/tester/win-proj';
  await fs.mkdir(path.join(winProj, 'outputs'), { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  await savePassphraseKey(winHome, 'p2-secret');
  await savePassphraseKey(macHome, 'p2-secret');
  await saveConfig(winHome, { deviceId: 'win-p2', deviceLabel: 'WinP2', platform: 'win32', vaultDir, encryptionEnabled: true });
  await saveConfig(macHome, { deviceId: 'mac-p2', deviceLabel: 'MacP2', platform: 'darwin', vaultDir, encryptionEnabled: true });

  const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', minQuietMs: 0, pollIntervalMs: 0 });
  const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', minQuietMs: 0, pollIntervalMs: 0 });
  await winCtrl.reloadConfig();
  await macCtrl.reloadConfig();

  // 1. P2-2 validation: swapped paths & cross-OS ~/ rejected; colliding basename disambiguated!
  const swapped = await winCtrl.handleAddMapping({ winPath: '/Users/me/proj', macPath: 'D:\\proj' });
  assert.equal(swapped.kind, 'error');
  assert.match(swapped.text, /填反/);

  const crossTilde = await winCtrl.handleAddMapping({ winPath: 'D:\\proj', macPath: '~/proj' });
  assert.equal(crossTilde.kind, 'error');
  assert.match(crossTilde.text, /无法自动展开/);

  const add1 = await winCtrl.handleAddMapping({ winPath: 'D:\\2025\\报告', macPath: '/Users/me/2025/报告' });
  assert.equal(add1.kind, 'success');
  const add2 = await winCtrl.handleAddMapping({ winPath: 'D:\\2026\\报告', macPath: '/Users/me/2026/报告' });
  assert.equal(add2.kind, 'success');
  const winMaps = (await loadConfig(winHome)).workspaceMappings;
  assert.equal(winMaps.length, 2, 'Same basename with different paths must NOT overwrite existing mapping');
  assert.notEqual(winMaps[0].id, winMaps[1].id);

  // 2. F8: Global encrypted workspace-mappings Win -> Mac auto-propagation!
  const macPullRes = await macCtrl.pullAll();
  assert.equal(macPullRes.ok, true);
  const macMaps = (await loadConfig(macHome)).workspaceMappings;
  assert.equal(macMaps.length, 2, 'Mac must automatically receive Win workspaceMappings via encrypted global commit');
  assert.deepEqual(macMaps.map((m) => m.id).sort(), winMaps.map((m) => m.id).sort());

  // 3. F11: Colliding auto-mirror basenames (`D:\工作\分析` vs `D:\个人\分析`) land in two distinct dirs!
  const winWorkAnalysis = path.join(caseDir, 'work', '分析');
  const winPersonalAnalysis = path.join(caseDir, 'personal', '分析');
  await fs.mkdir(path.join(winWorkAnalysis, 'outputs'), { recursive: true });
  await fs.mkdir(path.join(winPersonalAnalysis, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(winWorkAnalysis, 'outputs', 'work.md'), 'work-only', 'utf8');
  await fs.writeFile(path.join(winPersonalAnalysis, 'outputs', 'personal.md'), 'personal-only', 'utf8');
  // Also plant a secret file in outputs/ to verify F9 skippedOutputs reporting
  await fs.writeFile(path.join(winWorkAnalysis, 'outputs', '.env'), 'SECRET=1\n', 'utf8');

  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: 'sess-work-an', createdAt: 1000, cwd: winWorkAnalysis, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '工作分析' }] } }],
  );
  await writeLocalSession(
    winHome,
    { type: 'session', version: 4, id: 'sess-pers-an', createdAt: 1200, cwd: winPersonalAnalysis, isSeeded: false, delegationDepth: 0 },
    [{ seq: 0, time: 1300, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '个人分析' }] } }],
  );

  const pushBoth = await winCtrl.pushSelected({ sessionIds: ['sess-work-an', 'sess-pers-an'] });
  assert.equal(pushBoth.sessionPushedCount, 2);
  assert.ok(pushBoth.skippedOutputs.some((o) => o.path === 'outputs/.env' && o.reason === 'sensitive-filename'));

  const macLocalHome = path.join(caseDir, 'mac-local-home');
  const macMirrors = path.join(caseDir, 'mac-colliding-mirrors');
  await savePassphraseKey(macLocalHome, 'p2-secret');
  await saveConfig(macLocalHome, {
    deviceId: 'mac-col',
    deviceLabel: 'MacCol',
    platform: process.platform,
    vaultDir,
    encryptionEnabled: true,
    autoMirrorRoot: macMirrors,
  });
  const macColCtrl = new SoulSyncController(null, { dshHome: macLocalHome, platform: process.platform, minQuietMs: 0, pollIntervalMs: 0 });
  await macColCtrl.reloadConfig();
  const pullCol = await macColCtrl.pullAll();
  assert.equal(pullCol.sessions.summary.imported, 2);

  const resWork = pullCol.sessions.results.find((r) => r.sessionId === 'sess-work-an');
  const resPers = pullCol.sessions.results.find((r) => r.sessionId === 'sess-pers-an');
  assert.ok(resWork?.targetCwd && resPers?.targetCwd);
  assert.notEqual(resWork.targetCwd.toLowerCase(), resPers.targetCwd.toLowerCase(), 'Colliding auto-mirror basenames must land in distinct directories');
  assert.equal(await fs.readFile(path.join(resWork.targetCwd, 'outputs', 'work.md'), 'utf8'), 'work-only');
  assert.equal(await fs.readFile(path.join(resPers.targetCwd, 'outputs', 'personal.md'), 'utf8'), 'personal-only');

  // 4. P2-1: Seed baseTree from session-outputs-state.json so promoting auto-mirror to mapped workspace causes 0 false Rule-3 conflicts
  await fs.writeFile(path.join(winWorkAnalysis, 'outputs', 'work.md'), 'work-updated-v2', 'utf8');
  await pushWorkspaceDeliverables({
    dshHome: winHome,
    vault: winCtrl.vault,
    workspaceId: 'ws-work-promoted',
    workspaceRoot: winWorkAnalysis,
    deviceLabel: 'WinP2',
    minQuietMs: 0,
  });
  const promotedPull = await pullWorkspaceDeliverables({
    dshHome: macLocalHome,
    vault: macColCtrl.vault,
    workspaceId: 'ws-work-promoted',
    workspaceRoot: resWork.targetCwd,
  });
  assert.equal(promotedPull.conflicts.length, 0, 'Seeding baseTree from session-outputs-state.json must prevent false Rule-3 conflict');
  assert.equal(await fs.readFile(path.join(resWork.targetCwd, 'outputs', 'work.md'), 'utf8'), 'work-updated-v2');

  await winCtrl.dispose();
  await macCtrl.dispose();
  await macColCtrl.dispose();
});

test('P2-3 / F13: 200-session GET /__soul-sync/api/state benchmark < 1000ms & cached commit/session scanning', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'p2-3-bench-200');
  const dshHome = path.join(caseDir, 'home');
  const vaultDir = path.join(caseDir, 'vault');
  const wsDir = path.join(caseDir, 'ws-bench');
  await fs.mkdir(wsDir, { recursive: true });
  await fs.mkdir(vaultDir, { recursive: true });

  const keys = await savePassphraseKey(dshHome, 'bench-secret-2026');
  await saveConfig(dshHome, {
    deviceId: 'win-bench',
    deviceLabel: 'WinBench',
    platform: 'win32',
    vaultDir,
    encryptionEnabled: true,
    workspaceMappings: [{ id: 'ws-bench', title: 'Bench', win32: wsDir, darwin: '/Users/me/ws-bench' }],
  });

  // Create 200 local sessions & publish 200 peer commits in vault
  const peerVault = new VaultStore({ vaultDir, deviceId: 'mac-peer-bench', platform: 'darwin', secretKeys: keys });
  const now = Date.now();
  const writeJobs = [];
  for (let i = 0; i < 200; i += 1) {
    const sid = `sess-bench-${String(i).padStart(3, '0')}`;
    const header = { type: 'session', version: 4, id: sid, createdAt: now - i * 1000, cwd: wsDir, isSeeded: false, delegationDepth: 0 };
    const events = [
      { seq: 0, time: now - i * 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `压测对话 #${i}` }] } },
      { seq: 1, time: now - i * 1000 + 10, type: 'assistant/message', data: { content: [{ type: 'text', text: `压测回复 #${i}` }] } },
    ];
    writeJobs.push(writeLocalSession(dshHome, header, events));
  }
  await Promise.all(writeJobs);

  // Publish 200 lightweight peer commits directly
  for (let i = 0; i < 200; i += 1) {
    const sid = `sess-bench-${String(i).padStart(3, '0')}`;
    await peerVault.publishCommit('session', sid, {
      schemaVersion: 1,
      dshFormatVersion: 4,
      rootSessionId: sid,
      deviceLabel: 'MacBench',
      title: `压测对话 #${i}`,
      lastActiveAt: now - i * 1000 + 10,
      turnCount: 1,
      sourceCwd: '/Users/me/ws-bench',
      sourceWorkspaceTitle: 'Bench',
      nodes: [{ sessionId: sid, eventCount: 2, headChainHash: 'a'.repeat(64), chainHashes: ['a'.repeat(64), 'a'.repeat(64)] }],
      attachments: [],
    });
  }

  const ctrl = new SoulSyncController(null, { dshHome, platform: 'win32', pollIntervalMs: 0 });
  await ctrl.reloadConfig();

  // Warm call (initial scan + decrypt populates caches)
  const res1 = await callApi(ctrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: { 'x-dsh-soul-sync': '1' },
  });
  assert.equal(res1.status, 200);
  assert.equal(res1.json.localCatalog.totalSessions, 200);
  assert.equal(res1.json.vaultCatalog.totalSessions, 200);

  // Timed call: 200 local sessions + 200 vault sessions MUST complete well under 1000ms!
  const t0 = performance.now();
  const res2 = await callApi(ctrl, {
    method: 'GET',
    url: '/__soul-sync/api/state',
    headers: { 'x-dsh-soul-sync': '1' },
  });
  const elapsedMs = performance.now() - t0;
  assert.equal(res2.status, 200);
  assert.ok(elapsedMs < 1000, `Expected 200-session GET /state < 1000ms, got ${elapsedMs.toFixed(1)}ms`);

  await ctrl.dispose();
});

test('Re-audit regressions: dual-selected pullAll reply roundtrip, unpublish LWW restore (no zombie tombstone), wrong-passphrase own-commit purge & poller recovery', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'reaudit-regressions');

  // --- Regression A (P1-1 / P1-A): Both machines in syncScope='selected' ---
  // Win pushAll -> Mac pullAll -> Mac replies (turn/end + pushAll) -> Win pullAll (fastForwarded===1) -> Win replies -> Mac pullAll (fastForwarded===1, zero fork!)
  {
    const subDir = path.join(caseDir, 'dual-selected-roundtrip');
    const winHome = path.join(subDir, 'win-home');
    const macHome = path.join(subDir, 'mac-home');
    const vaultDir = path.join(subDir, 'vault');
    const winWs = path.join(subDir, 'win-ws');
    const macWs = path.join(subDir, 'mac-ws');
    await fs.mkdir(path.join(winWs, 'outputs'), { recursive: true });
    await fs.mkdir(macWs, { recursive: true });
    await fs.mkdir(vaultDir, { recursive: true });

    const mappings = [{ id: 'dual-proj', title: 'DualProj', win32: winWs, darwin: macWs, linux: macWs }];
    await savePassphraseKey(winHome, 'dual-secret');
    await savePassphraseKey(macHome, 'dual-secret');
    await saveConfig(winHome, {
      deviceId: 'win-dual',
      deviceLabel: 'WinDual',
      platform: 'win32',
      vaultDir,
      encryptionEnabled: true,
      syncScope: 'selected',
      selectedSessionIds: ['sess-dual-1'],
      workspaceMappings: mappings,
    });
    await saveConfig(macHome, {
      deviceId: 'mac-dual',
      deviceLabel: 'MacDual',
      platform: 'darwin',
      vaultDir,
      encryptionEnabled: true,
      syncScope: 'selected',
      selectedWorkspaces: [],
      selectedSessionIds: [],
      workspaceMappings: mappings,
    });

    const header = { type: 'session', version: 4, id: 'sess-dual-1', createdAt: 1000, cwd: winWs, isSeeded: false, delegationDepth: 0 };
    const turn1 = [
      { seq: 0, time: 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Win第一轮提问' }] } },
      { seq: 1, time: 1150, type: 'assistant/message', data: { content: [{ type: 'text', text: 'Win第一轮回答' }] } },
    ];
    await writeLocalSession(winHome, header, turn1);
    await fs.writeFile(path.join(winWs, 'outputs', 'dual-note.md'), '# Dual Selected Deliverable\n', 'utf8');

    const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', minQuietMs: 0, pollIntervalMs: 0 });
    const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', minQuietMs: 0, pollIntervalMs: 0 });
    try {
      await winCtrl.reloadConfig();
      await macCtrl.reloadConfig();

      // 1. Win pushAll pushes sess-dual-1 AND its mapped workspace deliverable even though selectedWorkspaces is empty!
      const winPush1 = await winCtrl.pushAll();
      assert.equal(winPush1.ok, true);
      assert.equal(winPush1.sessionPushedCount, 1);
      assert.equal(winPush1.workspaces.length, 1);
      assert.ok(winPush1.workspaces[0].uploaded.includes('outputs/dual-note.md'));

      // 2. Mac pullAll (selected mode, empty whitelist) imports sess-dual-1 AND persists it into selectedSessionIds!
      const macPull1 = await macCtrl.pullAll();
      assert.equal(macPull1.sessions.summary.imported, 1);
      const macCfg1 = await loadConfig(macHome);
      assert.ok(macCfg1.selectedSessionIds.includes('sess-dual-1'), 'pullAll must auto-track imported session in selectedSessionIds');

      // 3. Mac replies -> write turn 2 locally on Mac -> Mac turn/end export + pushAll -> Win pullAll MUST fast-forward!
      const macScanned = await scanLocalSessions(macHome);
      const macRec = macScanned.get('sess-dual-1');
      assert.ok(macRec);
      const macTurn2 = [
        ...macRec.events,
        { seq: 2, time: 2000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Mac第二轮续聊' }] } },
        { seq: 3, time: 2050, type: 'assistant/message', data: { content: [{ type: 'text', text: 'Mac第二轮回答' }] } },
      ];
      await writeLocalSession(macHome, macRec.header, macTurn2);

      const macPush = await macCtrl.pushAll();
      assert.equal(macPush.sessionPushedCount, 1, 'Mac reply on auto-pulled session must push back under syncScope=selected');

      const winPull = await winCtrl.pullAll();
      assert.equal(winPull.sessions.summary.fastForwarded, 1, 'Win must fast-forward Mac reply');
      assert.equal(winPull.sessions.summary.forkedBranches, 0);

      // 4. Win replies turn 3 -> Mac pulls -> MUST fast-forward with ZERO forked-branch!
      const winScanned = await scanLocalSessions(winHome);
      const winRec = winScanned.get('sess-dual-1');
      const winTurn3 = [
        ...winRec.events,
        { seq: 4, time: 3000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Win第三轮续聊' }] } },
        { seq: 5, time: 3050, type: 'assistant/message', data: { content: [{ type: 'text', text: 'Win第三轮回答' }] } },
      ];
      await writeLocalSession(winHome, winRec.header, winTurn3);
      await winCtrl.pushAll();
      const macPull2 = await macCtrl.pullAll();
      assert.equal(macPull2.sessions.summary.fastForwarded, 1);
      assert.equal(macPull2.sessions.summary.forkedBranches, 0, 'No split-brain fork when roundtripping in dual-selected mode');
    } finally {
      await winCtrl.dispose();
      await macCtrl.dispose();
    }
  }

  // --- Regression B (P1-2): unpublish -> Mac pullAll -> Win pushSelected (NO new turn) -> Mac pullAll imports cleanly (no zombie tombstone) ---
  {
    const subDir = path.join(caseDir, 'unpublish-lww-restore');
    const winHome = path.join(subDir, 'win-home');
    const macHome = path.join(subDir, 'mac-home');
    const vaultDir = path.join(subDir, 'vault');
    const winWs = path.join(subDir, 'win-ws');
    await fs.mkdir(winWs, { recursive: true });
    await fs.mkdir(vaultDir, { recursive: true });

    await savePassphraseKey(winHome, 'lww-secret');
    await savePassphraseKey(macHome, 'lww-secret');
    await saveConfig(winHome, { deviceId: 'win-lww', deviceLabel: 'WinLWW', platform: 'win32', vaultDir, encryptionEnabled: true });
    await saveConfig(macHome, {
      deviceId: 'mac-lww',
      deviceLabel: 'MacLWW',
      platform: 'darwin',
      vaultDir,
      encryptionEnabled: true,
      autoMirrorRoot: path.join(subDir, 'mac-mirrors'),
    });

    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: 'sess-zombie-1', createdAt: 1000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '将被撤回再恢复的老对话' }] } }],
    );

    const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', minQuietMs: 0, pollIntervalMs: 0 });
    const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', minQuietMs: 0, pollIntervalMs: 0 });
    try {
      await winCtrl.reloadConfig();
      await macCtrl.reloadConfig();

      await winCtrl.pushAll();
      await winCtrl.unpublishSessionFromVault({ sessionIds: ['sess-zombie-1'] });

      // Mac pulls and re-publishes global metadata containing the withdrawn tombstone
      const macPullBefore = await macCtrl.pullAll();
      assert.equal(macPullBefore.sessions.summary.imported, 0);
      assert.ok((await loadConfig(macHome)).withdrawnSessions['sess-zombie-1'] > 0);

      // Win explicitly re-pushes sess-zombie-1 with NO new turn -> LWW restoredSessions must override Mac's old tombstone!
      const repush = await winCtrl.pushSelected({ sessionIds: ['sess-zombie-1'] });
      assert.equal(repush.ok, true);
      assert.equal(repush.sessionPushedCount, 1);

      const winCfgAfter = await loadConfig(winHome);
      assert.equal(winCfgAfter.withdrawnSessions['sess-zombie-1'], undefined, 'Zombie tombstone must NOT resurrect on Win');
      assert.ok(winCfgAfter.restoredSessions['sess-zombie-1'] > 0, 'LWW restoredSessions timestamp must be recorded');

      // Mac pullAll receives the restored session cleanly!
      const macPullAfter = await macCtrl.pullAll();
      assert.equal(macPullAfter.sessions.summary.imported, 1, 'Mac must import explicitly restored session without new turn');
      const macCfgAfter = await loadConfig(macHome);
      assert.equal(macCfgAfter.withdrawnSessions['sess-zombie-1'], undefined, 'Tombstone must be cleared on Mac too');
    } finally {
      await winCtrl.dispose();
      await macCtrl.dispose();
    }
  }

  // --- Regression C (P1-3 + Opus P1-B): Wrong passphrase on Mac + sync -> fix passphrase via updateSettings ->
  // Win sees decryptionFailedCount===0, pruneHistory skippedBlobGc===false, AND Mac _pollTick after bad start pulls Win session! ---
  {
    const subDir = path.join(caseDir, 'wrong-passphrase-recovery');
    const winHome = path.join(subDir, 'win-home');
    const macHome = path.join(subDir, 'mac-home');
    const vaultDir = path.join(subDir, 'vault');
    const winWs = path.join(subDir, 'win-ws');
    const macWs = path.join(subDir, 'mac-ws');
    await fs.mkdir(winWs, { recursive: true });
    await fs.mkdir(macWs, { recursive: true });
    await fs.mkdir(vaultDir, { recursive: true });

    const mappings = [{ id: 'rec-proj', title: 'RecProj', win32: winWs, darwin: macWs, linux: macWs }];
    await savePassphraseKey(winHome, 'true-pass-2026');
    await savePassphraseKey(macHome, 'wrong-pass-9999');
    await saveConfig(winHome, {
      deviceId: 'win-rec',
      deviceLabel: 'WinRec',
      platform: 'win32',
      vaultDir,
      encryptionEnabled: true,
      workspaceMappings: mappings,
    });
    await saveConfig(macHome, {
      deviceId: 'mac-rec',
      deviceLabel: 'MacRec',
      platform: 'darwin',
      vaultDir,
      encryptionEnabled: true,
      workspaceMappings: mappings,
    });

    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: 'sess-win-true', createdAt: 1000, cwd: winWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Win正确口令对话' }] } }],
    );
    await writeLocalSession(
      macHome,
      { type: 'session', version: 4, id: 'sess-mac-bad', createdAt: 1200, cwd: macWs, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 1300, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Mac错口令期间对话' }] } }],
    );

    const winCtrl = new SoulSyncController(null, { dshHome: winHome, platform: 'win32', minQuietMs: 0, pollIntervalMs: 0 });
    const macCtrl = new SoulSyncController(null, { dshHome: macHome, platform: 'darwin', minQuietMs: 0, pollIntervalMs: 0 });
    try {
      await winCtrl.reloadConfig();
      await winCtrl.pushAll();

      // Mac starts with WRONG passphrase AND writes wrong-key session + global commits
      await macCtrl.start();
      await macCtrl.pushAll();
      assert.equal(macCtrl._seenRemoteCommitFiles.size, 0, '_runStartup must NOT swallow undecryptable remote commits into _seenRemoteCommitFiles');

      // Win currently sees Mac's undecryptable commits
      const winBadState = await callApi(winCtrl, { method: 'GET', url: '/__soul-sync/api/state', headers: { 'x-dsh-soul-sync': '1' } });
      assert.ok(winBadState.json.decryptionFailedCount > 0, 'Win should detect Mac wrong-key commits before recovery');
      assert.ok(winBadState.json.decryptionFailedDevices['mac-rec'] > 0, 'decryptionFailedDevices should attribute mac-rec');

      // Mac fixes passphrase via updateSettings -> purges obsolete own wrong-key commits, re-publishes & syncs!
      await macCtrl.updateSettings({ passphrase: 'true-pass-2026' });

      // Win now sees decryptionFailedCount === 0 AND pruneHistory runs blob GC cleanly (skippedBlobGc === false)!
      const winGoodState = await callApi(winCtrl, { method: 'GET', url: '/__soul-sync/api/state', headers: { 'x-dsh-soul-sync': '1' } });
      assert.equal(winGoodState.json.decryptionFailedCount, 0, 'Win decryptionFailedCount must return to 0 after Mac fixes passphrase');
      const pruneRes = await winCtrl.vault.pruneHistory('session', 5);
      assert.equal(pruneRes.skippedBlobGc, false, 'Vault orphan blob GC must resume cleanly after wrong-key own commits purged');

      // Mac has pulled Win's session AND _pollTick sees unconsumed files cleanly
      const pollRes = await macCtrl._pollTick();
      assert.equal(pollRes.polled, true);
      assert.equal(pollRes.pulled, true);
      const macSessions = await scanLocalSessions(macHome);
      assert.ok(macSessions.has('sess-win-true'), 'Mac must have pulled Win session after passphrase fix');
    } finally {
      await winCtrl.dispose();
      await macCtrl.dispose();
    }
  }
});
