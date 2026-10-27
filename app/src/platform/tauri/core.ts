import { Capacitor } from '@capacitor/core';
import { androidEngine } from '../androidEngine';
import { getElectronBridge, isAndroidNative } from '../nativeBridge';

export type InvokeArgs = Record<string, unknown>;

export function isTauri(): boolean {
  return Boolean(getElectronBridge() || isAndroidNative());
}

export async function invoke<T = unknown>(cmd: string, args?: InvokeArgs): Promise<T> {
  const electronBridge = getElectronBridge();
  if (electronBridge) {
    return (await electronBridge.invoke(cmd, args ?? {})) as T;
  }
  return (await androidEngine.invoke(cmd, args ?? {})) as T;
}

export function convertFileSrc(filePath: string, _protocol = 'asset'): string {
  if (!filePath) return '';
  if (/^(blob:|data:|https?:|tdfile:|app:)/i.test(filePath)) {
    return filePath;
  }
  if (getElectronBridge()) {
    return `tdfile://local?path=${encodeURIComponent(filePath)}`;
  }
  if (isAndroidNative()) {
    return Capacitor.convertFileSrc(filePath);
  }
  return filePath;
}
