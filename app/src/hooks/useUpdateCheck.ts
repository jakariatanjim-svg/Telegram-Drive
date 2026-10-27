import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { version as pkgVersion } from '../../package.json';
import { GITHUB_RELEASES_URL, compareVersions, formatDisplayVersion } from '../../shared/versioning';
import type { UpdateInstallPhase } from '../services/updateReliability';

export const RELEASES_URL = GITHUB_RELEASES_URL;

const UPDATE_CACHE_KEY = 'telegram_drive_update_check_cache_v1';
const AUTO_CHECK_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes cached cooldown

interface CachedUpdateCheck {
  checkedAt: number;
  currentVersion: string;
  available: boolean;
  latestVersion: string | null;
  downloadUrl: string | null;
  assetName: string | null;
}

interface BackendUpdateCheckResponse {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string | null;
  assetName: string | null;
  assetSize: number;
  releaseUrl: string;
}

interface UpdateState {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  progress: number;
  error: string | null;
  version: string | null;
  phase: UpdateInstallPhase | null;
}

interface UpdateCheckResult {
  version: string | null;
  error: string | null;
}

interface UpdateInstallResult {
  error: string | null;
}

function readCachedCheck(currentDisplayVersion: string): CachedUpdateCheck | null {
  try {
    const raw = localStorage.getItem(UPDATE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUpdateCheck;
    if (parsed.currentVersion !== currentDisplayVersion) return null;
    if (Date.now() - parsed.checkedAt > AUTO_CHECK_COOLDOWN_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedCheck(entry: CachedUpdateCheck): void {
  try {
    localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // ignore storage errors
  }
}

export function useUpdateCheck() {
  const currentVersion = formatDisplayVersion(pkgVersion, '1.0');

  const [state, setState] = useState<UpdateState>({
    checking: false,
    available: false,
    downloading: false,
    progress: 0,
    error: null,
    version: null,
    phase: null,
  });

  const latestAssetRef = useRef<{ downloadUrl: string | null; assetName: string | null }>({
    downloadUrl: null,
    assetName: null,
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ progress: number }>('update-download-progress', ev => {
      const pct = Math.max(0, Math.min(100, Number(ev.payload?.progress ?? 0)));
      setState(prev => ({
        ...prev,
        progress: pct,
        phase: pct >= 99 ? 'installing' : 'downloading',
      }));
    }).then(fn => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const runCheck = useCallback(
    async (opts: { silent: boolean; bypassCache: boolean }): Promise<UpdateCheckResult> => {
      if (!opts.bypassCache) {
        const cached = readCachedCheck(currentVersion);
        if (cached) {
          latestAssetRef.current = {
            downloadUrl: cached.downloadUrl,
            assetName: cached.assetName,
          };
          const validNewer =
            cached.available &&
            cached.latestVersion &&
            compareVersions(cached.latestVersion, currentVersion) > 0;
          setState(s => ({
            ...s,
            checking: false,
            available: Boolean(validNewer),
            version: validNewer ? cached.latestVersion : null,
            error: null,
          }));
          return { version: validNewer ? cached.latestVersion : null, error: null };
        }
      }

      setState(s => ({ ...s, checking: true, error: null }));

      try {
        const res = await invoke<BackendUpdateCheckResponse>('cmd_check_github_update', {
          currentVersion,
        });
        const validNewer =
          Boolean(res?.available) &&
          Boolean(res?.latestVersion) &&
          compareVersions(res.latestVersion!, currentVersion) > 0;

        latestAssetRef.current = {
          downloadUrl: res?.downloadUrl ?? null,
          assetName: res?.assetName ?? null,
        };

        writeCachedCheck({
          checkedAt: Date.now(),
          currentVersion,
          available: validNewer,
          latestVersion: res?.latestVersion ?? null,
          downloadUrl: res?.downloadUrl ?? null,
          assetName: res?.assetName ?? null,
        });

        setState(s => ({
          ...s,
          checking: false,
          available: validNewer,
          version: validNewer ? res.latestVersion : null,
          error: null,
        }));

        return { version: validNewer ? res.latestVersion : null, error: null };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setState(s => ({
          ...s,
          checking: false,
          error: opts.silent ? null : message,
        }));
        return { version: null, error: opts.silent ? null : message };
      }
    },
    [currentVersion],
  );

  // Automatic launch check: respects 2-minute cached cooldown & fails silently
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runCheck({ silent: true, bypassCache: false });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [runCheck]);

  const checkForUpdates = useCallback(async (): Promise<UpdateCheckResult> => {
    return await runCheck({ silent: false, bypassCache: true });
  }, [runCheck]);

  const downloadAndInstall = useCallback(async (): Promise<UpdateInstallResult> => {
    const { downloadUrl, assetName } = latestAssetRef.current;
    if (!downloadUrl) {
      await openUrl(RELEASES_URL);
      return { error: null };
    }

    setState(s => ({
      ...s,
      downloading: true,
      progress: 0,
      error: null,
      phase: 'downloading',
    }));

    try {
      await invoke('cmd_install_github_update', {
        downloadUrl,
        assetName: assetName ?? undefined,
      });
      setState(s => ({ ...s, downloading: false, progress: 100, phase: null }));
      return { error: null };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setState(s => ({
        ...s,
        downloading: false,
        phase: null,
        error: message,
      }));
      return { error: message };
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    setState(s => ({ ...s, checking: false, available: false, version: null, phase: null }));
  }, []);

  return {
    ...state,
    checkForUpdates,
    downloadAndInstall,
    dismissUpdate,
  };
}
