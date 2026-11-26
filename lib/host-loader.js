import fsSync from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Dynamically import a `@deepseek-ai/*` package from the active DSH host runtime.
 * Falls back cleanly to `null` in standalone pure-Node CLI / unit test environments,
 * while resolving into Electron DSH's `app.asar/dsh` even when `dsh-soul-sync` is
 * mounted via `link:` outside `app.asar/dsh/node_modules`.
 *
 * @param {string} specifier
 * @returns {Promise<any | null>}
 */
export async function importHostPackage(specifier) {
  try {
    return await import(specifier);
  } catch {
    // External linked plugin outside app.asar/dsh/node_modules -> probe DSH host runtime roots
  }

  const candidatePkgJsons = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidatePkgJsons.push(
      path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'),
      path.join(process.resourcesPath, 'dsh', 'package.json'),
    );
  }
  const execDir = path.dirname(process.execPath);
  candidatePkgJsons.push(
    path.join(execDir, 'resources', 'app.asar', 'dsh', 'package.json'),
    path.join(execDir, '..', 'Resources', 'app.asar', 'dsh', 'package.json'),
  );

  for (const anchor of candidatePkgJsons) {
    try {
      if (!fsSync.existsSync(anchor)) continue;
      const req = createRequire(anchor);
      const resolved = req.resolve(specifier);
      return await import(pathToFileURL(resolved).href);
    } catch {
      // Try next host anchor
    }
  }
  return null;
}
