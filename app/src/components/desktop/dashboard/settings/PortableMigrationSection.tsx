import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  ArrowRightLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderInput,
  FolderOpen,
  HardDrive,
  Loader2,
  Rocket,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatBytes, isAndroidPlatform } from '../../../../utils';

interface PortableMigrationInfo {
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

interface RelocateProgressPayload {
  phase: 'flushing' | 'copying' | 'verifying' | 'completed';
  percent: number;
  copiedBytes: number;
  totalBytes: number;
  currentItem?: string;
}

interface RelocatePortableResult {
  targetDir: string;
  dataDir: string;
  executablePath: string | null;
  canLaunchExecutable: boolean;
  mode: 'copy' | 'move';
  copiedBytes: number;
  fileCount: number;
  updatedShortcuts?: number;
}

interface PortableBundleImportResult {
  restoredSession: boolean;
  restoredVault: boolean;
  restoredApiId: number | null;
  restoredStores: string[];
}

export function PortableMigrationSection() {
  const [info, setInfo] = useState<PortableMigrationInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [relocateMode, setRelocateMode] = useState<'copy' | 'move'>('copy');
  const [includeCaches, setIncludeCaches] = useState(true);
  const [busyAction, setBusyAction] = useState<'relocate' | 'export' | 'import' | 'launch' | null>(null);
  const [progress, setProgress] = useState<RelocateProgressPayload | null>(null);
  const [relocated, setRelocated] = useState<RelocatePortableResult | null>(null);

  const refreshInfo = useCallback(async () => {
    if (isAndroidPlatform) {
      setLoadingInfo(false);
      return;
    }
    setLoadingInfo(true);
    try {
      const result = await invoke<PortableMigrationInfo | null>('cmd_get_portable_migration_info');
      setInfo(result && result.dataRoot ? result : null);
    } catch {
      setInfo(null);
    } finally {
      setLoadingInfo(false);
    }
  }, []);

  useEffect(() => {
    void refreshInfo();
  }, [refreshInfo]);

  useEffect(() => {
    if (isAndroidPlatform) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<RelocateProgressPayload>('migration-progress', (event) => {
      if (!disposed && event.payload) {
        setProgress(event.payload);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (isAndroidPlatform || (!loadingInfo && !info)) {
    return null;
  }

  const handleOpenCurrentFolder = async () => {
    if (!info) return;
    try {
      await invoke('cmd_open_file_in_folder', { path: info.dataRoot });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRelocateApp = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: relocateMode === 'move'
          ? 'Select destination folder to move Telegram Drive'
          : 'Select destination folder to copy Telegram Drive',
      });
      if (!selected || Array.isArray(selected)) return;

      setBusyAction('relocate');
      setProgress({ phase: 'flushing', percent: 2, copiedBytes: 0, totalBytes: 0 });
      const result = await invoke<RelocatePortableResult>('cmd_relocate_portable_app', {
        destinationDir: selected,
        mode: relocateMode,
        includeCaches,
      });
      setRelocated(result);
      await refreshInfo();
      toast.success(
        relocateMode === 'move'
          ? `Prepared Telegram Drive in ${result.targetDir}. Launch the new location to finish moving.`
          : `Copied Telegram Drive (${formatBytes(result.copiedBytes)}) to ${result.targetDir}.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
      setProgress(null);
    }
  };

  const handleLaunchRelocated = async () => {
    if (!relocated?.executablePath) return;
    setBusyAction('launch');
    try {
      await invoke('cmd_launch_relocated_app', {
        targetDir: relocated.targetDir,
        executablePath: relocated.executablePath,
        mode: relocated.mode,
      });
    } catch (err) {
      setBusyAction(null);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExportBundle = async () => {
    try {
      const dateStamp = new Date().toISOString().slice(0, 10);
      const outputFilePath = await save({
        title: 'Export Telegram Drive Portable Data (.tdmigrate)',
        defaultPath: `Telegram-Drive-Portable-${dateStamp}.tdmigrate`,
        filters: [{ name: 'Telegram Drive Portable Migration', extensions: ['tdmigrate'] }],
      });
      if (!outputFilePath) return;

      setBusyAction('export');
      const result = await invoke<{ filePath: string; sizeBytes: number; includedFiles: number }>(
        'cmd_export_portable_bundle',
        { outputFilePath },
      );
      toast.success(
        `Exported ${result.includedFiles} portable files (${formatBytes(result.sizeBytes)}) to ${result.filePath}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const runImportFromPath = async (sourcePath: string) => {
    setBusyAction('import');
    try {
      const result = await invoke<PortableBundleImportResult>('cmd_import_portable_bundle', { sourcePath });
      await refreshInfo();
      toast.success(
        result.restoredSession
          ? 'Portable session, vault, and settings restored. Reloading workspace...'
          : 'Portable settings and data restored. Reloading workspace...',
      );
      setTimeout(() => {
        window.location.reload();
      }, 650);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleImportBundleFile = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: 'Select Telegram Drive .tdmigrate package',
        filters: [{ name: 'Telegram Drive Portable Migration', extensions: ['tdmigrate'] }],
      });
      if (!selected || Array.isArray(selected)) return;
      await runImportFromPath(selected);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportFromFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select previous Telegram Drive folder or portable data folder',
      });
      if (!selected || Array.isArray(selected)) return;
      await runImportFromPath(selected);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const isBusy = busyAction !== null;

  return (
    <div className="space-y-4">
      {/* Current Portable Folder Info */}
      <div className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/50 p-3.5 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <HardDrive className="h-4 w-4 shrink-0 text-app-accent" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-app-text">Portable App & Data Location</p>
              <p className="text-[11px] text-app-text-secondary">
                All login sessions, API keys, vault, folders, and settings live inside your portable data folder.
              </p>
            </div>
          </div>
          {info && (
            <button
              type="button"
              onClick={() => void handleOpenCurrentFolder()}
              className="settings-btn-secondary shrink-0 flex items-center gap-1.5 text-xs"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open Folder
            </button>
          )}
        </div>

        {loadingInfo ? (
          <div className="flex items-center gap-2 text-xs text-app-text-secondary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Reading portable installation info...
          </div>
        ) : info ? (
          <div className="grid gap-1.5 rounded-md border border-app-border-subtle bg-app-surface/70 p-2.5 text-[11px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-app-text-tertiary shrink-0">App Folder</span>
              <span className="font-mono text-app-text truncate" title={info.installDir}>{info.installDir}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-app-text-tertiary shrink-0">Data Folder</span>
              <span className="font-mono text-app-text truncate" title={info.dataRoot}>{info.dataRoot}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-app-text-tertiary shrink-0">Portable Data Size</span>
              <span className="font-mono text-app-text">
                {formatBytes(info.totalDataBytes)} ({info.dataFileCount} files)
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Relocate / Move Portable App */}
      <div className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/50 p-3.5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <ArrowRightLeft className="h-4 w-4 mt-0.5 shrink-0 text-app-accent" />
            <div>
              <p className="text-xs font-semibold text-app-text">Move or Copy App to Another Folder / Drive</p>
              <p className="text-[11px] text-app-text-secondary">
                Relocate Telegram Drive together with your active login session, vault, folders, and settings without signing in again.
              </p>
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-[11px] text-app-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeCaches}
            disabled={isBusy}
            onChange={(e) => setIncludeCaches(e.target.checked)}
            className="rounded border-app-border accent-app-accent"
          />
          Include offline & thumbnail caches when relocating
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="inline-flex rounded-lg border border-app-border bg-app-surface p-0.5 text-xs">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setRelocateMode('copy')}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                relocateMode === 'copy'
                  ? 'bg-app-accent text-app-accent-contrast'
                  : 'text-app-text-secondary hover:text-app-text'
              }`}
            >
              Copy (Keep Original)
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setRelocateMode('move')}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                relocateMode === 'move'
                  ? 'bg-app-accent text-app-accent-contrast'
                  : 'text-app-text-secondary hover:text-app-text'
              }`}
            >
              Move to New Folder
            </button>
          </div>

          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleRelocateApp()}
            className="settings-btn-primary flex items-center gap-1.5 text-xs disabled:opacity-50"
          >
            {busyAction === 'relocate' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {progress ? `Transferring (${progress.percent}%)...` : 'Transferring...'}
              </>
            ) : (
              <>
                <FolderInput className="h-3.5 w-3.5" />
                {relocateMode === 'move' ? 'Choose Destination & Move...' : 'Choose Destination & Copy...'}
              </>
            )}
          </button>
        </div>

        {busyAction === 'relocate' && progress && (
          <div className="space-y-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-app-border">
              <div
                className="h-full rounded-full bg-app-accent transition-[width] duration-200"
                style={{ width: `${Math.max(4, Math.min(100, progress.percent))}%` }}
              />
            </div>
            <p className="text-[10px] font-mono text-app-text-tertiary truncate">
              {progress.phase === 'verifying'
                ? 'Verifying migrated session & vault integrity...'
                : progress.currentItem || 'Flushing workspace state...'}
            </p>
          </div>
        )}

        {relocated && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-400" />
              <div className="min-w-0 flex-1 text-xs">
                <p className="font-semibold text-app-text">
                  Ready at <span className="font-mono">{relocated.targetDir}</span>
                </p>
                <p className="text-[11px] text-app-text-secondary mt-0.5">
                  Transferred {relocated.fileCount} files ({formatBytes(relocated.copiedBytes)}) with verified session & workspace integrity.
                  {relocated.updatedShortcuts && relocated.updatedShortcuts > 0
                    ? ` Updated ${relocated.updatedShortcuts} Desktop / Start Menu shortcut${relocated.updatedShortcuts === 1 ? '' : 's'} automatically.`
                    : ''}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {relocated.canLaunchExecutable && relocated.executablePath && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleLaunchRelocated()}
                  className="settings-btn-primary flex items-center gap-1.5 text-xs disabled:opacity-50"
                >
                  {busyAction === 'launch' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Rocket className="h-3.5 w-3.5" />
                  )}
                  Launch New Location & Close Current
                </button>
              )}
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void invoke('cmd_open_file_in_folder', { path: relocated.targetDir })}
                className="settings-btn-secondary flex items-center gap-1.5 text-xs"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Show in Explorer
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Export / Import Portable Data Bundle (.tdmigrate) */}
      <div className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/50 p-3.5 space-y-3">
        <div>
          <p className="text-xs font-semibold text-app-text">Portable Data Package (.tdmigrate)</p>
          <p className="text-[11px] text-app-text-secondary">
            Export your entire portable workspace (login session, vault, folders, themes, and settings) into one file or import from another Telegram Drive folder.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleExportBundle()}
            className="settings-btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-50"
          >
            {busyAction === 'export' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Export .tdmigrate File
          </button>

          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleImportBundleFile()}
            className="settings-btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-50"
          >
            {busyAction === 'import' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Import .tdmigrate File
          </button>

          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleImportFromFolder()}
            className="settings-btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Import from Folder
          </button>
        </div>
      </div>
    </div>
  );
}
