import { subscribeEvent, type UnlistenFn } from '../eventBus';
import { getElectronBridge } from '../nativeBridge';

export interface AppWindowHandle {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  setFullscreen: (fullscreen: boolean) => Promise<void>;
  isFullscreen: () => Promise<boolean>;
  setFocus: () => Promise<void>;
  show: () => Promise<void>;
  hide: () => Promise<void>;
  setTitle: (title: string) => Promise<void>;
  onResized: (handler: () => void) => Promise<UnlistenFn>;
  onCloseRequested: (handler: () => void) => Promise<UnlistenFn>;
}

const currentWindowHandle: AppWindowHandle = {
  async minimize() {
    await getElectronBridge()?.windowAction('minimize');
  },
  async toggleMaximize() {
    await getElectronBridge()?.windowAction('toggleMaximize');
  },
  async close() {
    await getElectronBridge()?.windowAction('close');
  },
  async isMaximized() {
    return Boolean(await getElectronBridge()?.windowAction('isMaximized'));
  },
  async setFullscreen(fullscreen: boolean) {
    const bridge = getElectronBridge();
    if (bridge) {
      await bridge.windowAction('setFullscreen', fullscreen);
      return;
    }
    if (fullscreen) {
      await document.documentElement.requestFullscreen?.().catch(() => undefined);
    } else if (document.fullscreenElement) {
      await document.exitFullscreen?.().catch(() => undefined);
    }
  },
  async isFullscreen() {
    const bridge = getElectronBridge();
    if (bridge) {
      return Boolean(await bridge.windowAction('isFullscreen'));
    }
    return Boolean(document.fullscreenElement);
  },
  async setFocus() {
    await getElectronBridge()?.windowAction('setFocus');
  },
  async show() {
    await getElectronBridge()?.windowAction('show');
  },
  async hide() {
    await getElectronBridge()?.windowAction('hide');
  },
  async setTitle(title: string) {
    await getElectronBridge()?.windowAction('setTitle', title);
  },
  async onResized(handler: () => void) {
    const unsubBackend = await subscribeEvent('tauri://resize', () => handler());
    const domListener = () => handler();
    window.addEventListener('resize', domListener);
    return () => {
      unsubBackend();
      window.removeEventListener('resize', domListener);
    };
  },
  async onCloseRequested(_handler: () => void) {
    return () => undefined;
  },
};

export function getCurrentWindow(): AppWindowHandle {
  return currentWindowHandle;
}
