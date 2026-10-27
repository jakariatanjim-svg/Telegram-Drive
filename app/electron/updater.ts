import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import {
  GITHUB_LATEST_RELEASE_API,
  GITHUB_RELEASES_URL,
  compareVersions,
  formatDisplayVersion,
  parseMajorMinor,
  pickPlatformReleaseAsset,
  type GithubLatestReleasePayload,
} from '../shared/versioning';
import { getPortablePaths } from './portablePaths';

export interface UpdateCheckResponse {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string | null;
  assetName: string | null;
  assetSize: number;
  releaseUrl: string;
}

export async function checkGithubUpdate(currentVersionRaw: string): Promise<UpdateCheckResponse> {
  const currentVersion = formatDisplayVersion(currentVersionRaw, '1.0');
  const res = await fetch(GITHUB_LATEST_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Telegram-Drive/${currentVersion}`,
    },
  });

  if (res.status === 404) {
    return {
      available: false,
      currentVersion,
      latestVersion: null,
      downloadUrl: null,
      assetName: null,
      assetSize: 0,
      releaseUrl: GITHUB_RELEASES_URL,
    };
  }

  if (!res.ok) {
    throw new Error(`GitHub Releases check failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as GithubLatestReleasePayload;
  const parsedLatest = parseMajorMinor(data.tag_name ?? data.name ?? '');
  if (!parsedLatest) {
    return {
      available: false,
      currentVersion,
      latestVersion: null,
      downloadUrl: null,
      assetName: null,
      assetSize: 0,
      releaseUrl: data.html_url || GITHUB_RELEASES_URL,
    };
  }

  const isNewer = compareVersions(parsedLatest.display, currentVersion) > 0;
  const asset = pickPlatformReleaseAsset(data.assets, 'windows');

  return {
    available: Boolean(isNewer && asset),
    currentVersion,
    latestVersion: parsedLatest.display,
    downloadUrl: asset?.browser_download_url ?? null,
    assetName: asset?.name ?? null,
    assetSize: asset?.size ?? 0,
    releaseUrl: data.html_url || GITHUB_RELEASES_URL,
  };
}

export async function downloadAndInstallWindowsUpdate(
  downloadUrl: string,
  assetName: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  if (!app.isPackaged) {
    await shell.openExternal(GITHUB_RELEASES_URL);
    return;
  }

  const paths = getPortablePaths();
  const safeName = path.basename(assetName || 'Telegram-Drive-portable-setup.exe');
  const destPath = path.join(paths.tempDir, safeName);

  const response = await fetch(downloadUrl, {
    headers: { 'User-Agent': 'Telegram-Drive-Updater' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download update installer (HTTP ${response.status})`);
  }

  const totalBytes = Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0;
  let downloaded = 0;

  const fileStream = fs.createWriteStream(destPath);
  const reader = response.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        downloaded += value.byteLength;
        fileStream.write(Buffer.from(value));
        if (totalBytes > 0) {
          onProgress(Math.min(99, Math.round((downloaded / totalBytes) * 100)));
        }
      }
    }
  } finally {
    await new Promise<void>(resolve => fileStream.end(() => resolve()));
  }

  const stat = fs.statSync(destPath);
  if (stat.size < 1024 * 100) {
    fs.rmSync(destPath, { force: true });
    throw new Error('Downloaded installer appears incomplete.');
  }

  onProgress(100);

  const installDir = paths.installDir;
  const exePath = process.execPath;
  const pid = process.pid;

  // Escape single quotes for PowerShell single-quoted string literals
  const psEscape = (val: string) => val.replace(/'/g, "''");

  const psScript = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `Wait-Process -Id ${pid} -Timeout 20`,
    `Start-Sleep -Milliseconds 500`,
    // Note: NSIS requires /D= to be the final unquoted parameter on the command line
    `$proc = Start-Process -FilePath '${psEscape(destPath)}' -ArgumentList ('/S /D=' + '${psEscape(installDir)}') -PassThru -Wait`,
    `Remove-Item -LiteralPath '${psEscape(destPath)}' -Force`,
    `Start-Process -FilePath '${psEscape(exePath)}'`,
  ].join('; ');

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();

  setTimeout(() => {
    app.exit(0);
  }, 200);
}
