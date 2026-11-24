import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  loadConfig,
  loadPassphraseKey,
  writeFileAtomic,
  GLOBAL_AGENTS_RULES_MARKER,
} from '../lib/config.js';
import { encodeSegment, projectKey, encodeV4SessionLog, decodeV4SessionLog } from '../lib/zstd-v4.js';
import { consumePendingMigration } from '../lib/session-plane.js';
import { runCli, parseWorkspaceMappingSpec } from '../bin/dsh-soul.js';

const execFile = promisify(execFileCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_TMP_ROOT = path.join(REPO_ROOT, '.test-tmp', `dsh-integration-${process.pid}-${Date.now()}`);

function makeMemoryIo(extra = {}) {
  const out = [];
  const err = [];
  return {
    stdout: (chunk) => out.push(String(chunk)),
    stderr: (chunk) => err.push(String(chunk)),
    isTTY: false,
    checkDesktopRunning: async () => false,
    minQuietMs: 0,
    ...extra,
    getStdout: () => out.join(''),
    getStderr: () => err.join(''),
  };
}

function createValidMinimalXlsx(tag = 'e2e-xlsx') {
  return Buffer.concat([
    Buffer.from(`PK\x03\x04${tag}`, 'binary'),
    Buffer.from('PK\x05\x06', 'binary'),
    Buffer.alloc(18),
  ]);
}

async function writeLocalSessionWithAttachment(dshHome, header, events, attachmentName, attachmentBytes) {
  const projDir = header.cwd ? projectKey(header.cwd) : '_no-cwd';
  const sessDir = path.join(dshHome, 'sessions', projDir, encodeSegment(header.id));
  await fs.mkdir(sessDir, { recursive: true });
  const logPath = path.join(sessDir, `session.v${header.version ?? 4}.jsonl.zstd`);
  const encoded = await encodeV4SessionLog(header, events);
  await writeFileAtomic(logPath, encoded, { mode: 0o600 });

  const sha = crypto.createHash('sha256').update(attachmentBytes).digest('hex');
  const objPath = path.join(dshHome, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha);
  const fileObjPath = path.join(dshHome, 'attachments', 'v1', 'file-objects', sha.slice(0, 2), sha);
  const namedPath = path.join(dshHome, 'attachments', 'v1', 'files', sha.slice(0, 2), sha, attachmentName);
  await writeFileAtomic(objPath, attachmentBytes, { mode: 0o600 });
  await writeFileAtomic(fileObjPath, attachmentBytes, { mode: 0o600 });
  await writeFileAtomic(namedPath, attachmentBytes, { mode: 0o600 });
  return { logPath, sha };
}

test.after(async () => {
  await fs.rm(TEST_TMP_ROOT, { recursive: true, force: true });
});

test('hygiene: .gitattributes, LF-only mac/bin scripts, and pure-ASCII PS 5.1 zero-error install-win.ps1', async () => {
  const gitattrsPath = path.join(REPO_ROOT, '.gitattributes');
  const gitattrs = await fs.readFile(gitattrsPath, 'utf8');
  assert.match(gitattrs, /\*\.sh\s+text\s+eol=lf/);
  assert.match(gitattrs, /bin\/\*\.js\s+text\s+eol=lf/);

  for (const rel of ['scripts/install-mac.sh', 'bin/dsh-soul.js']) {
    const buf = await fs.readFile(path.join(REPO_ROOT, rel));
    assert.ok(
      !(buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF),
      `${rel} must be UTF-8 without BOM`,
    );
    assert.equal(buf.includes(0x0D), false, `${rel} must contain zero CR (\\r) bytes`);
  }

  // scripts/install-mac.sh must remain compatible with macOS default Bash 3.2 under `set -u`
  // (empty array `${#ARR[@]}` throws `unbound variable` on Bash 3.2)
  const macShText = await fs.readFile(path.join(REPO_ROOT, 'scripts', 'install-mac.sh'), 'utf8');
  assert.doesNotMatch(
    macShText,
    /\$\{#(?:MAP_ARGS|PROFILES|INIT_ARGS|DOCTOR_ARGS)\[@\]\}/,
    'scripts/install-mac.sh must not dereference potentially empty array lengths with ${#ARR[@]} under set -u',
  );

  // scripts/install-mac.sh and bin/dsh-soul.js must have 100755 executable file mode in Git index
  const { stdout: lsFilesOut } = await execFile(
    'git',
    ['ls-files', '-s', 'scripts/install-mac.sh', 'bin/dsh-soul.js'],
    { cwd: REPO_ROOT, windowsHide: true },
  );
  const modeLines = lsFilesOut.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(modeLines.length, 2, 'expected both scripts/install-mac.sh and bin/dsh-soul.js to be tracked by git');
  for (const line of modeLines) {
    assert.match(line, /^100755\s+/, `expected git mode 100755, got: ${line}`);
  }

  // scripts/install-win.ps1 must be 100% pure ASCII bytes so Chinese Windows PS 5.1 never mis-decodes UTF-8 as GBK
  const ps1Path = path.join(REPO_ROOT, 'scripts', 'install-win.ps1');
  const ps1Buf = await fs.readFile(ps1Path);
  for (let i = 0; i < ps1Buf.length; i++) {
    assert.ok(
      ps1Buf[i] <= 0x7F,
      `scripts/install-win.ps1 contains non-ASCII byte 0x${ps1Buf[i].toString(16)} at offset ${i}`,
    );
  }

  if (process.platform === 'win32') {
    const parseScript = [
      '$tokens = $null; $errors = $null;',
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${ps1Path.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors);`,
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
      'Write-Output "PARSE_OK"',
    ].join(' ');
    const { stdout } = await execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', parseScript],
      { windowsHide: true },
    );
    assert.match(stdout, /PARSE_OK/);
  }
});

test('bin/dsh-soul.js full CLI roundtrip: Win init+keep+push -> Encrypted Vault -> Mac init+pull+config+status+doctor+watch', async () => {
  // Sanity-check mapping parser for both id=win::mac and auto-id win::mac
  const parsedAuto = parseWorkspaceMappingSpec('D:\\美股分析::/Users/me/美股分析');
  assert.equal(parsedAuto.id, '美股分析');
  assert.equal(parsedAuto.win32, 'D:\\美股分析');
  assert.equal(parsedAuto.darwin, '/Users/me/美股分析');

  const caseDir = path.join(TEST_TMP_ROOT, 'cli-roundtrip');
  const winHome = path.join(caseDir, 'win-home');
  const macHome = path.join(caseDir, 'mac-home');
  const vaultDir = path.join(caseDir, 'vault');
  const winWs = path.join(caseDir, 'win-ws');
  const macWs = path.join(caseDir, 'mac-ws');
  await fs.mkdir(path.join(winWs, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(winWs, 'outputs'), { recursive: true });

  // 1. Windows side init (encrypted passphrase + mapping)
  const winInitIo = makeMemoryIo({ platform: 'win32' });
  const winInitCode = await runCli(
    [
      '--dsh-home', winHome,
      'init',
      '--non-interactive',
      '--vault', vaultDir,
      '--passphrase', 'cli-e2e-passphrase',
      '--device-label', '公司Win主机',
      '--map', `ws-main=${winWs}::${macWs}`,
      '--max-file-mb', '40',
      '--retain', '12',
    ],
    winInitIo,
  );
  assert.equal(winInitCode, 0, winInitIo.getStderr());

  // Key must exist ONLY in <winHome>/soul-sync/secret.key and NEVER inside vaultDir
  const winKey = await loadPassphraseKey(winHome);
  assert.ok(winKey && winKey.encKey.length === 32);
  assert.equal(fsSync.existsSync(path.join(vaultDir, 'secret.key')), false);
  const winAgents = await fs.readFile(path.join(winHome, 'AGENTS.md'), 'utf8');
  assert.ok(winAgents.includes(GLOBAL_AGENTS_RULES_MARKER));
  const winSkill = await fs.readFile(path.join(winHome, 'skills', 'soul-handoff', 'SKILL.md'), 'utf8');
  assert.match(winSkill, /name:\s*soul-handoff/);

  // 2. Write V4 session with attachment + Python script + valid .xlsx
  const sessionId = 'sess-cli-e2e-01';
  const imgBytes = Buffer.from('\x89PNG\r\n\x1a\nfake-chart-payload-IEND', 'binary');
  const imgSha = crypto.createHash('sha256').update(imgBytes).digest('hex');
  const winHeader = {
    version: 4,
    id: sessionId,
    cwd: winWs,
    createdAt: Date.now() - 5000,
  };
  const winEvents = [
    {
      seq: 0,
      time: Date.now() - 4000,
      type: 'user/message',
      data: {
        content: [
          { type: 'text', text: '把财报截图指标写进 valuation.xlsx' },
          { type: 'image', attachmentId: imgSha },
          { type: 'file', sha256: imgSha, name: 'q4_margin.png' },
        ],
      },
    },
    {
      seq: 1,
      time: Date.now() - 3000,
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: '已生成 scripts/dcf.py 与 outputs/valuation.xlsx' }] },
    },
  ];
  await writeLocalSessionWithAttachment(winHome, winHeader, winEvents, 'q4_margin.png', imgBytes);

  const dcfCode = 'from pathlib import Path\nprint("DCF OK")\n';
  const xlsxBytes = createValidMinimalXlsx('win-valuation-v1');
  await fs.writeFile(path.join(winWs, 'scripts', 'dcf.py'), dcfCode, 'utf8');
  await fs.writeFile(path.join(winWs, 'outputs', 'valuation.xlsx'), xlsxBytes);

  // 3. keep scripts/dcf.py + push
  const keepIo = makeMemoryIo({ platform: 'win32' });
  const keepCode = await runCli(
    ['--dsh-home', winHome, 'keep', 'scripts/dcf.py', '--workspace', winWs],
    keepIo,
  );
  assert.equal(keepCode, 0, keepIo.getStderr());

  const pushIo = makeMemoryIo({ platform: 'win32' });
  const pushCode = await runCli(['--dsh-home', winHome, 'push'], pushIo);
  assert.equal(pushCode, 0, pushIo.getStderr());
  assert.match(pushIo.getStdout(), /会话闭包 1 个/);

  // 4. Simulate disaster recovery onto Mac: init + pull
  const macInitIo = makeMemoryIo({ platform: 'darwin' });
  const macInitCode = await runCli(
    [
      '--dsh-home', macHome,
      'init',
      '--non-interactive',
      '--vault', vaultDir,
      '--passphrase', 'cli-e2e-passphrase',
      '--device-label', '家里MacBook',
      '--map', `ws-main=${winWs}::${macWs}`,
    ],
    macInitIo,
  );
  assert.equal(macInitCode, 0, macInitIo.getStderr());

  // 4a. When Desktop GUI is detected running without --force: warns & skips session import, still syncs workspace
  const macPullGuardedIo = makeMemoryIo({
    platform: 'darwin',
    checkDesktopRunning: async () => true,
  });
  const macPullGuardedCode = await runCli(['--dsh-home', macHome, 'pull'], macPullGuardedIo);
  assert.equal(macPullGuardedCode, 0, macPullGuardedIo.getStderr());
  assert.match(macPullGuardedIo.getStdout(), /正在运行 DeepSeek Harness 桌面端/);
  assert.equal(await fs.readFile(path.join(macWs, 'scripts', 'dcf.py'), 'utf8'), dcfCode);
  assert.ok((await fs.readFile(path.join(macWs, 'outputs', 'valuation.xlsx'))).equals(xlsxBytes));

  // 4b. Pull with --force restores the V4 session + attachment + pending first-person migration baton
  const macPullForceIo = makeMemoryIo({
    platform: 'darwin',
    checkDesktopRunning: async () => true,
  });
  const macPullForceCode = await runCli(['--dsh-home', macHome, 'pull', '--force'], macPullForceIo);
  assert.equal(macPullForceCode, 0, macPullForceIo.getStderr());
  assert.match(macPullForceIo.getStdout(), /会话新增 1/);

  // Verify restored session log on Mac has mapped cwd, restored attachment, and pending migration
  const macSessLogPath = path.join(
    macHome,
    'sessions',
    projectKey(macWs),
    encodeSegment(sessionId),
    'session.v4.jsonl.zstd',
  );
  const decoded = await decodeV4SessionLog(await fs.readFile(macSessLogPath));
  assert.equal(decoded.header.cwd, macWs.replace(/\\/g, '/'));
  assert.equal(decoded.events.length, 2);

  const restoredImg = await fs.readFile(
    path.join(macHome, 'attachments', 'v1', 'files', imgSha.slice(0, 2), imgSha, 'q4_margin.png'),
  );
  assert.ok(restoredImg.equals(imgBytes));

  const mig = await consumePendingMigration(macHome, sessionId);
  assert.ok(mig, 'first-person cross-OS migration baton should be ready after pull');
  assert.equal(mig.fromDeviceLabel, '公司Win主机');
  assert.equal(mig.fromPlatform, 'win32');

  // 5. config maxFileMB=64
  const cfgIo = makeMemoryIo({ platform: 'darwin' });
  const cfgCode = await runCli(['--dsh-home', macHome, 'config', 'maxFileMB=64'], cfgIo);
  assert.equal(cfgCode, 0, cfgIo.getStderr());
  const macCfg = await loadConfig(macHome);
  assert.equal(macCfg.quotas.maxFileBytes, 64 * 1024 * 1024);

  // 6. status
  const statusIo = makeMemoryIo({ platform: 'darwin' });
  const statusCode = await runCli(['--dsh-home', macHome, 'status'], statusIo);
  assert.equal(statusCode, 0, statusIo.getStderr());
  assert.match(statusIo.getStdout(), /双机接力体检卡/);
  assert.match(statusIo.getStdout(), /本地会话总数.*1 个/);
  assert.match(statusIo.getStdout(), /ws-main/);

  // 7. doctor: fails (exit 1) when neither web nor desktop profile is registered, passes (exit 0) once registered
  const docFailIo = makeMemoryIo({ platform: 'darwin' });
  const docFailCode = await runCli(['--dsh-home', macHome, 'doctor'], docFailIo);
  assert.equal(docFailCode, 1);
  assert.match(docFailIo.getStdout(), /\[FAIL\] profiles/);

  await writeFileAtomic(
    path.join(macHome, 'profiles', 'web', 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { 'dsh-soul-sync': 'link:../..' },
      dsh: { profile: { bundles: ['dsh-soul-sync'] } },
    }, null, 2),
    { mode: 0o644 },
  );
  const docOkIo = makeMemoryIo({ platform: 'darwin' });
  const docOkCode = await runCli(['--dsh-home', macHome, 'doctor'], docOkIo);
  assert.equal(docOkCode, 0, docOkIo.getStdout());
  assert.match(docOkIo.getStdout(), /体检通过/);

  // 8. watch with short interval + AbortSignal graceful exit
  const ac = new AbortController();
  const watchIo = makeMemoryIo({ platform: 'darwin', signal: ac.signal });
  setTimeout(() => ac.abort(), 160);
  const watchCode = await runCli(['--dsh-home', macHome, 'watch', '--interval-ms', '60'], watchIo);
  assert.equal(watchCode, 0, watchIo.getStderr());
  assert.match(watchIo.getStdout(), /已优雅退出/);
});

test('bin/dsh-soul.js CLI --platform flag overrides io.platform and rejects invalid platform values', async () => {
  const caseDir = path.join(TEST_TMP_ROOT, 'cli-platform-flag');
  const dshHome = path.join(caseDir, 'home');
  const vaultDir = path.join(caseDir, 'vault');

  // Pass --platform darwin explicitly without ioOverrides.platform
  const initIo = makeMemoryIo();
  const initCode = await runCli(
    [
      '--dsh-home', dshHome,
      '--platform', 'darwin',
      'init',
      '--non-interactive',
      '--vault', vaultDir,
      '--no-passphrase',
      '--device-label', 'OverridePlatformMac',
    ],
    initIo,
  );
  assert.equal(initCode, 0, initIo.getStderr());
  assert.match(initIo.getStdout(), /darwin/);
  const cfg = await loadConfig(dshHome);
  assert.equal(cfg.platform, 'darwin');

  // Invalid platform value must fail with exit code 1
  const badIo = makeMemoryIo();
  const badCode = await runCli(
    ['--dsh-home', dshHome, '--platform', 'solaris', 'status'],
    badIo,
  );
  assert.equal(badCode, 1);
  assert.match(badIo.getStderr(), /--platform/);
});

const LOCAL_DSH_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')
  : '';
const LOCAL_DSH_EXE = LOCAL_DSH_DIR ? path.join(LOCAL_DSH_DIR, 'DeepSeek Harness.exe') : '';
const LOCAL_DSH_CLI = LOCAL_DSH_DIR
  ? path.join(LOCAL_DSH_DIR, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  : '';
const HAS_LIVE_DSH = process.platform === 'win32' && fsSync.existsSync(LOCAL_DSH_EXE);

test(
  'live local DSH 0.2.2-rc.1 sandbox E2E: install-win.ps1 (both profiles + idempotent x2) + live Cordis web boot + startup auto-pull',
  { skip: !HAS_LIVE_DSH },
  async () => {
    const sandboxDir = path.join(TEST_TMP_ROOT, `real-dsh-${process.pid}-${Date.now()}`);
    const isolatedDshHome = path.join(sandboxDir, 'dsh-home');
    const isolatedVault = path.join(sandboxDir, 'vault');
    const macHome = path.join(sandboxDir, 'mac-home');
    const macSimWs = path.join(sandboxDir, 'mac-sim-ws');
    const winWs = path.join(sandboxDir, 'win-ws');
    await fs.mkdir(path.join(macSimWs, 'outputs'), { recursive: true });

    // Pre-populate encrypted vault from a simulated Mac peer BEFORE Windows DSH even creates winWs!
    const macInitIo = makeMemoryIo({ platform: 'darwin' });
    assert.equal(
      await runCli(
        [
          '--dsh-home', macHome,
          'init',
          '--non-interactive',
          '--vault', isolatedVault,
          '--passphrase', 'real-e2e-secret',
          '--device-label', '家里MacBook',
          '--map', `us=${winWs}::${macSimWs}`,
        ],
        macInitIo,
      ),
      0,
      macInitIo.getStderr(),
    );

    const liveSessId = 'session-live-cordis-boot-01';
    const liveImg = Buffer.from('\x89PNG\r\n\x1a\nlive-chart-IEND', 'binary');
    await writeLocalSessionWithAttachment(
      macHome,
      {
        version: 4,
        id: liveSessId,
        cwd: macSimWs,
        createdAt: Date.now() - 2000,
      },
      [
        {
          seq: 0,
          time: Date.now() - 1500,
          type: 'user/message',
          surfaceOp: 'append',
          data: {
            id: 'msg-user-1',
            role: 'user',
            content: [{ type: 'text', text: '我们在 Mac 上算完毛利率了，回公司 Windows 继续' }],
            source: { kind: 'user' },
          },
        },
      ],
      'margin.png',
      liveImg,
    );
    const liveXlsx = createValidMinimalXlsx('mac-to-live-win-dsh');
    await fs.writeFile(path.join(macSimWs, 'outputs', 'valuation.xlsx'), liveXlsx);

    const macPushIo = makeMemoryIo({ platform: 'darwin' });
    assert.equal(await runCli(['--dsh-home', macHome, 'push'], macPushIo), 0, macPushIo.getStderr());

    // Note: NO -SkipDesktop! Verifies uninitialized desktop profile is handled gracefully with exit code 0!
    const installScript = path.join(REPO_ROOT, 'scripts', 'install-win.ps1');
    const installArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', installScript,
      '-NonInteractive',
      '-DshHome', isolatedDshHome,
      '-VaultDir', isolatedVault,
      '-Passphrase', 'real-e2e-secret',
      '-Map', `us=${winWs}::${macSimWs}`,
    ];

    try {
      // Run 1: clean installation into completely isolated DSH_HOME (both web & uninitialized desktop)
      const run1 = await execFile('powershell.exe', installArgs, {
        cwd: REPO_ROOT,
        windowsHide: true,
        timeout: 60000,
      });
      assert.match(run1.stdout, /体检通过/);

      // Run 2: idempotent reinstall must succeed with exit code 0
      const run2 = await execFile('powershell.exe', installArgs, {
        cwd: REPO_ROOT,
        windowsHide: true,
        timeout: 60000,
      });
      assert.match(run2.stdout, /体检通过/);

      // Run real DSH host CLI `--profile web --dump-config` from isolated sandboxDir
      const dumpRes = await execFile(
        LOCAL_DSH_EXE,
        ['--expose-internals', LOCAL_DSH_CLI, '--profile', 'web', '--dump-config'],
        {
          cwd: sandboxDir,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            DSH_HOME: isolatedDshHome,
          },
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      assert.ok(
        dumpRes.stdout.includes('# == dsh-soul-sync'),
        `Expected --dump-config to include "# == dsh-soul-sync", got:\n${dumpRes.stdout.slice(0, 600)}`,
      );

      // ACTUALLY BOOT real DeepSeek Harness `web` profile runtime (`@deepseek-ai/cordis`)
      // and verify `dsh-soul-sync` activates with ZERO errors and executes live startup auto-pull!
      const bootResult = await new Promise((resolve, reject) => {
        const child = spawn(
          LOCAL_DSH_EXE,
          ['--expose-internals', LOCAL_DSH_CLI, '--profile', 'web', '--no-open', '--port', '0'],
          {
            cwd: sandboxDir,
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
              DSH_HOME: isolatedDshHome,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );

        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            child.kill();
          } catch {
            // ignore
          }
        };

        const timeout = setTimeout(() => {
          finish();
          reject(new Error(`Timed out waiting for live dsh web boot.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        }, 25000);

        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
          if (stdout.includes('dsh web: http://127.0.0.1:')) {
            // Give async controller.start() 1500ms to finish live pullSessionsFromVault + WorkspaceRegistry reconciliation
            setTimeout(() => {
              clearTimeout(timeout);
              finish();
            }, 1500);
          }
        });

        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        child.on('close', () => {
          clearTimeout(timeout);
          resolve({ stdout, stderr });
        });
      });

      assert.match(bootResult.stdout, /dsh web: http:\/\/127\.0\.0\.1:\d+/);
      assert.equal(
        bootResult.stderr.includes('did not activate'),
        false,
        `Real DSH Cordis failed to activate plugin:\n${bootResult.stderr}`,
      );
      assert.equal(
        bootResult.stderr.includes('cannot get property'),
        false,
        `Real DSH Cordis strict proxy error:\n${bootResult.stderr}`,
      );

      assert.equal(
        bootResult.stderr.includes('[dsh-soul-sync] startup error:'),
        false,
        `Startup error inside live DSH:\n${bootResult.stderr}`,
      );

      // Verify live DSH boot auto-created winWs, decrypted & restored valuation.xlsx, imported V4 session, and reconciled WorkspaceRegistry!
      const restoredXlsx = await fs.readFile(path.join(winWs, 'outputs', 'valuation.xlsx'));
      assert.ok(restoredXlsx.equals(liveXlsx), 'Live DSH boot should auto-pull encrypted deliverables into winWs');

      const winSessPath = path.join(
        isolatedDshHome,
        'sessions',
        projectKey(winWs),
        encodeSegment(liveSessId),
        'session.v4.jsonl.zstd',
      );
      const winDecoded = await decodeV4SessionLog(await fs.readFile(winSessPath));
      assert.equal(winDecoded.header.cwd.toLowerCase(), winWs.toLowerCase());

      const wsJson = JSON.parse(await fs.readFile(path.join(isolatedDshHome, 'storages', 'workspace.json'), 'utf8'));
      const wsEntries = Object.values(wsJson.tables?.workspaces ?? {});
      assert.ok(
        wsEntries.some((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(liveSessId)),
        `Expected real DSH WorkspaceRegistry to attach ${liveSessId}, got: ${JSON.stringify(wsJson)}`,
      );

      // Run standalone `node bin/dsh-soul.js --dsh-home <isolatedDshHome> doctor`
      const doctorRes = await execFile(
        process.execPath,
        [path.join(REPO_ROOT, 'bin', 'dsh-soul.js'), '--dsh-home', isolatedDshHome, 'doctor'],
        {
          cwd: sandboxDir,
          windowsHide: true,
          timeout: 15000,
        },
      );
      assert.match(doctorRes.stdout, /\[OK\]\s+profile\/web/);
      assert.match(doctorRes.stdout, /体检通过/);

      // Verify real @deepseek-ai/dsh-session-persistence-jsonl opens imported & split-brain forked sessions
      // AND real @deepseek-ai/dsh-commands executes all 6 `/soul` slash commands inside real Cordis!
      const verifierScript = path.join(sandboxDir, 'verify-asar-services.mjs');
      const dshScopeDir = path.join(LOCAL_DSH_DIR, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
      const verifierSource = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scopeDir = ${JSON.stringify(dshScopeDir)};
const repoRoot = ${JSON.stringify(REPO_ROOT)};
const isolatedDshHome = ${JSON.stringify(isolatedDshHome)};
const winWs = ${JSON.stringify(winWs)};

const { Context } = await import(pathToFileURL(path.join(scopeDir, 'cordis', 'lib', 'index.js')).href);
const PersistenceMod = await import(pathToFileURL(path.join(scopeDir, 'dsh-session-persistence-jsonl', 'lib', 'index.js')).href);
const CommandsMod = await import(pathToFileURL(path.join(scopeDir, 'dsh-commands', 'lib', 'index.js')).href);
const SessionMod = await import(pathToFileURL(path.join(scopeDir, 'dsh-session', 'lib', 'index.js')).href);
const { createScope } = await import(pathToFileURL(path.join(scopeDir, 'dsh-scope', 'lib', 'index.js')).href);
const SoulSyncPlugin = await import(pathToFileURL(path.join(repoRoot, 'lib', 'index.js')).href);

const ctx = new Context();
ctx.plugin(SessionMod.default ?? SessionMod);
ctx.plugin(CommandsMod.default ?? CommandsMod);
ctx.plugin(PersistenceMod.default ?? PersistenceMod, { root: path.join(isolatedDshHome, 'sessions'), compression: 'zstd' });
ctx.plugin(SoulSyncPlugin, { dshHome: isolatedDshHome, minQuietMs: 0 });
await new Promise((r) => setTimeout(r, 250));

// 1. Real JsonlSessionPersistence.open('read') decodes the imported session without V4 schema/surface errors
const handle = await ctx.get('sessionPersistence').open(${JSON.stringify(liveSessId)}, 'read');
const slice = await handle.read();
assert.equal(slice.events.length, 1);
assert.equal(slice.events[0].type, 'user/message');
await handle.close();

// 2. Real CommandRuntime.execute runs all 6 /soul subcommands and appends command/run + command/done events
const liveSession = ctx.get('sessions').create('live-cmd-sess', {
  meta: { version: 4, id: 'live-cmd-sess', createdAt: Date.now(), cwd: winWs, isSeeded: false, delegationDepth: 0 },
});
const steered = [];
const fakeAgent = { id: liveSession.id, session: liveSession, steer: (m) => steered.push(m) };
fakeAgent.scope = createScope(ctx, fakeAgent);
fakeAgent.ctx = fakeAgent.scope.ctx;

await fs.writeFile(path.join(winWs, 'notes.md'), '# 实时验收假设\\n', 'utf8');
for (const line of ['/soul status', '/soul keep notes.md', '/soul config maxFileMB=48', '/soul handoff 验收通过', '/soul push', '/soul pull']) {
  const execRes = await ctx.get('commands').execute(fakeAgent, line, [], new AbortController().signal);
  assert.ok(execRes, 'Command should resolve: ' + line);
  assert.equal(execRes.result.kind, 'success', line + ' failed: ' + execRes.result.text);
}
assert.equal(steered.length, 1);
assert.equal(liveSession.snapshotEvents().length, 12);
await ctx.fiber.dispose();
console.log('ASAR_LIVE_SERVICES_OK');
`;
      await fs.writeFile(verifierScript, verifierSource, 'utf8');
      const liveServicesRes = await execFile(
        LOCAL_DSH_EXE,
        ['--expose-internals', verifierScript],
        {
          cwd: sandboxDir,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          timeout: 20000,
        },
      );
      assert.match(liveServicesRes.stdout, /ASAR_LIVE_SERVICES_OK/);
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  },
);
