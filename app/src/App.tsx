import React, { useState, useEffect, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { AppProviders } from "./components/shared/AppProviders";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { UpdateBanner } from "./components/shared/UpdateBanner";
import { useUpdates } from "./context/UpdateContext";
import "./App.css";

const DesktopDashboard = React.lazy(() => import("./components/desktop/DesktopDashboard").then(m => ({ default: m.Dashboard })));
const MobileDashboard = React.lazy(() => import("./components/mobile/MobileDashboard"));
const AuthWizard = React.lazy(() => import("./components/shared/AuthWizard").then(m => ({ default: m.AuthWizard })));

import { Toaster, toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { useTheme } from "./context/ThemeContext";
import { usePlatform } from "./hooks/usePlatform";
import { TelegramCooldownBanner } from "./components/shared/TelegramCooldownBanner";
const WhatsNewDialog = React.lazy(() => import("./components/shared/WhatsNewDialog").then(m => ({ default: m.WhatsNewDialog })));
import { useSettings } from "./context/SettingsContext";
import { useTranslation } from "react-i18next";

import { getLanguageInfo } from "./i18n/languages";
import { resolveLanguagePreference } from "./i18n/resolveLanguage";
import { version as rawPkgVersion } from "../package.json";
import { resolveRuntimeAppVersion } from "../shared/versioning";
const appVersion = resolveRuntimeAppVersion(rawPkgVersion);
import { consumeWhatsNew, type WhatsNewDetails } from "./services/updateReliability";
import { ensureLanguageResource } from "./i18n";
import { publishNativeLanguage } from "./services/nativeLanguage";
import { setDataSaverActive } from "./services/imagePreviewCache";
import { formatBytes } from "./utils";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

let languageApplyQueue: Promise<void> = Promise.resolve();

interface StartupProgress {
  stage: "initial" | "local" | "session" | "empty" | "invalid" | "connect" | "account";
  percent: number;
}

function AppContent() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [startupProgress, setStartupProgress] = useState<StartupProgress>({
    stage: "initial",
    percent: 8,
  });
  const [whatsNew, setWhatsNew] = useState<WhatsNewDetails | null>(() => consumeWhatsNew(appVersion));
  const { theme } = useTheme();
  const { isMobile } = usePlatform();
  const { available, version, downloading, progress, phase, downloadAndInstall, dismissUpdate } = useUpdates();
  const { settings, updateSetting, isLoaded, persistenceStatus, retryPersistence } = useSettings();
  const { i18n, t } = useTranslation();

  // Handle active language and RTL direction changes
  useEffect(() => {
    if (!isLoaded) return;
    const activeLang = resolveLanguagePreference(settings.language);
    const info = getLanguageInfo(activeLang);
    let cancelled = false;
    void ensureLanguageResource(activeLang)
      .then(() => {
        const operation = languageApplyQueue.then(async () => {
          if (cancelled) return;
          await i18n.changeLanguage(activeLang);
          if (cancelled) return;
          document.documentElement.lang = activeLang;
          document.documentElement.dir = info.dir;
          await publishNativeLanguage(activeLang);
        });
        // Serialize IPC as well as language application, including across remounts.
        // An older dispatched language completes before the next valid language.
        languageApplyQueue = operation.catch(() => undefined);
        return operation;
      })
      .catch(() => {
        if (import.meta.env.DEV) console.error(`[i18n] Unable to load ${activeLang}`);
      });
    return () => { cancelled = true; };
  }, [settings.language, isLoaded, i18n]);

  // Performance mode: auto-enable when user has prefers-reduced-motion
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mediaQuery.matches && !settings.performanceMode) {
      updateSetting('performanceMode', true);
    }
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches && !settings.performanceMode) {
        updateSetting('performanceMode', true);
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  // Apply performance-mode class to body (guarded by settings load to avoid flicker)
  useEffect(() => {
    if (!isLoaded) return;
    if (settings.performanceMode) {
      document.body.classList.add('performance-mode');
    } else {
      document.body.classList.remove('performance-mode');
    }
  }, [settings.performanceMode, isLoaded]);

  // Sync Data Saver mode to preview cache & Android native media streamer
  useEffect(() => {
    if (!isLoaded) return;
    setDataSaverActive(Boolean(settings.dataSaverMode));
    if (isMobile) {
      void invoke('cmd_set_data_saver_mode', { enabled: Boolean(settings.dataSaverMode) }).catch(() => {});
    }
  }, [settings.dataSaverMode, isLoaded, isMobile]);

  // Non-blocking quiet notices for split large files, once-ever ultra-low-RAM phones, and once-per-session Mobile Data
  useEffect(() => {
    let disposed = false;
    const seenSplitIds = new Set<string>();
    const unlisteners: Array<() => void> = [];

    void listen<{ id?: string; fileName: string; totalBytes: number; partCount: number }>(
      'split-file-notice',
      ({ payload }) => {
        if (disposed || !payload) return;
        const dedupeKey = payload.id || `${payload.fileName}:${payload.totalBytes}`;
        if (seenSplitIds.has(dedupeKey)) return;
        seenSplitIds.add(dedupeKey);
        toast.info(
          t('settings.notice_split_file', {
            name: payload.fileName,
            count: payload.partCount,
          }),
          { duration: 4500 },
        );
      },
    )
      .then(fn => {
        if (disposed) fn();
        else unlisteners.push(fn);
      })
      .catch(() => {});

    void listen<{
      kind: 'ultra-low-ram' | 'mobile-data';
      sizeBytes?: number;
      dataSaverActive?: boolean;
    }>('quiet-hardware-notice', ({ payload }) => {
      if (disposed || !payload) return;
      if (payload.kind === 'ultra-low-ram') {
        toast.info(t('settings.notice_ultra_low_ram'), { duration: 6000 });
      } else if (payload.kind === 'mobile-data' && !payload.dataSaverActive) {
        toast.info(
          t('settings.notice_mobile_data_large', {
            size: formatBytes(payload.sizeBytes ?? 0),
          }),
          { duration: 5000 },
        );
      }
    })
      .then(fn => {
        if (disposed) fn();
        else unlisteners.push(fn);
      })
      .catch(() => {});

    return () => {
      disposed = true;
      for (const fn of unlisteners) fn();
    };
  }, [t]);

  // On mount: check for a saved session and auto-restore it.
  // This is the SINGLE source of truth for the initial connection.
  // useTelegramConnection (inside Dashboard) no longer calls cmd_connect on mount.
  useEffect(() => {
    const checkSession = async () => {
      try {
        setStartupProgress({ stage: "local", percent: 18 });
        await invoke("cmd_get_startup_health");
        setStartupProgress({ stage: "session", percent: 38 });
        const store = await load("config.json");
        let savedId = await store.get<string | number>("api_id");
        const legacyApiHash = await store.get<string>("api_hash");
        if (legacyApiHash) {
          try {
            await invoke('cmd_store_api_hash', { apiHash: legacyApiHash });
            await store.delete('api_hash');
            await store.save();
          } catch {
            // Preserve the only working copy and retry migration next launch.
            // Session restoration needs only the public API ID.
          }
        }

        if (!savedId) {
          // Self-heal from persisted engine database if config.json lacked api_id
          const savedInfo = await invoke<{
            apiId?: number | null;
            hasApiHash?: boolean;
            hasSession?: boolean;
          } | null>("cmd_get_saved_session_info").catch(() => null);
          if (savedInfo?.apiId && savedInfo.hasApiHash && savedInfo.hasSession) {
            savedId = String(savedInfo.apiId);
            await store.set("api_id", String(savedInfo.apiId));
            await store.save();
          }
        }

        if (!savedId) {
          setStartupProgress({ stage: "empty", percent: 100 });
          setAuthStatus("unauthenticated");
          return;
        }

        const apiId = typeof savedId === "number" ? savedId : parseInt(String(savedId), 10);
        if (isNaN(apiId) || apiId <= 0) {
          setStartupProgress({ stage: "invalid", percent: 100 });
          setAuthStatus("unauthenticated");
          return;
        }

        // Initialize the client with the saved API ID
        setStartupProgress({ stage: "connect", percent: 58 });
        await invoke("cmd_connect", { apiId });

        // Verify the session is still valid with Telegram servers (offline-resilient)
        setStartupProgress({ stage: "account", percent: 82 });
        const ok = await invoke<boolean>("cmd_check_connection");
        if (ok) {
          setAuthStatus("authenticated");
        } else {
          setAuthStatus("unauthenticated");
        }
      } catch (err) {
        console.warn("Session restore encountered an error; preserving saved credentials:", err);
        // Never wipe saved api_id on transient startup errors; only explicit logout clears credentials.
        setAuthStatus("unauthenticated");
      }
    };

    checkSession();
  }, []);

  // Warm-up screen driven by actual Rust health and Telegram session steps.
  if (authStatus === "loading") {
    const visibleProgress: StartupProgress = startupProgress;
    return (
      <main className="h-screen w-screen flex items-center justify-center bg-telegram-bg">
        <div className="flex w-full max-w-sm flex-col items-center gap-5 px-8" role="status" aria-live="polite">
          <img src="/logo.svg" className="w-16 h-16 drop-shadow-lg animate-pulse" alt={i18n.t("common.app_title")} />
          <div className="w-full text-center">
            <p className="text-sm font-semibold text-telegram-text">{t(`runtime.startup_${visibleProgress.stage}_label`)}</p>
            <p className="mt-1 text-xs text-telegram-subtext">{t(`runtime.startup_${visibleProgress.stage}_detail`)}</p>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10" aria-label={t('runtime.startup_percent',{percent:visibleProgress.percent})}>
            <div className="h-full rounded-full bg-telegram-primary transition-[width] duration-300" style={{ width: `${visibleProgress.percent}%` }} />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="absolute inset-0 text-telegram-text overflow-hidden selection:bg-telegram-primary/30">
      <UpdateBanner
        available={available}
        version={version}
        downloading={downloading}
        progress={progress}
        phase={phase}
        onUpdate={downloadAndInstall}
        onDismiss={dismissUpdate}
      />
      <Toaster theme={theme} position="bottom-center" />
      <TelegramCooldownBanner />
      {persistenceStatus === 'error' && (
        <div className="fixed inset-x-4 top-4 z-[400] mx-auto flex max-w-xl items-center justify-between gap-3 rounded-lg border border-app-danger/30 bg-app-surface-raised px-4 py-3 text-sm text-app-text shadow-xl" role="alert">
          <span>{t('common.operation_failed')}</span>
          <button type="button" onClick={() => void retryPersistence().catch(() => undefined)} className="quiet-control shrink-0 bg-app-accent px-3 py-1.5 font-medium text-app-accent-contrast">
            {t('common.retry')}
          </button>
        </div>
      )}
      {whatsNew && <Suspense fallback={null}><WhatsNewDialog details={whatsNew} onClose={() => setWhatsNew(null)} /></Suspense>}
      {authStatus === "authenticated" && (
        <Suspense fallback={
          <div className="h-screen w-screen flex flex-col items-center justify-center bg-telegram-bg">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-telegram-primary"></div>
          </div>
        }>
          <ErrorBoundary>
            {isMobile ? (
              <MobileDashboard onLogout={() => setAuthStatus("unauthenticated")} />
            ) : (
              <DesktopDashboard onLogout={() => setAuthStatus("unauthenticated")} />
            )}
          </ErrorBoundary>
        </Suspense>
      )}
      {authStatus === "unauthenticated" && (
        <Suspense fallback={<div className="h-screen bg-telegram-bg" />}>
          <AuthWizard onLogin={() => setAuthStatus("authenticated")} />
        </Suspense>
      )}
    </main>
  );
}


function App() {
  return (
    <AppProviders>
      <AppContent />
    </AppProviders>
  );
}

export default App;
