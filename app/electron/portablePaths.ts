import fs from 'node:fs';
import path from 'node:path';
import type { App } from 'electron';

export interface PortablePaths {
  installDir: string;
  dataRoot: string;
  chromiumUserData: string;
  chromiumSessionData: string;
  chromiumCache: string;
  tempDir: string;
  logsDir: string;
  sessionDir: string;
  dbDir: string;
  storesDir: string;
  previewsCacheDir: string;
  thumbnailsCacheDir: string;
  offlineCacheDir: string;
  stagingCacheDir: string;
}

let cachedPaths: PortablePaths | null = null;

/**
 * Redirects ALL Electron / Chromium / application storage into `<InstallDir>/data/`
 * BEFORE `app.whenReady()` so nothing is ever written to `%APPDATA%` or `%LOCALAPPDATA%`.
 */
export function initPortablePaths(app: App): PortablePaths {
  if (cachedPaths) return cachedPaths;

  const isPackaged = app.isPackaged;
  const installDir = isPackaged
    ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)
    : path.resolve(process.cwd());

  const dataRoot = isPackaged
    ? path.join(installDir, 'data')
    : path.join(installDir, 'data-dev');

  const paths: PortablePaths = {
    installDir,
    dataRoot,
    chromiumUserData: path.join(dataRoot, 'chromium'),
    chromiumSessionData: path.join(dataRoot, 'chromium-session'),
    chromiumCache: path.join(dataRoot, 'chromium-cache'),
    tempDir: path.join(dataRoot, 'temp'),
    logsDir: path.join(dataRoot, 'logs'),
    sessionDir: path.join(dataRoot, 'session'),
    dbDir: path.join(dataRoot, 'db'),
    storesDir: path.join(dataRoot, 'stores'),
    previewsCacheDir: path.join(dataRoot, 'cache', 'previews'),
    thumbnailsCacheDir: path.join(dataRoot, 'cache', 'thumbnails'),
    offlineCacheDir: path.join(dataRoot, 'cache', 'offline'),
    stagingCacheDir: path.join(dataRoot, 'cache', 'staging'),
  };

  for (const dir of Object.values(paths)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  app.setPath('userData', paths.chromiumUserData);
  app.setPath('sessionData', paths.chromiumSessionData);
  app.setPath('cache', paths.chromiumCache);
  app.setPath('temp', paths.tempDir);
  app.setPath('logs', paths.logsDir);
  app.setAppLogsPath(paths.logsDir);

  cachedPaths = paths;
  return paths;
}

export function getPortablePaths(): PortablePaths {
  if (!cachedPaths) {
    throw new Error('Portable paths have not been initialized yet.');
  }
  return cachedPaths;
}
