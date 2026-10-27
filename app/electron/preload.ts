import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface ElectronBridgeApi {
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

async function unwrapIpcInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const cleaned = raw
      .replace(/^Error invoking remote method '[^']+':\s*/, '')
      .replace(/^Error:\s*/, '');
    throw new Error(cleaned || 'IPC invocation failed');
  }
}

const api: ElectronBridgeApi = {
  isElectron: true,
  platform: 'windows',
  invoke: (cmd, args) => unwrapIpcInvoke('td:invoke', cmd, args ?? {}),
  emitToBackend: (event, payload) => {
    ipcRenderer.send('td:client-event', event, payload);
  },
  onBackendEvent: callback => {
    const handler = (_e: Electron.IpcRendererEvent, eventName: string, payload: unknown) => {
      callback(eventName, payload);
    };
    ipcRenderer.on('td:event', handler);
    return () => {
      ipcRenderer.removeListener('td:event', handler);
    };
  },
  windowAction: (action, payload) => unwrapIpcInvoke('td:window', action, payload),
  storeAction: (storeName, action, key, value) =>
    unwrapIpcInvoke('td:store', storeName, action, key, value),
  dialogAction: (kind, options) => unwrapIpcInvoke('td:dialog', kind, options ?? {}),
  openExternal: url => unwrapIpcInvoke('td:open-external', url),
  openPath: targetPath => unwrapIpcInvoke('td:open-path', targetPath),
  revealItemInDir: targetPath => unwrapIpcInvoke('td:reveal-path', targetPath),
  clipboardReadText: () => unwrapIpcInvoke<string>('td:clipboard', 'read'),
  clipboardWriteText: async text => {
    await unwrapIpcInvoke('td:clipboard', 'write', text);
  },
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('telegramDriveElectron', api);
