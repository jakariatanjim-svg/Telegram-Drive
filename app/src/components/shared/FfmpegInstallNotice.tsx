import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { isWindowsPlatform } from '../../utils/platform';

export const FFMPEG_WINDOWS_DOWNLOAD_URL = 'https://ffmpeg.org/download.html#build-windows';

export async function openFfmpegWindowsDownloads(): Promise<void> {
  try {
    await open(FFMPEG_WINDOWS_DOWNLOAD_URL);
  } catch {
    window.open(FFMPEG_WINDOWS_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
  }
}

interface FfmpegStatusInfo {
  available: boolean;
  source: string | null;
  version: string | null;
  executablePath: string | null;
  installState?: {
    installing: boolean;
    phase: string;
    percent: number;
    downloadedBytes: number;
    totalBytes: number;
    error: string | null;
  };
}

interface FfmpegInstallProgress {
  phase: 'downloading' | 'extracting' | 'verifying' | 'completed' | 'error' | 'cancelled';
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  error?: string | null;
}

interface FfmpegInstallNoticeProps {
  available: boolean | undefined;
  variant?: 'settings' | 'player';
  onInstalled?: () => void;
}

export function FfmpegInstallNotice({
  available,
  variant = 'settings',
  onInstalled,
}: FfmpegInstallNoticeProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<FfmpegStatusInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<FfmpegInstallProgress | null>(null);

  useEffect(() => {
    if (!isWindowsPlatform()) return;
    let cancelled = false;
    void invoke<FfmpegStatusInfo>('cmd_get_ffmpeg_status')
      .then(info => {
        if (!cancelled && info) {
          setStatus(info);
          if (info.installState?.installing) {
            setInstalling(true);
            setProgress({
              phase: (info.installState.phase as FfmpegInstallProgress['phase']) || 'downloading',
              percent: info.installState.percent || 0,
              downloadedBytes: info.installState.downloadedBytes || 0,
              totalBytes: info.installState.totalBytes || 0,
            });
          }
        }
      })
      .catch(() => {});

    let unlisten: (() => void) | undefined;
    void listen<FfmpegInstallProgress>('ffmpeg-install-progress', ({ payload }) => {
      if (cancelled || !payload) return;
      setProgress(payload);
      if (payload.phase === 'completed') {
        setInstalling(false);
        void invoke<FfmpegStatusInfo>('cmd_get_ffmpeg_status')
          .then(info => {
            if (!cancelled && info) setStatus(info);
          })
          .catch(() => {});
        onInstalled?.();
      } else if (payload.phase === 'error' || payload.phase === 'cancelled') {
        setInstalling(false);
      } else {
        setInstalling(true);
      }
    })
      .then(fn => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [available, onInstalled]);

  if (!isWindowsPlatform()) return null;

  const isDetected = Boolean(available || status?.available);

  if (isDetected) {
    if (variant !== 'settings') return null;
    return (
      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-telegram-text" role="status">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-emerald-300">{t('settings.ffmpeg_installed_ready')}</p>
            {status?.executablePath && (
              <p className="mt-0.5 truncate font-mono text-[10px] text-telegram-subtext" title={status.executablePath}>
                {status.executablePath}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (available === undefined && status === null) return null;

  const handleInstallInApp = async () => {
    if (installing) return;
    setInstalling(true);
    setProgress({ phase: 'downloading', percent: 1, downloadedBytes: 0, totalBytes: 0 });
    try {
      const res = await invoke<FfmpegStatusInfo>('cmd_install_ffmpeg');
      if (res?.available) {
        setStatus(res);
        toast.success(t('settings.ffmpeg_install_success'));
        onInstalled?.();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/CANCEL|ABORT/i.test(msg)) {
        toast.error(t('settings.failed_prefix', { error: msg }));
      }
    } finally {
      setInstalling(false);
    }
  };

  const handleCancelInstall = async () => {
    await invoke('cmd_cancel_ffmpeg_install').catch(() => {});
    setInstalling(false);
    setProgress(null);
  };

  const playerStyles =
    variant === 'player'
      ? 'mt-3 w-full border-amber-400/20 bg-amber-400/10 text-white'
      : 'border-amber-500/20 bg-amber-500/5 text-telegram-text';

  const pct = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));

  return (
    <div className={`rounded-lg border p-3 ${playerStyles}`} role="status">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">{t('settings.ffmpeg_required_title')}</p>
          <p className={`mt-1 text-[11px] leading-relaxed ${variant === 'player' ? 'text-white/60' : 'text-telegram-subtext'}`}>
            {t('settings.ffmpeg_required_desc')}
          </p>

          {installing && (
            <div className="mt-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 font-medium text-amber-300">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {progress?.phase === 'extracting' || progress?.phase === 'verifying'
                    ? t('settings.ffmpeg_extracting')
                    : t('settings.ffmpeg_installing', { percent: pct })}
                </span>
                <button
                  type="button"
                  onClick={() => void handleCancelInstall()}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-telegram-subtext hover:bg-white/10 hover:text-telegram-text"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                  {t('common.cancel')}
                </button>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-black/25">
                <div
                  className="h-full rounded-full bg-amber-400 transition-[width] duration-200"
                  style={{ width: `${Math.max(3, pct)}%` }}
                />
              </div>
            </div>
          )}

          {!installing && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleInstallInApp()}
                className="inline-flex items-center gap-1.5 rounded-md bg-telegram-primary px-3 py-1.5 text-[11px] font-semibold text-white transition hover:opacity-90"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                {t('settings.ffmpeg_install_in_app')}
              </button>
              <button
                type="button"
                onClick={() => void openFfmpegWindowsDownloads()}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-400/15 px-2.5 py-1.5 text-[11px] font-medium text-amber-300 transition hover:bg-amber-400/25"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                {t('settings.ffmpeg_download_windows')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
