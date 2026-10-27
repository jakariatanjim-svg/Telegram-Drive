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

function fallbackMachineKey(): Buffer {
  const seed = `telegram-drive-portable:${os.hostname()}:${os.userInfo().username}`;
  return nodeCrypto.createHash('sha256').update(seed).digest();
}

export function writeEncryptedSecretFile(filePath: string, plaintext: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(plaintext);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ scheme: 'dpapi', data: buf.toString('base64') }),
      'utf8',
    );
    return;
  }
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', fallbackMachineKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      scheme: 'aes-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    }),
    'utf8',
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
    if (parsed.scheme === 'dpapi' && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(parsed.data, 'base64'));
    }
    if (parsed.scheme === 'aes-gcm' && parsed.iv && parsed.tag) {
      const decipher = nodeCrypto.createDecipheriv(
        'aes-256-gcm',
        fallbackMachineKey(),
        Buffer.from(parsed.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    }
  } catch {
    return null;
  }
  return null;
}

export async function createNodeTelegramClient(opts: {
  apiId: number;
  apiHash: string;
  getProxy: () => ProxySettingsConfig | null;
}): Promise<TelegramClient> {
  const wasmModule = await resolveWasmModule();
  const baseClient = new BaseTelegramClient({
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    storage: new MemoryStorage(),
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
