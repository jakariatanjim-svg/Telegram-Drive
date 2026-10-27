import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';
import { withHttpProxy, withSocksProxy } from '@fuman/net';
import { connectTcp } from '@fuman/node';
import {
  IntermediatePacketCodec,
  MemoryStorage,
  type ICorePlatform,
  type TelegramTransport,
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
}

export class ConfigurableNodeTransport implements TelegramTransport {
  constructor(private readonly getProxy: () => ProxySettingsConfig | null) {}

  async connect(dc: BasicDcOption, abortSignal: AbortSignal) {
    const proxy = this.getProxy();
    const endpoint = { address: dc.ipAddress, port: dc.port };

    if (proxy?.enabled && proxy.host && proxy.port > 0) {
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

  packetCodec() {
    return new IntermediatePacketCodec();
  }
}

function resolveWasmBuffer(): Uint8Array {
  const candidates = [
    path.join(__dirname, 'mtcute.wasm'),
    path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'mtcute.wasm'),
    path.resolve(process.cwd(), 'node_modules', '@mtcute', 'wasm', 'mtcute.wasm'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate);
    }
  }
  throw new Error('mtcute.wasm binary could not be located.');
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

export function createNodeTelegramClient(opts: {
  apiId: number;
  apiHash: string;
  getProxy: () => ProxySettingsConfig | null;
}): TelegramClient {
  const wasmBytes = resolveWasmBuffer();
  const baseClient = new BaseTelegramClient({
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    storage: new MemoryStorage(),
    crypto: new WebCryptoProvider({
      crypto: nodeCrypto.webcrypto as unknown as NonNullable<ConstructorParameters<typeof WebCryptoProvider>[0]>['crypto'],
      wasmInput: wasmBytes,
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
