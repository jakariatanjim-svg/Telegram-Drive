import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { Sun, Moon, ExternalLink, X } from "lucide-react";
import { load } from '@tauri-apps/plugin-store';
import { toast } from 'sonner';
import { useTheme } from '../../context/ThemeContext';
import { open } from '@tauri-apps/plugin-shell';
import { extractDeviceLinkCode } from '../../../shared/deviceLink';
import { DeviceLinkReceiverModal } from './DeviceLinkReceiverModal';
import {
    AuthCodeStep,
    AuthMethodStep,
    AuthPasswordStep,
    AuthSetupStep,
    type AuthStep,
    type CodeRequestResult,
} from './auth/AuthSteps';

import { Trans, useTranslation } from "react-i18next";
import i18n from '../../i18n';

function AuthThemeToggle() {
    useTranslation();
    const { theme, toggleTheme } = useTheme();
    return (
        <button
            onClick={toggleTheme}
            className="quiet-control absolute end-4 top-[calc(1rem+env(safe-area-inset-top,24px))] z-10 flex h-9 w-9 items-center justify-center border border-app-border bg-app-surface-raised text-app-text-secondary shadow-[var(--shadow-raised)] hover:text-app-text"
            title={theme === 'dark' ? i18n.t("common.switch_light") : i18n.t("common.switch_dark")}
            aria-label={theme === 'dark' ? i18n.t("common.switch_light") : i18n.t("common.switch_dark")}
        >
            {theme === 'dark' ? (
                <Sun className="h-4 w-4" />
            ) : (
                <Moon className="h-4 w-4" />
            )}
        </button>
    );
}
export function AuthWizard({ onLogin }: { onLogin: () => void }) {
    const { t } = useTranslation();

    const [step, setStep] = useState<AuthStep>("setup");
    const [loading, setLoading] = useState(false);

    const [apiId, setApiId] = useState("");
    const [apiHash, setApiHash] = useState("");

    const [phone, setPhone] = useState("");
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [floodWait, setFloodWait] = useState<number | null>(null);
    const [showHelp, setShowHelp] = useState(false);
    const isMobile = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
    const [loginMethod, setLoginMethod] = useState<'phone' | 'qr'>(() => isMobile ? 'phone' : 'qr');
    const [codeDelivery, setCodeDelivery] = useState<CodeRequestResult | null>(null);
    const [resendWait, setResendWait] = useState(0);

    useEffect(() => {
        if (isMobile && loginMethod !== 'phone') {
            setLoginMethod('phone');
        }
    }, [isMobile, loginMethod]);
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const [qrPolling, setQrPolling] = useState(false);
    const [qrScanned, setQrScanned] = useState(false);
    const [importingPortable, setImportingPortable] = useState(false);
    const [deviceLinkOpen, setDeviceLinkOpen] = useState(false);
    const [deviceLinkMode, setDeviceLinkMode] = useState<'scan' | 'code'>('scan');
    const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const onLoginRef = useRef(onLogin);
    onLoginRef.current = onLogin;

    useEffect(() => {
        let cancelled = false;
        let unlistenDeepLink: (() => void) | null = null;

        const consumeIncomingLinkUrl = async (rawUrl: string) => {
            const code = extractDeviceLinkCode(rawUrl);
            if (!code || cancelled) return;
            setImportingPortable(true);
            setError(null);
            try {
                const res = await invoke<{ success: boolean; apiId: number; userId: string }>(
                    'cmd_import_device_link',
                    { code },
                );
                try {
                    const store = await load('config.json');
                    await store.set('api_id', String(res.apiId));
                    await store.save();
                } catch {
                    // Already persisted by backend
                }
                if (!cancelled) {
                    toast.success('Device linked and signed in!');
                    onLoginRef.current();
                }
            } catch {
                if (!cancelled) {
                    setError('Invalid or expired device link. Generate a fresh QR or code on your logged-in device.');
                }
            } finally {
                if (!cancelled) {
                    setImportingPortable(false);
                }
            }
        };

        if (typeof window !== 'undefined') {
            const hrefCode = extractDeviceLinkCode(window.location.href);
            if (hrefCode) {
                try {
                    const cleanUrl = new URL(window.location.href);
                    cleanUrl.searchParams.delete('code');
                    cleanUrl.searchParams.delete('link');
                    window.history.replaceState({}, '', cleanUrl.toString());
                } catch {
                    // Ignore URL cleanup errors
                }
                void consumeIncomingLinkUrl(hrefCode);
            }
        }

        void onOpenUrl(urls => {
            for (const url of urls) {
                if (extractDeviceLinkCode(url)) {
                    void consumeIncomingLinkUrl(url);
                    break;
                }
            }
        }).then(fn => {
            if (cancelled) fn();
            else unlistenDeepLink = fn;
        });

        return () => {
            cancelled = true;
            unlistenDeepLink?.();
        };
    }, []);

    const cancelQrFlow = useCallback(() => {
        setQrPolling(false);
        setQrScanned(false);
        void invoke("cmd_auth_qr_cancel").catch(() => {});
    }, []);

    useEffect(() => {
        return () => {
            void invoke("cmd_auth_qr_cancel").catch(() => {});
        };
    }, []);


    useEffect(() => {
        if (!floodWait) return;
        const interval = setInterval(() => {
            setFloodWait(prev => {
                if (prev === null || prev <= 1) return null;
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(interval);
    }, [floodWait]);

    useEffect(() => {
        if (resendWait <= 0) return;
        const interval = setInterval(() => {
            setResendWait((previous) => Math.max(0, previous - 1));
        }, 1000);
        return () => clearInterval(interval);
    }, [resendWait]);

    useEffect(() => {
        const initStore = async () => {
            try {
                const store = await load('config.json');
                const savedId = await store.get<string>('api_id');
                const legacyHash = await store.get<string>('api_hash');
                let savedHash: string | null = null;
                let secureLoadFailed = false;
                try {
                    savedHash = await invoke<string | null>('cmd_load_api_hash');
                } catch {
                    // A legacy value can still be used for this launch without
                    // deleting it. New values are never written back as JSON.
                    savedHash = legacyHash ?? null;
                    secureLoadFailed = true;
                }

                if ((!savedHash || secureLoadFailed) && legacyHash) {
                    // Delete the legacy plaintext copy only after the platform
                    // credential manager confirms the migration succeeded.
                    try {
                        await invoke('cmd_store_api_hash', { apiHash: legacyHash });
                        savedHash = legacyHash;
                        try {
                            await store.delete('api_hash');
                            await store.save();
                        } catch {
                            // Secure storage already succeeded. Keep using it and
                            // retry legacy cleanup on the next launch.
                        }
                    } catch {
                        // Keep the legacy value for this launch and retry secure
                        // migration next time; never delete the only working copy.
                        savedHash = legacyHash;
                    }
                }

                if (savedId && savedHash) {
                    setApiId(savedId);
                    setApiHash(savedHash);
                } else {
                    try {
                        const savedSession = await invoke<{ hasSession: boolean; apiId: number | null }>('cmd_get_saved_session_info');
                        if (savedSession?.apiId && savedHash) {
                            setApiId(String(savedSession.apiId));
                            setApiHash(savedHash);
                        } else if (savedSession?.apiId && !savedId) {
                            setApiId(String(savedSession.apiId));
                        }
                    } catch {
                        // ignore
                    }
                }
            } catch {
                // config not found, starting fresh
            }
        };
        initStore();
    }, []);

    const saveCredentials = async () => {
        await invoke('cmd_store_api_hash', { apiHash });
        const store = await load('config.json');
        await store.set('api_id', apiId);
        await store.delete('api_hash');
        await store.save();
    };

    const handleSetupSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (apiId.includes(' ') || apiHash.includes(' ')) {
            setError(t('auth_copy.no_spaces'));
            return;
        }

        if (!apiId || !apiHash) {
            setError(t('auth_copy.credentials_required'));
            return;
        }
        setError(null);
        try {
            await saveCredentials();
        } catch {
            setError(t('common.operation_failed'));
            return;
        }
        setStep("phone");
        setLoginMethod(isMobile ? 'phone' : 'qr');
        setQrUrl(null);
        setQrPolling(false);
        if (!isMobile) void handleQrLogin();
    };

    const handleQrLogin = async () => {
        setError(null);
        setQrScanned(false);
        setLoading(true);
        try {
            const idInt = parseInt(apiId, 10);
            if (isNaN(idInt)) throw new Error(t('auth_copy.id_number'));

            const url = await invoke<string>("cmd_auth_qr_login", {
                apiId: idInt,
                apiHash: apiHash
            });

            if (url === "__authorized__") {
                setQrPolling(false);
                onLoginRef.current();
                return;
            }
            if (url === "__password_required__") {
                setQrPolling(false);
                setStep("password");
                return;
            }

            setQrUrl(url);
            setQrPolling(true);
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setLoading(false);
        }
    };

    const runPortableImport = async (sourcePath: string) => {
        setError(null);
        setImportingPortable(true);
        try {
            const result = await invoke<{ restoredSession: boolean; restoredVault: boolean; restoredApiId: number | null; restoredStores: string[] }>(
                'cmd_import_portable_bundle',
                { sourcePath },
            );
            toast.success(result.restoredSession ? 'Portable session & data restored.' : 'Portable settings restored.');
            if (result.restoredSession) {
                onLoginRef.current();
                return;
            }
            window.location.reload();
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setImportingPortable(false);
        }
    };

    const handleImportPortableFile = async () => {
        try {
            const selected = await openDialog({
                directory: false,
                multiple: false,
                title: 'Import Telegram Drive Portable Package (.tdmigrate)',
                filters: [{ name: 'Telegram Drive Portable Migration', extensions: ['tdmigrate'] }],
            });
            if (!selected || Array.isArray(selected)) return;
            await runPortableImport(selected);
        } catch (err: unknown) {
            handleAuthError(err);
        }
    };

    const handleImportPortableFolder = async () => {
        try {
            const selected = await openDialog({
                directory: true,
                multiple: false,
                title: 'Select Previous Telegram Drive Folder or Portable Data Folder',
            });
            if (!selected || Array.isArray(selected)) return;
            await runPortableImport(selected);
        } catch (err: unknown) {
            handleAuthError(err);
        }
    };

    const applyCodeRequestResult = (codeRequest: CodeRequestResult) => {
        if (codeRequest.status === "authorized") {
            onLogin();
            return;
        }

        setCode("");
        setCodeDelivery(codeRequest);
        setResendWait(Math.max(0, codeRequest.resendAfterSeconds ?? 0));
        setStep("code");
    };

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | null = null;

        void listen<{
            status: 'url' | 'scanned' | 'password_required' | 'authorized' | 'error';
            url?: string;
            error?: string;
        }>('qr-auth-update', (event) => {
            if (cancelled) return;
            const payload = event.payload;
            if (!payload) return;

            if (payload.status === 'url' && payload.url) {
                setQrScanned(false);
                setQrUrl(prev => (payload.url && payload.url !== prev ? payload.url : prev));
            } else if (payload.status === 'scanned') {
                setQrScanned(true);
            } else if (payload.status === 'password_required') {
                setQrScanned(false);
                setQrPolling(false);
                setStep('password');
            } else if (payload.status === 'authorized') {
                setQrScanned(false);
                setQrPolling(false);
                onLoginRef.current();
            } else if (payload.status === 'error' && payload.error) {
                setQrScanned(false);
                setQrPolling(false);
                const floodMatch = payload.error.match(/FLOOD_WAIT_(\d+)/);
                if (floodMatch) {
                    setFloodWait(Number.parseInt(floodMatch[1], 10));
                } else {
                    setError(payload.error);
                }
            }
        }).then((dispose) => {
            if (cancelled) dispose();
            else unlisten = dispose;
        }).catch(() => {});

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        if (!qrPolling) {
            if (qrPollRef.current) {
                clearInterval(qrPollRef.current);
                qrPollRef.current = null;
            }
            return;
        }

        qrPollRef.current = setInterval(async () => {
            try {
                const pollResult = await invoke<{ success: boolean; next_step?: string; url?: string | null; scanned?: boolean }>("cmd_auth_qr_poll");
                if (pollResult.url) {
                    setQrUrl(prev => (pollResult.url && pollResult.url !== prev ? pollResult.url : prev));
                }
                if (typeof pollResult.scanned === 'boolean') {
                    setQrScanned(pollResult.scanned);
                }
                if (pollResult.next_step === "password") {
                    setQrScanned(false);
                    setQrPolling(false);
                    setStep("password");
                } else if (pollResult.success) {
                    setQrScanned(false);
                    setQrPolling(false);
                    onLoginRef.current();
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (/API_ID_INVALID|API_CREDENTIALS_MISSING|FLOOD_WAIT_/i.test(msg)) {
                    setQrScanned(false);
                    setQrPolling(false);
                    handleAuthError(err);
                }
                // Otherwise ignore transient errors while Telegram rotates the QR token.
            }
        }, 1200);

        return () => {
            if (qrPollRef.current) {
                clearInterval(qrPollRef.current);
                qrPollRef.current = null;
            }
        };
    }, [qrPolling, apiId, apiHash]);

    const handleAuthError = (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const floodMatch = message.match(/FLOOD_WAIT_(\d+)/);
        if (floodMatch) {
            setFloodWait(Number.parseInt(floodMatch[1], 10));
            return;
        }
        setError(message);
    };

    const handlePhoneSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const idInt = parseInt(apiId, 10);
            if (isNaN(idInt)) throw new Error(t('auth_copy.id_number'));

            const codeRequest = await invoke<CodeRequestResult>("cmd_auth_request_code", {
                phone,
                apiId: idInt,
                apiHash: apiHash
            });
            applyCodeRequestResult(codeRequest);
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setLoading(false);
        }
    };

    const handleCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const signInResult = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_sign_in", { code });
            if (signInResult.success) {
                onLogin();
            } else if (signInResult.next_step === "password") {
                setStep("password");
            } else {
                setError(t('common.operation_failed'));
            }
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setLoading(false);
        }
    };

    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const passwordResult = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_check_password", { password });
            if (passwordResult.success) {
                onLogin();
            } else {
                setError(t('common.operation_failed'));
            }
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setLoading(false);
        }
    };

    const handleResendCode = async () => {
        if (resendWait > 0 || loading) return;
        setLoading(true);
        setError(null);
        try {
            const codeRequest = await invoke<CodeRequestResult>("cmd_auth_resend_code");
            applyCodeRequestResult(codeRequest);
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setLoading(false);
        }
    };

    const handleChangePhone = async () => {
        try {
            await invoke("cmd_auth_cancel_code");
        } catch {
            // Cancellation is best-effort; local backend state is always cleared.
        }
        setCode("");
        setCodeDelivery(null);
        setResendWait(0);
        setError(null);
        setStep("phone");
    };

    const handleUseQrInstead = () => {
        setCode("");
        setCodeDelivery(null);
        setResendWait(0);
        setError(null);
        setStep("phone");
        setLoginMethod("qr");
        setQrUrl(null);
        setQrPolling(false);
        void handleQrLogin();
    };

    const handleOpenFragment = async () => {
        if (!codeDelivery?.fragmentUrl) return;
        try {
            const target = new URL(codeDelivery.fragmentUrl);
            const isFragment = target.protocol === "https:"
                && (target.hostname === "fragment.com" || target.hostname.endsWith(".fragment.com"));
            if (!isFragment) throw new Error(t('auth.fragment_url_invalid'));
            await open(target.toString());
        } catch {
            setError(t("auth.fragment_url_invalid"));
        }
    };

    const deliveryMessage = (() => {
        if (!codeDelivery) return "";
        const hint = codeDelivery.destinationHint ?? "";
        switch (codeDelivery.delivery) {
            case "telegram_app": return t("auth.code_sent_telegram_app");
            case "sms": return t("auth.code_sent_sms");
            case "call": return t("auth.code_sent_call");
            case "flash_call": return t("auth.code_sent_flash_call", { hint });
            case "missed_call": return t("auth.code_sent_missed_call", { hint });
            case "email": return t("auth.code_sent_email", { hint });
            case "fragment": return t("auth.code_sent_fragment");
            case "sms_word": return t("auth.code_sent_sms_word", { hint });
            case "sms_phrase": return t("auth.code_sent_sms_phrase", { hint });
            case "email_setup":
            case "firebase":
            default: return t("auth.code_delivery_unsupported");
        }
    })();

    return (
        <div className="auth-gradient relative flex h-full w-full items-center justify-center overflow-y-auto p-4 pt-[calc(1rem+env(safe-area-inset-top,24px))] text-app-text sm:p-6">
            <AuthThemeToggle />

            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="auth-glass my-auto w-full max-w-[26rem] rounded-overlay p-5 sm:p-6"
            >
                <div className="mb-6 text-center">
                    <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center">
                        <img src="/logo.svg" alt={i18n.t('common.app_title')} className="w-full h-full" />
                    </div>
                    <h1 className="text-app-title font-semibold tracking-[-0.01em] text-app-text">{i18n.t("common.app_title")}</h1>
                    <p className="mt-1 text-metadata text-app-text-secondary">{i18n.t("auth.tagline")}</p>
                </div>

                <AnimatePresence mode="wait">
                    {floodWait ? (
                        <motion.div
                            key="flood"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="space-y-5 text-center"
                        >
                            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-container bg-app-danger/10">
                                <span className="text-xl">⏳</span>
                            </div>
                            <div>
                                <h2 className="text-app-title font-semibold text-app-text">{i18n.t("auth.too_many_requests")}</h2>
                                <p className="mt-2 text-ui text-app-text-secondary">{i18n.t("auth.flood_wait_msg")}</p>
                                <p className="text-ui text-app-text-secondary">{i18n.t("auth.please_wait")}</p>
                            </div>

                            <div className="flex items-center justify-center font-mono text-3xl font-semibold tabular-nums text-app-accent">
                                {Math.floor(floodWait / 60)}:{(floodWait % 60).toString().padStart(2, '0')}
                            </div>

                            <p className="mt-4 text-metadata text-app-danger">
                                {i18n.t("auth.timer_reset_warning")}
                            </p>
                        </motion.div>
                    ) : (
                        <>
                            {step === "setup" && (
                                <AuthSetupStep
                                    apiId={apiId}
                                    apiHash={apiHash}
                                    isMobile={isMobile}
                                    importingPortable={importingPortable}
                                    onApiIdChange={setApiId}
                                    onApiHashChange={setApiHash}
                                    onSubmit={handleSetupSubmit}
                                    onShowHelp={() => setShowHelp(true)}
                                    onDevLogin={onLogin}
                                    onOpenDeviceLinkScan={() => { setDeviceLinkMode('scan'); setDeviceLinkOpen(true); }}
                                    onOpenDeviceLinkCode={() => { setDeviceLinkMode('code'); setDeviceLinkOpen(true); }}
                                    onImportPortableFile={isMobile ? undefined : () => { void handleImportPortableFile(); }}
                                    onImportPortableFolder={isMobile ? undefined : () => { void handleImportPortableFolder(); }}
                                />
                            )}
                            {step === "phone" && (
                                <AuthMethodStep
                                    isMobile={isMobile}
                                    loginMethod={loginMethod}
                                    loading={loading}
                                    phone={phone}
                                    qrUrl={qrUrl}
                                    qrPolling={qrPolling}
                                    qrScanned={qrScanned}
                                    onPhoneChange={setPhone}
                                    onSelectPhone={() => { cancelQrFlow(); setLoginMethod("phone"); setQrUrl(null); setError(null); }}
                                    onSelectQr={() => { setLoginMethod("qr"); setError(null); void handleQrLogin(); }}
                                    onPhoneSubmit={handlePhoneSubmit}
                                    onQrLogin={() => { void handleQrLogin(); }}
                                    onBack={() => { cancelQrFlow(); setStep("setup"); }}
                                />
                            )}
                            {step === "code" && (
                                <AuthCodeStep
                                    codeDelivery={codeDelivery}
                                    deliveryMessage={deliveryMessage}
                                    code={code}
                                    loading={loading}
                                    resendWait={resendWait}
                                    isMobile={isMobile}
                                    onCodeChange={setCode}
                                    onSubmit={handleCodeSubmit}
                                    onOpenFragment={() => { void handleOpenFragment(); }}
                                    onResend={() => { void handleResendCode(); }}
                                    onUseQr={handleUseQrInstead}
                                    onChangePhone={() => { void handleChangePhone(); }}
                                />
                            )}
                            {step === "password" && (
                                <AuthPasswordStep
                                    password={password}
                                    loading={loading}
                                    onPasswordChange={setPassword}
                                    onSubmit={handlePasswordSubmit}
                                    onBack={() => {
                                        // The login code was consumed when Telegram asked for the
                                        // password, so going back restarts from the sign-in method.
                                        setPassword("");
                                        void handleChangePhone();
                                    }}
                                />
                            )}
                        </>
                    )}
                </AnimatePresence>

                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-5 flex items-start gap-2 rounded-control border border-app-danger/20 bg-app-danger/10 p-3"
                    >
                        <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 shrink-0" />
                        <p className="text-ui leading-snug text-app-danger">{error}</p>
                    </motion.div>
                )}

            </motion.div>


            <AnimatePresence>
                {showHelp && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm"
                        onClick={() => setShowHelp(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="quiet-raised max-h-[80vh] w-full max-w-lg overflow-y-auto p-5 sm:p-6"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="mb-5 flex items-center justify-between">
                                <h2 className="text-app-title font-semibold text-app-text">{i18n.t("auth.getting_started")}</h2>
                                <button onClick={() => setShowHelp(false)} className="quiet-control flex h-8 w-8 items-center justify-center text-app-text-secondary hover:text-app-text" aria-label={i18n.t("auth.close_help")}>
                                    <X className="h-4 w-4" />
                                </button>
                            </div>

                            <div className="space-y-5 text-app-text">
                                <div className="rounded-control border border-app-accent/20 bg-app-selected p-3">
                                    <p className="text-ui leading-relaxed text-app-text-secondary">
                                        {t('auth_copy.help_intro')}
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-ui font-semibold">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-app-accent text-badge font-semibold text-app-accent-contrast">1</span>
                                        {t('auth_copy.portal_heading')}
                                    </h3>
                                    <p className="ms-7 text-ui leading-relaxed text-app-text-secondary">
                                        <Trans i18nKey="auth_copy.portal_instruction" components={{ portal: <button type="button" onClick={(e) => { e.preventDefault(); open('https://my.telegram.org'); }} className="cursor-pointer text-app-accent underline hover:text-app-text" /> }} />
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-ui font-semibold">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-app-accent text-badge font-semibold text-app-accent-contrast">2</span>
                                        {t('auth_copy.create_heading')}
                                    </h3>
                                    <p className="ms-7 text-ui leading-relaxed text-app-text-secondary">
                                        {t('auth_copy.create_instruction')}
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-ui font-semibold">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-app-accent text-badge font-semibold text-app-accent-contrast">3</span>
                                        {t('auth_copy.copy_heading')}
                                    </h3>
                                    <p className="ms-7 text-ui leading-relaxed text-app-text-secondary">
                                        {t('auth_copy.copy_instruction', { apiId: t('auth.api_id'), apiHash: t('auth.api_hash') })}
                                    </p>
                                </div>

                                <div className="rounded-control border border-app-border bg-app-surface-sunken/35 p-3">
                                    <p className="text-metadata leading-relaxed text-app-text-secondary">
                                        <strong>{t('auth_copy.privacy')}</strong> {i18n.t("auth.privacy_note")}
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    onClick={(e) => { e.preventDefault(); open('https://my.telegram.org'); }}
                                    className="quiet-control auth-primary-action"
                                >
                                    <ExternalLink className="w-4 h-4" />
                                    {t('auth_copy.open_portal')}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <DeviceLinkReceiverModal
                isOpen={deviceLinkOpen}
                initialMode={deviceLinkMode}
                onClose={() => setDeviceLinkOpen(false)}
                onLinked={onLogin}
            />

        </div>
    );
}
