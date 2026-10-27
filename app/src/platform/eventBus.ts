import { getElectronBridge, isAndroidNative, TelegramDriveNative } from './nativeBridge';

export interface PlatformEvent<T = unknown> {
  event: string;
  id: number;
  payload: T;
}

export type UnlistenFn = () => void;

type Handler = (event: PlatformEvent<unknown>) => void;

const listeners = new Map<string, Set<Handler>>();
let nextEventId = 1;
let initialized = false;

function ensureInitialized(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  const bridge = getElectronBridge();
  if (bridge) {
    bridge.onBackendEvent((eventName, payload) => {
      dispatchLocalEvent(eventName, payload);
    });
  } else if (isAndroidNative()) {
    void TelegramDriveNative.addListener('apkDownloadProgress', data => {
      dispatchLocalEvent('update-download-progress', { progress: data.progress });
    }).catch(() => undefined);

    void TelegramDriveNative.addListener('deepLinkOpened', data => {
      dispatchLocalEvent('td:deep-link', [data.url]);
    }).catch(() => undefined);
  }
}

export function dispatchLocalEvent(eventName: string, payload: unknown): void {
  const set = listeners.get(eventName);
  if (!set || set.size === 0) return;
  const eventObj: PlatformEvent<unknown> = {
    event: eventName,
    id: nextEventId++,
    payload,
  };
  for (const handler of [...set]) {
    try {
      handler(eventObj);
    } catch {
      // Isolate listener errors
    }
  }
}

export async function subscribeEvent<T = unknown>(
  eventName: string,
  handler: (event: PlatformEvent<T>) => void,
): Promise<UnlistenFn> {
  ensureInitialized();
  let set = listeners.get(eventName);
  if (!set) {
    set = new Set();
    listeners.set(eventName, set);
  }
  const wrapped: Handler = ev => handler(ev as PlatformEvent<T>);
  set.add(wrapped);
  return () => {
    set?.delete(wrapped);
  };
}

export async function emitPlatformEvent(eventName: string, payload?: unknown): Promise<void> {
  ensureInitialized();
  const bridge = getElectronBridge();
  if (bridge) {
    bridge.emitToBackend(eventName, payload);
  }
  dispatchLocalEvent(eventName, payload);
}
