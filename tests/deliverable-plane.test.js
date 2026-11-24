import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { savePassphraseKey } from '../lib/config.js';
import { VaultStore } from '../lib/crypto-vault.js';
import { inspectWorkspaceFile } from '../lib/artifact-worker.js';
import {
  recordDeliverableCandidate,
  createActiveWorkspaceWatcher,
  detectOpenOfficeLocks,
  pushWorkspaceDeliverables,
  pullWorkspaceDeliverables,
  loadWorkspaceDeliverableState,
} from '../lib/deliverable-plane.js';

const execFile = promisify(execFileCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_ROOT = path.join(REPO_ROOT, '.test-tmp', `deliverable-plane-${process.pid}-${Date.now()}`);

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeValidZipBuffer(payloadText = 'sheet1-v1') {
  const payload = Buffer.from(payloadText, 'utf8');
  const localHeader = Buffer.from([
    0x50, 0x4b, 0x03, 0x04, // PK\x03\x04
    0x14, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    payload.length & 0xff, (payload.length >> 8) & 0xff, 0x00, 0x00,
    payload.length & 0xff, (payload.length >> 8) & 0xff, 0x00, 0x00,
    0x05, 0x00, 0x00, 0x00,
  ]);
  const fileName = Buffer.from('a.xml', 'utf8');
  const eocd = Buffer.from([
    0x50, 0x4b, 0x05, 0x06, // PK\x05\x06 EOCD
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ]);
  return Buffer.concat([localHeader, fileName, payload, eocd]);
}

function makeTornZipBuffer(payloadText = 'half-written-excel') {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
    Buffer.from(payloadText, 'utf8'),
  ]);
}

function makeValidPdfBuffer(body = 'Q3 Financial Memo') {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n(${body})\nendobj\n%%EOF\n`, 'utf8');
}

function makeTornPdfBuffer(body = 'truncated pdf without eof') {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n(${body})\nstream\n...`, 'utf8');
}

function makeValidPngBuffer(extra = 'chart-data') {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mid = Buffer.from(extra, 'utf8');
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([magic, mid, iend]);
}

function makeTornPngBuffer() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('incomplete-idat-chunk', 'utf8'),
  ]);
}

function makeValidParquetBuffer(body = 'col1-data') {
  return Buffer.concat([Buffer.from('PAR1', 'ascii'), Buffer.from(body, 'utf8'), Buffer.from('PAR1', 'ascii')]);
}

function makeTornParquetBuffer() {
  return Buffer.concat([Buffer.from('PAR1', 'ascii'), Buffer.from('half-written-parquet', 'utf8')]);
}

async function writeFileEnsuringDir(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function waitForCondition(predicate, timeoutMs = 4000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test.before(async () => {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
});

test.after(async () => {
  await fs.rm(TEST_TMP_ROOT, { recursive: true, force: true });
});

test.describe('deliverable-plane: 4-signal provenance ledger & Git exclusion', () => {
  test('excludes legacy files, git-tracked files, and .dshsyncignore while tracking outputs/**, tool, watcher, /soul keep, and subsequent manual Excel edits', async () => {
    const baseDir = path.join(TEST_TMP_ROOT, 'case1-provenance');
    const dshHome = path.join(baseDir, 'dsh-home');
    const vaultDir = path.join(baseDir, 'vault');
    const wsRoot = path.join(baseDir, 'workspace');
    await fs.mkdir(wsRoot, { recursive: true });

    // Pre-existing legacy files that must NEVER be uploaded
    await writeFileEnsuringDir(path.join(wsRoot, 'legacy_history.xlsx'), makeValidZipBuffer('old-legacy-data'));
    await writeFileEnsuringDir(path.join(wsRoot, 'raw_prices.csv'), 'date,close\n2020-01-02,100\n');

    // Initialize a git repo and track two files: one normal (excluded), one forced via /soul keep (included)
    await execFile('git', ['init'], { cwd: wsRoot });
    await writeFileEnsuringDir(path.join(wsRoot, 'tracked_in_git.py'), 'print("managed by git")\n');
    await writeFileEnsuringDir(path.join(wsRoot, 'keep_override.py'), 'print("kept via /soul keep")\n');
    await execFile('git', ['add', 'tracked_in_git.py', 'keep_override.py'], { cwd: wsRoot });

    // Optional .dshsyncignore
    await writeFileEnsuringDir(path.join(wsRoot, '.dshsyncignore'), '# ignore temp exports\noutputs/ignored.csv\n');
    await writeFileEnsuringDir(path.join(wsRoot, 'outputs', 'ignored.csv'), 'temp,1\n');

    // Signal 2: outputs/**
    const reportV1 = makeValidZipBuffer('valuation-v1');
    await writeFileEnsuringDir(path.join(wsRoot, 'outputs', 'report.xlsx'), reportV1);

    // Signal 1: tool-written file outside outputs/
    await writeFileEnsuringDir(path.join(wsRoot, 'scripts', 'dcf.py'), 'def dcf(fcf, wacc):\n    return fcf / wacc\n');
    await recordDeliverableCandidate(dshHome, 'us-stocks', wsRoot, path.join(wsRoot, 'scripts', 'dcf.py'), 'tool');

    // Signal 4: /soul keep overriding git ls-files
    await recordDeliverableCandidate(dshHome, 'us-stocks', wsRoot, 'keep_override.py', 'manual');

    // Also record git-tracked non-manual file via tool — must still be skipped by git ls-files exclusion
    await recordDeliverableCandidate(dshHome, 'us-stocks', wsRoot, 'tracked_in_git.py', 'tool');

    // Signal 3: active workspace watcher captures newly created file without touching legacy files
    const watchedPaths = [];
    const watcher = createActiveWorkspaceWatcher(wsRoot, async (relPosix) => {
      watchedPaths.push(relPosix);
      await recordDeliverableCandidate(dshHome, 'us-stocks', wsRoot, relPosix, 'watcher');
    });

    try {
      await new Promise((r) => setTimeout(r, 120));
      await writeFileEnsuringDir(path.join(wsRoot, 'charts', 'revenue.png'), makeValidPngBuffer('nvda-rev-2026'));
      // Write a lock file that watcher must ignore
      await writeFileEnsuringDir(path.join(wsRoot, 'outputs', '~$report.xlsx'), 'lock');

      const seen = await waitForCondition(() => watchedPaths.includes('charts/revenue.png'), 4000);
      assert.equal(seen, true, `Watcher should capture charts/revenue.png, saw: ${JSON.stringify(watchedPaths)}`);
      assert.equal(watchedPaths.some((p) => p.includes('~$report.xlsx')), false, 'Watcher must filter Office lock files');
      assert.equal(watchedPaths.includes('legacy_history.xlsx'), false, 'Watcher must not touch pre-existing legacy files');
      await fs.rm(path.join(wsRoot, 'outputs', '~$report.xlsx'), { force: true });
    } finally {
      await watcher.close();
    }

    const vault = new VaultStore({ vaultDir, deviceId: 'win-office', platform: 'win32' });
    const push1 = await pushWorkspaceDeliverables({
      dshHome,
      vault,
      workspaceId: 'us-stocks',
      workspaceRoot: wsRoot,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });

    assert.equal(push1.published, true);
    assert.ok(push1.tree['outputs/report.xlsx'], 'outputs/report.xlsx must be uploaded');
    assert.ok(push1.tree['scripts/dcf.py'], 'tool-recorded scripts/dcf.py must be uploaded');
    assert.ok(push1.tree['charts/revenue.png'], 'watcher-captured charts/revenue.png must be uploaded');
    assert.ok(push1.tree['keep_override.py'], '/soul keep manual file must override git exclusion');

    assert.equal(push1.tree['legacy_history.xlsx'], undefined, 'legacy .xlsx must NOT be uploaded');
    assert.equal(push1.tree['raw_prices.csv'], undefined, 'legacy .csv must NOT be uploaded');
    assert.equal(push1.tree['tracked_in_git.py'], undefined, 'git-tracked non-manual .py must NOT be uploaded');
    assert.equal(push1.tree['outputs/ignored.csv'], undefined, '.dshsyncignore file must NOT be uploaded');

    // Verify no state files were written into the user workspace itself
    const wsEntries = await fs.readdir(wsRoot);
    assert.equal(wsEntries.includes('.dsh-soul-sync'), false);

    // Simulate colleague manually editing the tracked Excel file later
    const reportV2 = makeValidZipBuffer('valuation-v2-colleague-manual-edit');
    await fs.writeFile(path.join(wsRoot, 'outputs', 'report.xlsx'), reportV2);

    const push2 = await pushWorkspaceDeliverables({
      dshHome,
      vault,
      workspaceId: 'us-stocks',
      workspaceRoot: wsRoot,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });

    assert.equal(push2.published, true);
    assert.deepEqual(push2.uploaded, ['outputs/report.xlsx']);
    assert.equal(push2.tree['outputs/report.xlsx'].sha256, sha256Hex(reportV2));
  });
});

test.describe('deliverable-plane: container trailer autopsy gate & stability guard', () => {
  test('defers torn .xlsx/.pdf/.png/.parquet without corrupting intact vault versions', async () => {
    const baseDir = path.join(TEST_TMP_ROOT, 'case2-torn-containers');
    const winHome = path.join(baseDir, 'win-home');
    const macHome = path.join(baseDir, 'mac-home');
    const vaultDir = path.join(baseDir, 'vault');
    const winWs = path.join(baseDir, 'win-ws');
    const macWs = path.join(baseDir, 'mac-ws');
    await fs.mkdir(winWs, { recursive: true });
    await fs.mkdir(macWs, { recursive: true });

    const goodXlsx = makeValidZipBuffer('good-model-v1');
    const goodPdf = makeValidPdfBuffer('good-memo-v1');
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'model.xlsx'), goodXlsx);
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'memo.pdf'), goodPdf);

    const winVault = new VaultStore({ vaultDir, deviceId: 'win-office', platform: 'win32' });
    const macVault = new VaultStore({ vaultDir, deviceId: 'mac-air', platform: 'darwin' });

    const firstPush = await pushWorkspaceDeliverables({
      dshHome: winHome,
      vault: winVault,
      workspaceId: 'ws-containers',
      workspaceRoot: winWs,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });
    assert.equal(firstPush.published, true);
    const goodXlsxSha = sha256Hex(goodXlsx);
    const goodPdfSha = sha256Hex(goodPdf);

    // Now corrupt/half-write model.xlsx, memo.pdf, plus add torn .png and .parquet, plus a fresh valid .txt
    await fs.writeFile(path.join(winWs, 'outputs', 'model.xlsx'), makeTornZipBuffer('half-written-v2'));
    await fs.writeFile(path.join(winWs, 'outputs', 'memo.pdf'), makeTornPdfBuffer('half-written-pdf'));
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'chart.png'), makeTornPngBuffer());
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'table.parquet'), makeTornParquetBuffer());
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'summary.txt'), 'clean note v2\n');

    const secondPush = await pushWorkspaceDeliverables({
      dshHome: winHome,
      vault: winVault,
      workspaceId: 'ws-containers',
      workspaceRoot: winWs,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });

    const deferredByPath = new Map(secondPush.deferred.map((d) => [d.path, d]));
    assert.equal(deferredByPath.get('outputs/model.xlsx')?.reason, 'torn-container');
    assert.equal(deferredByPath.get('outputs/model.xlsx')?.retryable, true);
    assert.equal(deferredByPath.get('outputs/memo.pdf')?.reason, 'torn-container');
    assert.equal(deferredByPath.get('outputs/chart.png')?.reason, 'torn-container');
    assert.equal(deferredByPath.get('outputs/table.parquet')?.reason, 'torn-container');

    // Intact previous versions must be preserved in tree (not overwritten and not deleted!)
    assert.equal(secondPush.tree['outputs/model.xlsx'].sha256, goodXlsxSha);
    assert.equal(secondPush.tree['outputs/model.xlsx'].deleted, undefined);
    assert.equal(secondPush.tree['outputs/memo.pdf'].sha256, goodPdfSha);
    assert.equal(secondPush.tree['outputs/chart.png'], undefined);
    assert.equal(secondPush.tree['outputs/table.parquet'], undefined);
    assert.ok(secondPush.tree['outputs/summary.txt']);

    // Peer pulling from vault gets the intact v1 model.xlsx and memo.pdf
    const macPull = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-containers',
      workspaceRoot: macWs,
    });
    assert.equal(macPull.status, 'synced');
    const pulledXlsx = await fs.readFile(path.join(macWs, 'outputs', 'model.xlsx'));
    assert.deepEqual(pulledXlsx, goodXlsx);

    // Direct worker inspection: valid parquet + stability guard + maxFileBytes
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'good.parquet'), makeValidParquetBuffer('ok-rows'));
    const okParquet = await inspectWorkspaceFile({
      workspaceRoot: winWs,
      relativePath: 'outputs/good.parquet',
      minQuietMs: 0,
    });
    assert.equal(okParquet.ok, true);

    const stillChanging = await inspectWorkspaceFile({
      workspaceRoot: winWs,
      relativePath: 'outputs/good.parquet',
      minQuietMs: 60_000,
    });
    assert.equal(stillChanging.ok, false);
    assert.equal(stillChanging.reason, 'file-still-changing');
    assert.equal(stillChanging.retryable, true);

    const tooBig = await inspectWorkspaceFile({
      workspaceRoot: winWs,
      relativePath: 'outputs/good.parquet',
      maxFileBytes: 4,
      minQuietMs: 0,
    });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.reason, 'exceeds-max-file-bytes');
  });
});

test.describe('deliverable-plane: security guard (secrets, blacklist, symlink/junction, hardlink, cross-OS names)', () => {
  test('blocks .env, credentials, hardcoded sk- keys, escaping junction/symlink, hardlinks, and illegal filenames', async () => {
    const baseDir = path.join(TEST_TMP_ROOT, 'case3-security');
    const dshHome = path.join(baseDir, 'dsh-home');
    const vaultDir = path.join(baseDir, 'vault');
    const wsRoot = path.join(baseDir, 'workspace');
    const outsideDir = path.join(baseDir, 'outside-secret-dir');
    await fs.mkdir(path.join(wsRoot, 'outputs'), { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    // Sensitive files
    await writeFileEnsuringDir(path.join(wsRoot, 'outputs', '.env'), 'OPENAI_API_KEY=plain\n');
    await writeFileEnsuringDir(path.join(wsRoot, 'outputs', '.env.example'), 'OPENAI_API_KEY=replace-me\n');
    await writeFileEnsuringDir(path.join(wsRoot, 'outputs', 'db_credentials.json'), '{"user":"root"}\n');
    await writeFileEnsuringDir(
      path.join(wsRoot, 'outputs', 'config.py'),
      'API_KEY = "sk-proj-1234567890abcdefghijklmnop"\n',
    );
    await writeFileEnsuringDir(path.join(wsRoot, 'outputs', 'server.pem'), 'cert-bytes');

    // Outside directory escape via Windows Junction (or dir symlink on POSIX)
    await writeFileEnsuringDir(path.join(outsideDir, 'stolen.txt'), 'top-secret-outside-workspace');
    const junctionPath = path.join(wsRoot, 'outputs', 'escape-link');
    await fs.symlink(outsideDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
    await recordDeliverableCandidate(dshHome, 'ws-sec', wsRoot, 'outputs/escape-link/stolen.txt', 'manual');

    // Hardlink theft attempt (nlink > 1)
    const outsideTarget = path.join(outsideDir, 'hardlink-source.txt');
    await writeFileEnsuringDir(outsideTarget, 'hardlinked-external-data');
    const hardlinkInWs = path.join(wsRoot, 'outputs', 'hardlinked.txt');
    await fs.link(outsideTarget, hardlinkInWs);

    // Illegal cross-OS filenames (recorded directly since NTFS rejects ':'/'?' on disk)
    await recordDeliverableCandidate(dshHome, 'ws-sec', wsRoot, 'bad:name?.xlsx', 'manual');
    await recordDeliverableCandidate(dshHome, 'ws-sec', wsRoot, 'outputs/aux.py', 'manual');

    const vault = new VaultStore({ vaultDir, deviceId: 'win-office', platform: 'win32' });
    const res = await pushWorkspaceDeliverables({
      dshHome,
      vault,
      workspaceId: 'ws-sec',
      workspaceRoot: wsRoot,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });

    const blockedMap = new Map(res.blocked.map((b) => [b.path, b]));
    assert.ok(blockedMap.has('outputs/.env'), '.env must be blocked');
    assert.ok(blockedMap.has('outputs/db_credentials.json'), 'db_credentials.json must be blocked');
    assert.ok(blockedMap.has('outputs/server.pem'), '*.pem must be blocked');
    assert.equal(blockedMap.get('outputs/config.py')?.reason, 'secret-detected');
    assert.equal(blockedMap.get('outputs/escape-link/stolen.txt')?.reason, 'symlink-escaped');
    assert.equal(blockedMap.get('outputs/hardlinked.txt')?.reason, 'hardlink-rejected');
    assert.equal(blockedMap.get('bad:name?.xlsx')?.reason, 'illegal-cross-os-filename');
    assert.equal(blockedMap.get('outputs/aux.py')?.reason, 'illegal-cross-os-filename');

    // Only .env.example should pass into tree
    assert.deepEqual(Object.keys(res.tree), ['outputs/.env.example']);
  });
});

test.describe('deliverable-plane: Office lock detection & .dsh-incoming staging + auto-drain', () => {
  test('stages incoming Excel update to .dsh-incoming while ~$ lock exists, then auto-applies once unlocked', async () => {
    const baseDir = path.join(TEST_TMP_ROOT, 'case4-office-lock');
    const winHome = path.join(baseDir, 'win-home');
    const macHome = path.join(baseDir, 'mac-home');
    const vaultDir = path.join(baseDir, 'vault');
    const winWs = path.join(baseDir, 'win-ws');
    const macWs = path.join(baseDir, 'mac-ws');
    await fs.mkdir(winWs, { recursive: true });
    await fs.mkdir(macWs, { recursive: true });

    const winVault = new VaultStore({ vaultDir, deviceId: 'win-office', platform: 'win32' });
    const macVault = new VaultStore({ vaultDir, deviceId: 'mac-air', platform: 'darwin' });

    const v1 = makeValidZipBuffer('report-v1');
    const v2 = makeValidZipBuffer('report-v2-updated');

    // v1 pushed by Win and pulled cleanly by Mac
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'report.xlsx'), v1);
    await pushWorkspaceDeliverables({
      dshHome: winHome,
      vault: winVault,
      workspaceId: 'ws-lock',
      workspaceRoot: winWs,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });
    const macPull1 = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-lock',
      workspaceRoot: macWs,
    });
    assert.equal(macPull1.status, 'synced');
    assert.deepEqual(await fs.readFile(path.join(macWs, 'outputs', 'report.xlsx')), v1);

    // Win pushes v2
    await fs.writeFile(path.join(winWs, 'outputs', 'report.xlsx'), v2);
    await pushWorkspaceDeliverables({
      dshHome: winHome,
      vault: winVault,
      workspaceId: 'ws-lock',
      workspaceRoot: winWs,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });

    // Simulate Excel holding outputs/report.xlsx open on Mac via ~$report.xlsx lock file
    const lockFile = path.join(macWs, 'outputs', '~$report.xlsx');
    await fs.writeFile(lockFile, 'excel-lock-marker');

    const detectedLocks = await detectOpenOfficeLocks(macWs, ['outputs/report.xlsx']);
    assert.equal(detectedLocks.length, 1);
    assert.equal(detectedLocks[0].targetPath, 'outputs/report.xlsx');

    // Pull on Mac must stage into .dsh-incoming/outputs/report.xlsx without clobbering v1
    const macPullLocked = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-lock',
      workspaceRoot: macWs,
    });
    assert.equal(macPullLocked.stagedIncoming.length, 1);
    assert.equal(macPullLocked.stagedIncoming[0].path, 'outputs/report.xlsx');
    assert.deepEqual(await fs.readFile(path.join(macWs, 'outputs', 'report.xlsx')), v1);
    assert.deepEqual(await fs.readFile(path.join(macWs, '.dsh-incoming', 'outputs', 'report.xlsx')), v2);

    // User closes Excel -> lock disappears -> next pull automatically drains .dsh-incoming into place
    await fs.rm(lockFile, { force: true });
    const macPullUnlocked = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-lock',
      workspaceRoot: macWs,
    });
    assert.ok(macPullUnlocked.drainedIncoming.includes('outputs/report.xlsx'));
    assert.deepEqual(await fs.readFile(path.join(macWs, 'outputs', 'report.xlsx')), v2);
    await assert.rejects(fs.stat(path.join(macWs, '.dsh-incoming', 'outputs', 'report.xlsx')));
  });

  test('drainIncomingFiles preserves local edits made while Excel locked and writes conflict copy instead of overwriting', async () => {
    const baseDir = path.join(TEST_TMP_ROOT, 'case4b-drain-conflict');
    const winHome = path.join(baseDir, 'win-home');
    const macHome = path.join(baseDir, 'mac-home');
    const vaultDir = path.join(baseDir, 'vault');
    const winWs = path.join(baseDir, 'win-ws');
    const macWs = path.join(baseDir, 'mac-ws');
    await fs.mkdir(winWs, { recursive: true });
    await fs.mkdir(macWs, { recursive: true });

    const winVault = new VaultStore({ vaultDir, deviceId: 'win-office', platform: 'win32' });
    const macVault = new VaultStore({ vaultDir, deviceId: 'mac-air', platform: 'darwin' });

    const v1 = makeValidZipBuffer('model-base-v1');
    const v2Remote = makeValidZipBuffer('model-remote-v2');
    const vLocalEdit = makeValidZipBuffer('model-local-user-saved-while-locked');

    // Step 1: Win pushes v1 -> Mac pulls v1 cleanly (establishes baseTree)
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'model.xlsx'), v1);
    await pushWorkspaceDeliverables({
      dshHome: winHome,
      vault: winVault,
      workspaceId: 'ws-drain-conflict',
      workspaceRoot: winWs,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });
    const macPull1 = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-drain-conflict',
      workspaceRoot: macWs,
    });
    assert.equal(macPull1.status, 'synced');
    assert.deepEqual(await fs.readFile(path.join(macWs, 'outputs', 'model.xlsx')), v1);

    // Step 2: Mac opens outputs/model.xlsx in Excel (~$model.xlsx lock present)
    const lockPath = path.join(macWs, 'outputs', '~$model.xlsx');
    await writeFileEnsuringDir(lockPath, 'excel-lock');

    // Step 3: Win updates outputs/model.xlsx to v2Remote and pushes
    await fs.writeFile(path.join(winWs, 'outputs', 'model.xlsx'), v2Remote);
    await pushWorkspaceDeliverables({
      dshHome: winHome,
      vault: winVault,
      workspaceId: 'ws-drain-conflict',
      workspaceRoot: winWs,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });

    // Step 4: Mac pulls while locked -> v2Remote staged in .dsh-incoming/outputs/model.xlsx
    const macPullLocked = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-drain-conflict',
      workspaceRoot: macWs,
    });
    assert.equal(macPullLocked.stagedIncoming.length, 1);
    assert.deepEqual(
      await fs.readFile(path.join(macWs, '.dsh-incoming', 'outputs', 'model.xlsx')),
      v2Remote,
    );

    // Step 5: User edits & saves local outputs/model.xlsx while Excel is open, then closes Excel (removes ~$ lock)
    await fs.writeFile(path.join(macWs, 'outputs', 'model.xlsx'), vLocalEdit);
    await fs.rm(lockPath, { force: true });

    // Step 6: Mac pulls after unlock -> MUST preserve vLocalEdit, write v2Remote as conflict copy, and clear .dsh-incoming/
    const macPullUnlocked = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-drain-conflict',
      workspaceRoot: macWs,
    });
    assert.deepEqual(
      await fs.readFile(path.join(macWs, 'outputs', 'model.xlsx')),
      vLocalEdit,
      'local Excel edits saved while locked must NEVER be overwritten by drainIncomingFiles',
    );
    const conflict = macPullUnlocked.conflicts.find((c) => c.path === 'outputs/model.xlsx');
    assert.ok(conflict, 'must report a conflict copy when draining staged file over modified local file');
    assert.equal(conflict.kind, 'both-modified');
    assert.match(conflict.conflictPath, /^outputs\/model \(来自win-office \d{8}-\d{4}\)\.xlsx$/);
    assert.deepEqual(
      await fs.readFile(path.join(macWs, ...conflict.conflictPath.split('/'))),
      v2Remote,
    );
    await assert.rejects(fs.stat(path.join(macWs, '.dsh-incoming', 'outputs', 'model.xlsx')));
    const stateAfter = await loadWorkspaceDeliverableState(macHome, 'ws-drain-conflict');
    assert.deepEqual(stateAfter.pendingIncoming, {});
    assert.equal(stateAfter.baseTree['outputs/model.xlsx']?.sha256, sha256Hex(v2Remote));

    // Step 7: Subsequent pull is idempotent (no duplicate conflict copies)
    const macPullAgain = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-drain-conflict',
      workspaceRoot: macWs,
    });
    assert.equal(macPullAgain.conflicts.length, 0);
  });
});

test.describe('deliverable-plane: 3-way merge conflicts, idempotency, soft-delete trash & encrypted vault', () => {
  test('creates idempotent conflict copy on dual modification, soft-deletes to ~/.dsh/trash/, and preserves modify-delete local edits', async () => {
    const baseDir = path.join(TEST_TMP_ROOT, 'case5-3way-merge');
    const winHome = path.join(baseDir, 'win-home');
    const macHome = path.join(baseDir, 'mac-home');
    const vaultDir = path.join(baseDir, 'vault');
    const winWs = path.join(baseDir, 'win-ws');
    const macWs = path.join(baseDir, 'mac-ws');
    await fs.mkdir(winWs, { recursive: true });
    await fs.mkdir(macWs, { recursive: true });

    // Use AES-256-GCM encrypted VaultStore to prove end-to-end encrypted deliverable sync
    const winKeys = await savePassphraseKey(winHome, 'deliverable-e2ee-pass');
    const macKeys = await savePassphraseKey(macHome, 'deliverable-e2ee-pass');
    const winVault = new VaultStore({ vaultDir, deviceId: 'win-office', platform: 'win32', secretKeys: winKeys });
    const macVault = new VaultStore({ vaultDir, deviceId: 'mac-air', platform: 'darwin', secretKeys: macKeys });

    const valBase = makeValidZipBuffer('valuation-base-v1');
    const valWin = makeValidZipBuffer('valuation-win-offline-edit');
    const valMac = makeValidZipBuffer('valuation-mac-offline-edit');

    // Base state pushed by Win
    await writeFileEnsuringDir(path.join(winWs, 'outputs', '估值表.xlsx'), valBase);
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'obsolete.txt'), 'delete-me-cleanly\n');
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'keep_modified.txt'), 'original-content\n');

    await pushWorkspaceDeliverables({
      dshHome: winHome,
      vault: winVault,
      workspaceId: 'ws-merge',
      workspaceRoot: winWs,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });

    // Mac pulls base state
    const macBasePull = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-merge',
      workspaceRoot: macWs,
    });
    assert.equal(macBasePull.status, 'synced');

    // Plant an expired (>14 days old) trash folder on Mac to verify retention cleanup
    const expiredTs = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const expiredTrashFile = path.join(macHome, 'trash', encodeURIComponent('ws-merge'), String(expiredTs), 'old.txt');
    await writeFileEnsuringDir(expiredTrashFile, 'expired-trash-item');

    // Concurrent offline edits on Win: modify 估值表.xlsx, delete obsolete.txt and keep_modified.txt
    await fs.writeFile(path.join(winWs, 'outputs', '估值表.xlsx'), valWin);
    await fs.rm(path.join(winWs, 'outputs', 'obsolete.txt'));
    await fs.rm(path.join(winWs, 'outputs', 'keep_modified.txt'));

    const winPush2 = await pushWorkspaceDeliverables({
      dshHome: winHome,
      vault: winVault,
      workspaceId: 'ws-merge',
      workspaceRoot: winWs,
      deviceLabel: 'win-office',
      minQuietMs: 0,
    });
    assert.equal(winPush2.published, true);
    assert.equal(winPush2.tree['outputs/obsolete.txt'].deleted, true);
    assert.equal(winPush2.tree['outputs/keep_modified.txt'].deleted, true);

    // Concurrent offline edits on Mac: modify 估值表.xlsx AND modify keep_modified.txt (leave obsolete.txt untouched)
    await fs.writeFile(path.join(macWs, 'outputs', '估值表.xlsx'), valMac);
    await fs.writeFile(path.join(macWs, 'outputs', 'keep_modified.txt'), 'mac-important-local-edit\n');

    // Mac pulls -> 3-way merge
    const macMerge = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-merge',
      workspaceRoot: macWs,
      trashRetentionDays: 14,
    });

    // 1) Dual-modified 估值表.xlsx: Mac local untouched, remote written as conflict copy
    assert.deepEqual(await fs.readFile(path.join(macWs, 'outputs', '估值表.xlsx')), valMac);
    const bothModConflict = macMerge.conflicts.find((c) => c.path === 'outputs/估值表.xlsx');
    assert.ok(bothModConflict, 'must report both-modified conflict for 估值表.xlsx');
    assert.match(bothModConflict.conflictPath, /^outputs\/估值表 \(来自win-office \d{8}-\d{4}\)\.xlsx$/);
    const conflictCopyBytes = await fs.readFile(path.join(macWs, ...bothModConflict.conflictPath.split('/')));
    assert.deepEqual(conflictCopyBytes, valWin);

    // 2) Remote clean delete of obsolete.txt: moved to <macHome>/trash/<wsId>/<ts>/outputs/obsolete.txt (NOT hard-deleted)
    await assert.rejects(fs.stat(path.join(macWs, 'outputs', 'obsolete.txt')));
    assert.equal(macMerge.trashed.length, 1);
    assert.equal(macMerge.trashed[0].path, 'outputs/obsolete.txt');
    assert.equal(await fs.readFile(macMerge.trashed[0].trashPath, 'utf8'), 'delete-me-cleanly\n');
    // Expired 20-day-old trash should be pruned
    await assert.rejects(fs.stat(path.dirname(expiredTrashFile)));

    // 3) Modify-delete conflict on keep_modified.txt: Mac local edit preserved
    assert.equal(await fs.readFile(path.join(macWs, 'outputs', 'keep_modified.txt'), 'utf8'), 'mac-important-local-edit\n');
    const modDelConflict = macMerge.conflicts.find((c) => c.path === 'outputs/keep_modified.txt');
    assert.ok(modDelConflict, 'must report modify-delete conflict');

    // 4) Second pull is 100% idempotent — NO duplicate conflict copy generated
    const outputsBefore = (await fs.readdir(path.join(macWs, 'outputs'))).sort();
    const macPullAgain = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-merge',
      workspaceRoot: macWs,
    });
    assert.equal(macPullAgain.conflicts.length, 0);
    const outputsAfter = (await fs.readdir(path.join(macWs, 'outputs'))).sort();
    assert.deepEqual(outputsAfter, outputsBefore);
  });

  test('enforces maxWorkspaceBytes quota, handles pending-hydration safely, and blocks pull symlink escape', async () => {
    const baseDir = path.join(TEST_TMP_ROOT, 'case6-quotas-hydration-escape');
    const winHome = path.join(baseDir, 'win-home');
    const macHome = path.join(baseDir, 'mac-home');
    const vaultDir = path.join(baseDir, 'vault');
    const winWs = path.join(baseDir, 'win-ws');
    const macWs = path.join(baseDir, 'mac-ws');
    const outsideDir = path.join(baseDir, 'outside');
    await fs.mkdir(winWs, { recursive: true });
    await fs.mkdir(macWs, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    const winVault = new VaultStore({ vaultDir, deviceId: 'win-office', platform: 'win32' });
    const macVault = new VaultStore({ vaultDir, deviceId: 'mac-air', platform: 'darwin' });

    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'a_small.txt'), 'x'.repeat(60));
    await writeFileEnsuringDir(path.join(winWs, 'outputs', 'b_overflow.txt'), 'y'.repeat(60));

    const pushQuota = await pushWorkspaceDeliverables({
      dshHome: winHome,
      vault: winVault,
      workspaceId: 'ws-quota',
      workspaceRoot: winWs,
      deviceLabel: 'win-office',
      minQuietMs: 0,
      quotas: { maxWorkspaceBytes: 100 },
    });

    assert.equal(pushQuota.published, true);
    assert.ok(pushQuota.tree['outputs/a_small.txt']);
    assert.equal(pushQuota.tree['outputs/b_overflow.txt'], undefined);
    assert.equal(
      pushQuota.blocked.find((b) => b.path === 'outputs/b_overflow.txt')?.reason,
      'exceeds-max-workspace-bytes',
    );

    // Simulate iCloud unhydrated placeholder for a_small.txt blob -> pull must return pending-hydration
    const storageKey = pushQuota.tree['outputs/a_small.txt'].storageKey;
    const blobDir = path.join(vaultDir, 'blobs', 'sha256', storageKey.slice(0, 2));
    const icloudStub = path.join(blobDir, `.${storageKey}.icloud`);
    await fs.writeFile(icloudStub, 'evicted');

    const pendingPull = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-quota',
      workspaceRoot: macWs,
    });
    assert.equal(pendingPull.status, 'pending-hydration');
    await assert.rejects(fs.stat(path.join(macWs, 'outputs', 'a_small.txt')));

    // Hydrate blob (remove .icloud placeholder), but plant an escaping junction at macWs/outputs
    await fs.rm(icloudStub, { force: true });
    await fs.symlink(outsideDir, path.join(macWs, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir');

    const blockedPull = await pullWorkspaceDeliverables({
      dshHome: macHome,
      vault: macVault,
      workspaceId: 'ws-quota',
      workspaceRoot: macWs,
    });
    assert.equal(
      blockedPull.blocked.find((b) => b.path === 'outputs/a_small.txt')?.reason,
      'symlink-escaped',
    );
    await assert.rejects(fs.stat(path.join(outsideDir, 'a_small.txt')));
  });
});
