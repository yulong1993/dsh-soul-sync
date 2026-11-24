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
});
