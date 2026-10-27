import { getElectronBridge } from '../nativeBridge';

export class Store {
  private readonly storeName: string;

  constructor(storeName: string) {
    this.storeName = storeName;
  }

  private lsKey(): string {
    return `td_store_${this.storeName}`;
  }

  private readLocal(): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(this.lsKey());
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private writeLocal(data: Record<string, unknown>): void {
    localStorage.setItem(this.lsKey(), JSON.stringify(data));
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const bridge = getElectronBridge();
    if (bridge) {
      const val = await bridge.storeAction(this.storeName, 'get', key);
      return (val === null ? undefined : val) as T | undefined;
    }
    const map = this.readLocal();
    return (key in map ? map[key] : undefined) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const bridge = getElectronBridge();
    if (bridge) {
      await bridge.storeAction(this.storeName, 'set', key, value);
      return;
    }
    const map = this.readLocal();
    map[key] = value;
    this.writeLocal(map);
  }

  async delete(key: string): Promise<boolean> {
    const bridge = getElectronBridge();
    if (bridge) {
      return Boolean(await bridge.storeAction(this.storeName, 'delete', key));
    }
    const map = this.readLocal();
    if (!(key in map)) return false;
    delete map[key];
    this.writeLocal(map);
    return true;
  }

  async clear(): Promise<void> {
    const bridge = getElectronBridge();
    if (bridge) {
      await bridge.storeAction(this.storeName, 'clear');
      return;
    }
    this.writeLocal({});
  }

  async keys(): Promise<string[]> {
    const bridge = getElectronBridge();
    if (bridge) {
      return ((await bridge.storeAction(this.storeName, 'keys')) as string[]) ?? [];
    }
    return Object.keys(this.readLocal());
  }

  async entries<T = unknown>(): Promise<Array<[string, T]>> {
    const bridge = getElectronBridge();
    if (bridge) {
      return ((await bridge.storeAction(this.storeName, 'entries')) as Array<[string, T]>) ?? [];
    }
    return Object.entries(this.readLocal()) as Array<[string, T]>;
  }

  async save(): Promise<void> {
    const bridge = getElectronBridge();
    if (bridge) {
      await bridge.storeAction(this.storeName, 'save');
    }
  }
}

const instances = new Map<string, Store>();

export async function load(
  path: string,
  _options?: { autoSave?: boolean | number; createNew?: boolean },
): Promise<Store> {
  let inst = instances.get(path);
  if (!inst) {
    inst = new Store(path);
    instances.set(path, inst);
  }
  return inst;
}
