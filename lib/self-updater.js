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
  const hasUpdate = !localInfo.commit || localInfo.commit !== remoteCommit;

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

  // Strategy 1: Clean git fast-forward when .git exists and git CLI is available
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
      } catch {
        // Fall through to zero-Git HTTPS tarball update below!
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

  const tmpDir = path.join(
    os.tmpdir(),
    `dsh-soul-upd-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  const archivePath = path.join(tmpDir, 'release.tar.gz');
  const extractDir = path.join(tmpDir, 'extracted');

  try {
    await fs.mkdir(extractDir, { recursive: true });
    await fs.writeFile(archivePath, tarBytes);

    // Inspect archive entries BEFORE extracting to prevent any path traversal
    const { stdout: listOut } = await execFileAsync('tar', ['-tzf', archivePath], {
      timeout: 15000,
      windowsHide: true,
    });
    const archiveEntries = String(listOut ?? '').split(/\r?\n/).filter(Boolean);
    if (archiveEntries.length === 0 || archiveEntries.some(isUnsafeArchiveEntry)) {
      throw new Error('更新包路径安全校验未通过，已拒绝解压');
    }

    await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], {
      timeout: 20000,
      windowsHide: true,
    });

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
