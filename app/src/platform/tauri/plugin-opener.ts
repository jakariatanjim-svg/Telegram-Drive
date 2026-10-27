import { getElectronBridge, isAndroidNative, TelegramDriveNative } from '../nativeBridge';

export async function openUrl(url: string): Promise<void> {
  if (!url) return;
  const bridge = getElectronBridge();
  if (bridge) {
    await bridge.openExternal(url);
    return;
  }
  if (isAndroidNative()) {
    await TelegramDriveNative.openExternalUrl({ url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function openPath(targetPath: string): Promise<void> {
  if (!targetPath) return;
  const bridge = getElectronBridge();
  if (bridge) {
    await bridge.openPath(targetPath);
    return;
  }
  if (isAndroidNative()) {
    await TelegramDriveNative.openFileExternally({ path: targetPath });
  }
}

export async function revealItemInDir(targetPath: string): Promise<void> {
  if (!targetPath) return;
  const bridge = getElectronBridge();
  if (bridge) {
    await bridge.revealItemInDir(targetPath);
  }
}
