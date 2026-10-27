import { androidEngine } from '../androidEngine';
import { getElectronBridge, isAndroidNative, TelegramDriveNative } from '../nativeBridge';

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  multiple?: boolean;
  directory?: boolean;
  defaultPath?: string;
  title?: string;
  filters?: DialogFilter[];
  recursive?: boolean;
}

export interface SaveDialogOptions {
  defaultPath?: string;
  title?: string;
  filters?: DialogFilter[];
}

export function open(options: OpenDialogOptions & { multiple: true }): Promise<string[] | null>;
export function open(options?: OpenDialogOptions & { multiple?: false }): Promise<string | null>;
export function open(options?: OpenDialogOptions): Promise<string | string[] | null>;
export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  const bridge = getElectronBridge();
  if (bridge) {
    return (await bridge.dialogAction('open', options as Record<string, unknown>)) as
      | string
      | string[]
      | null;
  }

  if (isAndroidNative() && !options.directory) {
    const res = await TelegramDriveNative.pickFiles({ multiple: Boolean(options.multiple) });
    if (!res.files || res.files.length === 0) return null;
    const paths = res.files.map(f => f.cachedPath);
    return options.multiple ? paths : paths[0];
  }

  return await new Promise<string | string[] | null>(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = Boolean(options.multiple);
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      if (files.length === 0) {
        resolve(null);
        return;
      }
      const pseudoPaths = files.map(file => {
        const key = `/picked/${Date.now()}_${file.name}`;
        androidEngine.registerBrowserSelectedFile(key, file);
        return key;
      });
      resolve(options.multiple ? pseudoPaths : pseudoPaths[0]);
    };

    input.oncancel = () => {
      input.remove();
      resolve(null);
    };

    input.click();
  });
}

export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  const bridge = getElectronBridge();
  if (bridge) {
    return (await bridge.dialogAction('save', options as Record<string, unknown>)) as string | null;
  }
  return options.defaultPath ?? `download_${Date.now()}`;
}
