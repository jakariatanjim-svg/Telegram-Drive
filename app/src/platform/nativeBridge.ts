import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface PickedAndroidFile {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
  cachedPath: string;
}

export interface AndroidEnvironmentSnapshot {
  connected: boolean;
  metered: boolean;
  roaming: boolean;
  charging: boolean;
  batteryLow: boolean;
  storageLow: boolean;
  freeBytes: number;
  powerSaveMode: boolean;
  backgroundRestricted: boolean;
  deviceRamBytes?: number;
  availableRamBytes?: number;
  ultraLowRam?: boolean;
  systemDataSaver?: boolean;
  network_connected: boolean;
  wifi_connected: boolean;
  battery_percent: number;
  power_save_mode: boolean;
  available_storage_bytes: number;
  notification_permission: 'granted' | 'denied' | 'prompt';
  recovery_supported: boolean;
}

export interface MediaStreamRequestEvent {
  reqId: string;
  method: string;
  folder: string;
  messageId: number;
  range: string;
}

export interface TelegramDriveNativePlugin {
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  secureRemove(options: { key: string }): Promise<void>;
  isBiometricAvailable(): Promise<{ available: boolean }>;
  authenticate(options: { reason: string }): Promise<{ authenticated: boolean }>;
  setPrivacyScreen(options: { enabled: boolean }): Promise<{ applied: boolean }>;
  getTransferEnvironment(): Promise<AndroidEnvironmentSnapshot>;
  startForegroundService(options?: { title?: string; body?: string }): Promise<void>;
  updateForegroundService(options: Record<string, unknown>): Promise<void>;
  stopForegroundService(): Promise<void>;
  getPendingTransferAction(): Promise<{ action: string }>;
  getPendingShareCount(): Promise<{ count: number }>;
  listSharedCachedFiles(): Promise<{ files: Array<{ uri: string; file_name: string; file_size: number; cached_path: string }> }>;
  removeSharedCachedFile(options: { uri: string }): Promise<void>;
  getFileInfo(options: { path: string }): Promise<{ name: string; size: number; mimeType: string }>;
  readFileChunkBase64(options: { path: string; offset: number; length: number }): Promise<{ data: string; bytesRead: number }>;
  readFileBase64(options: { path: string }): Promise<{ data: string; name: string; size: number }>;
  writeFileBase64(options: { directory: 'cache' | 'downloads'; filename: string; data: string; mimeType?: string }): Promise<{ path: string; uri: string }>;
  openDownloadSink(options: { resumeKey: string; expectedTotalBytes: number }): Promise<{ sinkId: string; existingBytes: number }>;
  appendDownloadChunkBase64(options: { sinkId: string; data: string }): Promise<void>;
  finalizeDownloadSink(options: { sinkId: string; directory: 'cache' | 'downloads'; filename: string; mimeType?: string }): Promise<{ path: string; uri: string }>;
  abortDownloadSink(options: { sinkId: string; deletePartial?: boolean }): Promise<void>;
  startLocalMediaServer(): Promise<{ port: number; token: string; baseUrl: string }>;
  respondMediaStreamHeader(options: {
    reqId: string;
    status: number;
    mimeType: string;
    totalSize: number;
    start: number;
    end: number;
    acceptRanges?: boolean;
  }): Promise<void>;
  pushMediaStreamChunk(options: { reqId: string; data: string }): Promise<{ closed: boolean }>;
  endMediaStream(options: { reqId: string; error?: string }): Promise<void>;
  pickFiles(options: { multiple?: boolean }): Promise<{ files: PickedAndroidFile[] }>;
  openFileExternally(options: { path: string; mimeType?: string }): Promise<void>;
  openStreamPlayer(options: { streamUrl: string; title?: string; mimeType?: string }): Promise<void>;
  openExternalUrl(options: { url: string }): Promise<void>;
  ensureCameraPermission(): Promise<{ granted: boolean }>;
  downloadAndInstallApk(options: { downloadUrl: string; fileName: string }): Promise<void>;
  addListener(
    eventName: 'apkDownloadProgress',
    listenerFunc: (data: { progress: number }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'deepLinkOpened',
    listenerFunc: (data: { url: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mediaStreamRequest',
    listenerFunc: (data: MediaStreamRequestEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mediaStreamAbort',
    listenerFunc: (data: { reqId: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const TelegramDriveNative = registerPlugin<TelegramDriveNativePlugin>('TelegramDriveNative');

export interface ElectronPreloadBridge {
  readonly isElectron: true;
  readonly platform: 'windows';
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  emitToBackend: (event: string, payload?: unknown) => void;
  onBackendEvent: (callback: (event: string, payload: unknown) => void) => () => void;
  windowAction: (action: string, payload?: unknown) => Promise<unknown>;
  storeAction: (
    storeName: string,
    action: 'get' | 'set' | 'delete' | 'clear' | 'keys' | 'entries' | 'save',
    key?: string,
    value?: unknown,
  ) => Promise<unknown>;
  dialogAction: (kind: 'open' | 'save', options?: Record<string, unknown>) => Promise<unknown>;
  openExternal: (url: string) => Promise<void>;
  openPath: (targetPath: string) => Promise<void>;
  revealItemInDir: (targetPath: string) => Promise<void>;
  clipboardReadText: () => Promise<string>;
  clipboardWriteText: (text: string) => Promise<void>;
  getPathForFile: (file: File) => string;
}

declare global {
  interface Window {
    telegramDriveElectron?: ElectronPreloadBridge;
  }
}

export function getElectronBridge(): ElectronPreloadBridge | null {
  return typeof window !== 'undefined' && window.telegramDriveElectron
    ? window.telegramDriveElectron
    : null;
}

export function isAndroidNative(): boolean {
  if (getElectronBridge()) return false;
  if (typeof window !== 'undefined' && 'androidBridge' in window && Boolean((window as unknown as { androidBridge?: unknown }).androidBridge)) {
    return true;
  }
  return Capacitor.getPlatform() === 'android';
}
