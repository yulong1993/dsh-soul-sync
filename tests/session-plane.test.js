import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { savePassphraseKey, writeFileAtomic } from '../lib/config.js';
import { encodeSegment, projectKey, encodeV4SessionLog, decodeV4SessionLog } from '../lib/zstd-v4.js';
import { VaultStore } from '../lib/crypto-vault.js';
import {
  computeEventHashChain,
  rewriteSessionForTargetOs,
  exportSessionClosure,
  exportAllLocalSessions,
  importSessionCommit,
  pullSessionsFromVault,
  consumePendingMigration,
  readPendingMigrations,
} from '../lib/session-plane.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_ROOT = path.join(REPO_ROOT, '.test-tmp', `session-plane-${process.pid}-${Date.now()}`);

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function writeLocalSession(dshHome, header, events, version = header.version ?? 4) {
  const projDir = header.cwd ? projectKey(header.cwd) : '_no-cwd';
  const sessDir = path.join(dshHome, 'sessions', projDir, encodeSegment(header.id));
  await fs.mkdir(sessDir, { recursive: true });
  const logPath = path.join(sessDir, `session.v${version}.jsonl.zstd`);
  const encoded = await encodeV4SessionLog(header, events);
  await writeFileAtomic(logPath, encoded, { mode: 0o600 });
  return logPath;
}

async function findAllSessionDirsById(dshHome, sessionId) {
  const sessionsRoot = path.join(dshHome, 'sessions');
  const encodedId = encodeSegment(sessionId);
  const found = [];
  let projEntries;
  try {
    projEntries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return found;
    throw err;
  }
  for (const proj of projEntries) {
    if (!proj.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, proj.name, encodedId);
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) found.push({ projKey: proj.name, dir: candidate });
    } catch {
      // not in this projectKey
    }
  }
  return found;
}

function assertWorkspaceV2Invariants(wsJson) {
  assert.deepEqual(wsJson.unit, { name: 'workspace', version: 2 });
  assert.equal(wsJson.global.initialized, true);
  assert.ok(Array.isArray(wsJson.global.workspaceIds));
  assert.ok(Array.isArray(wsJson.global.archivedSessionIds));
  assert.ok(Array.isArray(wsJson.global.pinnedSessionIds));

  const tableKeys = Object.keys(wsJson.tables.workspaces);
  const orderSet = new Set(wsJson.global.workspaceIds);
  // Invariant 1 & 2: workspaceIds has no duplicates and is strictly 1:1 with tables.workspaces
  assert.equal(orderSet.size, wsJson.global.workspaceIds.length, 'workspaceIds must have no duplicates');
  assert.equal(orderSet.size, tableKeys.length, 'workspaceIds must be 1:1 with tables.workspaces');
  for (const k of tableKeys) {
    assert.ok(orderSet.has(k), `workspace ${k} must exist in global.workspaceIds`);
  }

  // Invariant 3 & 4: unique paths, each sessionId owned by at most 1 workspace
  const seenPaths = new Set();
  const seenSessions = new Set();
  for (const [id, rec] of Object.entries(wsJson.tables.workspaces)) {
    assert.equal(seenPaths.has(rec.path), false, `duplicate workspace path ${rec.path} on ${id}`);
    seenPaths.add(rec.path);
    for (const sid of rec.sessionIds) {
      assert.equal(seenSessions.has(sid), false, `session ${sid} accounted in multiple workspaces`);
      seenSessions.add(sid);
    }
  }
}

test.before(async () => {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
});

test.after(async () => {
  await fs.rm(TEST_TMP_ROOT, { recursive: true, force: true });
});

test.describe('session-plane: cross-OS lineage export/import, minimal rewrite & attachments', () => {
  test('exports Win session + cross-projectKey subagent + attachments -> imports cleanly on simulated Mac', async () => {
    const winHome = path.join(TEST_TMP_ROOT, 'case1-win-home');
    const macHome = path.join(TEST_TMP_ROOT, 'case1-mac-home');
    const vaultDir = path.join(TEST_TMP_ROOT, 'case1-vault');
    const winWorkspaceDir = path.join(TEST_TMP_ROOT, 'case1-win-us-stocks');
    const winArticlesDir = path.join(TEST_TMP_ROOT, 'case1-win-articles');
    await fs.mkdir(winWorkspaceDir, { recursive: true });
    await fs.mkdir(winArticlesDir, { recursive: true });

    const workspaceMappings = [
      { id: 'us-stocks', title: '美股分析', win32: winWorkspaceDir, darwin: '/Users/alex/美股分析' },
      { id: 'articles', title: '文章', win32: winArticlesDir, darwin: '/Users/alex/文章' },
    ];

    const winKeys = await savePassphraseKey(winHome, 'soul-sync-pass-2026');
    const macKeys = await savePassphraseKey(macHome, 'soul-sync-pass-2026');

    const winVault = new VaultStore({ vaultDir, deviceId: 'win-office', platform: 'win32', secretKeys: winKeys });
    const macVault = new VaultStore({ vaultDir, deviceId: 'mac-air', platform: 'darwin', secretKeys: macKeys });

    // Create image & file attachments in Win DSH_HOME
    const imgBytes = Buffer.from('fake-png-image-binary-bytes-nvda-chart-001');
    const imgSha = sha256Hex(imgBytes);
    const imgObjPath = path.join(winHome, 'attachments', 'v1', 'objects', imgSha.slice(0, 2), imgSha);
    await writeFileAtomic(imgObjPath, imgBytes, { mode: 0o600 });

    const pdfBytes = Buffer.from('%PDF-1.7 fake Q3 earnings report content');
    const pdfSha = sha256Hex(pdfBytes);
    const pdfFileObjPath = path.join(winHome, 'attachments', 'v1', 'file-objects', pdfSha.slice(0, 2), pdfSha);
    const pdfNamedPath = path.join(winHome, 'attachments', 'v1', 'files', pdfSha.slice(0, 2), pdfSha, 'Q3财报.pdf');
    await writeFileAtomic(pdfFileObjPath, pdfBytes, { mode: 0o600 });
    await writeFileAtomic(pdfNamedPath, pdfBytes, { mode: 0o600 });

    // Pre-plant a 0o400 read-only identical attachment on Mac to verify Windows EPERM protection
    const macPreExistingImg = path.join(macHome, 'attachments', 'v1', 'objects', imgSha.slice(0, 2), imgSha);
    await writeFileAtomic(macPreExistingImg, imgBytes, { mode: 0o600 });
    await fs.chmod(macPreExistingImg, 0o400);

    // Pre-plant stale session_projcache on Mac to verify invalidation
    const rootId = 'session-root-nvda-001';
    const childId = 'session-subagent-dcf-002';
    const staleCachePath = path.join(macHome, 'storages', 'session_projcache', 'sessions', `${encodeSegment(rootId)}.json`);
    await writeFileAtomic(staleCachePath, JSON.stringify({ stale: true }), { mode: 0o600 });

    const rootHeader = {
      type: 'session',
      version: 4,
      id: rootId,
      createdAt: 1732400001000,
      cwd: winWorkspaceDir,
      isSeeded: false,
      delegationDepth: 0,
    };

    const userMessageEvent = {
      seq: 0,
      time: 1732400002000,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        source: { kind: 'user' },
        content: [
          { type: 'text', text: '请结合这张图表和 Q3 财报做估值分析' },
          { type: 'image', attachmentId: `sha256:${imgSha}`, mediaType: 'image/png', bytes: imgBytes.length },
          { type: 'file', attachmentId: `sha256:${pdfSha}`, name: 'Q3财报.pdf', bytes: pdfBytes.length },
        ],
      },
    };

    const wdChangeEvent = {
      seq: 1,
      time: 1732400003000,
      type: 'working-directory/change',
      data: { cwd: path.join(winWorkspaceDir, 'scripts') },
    };

    const assistantMessageEvent = {
      seq: 2,
      time: 1732400004000,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        stream: [
          { type: 'reasoning', text: '先核对自由现金流与毛利率轨迹', signature: 'sig-opaque-base64-XYZ987==' },
          { type: 'text', text: '已完成初步折现估值计算。' },
        ],
        replayState: { opaqueToken: 'replay-token-0xDEAD', checksum: 'abc123' },
      },
    };

    const toolCallEvent = {
      seq: 3,
      time: 1732400005000,
      type: 'tool/call',
      data: { callId: 'call_1', name: 'bash', args: { cmd: 'python scripts/dcf.py' } },
    };

    const toolResultEvent = {
      seq: 4,
      time: 1732400006000,
      type: 'tool/result',
      surfaceOp: 'append',
      data: { callId: 'call_1', output: 'DCF Fair Value = $148.20' },
    };

    const subagentCatalogEvent = {
      seq: 5,
      time: 1732400007000,
      type: 'subagent/catalog',
      data: { version: 0, childId, childCreatedAt: 1732400007000, mode: 'continuable', label: '财务核对子代理' },
    };

    const deliverablesEvent = {
      seq: 6,
      time: 1732400008000,
      type: 'deliverables/presented',
      data: {
        files: [
          { path: path.join(winWorkspaceDir, 'outputs', 'nvda_dcf.xlsx'), label: 'DCF 估值表' },
          { path: 'outputs/summary.md', label: '相对路径摘要' },
        ],
      },
    };

    const rootEvents = [
      userMessageEvent,
      wdChangeEvent,
      assistantMessageEvent,
      toolCallEvent,
      toolResultEvent,
      subagentCatalogEvent,
      deliverablesEvent,
    ];

    // Child subagent intentionally lives in a DIFFERENT projectKey directory (winArticlesDir)
    const childHeader = {
      type: 'session',
      version: 4,
      id: childId,
      createdAt: 1732400007000,
      cwd: winArticlesDir,
      parentSession: rootId,
      origin: 'subagent',
      isSeeded: false,
      delegationDepth: 1,
    };
    const childEvents = [
      { seq: 0, time: 1732400007500, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '核对历史研报口径' }] } },
      { seq: 1, time: 1732400007900, type: 'assistant/message', surfaceOp: 'append', data: { stream: [{ type: 'text', text: '口径一致' }] } },
    ];

    await writeLocalSession(winHome, rootHeader, rootEvents);
    await writeLocalSession(winHome, childHeader, childEvents);

    // Export from Windows
    const exported = await exportSessionClosure({
      dshHome: winHome,
      vault: winVault,
      sessionId: rootId,
      workspaceMappings,
      deviceLabel: 'Windows 办公机',
    });

    assert.equal(exported.commit.kind, 'session');
    assert.equal(exported.commit.targetId, rootId);
    assert.equal(exported.commit.payload.nodes.length, 2);
    assert.equal(exported.commit.payload.attachments.length, 2);

    // Pull on simulated macOS
    const pullRes = await pullSessionsFromVault({
      dshHome: macHome,
      vault: macVault,
      workspaceMappings,
      targetPlatform: 'darwin',
    });

    assert.equal(pullRes.results.length, 1);
    assert.equal(pullRes.results[0].status, 'imported');

    // Verify rewritten root session on Mac
    const macRootPath = path.join(
      macHome,
      'sessions',
      projectKey('/Users/alex/美股分析'),
      encodeSegment(rootId),
      'session.v4.jsonl.zstd',
    );
    const macRootDecoded = await decodeV4SessionLog(await fs.readFile(macRootPath));
    assert.equal(macRootDecoded.header.cwd, '/Users/alex/美股分析');
    assert.equal(macRootDecoded.events[1].data.cwd, '/Users/alex/美股分析/scripts');
    assert.equal(macRootDecoded.events[6].data.files[0].path, '/Users/alex/美股分析/outputs/nvda_dcf.xlsx');
    assert.equal(macRootDecoded.events[6].data.files[1].path, 'outputs/summary.md');

    // Byte-for-byte zero modification check on assistant/message (reasoning/signature/replayState), user/message, tool/call, tool/result
    assert.equal(JSON.stringify(macRootDecoded.events[0]), JSON.stringify(userMessageEvent));
    assert.equal(JSON.stringify(macRootDecoded.events[2]), JSON.stringify(assistantMessageEvent));
    assert.equal(JSON.stringify(macRootDecoded.events[3]), JSON.stringify(toolCallEvent));
    assert.equal(JSON.stringify(macRootDecoded.events[4]), JSON.stringify(toolResultEvent));

    // Verify subagent child imported under its own mapped Mac projectKey
    const macChildPath = path.join(
      macHome,
      'sessions',
      projectKey('/Users/alex/文章'),
      encodeSegment(childId),
      'session.v4.jsonl.zstd',
    );
    const macChildDecoded = await decodeV4SessionLog(await fs.readFile(macChildPath));
    assert.equal(macChildDecoded.header.cwd, '/Users/alex/文章');
    assert.equal(macChildDecoded.header.parentSession, rootId);
    assert.equal(macChildDecoded.header.origin, 'subagent');

    // Verify attachments reconstructed (objects/ for both, plus file-objects/ and files/<name> for file)
    const macImg = await fs.readFile(path.join(macHome, 'attachments', 'v1', 'objects', imgSha.slice(0, 2), imgSha));
    assert.deepEqual(macImg, imgBytes);
    const macPdfObj = await fs.readFile(path.join(macHome, 'attachments', 'v1', 'objects', pdfSha.slice(0, 2), pdfSha));
    const macPdfFileObj = await fs.readFile(path.join(macHome, 'attachments', 'v1', 'file-objects', pdfSha.slice(0, 2), pdfSha));
    const macPdfNamed = await fs.readFile(path.join(macHome, 'attachments', 'v1', 'files', pdfSha.slice(0, 2), pdfSha, 'Q3财报.pdf'));
    assert.deepEqual(macPdfObj, pdfBytes);
    assert.deepEqual(macPdfFileObj, pdfBytes);
    assert.deepEqual(macPdfNamed, pdfBytes);

    // Verify workspace.json v2 invariants AND subagent excluded from top-level sessionIds
    const wsJson = JSON.parse(await fs.readFile(path.join(macHome, 'storages', 'workspace.json'), 'utf8'));
    assertWorkspaceV2Invariants(wsJson);
    const allAccountedSessions = Object.values(wsJson.tables.workspaces).flatMap((w) => w.sessionIds);
    assert.ok(allAccountedSessions.includes(rootId), 'root session must be registered in workspace.json');
    assert.equal(allAccountedSessions.includes(childId), false, 'subagent must NOT be mixed into top-level workspace sessionIds');

    // Verify stale session_projcache was deleted
    await assert.rejects(() => fs.stat(staleCachePath), { code: 'ENOENT' });

    // Verify pending-migrations.json recorded and consumePendingMigration consumes once
    const pendingBefore = await readPendingMigrations(macHome);
    assert.equal(pendingBefore[rootId].fromDeviceId, 'win-office');
    assert.equal(pendingBefore[rootId].fromPlatform, 'win32');
    assert.equal(pendingBefore[rootId].toCwd, '/Users/alex/美股分析');

    const consumed = await consumePendingMigration(macHome, rootId);
    assert.equal(consumed.fromDeviceId, 'win-office');
    assert.equal(await consumePendingMigration(macHome, rootId), null);

    // Restore write bit on 0o400 file so test.after cleanup succeeds on Windows
    await fs.chmod(macPreExistingImg, 0o666);
  });
});

test.describe('session-plane: roundtrip Fast-Forward & logical path hash chain', () => {
  test('Win -> Mac (+2 turns) -> Win executes lossless Fast-Forward without false split-brain', async () => {
    const winHome = path.join(TEST_TMP_ROOT, 'case2-win-home');
    const macHome = path.join(TEST_TMP_ROOT, 'case2-mac-home');
    const vaultDir = path.join(TEST_TMP_ROOT, 'case2-vault');
    const winDir = path.join(TEST_TMP_ROOT, 'case2-win-proj');
    await fs.mkdir(winDir, { recursive: true });
    await fs.mkdir(path.join(winDir, 'outputs'), { recursive: true });

    const mappings = [
      { id: 'proj-alpha', title: 'Alpha', win32: winDir, darwin: '/Users/alex/Alpha' },
    ];

    const winVault = new VaultStore({ vaultDir, deviceId: 'win-desk', platform: 'win32' });
    const macVault = new VaultStore({ vaultDir, deviceId: 'mac-pro', platform: 'darwin' });

    const sid = 'session-roundtrip-001';
    const winHeader = {
      type: 'session',
      version: 4,
      id: sid,
      createdAt: 1732410000000,
      cwd: winDir,
      isSeeded: false,
      delegationDepth: 0,
    };
    const initialEvents = [
      { seq: 0, time: 1732410001000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮问题' }] } },
      { seq: 1, time: 1732410002000, type: 'working-directory/change', data: { cwd: path.join(winDir, 'outputs') } },
      { seq: 2, time: 1732410003000, type: 'deliverables/presented', data: { files: [{ path: path.join(winDir, 'outputs', 'v1.md') }] } },
      { seq: 3, time: 1732410004000, type: 'assistant/message', data: { stream: [{ type: 'text', text: '第一轮回答' }] } },
    ];

    await writeLocalSession(winHome, winHeader, initialEvents);

    // 1. Win exports
    await exportSessionClosure({ dshHome: winHome, vault: winVault, sessionId: sid, workspaceMappings: mappings });

    // 2. Mac imports
    const macPull = await pullSessionsFromVault({
      dshHome: macHome,
      vault: macVault,
      workspaceMappings: mappings,
      targetPlatform: 'darwin',
    });
    assert.equal(macPull.results[0].status, 'imported');

    // Verify logical hash chain parity between Win original and Mac rewritten
    const macLogPath = path.join(macHome, 'sessions', projectKey('/Users/alex/Alpha'), encodeSegment(sid), 'session.v4.jsonl.zstd');
    const macDecoded = await decodeV4SessionLog(await fs.readFile(macLogPath));
    const winChain = computeEventHashChain(initialEvents, mappings);
    const macChain = computeEventHashChain(macDecoded.events, mappings);
    assert.equal(macChain.headHash, winChain.headHash, 'logical normalized hash chain must be 100% identical across OS rewrite');

    // 3. Mac continues conversation for 2 more turns (4 more events)
    const macExtraEvents = [
      { seq: 4, time: 1732410010000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Mac 续聊第二轮' }] } },
      { seq: 5, time: 1732410011000, type: 'working-directory/change', data: { cwd: '/Users/alex/Alpha/outputs' } },
      { seq: 6, time: 1732410012000, type: 'assistant/message', data: { stream: [{ type: 'text', text: 'Mac 第二轮回答' }] } },
      { seq: 7, time: 1732410013000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Mac 续聊第三轮' }] } },
    ];
    const macAllEvents = [...macDecoded.events, ...macExtraEvents];
    await writeFileAtomic(macLogPath, await encodeV4SessionLog(macDecoded.header, macAllEvents), { mode: 0o600 });

    await exportSessionClosure({
      dshHome: macHome,
      vault: macVault,
      sessionId: sid,
      workspaceMappings: mappings,
      deviceLabel: 'MacBook Pro',
    });

    // 4. Win pulls back -> must Fast-Forward cleanly!
    const winPull = await pullSessionsFromVault({
      dshHome: winHome,
      vault: winVault,
      workspaceMappings: mappings,
      targetPlatform: 'win32',
    });

    assert.equal(winPull.results.length, 1);
    assert.equal(winPull.results[0].status, 'fast-forwarded');
    assert.equal(winPull.results[0].previousEventCount, 4);
    assert.equal(winPull.results[0].newEventCount, 8);

    const winLogPath = path.join(winHome, 'sessions', projectKey(winDir), encodeSegment(sid), 'session.v4.jsonl.zstd');
    const winAfter = await decodeV4SessionLog(await fs.readFile(winLogPath));
    assert.equal(winAfter.events.length, 8);
    assert.equal(winAfter.events[5].data.cwd.toLowerCase(), path.join(winDir, 'outputs').toLowerCase());
    assert.equal(winAfter.events[7].data.content[0].text, 'Mac 续聊第三轮');

    // Pulling again must be up-to-date
    const winPullAgain = await pullSessionsFromVault({
      dshHome: winHome,
      vault: winVault,
      workspaceMappings: mappings,
      targetPlatform: 'win32',
    });
    assert.equal(winPullAgain.results[0].status, 'up-to-date');
  });

  test('online mode respects isSessionBusy and delegates Fast-Forward & workspace to cordisCtx without touching workspace.json', async () => {
    const winHome = path.join(TEST_TMP_ROOT, 'case2b-win-home');
    const macHome = path.join(TEST_TMP_ROOT, 'case2b-mac-home');
    const vaultDir = path.join(TEST_TMP_ROOT, 'case2b-vault');
    const winDir = path.join(TEST_TMP_ROOT, 'case2b-win-proj');
    await fs.mkdir(winDir, { recursive: true });

    const mappings = [{ id: 'p1', title: 'P1', win32: winDir, darwin: '/Users/alex/P1' }];
    const winVault = new VaultStore({ vaultDir, deviceId: 'win-1', platform: 'win32' });
    const macVault = new VaultStore({ vaultDir, deviceId: 'mac-1', platform: 'darwin' });

    const sid = 'session-online-ff';
    const baseEvents = [
      { seq: 0, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    ];
    await writeLocalSession(winHome, { type: 'session', version: 4, id: sid, createdAt: 1000, cwd: winDir, isSeeded: false, delegationDepth: 0 }, baseEvents);

    // Mac has base + 1 new event
    const macEvents = [
      ...baseEvents,
      { seq: 1, time: 2000, type: 'assistant/message', data: { stream: [{ type: 'text', text: 'world from mac' }] } },
    ];
    await writeLocalSession(macHome, { type: 'session', version: 4, id: sid, createdAt: 1000, cwd: '/Users/alex/P1', isSeeded: false, delegationDepth: 0 }, macEvents);
    const { commit } = await exportSessionClosure({ dshHome: macHome, vault: macVault, sessionId: sid, workspaceMappings: mappings });

    // Busy session -> deferred-busy
    const busyCtx = { isSessionBusy: (id) => id === sid };
    const busyRes = await importSessionCommit({
      dshHome: winHome,
      vault: winVault,
      commit,
      workspaceMappings: mappings,
      targetPlatform: 'win32',
      cordisCtx: busyCtx,
    });
    assert.equal(busyRes.status, 'deferred-busy');

    // Idle online session -> uses cordisCtx handles
    const calls = { appended: [], flushed: false, closed: false, wsCreated: [], cacheDeleted: [] };
    const onlineCtx = {
      isSessionBusy: () => false,
      sessionPersistence: {
        async open(id, mode) {
          assert.equal(id, sid);
          assert.equal(mode, 'write');
          return {
            async append(evs) { calls.appended.push(...evs); },
            async flush() { calls.flushed = true; },
            async close() { calls.closed = true; },
          };
        },
      },
      workspaceRegistry: {
        async create(cwd, title) {
          calls.wsCreated.push({ cwd, title });
          return { id: 'ws-1', async attachSession() {} };
        },
      },
      storageDomain: {
        get(name) {
          assert.equal(name, 'session_projcache');
          return {
            table(t) {
              assert.equal(t, 'sessions');
              return { async delete(id) { calls.cacheDeleted.push(id); } };
            },
          };
        },
      },
    };

    const onlineRes = await importSessionCommit({
      dshHome: winHome,
      vault: winVault,
      commit,
      workspaceMappings: mappings,
      targetPlatform: 'win32',
      cordisCtx: onlineCtx,
    });
    assert.equal(onlineRes.status, 'fast-forwarded');
    assert.equal(calls.appended.length, 1);
    assert.equal(calls.appended[0].seq, 1);
    assert.equal(calls.flushed, true);
    assert.equal(calls.closed, true);
    assert.equal(calls.wsCreated.length, 1);
    assert.ok(calls.cacheDeleted.includes(sid));
    // Must NOT have created workspace.json on disk in online mode
    await assert.rejects(() => fs.stat(path.join(winHome, 'storages', 'workspace.json')), { code: 'ENOENT' });
  });
});

test.describe('session-plane: true split-brain zero-shift fork & safety guards', () => {
  test('offline divergence triggers zero-shift split-brain fork, rewrites delivery-accepted, remaps subagent parent, and is idempotent', async () => {
    const winHome = path.join(TEST_TMP_ROOT, 'case3-win-home');
    const macHome = path.join(TEST_TMP_ROOT, 'case3-mac-home');
    const vaultDir = path.join(TEST_TMP_ROOT, 'case3-vault');
    const winDir = path.join(TEST_TMP_ROOT, 'case3-win-proj');
    await fs.mkdir(winDir, { recursive: true });

    const mappings = [{ id: 'macro', title: '宏观', win32: winDir, darwin: '/Users/alex/宏观' }];
    const winVault = new VaultStore({ vaultDir, deviceId: 'win-office', platform: 'win32' });
    const macVault = new VaultStore({ vaultDir, deviceId: 'macbook-air-m3', platform: 'darwin' });

    const origId = 'session-split-001';
    const commonEvents = [
      { seq: 0, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '美联储利率路径推演' }] } },
      { seq: 1, time: 1100, type: 'session/title', data: { title: '美联储利率推演', messageSeqs: [0], source: { kind: 'fallback' } } },
    ];

    // Win diverges locally
    const winEvents = [
      ...commonEvents,
      { seq: 2, time: 2000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Windows 离线续聊：看美债收益率' }] } },
    ];
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: origId, createdAt: 1000, cwd: winDir, isSeeded: false, delegationDepth: 0 },
      winEvents,
    );

    // Mac diverges offline with delivery-accepted watermark AND a diverged subagent
    const macSubId = 'session-sub-mac-diverged';
    const macEvents = [
      ...commonEvents,
      { seq: 2, time: 2100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Mac 离线续聊：看点阵图分布' }] } },
      { seq: 3, time: 2200, type: 'session-log-deepseek/delivery-accepted', data: { sessionId: origId, sessionFormatVersion: 4, throughSeq: 2 } },
      { seq: 4, time: 2300, type: 'subagent/catalog', data: { version: 0, childId: macSubId, childCreatedAt: 2300, mode: 'continuable', label: 'Mac 子代理' } },
    ];
    await writeLocalSession(
      macHome,
      { type: 'session', version: 4, id: origId, createdAt: 1000, cwd: '/Users/alex/宏观', isSeeded: false, delegationDepth: 0 },
      macEvents,
    );
    await writeLocalSession(
      macHome,
      { type: 'session', version: 4, id: macSubId, createdAt: 2300, cwd: '/Users/alex/宏观', parentSession: origId, origin: 'subagent', isSeeded: false, delegationDepth: 1 },
      [{ seq: 0, time: 2310, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '抓取点阵图' }] } }],
    );

    await exportSessionClosure({
      dshHome: macHome,
      vault: macVault,
      sessionId: origId,
      workspaceMappings: mappings,
      deviceLabel: 'MacBook Air',
    });

    // Win pulls -> must trigger zero-shift split-brain fork!
    const pullRes = await pullSessionsFromVault({
      dshHome: winHome,
      vault: winVault,
      workspaceMappings: mappings,
      targetPlatform: 'win32',
    });

    assert.equal(pullRes.results.length, 1);
    const res = pullRes.results[0];
    assert.equal(res.status, 'forked-branch');
    assert.equal(res.sessionId, origId);
    assert.ok(res.branchId.startsWith('session-branch-macbook--'));

    // 1. Original Win session untouched!
    const winOrigPath = path.join(winHome, 'sessions', projectKey(winDir), encodeSegment(origId), 'session.v4.jsonl.zstd');
    const winOrigDecoded = await decodeV4SessionLog(await fs.readFile(winOrigPath));
    assert.deepEqual(winOrigDecoded.events, winEvents);

    // 2. Forked branch session exists, zero seq shift, header.origin deleted, delivery-accepted rewritten, trailing session/title valid!
    const branchPath = path.join(winHome, 'sessions', projectKey(winDir), encodeSegment(res.branchId), 'session.v4.jsonl.zstd');
    const branchDecoded = await decodeV4SessionLog(await fs.readFile(branchPath));
    assert.equal(branchDecoded.header.id, res.branchId);
    assert.equal(branchDecoded.header.parentSession, origId);
    assert.equal(branchDecoded.header.origin, undefined);
    assert.equal(branchDecoded.header.isSeeded, false);

    // Zero seq shift: events 0..4 have exact seq 0..4, and event 5 is trailing session/title
    assert.equal(branchDecoded.events.length, 6);
    for (let i = 0; i < 6; i++) {
      assert.equal(branchDecoded.events[i].seq, i, `event index ${i} must have exact seq ${i} (zero shift)`);
    }
    // delivery-accepted at seq 3 rewritten to branchId
    assert.equal(branchDecoded.events[3].type, 'session-log-deepseek/delivery-accepted');
    assert.equal(branchDecoded.events[3].data.sessionId, res.branchId);
    assert.equal(branchDecoded.events[3].data.throughSeq, 2);

    // Trailing session/title has DSH valid structure & branch prefix
    const titleEv = branchDecoded.events[5];
    assert.equal(titleEv.type, 'session/title');
    assert.equal(titleEv.seq, 5);
    assert.ok(titleEv.data.title.includes('[来自MacBook Air分支]'));
    assert.ok(titleEv.data.title.includes('美联储利率推演'));
    assert.deepEqual(titleEv.data.messageSeqs, []);
    assert.deepEqual(titleEv.data.source, { kind: 'user' });

    // Diverged subagent's parentSession remapped to branchId
    const subPath = path.join(winHome, 'sessions', projectKey(winDir), encodeSegment(macSubId), 'session.v4.jsonl.zstd');
    const subDecoded = await decodeV4SessionLog(await fs.readFile(subPath));
    assert.equal(subDecoded.header.parentSession, res.branchId);
    assert.equal(subDecoded.header.origin, 'subagent');

    // Workspace.json registers both origId and branchId, excludes macSubId
    const wsJson = JSON.parse(await fs.readFile(path.join(winHome, 'storages', 'workspace.json'), 'utf8'));
    assertWorkspaceV2Invariants(wsJson);
    const wsSessions = Object.values(wsJson.tables.workspaces).flatMap((w) => w.sessionIds);
    assert.ok(wsSessions.includes(res.branchId));
    assert.equal(wsSessions.includes(macSubId), false);

    // Idempotent second pull -> up-to-date, does NOT create a duplicate branch
    const pullAgain = await pullSessionsFromVault({
      dshHome: winHome,
      vault: winVault,
      workspaceMappings: mappings,
      targetPlatform: 'win32',
    });
    assert.equal(pullAgain.results[0].status, 'up-to-date');

    // If Mac continues chatting on its diverged branch, Win fast-forwards the EXISTING branchId!
    const macGrownEvents = [
      ...macEvents,
      { seq: 5, time: 2400, type: 'assistant/message', data: { stream: [{ type: 'text', text: '点阵图中位数维持不变' }] } },
    ];
    await writeLocalSession(
      macHome,
      { type: 'session', version: 4, id: origId, createdAt: 1000, cwd: '/Users/alex/宏观', isSeeded: false, delegationDepth: 0 },
      macGrownEvents,
    );
    await exportSessionClosure({
      dshHome: macHome,
      vault: macVault,
      sessionId: origId,
      workspaceMappings: mappings,
      deviceLabel: 'MacBook Air',
    });

    const pullGrown = await pullSessionsFromVault({
      dshHome: winHome,
      vault: winVault,
      workspaceMappings: mappings,
      targetPlatform: 'win32',
    });
    assert.equal(pullGrown.results.length, 1);
    assert.equal(pullGrown.results[0].status, 'fast-forwarded');
    assert.equal(pullGrown.results[0].branchId, res.branchId);
    const branchAfterGrow = await decodeV4SessionLog(await fs.readFile(branchPath));
    assert.equal(branchAfterGrow.events.length, 7); // 6 remote events + 1 trailing branch title
    assert.equal(branchAfterGrow.events[5].data.stream[0].text, '点阵图中位数维持不变');
    assert.equal(branchAfterGrow.events[6].type, 'session/title');
    assert.equal(branchAfterGrow.events[6].seq, 6);
  });

  test('hydration pending, version mismatch, anti-duplicate projectKey cleanup & unmapped fallback', async () => {
    const srcHome = path.join(TEST_TMP_ROOT, 'case4-src-home');
    const dstHome = path.join(TEST_TMP_ROOT, 'case4-dst-home');
    const vaultDir = path.join(TEST_TMP_ROOT, 'case4-vault');
    const fallbackRoot = path.join(TEST_TMP_ROOT, 'case4-fallback');

    const srcVault = new VaultStore({ vaultDir, deviceId: 'mac-src', platform: 'darwin' });
    const dstVault = new VaultStore({ vaultDir, deviceId: 'win-dst', platform: 'win32' });

    const sid = 'session-guards-001';
    await writeLocalSession(
      srcHome,
      { type: 'session', version: 4, id: sid, createdAt: 1000, cwd: '/Users/alex/unmapped-repo', isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 1001, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } }],
    );

    const { commit } = await exportSessionClosure({ dshHome: srcHome, vault: srcVault, sessionId: sid });

    // 1. Version mismatch guard
    const futureCommit = {
      ...commit,
      payload: { ...commit.payload, dshFormatVersion: 99 },
    };
    const vmRes = await importSessionCommit({
      dshHome: dstHome,
      vault: dstVault,
      commit: futureCommit,
      targetPlatform: 'win32',
      fallbackRoot,
    });
    assert.equal(vmRes.status, 'version-mismatch');
    assert.deepEqual(await findAllSessionDirsById(dstHome, sid), []);

    // 2. Hydration pending guard (.icloud placeholder)
    const logRef = commit.payload.nodes[0].logBlob;
    const blobFile = path.join(vaultDir, 'blobs', 'sha256', logRef.storageKey.slice(0, 2), logRef.storageKey);
    const icloudFile = path.join(path.dirname(blobFile), `.${logRef.storageKey}.icloud`);
    const savedBlob = await fs.readFile(blobFile);
    await fs.rm(blobFile);
    await fs.writeFile(icloudFile, 'icloud-stub');

    const hydRes = await importSessionCommit({
      dshHome: dstHome,
      vault: dstVault,
      commit,
      targetPlatform: 'win32',
      fallbackRoot,
    });
    assert.equal(hydRes.status, 'pending-hydration');
    assert.deepEqual(await findAllSessionDirsById(dstHome, sid), []);

    // Restore blob
    await fs.rm(icloudFile);
    await fs.writeFile(blobFile, savedBlob);

    // 3. Anti-duplicate directory guard + unmapped fallback directory creation
    // Plant an old directory for the SAME sessionId under a different projectKey
    const oldWinDir = path.join(TEST_TMP_ROOT, 'case4-old-dir');
    await fs.mkdir(oldWinDir, { recursive: true });
    await writeLocalSession(
      dstHome,
      { type: 'session', version: 4, id: sid, createdAt: 1000, cwd: oldWinDir, isSeeded: false, delegationDepth: 0 },
      [],
    );
    assert.equal((await findAllSessionDirsById(dstHome, sid)).length, 1);

    // Now import commit (0 local events -> 1 remote event = Fast-Forward + cwd moves to fallbackRoot!)
    const impRes = await importSessionCommit({
      dshHome: dstHome,
      vault: dstVault,
      commit,
      targetPlatform: 'win32',
      fallbackRoot,
    });
    assert.equal(impRes.status, 'fast-forwarded');

    // Verify ONLY ONE projectKey directory holds sid (no duplicate directory explosion!)
    const dirsAfter = await findAllSessionDirsById(dstHome, sid);
    assert.equal(dirsAfter.length, 1, 'sessionId must NEVER exist in two projectKey directories');

    // Verify fallback directory was created and header.cwd points inside fallbackRoot
    const decodedAfter = await decodeV4SessionLog(
      await fs.readFile(path.join(dirsAfter[0].dir, 'session.v4.jsonl.zstd')),
    );
    assert.ok(decodedAfter.header.cwd.toLowerCase().includes('case4-fallback'));
    assert.equal((await fs.stat(decodedAfter.header.cwd)).isDirectory(), true);

    // 4. exportAllLocalSessions skips subagent roots & exports all top-level sessions
    const exportAllRes = await exportAllLocalSessions({ dshHome: srcHome, vault: srcVault });
    assert.equal(exportAllRes.exported.length, 1);
    assert.equal(exportAllRes.exported[0].rootSessionId, sid);
  });

  test('rewriteSessionForTargetOs leaves non-path events untouched and supports in-memory snapshot export', async () => {
    const winHome = path.join(TEST_TMP_ROOT, 'case5-win-home');
    const vaultDir = path.join(TEST_TMP_ROOT, 'case5-vault');
    const vault = new VaultStore({ vaultDir, deviceId: 'win-snap', platform: 'win32' });

    const mappings = [{ id: 'w1', title: 'W1', win32: 'D:\\Work', darwin: '/Users/bob/Work' }];
    const header = { type: 'session', version: 4, id: 'snap-1', createdAt: 1000, cwd: 'D:\\Work', isSeeded: false, delegationDepth: 0 };
    const events = [
      { seq: 0, time: 1001, type: 'assistant/message', data: { stream: [{ type: 'reasoning', text: 'D:\\Work\\secret.py', signature: 'sig1' }] } },
      { seq: 1, time: 1002, type: 'working-directory/change', data: { cwd: 'D:\\Work\\sub' } },
    ];

    const rewritten = await rewriteSessionForTargetOs({
      header,
      events,
      workspaceMappings: mappings,
      targetPlatform: 'darwin',
    });
    assert.equal(rewritten.header.cwd, '/Users/bob/Work');
    assert.equal(rewritten.events[1].data.cwd, '/Users/bob/Work/sub');
    // assistant/message mentioning D:\Work\secret.py in text/reasoning MUST NOT be rewritten!
    assert.equal(JSON.stringify(rewritten.events[0]), JSON.stringify(events[0]));

    // Export using in-memory snapshot without writing to disk
    const res = await exportSessionClosure({
      dshHome: winHome,
      vault,
      sessionId: 'snap-1',
      workspaceMappings: mappings,
      snapshot: { header, events },
    });
    assert.equal(res.commit.targetId, 'snap-1');
    assert.equal(res.commit.payload.nodes[0].eventCount, 2);
  });

  test('unmapped fallback session with working-directory/change & absolute deliverables/presented does not false-fork on repeated pull', async () => {
    const srcHome = path.join(TEST_TMP_ROOT, 'case6-src-home');
    const dstHome = path.join(TEST_TMP_ROOT, 'case6-dst-home');
    const vaultDir = path.join(TEST_TMP_ROOT, 'case6-vault');
    const fallbackRoot = path.join(TEST_TMP_ROOT, 'case6-fallback');

    const srcVault = new VaultStore({ vaultDir, deviceId: 'mac-src-fb', platform: 'darwin' });
    const dstVault = new VaultStore({ vaultDir, deviceId: 'win-dst-fb', platform: 'win32' });

    const rootId = 'session-unmapped-fb-001';
    const childId = 'session-unmapped-fb-child-001';

    await writeLocalSession(
      srcHome,
      { type: 'session', version: 4, id: rootId, createdAt: 1000, cwd: '/Users/alex/unmapped-alpha', isSeeded: false, delegationDepth: 0 },
      [
        { seq: 0, time: 1001, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'check unmapped' }] } },
        { seq: 1, time: 1002, type: 'working-directory/change', data: { cwd: '/Users/alex/unmapped-alpha/subdir' } },
        { seq: 2, time: 1003, type: 'deliverables/presented', data: { files: [{ path: '/Users/alex/unmapped-alpha/subdir/out.xlsx' }] } },
        { seq: 3, time: 1004, type: 'subagent/catalog', data: { childId } },
      ],
    );
    await writeLocalSession(
      srcHome,
      { type: 'session', version: 4, id: childId, parentSession: rootId, origin: 'subagent', createdAt: 1005, cwd: '/Users/alex/unmapped-alpha/subdir', isSeeded: false, delegationDepth: 1 },
      [
        { seq: 0, time: 1006, type: 'working-directory/change', data: { cwd: '/Users/alex/unmapped-alpha/subdir/nested' } },
        { seq: 1, time: 1007, type: 'assistant/message', data: { stream: [{ type: 'text', text: 'child done' }] } },
      ],
    );

    await exportSessionClosure({
      dshHome: srcHome,
      vault: srcVault,
      sessionId: rootId,
      workspaceMappings: [],
      deviceLabel: 'MacBook',
    });

    const pull1 = await pullSessionsFromVault({
      dshHome: dstHome,
      vault: dstVault,
      workspaceMappings: [],
      targetPlatform: 'win32',
      fallbackRoot,
    });
    assert.equal(pull1.summary.imported, 1);
    assert.equal(pull1.summary.forkedBranches, 0);

    // Second pull of the exact same unmapped commit MUST report upToDate: 1 and forkedBranches: 0
    const pull2 = await pullSessionsFromVault({
      dshHome: dstHome,
      vault: dstVault,
      workspaceMappings: [],
      targetPlatform: 'win32',
      fallbackRoot,
    });
    assert.equal(pull2.summary.upToDate, 1);
    assert.equal(pull2.summary.forkedBranches, 0);
  });

  test('offline session_projcache invalidation rejects path traversal IDs and online SessionAlreadyOwnedError returns deferred-busy', async () => {
    const srcHome = path.join(TEST_TMP_ROOT, 'case7-src-home');
    const dstHome = path.join(TEST_TMP_ROOT, 'case7-dst-home');
    const vaultDir = path.join(TEST_TMP_ROOT, 'case7-vault');

    const srcVault = new VaultStore({ vaultDir, deviceId: 'mac-src-sec', platform: 'darwin' });
    const dstVault = new VaultStore({ vaultDir, deviceId: 'win-dst-sec', platform: 'win32' });

    // 1. Offline cache traversal guard: plant a file outside session_projcache/sessions/
    const outsideVictim = path.join(dstHome, 'storages', 'victim-outside.json');
    await writeFileAtomic(outsideVictim, '{"safe":true}\n', { mode: 0o600 });

    const craftedId = '../../victim-outside';
    await writeLocalSession(
      srcHome,
      { type: 'session', version: 4, id: craftedId, createdAt: 1000, cwd: '/Users/alex/sec', isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 1001, type: 'user/message', data: { content: [{ type: 'text', text: 'probe' }] } }],
    );
    const { commit: craftedCommit } = await exportSessionClosure({
      dshHome: srcHome,
      vault: srcVault,
      sessionId: craftedId,
    });
    await importSessionCommit({
      dshHome: dstHome,
      vault: dstVault,
      commit: craftedCommit,
      targetPlatform: 'win32',
      fallbackRoot: path.join(TEST_TMP_ROOT, 'case7-fb'),
    });
    // Victim file outside session_projcache/sessions/ MUST still exist!
    assert.equal(await fs.readFile(outsideVictim, 'utf8'), '{"safe":true}\n');

    // 2. Online SessionAlreadyOwnedError on sessionPersistence.open gracefully returns deferred-busy without aborting batch
    const busySid = 'session-busy-owned-01';
    const okSid = 'session-other-ok-02';
    const localCwd = path.join(TEST_TMP_ROOT, 'case7-ws');
    await fs.mkdir(localCwd, { recursive: true });
    const mappings = [{ id: 'w7', title: 'W7', win32: localCwd, darwin: '/Users/alex/w7' }];

    // Seed busySid locally with 1 event so remote 2 events triggers fast-forward via sessionPersistence.open
    const ev0 = { seq: 0, time: 2000, type: 'user/message', data: { content: [{ type: 'text', text: 'turn 1' }] } };
    const ev1 = { seq: 1, time: 2005, type: 'assistant/message', data: { stream: [{ type: 'text', text: 'turn 2' }] } };
    await writeLocalSession(
      dstHome,
      { type: 'session', version: 4, id: busySid, createdAt: 2000, cwd: localCwd, isSeeded: false, delegationDepth: 0 },
      [ev0],
    );

    const srcVault2 = new VaultStore({ vaultDir: path.join(TEST_TMP_ROOT, 'case7-vault2'), deviceId: 'mac-src-2', platform: 'darwin' });
    const dstVault2 = new VaultStore({ vaultDir: path.join(TEST_TMP_ROOT, 'case7-vault2'), deviceId: 'win-dst-2', platform: 'win32' });
    const srcHome2 = path.join(TEST_TMP_ROOT, 'case7-src-home2');

    await writeLocalSession(
      srcHome2,
      { type: 'session', version: 4, id: busySid, createdAt: 2000, cwd: '/Users/alex/w7', isSeeded: false, delegationDepth: 0 },
      [ev0, ev1],
    );
    await writeLocalSession(
      srcHome2,
      { type: 'session', version: 4, id: okSid, createdAt: 2010, cwd: '/Users/alex/w7', isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 2011, type: 'user/message', data: { content: [{ type: 'text', text: 'second session' }] } }],
    );
    await exportSessionClosure({ dshHome: srcHome2, vault: srcVault2, sessionId: busySid, workspaceMappings: mappings });
    await exportSessionClosure({ dshHome: srcHome2, vault: srcVault2, sessionId: okSid, workspaceMappings: mappings });

    const mockCordisCtx = {
      workspaceRegistry: {
        async create(cwd) { return { id: 'ws-mock', cwd, async attachSession() {} }; },
      },
      sessionPersistence: {
        async open(sid) {
          if (sid === busySid) {
            const err = new Error('Session is already owned by another active writer');
            err.name = 'SessionAlreadyOwnedError';
            throw err;
          }
          return { async append() {}, async flush() {}, async close() {} };
        },
      },
      storageDomain: {
        get() { return { table() { return { async delete() {} }; } }; },
      },
    };

    const pullBatch = await pullSessionsFromVault({
      dshHome: dstHome,
      vault: dstVault2,
      workspaceMappings: mappings,
      targetPlatform: 'win32',
      cordisCtx: mockCordisCtx,
    });
    assert.equal(pullBatch.summary.deferredBusy, 1);
    assert.equal(pullBatch.summary.imported, 1);
    const busyRes = pullBatch.results.find((r) => r.sessionId === busySid);
    assert.equal(busyRes?.status, 'deferred-busy');
  });

  test('zero-config auto-homing into default workspace + pin-to-top + vault self-rescue + basename match + orphan migration + Win->Mac->Win roundtrip + unmapped outputs/', async () => {
    const winHome = path.join(TEST_TMP_ROOT, 'ux1-win-home');
    const macHome = path.join(TEST_TMP_ROOT, 'ux1-mac-home');
    const vaultDir = path.join(TEST_TMP_ROOT, 'ux1-vault');
    const winRandomDir = path.join(TEST_TMP_ROOT, 'ux1-win-any-folder');
    const macDefaultWsDir = path.join(TEST_TMP_ROOT, 'ux1-mac-default-workspace');
    const macSameNameDir = path.join(TEST_TMP_ROOT, 'ux1-mac-parent', 'same-name-proj');
    const winSameNameDir = path.join(TEST_TMP_ROOT, 'ux1-win-parent', 'same-name-proj');

    await fs.mkdir(path.join(winRandomDir, 'outputs'), { recursive: true });
    await fs.mkdir(macDefaultWsDir, { recursive: true });
    await fs.mkdir(macSameNameDir, { recursive: true });
    await fs.mkdir(winSameNameDir, { recursive: true });
    await fs.mkdir(vaultDir, { recursive: true });

    const winVault = new VaultStore({ vaultDir, deviceId: 'win-zero-cfg', platform: 'win32' });
    const macVault = new VaultStore({ vaultDir, deviceId: 'mac-zero-cfg', platform: 'darwin' });

    // Create a mock Mac workspaceRegistry with defaultWorkspaceId + an existing session + a same-basename workspace
    const defaultWsRecord = {
      id: 'ws-default',
      path: macDefaultWsDir,
      sessionIds: ['session-older-001'],
      insertCalls: [],
      async attachSession(id) {
        if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
      },
      async insertSessionBefore(id, beforeId) {
        this.insertCalls.push({ id, beforeId });
        const without = this.sessionIds.filter((s) => s !== id);
        const idx = without.indexOf(beforeId);
        this.sessionIds = idx === -1 ? [id, ...without] : [...without.slice(0, idx), id, ...without.slice(idx)];
      },
      async detachSession(id) {
        this.sessionIds = this.sessionIds.filter((s) => s !== id);
      },
    };
    const sameNameWsRecord = {
      id: 'ws-same-name',
      path: macSameNameDir,
      sessionIds: [],
      async attachSession(id) {
        if (!this.sessionIds.includes(id)) this.sessionIds.unshift(id);
      },
      async insertSessionBefore() {},
      async detachSession(id) {
        this.sessionIds = this.sessionIds.filter((s) => s !== id);
      },
    };
    const unmappedWsPath = path.join(macHome, 'soul-sync', 'unmapped-workspaces', 'D', 'legacy');
    const oldUnmappedWsRecord = {
      id: 'ws-old-unmapped',
      path: unmappedWsPath,
      sessionIds: ['session-orphan-01'],
      detached: [],
      async attachSession() {},
      async detachSession(id) {
        this.detached.push(id);
        this.sessionIds = this.sessionIds.filter((s) => s !== id);
      },
    };

    const macCordisCtx = {
      workspaceRegistry: {
        state: { defaultWorkspaceId: 'ws-default' },
        get(id) {
          if (id === 'ws-default') return defaultWsRecord;
          if (id === 'ws-same-name') return sameNameWsRecord;
          if (id === 'ws-old-unmapped') return oldUnmappedWsRecord;
          return undefined;
        },
        list() {
          return [defaultWsRecord, sameNameWsRecord, oldUnmappedWsRecord];
        },
        async create(cwd) {
          if (cwd.toLowerCase() === macDefaultWsDir.toLowerCase()) return defaultWsRecord;
          if (cwd.toLowerCase() === macSameNameDir.toLowerCase()) return sameNameWsRecord;
          return { id: 'ws-other', path: cwd, sessionIds: [], async attachSession() {} };
        },
      },
      storageDomain: {
        get() { return { table() { return { async delete() {} }; } }; },
      },
    };

    // 1. Unmapped Win session with outputs/ (valid file + skipped ~$ lock + skipped .env + skipped sk- secret)
    const relaySid = 'session-zero-cfg-relay';
    const winEvents1 = [
      { seq: 0, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '分析行业格局' }] } },
      { seq: 1, time: 1001, type: 'working-directory/change', data: { cwd: path.join(winRandomDir, 'outputs') } },
      { seq: 2, time: 1002, type: 'deliverables/presented', data: { files: [{ path: path.join(winRandomDir, 'outputs', 'report.md') }] } },
      { seq: 3, time: 1003, type: 'assistant/message', data: { stream: [{ type: 'text', text: '已生成 outputs/report.md' }] } },
    ];
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: relaySid, createdAt: 1000, cwd: winRandomDir, isSeeded: false, delegationDepth: 0 },
      winEvents1,
    );
    await fs.writeFile(path.join(winRandomDir, 'outputs', 'report.md'), '# 行业格局报告 v1\n', 'utf8');
    await fs.writeFile(path.join(winRandomDir, 'outputs', '~$report.xlsx'), 'excel-lock', 'utf8');
    await fs.writeFile(path.join(winRandomDir, 'outputs', '.env'), 'SECRET=123\n', 'utf8');
    await fs.writeFile(path.join(winRandomDir, 'outputs', 'leaked.txt'), 'token=sk-1234567890abcdefghij\n', 'utf8');

    // 2. Vault self-rescue session: user mistakenly opened vaultDir itself as workspace on Win!
    const vaultOopsSid = 'session-opened-in-vault';
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: vaultOopsSid, createdAt: 1010, cwd: vaultDir, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 1011, type: 'user/message', data: { content: [{ type: 'text', text: '误在金库目录聊的' }] } }],
    );

    // 3. Same-basename session (zero workspaceMappings -> auto-matches macSameNameDir!)
    const basenameSid = 'session-same-basename';
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: basenameSid, createdAt: 1020, cwd: winSameNameDir, isSeeded: false, delegationDepth: 0 },
      [{ seq: 0, time: 1021, type: 'user/message', data: { content: [{ type: 'text', text: '同名目录自动匹配' }] } }],
    );

    // 4. Orphan session ALREADY sitting in Mac's unmapped-workspaces with identical events
    const orphanSid = 'session-orphan-01';
    const orphanEvents = [
      { seq: 0, time: 1030, type: 'user/message', data: { content: [{ type: 'text', text: '旧孤儿会话' }] } },
    ];
    await writeLocalSession(
      winHome,
      { type: 'session', version: 4, id: orphanSid, createdAt: 1030, cwd: winRandomDir, isSeeded: false, delegationDepth: 0 },
      orphanEvents,
    );
    await writeLocalSession(
      macHome,
      { type: 'session', version: 4, id: orphanSid, createdAt: 1030, cwd: unmappedWsPath, isSeeded: false, delegationDepth: 0 },
      orphanEvents,
    );

    // Export all 4 from Windows with ZERO workspaceMappings!
    const expRelay = await exportSessionClosure({ dshHome: winHome, vault: winVault, sessionId: relaySid, workspaceMappings: [] });
    assert.equal(expRelay.packedOutputCount, 1, 'Only safe report.md should be packed (lock/.env/sk- skipped)');
    await exportSessionClosure({ dshHome: winHome, vault: winVault, sessionId: vaultOopsSid, workspaceMappings: [] });
    await exportSessionClosure({ dshHome: winHome, vault: winVault, sessionId: basenameSid, workspaceMappings: [] });
    await exportSessionClosure({ dshHome: winHome, vault: winVault, sessionId: orphanSid, workspaceMappings: [] });

    // Pull on target (using current platform so outputs/ and fs checks execute for real)
    const macPull = await pullSessionsFromVault({
      dshHome: macHome,
      vault: macVault,
      workspaceMappings: [],
      targetPlatform: process.platform,
      cordisCtx: macCordisCtx,
    });
    assert.equal(macPull.summary.imported, 3);
    assert.equal(macPull.summary.migrated, 1);
    assert.equal(macPull.summary.forkedBranches, 0);

    // Verify relaySid auto-homed into macDefaultWsDir and pinned above session-older-001!
    assert.ok(defaultWsRecord.sessionIds.includes(relaySid));
    assert.ok(defaultWsRecord.sessionIds.includes(vaultOopsSid), 'Vault-dir session must be rescued into default workspace');
    assert.ok(defaultWsRecord.sessionIds.includes(orphanSid), 'Orphan session must be rescued into default workspace');
    assert.equal(defaultWsRecord.sessionIds[defaultWsRecord.sessionIds.length - 1], 'session-older-001', 'New/migrated sessions must be pinned above older sessions');
    assert.ok(defaultWsRecord.insertCalls.length >= 1, 'insertSessionBefore should pin relay sessions to top');

    // Verify basenameSid auto-matched same-name-proj!
    assert.ok(sameNameWsRecord.sessionIds.includes(basenameSid));

    // Verify orphanSid was detached from old unmapped workspace and old projectKey dir was cleaned up!
    assert.ok(oldUnmappedWsRecord.detached.includes(orphanSid));
    const orphanDirs = await findAllSessionDirsById(macHome, orphanSid);
    assert.equal(orphanDirs.length, 1);
    const orphanDecoded = await decodeV4SessionLog(await fs.readFile(path.join(orphanDirs[0].dir, 'session.v4.jsonl.zstd')));
    assert.equal(orphanDecoded.header.cwd.toLowerCase(), macDefaultWsDir.toLowerCase());

    // Verify unmapped outputs/ report.md was restored to macDefaultWsDir/outputs/report.md (and secrets were NOT)
    assert.equal(await fs.readFile(path.join(macDefaultWsDir, 'outputs', 'report.md'), 'utf8'), '# 行业格局报告 v1\n');
    await assert.rejects(() => fs.stat(path.join(macDefaultWsDir, 'outputs', '.env')), { code: 'ENOENT' });
    await assert.rejects(() => fs.stat(path.join(macDefaultWsDir, 'outputs', 'leaked.txt')), { code: 'ENOENT' });

    // Verify vaultOopsSid did NOT land inside vaultDir
    const vaultOopsDirs = await findAllSessionDirsById(macHome, vaultOopsSid);
    const vaultOopsDecoded = await decodeV4SessionLog(await fs.readFile(path.join(vaultOopsDirs[0].dir, 'session.v4.jsonl.zstd')));
    assert.equal(vaultOopsDecoded.header.cwd.toLowerCase(), macDefaultWsDir.toLowerCase());

    // 5. Roundtrip: continue chatting 2 turns on Mac (in macDefaultWsDir), export, and pull back to Win (in winRandomDir)!
    const macRelayDirs = await findAllSessionDirsById(macHome, relaySid);
    const macRelayPath = path.join(macRelayDirs[0].dir, 'session.v4.jsonl.zstd');
    const macRelayDecoded = await decodeV4SessionLog(await fs.readFile(macRelayPath));
    const macContinuedEvents = [
      ...macRelayDecoded.events,
      { seq: 4, time: 2000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Mac 续聊第一轮' }] } },
      { seq: 5, time: 2001, type: 'working-directory/change', data: { cwd: path.join(macDefaultWsDir, 'outputs') } },
      { seq: 6, time: 2002, type: 'assistant/message', data: { stream: [{ type: 'text', text: 'Mac 续聊结论' }] } },
    ];
    await writeFileAtomic(macRelayPath, await encodeV4SessionLog(macRelayDecoded.header, macContinuedEvents), { mode: 0o600 });

    // Also modify outputs/report.md on BOTH sides to test non-destructive conflict copy on Win pull
    await fs.writeFile(path.join(macDefaultWsDir, 'outputs', 'report.md'), '# 行业格局报告 v2 (Mac)\n', 'utf8');
    await fs.writeFile(path.join(winRandomDir, 'outputs', 'report.md'), '# 行业格局报告 v2 (Win local edit)\n', 'utf8');

    await exportSessionClosure({ dshHome: macHome, vault: macVault, sessionId: relaySid, workspaceMappings: [], deviceLabel: 'MacBook' });

    const winPullBack = await pullSessionsFromVault({
      dshHome: winHome,
      vault: winVault,
      workspaceMappings: [],
      targetPlatform: process.platform,
    });
    const relayBack = winPullBack.results.find((r) => r.sessionId === relaySid);
    assert.equal(relayBack?.status, 'fast-forwarded', 'Zero-config Win->Mac->Win roundtrip must Fast-Forward without false split-brain');
    assert.equal(relayBack?.previousEventCount, 4);
    assert.equal(relayBack?.newEventCount, 7);
    assert.equal(winPullBack.summary.forkedBranches, 0);

    // Win session MUST remain in winRandomDir (Priority A), with working-directory/change rewritten back to winRandomDir/outputs!
    const winAfterDirs = await findAllSessionDirsById(winHome, relaySid);
    assert.equal(winAfterDirs.length, 1);
    const winAfterDecoded = await decodeV4SessionLog(await fs.readFile(path.join(winAfterDirs[0].dir, 'session.v4.jsonl.zstd')));
    assert.equal(winAfterDecoded.header.cwd.toLowerCase(), winRandomDir.toLowerCase());
    assert.equal(winAfterDecoded.events[5].data.cwd.toLowerCase(), path.join(winRandomDir, 'outputs').toLowerCase());

    // Local Win report.md was preserved untouched AND Mac's conflicting version landed as a sidecar conflict copy!
    assert.equal(await fs.readFile(path.join(winRandomDir, 'outputs', 'report.md'), 'utf8'), '# 行业格局报告 v2 (Win local edit)\n');
    assert.equal(relayBack?.outputConflicts?.length, 1);
    assert.equal(await fs.readFile(relayBack.outputConflicts[0].conflictPath, 'utf8'), '# 行业格局报告 v2 (Mac)\n');
  });
});
