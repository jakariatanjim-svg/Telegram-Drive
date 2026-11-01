import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Check, Copy, Loader2, Lock, QrCode, RefreshCw, ShieldAlert, Smartphone, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import type { CreateDeviceLinkResult } from '../../../shared/deviceLink';

interface DeviceLinkGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DeviceLinkGeneratorModal({ isOpen, onClose }: DeviceLinkGeneratorModalProps) {
  const [loading, setLoading] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [twoFaPassword, setTwoFaPassword] = useState('');
  const [linkData, setLinkData] = useState<{
    code: string;
    qrValue: string;
    expiresAt: number;
    dedicatedSession: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);

  const generateLink = useCallback(async (password?: string) => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const res = await invoke<CreateDeviceLinkResult>('cmd_create_device_link', {
        password: password?.trim() ? password : undefined,
      });
      if (res.status === 'password_required') {
        setNeedsPassword(true);
        setLinkData(null);
        return;
      }
      setNeedsPassword(false);
      setTwoFaPassword('');
      setLinkData({
        code: res.code,
        qrValue: res.qrValue,
        expiresAt: res.expiresAt,
        dedicatedSession: res.dedicatedSession,
      });
      setRemainingSeconds(Math.max(0, Math.floor((res.expiresAt - Date.now()) / 1000)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/PASSWORD_HASH_INVALID/i.test(msg)) {
        setError('Incorrect Telegram 2FA password. Please try again.');
      } else {
        setError('Could not prepare device link. Check your connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setLinkData(null);
      setNeedsPassword(false);
      setTwoFaPassword('');
      setError(null);
      setCopied(false);
      return;
    }
    void generateLink();
  }, [isOpen, generateLink]);

  useEffect(() => {
    if (!linkData) return;
    const tick = () => {
      const secs = Math.max(0, Math.floor((linkData.expiresAt - Date.now()) / 1000));
      setRemainingSeconds(secs);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [linkData]);

  const handleCopyCode = async () => {
    if (!linkData?.code) return;
    try {
      await writeText(linkData.code);
      setCopied(true);
      toast.success('Link code copied');
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error('Could not copy automatically. Select and copy the code below.');
    }
  };

  const handlePasswordSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!twoFaPassword.trim() || loading) return;
    void generateLink(twoFaPassword);
  };

  if (!isOpen) return null;

  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  const expired = Boolean(linkData && remainingSeconds <= 0);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-app-border bg-app-surface p-5 text-app-text shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-app-accent/15 text-app-accent">
              <Smartphone className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-app-text">Link Another Device</h2>
              <p className="text-xs text-app-text-secondary">
                Sign in on your phone or PC in one step
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="quiet-control flex h-8 w-8 items-center justify-center rounded-lg text-app-text-secondary hover:bg-app-hover hover:text-app-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {loading && !needsPassword && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Loader2 className="h-7 w-7 animate-spin text-app-accent" />
              <p className="mt-3 text-xs font-medium text-app-text">
                Preparing instant sign-in QR & code...
              </p>
              <p className="mt-1 text-[11px] text-app-text-tertiary">
                Creating a ready-to-use Telegram session for your other device
              </p>
            </div>
          )}

          {needsPassword && (
            <form onSubmit={handlePasswordSubmit} className="space-y-3 pt-1">
              <div className="rounded-xl border border-app-border-subtle bg-app-hover/40 p-3 text-xs text-app-text-secondary">
                Your Telegram account is protected by a 2FA Cloud Password. Enter it once here so the new device signs in right away.
              </div>
              <div>
                <label htmlFor="device-link-2fa" className="auth-label">
                  Telegram 2FA Password
                </label>
                <div className="relative">
                  <Lock className="auth-input-icon" />
                  <input
                    id="device-link-2fa"
                    type="password"
                    autoFocus
                    value={twoFaPassword}
                    onChange={e => setTwoFaPassword(e.target.value)}
                    placeholder="Enter 2FA password"
                    className="auth-input"
                  />
                </div>
              </div>
              {error && (
                <p className="rounded-lg bg-app-danger/10 px-3 py-2 text-xs text-app-danger">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={loading || !twoFaPassword.trim()}
                className="quiet-control auth-primary-action w-full disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Authorizing...
                  </>
                ) : (
                  <>
                    <QrCode className="h-4 w-4" /> Generate QR & Code
                  </>
                )}
              </button>
            </form>
          )}

          {!loading && !needsPassword && error && (
            <div className="space-y-3 py-4 text-center">
              <p className="rounded-xl bg-app-danger/10 px-3 py-2.5 text-xs text-app-danger">
                {error}
              </p>
              <button
                type="button"
                onClick={() => void generateLink()}
                className="quiet-control auth-secondary-action mx-auto"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Try Again
              </button>
            </div>
          )}

          {!loading && !needsPassword && linkData && (
            <>
              <div className="flex flex-col items-center rounded-2xl border border-app-border-subtle bg-app-hover/30 p-4">
                <div className={`rounded-xl bg-white p-3 shadow-sm ${expired ? 'opacity-30 blur-[2px]' : ''}`}>
                  <QRCodeSVG
                    value={linkData.qrValue}
                    size={212}
                    level="L"
                    marginSize={2}
                    bgColor="#ffffff"
                    fgColor="#0f172a"
                  />
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs">
                  {expired ? (
                    <span className="font-medium text-app-danger">Code expired</span>
                  ) : (
                    <span className="font-mono text-app-text-secondary">
                      Valid for {mins}:{secs.toString().padStart(2, '0')}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void generateLink()}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-app-accent hover:bg-app-accent/10"
                  >
                    <RefreshCw className="h-3 w-3" /> Refresh
                  </button>
                </div>
                <p className="mt-1 text-center text-[11px] text-app-text-tertiary">
                  On your other device’s first screen, tap <strong>Link from Logged-in Device</strong> and scan this QR or paste the code below.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-app-text-secondary">
                    Or use Link Code (no camera needed)
                  </span>
                  <button
                    type="button"
                    disabled={expired}
                    onClick={() => void handleCopyCode()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-app-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-95 disabled:opacity-50"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3.5 w-3.5" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" /> Copy Code
                      </>
                    )}
                  </button>
                </div>
                <input
                  type="text"
                  readOnly
                  value={linkData.code}
                  onFocus={e => e.currentTarget.select()}
                  aria-label="Device link code"
                  className="w-full rounded-xl border border-app-border bg-app-surface-raised px-3 py-2 font-mono text-[11px] text-app-text focus:outline-none"
                />
              </div>

              <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-4 text-app-text-secondary">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                <span>
                  Only use this QR or code on your own device. It includes your API credentials and a ready Telegram session.
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
