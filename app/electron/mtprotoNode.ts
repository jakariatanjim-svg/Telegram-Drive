import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { safeStorage } from 'electron';
import { withHttpProxy, withSocksProxy } from '@fuman/net';
import { connectTcp, nodeReadableToFuman } from '@fuman/node';
import {
  BaseMtProxyTransport,
  IntermediatePacketCodec,
  MemoryStorage,
  type ICorePlatform,
  type TelegramTransport,
  type UploadFileLike,
} from '@mtcute/core';
import { BaseTelegramClient, TelegramClient } from '@mtcute/core/client.js';
import type { BasicDcOption } from '@mtcute/core/utils.js';
import { WebCryptoProvider } from '@mtcute/web';

export interface ProxySettingsConfig {
  enabled: boolean;
  type: 'socks5' | 'http' | 'mtproto';
  host: string;
  port: number;
  username?: string;
  password?: string;
  secret?: string;
}

export function atomicWriteFileSync(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    if (typeof content === 'string') {
      fs.writeFileSync(fd, content, 'utf8');
    } else {
      fs.writeFileSync(fd, content);
    }
    try {
      fs.fsyncSync(fd);
    } catch {
      // Ignore filesystems that do not support fsync on regular files
    }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Windows fallback if an antivirus scanner briefly holds destination open
    fs.copyFileSync(tmpPath, filePath);
    fs.rmSync(tmpPath, { force: true });
  }
}

class NodeMtProxyTransport extends BaseMtProxyTransport {
  override _connectTcp = connectTcp;
}

class NodeCorePlatform implements ICorePlatform {
  log = (_color: number, _level: number, _tag: string, _fmt: string, _args: unknown[]): void => {
    // Keep MTProto runtime logs quiet unless debugging; never write credentials to disk.
  };

  beforeExit(fn: () => void): () => void {
    process.on('beforeExit', fn);
    return () => {
      process.off('beforeExit', fn);
    };
  }

  getDeviceModel(): string {
    return `Telegram Drive Desktop (${os.release()})`;
  }

  getDefaultLogLevel(): number | null {
    return 0;
  }

  async normalizeFile(file: UploadFileLike) {
    if (typeof file === 'string') {
      const stat = await fs.promises.stat(file);
      return {
        file: nodeReadableToFuman(fs.createReadStream(file)) as unknown as UploadFileLike,
        fileSize: stat.size,
        fileName: path.basename(file),
      };
    }
    if (file instanceof Readable) {
      return {
        file: nodeReadableToFuman(file) as unknown as UploadFileLike,
      };
    }
    return null;
  }
}

export class ConfigurableNodeTransport implements TelegramTransport {
  private mtProxyCache: { key: string; transport: NodeMtProxyTransport } | null = null;
  private crypto?: Parameters<BaseMtProxyTransport['setup']>[0];
  private log?: Parameters<BaseMtProxyTransport['setup']>[1];

  constructor(private readonly getProxy: () => ProxySettingsConfig | null) {}

  setup(
    crypto: Parameters<BaseMtProxyTransport['setup']>[0],
    log: Parameters<BaseMtProxyTransport['setup']>[1],
  ): void {
    this.crypto = crypto;
    this.log = log;
  }

  private resolveMtProxy(proxy: ProxySettingsConfig): NodeMtProxyTransport | null {
    if (!proxy.enabled || proxy.type !== 'mtproto' || !proxy.host || proxy.port <= 0 || !proxy.secret) {
      return null;
    }
    const key = `${proxy.host}:${proxy.port}:${proxy.secret}`;
    if (!this.mtProxyCache || this.mtProxyCache.key !== key) {
      const transport = new NodeMtProxyTransport({
        host: proxy.host,
        port: proxy.port,
        secret: proxy.secret,
      });
      if (this.crypto && this.log) {
        transport.setup(this.crypto, this.log);
      }
      this.mtProxyCache = { key, transport };
    }
    return this.mtProxyCache.transport;
  }

  async connect(dc: BasicDcOption, abortSignal: AbortSignal) {
    const proxy = this.getProxy();
    const endpoint = { address: dc.ipAddress, port: dc.port };

    if (proxy?.enabled && proxy.host && proxy.port > 0) {
      const mtProxy = this.resolveMtProxy(proxy);
      if (mtProxy) {
        return mtProxy.connect(dc, abortSignal);
      }
      if (proxy.type === 'http') {
        const dial = withHttpProxy(connectTcp, {
          host: proxy.host,
          port: proxy.port,
          user: proxy.username || undefined,
          password: proxy.password || undefined,
        });
        return dial(endpoint, abortSignal);
      }
      if (proxy.type === 'socks5') {
        const dial = withSocksProxy(connectTcp, {
          host: proxy.host,
          port: proxy.port,
          user: proxy.username || undefined,
          password: proxy.password || undefined,
        });
        return dial(endpoint, abortSignal);
      }
    }

    return connectTcp(endpoint, abortSignal);
  }

  packetCodec(dc: BasicDcOption) {
    const proxy = this.getProxy();
    if (proxy) {
      const mtProxy = this.resolveMtProxy(proxy);
      if (mtProxy) {
        return mtProxy.packetCodec(dc);
      }
    }
    return new IntermediatePacketCodec();
  }
}

let cachedWasmModulePromise: Promise<WebAssembly.Module> | null = null;

function resolveWasmModule(): Promise<WebAssembly.Module> {
  if (!cachedWasmModulePromise) {
    cachedWasmModulePromise = (async () => {
      const candidates = [
        path.join(process.resourcesPath ?? '', 'app.asar.unpacked', 'dist-electron', 'mtcute.wasm'),
        path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'mtcute.wasm'),
        path.join(__dirname, 'mtcute.wasm'),
        path.join(process.resourcesPath ?? '', 'app.asar', 'dist-electron', 'mtcute.wasm'),
        path.join(process.resourcesPath ?? '', 'mtcute.wasm'),
        path.resolve(__dirname, '..', 'node_modules', '@mtcute', 'wasm', 'mtcute.wasm'),
        path.resolve(process.cwd(), 'node_modules', '@mtcute', 'wasm', 'mtcute.wasm'),
      ];
      for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
          const bytes = fs.readFileSync(candidate);
          return WebAssembly.compile(bytes);
        }
      }
      throw new Error('mtcute.wasm binary could not be located.');
    })().catch(err => {
      cachedWasmModulePromise = null;
      throw err;
    });
  }
  return cachedWasmModulePromise;
}

function legacyMachineKey(): Buffer {
  const seed = `telegram-drive-portable:${os.hostname()}:${os.userInfo().username}`;
  return nodeCrypto.createHash('sha256').update(seed).digest();
}

const portableKeyCache = new Map<string, Buffer>();

function getOrCreatePortableKey(sessionDir: string): Buffer {
  const normalizedDir = path.resolve(sessionDir);
  const cached = portableKeyCache.get(normalizedDir);
  if (cached) return cached;

  fs.mkdirSync(normalizedDir, { recursive: true });
  const keyFilePath = path.join(normalizedDir, 'portable.key');
  if (fs.existsSync(keyFilePath)) {
    try {
      const raw = fs.readFileSync(keyFilePath, 'utf8').trim();
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === 32) {
        portableKeyCache.set(normalizedDir, decoded);
        return decoded;
      }
    } catch {
      // Regenerate below if corrupted
    }
  }

  const generated = nodeCrypto.randomBytes(32);
  atomicWriteFileSync(keyFilePath, generated.toString('base64'));
  portableKeyCache.set(normalizedDir, generated);
  return generated;
}

export function clearPortableKeyCache(): void {
  portableKeyCache.clear();
}

/**
 * Encrypts sensitive session/API material using a self-contained portable AES-256-GCM key
 * stored alongside `<data>/session/portable.key` with atomic fsync + rename.
 * Unlike Chromium `safeStorage` (which depends on `data/chromium/Local State` flushing cleanly
 * and breaks if the portable folder is moved to another user/machine), `portable-aes-gcm`
 * survives sudden exits, Windows restarts, and portable directory relocations reliably.
 */
export function writeEncryptedSecretFile(filePath: string, plaintext: string): void {
  const key = getOrCreatePortableKey(path.dirname(filePath));
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  atomicWriteFileSync(
    filePath,
    JSON.stringify({
      scheme: 'portable-aes-gcm',
      v: 1,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    }),
  );
}

export function readEncryptedSecretFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      scheme?: string;
      data?: string;
      iv?: string;
      tag?: string;
    };
    if (!parsed.data) return null;

    if (parsed.scheme === 'portable-aes-gcm' && parsed.iv && parsed.tag) {
      const key = getOrCreatePortableKey(path.dirname(filePath));
      const decipher = nodeCrypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(parsed.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    }

    if (parsed.scheme === 'dpapi' && safeStorage.isEncryptionAvailable()) {
      const plain = safeStorage.decryptString(Buffer.from(parsed.data, 'base64'));
      // Transparently upgrade legacy DPAPI secret file to portable-aes-gcm
      try {
        writeEncryptedSecretFile(filePath, plain);
      } catch {
        // Ignore write-back failure on read-only media
      }
      return plain;
    }

    if (parsed.scheme === 'aes-gcm' && parsed.iv && parsed.tag) {
      const decipher = nodeCrypto.createDecipheriv(
        'aes-256-gcm',
        legacyMachineKey(),
        Buffer.from(parsed.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
      ]);
      const plain = decrypted.toString('utf8');
      try {
        writeEncryptedSecretFile(filePath, plain);
      } catch {
        // Ignore
      }
      return plain;
    }
  } catch {
    return null;
  }
  return null;
}

interface SerializedPeerRecord {
  id: number;
  accessHash: string;
  isMin: boolean;
  usernames: string[];
  phone?: string;
  updated: number;
  complete: string;
}

interface SerializedMtprotoStorageSnapshot {
  version: 1;
  authKeys: Array<[number, string]>;
  authKeysTemp: Array<[string, string]>;
  authKeysTempExpiry: Array<[string, number]>;
  kv: Array<[string, string]>;
  peers: SerializedPeerRecord[];
  refMessages: Array<[number, string[]]>;
}

/**
 * Persistent encrypted file-backed MTProto storage provider extending `MemoryStorage`.
 * Persists all 4 repositories (`authKeys` across all DCs, `kv` state & self user,
 * `peers` including private Drive channel `accessHash`es, and `refMessages` for file_reference
 * refreshes) so cold restarts never lose channel access hashes or secondary DC keys.
 */
export class PersistentMtprotoStorage extends MemoryStorage {
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private loaded = false;

  constructor(private readonly storageFilePath: string) {
    super();
    this.installPersistenceHooks();
    this.loadFromDiskSync();
  }

  private installPersistenceHooks(): void {
    const origDriver = this.driver as unknown as {
      load: () => void | Promise<void>;
      save?: () => void | Promise<void>;
      destroy?: () => void | Promise<void>;
    };

    origDriver.load = () => {
      if (!this.loaded) {
        this.loadFromDiskSync();
      }
    };
    origDriver.save = () => {
      this.flushSync();
    };
    origDriver.destroy = () => {
      this.flushSync();
    };

    const wrapMutator = <T extends object>(repo: T, methods: Array<keyof T>) => {
      for (const method of methods) {
        const orig = repo[method];
        if (typeof orig !== 'function') continue;
        (repo as Record<PropertyKey, unknown>)[method] = (...args: unknown[]) => {
          const result = (orig as (...a: unknown[]) => unknown).apply(repo, args);
          this.scheduleFlush();
          return result;
        };
      }
    };

    wrapMutator(this.authKeys, ['set', 'setTemp', 'deleteByDc', 'deleteAll']);
    wrapMutator(this.kv, ['set', 'delete', 'deleteAll']);
    wrapMutator(this.peers, ['store', 'deleteAll']);
    wrapMutator(this.refMessages, ['store', 'delete', 'deleteByPeer', 'deleteAll']);
  }

  public hasAuthKey(): boolean {
    const authState = (
      this.authKeys as unknown as {
        state: { authKeys: Map<number, Uint8Array> };
      }
    ).state;
    return authState.authKeys.size > 0;
  }

  public loadFromDiskSync(): void {
    this.loaded = true;
    const rawJson = readEncryptedSecretFile(this.storageFilePath);
    if (!rawJson) return;

    try {
      const snapshot = JSON.parse(rawJson) as Partial<SerializedMtprotoStorageSnapshot>;
      const authState = (
        this.authKeys as unknown as {
          state: {
            authKeys: Map<number, Uint8Array>;
            authKeysTemp: Map<string, Uint8Array>;
            authKeysTempExpiry: Map<string, number>;
          };
        }
      ).state;
      const kvState = (
        this.kv as unknown as {
          state: Map<string, Uint8Array>;
        }
      ).state;
      const peersState = (
        this.peers as unknown as {
          state: {
            entities: Map<number, unknown>;
            usernameIndex: Map<string, number>;
            phoneIndex: Map<string, number>;
          };
        }
      ).state;
      const refState = (
        this.refMessages as unknown as {
          state: { refs: Map<number, Set<string>> };
        }
      ).state;

      if (Array.isArray(snapshot.authKeys)) {
        authState.authKeys.clear();
        for (const [dc, b64] of snapshot.authKeys) {
          authState.authKeys.set(Number(dc), new Uint8Array(Buffer.from(b64, 'base64')));
        }
      }
      if (Array.isArray(snapshot.authKeysTemp)) {
        authState.authKeysTemp.clear();
        for (const [k, b64] of snapshot.authKeysTemp) {
          authState.authKeysTemp.set(String(k), new Uint8Array(Buffer.from(b64, 'base64')));
        }
      }
      if (Array.isArray(snapshot.authKeysTempExpiry)) {
        authState.authKeysTempExpiry.clear();
        for (const [k, exp] of snapshot.authKeysTempExpiry) {
          authState.authKeysTempExpiry.set(String(k), Number(exp));
        }
      }
      if (Array.isArray(snapshot.kv)) {
        kvState.clear();
        for (const [k, b64] of snapshot.kv) {
          kvState.set(String(k), new Uint8Array(Buffer.from(b64, 'base64')));
        }
      }
      if (Array.isArray(snapshot.peers)) {
        peersState.entities.clear();
        peersState.usernameIndex.clear();
        peersState.phoneIndex.clear();
        for (const p of snapshot.peers) {
          if (!p || typeof p.id !== 'number' || typeof p.complete !== 'string') continue;
          const usernames = Array.isArray(p.usernames) ? p.usernames.map(String) : [];
          const record = {
            id: p.id,
            accessHash: String(p.accessHash ?? '0'),
            isMin: Boolean(p.isMin),
            usernames,
            phone: typeof p.phone === 'string' ? p.phone : undefined,
            updated: Number(p.updated ?? Date.now()),
            complete: new Uint8Array(Buffer.from(p.complete, 'base64')),
          };
          for (const uname of usernames) {
            peersState.usernameIndex.set(uname.toLowerCase(), record.id);
          }
          if (record.phone) {
            peersState.phoneIndex.set(record.phone, record.id);
          }
          peersState.entities.set(record.id, record);
        }
      }
      if (Array.isArray(snapshot.refMessages)) {
        refState.refs.clear();
        for (const [peerId, refs] of snapshot.refMessages) {
          if (Array.isArray(refs)) {
            refState.refs.set(Number(peerId), new Set(refs.map(String)));
          }
        }
      }
      this.dirty = false;
    } catch {
      // Ignore corrupt snapshot and allow clean regeneration
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, 200);
  }

  public flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty && fs.existsSync(this.storageFilePath)) {
      return;
    }

    try {
      const authState = (
        this.authKeys as unknown as {
          state: {
            authKeys: Map<number, Uint8Array>;
            authKeysTemp: Map<string, Uint8Array>;
            authKeysTempExpiry: Map<string, number>;
          };
        }
      ).state;
      const kvState = (
        this.kv as unknown as {
          state: Map<string, Uint8Array>;
        }
      ).state;
      const peersState = (
        this.peers as unknown as {
          state: {
            entities: Map<
              number,
              {
                id: number;
                accessHash: string;
                isMin: boolean;
                usernames: string[];
                phone?: string;
                updated: number;
                complete: Uint8Array;
              }
            >;
          };
        }
      ).state;
      const refState = (
        this.refMessages as unknown as {
          state: { refs: Map<number, Set<string>> };
        }
      ).state;

      if (
        authState.authKeys.size === 0 &&
        kvState.size === 0 &&
        peersState.entities.size === 0
      ) {
        this.dirty = false;
        return;
      }

      const snapshot: SerializedMtprotoStorageSnapshot = {
        version: 1,
        authKeys: Array.from(authState.authKeys.entries()).map(([dc, bytes]) => [
          dc,
          Buffer.from(bytes).toString('base64'),
        ]),
        authKeysTemp: Array.from(authState.authKeysTemp.entries()).map(([k, bytes]) => [
          k,
          Buffer.from(bytes).toString('base64'),
        ]),
        authKeysTempExpiry: Array.from(authState.authKeysTempExpiry.entries()),
        kv: Array.from(kvState.entries()).map(([k, bytes]) => [
          k,
          Buffer.from(bytes).toString('base64'),
        ]),
        peers: Array.from(peersState.entities.values()).map(p => ({
          id: p.id,
          accessHash: p.accessHash,
          isMin: Boolean(p.isMin),
          usernames: Array.isArray(p.usernames) ? p.usernames : [],
          phone: p.phone,
          updated: p.updated,
          complete: Buffer.from(p.complete).toString('base64'),
        })),
        refMessages: Array.from(refState.refs.entries()).map(([peerId, set]) => [
          peerId,
          Array.from(set),
        ]),
      };

      writeEncryptedSecretFile(this.storageFilePath, JSON.stringify(snapshot));
      this.dirty = false;
    } catch {
      // Best-effort flush
    }
  }

  public clearDisk(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty = false;
    this.authKeys.deleteAll();
    this.kv.deleteAll();
    this.peers.deleteAll();
    this.refMessages.deleteAll();
    fs.rmSync(this.storageFilePath, { force: true });
  }
}

export async function createNodeTelegramClient(opts: {
  apiId: number;
  apiHash: string;
  storage?: PersistentMtprotoStorage;
  getProxy: () => ProxySettingsConfig | null;
}): Promise<TelegramClient> {
  const wasmModule = await resolveWasmModule();
  const baseClient = new BaseTelegramClient({
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    storage: opts.storage ?? new MemoryStorage(),
    storageOptions: {
      saveInterval: 1000,
    },
    updates: false,
    crypto: new WebCryptoProvider({
      crypto: nodeCrypto.webcrypto as unknown as NonNullable<ConstructorParameters<typeof WebCryptoProvider>[0]>['crypto'],
      wasmInput: wasmModule,
    }),
    transport: new ConfigurableNodeTransport(opts.getProxy),
    platform: new NodeCorePlatform(),
    initConnectionOptions: {
      deviceModel: 'Telegram Drive Desktop',
      systemVersion: `Windows ${os.release()}`,
      appVersion: '1.0',
      systemLangCode: 'en',
      langCode: 'en',
    },
  });

  return new TelegramClient({
    client: baseClient,
    disableUpdates: true,
  });
}
