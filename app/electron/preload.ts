import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron';

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

const api: ElectronBridgeApi = {
  isElectron: true,
  platform: 'windows',
  invoke: (cmd, args) => ipcRenderer.invoke('td:invoke', cmd, args ?? {}),
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
  windowAction: (action, payload) => ipcRenderer.invoke('td:window', action, payload),
  storeAction: (storeName, action, key, value) =>
    ipcRenderer.invoke('td:store', storeName, action, key, value),
  dialogAction: (kind, options) => ipcRenderer.invoke('td:dialog', kind, options ?? {}),
  openExternal: url => ipcRenderer.invoke('td:open-external', url),
  openPath: targetPath => ipcRenderer.invoke('td:open-path', targetPath),
  revealItemInDir: targetPath => ipcRenderer.invoke('td:reveal-path', targetPath),
  clipboardReadText: async () => clipboard.readText(),
  clipboardWriteText: async text => {
    clipboard.writeText(text);
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
