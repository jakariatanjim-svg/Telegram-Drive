import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { load } from '@tauri-apps/plugin-store';
import jsQR from 'jsqr';
import {
  Camera,
  ClipboardPaste,
  ImagePlus,
  KeyRound,
  Loader2,
  QrCode,
  SwitchCamera,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { extractDeviceLinkCode } from '../../../shared/deviceLink';
import { isAndroidNative, TelegramDriveNative } from '../../platform/nativeBridge';

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats?: string[] }): BarcodeDetectorLike;
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

interface DeviceLinkReceiverModalProps {
  isOpen: boolean;
  initialMode?: 'scan' | 'code';
  onClose: () => void;
  onLinked: () => void;
}

export function DeviceLinkReceiverModal({
  isOpen,
  initialMode = 'scan',
  onClose,
  onLinked,
}: DeviceLinkReceiverModalProps) {
  const [mode, setMode] = useState<'scan' | 'code'>(initialMode);
  const [codeInput, setCodeInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const importingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stopCamera = useCallback(() => {
    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors
        }
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setCameraStarting(false);
  }, []);

  const formatImportError = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err);
    if (/LINK_CODE_EXPIRED/i.test(raw)) {
      return 'This link code has expired (valid for 15 minutes). Generate a fresh QR or code on your logged-in device.';
    }
    if (/UNSUPPORTED_LINK_CODE_VERSION/i.test(raw)) {
      return 'This link code was created by a newer app version. Update Telegram Drive and try again.';
    }
    if (/INVALID_LINK_CODE/i.test(raw)) {
      return 'Invalid or incomplete link code. Scan the Link QR from Telegram Drive or paste the full TD1-... code.';
    }
    if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED/i.test(raw)) {
      return 'That linked session is no longer active. Generate a new QR or code on your logged-in device.';
    }
    return 'Could not complete sign-in with this link code. Check your internet connection and try again.';
  };

  const completeDeviceLink = useCallback(
    async (rawCodeOrUrl: string) => {
      if (importingRef.current) return;
      const extracted = extractDeviceLinkCode(rawCodeOrUrl);
      if (!extracted) {
        setError('Invalid link code. Scan a Telegram Drive Link QR or paste a TD1-... code.');
        return;
      }

      importingRef.current = true;
      setImporting(true);
      setError(null);
      stopCamera();

      try {
        const res = await invoke<{ success: boolean; apiId: number; userId: string }>(
          'cmd_import_device_link',
          { code: extracted },
        );
        try {
          const store = await load('config.json');
          await store.set('api_id', String(res.apiId));
          await store.save();
        } catch {
          // Backend already persisted credentials securely
        }
        toast.success('Device linked and signed in!');
        onClose();
        onLinked();
      } catch (err) {
        setError(formatImportError(err));
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [onClose, onLinked, stopCamera],
  );

  const startCamera = useCallback(async () => {
    stopCamera();
    setCameraError(null);
    setError(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera access is not available in this environment. Switch to Enter Code or choose a QR image.');
      return;
    }

    setCameraStarting(true);
    try {
      if (isAndroidNative()) {
        try {
          const perm = await TelegramDriveNative.ensureCameraPermission();
          if (!perm.granted) {
            setCameraError('Camera permission was denied. Allow camera access or use Enter Code instead.');
            setCameraStarting(false);
            return;
          }
        } catch {
          // Proceed to standard getUserMedia fallback
        }
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }

      streamRef.current = stream;

      if (navigator.mediaDevices.enumerateDevices) {
        void navigator.mediaDevices
          .enumerateDevices()
          .then(devices => {
            const videoInputs = devices.filter(d => d.kind === 'videoinput');
            setHasMultipleCameras(videoInputs.length > 1);
          })
          .catch(() => undefined);
      }

      const video = videoRef.current;
      if (!video) {
        stopCamera();
        return;
      }

      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play();
      setCameraActive(true);
      setCameraStarting(false);

      let detector: BarcodeDetectorLike | null = null;
      if (typeof window !== 'undefined' && window.BarcodeDetector) {
        try {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch {
          detector = null;
        }
      }

      let busyFrame = false;
      scanTimerRef.current = window.setInterval(() => {
        if (busyFrame || importingRef.current) return;
        const vid = videoRef.current;
        if (!vid || vid.readyState < 2 || vid.videoWidth <= 0 || vid.videoHeight <= 0) {
          return;
        }

        busyFrame = true;
        void (async () => {
          try {
            if (detector) {
              try {
                const hits = await detector.detect(vid);
                for (const hit of hits) {
                  const candidate = extractDeviceLinkCode(hit.rawValue);
                  if (candidate) {
                    await completeDeviceLink(candidate);
                    return;
                  }
                }
              } catch {
                // Fall through to universal jsQR canvas decoder
              }
            }

            let canvas = canvasRef.current;
            if (!canvas) {
              canvas = document.createElement('canvas');
              canvasRef.current = canvas;
            }
            const maxDim = 720;
            const scale = Math.min(1, maxDim / Math.max(vid.videoWidth, vid.videoHeight));
            const w = Math.max(1, Math.floor(vid.videoWidth * scale));
            const h = Math.max(1, Math.floor(vid.videoHeight * scale));
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;

            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(vid, 0, 0, w, h);
            const imageData = ctx.getImageData(0, 0, w, h);
            const qr = jsQR(imageData.data, w, h, { inversionAttempts: 'attemptBoth' });
            if (qr?.data) {
              const candidate = extractDeviceLinkCode(qr.data);
              if (candidate) {
                await completeDeviceLink(candidate);
              }
            }
          } finally {
            busyFrame = false;
          }
        })();
      }, 150);
    } catch {
      stopCamera();
      setCameraError(
        'No camera found or camera access was blocked. You can paste the Link Code or choose a QR screenshot below.',
      );
    }
  }, [completeDeviceLink, facingMode, stopCamera]);

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      setCodeInput('');
      setError(null);
      setCameraError(null);
      return;
    }
    setMode(initialMode);
  }, [initialMode, isOpen, stopCamera]);

  useEffect(() => {
    if (!isOpen) return;
    if (mode === 'scan' && !importing) {
      void startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen, mode, facingMode, importing, startCamera, stopCamera]);

  const handleImageSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError(null);
    try {
      const bitmap = await createImageBitmap(file);
      try {
        let canvas = canvasRef.current;
        if (!canvas) {
          canvas = document.createElement('canvas');
          canvasRef.current = canvas;
        }
        const maxDim = 1200;
        const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.floor(bitmap.width * scale));
        const h = Math.max(1, Math.floor(bitmap.height * scale));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('CANVAS_UNAVAILABLE');
        ctx.drawImage(bitmap, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const qr = jsQR(imageData.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (!qr?.data) {
          setError('No QR code was found in that image. Try a clearer image or paste the Link Code.');
          return;
        }
        await completeDeviceLink(qr.data);
      } finally {
        bitmap.close?.();
      }
    } catch {
      setError('Could not read that image. Try pasting the Link Code instead.');
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await readText();
      if (!text || !text.trim()) {
        toast.error('Clipboard is empty');
        return;
      }
      setCodeInput(text.trim());
      const extracted = extractDeviceLinkCode(text);
      if (extracted) {
        await completeDeviceLink(extracted);
      } else {
        setError('Clipboard does not contain a valid TD1-... link code.');
      }
    } catch {
      toast.error('Paste directly into the box using Ctrl+V or long-press Paste.');
    }
  };

  const handleCodeSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!codeInput.trim() || importing) return;
    void completeDeviceLink(codeInput);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!importing) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-app-border bg-app-surface p-5 text-app-text shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-app-accent/15 text-app-accent">
              <QrCode className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-app-text">Link from Logged-in Device</h2>
              <p className="text-xs text-app-text-secondary">
                Open <strong>Settings → Link Another Device</strong> on your other device
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={importing}
            onClick={onClose}
            aria-label="Close"
            className="quiet-control flex h-8 w-8 items-center justify-center rounded-lg text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-xl border border-app-border-subtle bg-app-hover/50 p-1">
          <button
            type="button"
            disabled={importing}
            onClick={() => {
              setError(null);
              setMode('scan');
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              mode === 'scan'
                ? 'bg-app-surface text-app-text shadow-sm'
                : 'text-app-text-secondary hover:text-app-text'
            }`}
          >
            <Camera className="h-3.5 w-3.5" /> Scan QR
          </button>
          <button
            type="button"
            disabled={importing}
            onClick={() => {
              setError(null);
              setMode('code');
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              mode === 'code'
                ? 'bg-app-surface text-app-text shadow-sm'
                : 'text-app-text-secondary hover:text-app-text'
            }`}
          >
            <KeyRound className="h-3.5 w-3.5" /> Enter Code
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={e => void handleImageSelected(e)}
          className="hidden"
        />

        {importing ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
            <p className="mt-3 text-sm font-semibold text-app-text">Signing in automatically...</p>
            <p className="mt-1 text-xs text-app-text-secondary">
              Setting up API credentials and linking your Telegram Drive session
            </p>
          </div>
        ) : mode === 'scan' ? (
          <div className="mt-4 space-y-3">
            <div className="relative aspect-square w-full overflow-hidden rounded-2xl border border-app-border bg-black">
              <video
                ref={videoRef}
                muted
                playsInline
                className={`h-full w-full object-cover ${cameraActive ? 'opacity-100' : 'opacity-0'}`}
              />

              {cameraActive && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-48 w-48 rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.38)]" />
                </div>
              )}

              {cameraStarting && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-4 text-center text-white">
                  <Loader2 className="h-7 w-7 animate-spin text-app-accent" />
                  <p className="mt-2 text-xs font-medium">Starting camera...</p>
                </div>
              )}

              {!cameraStarting && cameraError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 p-5 text-center text-white">
                  <Camera className="h-7 w-7 text-white/60" />
                  <p className="mt-2 text-xs leading-5 text-white/85">{cameraError}</p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setMode('code')}
                      className="rounded-lg bg-app-accent px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Use Link Code
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-lg border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20"
                    >
                      Choose QR Image
                    </button>
                  </div>
                </div>
              )}

              {cameraActive && hasMultipleCameras && (
                <button
                  type="button"
                  onClick={() =>
                    setFacingMode(prev => (prev === 'environment' ? 'user' : 'environment'))
                  }
                  title="Switch camera"
                  className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-xl bg-black/65 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/80"
                >
                  <SwitchCamera className="h-3.5 w-3.5" /> Flip
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-app-text-secondary">
                Point your camera or webcam at the QR code
              </span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-app-border px-2.5 py-1.5 text-xs font-medium text-app-text hover:bg-app-hover"
              >
                <ImagePlus className="h-3.5 w-3.5 text-app-accent" /> QR Image
              </button>
            </div>

            {error && (
              <p className="rounded-xl bg-app-danger/10 px-3 py-2 text-xs text-app-danger">
                {error}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={handleCodeSubmit} className="mt-4 space-y-3">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="device-link-code-input" className="text-xs font-medium text-app-text-secondary">
                  Link Code from your logged-in device
                </label>
                <button
                  type="button"
                  onClick={() => void handlePasteClipboard()}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-app-accent hover:bg-app-accent/10"
                >
                  <ClipboardPaste className="h-3.5 w-3.5" /> Paste & Sign In
                </button>
              </div>
              <textarea
                id="device-link-code-input"
                rows={4}
                autoFocus
                value={codeInput}
                onChange={e => setCodeInput(e.target.value)}
                placeholder="TD1-..."
                className="w-full resize-none rounded-xl border border-app-border bg-app-surface-raised p-3 font-mono text-xs text-app-text placeholder:text-app-text-tertiary focus:border-app-accent focus:outline-none"
              />
            </div>

            {error && (
              <p className="rounded-xl bg-app-danger/10 px-3 py-2 text-xs text-app-danger">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!codeInput.trim() || importing}
              className="quiet-control auth-primary-action w-full disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" /> Sign In with Code
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
