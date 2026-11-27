import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ensureGlobalAgentsRules, resolveDshHome, writeFileAtomic } from './config.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_GITHUB_REPO = 'yulong1993/dsh-soul-sync';
export const DEFAULT_GITHUB_BRANCH = 'main';
export const VERSION_STAMP_FILENAME = '.dsh-soul-version.json';

const SAFE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_TARBALL_BYTES = 25 * 1024 * 1024; // 25 MB safety cap
const PRESERVED_TOP_ENTRIES = new Set(['.git', 'node_modules', '.test-tmp', VERSION_STAMP_FILENAME]);

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isUnsafeArchiveEntry(entryLine) {
  const clean = String(entryLine ?? '').trim();
  if (!clean) return false;
  if (clean.startsWith('/') || clean.startsWith('\\') || /^[A-Za-z]:/.test(clean)) {
    return true;
  }
  const normalized = clean.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.some((seg) => seg === '..');
}

function isUnsafeVerboseTarLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return false;
  const typeChar = trimmed[0];
  // Reject symlinks (l), hardlinks (h), block/char devices (b/c), and FIFOs (p)
  return typeChar === 'l' || typeChar === 'h' || typeChar === 'b' || typeChar === 'c' || typeChar === 'p';
}

async function assertSafeExtractedTree(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    const lst = await fs.lstat(fullPath);
    if (lst.isSymbolicLink()) {
      throw new Error(`更新包内包含不安全的符号链接（${entry.name}），已拒绝更新`);
    }
    if (lst.isDirectory()) {
      await assertSafeExtractedTree(fullPath);
    } else if (lst.isFile() && (lst.nlink ?? 1) > 1) {
      throw new Error(`更新包内包含不安全的硬链接（${entry.name}），已拒绝更新`);
    } else if (!lst.isFile()) {
      throw new Error(`更新包内包含非常规特殊文件（${entry.name}），已拒绝更新`);
    }
  }
}

async function isCommitAncestorOfHead(repoRoot, ancestorCommit) {
  if (!COMMIT_SHA_RE.test(String(ancestorCommit ?? ''))) return false;
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestorCommit, 'HEAD'], {
      cwd: repoRoot,
      timeout: 4000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function copyExtractedTreeAtomically(srcDir, destDir, isTopLevel = true) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (isTopLevel && PRESERVED_TOP_ENTRIES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyExtractedTreeAtomically(srcPath, dstPath, false);
    } else if (entry.isFile()) {
      let bytes = await fs.readFile(srcPath);
      const isShellOrBin = entry.name.endsWith('.sh') || entry.name === 'dsh-soul.js';
      if (isShellOrBin) {
        bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
      }
      const mode = isShellOrBin ? 0o755 : 0o644;
      await writeFileAtomic(dstPath, bytes, { mode });
      if (isShellOrBin && process.platform !== 'win32') {
        await fs.chmod(dstPath, 0o755).catch(() => {});
      }
    }
  }
}

async function refreshInstalledSkillAndRulesIfConfigured(repoRoot, dshHome) {
  if (!dshHome) return;
  const homeDir = resolveDshHome(dshHome);
  const ssDir = path.join(homeDir, 'soul-sync');
  if (!(await pathExists(ssDir))) return;

  const srcSkill = path.join(repoRoot, 'skills', 'soul-handoff', 'SKILL.md');
  if (await pathExists(srcSkill)) {
    const dstSkill = path.join(homeDir, 'skills', 'soul-handoff', 'SKILL.md');
    const skillBytes = await fs.readFile(srcSkill);
    await writeFileAtomic(dstSkill, skillBytes, { mode: 0o644 }).catch(() => {});
  }
  await ensureGlobalAgentsRules(homeDir).catch(() => {});
}

export async function readLocalVersionInfo(repoRoot) {
  let version = '0.1.0';
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.trim()) {
      version = pkg.version.trim();
    }
  } catch {
    // ignore
  }

  const hasGitDir = await pathExists(path.join(repoRoot, '.git'));
  let commit = null;
  if (hasGitDir) {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        timeout: 5000,
        windowsHide: true,
      });
      const trimmed = String(stdout ?? '').trim();
      if (COMMIT_SHA_RE.test(trimmed)) {
        commit = trimmed.toLowerCase();
      }
    } catch {
      // git binary not installed or unavailable; fallback to stamp file below
    }
  }

  if (!commit) {
    try {
      const stamp = JSON.parse(await fs.readFile(path.join(repoRoot, VERSION_STAMP_FILENAME), 'utf8'));
      if (typeof stamp?.commit === 'string' && COMMIT_SHA_RE.test(stamp.commit.trim())) {
        commit = stamp.commit.trim().toLowerCase();
      }
    } catch {
      // no stamp yet
    }
  }

  return {
    version,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    hasGitDir,
  };
}

export async function checkRemoteUpdate({
  repoRoot,
  githubRepo = DEFAULT_GITHUB_REPO,
  branch = DEFAULT_GITHUB_BRANCH,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!SAFE_REPO_RE.test(githubRepo)) {
    throw new Error(`非法仓库标识：${githubRepo}`);
  }
  if (!SAFE_BRANCH_RE.test(branch) || branch.includes('..')) {
    throw new Error(`非法分支名：${branch}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境不支持在线检查更新（缺少 fetch）');
  }

  const localInfo = await readLocalVersionInfo(repoRoot);
  const apiUrl = `https://api.github.com/repos/${githubRepo}/commits/${branch}`;

  let resp;
  try {
    resp = await fetchImpl(apiUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-soul-sync-updater',
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    throw new Error(`无法连接 GitHub 检查更新（请检查网络或代理）：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!resp.ok) {
    if (resp.status === 403 || resp.status === 429) {
      throw new Error(`GitHub 检查更新触发接口限流（HTTP ${resp.status}），请稍等几分钟再试`);
    }
    throw new Error(`GitHub 检查更新返回 HTTP ${resp.status}（请稍后重试或检查网络）`);
  }

  const data = await resp.json();
  const remoteCommit = String(data?.sha ?? '').trim().toLowerCase();
  if (!COMMIT_SHA_RE.test(remoteCommit)) {
    throw new Error('GitHub 返回的版本号格式异常');
  }

  const rawMsg = String(data?.commit?.message ?? '').trim();
  const remoteMessage = (rawMsg.split(/\r?\n/)[0] || '最新版本').slice(0, 120);
  const remoteDate = data?.commit?.committer?.date ?? data?.commit?.author?.date ?? null;
  let localAhead = false;
  if (localInfo.hasGitDir && localInfo.commit && localInfo.commit !== remoteCommit) {
    localAhead = await isCommitAncestorOfHead(repoRoot, remoteCommit);
  }
  const hasUpdate = !localAhead && (!localInfo.commit || localInfo.commit !== remoteCommit);

  return {
    ok: true,
    version: localInfo.version,
    hasGitDir: localInfo.hasGitDir,
    localCommit: localInfo.commit,
    localShort: localInfo.shortCommit,
    remoteCommit,
    remoteShort: remoteCommit.slice(0, 7),
    remoteMessage,
    remoteDate,
    localAhead,
    hasUpdate,
  };
}

export async function applyRemoteUpdate({
  repoRoot,
  dshHome = undefined,
  githubRepo = DEFAULT_GITHUB_REPO,
  branch = DEFAULT_GITHUB_BRANCH,
  fetchImpl = globalThis.fetch,
  forceTarball = false,
} = {}) {
  const check = await checkRemoteUpdate({ repoRoot, githubRepo, branch, fetchImpl });
  const stampPath = path.join(repoRoot, VERSION_STAMP_FILENAME);

  if (!check.hasUpdate) {
    if (!check.hasGitDir) {
      await writeFileAtomic(
        stampPath,
        `${JSON.stringify({ commit: check.remoteCommit, updatedAt: Date.now() }, null, 2)}\n`,
        { mode: 0o644 },
      ).catch(() => {});
    }
    return {
      ...check,
      updated: false,
      alreadyLatest: true,
      method: 'none',
    };
  }

  // Strategy 1: Clean git fast-forward when .git exists and git CLI is available.
  // P0-2: NEVER fall through to Tarball if `.git` + `git` CLI is active — overwriting tracked files
  // while `.git/HEAD` stays at the old commit would leave the repo dirty and permanently deadlocked!
  if (!forceTarball && check.hasGitDir) {
    let gitAvailable = false;
    let dirtyTracked = false;
    try {
      const { stdout: statusOut } = await execFileAsync(
        'git',
        ['status', '--porcelain', '--untracked-files=no'],
        { cwd: repoRoot, timeout: 5000, windowsHide: true },
      );
      gitAvailable = true;
      dirtyTracked = String(statusOut ?? '').trim().length > 0;
    } catch {
      gitAvailable = false;
    }

    if (gitAvailable && dirtyTracked) {
      return {
        ok: false,
        updated: false,
        error: '检测到插件目录内存在未提交的本地代码修改，为保护本地修改已跳过自动覆盖（开发环境下请手动 git pull）。',
      };
    }

    if (gitAvailable) {
      try {
        const httpsUrl = `https://github.com/${githubRepo}.git`;
        await execFileAsync('git', ['fetch', httpsUrl, branch], {
          cwd: repoRoot,
          timeout: 25000,
          windowsHide: true,
        });
        // Check again after fetch in case remoteCommit wasn't in local git object database earlier
        if (await isCommitAncestorOfHead(repoRoot, check.remoteCommit)) {
          return {
            ...check,
            hasUpdate: false,
            updated: false,
            alreadyLatest: true,
            localAhead: check.localCommit !== check.remoteCommit,
            method: 'none',
          };
        }
        await execFileAsync('git', ['merge', '--ff-only', check.remoteCommit], {
          cwd: repoRoot,
          timeout: 10000,
          windowsHide: true,
        });
        await writeFileAtomic(
          stampPath,
          `${JSON.stringify({ commit: check.remoteCommit, updatedAt: Date.now() }, null, 2)}\n`,
          { mode: 0o644 },
        ).catch(() => {});
        await refreshInstalledSkillAndRulesIfConfigured(repoRoot, dshHome);
        return {
          ...check,
          localCommit: check.remoteCommit,
          localShort: check.remoteShort,
          hasUpdate: false,
          updated: true,
          alreadyLatest: false,
          method: 'git',
        };
      } catch (err) {
        return {
          ok: false,
          updated: false,
          error: `Git 快进更新未完成（可能网络超时或本地分支与远端分叉，为保护 Git 仓库已中止覆盖）：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  // Strategy 2: Zero-Git HTTPS tarball download & atomic extraction (works for non-Git colleague installs!)
  const tarballUrl = `https://codeload.github.com/${githubRepo}/tar.gz/${check.remoteCommit}`;
  let tarResp;
  try {
    tarResp = await fetchImpl(tarballUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'dsh-soul-sync-updater' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(`下载更新包失败（请检查网络）：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!tarResp.ok) {
    throw new Error(`下载更新包返回 HTTP ${tarResp.status}`);
  }

  const tarBytes = Buffer.from(await tarResp.arrayBuffer());
  if (tarBytes.length < 128) {
    throw new Error('下载到的更新包体积异常，已中止覆盖');
  }
  if (tarBytes.length > MAX_TARBALL_BYTES) {
    throw new Error('下载到的更新包体积超过安全上限（25MB），已中止覆盖');
  }

  const tmpDir = path.join(
    os.tmpdir(),
    `dsh-soul-upd-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  const archiveFileName = 'release.tar.gz';
  const extractDirName = 'extracted';
  const archivePath = path.join(tmpDir, archiveFileName);
  const extractDir = path.join(tmpDir, extractDirName);

  try {
    await fs.mkdir(extractDir, { recursive: true });
    await fs.writeFile(archivePath, tarBytes);

    // P1-3: Pass relative filenames with `cwd: tmpDir` so Git/MSYS2 GNU `tar.exe` on Windows
    // NEVER misinterprets `C:\...` drive colons as remote hosts (`Cannot connect to C: resolve failed`),
    // and inspect BOTH `-tzf` paths AND `-tvzf` entry types to reject symlinks/hardlinks BEFORE extraction!
    const { stdout: listOut } = await execFileAsync('tar', ['-tzf', archiveFileName], {
      cwd: tmpDir,
      timeout: 15000,
      windowsHide: true,
    });
    const archiveEntries = String(listOut ?? '').split(/\r?\n/).filter(Boolean);
    if (archiveEntries.length === 0 || archiveEntries.some(isUnsafeArchiveEntry)) {
      throw new Error('更新包路径安全校验未通过，已拒绝解压');
    }

    const { stdout: verboseOut } = await execFileAsync('tar', ['-tvzf', archiveFileName], {
      cwd: tmpDir,
      timeout: 15000,
      windowsHide: true,
    });
    const verboseLines = String(verboseOut ?? '').split(/\r?\n/).filter(Boolean);
    if (verboseLines.some(isUnsafeVerboseTarLine)) {
      throw new Error('更新包包含不安全的链接或特殊文件条目，已拒绝解压');
    }

    await execFileAsync('tar', ['-xzf', archiveFileName, '-C', extractDirName], {
      cwd: tmpDir,
      timeout: 20000,
      windowsHide: true,
    });
    await assertSafeExtractedTree(extractDir);

    const topItems = await fs.readdir(extractDir, { withFileTypes: true });
    const subDirs = topItems.filter((d) => d.isDirectory());
    const unpackedRoot = subDirs.length === 1 && topItems.length === 1
      ? path.join(extractDir, subDirs[0].name)
      : extractDir;

    const pkgPath = path.join(unpackedRoot, 'package.json');
    const indexJsPath = path.join(unpackedRoot, 'lib', 'index.js');
    const clientJsPath = path.join(unpackedRoot, 'lib', 'client.js');
    if (!(await pathExists(pkgPath)) || !(await pathExists(indexJsPath)) || !(await pathExists(clientJsPath))) {
      throw new Error('更新包结构不完整（缺少核心入口文件），已取消覆盖');
    }
    const unpackedPkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    if (unpackedPkg?.name !== 'dsh-soul-sync') {
      throw new Error(`更新包名不匹配（${unpackedPkg?.name || 'unknown'}），已取消覆盖`);
    }

    await copyExtractedTreeAtomically(unpackedRoot, repoRoot, true);
    await writeFileAtomic(
      stampPath,
      `${JSON.stringify({ commit: check.remoteCommit, updatedAt: Date.now() }, null, 2)}\n`,
      { mode: 0o644 },
    );
    await refreshInstalledSkillAndRulesIfConfigured(repoRoot, dshHome);

    return {
      ...check,
      localCommit: check.remoteCommit,
      localShort: check.remoteShort,
      hasUpdate: false,
      updated: true,
      alreadyLatest: false,
      method: 'tarball',
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }).catch(() => {});
  }
}
