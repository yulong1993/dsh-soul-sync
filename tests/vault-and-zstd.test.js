import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_QUOTAS,
  GLOBAL_AGENTS_RULES_MARKER,
  writeFileAtomic,
  resolveDshHome,
  soulSyncDir,
  loadConfig,
  saveConfig,
  savePassphraseKey,
  loadPassphraseKey,
  mapPathAcrossOs,
  canonicalizeLocalPath,
  ensureGlobalAgentsRules,
} from '../lib/config.js';

import {
  encodeSegment,
  projectKey,
  scanZstdFrames,
  compressZstdFrame,
  encodeV4SessionLog,
  decodeV4SessionLog,
} from '../lib/zstd-v4.js';

import {
  VaultStore,
  VaultHydrationPendingError,
  VaultIntegrityError,
} from '../lib/crypto-vault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_ROOT = path.join(REPO_ROOT, '.test-tmp', `vault-and-zstd-${process.pid}-${Date.now()}`);

test.before(async () => {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
});

test.after(async () => {
  await fs.rm(TEST_TMP_ROOT, { recursive: true, force: true });
});

test.describe('zstd-v4: encodeSegment & projectKey exact DSH parity', () => {
  test('encodeSegment matches DSH UTF-16 escaping and dot traversal guards', () => {
    assert.throws(() => encodeSegment(''), /empty/i);
    assert.equal(encodeSegment('.'), '~002E');
    assert.equal(encodeSegment('..'), '~002E~002E');
    assert.equal(encodeSegment('abc-123_45.6'), 'abc-123_45.6');
    assert.equal(encodeSegment('a~b/c\\d'), 'a~007Eb~002Fc~005Cd');
    assert.equal(encodeSegment('文章'), '~6587~7AE0');
  });

  test('projectKey matches DSH exact format for Windows CJK and macOS paths', () => {
    assert.throws(() => projectKey(''), /empty/i);
    assert.equal(projectKey('D:\\文章'), '--D-~6587~7AE0--');
    assert.equal(projectKey('/Users/alex/美股分析'), '--Users-alex-~7F8E~80A1~5206~6790--');
    assert.equal(projectKey('C:\\\\Users///a'), '--C-Users-a--');
    assert.equal(projectKey('/'), '--root--');
  });
});

test.describe('zstd-v4: V4 multi-frame codec, checksum invariant & torn-tail recovery', () => {
  const sampleHeader = {
    type: 'session',
    version: 4,
    id: 'sess-001',
    createdAt: 1732400000000,
    cwd: 'D:\\文章',
    isSeeded: false,
    delegationDepth: 0,
  };

  test('Frame 0 contains ONLY single-line header with ZSTD checksum bit enabled and roundtrips', async () => {
    const events = [
      { seq: 0, type: 'user/message', data: { text: '分析一下 NVDA 估值模型' } },
      { seq: 1, type: 'assistant/message', data: { text: '好的，先看自由现金流折现假设。' } },
      { seq: 2, type: 'turn/end', data: { turn: 1 } },
      { seq: 3, type: 'user/message', data: { text: '加上敏感性分析表格' } },
      { seq: 4, type: 'turn/end', data: { turn: 2 } },
    ];

    const encoded = await encodeV4SessionLog(sampleHeader, events, 2);
    const scan = scanZstdFrames(encoded);

    assert.equal(scan.tornStart, undefined);
    assert.equal(scan.frames.length, 4); // 1 header frame + ceil(5/2)=3 event frames
    for (const frame of scan.frames) {
      assert.equal(frame.hasChecksum, true);
      // Verify Zstd frame header descriptor bit 2 (content checksum flag = 0x04)
      const descriptor = encoded.readUInt8(frame.start + 4);
      assert.notEqual(descriptor & 4, 0, 'ZSTD_c_checksumFlag bit must be set on every frame');
    }

    // Verify Frame 0 decompressed independently is strictly header + "\n"
    const frame0Plain = zlib.zstdDecompressSync(encoded.subarray(scan.frames[0].start, scan.frames[0].end));
    assert.equal(frame0Plain.toString('utf8'), `${JSON.stringify(sampleHeader)}\n`);

    const decoded = await decodeV4SessionLog(encoded);
    assert.deepEqual(decoded.header, sampleHeader);
    assert.deepEqual(decoded.events, events);
    assert.equal(decoded.frameCount, 4);
    assert.equal(decoded.hasAllChecksums, true);
    assert.equal(decoded.recoveredTornTail, false);
  });

  test('recovers prior frames and complete JSONL lines from a truncated final Zstd frame', async () => {
    const headerFrame = await compressZstdFrame(Buffer.from(`${JSON.stringify(sampleHeader)}\n`, 'utf8'));
    const earlyEvents = [
      { seq: 0, type: 'user/message', data: { text: '第一轮完整保存' } },
      { seq: 1, type: 'turn/end', data: { turn: 1 } },
    ];
    const frame1 = await compressZstdFrame(
      Buffer.from(earlyEvents.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8'),
    );

    // Create a large multi-block final frame (>128KB compressed) so truncating at 60%
    // leaves Block 1 intact and Block 2 torn, exercising real ZSTD_e_flush line salvage.
    const bigTailEvents = [];
    for (let i = 0; i < 200; i++) {
      bigTailEvents.push({
        seq: 2 + i,
        type: 'assistant/message',
        data: {
          idx: i,
          payload: crypto.randomBytes(800).toString('hex'),
        },
      });
    }
    const fullTailFrame = await compressZstdFrame(
      Buffer.from(bigTailEvents.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8'),
    );

    // Truncate the tail frame roughly halfway (cuts off checksum + final block)
    const truncatedTail = fullTailFrame.subarray(0, Math.floor(fullTailFrame.length * 0.6));
    const tornBuffer = Buffer.concat([headerFrame, frame1, truncatedTail]);

    const scan = scanZstdFrames(tornBuffer);
    assert.equal(scan.frames.length, 2);
    assert.equal(scan.tornStart, headerFrame.length + frame1.length);

    const decoded = await decodeV4SessionLog(tornBuffer);
    assert.deepEqual(decoded.header, sampleHeader);
    assert.equal(decoded.recoveredTornTail, true);
    assert.equal(decoded.frameCount, 2);
    // Must contain all early events AND rescued complete lines from Block 1 of the torn tail frame,
    // while cleanly dropping the final incomplete line.
    assert.ok(
      decoded.events.length > earlyEvents.length && decoded.events.length < earlyEvents.length + bigTailEvents.length,
      `expected partial salvage between ${earlyEvents.length + 1} and ${earlyEvents.length + bigTailEvents.length - 1}, got ${decoded.events.length}`,
    );
    assert.deepEqual(decoded.events.slice(0, 2), earlyEvents);
    for (let i = 2; i < decoded.events.length; i++) {
      assert.deepEqual(decoded.events[i], bigTailEvents[i - 2]);
    }
  });

  test('handles tiny torn garbage suffix (<4 bytes) after valid frames without throwing', async () => {
    const events = [{ seq: 0, type: 'user/message', data: { text: 'ok' } }];
    const valid = await encodeV4SessionLog(sampleHeader, events);
    const withTinyTorn = Buffer.concat([valid, Buffer.from([0x28, 0xb5])]);

    const scan = scanZstdFrames(withTinyTorn);
    assert.equal(scan.frames.length, 2);
    assert.equal(scan.tornStart, valid.length);

    const decoded = await decodeV4SessionLog(withTinyTorn);
    assert.deepEqual(decoded.header, sampleHeader);
    assert.deepEqual(decoded.events, events);
    assert.equal(decoded.recoveredTornTail, true);
  });

  test('detects bit-flip corruption inside a complete checksummed frame', async () => {
    const events = [{ seq: 0, type: 'user/message', data: { text: 'important valuation 12345' } }];
    const valid = await encodeV4SessionLog(sampleHeader, events);
    const corrupted = Buffer.from(valid);
    // Flip a bit in the final byte (the 4-byte checksum of frame 1)
    corrupted[corrupted.length - 1] ^= 0x01;

    await assert.rejects(() => decodeV4SessionLog(corrupted), /checksum|corrupt|zstd/i);
  });
});

test.describe('config: atomic writes, passphrase keys, cross-OS mapping & AGENTS.md', () => {
  test('DEFAULT_QUOTAS matches locked product defaults', () => {
    assert.equal(DEFAULT_QUOTAS.maxFileBytes, 30 * 1024 * 1024);
    assert.equal(DEFAULT_QUOTAS.maxWorkspaceBytes, 500 * 1024 * 1024);
    assert.equal(DEFAULT_QUOTAS.retainSnapshots, 10);
    assert.equal(DEFAULT_QUOTAS.stepSyncIntervalMs, 30000);
    assert.equal(DEFAULT_QUOTAS.trashRetentionDays, 14);
  });

  test('writeFileAtomic writes cleanly without leaving .tmp artifacts', async () => {
    const dir = path.join(TEST_TMP_ROOT, 'atomic-test');
    const target = path.join(dir, 'nested', 'state.json');
    await writeFileAtomic(target, '{"ok":true}\n');
    const content = await fs.readFile(target, 'utf8');
    assert.equal(content, '{"ok":true}\n');

    const entries = await fs.readdir(path.dirname(target));
    assert.deepEqual(entries, ['state.json']);
  });

  test('loadConfig and saveConfig persist config.json and merge quotas cleanly', async () => {
    const dshHome = path.join(TEST_TMP_ROOT, 'dsh-home-cfg');
    assert.equal(resolveDshHome(dshHome), path.resolve(dshHome));
    assert.equal(soulSyncDir(dshHome), path.join(path.resolve(dshHome), 'soul-sync'));

    const initial = await loadConfig(dshHome);
    assert.equal(initial.version, 1);
    assert.deepEqual(initial.quotas, DEFAULT_QUOTAS);

    const saved = await saveConfig(dshHome, {
      deviceId: 'win-office',
      deviceLabel: 'Windows 办公机',
      vaultDir: 'D:\\OneDrive\\dsh-vault',
      encryptionEnabled: true,
      workspaceMappings: [
        { id: 'us-equity', title: '美股分析', win32: 'D:\\美股分析', darwin: '/Users/alex/美股分析' },
      ],
      quotas: { retainSnapshots: 20 },
    });

    assert.equal(saved.deviceId, 'win-office');
    assert.equal(saved.quotas.retainSnapshots, 20);
    assert.equal(saved.quotas.maxFileBytes, DEFAULT_QUOTAS.maxFileBytes);

    const reloaded = await loadConfig(dshHome);
    assert.deepEqual(reloaded, saved);
  });

  test('savePassphraseKey / loadPassphraseKey derives matching 32-byte keys locally and supports clearing', async () => {
    const winHome = path.join(TEST_TMP_ROOT, 'dsh-home-win');
    const macHome = path.join(TEST_TMP_ROOT, 'dsh-home-mac');

    assert.equal(await loadPassphraseKey(winHome), null);

    const winKeys = await savePassphraseKey(winHome, 'my-strong-soul-passphrase');
    const macKeys = await savePassphraseKey(macHome, 'my-strong-soul-passphrase');

    assert.equal(winKeys.encKey.length, 32);
    assert.equal(winKeys.hmacKey.length, 32);
    assert.equal(winKeys.encKeyHex, macKeys.encKeyHex);
    assert.equal(winKeys.hmacKeyHex, macKeys.hmacKeyHex);

    const loaded = await loadPassphraseKey(winHome);
    assert.equal(loaded.encKeyHex, winKeys.encKeyHex);
    assert.equal(loaded.hmacKeyHex, winKeys.hmacKeyHex);
    assert.ok(Buffer.isBuffer(loaded.encKey));
    assert.ok(Buffer.isBuffer(loaded.hmacKey));

    // Verify stored JSON format inside local soul-sync/secret.key
    const rawKeyJson = JSON.parse(await fs.readFile(path.join(winHome, 'soul-sync', 'secret.key'), 'utf8'));
    assert.equal(typeof rawKeyJson.saltHex, 'string');
    assert.equal(rawKeyJson.encKeyHex, winKeys.encKeyHex);
    assert.equal(rawKeyJson.hmacKeyHex, winKeys.hmacKeyHex);

    // Clearing with empty passphrase removes secret.key (plaintext mode)
    const cleared = await savePassphraseKey(winHome, '');
    assert.equal(cleared, null);
    assert.equal(await loadPassphraseKey(winHome), null);
  });

  test('mapPathAcrossOs performs case-insensitive Win <-> NFC Mac bidirectional mapping', () => {
    const mappings = [
      {
        id: 'us-stocks',
        title: '美股分析',
        win32: 'D:\\美股分析',
        darwin: '/Users/alex/美股分析',
        linux: '/home/alex/美股分析',
      },
      {
        id: 'cafe-notes',
        title: 'Café Notes',
        win32: 'D:\\caf\u00e9',
        darwin: '/Users/alex/caf\u00e9',
      },
    ];

    // Win (lowercase drive) -> Mac
    const toMac = mapPathAcrossOs('d:\\美股分析\\scripts\\dcf.py', mappings, 'darwin');
    assert.deepEqual(toMac, {
      mappedPath: '/Users/alex/美股分析/scripts/dcf.py',
      workspaceId: 'us-stocks',
      relativePosixPath: 'scripts/dcf.py',
      matched: true,
    });

    // Mac -> Win
    const toWin = mapPathAcrossOs('/Users/alex/美股分析/scripts/dcf.py', mappings, 'win32');
    assert.deepEqual(toWin, {
      mappedPath: 'D:\\美股分析\\scripts\\dcf.py',
      workspaceId: 'us-stocks',
      relativePosixPath: 'scripts/dcf.py',
      matched: true,
    });

    // Exact workspace root
    const rootToMac = mapPathAcrossOs('D:\\美股分析\\', mappings, 'darwin');
    assert.deepEqual(rootToMac, {
      mappedPath: '/Users/alex/美股分析',
      workspaceId: 'us-stocks',
      relativePosixPath: '',
      matched: true,
    });

    // macOS NFD decomposed path -> NFC Windows path
    const nfdToWin = mapPathAcrossOs('/Users/alex/cafe\u0301/re\u0301sume\u0301.md', mappings, 'win32');
    assert.equal(nfdToWin.matched, true);
    assert.equal(nfdToWin.workspaceId, 'cafe-notes');
    assert.equal(nfdToWin.mappedPath, 'D:\\caf\u00e9\\r\u00e9sum\u00e9.md'.normalize('NFC'));
    assert.equal(nfdToWin.relativePosixPath, 'r\u00e9sum\u00e9.md'.normalize('NFC'));

    // Prefix boundary guard: D:\美股分析2 must NOT match D:\美股分析
    const sibling = mapPathAcrossOs('D:\\美股分析2\\other.py', mappings, 'darwin');
    assert.equal(sibling.matched, false);
    assert.equal(sibling.workspaceId, null);
  });

  test('canonicalizeLocalPath resolves existing and non-existent leaf paths with NFC', async () => {
    const baseDir = path.join(TEST_TMP_ROOT, 'canon-dir');
    await fs.mkdir(baseDir, { recursive: true });

    const existing = await canonicalizeLocalPath(baseDir);
    assert.equal(existing, (await fs.realpath(baseDir)).normalize('NFC'));

    const futureLeaf = path.join(baseDir, 'sub', 'cafe\u0301.xlsx');
    const canonicalLeaf = await canonicalizeLocalPath(futureLeaf);
    assert.equal(
      canonicalLeaf,
      path.join((await fs.realpath(baseDir)), 'sub', 'caf\u00e9.xlsx').normalize('NFC'),
    );
  });

  test('ensureGlobalAgentsRules idempotently appends 5 cross-OS rules without clobbering existing content', async () => {
    const dshHome = path.join(TEST_TMP_ROOT, 'dsh-home-agents');
    await fs.mkdir(dshHome, { recursive: true });
    const agentsPath = path.join(dshHome, 'AGENTS.md');
    await fs.writeFile(agentsPath, '# Existing Personal Rules\n\nKeep me intact.\n', 'utf8');

    const first = await ensureGlobalAgentsRules(dshHome);
    assert.equal(first.updated, true);

    const afterFirst = await fs.readFile(agentsPath, 'utf8');
    assert.ok(afterFirst.includes('# Existing Personal Rules'));
    assert.ok(afterFirst.includes('Keep me intact.'));
    assert.ok(afterFirst.includes(GLOBAL_AGENTS_RULES_MARKER));
    assert.ok(afterFirst.includes('outputs/'));
    assert.ok(afterFirst.includes('.work/'));
    assert.ok(afterFirst.includes('Path(__file__).resolve().parent'));
    assert.ok(afterFirst.includes('Microsoft YaHei'));
    assert.ok(afterFirst.includes('PingFang SC'));
    assert.ok(afterFirst.includes('utf-8-sig'));

    // Second invocation must be a no-op (idempotent)
    const second = await ensureGlobalAgentsRules(dshHome);
    assert.equal(second.updated, false);
    const afterSecond = await fs.readFile(agentsPath, 'utf8');
    assert.equal(afterSecond, afterFirst);
  });
});

test.describe('crypto-vault: AES-256-GCM Manifest-Last vault, hydration guard & GC', () => {
  test('AES-256-GCM hides plaintext on disk, rejects 1-byte tamper, and decrypts across devices', async () => {
    const vaultDir = path.join(TEST_TMP_ROOT, 'vault-enc');
    const winHome = path.join(TEST_TMP_ROOT, 'keys-win');
    const macHome = path.join(TEST_TMP_ROOT, 'keys-mac');

    const winKeys = await savePassphraseKey(winHome, 'top-secret-alpha-2026');
    const macKeys = await savePassphraseKey(macHome, 'top-secret-alpha-2026');

    const winVault = new VaultStore({
      vaultDir,
      deviceId: 'win-desk',
      platform: 'win32',
      secretKeys: winKeys,
    });
    const macVault = new VaultStore({
      vaultDir,
      deviceId: 'mac-air',
      platform: 'darwin',
      secretKeys: macKeys,
    });

    const secretText = 'TOP_SECRET_NVDA_DCF_TARGET_PRICE_999_CONFIDENTIAL';
    const plainBuf = Buffer.from(secretText, 'utf8');
    const ref = await winVault.putBlob(plainBuf);

    assert.equal(ref.size, plainBuf.length);
    assert.notEqual(ref.storageKey, ref.sha256, 'encrypted storageKey must be HMAC-derived');

    // Inspect raw file on disk: must start with DSHSOUL1 and contain zero plaintext
    const diskPath = path.join(vaultDir, 'blobs', 'sha256', ref.storageKey.slice(0, 2), ref.storageKey);
    const rawDisk = await fs.readFile(diskPath);
    assert.equal(rawDisk.subarray(0, 8).toString('ascii'), 'DSHSOUL1');
    assert.equal(rawDisk.includes(Buffer.from('TOP_SECRET_NVDA')), false, 'ciphertext must not leak plaintext');

    // Idempotent second putBlob
    const ref2 = await winVault.putBlob(plainBuf);
    assert.deepEqual(ref2, ref);

    // Mac decrypts Windows blob successfully
    const restored = await macVault.getBlob(ref.storageKey, ref.sha256, ref.size);
    assert.deepEqual(restored, plainBuf);

    // verifyCommitBlobs passes
    const verified = await macVault.verifyCommitBlobs([ref]);
    assert.equal(verified.ready, true);

    // Tamper 1 byte in ciphertext -> GCM must reject with VaultIntegrityError
    const tampered = Buffer.from(rawDisk);
    tampered[tampered.length - 1] ^= 0xff;
    await fs.writeFile(diskPath, tampered);

    await assert.rejects(
      () => macVault.getBlob(ref.storageKey, ref.sha256, ref.size),
      (err) => err instanceof VaultIntegrityError,
    );

    const verifyAfterTamper = await macVault.verifyCommitBlobs([ref]);
    assert.equal(verifyAfterTamper.ready, false);
  });

  test('detects .icloud evicted placeholder and 0-byte stubs as VaultHydrationPendingError', async () => {
    const vaultDir = path.join(TEST_TMP_ROOT, 'vault-hydration');
    const vault = new VaultStore({
      vaultDir,
      deviceId: 'mac-air',
      platform: 'darwin',
      secretKeys: null,
    });

    const plainBuf = Buffer.from('quarterly report payload', 'utf8');
    const ref = await vault.putBlob(plainBuf);
    assert.equal(ref.storageKey, ref.sha256, 'plaintext mode storageKey equals plain sha256');

    const blobDir = path.join(vaultDir, 'blobs', 'sha256', ref.storageKey.slice(0, 2));
    const blobFile = path.join(blobDir, ref.storageKey);
    const icloudStub = path.join(blobDir, `.${ref.storageKey}.icloud`);

    // Simulate iCloud eviction: delete real file and leave .<name>.icloud placeholder
    await fs.rm(blobFile);
    await fs.writeFile(icloudStub, 'bplist00-icloud-stub');

    await assert.rejects(
      () => vault.getBlob(ref.storageKey, ref.sha256, ref.size),
      (err) => err instanceof VaultHydrationPendingError,
    );

    const check1 = await vault.verifyCommitBlobs([ref]);
    assert.equal(check1.ready, false);

    // Simulate OneDrive 0-byte unhydrated stub
    await fs.rm(icloudStub);
    await fs.writeFile(blobFile, Buffer.alloc(0));

    await assert.rejects(
      () => vault.getBlob(ref.storageKey, ref.sha256, ref.size),
      (err) => err instanceof VaultHydrationPendingError,
    );
  });

  test('publishCommit, listCommits (with half-written commit skip), heartbeats & cross-device GC', async () => {
    const vaultDir = path.join(TEST_TMP_ROOT, 'vault-commits-gc');
    const keyHome = path.join(TEST_TMP_ROOT, 'keys-gc');
    const keys = await savePassphraseKey(keyHome, 'gc-vault-pass');

    const winVault = new VaultStore({
      vaultDir,
      deviceId: 'win-desk',
      platform: 'win32',
      secretKeys: keys,
      quotas: { retainSnapshots: 3 },
    });
    const macVault = new VaultStore({
      vaultDir,
      deviceId: 'mac-air',
      platform: 'darwin',
      secretKeys: keys,
      quotas: { retainSnapshots: 3 },
    });

    // Publish 5 commits from Windows for session 's1'
    const blobRefs = [];
    for (let i = 0; i < 5; i++) {
      const ref = await winVault.putBlob(Buffer.from(`snapshot-payload-${i}`, 'utf8'));
      blobRefs.push(ref);
      await winVault.publishCommit('session', 's1', {
        revision: i,
        sessionBlob: ref,
      });
    }

    // Mac also references blobRefs[0] (oldest Windows blob) in its own commit!
    await macVault.publishCommit('session', 's1', {
      revision: 100,
      sessionBlob: blobRefs[0],
    });

    // Verify commit file on disk does not leak plaintext
    const winCommitDir = path.join(vaultDir, 'devices', 'win-desk', 'session-commits');
    const commitFiles = (await fs.readdir(winCommitDir)).filter((f) => f.endsWith('.commit'));
    assert.equal(commitFiles.length, 5);
    const rawCommitBytes = await fs.readFile(path.join(winCommitDir, commitFiles[0]));
    assert.equal(rawCommitBytes.subarray(0, 8).toString('ascii'), 'DSHSOUL1');
    assert.equal(rawCommitBytes.includes(Buffer.from('sessionBlob')), false);

    // Plant a half-downloaded commit file in Mac's directory to verify graceful pendingCount handling
    const macCommitDir = path.join(vaultDir, 'devices', 'mac-air', 'session-commits');
    const partialCommitPath = path.join(macCommitDir, '9999999999999-99-deadbeef.commit');
    await fs.writeFile(partialCommitPath, Buffer.from('DSHSOUL1-truncated'));

    const listed = await winVault.listCommits('session', { targetId: 's1', includeSelf: true });
    assert.equal(listed.commits.length, 6);
    assert.equal(listed.pendingCount, 1);

    const remoteOnly = await winVault.listCommits('session', { targetId: 's1', includeSelf: false });
    assert.equal(remoteOnly.commits.length, 1);
    assert.equal(remoteOnly.commits[0].deviceId, 'mac-air');

    // While a pending/partial commit exists, pruneHistory prunes local commits but skips orphan blob GC for safety
    const gcWhilePending = await winVault.pruneHistory('session', 3);
    assert.equal(gcWhilePending.prunedCommits, 2); // 5 - 3 = 2 old Windows commits removed
    assert.equal(gcWhilePending.prunedBlobs, 0);
    assert.equal(gcWhilePending.skippedBlobGc, true);

    // Once the partial commit finishes syncing (removed here), blob GC cleans up the orphan blob safely
    await fs.rm(partialCommitPath);
    const gc = await winVault.pruneHistory('session', 3);
    assert.equal(gc.prunedCommits, 0);
    assert.equal(gc.prunedBlobs, 1); // blobRefs[1] is orphaned; blobRefs[0] is STILL referenced by Mac!
    assert.equal(gc.skippedBlobGc, false);

    // Verify blobRefs[0] survived (referenced by Mac), blobRefs[1] was deleted, blobRefs[2..4] survived
    const b0 = await macVault.getBlob(blobRefs[0].storageKey, blobRefs[0].sha256, blobRefs[0].size);
    assert.equal(b0.toString('utf8'), 'snapshot-payload-0');

    await assert.rejects(
      () => winVault.getBlob(blobRefs[1].storageKey, blobRefs[1].sha256, blobRefs[1].size),
      (err) => err instanceof VaultHydrationPendingError,
    );

    for (let i = 2; i < 5; i++) {
      const b = await winVault.getBlob(blobRefs[i].storageKey, blobRefs[i].sha256, blobRefs[i].size);
      assert.equal(b.toString('utf8'), `snapshot-payload-${i}`);
    }

    // Heartbeat baton roundtrip
    await winVault.writeHeartbeat({ baton: 'holding', activeSessionId: 's1' });
    await macVault.writeHeartbeat({ baton: 'idle' });
    const heartbeats = await winVault.readHeartbeats();
    assert.equal(heartbeats.length, 2);
    const winHb = heartbeats.find((h) => h.deviceId === 'win-desk');
    const macHb = heartbeats.find((h) => h.deviceId === 'mac-air');
    assert.equal(winHb.baton, 'holding');
    assert.equal(macHb.baton, 'idle');
  });
});
