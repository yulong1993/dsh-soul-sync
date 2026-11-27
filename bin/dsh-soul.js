#!/usr/bin/env node
import { execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_QUOTAS,
  VALID_SYNC_SCOPES,
  GLOBAL_AGENTS_RULES_MARKER,
  resolveDshHome,
  soulSyncDir,
  loadConfig,
  saveConfig,
  savePassphraseKey,
  loadPassphraseKey,
  derivePassphraseKey,
  ensureGlobalAgentsRules,
  writeFileAtomic,
  expandPosixHome,
  extractDirBasename,
  deriveWorkspaceId,
  stripOuterQuotes,
  validateVaultDirectory,
  validateWorkspaceDirectory,
  uninstallPluginFromDshHome,
} from '../lib/config.js';
import { applyRemoteUpdate } from '../lib/self-updater.js';
import { scanLocalSessions } from '../lib/session-plane.js';
import { VaultStore } from '../lib/crypto-vault.js';
import {
  recordDeliverableCandidate,
  pushWorkspaceDeliverables,
  pullWorkspaceDeliverables,
  loadWorkspaceDeliverableState,
  detectOpenOfficeLocks,
  createActiveWorkspaceWatcher,
} from '../lib/deliverable-plane.js';
import { SoulSyncController } from '../lib/index.js';
import { parseBooleanToggle } from '../lib/nl-router.js';

const execFile = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function createWriter(target, fallbackStream) {
  if (typeof target === 'function') {
    return (text) => target(String(text));
  }
  if (target && typeof target.write === 'function') {
    return (text) => target.write(String(text));
  }
  return (text) => fallbackStream.write(String(text));
}

function makeIo(io = {}) {
  const writeOut = createWriter(io.stdout, process.stdout);
  const writeErr = createWriter(io.stderr, process.stderr);
  return {
    out: (line = '') => writeOut(`${line}\n`),
    err: (line = '') => writeErr(`${line}\n`),
    stdin: io.stdin ?? process.stdin,
    stdoutStream: typeof io.stdout === 'object' && io.stdout?.write ? io.stdout : process.stdout,
    platform: io.platform ?? process.platform,
    env: io.env ?? process.env,
    isTTY: typeof io.isTTY === 'boolean' ? io.isTTY : Boolean(process.stdin.isTTY && process.stdout.isTTY),
    checkDesktopRunning: io.checkDesktopRunning ?? defaultCheckDesktopRunning,
    signal: io.signal ?? null,
    minQuietMs: typeof io.minQuietMs === 'number' ? io.minQuietMs : undefined,
  };
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

/**
 * Parse `--map` value in either `id=winPath::macPath` or `winPath::macPath` format.
 */
export function parseWorkspaceMappingSpec(rawSpec) {
  const spec = String(rawSpec ?? '').trim();
  if (!spec) {
    throw new Error('空的工作区映射参数（格式应为 winPath::macPath 或 id=winPath::macPath）');
  }
  const sepIdx = spec.indexOf('::');
  if (sepIdx === -1) {
    throw new Error(`无效的工作区映射「${spec}」，必须包含 "::" 分隔 Windows 与 macOS 路径`);
  }

  const leftPart = stripOuterQuotes(spec.slice(0, sepIdx));
  const rightPart = stripOuterQuotes(spec.slice(sepIdx + 2));

  let id = '';
  let winPath = leftPart;
  const eqIdx = leftPart.indexOf('=');
  if (eqIdx > 0 && !leftPart.slice(0, eqIdx).includes('\\') && !leftPart.slice(0, eqIdx).includes('/') && !leftPart.slice(0, eqIdx).includes(':')) {
    id = leftPart.slice(0, eqIdx).trim();
    winPath = stripOuterQuotes(leftPart.slice(eqIdx + 1));
  }

  const macPath = rightPart;
  if (!winPath && !macPath) {
    throw new Error(`无效的工作区映射「${spec}」，Windows 与 macOS 路径不能同时为空`);
  }

  const title = extractDirBasename(winPath) || extractDirBasename(macPath) || id || 'workspace';
  const finalId = id || deriveWorkspaceId(winPath, macPath);

  return {
    id: finalId,
    title,
    ...(winPath ? { win32: winPath.normalize('NFC') } : {}),
    ...(macPath ? { darwin: macPath.normalize('NFC') } : {}),
  };
}

function normPathCmp(p) {
  return String(p ?? '').trim().normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function mergeWorkspaceMappings(existingList, additions) {
  const result = (existingList ?? []).filter((m) => m?.id).map((m) => ({ ...m }));
  for (const m of additions ?? []) {
    if (!m?.id) continue;
    // C9: Match existing entry by exact id (only if paths don't conflict) or by matching win32/darwin path.
    // Two distinct path pairs sharing a basename NEVER silently overwrite each other!
    let idx = result.findIndex(
      (em) =>
        (m.win32 && em.win32 && normPathCmp(m.win32) === normPathCmp(em.win32))
        || (m.darwin && em.darwin && normPathCmp(m.darwin) === normPathCmp(em.darwin)),
    );
    if (idx === -1) {
      idx = result.findIndex((em) => em.id === m.id);
      if (idx !== -1) {
        const em = result[idx];
        const winDiff = Boolean(m.win32 && em.win32 && normPathCmp(m.win32) !== normPathCmp(em.win32));
        const macDiff = Boolean(m.darwin && em.darwin && normPathCmp(m.darwin) !== normPathCmp(em.darwin));
        if (winDiff || macDiff) {
          const disambigId = deriveWorkspaceId(m.win32 || '', m.darwin || '');
          const uniqueId = result.some((x) => x.id === disambigId)
            ? `${disambigId}-${crypto.createHash('sha256').update(`${normPathCmp(m.win32)}|${normPathCmp(m.darwin)}|${result.length}`).digest('hex').slice(0, 4)}`
            : disambigId;
          result.push({ ...m, id: uniqueId });
          continue;
        }
      }
    }
    if (idx !== -1) {
      const prevTs = typeof result[idx].updatedAt === 'number' && Number.isFinite(result[idx].updatedAt) ? result[idx].updatedAt : 0;
      const nextTs = typeof m.updatedAt === 'number' && Number.isFinite(m.updatedAt) ? m.updatedAt : prevTs;
      result[idx] = { ...result[idx], ...m, id: result[idx].id, updatedAt: Math.min(prevTs, nextTs) };
    } else {
      result.push({ ...m });
    }
  }
  return result;
}

function parseArgv(argv) {
  const flags = {
    dshHome: null,
    platform: null,
    help: false,
    version: false,
    nonInteractive: false,
    vault: null,
    passphrase: null,
    noPassphrase: false,
    deviceLabel: null,
    maps: [],
    fallbackDir: null,
    maxFileMB: null,
    maxWorkspaceMB: null,
    retain: null,
    stepSyncMs: null,
    stepSync: null,
    scope: null,
    trashDays: null,
    workspace: null,
    onlySessions: [],
    onlyWorkspaces: [],
    targets: [],
    saveMapping: false,
    force: false,
    forceRotate: false,
    intervalMs: null,
  };
  const positionals = [];

  const takeValue = (args, idx, name) => {
    const cur = args[idx];
    const eqIdx = cur.indexOf('=');
    if (eqIdx !== -1) {
      return { value: cur.slice(eqIdx + 1), nextIdx: idx };
    }
    if (idx + 1 >= args.length) {
      throw new Error(`参数 ${name} 缺少取值`);
    }
    return { value: args[idx + 1], nextIdx: idx + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === '--non-interactive') {
      flags.nonInteractive = true;
    } else if (arg === '--no-passphrase') {
      flags.noPassphrase = true;
    } else if (arg === '--force-rotate') {
      flags.forceRotate = true;
    } else if (arg === '--no-step-sync') {
      flags.stepSync = false;
    } else if (arg === '--step-sync' || arg.startsWith('--step-sync=')) {
      const r = takeValue(argv, i, '--step-sync');
      const parsedBool = parseBooleanToggle(r.value);
      if (parsedBool === null) {
        throw new Error(`参数 --step-sync 仅支持 on/off/true/false/1/0，当前收到：${r.value}`);
      }
      flags.stepSync = parsedBool;
      i = r.nextIdx;
    } else if (arg === '--scope' || arg.startsWith('--scope=')) {
      const r = takeValue(argv, i, '--scope');
      const normScope = String(r.value ?? '').trim().toLowerCase();
      if (!VALID_SYNC_SCOPES.includes(normScope)) {
        throw new Error(`参数 --scope 仅支持 active / selected，当前收到：${r.value}`);
      }
      flags.scope = normScope;
      i = r.nextIdx;
    } else if (arg === '--force') {
      flags.force = true;
    } else if (arg === '--dsh-home' || arg.startsWith('--dsh-home=')) {
      const r = takeValue(argv, i, '--dsh-home');
      flags.dshHome = r.value;
      i = r.nextIdx;
    } else if (arg === '--platform' || arg.startsWith('--platform=')) {
      const r = takeValue(argv, i, '--platform');
      flags.platform = r.value;
      i = r.nextIdx;
    } else if (arg === '--vault' || arg.startsWith('--vault=')) {
      const r = takeValue(argv, i, '--vault');
      flags.vault = r.value;
      i = r.nextIdx;
    } else if (arg === '--passphrase' || arg.startsWith('--passphrase=')) {
      const r = takeValue(argv, i, '--passphrase');
      flags.passphrase = r.value;
      i = r.nextIdx;
    } else if (arg === '--device-label' || arg.startsWith('--device-label=')) {
      const r = takeValue(argv, i, '--device-label');
      flags.deviceLabel = r.value;
      i = r.nextIdx;
    } else if (arg === '--map' || arg.startsWith('--map=')) {
      const r = takeValue(argv, i, '--map');
      flags.maps.push(r.value);
      i = r.nextIdx;
    } else if (arg === '--fallback-dir' || arg.startsWith('--fallback-dir=')) {
      const r = takeValue(argv, i, '--fallback-dir');
      flags.fallbackDir = r.value;
      i = r.nextIdx;
    } else if (arg === '--max-file-mb' || arg.startsWith('--max-file-mb=')) {
      const r = takeValue(argv, i, '--max-file-mb');
      flags.maxFileMB = r.value;
      i = r.nextIdx;
    } else if (arg === '--max-workspace-mb' || arg.startsWith('--max-workspace-mb=')) {
      const r = takeValue(argv, i, '--max-workspace-mb');
      flags.maxWorkspaceMB = r.value;
      i = r.nextIdx;
    } else if (arg === '--retain' || arg.startsWith('--retain=')) {
      const r = takeValue(argv, i, '--retain');
      flags.retain = r.value;
      i = r.nextIdx;
    } else if (arg === '--step-sync-ms' || arg.startsWith('--step-sync-ms=')) {
      const r = takeValue(argv, i, '--step-sync-ms');
      flags.stepSyncMs = r.value;
      i = r.nextIdx;
    } else if (arg === '--trash-days' || arg.startsWith('--trash-days=')) {
      const r = takeValue(argv, i, '--trash-days');
      flags.trashDays = r.value;
      i = r.nextIdx;
    } else if (arg === '--workspace' || arg.startsWith('--workspace=')) {
      const r = takeValue(argv, i, '--workspace');
      flags.workspace = r.value;
      i = r.nextIdx;
    } else if (arg === '--only-session' || arg.startsWith('--only-session=')) {
      const r = takeValue(argv, i, '--only-session');
      flags.onlySessions.push(r.value);
      i = r.nextIdx;
    } else if (arg === '--only-workspace' || arg.startsWith('--only-workspace=')) {
      const r = takeValue(argv, i, '--only-workspace');
      flags.onlyWorkspaces.push(r.value);
      i = r.nextIdx;
    } else if (arg === '--target' || arg.startsWith('--target=')) {
      const r = takeValue(argv, i, '--target');
      flags.targets.push(r.value);
      i = r.nextIdx;
    } else if (arg === '--save-mapping') {
      flags.saveMapping = true;
    } else if (arg === '--interval-ms' || arg.startsWith('--interval-ms=')) {
      const r = takeValue(argv, i, '--interval-ms');
      flags.intervalMs = r.value;
      i = r.nextIdx;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

function parsePositiveNumber(raw, label, { integer = false } = {}) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0 || (integer && !Number.isInteger(num))) {
    throw new Error(`参数 ${label} 必须为正${integer ? '整' : ''}数，当前收到：${raw}`);
  }
  return num;
}

async function defaultCheckDesktopRunning(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFile(
        'tasklist',
        ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 4000 },
      );
      const lines = String(stdout ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('"DeepSeek Harness.exe"'));
      // Filter out current PID if somehow running inside Electron
      const otherLines = lines.filter((line) => {
        const cols = line.split('","');
        const pid = Number((cols[1] ?? '').replace(/"/g, ''));
        return pid !== process.pid && pid !== process.ppid;
      });
      return otherLines.length > 0;
    }
    const { stdout } = await execFile('pgrep', ['-x', 'DeepSeek Harness'], { timeout: 4000 });
    return String(stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

async function syncHandoffSkill(dshHome) {
  const srcPath = path.join(REPO_ROOT, 'skills', 'soul-handoff', 'SKILL.md');
  const destPath = path.join(dshHome, 'skills', 'soul-handoff', 'SKILL.md');
  const content = await fs.readFile(srcPath, 'utf8');
  await writeFileAtomic(destPath, content, { mode: 0o644 });
  return destPath;
}

async function ensureVaultStructure(vaultDir) {
  const resolved = path.resolve(vaultDir);
  await fs.mkdir(path.join(resolved, 'blobs', 'sha256'), { recursive: true });
  await fs.mkdir(path.join(resolved, 'devices'), { recursive: true });
  return resolved;
}

async function readPackageVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function formatHelpText() {
  return [
    'dsh-soul — DeepSeek Harness 跨设备防灾备份与灵魂接力独立 CLI',
    '',
    '用法：',
    '  dsh-soul [--dsh-home <dir>] <子命令> [选项]',
    '',
    '子命令：',
    '  init      初始化配置、防灾金库目录、可选口令加密、工作区映射与接力技能',
    '  status    输出双机同步体检报告（金库、加密、模型档位、会话数、产出数与 Excel 锁）',
    '  catalog   盘点本机与金库中所有可迁移的工作区与对话清单（过滤空窗口）',
    '  push      备份本地会话闭包、AGENTS.md 与产出物（支持 --only-workspace / --only-session 按需推送）',
    '  pull      从金库恢复/三路合并会话与产出物（支持 --only-workspace / --only-session / --target / --force）',
    '  unpublish 从金库撤回指定会话（删除金库提交、回收孤儿块并加入屏蔽清单）',
    '  keep      将指定文件手动纳入《产出账本》并立即推送至防灾金库',
    '  config    查看或修改同步配额、文件夹对应模式（folderMatchMode）与同步范围（syncScope）',
    '  doctor    全面自检配置、金库读写、密钥、技能、规则块与 DSH 插件注册状态',
    '  watch     启动轻量级后台守护模式，自动监测并周期备份会话与产出物',
    '  disconnect 断开当前防灾金库连接并暂停同步（保留本机对话与文件）',
    '  reset     重置本机 soul-sync 配置与密钥（保留本机对话、文件与凭据）',
    '  uninstall 一键卸载插件注册、技能、规则块与本机配置（绝不删本机对话、文件与插件源目录）',
    '',
    '常用示例：',
    '  dsh-soul init --non-interactive --vault "D:\\OneDrive\\dsh-vault" --passphrase "我的口令" --map "us=D:\\美股分析::/Users/me/美股分析" [--no-step-sync]',
    '  dsh-soul catalog',
    '  dsh-soul push --only-workspace "量化" --only-session sess-abc',
    '  dsh-soul pull --only-workspace "文章" --target "D:\\文章::/Users/me/文章"',
    '  dsh-soul config folderMatchMode=mapped-only syncScope=selected',
  ].join('\n');
}

async function runInit(flags, dshHome, io) {
  const existing = await loadConfig(dshHome);

  let vaultDir = flags.vault ?? existing.vaultDir ?? '';
  let passphrase = flags.passphrase;
  let clearPassphrase = flags.noPassphrase;
  let deviceLabel = flags.deviceLabel ?? existing.deviceLabel ?? (os.hostname() || 'my-device');
  let stepSyncEnabled = flags.stepSync !== null
    ? flags.stepSync
    : (typeof existing.stepSyncEnabled === 'boolean' ? existing.stepSyncEnabled : true);
  const mapSpecs = [...flags.maps];

  if (!flags.nonInteractive && io.isTTY) {
    const rl = readline.createInterface({ input: io.stdin, output: io.stdoutStream });
    try {
      io.out('=== dsh-soul 初始化向导 ===');
      if (!flags.vault) {
        const ansVault = (await rl.question(`1. 请输入网盘防灾金库目录${vaultDir ? ` [默认: ${vaultDir}]` : ''}: `)).trim();
        if (ansVault) vaultDir = ansVault;
      }
      if (passphrase === null && !clearPassphrase) {
        const ansPass = await rl.question('2. 请输入端到端加密口令（直接回车表示明文模式；双端请保持一致）: ');
        if (ansPass.trim().length > 0) {
          passphrase = ansPass.trim();
        } else {
          clearPassphrase = true;
        }
      }
      if (!flags.deviceLabel) {
        const ansLabel = (await rl.question(`3. 本机昵称 [默认: ${deviceLabel}]: `)).trim();
        if (ansLabel) deviceLabel = ansLabel;
      }
      if (mapSpecs.length === 0) {
        io.out('4. 配置跨系统工作区路径配对（格式: D:\\美股分析::/Users/你的名字/美股分析 ，直接回车结束）：');
        for (;;) {
          const ansMap = (await rl.question('   添加映射: ')).trim();
          if (!ansMap) break;
          mapSpecs.push(ansMap);
        }
      }
      if (flags.stepSync === null) {
        const ansStep = (await rl.question('是否开启运行中每 30 秒步级防断电快照？[Y/n，默认开启，稳妥派可输入 n 关闭]: ')).trim().toLowerCase();
        if (ansStep === 'n' || ansStep === 'no' || ansStep === 'off' || ansStep === 'false' || ansStep === '0') {
          stepSyncEnabled = false;
        } else if (ansStep === 'y' || ansStep === 'yes' || ansStep === 'on' || ansStep === 'true' || ansStep === '1') {
          stepSyncEnabled = true;
        }
      }
    } finally {
      rl.close();
    }
  }

  const cleanVaultDir = stripOuterQuotes(vaultDir);
  if (!cleanVaultDir) {
    io.err('错误：请通过 --vault <dir> 指定网盘防灾金库目录。');
    return 1;
  }

  const vaultHostPlatform = io.platform === process.platform ? io.platform : process.platform;
  const vaultVal = validateVaultDirectory(cleanVaultDir, vaultHostPlatform, {
    dshHome,
    workspaceMappings: existing.workspaceMappings ?? [],
  });
  if (!vaultVal.ok) {
    io.err(`错误：${vaultVal.error}`);
    return 1;
  }
  const resolvedVaultDir = await ensureVaultStructure(vaultVal.normalizedPath);

  const quotasPatch = {};
  if (flags.maxFileMB !== null) {
    quotasPatch.maxFileBytes = Math.round(parsePositiveNumber(flags.maxFileMB, '--max-file-mb') * 1024 * 1024);
  }
  if (flags.maxWorkspaceMB !== null) {
    quotasPatch.maxWorkspaceBytes = Math.round(parsePositiveNumber(flags.maxWorkspaceMB, '--max-workspace-mb') * 1024 * 1024);
  }
  if (flags.retain !== null) {
    quotasPatch.retainSnapshots = parsePositiveNumber(flags.retain, '--retain', { integer: true });
  }
  if (flags.stepSyncMs !== null) {
    quotasPatch.stepSyncIntervalMs = Math.round(parsePositiveNumber(flags.stepSyncMs, '--step-sync-ms'));
  }
  if (flags.trashDays !== null) {
    quotasPatch.trashRetentionDays = parsePositiveNumber(flags.trashDays, '--trash-days', { integer: true });
  }

  // Neon P0 #3: Check vault decryptability BEFORE overwriting key / publishing any global commit!
  // Prevents `dsh-soul init --map ... --passphrase WRONG` from polluting the vault with an unreadable commit.
  const willBeEncrypted = clearPassphrase || (passphrase !== null && passphrase === '')
    ? false
    : passphrase !== null
      ? true
      : Boolean(existing.encryptionEnabled);
  const candidateKeys = !willBeEncrypted
    ? null
    : passphrase !== null
      ? derivePassphraseKey(passphrase)
      : await loadPassphraseKey(dshHome).catch(() => null);
  const preProbeVault = new VaultStore({
    vaultDir: resolvedVaultDir,
    deviceId: existing.deviceId,
    platform: io.platform,
    secretKeys: candidateKeys,
    quotas: { ...(existing.quotas ?? {}), ...quotasPatch },
  });
  if (!flags.forceRotate) {
    const preStats = await preProbeVault.countReadableDeviceStats().catch(() => null);
    if (
      preStats
      && (
        (preStats.peerFailedCount > 0 && preStats.peerDecryptedCount === 0)
        || (preStats.totalFailedCount > 0 && preStats.totalDecryptedCount === 0)
      )
    ) {
      io.err(
        `错误：当前口令无法解密金库中已有设备的 ${preStats.peerFailedCount || preStats.totalFailedCount} 条加密提交（0 条可读）！已中止初始化以避免用错误口令污染金库；请核对其他设备的加密口令后重试（如确需强制更换新口令请附加 --force-rotate）。`,
      );
      return 1;
    }
  }

  // Opus F8c: Pull existing readable remote `workspace-mappings` from vault BEFORE building `--map`
  // entries so `init --map` immediately reuses canonical/legacy IDs (e.g., `"文章"`) from peers!
  let seedMappings = existing.workspaceMappings ?? [];
  try {
    const remoteMeta = await preProbeVault.listCommits('global', { targetId: 'workspace-mappings', includeSelf: false });
    const latestRemoteByDev = new Map();
    for (const c of remoteMeta.commits ?? []) {
      latestRemoteByDev.set(c.deviceId, c);
    }
    const remoteSeed = [];
    for (const c of latestRemoteByDev.values()) {
      const deletedMap = c.payload?.deletedMappingIds ?? {};
      for (const rm of c.payload?.workspaceMappings ?? []) {
        if (!rm?.id) continue;
        const rmTs = typeof rm.updatedAt === 'number' && Number.isFinite(rm.updatedAt) ? rm.updatedAt : 0;
        const delTs = Number(deletedMap[rm.id] ?? 0);
        if (delTs > (rmTs > 0 ? rmTs : Number(c.timestamp ?? 0))) continue;
        remoteSeed.push({ ...rm, updatedAt: rmTs });
      }
    }
    if (remoteSeed.length > 0) {
      seedMappings = mergeWorkspaceMappings(remoteSeed, seedMappings);
    }
  } catch {
    // Non-fatal: syncGlobalWorkspaceMetadata below will still converge deterministically
  }

  const parsedMaps = [];
  for (const spec of mapSpecs) {
    const parsed = parseWorkspaceMappingSpec(spec);
    if (parsed.win32) {
      const wv = validateWorkspaceDirectory(parsed.win32, 'win32', {
        dshHome: io.platform === 'win32' ? dshHome : undefined,
        vaultDir: io.platform === 'win32' ? resolvedVaultDir : undefined,
      });
      if (!wv.ok) {
        io.err(`错误：${wv.error}`);
        return 1;
      }
      parsed.win32 = wv.normalizedPath;
    }
    if (parsed.darwin) {
      const macCheckPlatform =
        process.platform === 'win32' && (/^[A-Za-z]:[\\/]/.test(parsed.darwin) || /^\\\\/.test(parsed.darwin))
          ? 'win32'
          : 'darwin';
      const mv = validateWorkspaceDirectory(parsed.darwin, macCheckPlatform, {
        dshHome: macCheckPlatform === process.platform ? dshHome : undefined,
        vaultDir: macCheckPlatform === process.platform ? resolvedVaultDir : undefined,
      });
      if (!mv.ok) {
        io.err(`错误：${mv.error}`);
        return 1;
      }
      parsed.darwin = mv.normalizedPath;
    }
    parsedMaps.push({ ...parsed, updatedAt: Date.now() });
  }
  const mergedMappings = mergeWorkspaceMappings(seedMappings, parsedMaps);

  let encryptionEnabled = existing.encryptionEnabled;
  if (clearPassphrase || (passphrase !== null && passphrase === '')) {
    await savePassphraseKey(dshHome, '');
    encryptionEnabled = false;
  } else if (passphrase !== null) {
    await savePassphraseKey(dshHome, passphrase);
    encryptionEnabled = true;
  }

  const saved = await saveConfig(dshHome, {
    vaultDir: resolvedVaultDir,
    deviceLabel: deviceLabel || os.hostname() || 'my-device',
    platform: io.platform,
    encryptionEnabled,
    stepSyncEnabled,
    ...(flags.scope !== null ? { syncScope: flags.scope } : {}),
    workspaceMappings: mergedMappings,
    ...(flags.fallbackDir !== null ? { fallbackDir: flags.fallbackDir ? path.resolve(flags.fallbackDir) : '' } : {}),
    quotas: quotasPatch,
  });

  const agentsRes = await ensureGlobalAgentsRules(dshHome);
  const skillDest = await syncHandoffSkill(dshHome);

  // Initialize controller to write initial device heartbeat & sync global workspace mappings into vault
  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
  });
  await controller.reloadConfig();
  if (controller.vault) {
    await controller.syncGlobalWorkspaceMetadata({ publishLocal: mergedMappings.length > 0 }).catch(() => {});
    await controller.updateHeartbeat({ status: 'initialized' });
  }
  const finalMappings = controller.config?.workspaceMappings ?? saved.workspaceMappings;

  io.out('初始化完成！');
  io.out(`- DSH 目录: ${dshHome}`);
  io.out(`- 防灾金库: ${saved.vaultDir}`);
  io.out(`- 加密模式: ${saved.encryptionEnabled ? 'AES-256-GCM 已开启（密钥仅保存在本机 soul-sync/secret.key，绝不进入金库）' : '明文模式'}`);
  io.out(`- 步级快照: ${saved.stepSyncEnabled !== false ? '已开启（运行中每 30 秒自动防断电快照）' : '已关闭（仅在每轮对话结束时安全同步）'}`);
  io.out(`- 设备身份: ${saved.deviceLabel} (${saved.deviceId} / ${io.platform})`);
  io.out(`- 工作区映射: ${finalMappings.length} 个`);
  for (const m of finalMappings) {
    io.out(`    · [${m.id}] Win=${m.win32 || '(未设)'} ⇄ Mac=${m.darwin || '(未设)'}`);
  }
  io.out(`- 全局规则: ${agentsRes.path}`);
  io.out(`- 接力技能: ${skillDest}`);
  return 0;
}

async function runStatus(dshHome, io) {
  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
  });
  await controller.reloadConfig();

  const card = await controller.formatStatusCard();
  io.out(card);

  const localSessions = await scanLocalSessions(dshHome);
  io.out(`- **本地会话总数**：${localSessions.size} 个`);

  const mappings = controller.config?.workspaceMappings ?? [];
  if (mappings.length === 0) {
    io.out('- **映射工作区**：尚未配置（可通过 `dsh-soul init --map` 添加）');
  } else {
    io.out(`- **映射工作区详情**（共 ${mappings.length} 个）：`);
    for (const m of mappings) {
      const localRoot = m[io.platform];
      const exists = localRoot ? await pathExists(localRoot) : false;
      const wsState = await loadWorkspaceDeliverableState(dshHome, m.id);
      const trackedCount = Object.keys(wsState.trackedPaths ?? {}).length;
      const stagedCount = Object.keys(wsState.pendingIncoming ?? {}).length;
      let lockText = '无占锁';
      if (exists) {
        const locks = await detectOpenOfficeLocks(localRoot, Object.keys(wsState.trackedPaths ?? {}));
        if (locks.length > 0) {
          lockText = `⚠️ 检测到 ${locks.length} 个 Excel/Office 锁 (${locks.map((l) => l.lockPath).join(', ')})`;
        }
      }
      io.out(
        `  - [${m.id}] ${localRoot || '(本系统未映射)'} ${exists ? '' : '[目录不存在] '}— 受管产出 ${trackedCount} 个 | .dsh-incoming 暂存 ${stagedCount} 个 | ${lockText}`,
      );
    }
  }
  return 0;
}

async function runCatalog(dshHome, io) {
  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
  });
  await controller.reloadConfig();
  const res = await controller.handleListCatalog();
  io.out(res.text);
  return 0;
}

async function runPush(flags, dshHome, io) {
  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
  });
  await controller.reloadConfig();

  if (!controller.vault) {
    io.err('错误：尚未配置防灾金库或缺少加密密钥，请先运行 `dsh-soul init`。');
    return 1;
  }

  const hasSelective = flags.onlySessions.length > 0 || flags.onlyWorkspaces.length > 0;
  if (hasSelective) {
    const localCat = await controller.listLocalCatalog();
    const resolved = controller._resolveCatalogTargets(
      localCat,
      [...flags.onlyWorkspaces, ...flags.onlySessions],
      false,
    );
    const wsPaths = [...new Set([...flags.onlyWorkspaces, ...resolved.workspaceSelectors])];
    const sids = [...new Set([...resolved.sessionIds, ...flags.onlySessions.filter((s) => s.length > 10)])];
    const selRes = await controller.pushSelected({
      workspacePaths: wsPaths,
      sessionIds: sids,
    });
    if (!selRes.ok) {
      io.err(`选择性推送失败：${selRes.reason}`);
      return 1;
    }
    const uploaded = selRes.workspaces.reduce((sum, w) => sum + w.uploaded.length, 0);
    io.out(`选择性推送完成：会话闭包 ${selRes.sessionPushedCount} 个；工作区产出上传 ${uploaded} 个。`);
    return 0;
  }

  // P1-2: Delegate non-selective push through SoulSyncController.pushAll() so CLI strictly enforces
  // `syncScope: 'selected'`, `excludedSessionIds`, `withdrawnSessions`, and encrypted workspace-mappings!
  const pushRes = await controller.pushAll();
  if (!pushRes.ok) {
    io.err(`推送失败：${pushRes.reason || '未知错误'}`);
    return 1;
  }

  const wsResults = [...(pushRes.workspaces ?? [])];
  const pushedIds = new Set(wsResults.map((w) => w.workspaceId ?? w.id).filter(Boolean));

  if (flags.workspace) {
    const resolvedWs = path.resolve(flags.workspace);
    if (!(await pathExists(resolvedWs))) {
      io.err(`错误：指定的工作区目录不存在：${resolvedWs}`);
      return 1;
    }
    const matched = controller._matchWorkspaceForPath(resolvedWs);
    const wsId = matched?.mapping?.id ?? deriveWorkspaceId(resolvedWs, resolvedWs);
    if (!pushedIds.has(wsId)) {
      const res = await pushWorkspaceDeliverables({
        dshHome,
        vault: controller.vault,
        workspaceId: wsId,
        workspaceRoot: matched?.localRoot ?? resolvedWs,
        deviceLabel: controller.config.deviceLabel,
        minQuietMs: io.minQuietMs ?? 0,
        quotas: controller.config.quotas,
      });
      wsResults.push({ id: wsId, title: matched?.mapping?.title ?? wsId, ...res });
    }
  }

  const totalUploaded = wsResults.reduce((sum, w) => sum + w.uploaded.length, 0);
  const totalDeleted = wsResults.reduce((sum, w) => sum + w.deleted.length, 0);
  const totalDeferred = wsResults.reduce((sum, w) => sum + w.deferred.length, 0);
  const totalBlocked = wsResults.reduce((sum, w) => sum + w.blocked.length, 0);
  const openLocks = wsResults.flatMap((w) => w.openLocks ?? []);

  io.out(
    `推送完成：会话闭包 ${pushRes.sessionPushedCount} 个（AGENTS.md ${pushRes.global?.published ? '已更新' : '无变化'}）；工作区产出上传 ${totalUploaded} / 删除 ${totalDeleted} / 延后 ${totalDeferred} / 拦截 ${totalBlocked}。`,
  );
  if (openLocks.length > 0) {
    io.out(`⚠️ 检测到未关闭的 Office 锁文件：${openLocks.map((l) => l.lockPath).join('、')}`);
  }
  await controller.dispose();
  return 0;
}

async function runPull(flags, dshHome, io) {
  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
  });
  await controller.reloadConfig();

  if (!controller.vault) {
    io.err('错误：尚未配置防灾金库或缺少加密密钥，请先运行 `dsh-soul init`。');
    return 1;
  }

  const desktopRunning = await io.checkDesktopRunning(io.platform);
  const skipSessions = desktopRunning && !flags.force;

  if (skipSessions) {
    io.out('⚠️ 检测到本机正在运行 DeepSeek Harness 桌面端：为避免与运行中的桌面端并发写入会话索引，本次已跳过离线会话导入。');
    io.out('   建议在 DSH 对话框内执行 `/soul pull`，或先右键退出托盘 DeepSeek Harness 后重试（也可传 `--force` 强制离线导入）。');
  }

  const hasSelective = flags.onlySessions.length > 0 || flags.onlyWorkspaces.length > 0;
  const targetOverrides = {};
  for (const spec of flags.targets) {
    const sep = spec.indexOf('::');
    if (sep <= 0) {
      io.err(`无效的 --target 参数「${spec}」，格式应为 <源路径或会话ID>::<本机目标目录>`);
      return 1;
    }
    const srcKey = stripOuterQuotes(spec.slice(0, sep));
    const dstDir = stripOuterQuotes(spec.slice(sep + 2));
    if (srcKey && dstDir) {
      targetOverrides[srcKey] = dstDir;
    }
  }

  if (hasSelective) {
    if (skipSessions) {
      io.out('⚠️ 检测到本机正在运行 DeepSeek Harness 桌面端：请改在 DSH 对话框内执行 `/soul pull ...` 或传 `--force`。');
      return 0;
    }
    const vaultCat = await controller.listVaultCatalog();
    const resolved = controller._resolveCatalogTargets(
      vaultCat,
      [...flags.onlyWorkspaces, ...flags.onlySessions],
      true,
    );
    const wsSources = [...new Set([...flags.onlyWorkspaces, ...resolved.workspaceSelectors])];
    const sids = [...new Set([...resolved.sessionIds, ...flags.onlySessions.filter((s) => s.length > 10)])];
    const selRes = await controller.pullSelected({
      workspaceSources: wsSources,
      sessionIds: sids,
      targetOverrides,
      saveMappings: flags.saveMapping,
    });
    if (!selRes.ok) {
      io.err(`选择性拉取失败：${selRes.reason}`);
      return 1;
    }
    const s = selRes.sessions.summary;
    const totalApplied = selRes.workspaces.reduce((acc, w) => acc + w.applied.length, 0);
    io.out(
      `选择性拉取完成：会话新增 ${s.imported} / 快进 ${s.fastForwarded} / 分叉 ${s.forkedBranches} / 跳过未对应 ${s.skippedUnmapped ?? 0}；产出更新 ${totalApplied} 个。`,
    );
    return 0;
  }

  // P1-2: Delegate non-selective pull through SoulSyncController.pullAll() so disaster recovery
  // receives encrypted cross-device `workspace-mappings`, `withdrawnSessions`, and persists `autoMirrorAssignments`!
  const pullRes = await controller.pullAll({
    silent: false,
    skipSessions,
    workspaceTargetOverrides: Object.keys(targetOverrides).length > 0 ? targetOverrides : null,
  });
  if (!pullRes.ok) {
    io.err(`拉取失败：${pullRes.reason || '未知错误'}`);
    await controller.dispose();
    return 1;
  }

  const globalRes = pullRes.global ?? { pulled: false };
  const sessionSummary = pullRes.sessions?.summary ?? { imported: 0, fastForwarded: 0, forkedBranches: 0, upToDate: 0 };
  const wsResults = pullRes.workspaces ?? [];

  const totalApplied = wsResults.reduce((s, w) => s + w.applied.length, 0);
  const totalDrained = wsResults.reduce((s, w) => s + w.drainedIncoming.length, 0);
  const totalConflicts = wsResults.reduce((s, w) => s + w.conflicts.length, 0);
  const totalStaged = wsResults.reduce((s, w) => s + w.stagedIncoming.length, 0);

  io.out(
    `拉取完成：AGENTS.md ${globalRes.pulled ? '已更新' : '最新'}；`
    + (skipSessions
      ? '会话导入已安全跳过（桌面端运行中）；'
      : `会话新增 ${sessionSummary.imported} / 快进 ${sessionSummary.fastForwarded} / 分叉 ${sessionSummary.forkedBranches}；`)
    + `产出更新 ${totalApplied} 个（排空 .dsh-incoming ${totalDrained} 个），冲突 ${totalConflicts} 个。`,
  );
  if (totalStaged > 0) {
    io.out(`⚠️ 有 ${totalStaged} 个文件因本地 Excel/Office 占锁已暂存于 .dsh-incoming/，关闭软件后再次运行 dsh-soul pull 即可自动落位。`);
  }
  await controller.dispose();
  return 0;
}

async function runUnpublish(args, dshHome, io) {
  if (!args || args.length === 0) {
    io.err('用法：dsh-soul unpublish <会话ID或短ID...>');
    return 1;
  }
  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
  });
  await controller.reloadConfig();
  const res = await controller.handleUnpublish({ targets: args });
  if (res.kind === 'error') {
    io.err(`错误：${res.text}`);
    return 1;
  }
  io.out(res.text);
  return 0;
}

async function runKeep(flags, args, dshHome, io) {
  const target = args[0];
  if (!target) {
    io.err('用法：dsh-soul keep <文件路径> [--workspace <工作区目录>]');
    return 1;
  }

  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
  });
  await controller.reloadConfig();

  let matched = null;
  let resolvedTarget = target;

  if (flags.workspace) {
    const absWs = path.resolve(flags.workspace);
    matched = controller._matchWorkspaceForPath(absWs);
    if (!matched) {
      const wsId = deriveWorkspaceId(absWs, absWs);
      matched = { mapping: { id: wsId, title: wsId }, localRoot: absWs };
    }
    resolvedTarget = path.isAbsolute(target) ? target : path.resolve(matched.localRoot, target);
  } else {
    const absCandidate = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    matched = controller._matchWorkspaceForPath(absCandidate) ?? controller._matchWorkspaceForPath(target);
    if (matched) {
      resolvedTarget = absCandidate;
    } else if (controller.config.workspaceMappings.length === 1) {
      const only = controller.config.workspaceMappings[0];
      const localRoot = only[io.platform];
      if (localRoot) {
        matched = { mapping: only, localRoot };
        resolvedTarget = path.isAbsolute(target) ? target : path.resolve(localRoot, target);
      }
    }
  }

  if (!matched) {
    io.err(`错误：路径「${target}」未匹配到任何已配置工作区，请使用 --workspace <dir> 指定。`);
    return 1;
  }

  const rec = await recordDeliverableCandidate(
    dshHome,
    matched.mapping.id,
    matched.localRoot,
    resolvedTarget,
    'manual',
  );
  if (!rec.recorded) {
    io.err(`错误：无法纳管「${target}」（原因：${rec.reason}）。`);
    return 1;
  }

  if (controller.vault) {
    const pushRes = await pushWorkspaceDeliverables({
      dshHome,
      vault: controller.vault,
      workspaceId: matched.mapping.id,
      workspaceRoot: matched.localRoot,
      deviceLabel: controller.config.deviceLabel,
      minQuietMs: io.minQuietMs ?? 0,
      quotas: controller.config.quotas,
    });
    const blockedItem = pushRes.blocked.find((b) => b.path === rec.relativePath);
    const deferredItem = pushRes.deferred.find((d) => d.path === rec.relativePath);
    if (blockedItem) {
      io.err(`已登记「${rec.relativePath}」，但推送被安全校验拦截：${blockedItem.reason}`);
      return 1;
    }
    if (deferredItem) {
      io.out(`已登记「${rec.relativePath}」，文件正在写入已延后推送（${deferredItem.reason}）。`);
      return 0;
    }
    controller._lastBackupAt = Date.now();
    await controller.updateHeartbeat({ status: 'active' });
    io.out(`已将「${rec.relativePath}」手动纳管（工作区 ${matched.mapping.id}）并立即推送至防灾金库。`);
  } else {
    io.out(`已将「${rec.relativePath}」登记进本地产出账本（尚未配置金库）。`);
  }
  return 0;
}

async function runConfig(args, dshHome, io) {
  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
  });
  await controller.reloadConfig();

  const res = await controller.handleConfig({ argsText: args.join(' ') });
  if (res.kind === 'error') {
    io.err(`错误：${res.text}`);
    return 1;
  }
  io.out(res.text);
  return 0;
}

async function checkProfilePluginRegistered(dshHome, profileName) {
  const profileDir = path.join(dshHome, 'profiles', profileName);
  const pkgPath = path.join(profileDir, 'package.json');
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    const inDeps = Boolean(pkg?.dependencies?.['dsh-soul-sync']);
    const inBundles = Array.isArray(pkg?.dsh?.profile?.bundles)
      && pkg.dsh.profile.bundles.includes('dsh-soul-sync');
    if (inDeps || inBundles) {
      return { registered: true, source: 'package.json' };
    }
  } catch {
    // Fall through to cordis.patch.yml check
  }

  for (const fileName of ['cordis.patch.yml', 'cordis.yml']) {
    try {
      const text = await fs.readFile(path.join(profileDir, fileName), 'utf8');
      if (text.includes('dsh-soul-sync')) {
        return { registered: true, source: fileName };
      }
    } catch {
      // ignore
    }
  }
  return { registered: false, source: null };
}

async function runDoctor(dshHome, io) {
  let criticalFailures = 0;
  const pass = (label, detail) => io.out(`[OK]   ${label}: ${detail}`);
  const warn = (label, detail) => io.out(`[WARN] ${label}: ${detail}`);
  const fail = (label, detail) => {
    criticalFailures += 1;
    io.out(`[FAIL] ${label}: ${detail}`);
  };

  io.out(`=== dsh-soul doctor (${dshHome}) ===`);

  // 1. config.json
  const configPath = path.join(soulSyncDir(dshHome), 'config.json');
  let config = null;
  if (!(await pathExists(configPath))) {
    fail('config.json', `缺失配置文件 ${configPath}（请运行 dsh-soul init）`);
  } else {
    try {
      config = await loadConfig(dshHome);
      pass('config.json', `已加载 (deviceLabel=${config.deviceLabel})`);
    } catch (err) {
      fail('config.json', `解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Vault readability & writability
  if (!config?.vaultDir) {
    fail('vaultDir', '未配置防灾金库路径');
  } else if (!(await pathExists(config.vaultDir))) {
    fail('vaultDir', `目录不存在: ${config.vaultDir}`);
  } else {
    const probeFile = path.join(config.vaultDir, `.doctor-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      await fs.writeFile(probeFile, 'ok', 'utf8');
      await fs.rm(probeFile, { force: true });
      pass('vaultDir', `可正常读写 (${config.vaultDir})`);
    } catch (err) {
      fail('vaultDir', `目录不可写 (${config.vaultDir}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Encryption key completeness & C3b vault decryption verification
  let loadedSecretKey = null;
  if (config) {
    if (config.encryptionEnabled) {
      try {
        const key = await loadPassphraseKey(dshHome);
        if (key && key.encKey.length === 32 && key.hmacKey.length === 32) {
          loadedSecretKey = key;
          pass('encryption', '已开启 AES-256-GCM 且本机 secret.key 完整');
        } else {
          fail('encryption', '已开启加密但缺少本机 secret.key，请重新运行 dsh-soul init --passphrase');
        }
      } catch (err) {
        fail('encryption', `secret.key 损坏: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      pass('encryption', '明文模式（未开启加密）');
    }

    // C3b: Test-decrypt existing vault commits so a mistyped passphrase on a 2nd machine fails doctor immediately!
    if (config.vaultDir && (await pathExists(config.vaultDir)) && (!config.encryptionEnabled || loadedSecretKey)) {
      try {
        const probeVault = new VaultStore({
          vaultDir: config.vaultDir,
          deviceId: config.deviceId,
          platform: io.platform,
          secretKeys: config.encryptionEnabled ? loadedSecretKey : null,
          quotas: config.quotas,
        });
        const stats = await probeVault.countReadableDeviceStats();
        const allCommitsFailed = stats.totalFailedCount > 0 && stats.totalDecryptedCount === 0;
        const allPeerCommitsFailed = stats.peerFailedCount > 0 && stats.peerDecryptedCount === 0;
        if (allCommitsFailed || allPeerCommitsFailed) {
          fail(
            'vault-decrypt',
            allCommitsFailed
              ? `金库中有 ${stats.totalFailedCount} 条现有提交全部解密失败（0 条可读）——本机口令与金库已有设备不一致，请核对口令后重新配置`
              : `金库中对端设备的 ${stats.peerFailedCount} 条提交全部解密失败（0 条可读，仅本机提交可读）——本机口令与已有对端设备不一致，请核对口令后重新配置`,
          );
        } else if (stats.totalFailedCount > 0) {
          warn(
            'vault-decrypt',
            `当前口令可读 ${stats.totalDecryptedCount} 条提交，但金库中仍有 ${stats.totalFailedCount} 条旧/错口令提交无法解密`,
          );
        } else if (stats.totalDecryptedCount > 0) {
          pass('vault-decrypt', `成功解密验证金库现有 ${stats.totalDecryptedCount} 条提交`);
        }
      } catch (err) {
        warn('vault-decrypt', `金库解密校验出错: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 4. skills/soul-handoff/SKILL.md
  const skillPath = path.join(dshHome, 'skills', 'soul-handoff', 'SKILL.md');
  if (await pathExists(skillPath)) {
    const skillText = await fs.readFile(skillPath, 'utf8');
    if (skillText.includes('name: soul-handoff')) {
      pass('soul-handoff skill', `已就绪 (${skillPath})`);
    } else {
      fail('soul-handoff skill', `文件缺少 name: soul-handoff frontmatter (${skillPath})`);
    }
  } else {
    fail('soul-handoff skill', `缺失技能文件 ${skillPath}`);
  }

  // 5. Global AGENTS.md rules block
  const agentsPath = path.join(dshHome, 'AGENTS.md');
  if (await pathExists(agentsPath)) {
    const agentsText = await fs.readFile(agentsPath, 'utf8');
    if (agentsText.includes(GLOBAL_AGENTS_RULES_MARKER)) {
      pass('AGENTS.md', '包含跨平台工作流规范规则块');
    } else {
      fail('AGENTS.md', `缺少规则块标记 ${GLOBAL_AGENTS_RULES_MARKER}`);
    }
  } else {
    fail('AGENTS.md', `缺失全局规则文件 ${agentsPath}`);
  }

  // 6. DSH profiles plugin registration (web & desktop)
  const webReg = await checkProfilePluginRegistered(dshHome, 'web');
  const desktopReg = await checkProfilePluginRegistered(dshHome, 'desktop');
  if (webReg.registered) {
    pass('profile/web', `dsh-soul-sync 已注册 (${webReg.source})`);
  } else {
    warn('profile/web', '未检测到 dsh-soul-sync 插件注册');
  }
  if (desktopReg.registered) {
    pass('profile/desktop', `dsh-soul-sync 已注册 (${desktopReg.source})`);
  } else {
    warn('profile/desktop', '未检测到 dsh-soul-sync 插件注册');
  }
  if (!webReg.registered && !desktopReg.registered) {
    fail('profiles', 'web 与 desktop profile 均未注册 dsh-soul-sync 插件（请运行一键安装脚本）');
  }

  // 7. Workspace mappings & Office locks
  const mappings = config?.workspaceMappings ?? [];
  if (mappings.length === 0) {
    warn('workspaces', '尚未配置跨设备工作区映射');
  } else {
    for (const m of mappings) {
      const localRoot = m[io.platform];
      if (!localRoot) {
        warn(`workspace[${m.id}]`, `当前系统 (${io.platform}) 未配置本地路径`);
        continue;
      }
      if (!(await pathExists(localRoot))) {
        warn(`workspace[${m.id}]`, `本地目录尚不存在: ${localRoot}`);
        continue;
      }
      const wsState = await loadWorkspaceDeliverableState(dshHome, m.id);
      const locks = await detectOpenOfficeLocks(localRoot, Object.keys(wsState.trackedPaths ?? {}));
      if (locks.length > 0) {
        warn(`workspace[${m.id}]`, `目录存在，但检测到未关闭的 Office 锁：${locks.map((l) => l.lockPath).join(', ')}`);
      } else {
        pass(`workspace[${m.id}]`, `目录可访问且无 Office 占锁 (${localRoot})`);
      }
    }
  }

  if (criticalFailures > 0) {
    io.out(`\n体检未通过：发现 ${criticalFailures} 项关键问题。`);
    return 1;
  }
  io.out('\n体检通过：全部核心组件运行健康！');
  return 0;
}

async function runWatch(flags, dshHome, io) {
  const intervalMs = flags.intervalMs !== null
    ? Math.max(50, Math.round(parsePositiveNumber(flags.intervalMs, '--interval-ms')))
    : 60000;

  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 1500,
  });
  await controller.reloadConfig();
  if (!controller.vault) {
    io.err('错误：尚未配置防灾金库或缺少加密密钥，无法启动 watch。');
    return 1;
  }

  const watchers = [];
  for (const mapping of controller.config.workspaceMappings ?? []) {
    const localRoot = mapping[io.platform];
    if (!localRoot || !(await pathExists(localRoot))) continue;
    try {
      const handle = createActiveWorkspaceWatcher(localRoot, async (relPosix) => {
        await recordDeliverableCandidate(dshHome, mapping.id, localRoot, relPosix, 'watcher').catch(() => {});
      });
      watchers.push(handle);
    } catch {
      // Ignore individual watcher startup error
    }
  }

  io.out(`已启动 dsh-soul watch 守护模式（周期 ${intervalMs}ms，监听工作区 ${watchers.length} 个）...`);

  let stopped = false;
  let runningTick = false;

  const runTick = async () => {
    if (stopped || runningTick) return;
    runningTick = true;
    try {
      await controller.pushAll();
    } catch (err) {
      io.err(`[watch] 同步周期出错: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      runningTick = false;
    }
  };

  await runTick();

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      void runTick();
    }, intervalMs);

    const shutdown = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      if (io.signal) {
        io.signal.removeEventListener('abort', shutdown);
      }
      resolve();
    };

    if (io.signal?.aborted) {
      shutdown();
      return;
    }
    if (io.signal) {
      io.signal.addEventListener('abort', shutdown, { once: true });
    }
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  await Promise.allSettled(watchers.map((w) => w.close()));
  await controller.dispose();
  io.out('dsh-soul watch 已优雅退出。');
  return 0;
}

async function runDisconnect(dshHome, io) {
  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
    pollIntervalMs: 0,
  });
  await controller.reloadConfig();
  await controller.disconnectVault();
  await controller.dispose();
  io.out('已断开防灾金库连接并暂停同步（本机全部对话与工作区文件均保持原样未删）。');
  return 0;
}

async function runReset(dshHome, io) {
  const controller = new SoulSyncController(null, {
    dshHome,
    platform: io.platform,
    minQuietMs: io.minQuietMs ?? 0,
    pollIntervalMs: 0,
  });
  await controller.reloadConfig();
  await controller.resetLocalConfig();
  await controller.dispose();
  io.out('已重置本机 Soul Sync 配置与密钥（本机对话、工作区文件与登录凭据均保持原样未删）。');
  return 0;
}

async function runUninstall(dshHome, io) {
  const res = await uninstallPluginFromDshHome(dshHome);
  io.out('dsh-soul-sync 插件已安全卸载完成！');
  io.out(`- 已清理 Profile 注册: ${res.removedProfiles.length > 0 ? res.removedProfiles.join(', ') : '(无)'}`);
  io.out(`- 已移除符号链接: ${res.removedLinks.length} 个（未触碰插件源仓库目录）`);
  io.out(`- 已移除接力技能: ${res.removedSkill ? '是' : '未安装'}`);
  io.out(`- 已剥离 AGENTS.md 跨机规则块: ${res.updatedAgentsMd ? '是（保留其他个人规则）' : '无需变更'}`);
  io.out(`- 已清理 soul-sync 配置目录: ${res.removedSoulSyncDir ? '是' : '未创建'}`);
  io.out('- 100% 完整保留：本机全部历史对话、工作区文件、登录凭据与网盘金库数据。');
  io.out('提示：请退出并重新打开一次 DeepSeek Harness 以完成界面移除。');
  return 0;
}

const VALID_PLATFORMS = new Set(['win32', 'darwin', 'linux']);

export async function runCli(argv = [], ioOverrides = {}) {
  const io = makeIo(ioOverrides);
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    io.err(`参数错误：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { flags, positionals } = parsed;

  if (flags.platform !== null) {
    if (!VALID_PLATFORMS.has(flags.platform)) {
      io.err(`参数错误：--platform 仅支持 win32 / darwin / linux，当前收到：${flags.platform}`);
      return 1;
    }
    io.platform = flags.platform;
  }

  if (flags.version) {
    io.out(`dsh-soul ${await readPackageVersion()}`);
    return 0;
  }

  const subcommand = positionals[0];
  if (flags.help || !subcommand || subcommand === 'help') {
    io.out(formatHelpText());
    return 0;
  }

  const dshHome = resolveDshHome(flags.dshHome ?? io.env?.DSH_HOME);
  const subArgs = positionals.slice(1);

  try {
    switch (subcommand) {
      case 'init':
        return await runInit(flags, dshHome, io);
      case 'status':
        return await runStatus(dshHome, io);
      case 'catalog':
      case 'list':
        return await runCatalog(dshHome, io);
      case 'push':
        return await runPush(flags, dshHome, io);
      case 'pull':
        return await runPull(flags, dshHome, io);
      case 'unpublish':
        return await runUnpublish(subArgs, dshHome, io);
      case 'keep':
        return await runKeep(flags, subArgs, dshHome, io);
      case 'config':
        return await runConfig(subArgs, dshHome, io);
      case 'doctor':
        return await runDoctor(dshHome, io);
      case 'watch':
        return await runWatch(flags, dshHome, io);
      case 'disconnect':
        return await runDisconnect(dshHome, io);
      case 'reset':
        return await runReset(dshHome, io);
      case 'uninstall':
        return await runUninstall(dshHome, io);
      case 'update': {
        const upd = await applyRemoteUpdate({ repoRoot: REPO_ROOT, dshHome });
        if (!upd.ok) {
          io.err(`更新未执行：${upd.error}`);
          return 1;
        }
        if (upd.alreadyLatest) {
          io.out(`当前已是最新版本（#${upd.remoteShort}），无需更新。`);
        } else {
          io.out(`已更新至最新版本 #${upd.remoteShort}（方式: ${upd.method}）。请重启 DeepSeek Harness 生效。`);
        }
        return 0;
      }
      default:
        io.err(`未知子命令：${subcommand}\n\n${formatHelpText()}`);
        return 1;
    }
  } catch (err) {
    io.err(`执行失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const selfPath = fsSync.realpathSync(__filename);
    const argPath = fsSync.realpathSync(path.resolve(process.argv[1]));
    if (process.platform === 'win32') {
      return selfPath.toLowerCase() === argPath.toLowerCase();
    }
    return selfPath === argPath;
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isMainModule()) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
