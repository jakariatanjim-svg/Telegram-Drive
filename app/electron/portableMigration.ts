import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, shell } from 'electron';
import { unzipSync, zipSync } from 'fflate';
import { atomicWriteFileSync, clearPortableKeyCache } from './mtprotoNode';
import { getPortablePaths } from './portablePaths';

export interface PortableMigrationInfo {
  installDir: string;
  dataRoot: string;
  executablePath: string;
  executableName: string;
  isPackaged: boolean;
  totalAppBytes: number;
  totalDataBytes: number;
  dataFileCount: number;
  hasSession: boolean;
  hasVault: boolean;
}

export interface RelocateProgressPayload {
  phase: 'flushing' | 'copying' | 'verifying' | 'completed';
  percent: number;
  copiedBytes: number;
  totalBytes: number;
  currentItem?: string;
}

export interface RelocatePortableResult {
  targetDir: string;
  dataDir: string;
  executablePath: string | null;
  canLaunchExecutable: boolean;
  mode: 'copy' | 'move';
  copiedBytes: number;
  fileCount: number;
  updatedShortcutsCount?: number;
}

export interface PortableBundleImportResult {
  restoredSession: boolean;
  restoredVault: boolean;
  restoredApiId: number | null;
  restoredStores: string[];
}

const TRANSIENT_LOCK_NAMES = new Set([
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'LOCK',
  'lockfile',
]);

function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(parentPath: string, candidatePath: string): boolean {
  const parentNorm = normalizePathForCompare(parentPath);
  const childNorm = normalizePathForCompare(candidatePath);
  if (parentNorm === childNorm) return true;
  const withSep = parentNorm.endsWith(path.sep) ? parentNorm : `${parentNorm}${path.sep}`;
  return childNorm.startsWith(withSep);
}

function shouldSkipPath(
  sourceRoot: string,
  fullPath: string,
  isDir: boolean,
  includeCaches: boolean,
): boolean {
  const base = path.basename(fullPath);
  if (TRANSIENT_LOCK_NAMES.has(base) || base.endsWith('.tmp')) {
    return true;
  }
  const rel = path.relative(sourceRoot, fullPath).replace(/\\/g, '/');
  if (isDir && (rel === 'node_modules' || rel === '.git' || rel === 'release')) {
    return true;
  }
  if (!includeCaches && isDir) {
    if (
      rel === 'data/cache/previews' ||
      rel === 'data/cache/staging' ||
      rel === 'cache/previews' ||
      rel === 'cache/staging' ||
      rel.endsWith('chromium/Cache') ||
      rel.endsWith('chromium/Code Cache') ||
      rel.endsWith('chromium/GPUCache') ||
      rel.endsWith('chromium/DawnCache')
    ) {
      return true;
    }
  }
  return false;
}

function collectFilesRecursive(
  sourceRoot: string,
  includeCaches: boolean,
): Array<{ fullPath: string; relPath: string; size: number }> {
  if (!fs.existsSync(sourceRoot)) return [];
  const results: Array<{ fullPath: string; relPath: string; size: number }> = [];
  const stack = [sourceRoot];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (shouldSkipPath(sourceRoot, fullPath, true, includeCaches)) continue;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        if (shouldSkipPath(sourceRoot, fullPath, false, includeCaches)) continue;
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            fullPath,
            relPath: path.relative(sourceRoot, fullPath),
            size: stat.size,
          });
        } catch {
          // Ignore transient files removed mid-scan
        }
      }
    }
  }

  return results;
}

export function getPortableMigrationInfo(): PortableMigrationInfo {
  const paths = getPortablePaths();
  const isPackaged = app.isPackaged;
  const dataFiles = collectFilesRecursive(paths.dataRoot, true);
  const totalDataBytes = dataFiles.reduce((sum, f) => sum + f.size, 0);

  let totalAppBytes = totalDataBytes;
  if (isPackaged && fs.existsSync(paths.installDir)) {
    const appFiles = collectFilesRecursive(paths.installDir, true);
    totalAppBytes = appFiles.reduce((sum, f) => sum + f.size, 0);
  }

  const hasSession =
    fs.existsSync(path.join(paths.sessionDir, 'mtproto.session.enc')) ||
    fs.existsSync(path.join(paths.sessionDir, 'mtproto-storage.enc'));

  let hasVault = false;
  const statePath = path.join(paths.dbDir, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        vaultData?: { vault?: unknown };
      };
      hasVault = Boolean(parsed.vaultData?.vault);
    } catch {
      hasVault = false;
    }
  }

  return {
    installDir: paths.installDir,
    dataRoot: paths.dataRoot,
    executablePath: process.execPath,
    executableName: path.basename(process.execPath),
    isPackaged,
    totalAppBytes,
    totalDataBytes,
    dataFileCount: dataFiles.length,
    hasSession,
    hasVault,
  };
}

function resolveTargetFolder(chosenDir: string): string {
  const resolved = path.resolve(chosenDir);
  if (!fs.existsSync(resolved)) {
    return resolved;
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(resolved);
  } catch {
    return resolved;
  }
  if (entries.length === 0) {
    return resolved;
  }
  const baseLower = path.basename(resolved).toLowerCase();
  const looksLikeTelegramDriveFolder =
    baseLower === 'telegram drive' ||
    baseLower === 'telegram-drive' ||
    entries.includes('Telegram Drive.exe') ||
    (entries.includes('data') && entries.includes('resources'));
  if (looksLikeTelegramDriveFolder) {
    return resolved;
  }
  return path.join(resolved, 'Telegram Drive');
}

export async function relocatePortableApp(
  options: {
    destinationDir: string;
    mode: 'copy' | 'move';
    includeCaches?: boolean;
  },
  hooks: {
    flushAllSync: () => void;
    onProgress?: (payload: RelocateProgressPayload) => void;
  },
): Promise<RelocatePortableResult> {
  const rawDest = String(options.destinationDir ?? '').trim();
  if (!rawDest) {
    throw new Error('MIGRATION_DESTINATION_REQUIRED');
  }

  const paths = getPortablePaths();
  const isPackaged = app.isPackaged;
  const includeCaches = options.includeCaches !== false;
  const targetDir = resolveTargetFolder(rawDest);

  if (
    isSameOrInside(paths.installDir, targetDir) ||
    isSameOrInside(paths.dataRoot, targetDir)
  ) {
    throw new Error('MIGRATION_DESTINATION_INSIDE_CURRENT');
  }

  hooks.onProgress?.({
    phase: 'flushing',
    percent: 2,
    copiedBytes: 0,
    totalBytes: 0,
  });
  hooks.flushAllSync();

  const sourceRoot = isPackaged ? paths.installDir : paths.dataRoot;
  const destRootForSource = isPackaged ? targetDir : path.join(targetDir, 'data');

  const filesToCopy = collectFilesRecursive(sourceRoot, includeCaches);
  const totalBytes = filesToCopy.reduce((sum, f) => sum + f.size, 0);
  let copiedBytes = 0;

  fs.mkdirSync(destRootForSource, { recursive: true });

  for (let i = 0; i < filesToCopy.length; i++) {
    const item = filesToCopy[i];
    const destFile = path.join(destRootForSource, item.relPath);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    await fs.promises.copyFile(item.fullPath, destFile);
    copiedBytes += item.size;
    const pct =
      totalBytes > 0
        ? Math.min(96, 5 + Math.round((copiedBytes / totalBytes) * 90))
        : Math.min(96, 5 + Math.round(((i + 1) / Math.max(1, filesToCopy.length)) * 90));
    hooks.onProgress?.({
      phase: 'copying',
      percent: pct,
      copiedBytes,
      totalBytes,
      currentItem: item.relPath,
    });
  }

  hooks.onProgress?.({
    phase: 'verifying',
    percent: 98,
    copiedBytes,
    totalBytes,
  });

  const targetDataDir = path.join(targetDir, 'data');
  // Ensure portable subdirectories exist in target
  for (const sub of ['db', 'session', 'stores', 'backups', 'bin', 'cache', 'logs', 'chromium']) {
    fs.mkdirSync(path.join(targetDataDir, sub), { recursive: true });
  }

  // Verify critical state & session files match
  const criticalRelPaths = [
    path.join('db', 'state.json'),
    path.join('session', 'portable.key'),
    path.join('session', 'api_hash.enc'),
    path.join('session', 'mtproto.session.enc'),
    path.join('session', 'mtproto-storage.enc'),
    path.join('stores', 'config.json'),
    path.join('stores', 'settings.json'),
  ];
  for (const rel of criticalRelPaths) {
    const srcFile = path.join(paths.dataRoot, rel);
    const dstFile = path.join(targetDataDir, rel);
    if (fs.existsSync(srcFile)) {
      if (!fs.existsSync(dstFile)) {
        throw new Error(`MIGRATION_VERIFY_FAILED:${rel}`);
      }
      const srcSize = fs.statSync(srcFile).size;
      const dstSize = fs.statSync(dstFile).size;
      if (srcSize !== dstSize) {
        throw new Error(`MIGRATION_SIZE_MISMATCH:${rel}`);
      }
    }
  }

  const exeName = path.basename(process.execPath);
  const candidateExe = path.join(targetDir, exeName);
  const canLaunchExecutable = isPackaged && fs.existsSync(candidateExe);

  let updatedShortcutsCount = 0;
  if (options.mode === 'move' && canLaunchExecutable && process.platform === 'win32') {
    updatedShortcutsCount = updateWindowsShortcutsOnMove(
      paths.installDir,
      targetDir,
      candidateExe,
    );
  }

  hooks.onProgress?.({
    phase: 'completed',
    percent: 100,
    copiedBytes,
    totalBytes,
  });

  return {
    targetDir,
    dataDir: targetDataDir,
    executablePath: canLaunchExecutable ? candidateExe : null,
    canLaunchExecutable,
    mode: options.mode,
    copiedBytes,
    fileCount: filesToCopy.length,
    updatedShortcutsCount,
  };
}

function collectCandidateShortcutPaths(): string[] {
  if (process.platform !== 'win32') return [];
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const publicDir = process.env.PUBLIC || 'C:\\Users\\Public';

  const roots = new Set<string>();
  try {
    roots.add(app.getPath('desktop'));
  } catch {
    // Ignore
  }
  roots.add(path.join(home, 'Desktop'));
  if (process.env.OneDrive) roots.add(path.join(process.env.OneDrive, 'Desktop'));
  if (process.env.OneDriveConsumer) roots.add(path.join(process.env.OneDriveConsumer, 'Desktop'));
  roots.add(path.join(publicDir, 'Desktop'));
  roots.add(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  roots.add(path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  roots.add(
    path.join(
      appData,
      'Microsoft',
      'Internet Explorer',
      'Quick Launch',
      'User Pinned',
      'TaskBar',
    ),
  );

  const lnkPaths: string[] = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(root, ent.name);
      if (ent.isFile() && ent.name.toLowerCase().endsWith('.lnk')) {
        lnkPaths.push(full);
      } else if (ent.isDirectory()) {
        try {
          const subEntries = fs.readdirSync(full, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && sub.name.toLowerCase().endsWith('.lnk')) {
              lnkPaths.push(path.join(full, sub.name));
            }
          }
        } catch {
          // Ignore inaccessible subfolders
        }
      }
    }
  }
  return lnkPaths;
}

export function updateWindowsShortcutsOnMove(
  oldInstallDir: string,
  newInstallDir: string,
  newExePath: string,
): number {
  if (process.platform !== 'win32' || !fs.existsSync(newExePath)) return 0;

  let updatedCount = 0;
  const lnkCandidates = collectCandidateShortcutPaths();
  const psFallbackLinks: string[] = [];

  for (const lnkPath of lnkCandidates) {
    const fileBase = path.basename(lnkPath);
    const isTelegramDriveShortcutName = /^telegram[\s_-]*drive\.lnk$/i.test(fileBase);
    let existingDetails: Electron.ShortcutDetails | null = null;
    try {
      existingDetails = shell.readShortcutLink(lnkPath);
    } catch {
      existingDetails = null;
    }

    const existingTarget = existingDetails?.target ?? '';
    const pointsToOldDir = Boolean(existingTarget && isSameOrInside(oldInstallDir, existingTarget));
    const pointsToTelegramDriveExe = Boolean(
      isTelegramDriveShortcutName &&
        (!existingTarget ||
          !fs.existsSync(existingTarget) ||
          /telegram[\s_-]*drive\.exe$/i.test(path.basename(existingTarget))),
    );

    if (!pointsToOldDir && !pointsToTelegramDriveExe) continue;

    let wrote = false;
    try {
      wrote = shell.writeShortcutLink(lnkPath, existingDetails ? 'update' : 'replace', {
        target: newExePath,
        cwd: newInstallDir,
        args: existingDetails?.args || '',
        description: existingDetails?.description || 'Telegram Drive',
        icon: newExePath,
        iconIndex: 0,
      });
    } catch {
      wrote = false;
    }

    if (wrote) {
      updatedCount++;
    } else {
      psFallbackLinks.push(lnkPath);
    }
  }

  // Fallback via WScript.Shell COM for any shortcut where shell.writeShortcutLink returned false
  if (psFallbackLinks.length > 0) {
    try {
      const psEsc = (s: string) => s.replace(/'/g, "''");
      const listLiteral = psFallbackLinks.map(p => `'${psEsc(p)}'`).join(', ');
      const psCmd = [
        `$ErrorActionPreference = 'SilentlyContinue'`,
        `$wsh = New-Object -ComObject WScript.Shell`,
        `foreach ($p in @(${listLiteral})) {`,
        `  if (Test-Path -LiteralPath $p) {`,
        `    $sc = $wsh.CreateShortcut($p)`,
        `    $sc.TargetPath = '${psEsc(newExePath)}'`,
        `    $sc.WorkingDirectory = '${psEsc(newInstallDir)}'`,
        `    $sc.IconLocation = '${psEsc(newExePath)},0'`,
        `    $sc.Save()`,
        `  }`,
        `}`,
      ].join('; ');
      const res = childProcess.spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
        { stdio: 'ignore', timeout: 6000, windowsHide: true },
      );
      if (res.status === 0) {
        updatedCount += psFallbackLinks.length;
      }
    } catch {
      // Best-effort shortcut fallback
    }
  }

  // Best-effort update of user-scope NSIS Uninstall registry entry if pointing to oldInstallDir
  try {
    const psEsc = (s: string) => s.replace(/'/g, "''");
    const newUninstaller = path.join(newInstallDir, 'Uninstall Telegram Drive.exe');
    const regCmd = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$oldNorm = [IO.Path]::GetFullPath('${psEsc(oldInstallDir)}').TrimEnd('\\')`,
      `Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object {`,
      `  $p = Get-ItemProperty $_.PSPath`,
      `  if ($p.DisplayName -like '*Telegram Drive*' -or ($p.InstallLocation -and ([IO.Path]::GetFullPath($p.InstallLocation).TrimEnd('\\') -ieq $oldNorm))) {`,
      `    Set-ItemProperty -Path $_.PSPath -Name 'InstallLocation' -Value '${psEsc(newInstallDir)}'`,
      `    Set-ItemProperty -Path $_.PSPath -Name 'DisplayIcon' -Value '${psEsc(newExePath)},0'`,
      ...(fs.existsSync(newUninstaller)
        ? [`    Set-ItemProperty -Path $_.PSPath -Name 'UninstallString' -Value '"${psEsc(newUninstaller)}"'`]
        : []),
      `  }`,
      `}`,
    ].join('; ');
    childProcess.spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', regCmd],
      { stdio: 'ignore', timeout: 5000, windowsHide: true },
    );
  } catch {
    // Best-effort registry metadata update
  }

  return updatedCount;
}

export function launchRelocatedAppAndExit(
  params: {
    targetDir: string;
    executablePath: string;
    mode: 'copy' | 'move';
  },
  triggerGracefulQuit: () => void,
): boolean {
  const paths = getPortablePaths();
  if (!params.executablePath || !fs.existsSync(params.executablePath)) {
    return false;
  }

  if (
    process.platform === 'win32' &&
    params.mode === 'move' &&
    app.isPackaged &&
    !isSameOrInside(params.targetDir, paths.installDir)
  ) {
    const psScriptPath = path.join(
      os.tmpdir(),
      `td-relocate-${process.pid}-${Date.now()}.ps1`,
    );
    const escapedOldDir = paths.installDir.replace(/'/g, "''");
    const escapedNewExe = params.executablePath.replace(/'/g, "''");
    const escapedNewDir = params.targetDir.replace(/'/g, "''");
    const escapedSelf = psScriptPath.replace(/'/g, "''");
    const script = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$oldPid = ${process.pid}`,
      `for ($i = 0; $i -lt 60; $i++) {`,
      `  if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { break }`,
      `  Start-Sleep -Milliseconds 500`,
      `}`,
      `Start-Sleep -Milliseconds 400`,
      `Start-Process -FilePath '${escapedNewExe}' -WorkingDirectory '${escapedNewDir}'`,
      `for ($j = 0; $j -lt 10; $j++) {`,
      `  Remove-Item -LiteralPath '${escapedOldDir}' -Recurse -Force -ErrorAction SilentlyContinue`,
      `  if (-not (Test-Path -LiteralPath '${escapedOldDir}')) { break }`,
      `  Start-Sleep -Milliseconds 600`,
      `}`,
      `Remove-Item -LiteralPath '${escapedSelf}' -Force -ErrorAction SilentlyContinue`,
    ].join('\r\n');

    fs.writeFileSync(psScriptPath, script, 'utf8');
    const child = childProcess.spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', psScriptPath],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.unref();
    triggerGracefulQuit();
    return true;
  }

  const child = childProcess.spawn(params.executablePath, [], {
    cwd: params.targetDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  triggerGracefulQuit();
  return true;
}

export function exportPortableDataBundle(
  outputFilePath: string,
  hooks: { flushAllSync: () => void },
): { filePath: string; sizeBytes: number; includedFiles: number } {
  hooks.flushAllSync();
  const paths = getPortablePaths();
  const entries: Record<string, Uint8Array> = {};
  let includedFiles = 0;

  for (const section of ['db', 'session', 'stores']) {
    const dirPath = path.join(paths.dataRoot, section);
    const files = collectFilesRecursive(dirPath, false);
    for (const file of files) {
      const zipKey = `${section}/${file.relPath.replace(/\\/g, '/')}`;
      entries[zipKey] = new Uint8Array(fs.readFileSync(file.fullPath));
      includedFiles++;
    }
  }

  const manifest = {
    format: 'telegram-drive-portable-migration-v1',
    createdAt: new Date().toISOString(),
    includedFiles,
  };
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const zipped = zipSync(entries, { level: 6 });
  atomicWriteFileSync(outputFilePath, Buffer.from(zipped));
  return {
    filePath: outputFilePath,
    sizeBytes: zipped.byteLength,
    includedFiles,
  };
}

function locateDataRootFromSourceFolder(folderPath: string): string {
  const resolved = path.resolve(folderPath);
  if (
    fs.existsSync(path.join(resolved, 'db')) ||
    fs.existsSync(path.join(resolved, 'session')) ||
    fs.existsSync(path.join(resolved, 'stores'))
  ) {
    return resolved;
  }
  const nestedData = path.join(resolved, 'data');
  if (
    fs.existsSync(path.join(nestedData, 'db')) ||
    fs.existsSync(path.join(nestedData, 'session')) ||
    fs.existsSync(path.join(nestedData, 'stores'))
  ) {
    return nestedData;
  }
  throw new Error('MIGRATION_INVALID_SOURCE_FOLDER');
}

export function importPortableDataBundleOrFolder(
  sourcePath: string,
): PortableBundleImportResult {
  const cleanSource = String(sourcePath ?? '').trim();
  if (!cleanSource || !fs.existsSync(cleanSource)) {
    throw new Error('MIGRATION_SOURCE_NOT_FOUND');
  }

  const paths = getPortablePaths();
  const stat = fs.statSync(cleanSource);
  const restoredStores: string[] = [];

  if (stat.isDirectory()) {
    const sourceDataRoot = locateDataRootFromSourceFolder(cleanSource);
    if (normalizePathForCompare(sourceDataRoot) === normalizePathForCompare(paths.dataRoot)) {
      throw new Error('MIGRATION_SOURCE_IS_ACTIVE_DATA');
    }

    for (const section of ['db', 'session', 'stores']) {
      const srcSection = path.join(sourceDataRoot, section);
      const dstSection = path.join(paths.dataRoot, section);
      const files = collectFilesRecursive(srcSection, false);
      for (const f of files) {
        const destFile = path.join(dstSection, f.relPath);
        atomicWriteFileSync(destFile, fs.readFileSync(f.fullPath));
        if (section === 'stores' && f.relPath.endsWith('.json')) {
          restoredStores.push(path.basename(f.relPath));
        }
      }
    }
  } else {
    const rawZip = new Uint8Array(fs.readFileSync(cleanSource));
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(rawZip);
    } catch {
      throw new Error('MIGRATION_INVALID_BUNDLE');
    }

    const keys = Object.keys(unzipped);
    const hasRecognizedEntries = keys.some(
      k => k.startsWith('db/') || k.startsWith('session/') || k.startsWith('stores/'),
    );
    if (!hasRecognizedEntries) {
      throw new Error('MIGRATION_INVALID_BUNDLE');
    }

    for (const [entryKey, content] of Object.entries(unzipped)) {
      const normalizedKey = entryKey.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normalizedKey.includes('..')) continue;
      if (
        !normalizedKey.startsWith('db/') &&
        !normalizedKey.startsWith('session/') &&
        !normalizedKey.startsWith('stores/')
      ) {
        continue;
      }
      const destFile = path.join(paths.dataRoot, normalizedKey);
      if (!isSameOrInside(paths.dataRoot, destFile)) continue;
      atomicWriteFileSync(destFile, Buffer.from(content));
      if (normalizedKey.startsWith('stores/') && normalizedKey.endsWith('.json')) {
        restoredStores.push(path.basename(normalizedKey));
      }
    }
  }

  clearPortableKeyCache();

  let restoredApiId: number | null = null;
  let restoredVault = false;
  const statePath = path.join(paths.dbDir, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        apiId?: number | null;
        vaultData?: { vault?: unknown };
      };
      if (typeof parsed.apiId === 'number' && parsed.apiId > 0) {
        restoredApiId = parsed.apiId;
      }
      restoredVault = Boolean(parsed.vaultData?.vault);
    } catch {
      // Ignore
    }
  }

  // Ensure config.json in stores also has api_id if state.json had apiId
  const configStorePath = path.join(paths.storesDir, 'config.json');
  if (restoredApiId) {
    let configObj: Record<string, unknown> = {};
    if (fs.existsSync(configStorePath)) {
      try {
        configObj = JSON.parse(fs.readFileSync(configStorePath, 'utf8')) as Record<string, unknown>;
      } catch {
        configObj = {};
      }
    }
    if (!configObj.api_id) {
      configObj.api_id = restoredApiId;
      atomicWriteFileSync(configStorePath, JSON.stringify(configObj, null, 2));
      if (!restoredStores.includes('config.json')) {
        restoredStores.push('config.json');
      }
    }
  }

  const restoredSession =
    fs.existsSync(path.join(paths.sessionDir, 'mtproto.session.enc')) ||
    fs.existsSync(path.join(paths.sessionDir, 'mtproto-storage.enc'));

  return {
    restoredSession,
    restoredVault,
    restoredApiId,
    restoredStores,
  };
}
