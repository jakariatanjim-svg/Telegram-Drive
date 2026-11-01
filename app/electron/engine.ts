import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, shell } from 'electron';
import {
  MemoryStorage,
  SentCode,
  User,
  type Message,
} from '@mtcute/core';
import type { TelegramClient } from '@mtcute/core/client.js';
import {
  VaultRuntime,
  decryptSettingsSyncPayload,
  encryptSettingsSyncPayload,
  type EncryptedFileRecord,
  type PersistedVaultRecord,
  type VaultStateSettings,
} from '../shared/cryptoVault';
import {
  SETTINGS_SYNC_MARKER,
  TG_DRIVE_CHANNEL_PREFIX,
  createZipFromEntries,
  extractSingleZipEntry,
  formatByteSize,
  guessMimeType,
  listZipEntriesFromBytes,
  mapMessageToTelegramFile,
  mapSentCodeResult,
  type MappedTelegramFile,
} from '../shared/mtprotoHelpers';
import { LocalServersManager, type ShareRecord } from './localServers';
import {
  PersistentMtprotoStorage,
  atomicWriteFileSync,
  createNodeTelegramClient,
  readEncryptedSecretFile,
  readResilientJsonFile,
  removeResilientBackupsSync,
  writeEncryptedSecretFile,
  type ProxySettingsConfig,
} from './mtprotoNode';
import {
  exportPortableDataBundle,
  getPortableMigrationInfo,
  importPortableDataBundleOrFolder,
  launchRelocatedAppAndExit,
  relocatePortableApp,
} from './portableMigration';
import { getPortablePaths } from './portablePaths';
import {
  VideoTranscodeManager,
  cancelPortableFfmpegInstall,
  getFfmpegInstallState,
  installPortableFfmpeg,
  resetFfmpegDetectionCache,
  resolveFfmpegDetails,
} from './transcoder';
import { checkGithubUpdate, downloadAndInstallWindowsUpdate } from './updater';
import { runRobustQrSignIn } from '../shared/qrAuthLoop';
import { mintDeviceLinkBundle, unpackDeviceLinkToken } from '../shared/deviceLink';
import {
  ENCRYPTED_SPLIT_PART_SIZE_BYTES,
  SPLIT_PART_SIZE_BYTES,
  buildSplitManifestCaption,
  buildSplitManifestFileName,
  buildSplitPartCaption,
  buildSplitPartFileName,
  computeSplitPartPlan,
  isSplitPartMessage,
  mapSplitManifestToTelegramFile,
  parseSplitManifestFromMessage,
  parseSplitManifestJsonBytes,
  resolveRangeAcrossParts,
  shouldSplitUpload,
  type SplitFileManifest,
  type SplitUploadCheckpoint,
} from '../shared/splitFiles';

export type EventEmitterFn = (event: string, payload: unknown) => void;

interface StoredFolderMeta {
  id: number;
  name: string;
  group_id: number | null;
  sort_order: number;
  is_hidden: boolean;
  created_at: string;
}

interface StoredFolderGroup {
  id: number;
  name: string;
  color_hex: string;
  sort_order: number;
}

interface StoredSyncPair {
  id: number;
  ownerId: string;
  local_path: string;
  channel_id: number;
  label?: string;
  is_active: boolean;
  sync_direction?: string;
  conflict_policy?: string;
  exclude_patterns?: string[];
  last_synced_at?: string | null;
}

interface StoredSyncConflict {
  pair_id: number;
  ownerId: string;
  relative_path: string;
  local_mtime?: string;
  remote_mtime?: string;
  detected_at: string;
}

interface PersistedDatabase {
  deviceId: string;
  apiId: number | null;
  lastUserId: string | null;
  cachedFilesByFolder: Record<string, MappedTelegramFile[]>;
  weeklyQuotaBytes: number;
  proxy: ProxySettingsConfig;
  vpnCompat: { enabled: boolean; preferIpv4: boolean; bindInterface?: string | null };
  desktopPreferences: Record<string, unknown>;
  folders: StoredFolderMeta[];
  groups: StoredFolderGroup[];
  fileRenames: Record<string, string>;
  favorites: string[];
  pinnedPreviews: string[];
  collections: Record<string, Array<{ id: string; name: string; color: string; icon: string; coverKey: string | null }>>;
  fileCollections: Record<string, string[]>;
  fileTags: Record<string, string[]>;
  savedSearches: Record<string, unknown[]>;
  playback: Record<
    string,
    {
      items: Record<string, unknown>[];
      queue: Record<string, unknown>[];
      preferences: { volume: number; speed: number };
    }
  >;
  removals: Record<string, Array<Record<string, unknown>>>;
  offlinePacks: Record<string, Array<Record<string, unknown>>>;
  shares: ShareRecord[];
  syncPairs: StoredSyncPair[];
  syncConflicts: StoredSyncConflict[];
  storageLimits: Record<string, { previews: number; thumbnails: number; converted: number }>;
  previewCacheMaxGb: number;
  transcodeCacheMaxGb: number;
  apiSettings: { enabled: boolean; port: number; api_key: string };
  webdavSettings: { enabled: boolean; port: number; token_hash: string | null; token_preview: string | null };
  vaultData: {
    vault: PersistedVaultRecord | null;
    settings: VaultStateSettings | null;
    encryptedFiles: EncryptedFileRecord[];
  };
  splitManifests: Record<string, SplitFileManifest>;
  splitUploadCheckpoints: Record<string, SplitUploadCheckpoint>;
  bandwidth: { uploaded: number; downloaded: number };
}

interface TransferJobRecord {
  id: string;
  ownerId?: string | null;
  direction: 'upload' | 'download';
  kind: 'local_upload' | 'url_upload' | 'download';
  status: string;
  path?: string;
  url?: string;
  folderId: number | null;
  messageId?: number;
  filename: string;
  savePath?: string;
  collisionPolicy?: 'overwrite' | 'skip' | 'keep_both';
  downloadOutcome?: 'saved' | 'overwritten' | 'skipped' | 'kept_both';
  protectionMode?: string;
  promptToken?: number;
  protectMetadata?: boolean;
  videoUploadMode?: 'file' | 'media';
  videoFilenameCaption?: boolean;
  tempZipPath?: string;
  origin?: string;
  progress: number;
  transferredBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  error?: string;
  errorCategory?: string | null;
  retryAt?: number;
  queuePosition: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

function folderIdToPeer(folderId: number | null | undefined): 'self' | number {
  if (folderId === null || folderId === undefined || folderId === 0) return 'self';
  return folderId > 0 ? -1000000000000 - folderId : folderId;
}

function fileCompositeKey(folderId: number | null | undefined, messageId: number): string {
  return `${folderId ?? 'saved'}:${messageId}`;
}

function measureDirectory(dirPath: string): { bytes: number; fileCount: number } {
  if (!fs.existsSync(dirPath)) return { bytes: 0, fileCount: 0 };
  let bytes = 0;
  let fileCount = 0;
  const stack = [dirPath];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          fileCount++;
        } catch {
          // ignore race
        }
      }
    }
  }
  return { bytes, fileCount };
}

function resolveCollisionSavePath(
  requestedPath: string,
  policy: 'overwrite' | 'skip' | 'keep_both' = 'keep_both',
): { finalPath: string; outcome: 'saved' | 'overwritten' | 'skipped' | 'kept_both'; skip: boolean } {
  if (!fs.existsSync(requestedPath)) {
    return { finalPath: requestedPath, outcome: 'saved', skip: false };
  }
  if (policy === 'skip') {
    return { finalPath: requestedPath, outcome: 'skipped', skip: true };
  }
  if (policy === 'overwrite') {
    return { finalPath: requestedPath, outcome: 'overwritten', skip: false };
  }
  const parsed = path.parse(requestedPath);
  for (let idx = 1; idx < 10_000; idx++) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${idx})${parsed.ext}`);
    if (!fs.existsSync(candidate)) {
      return { finalPath: candidate, outcome: 'kept_both', skip: false };
    }
  }
  return { finalPath: requestedPath, outcome: 'overwritten', skip: false };
}

export interface ExternalLifecycleHooks {
  flushStoresSync?: () => void;
  reloadStoresSync?: () => void;
  triggerAppQuit?: () => void;
}

function isFatalTelegramAuthError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_DUPLICATED|USER_DEACTIVATED|USER_DEACTIVATED_BAN|SESSION_REVOKED|SESSION_EXPIRED/i.test(
    text,
  );
}

function isPeerCacheMissError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /MtPeerNotFoundError|not found in local cache|CHANNEL_INVALID|PEER_ID_INVALID/i.test(text);
}

function isTransientTransferNetworkError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR|FETCH_FAILED|socket hang up|network|TIMEOUT|FLOOD_WAIT/i.test(
    text,
  );
}

export class DesktopEngine {
  private db!: PersistedDatabase;
  private dbFilePath!: string;
  private sessionFilePath!: string;
  private mtprotoStorageFilePath!: string;
  private apiHashFilePath!: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private mtprotoStorage: PersistentMtprotoStorage | null = null;

  private client: TelegramClient | null = null;
  private currentApiHash: string | null = null;
  private currentUserId: string | null = null;
  private pendingAuth: {
    phone?: string;
    phoneCodeHash?: string;
    apiId?: number;
    apiHash?: string;
  } = {};
  private qrState: {
    latestUrl: string | null;
    scanned: boolean;
    needsPassword: boolean;
    authorized: boolean;
    error: string | null;
    abort: AbortController | null;
    providePassword?: (pw: string) => void;
    pendingPasswordResult?: {
      resolve: () => void;
      reject: (err: Error) => void;
    };
  } = {
    latestUrl: null,
    scanned: false,
    needsPassword: false,
    authorized: false,
    error: null,
    abort: null,
  };

  public readonly vault = new VaultRuntime();
  public readonly transcoder = new VideoTranscodeManager();
  public readonly servers: LocalServersManager;
  private lifecycleHooks: ExternalLifecycleHooks = {};

  private filesCache = new Map<string, MappedTelegramFile[]>();
  private transfers = new Map<string, TransferJobRecord>();
  private activeAbortControllers = new Map<string, AbortController>();
  private explicitlyCancelledTransfers = new Set<string>();
  private directActiveDirections = new Map<string, 'upload' | 'download'>();
  private maxConcurrentUploads = 3;
  private maxConcurrentDownloads = 3;
  private syncWatchers = new Map<number, fs.FSWatcher>();

  constructor(private readonly emitEvent: EventEmitterFn = () => {}) {
    this.servers = new LocalServersManager({
      resolveFileMeta: async (folderId, messageId) => {
        const key = fileCompositeKey(folderId, messageId);
        const encRec = this.vault.getEncryptedFileRecord(key);
        const splitManifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
        if (splitManifest) {
          const customName = this.db.fileRenames[key];
          const displayName = customName || encRec?.originalName || splitManifest.name || `file_${messageId}`;
          return {
            name: displayName,
            size: encRec?.originalSize ?? splitManifest.totalSize,
            mimeType: splitManifest.encrypted
              ? guessMimeType(displayName)
              : splitManifest.mime || guessMimeType(displayName),
            encrypted: Boolean(encRec || splitManifest.encrypted),
          };
        }
        const msg = await this.fetchSingleMessage(folderId, messageId);
        const mapped = mapMessageToTelegramFile(msg, folderId, {
          customName: this.db.fileRenames[key],
          favorite: this.db.favorites.includes(key),
          encryptedRecord: encRec,
        });
        const mediaSize = (msg.media as { fileSize?: number } | null)?.fileSize ?? 0;
        return {
          name: mapped?.name ?? `file_${messageId}`,
          size: mapped?.size || mediaSize,
          mimeType: mapped?.mime_type ?? 'application/octet-stream',
          encrypted: Boolean(encRec || mapped?.encryption_state !== 'plain'),
        };
      },
      readPlainRange: (folderId, messageId, start, endInclusive, signal) =>
        this.streamFileRange(folderId, messageId, start, endInclusive, signal),
      readDecryptedFull: async (folderId, messageId) => {
        const splitManifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
        if (splitManifest && splitManifest.encrypted) {
          const decryptedParts: Uint8Array[] = [];
          let totalPlain = 0;
          for (const part of splitManifest.parts) {
            const rawPart = await this.downloadRawTelegramBytes(folderId, part.id);
            const plainPart = this.vault.decryptBuffer(rawPart).plaintext;
            decryptedParts.push(plainPart);
            totalPlain += plainPart.byteLength;
          }
          const out = new Uint8Array(totalPlain);
          let off = 0;
          for (const p of decryptedParts) {
            out.set(p, off);
            off += p.byteLength;
          }
          return out;
        }
        const raw = await this.downloadRawTelegramBytes(folderId, messageId);
        return this.vault.decryptBuffer(raw).plaintext;
      },
      getShare: id => this.db.shares.find(s => s.id === id),
      incrementShareDownload: id => {
        const found = this.db.shares.find(s => s.id === id);
        if (found) {
          found.download_count++;
          this.scheduleSave();
        }
      },
      listFolders: async () =>
        this.db.folders
          .filter(f => !f.is_hidden)
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(f => ({ id: f.id, name: f.name })),
      listFiles: folderId => this.listFolderFiles(folderId),
      uploadBuffer: async (folderId, fileName, data) => {
        const tmpPath = path.join(getPortablePaths().stagingCacheDir, `${Date.now()}_${path.basename(fileName)}`);
        fs.writeFileSync(tmpPath, Buffer.from(data));
        try {
          await this.performUploadFile({
            filePath: tmpPath,
            fileName,
            folderId,
            transferId: `webdav_${Date.now()}`,
          });
        } finally {
          fs.rmSync(tmpPath, { force: true });
        }
      },
      deleteFile: (folderId, messageId) => this.deleteTelegramMessage(folderId, messageId),
      createFolder: async name => {
        const created = await this.createDriveFolder(name);
        return { id: created.id, name: created.name };
      },
      resolveHlsAssetPath: (fileKey, quality, assetName) =>
        this.transcoder.resolveHlsAssetPath(fileKey, quality, assetName),
      resolveFmp4Path: fileKey => this.transcoder.resolveFmp4Path(fileKey),
    });
  }

  public setLifecycleHooks(hooks: ExternalLifecycleHooks): void {
    this.lifecycleHooks = hooks;
  }

  async initialize(): Promise<void> {
    const paths = getPortablePaths();
    this.dbFilePath = path.join(paths.dbDir, 'state.json');
    this.sessionFilePath = path.join(paths.sessionDir, 'mtproto.session.enc');
    this.mtprotoStorageFilePath = path.join(paths.sessionDir, 'mtproto-storage.enc');
    this.apiHashFilePath = path.join(paths.sessionDir, 'api_hash.enc');

    this.loadDatabase();
    this.hydrateFilesCacheFromDb();
    this.currentUserId = this.db.lastUserId ?? null;
    this.vault.loadPersisted(this.db.vaultData);

    await this.servers.startMediaServer(14201);
    if (this.db.apiSettings.enabled) {
      await this.servers.configureApiServer({
        enabled: true,
        port: this.db.apiSettings.port,
        apiKey: this.db.apiSettings.api_key,
      });
    }
    if (this.db.webdavSettings.enabled && this.db.webdavSettings.token_hash) {
      await this.servers.configureWebDavServer({
        enabled: true,
        port: this.db.webdavSettings.port,
        tokenHash: this.db.webdavSettings.token_hash,
      });
    }
    this.refreshFolderWatchers();
  }

  private hydrateFilesCacheFromDb(): void {
    this.filesCache.clear();
    const saved = this.db.cachedFilesByFolder ?? {};
    for (const [folderKey, files] of Object.entries(saved)) {
      if (Array.isArray(files)) {
        this.filesCache.set(folderKey, files);
      }
    }
  }

  private syncFilesCacheToDb(): void {
    const next: Record<string, MappedTelegramFile[]> = {};
    for (const [k, files] of this.filesCache.entries()) {
      next[k] = files;
    }
    this.db.cachedFilesByFolder = next;
  }

  private loadDatabase(): void {
    const defaults: PersistedDatabase = {
      deviceId: nodeCrypto.randomUUID(),
      apiId: null,
      lastUserId: null,
      cachedFilesByFolder: {},
      weeklyQuotaBytes: 0,
      proxy: { enabled: false, type: 'socks5', host: '127.0.0.1', port: 1080 },
      vpnCompat: { enabled: false, preferIpv4: true, bindInterface: null },
      desktopPreferences: {
        schemaVersion: 1,
        backgroundModeEnabled: true,
        closeBehavior: 'background',
        notificationsEnabled: false,
        notifyCompleted: true,
        notifyFailed: true,
        notifyPaused: true,
        notifyAttention: true,
        notifyWhileVisible: false,
        showFilenamesInNotifications: false,
        backgroundHintSeen: false,
        lockOnSleep: true,
      },
      folders: [],
      groups: [],
      fileRenames: {},
      favorites: [],
      pinnedPreviews: [],
      collections: {},
      fileCollections: {},
      fileTags: {},
      savedSearches: {},
      playback: {},
      removals: {},
      offlinePacks: {},
      shares: [],
      syncPairs: [],
      syncConflicts: [],
      storageLimits: {},
      previewCacheMaxGb: 2,
      transcodeCacheMaxGb: 5,
      apiSettings: {
        enabled: false,
        port: 14280,
        api_key: nodeCrypto.randomBytes(20).toString('hex'),
      },
      webdavSettings: {
        enabled: false,
        port: 14281,
        token_hash: null,
        token_preview: null,
      },
      vaultData: {
        vault: null,
        settings: null,
        encryptedFiles: [],
      },
      splitManifests: {},
      splitUploadCheckpoints: {},
      bandwidth: { uploaded: 0, downloaded: 0 },
    };

    const recovered = readResilientJsonFile<Partial<PersistedDatabase>>(this.dbFilePath);
    if (recovered) {
      this.db = {
        ...defaults,
        ...recovered,
        splitManifests: recovered.splitManifests ?? {},
        splitUploadCheckpoints: recovered.splitUploadCheckpoints ?? {},
      };
      return;
    }
    this.db = defaults;
    this.flushDatabase();
  }

  public getActiveTransferSummary(): {
    activeUploads: number;
    activeDownloads: number;
    totalActive: number;
  } {
    let activeUploads = 0;
    let activeDownloads = 0;
    const countedIds = new Set<string>();

    for (const job of this.transfers.values()) {
      if (job.direction === 'upload' && ['uploading', 'encrypting'].includes(job.status)) {
        activeUploads++;
        countedIds.add(job.id);
      } else if (job.direction === 'download' && ['downloading', 'decrypting'].includes(job.status)) {
        activeDownloads++;
        countedIds.add(job.id);
      }
    }

    for (const [id, dir] of this.directActiveDirections.entries()) {
      if (countedIds.has(id)) continue;
      if (dir === 'upload') activeUploads++;
      else activeDownloads++;
    }

    return {
      activeUploads,
      activeDownloads,
      totalActive: activeUploads + activeDownloads,
    };
  }

  private scheduleSave(): void {
    this.db.vaultData = this.vault.exportPersisted();
    this.syncFilesCacheToDb();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushDatabase();
    }, 150);
  }

  public flushDatabase(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.db.vaultData = this.vault.exportPersisted();
    this.syncFilesCacheToDb();
    atomicWriteFileSync(this.dbFilePath, JSON.stringify(this.db, null, 2));
  }

  public flushSync(): void {
    this.flushDatabase();
    this.mtprotoStorage?.flushSync();
    this.lifecycleHooks.flushStoresSync?.();
  }

  public getDesktopPreferences(): Record<string, unknown> {
    return { ...this.db.desktopPreferences };
  }

  private async persistMtprotoSession(): Promise<void> {
    this.mtprotoStorage?.flushSync();
    if (!this.client) return;
    try {
      const exported = await this.client.exportSession();
      if (exported) {
        writeEncryptedSecretFile(this.sessionFilePath, exported);
      }
    } catch {
      // Session may not be authorized yet during intermediate auth step
    }
    this.mtprotoStorage?.flushSync();
  }

  private async ensureClient(apiId?: number, apiHash?: string): Promise<TelegramClient> {
    const resolvedId = apiId ?? this.db.apiId ?? this.pendingAuth.apiId ?? 0;
    const resolvedHash =
      apiHash ||
      readEncryptedSecretFile(this.apiHashFilePath) ||
      this.pendingAuth.apiHash ||
      '';

    if (!resolvedId || !resolvedHash) {
      throw new Error('API_CREDENTIALS_MISSING');
    }

    if (this.client && this.db.apiId === resolvedId && this.currentApiHash === resolvedHash) {
      return this.client;
    }

    if (this.client) {
      this.mtprotoStorage?.flushSync();
      await this.client.destroy().catch(() => undefined);
      this.client = null;
      this.currentApiHash = null;
    }

    this.db.apiId = resolvedId;
    this.scheduleSave();

    if (!this.mtprotoStorage) {
      this.mtprotoStorage = new PersistentMtprotoStorage(this.mtprotoStorageFilePath);
    } else {
      this.mtprotoStorage.loadFromDiskSync();
    }

    const client = await createNodeTelegramClient({
      apiId: resolvedId,
      apiHash: resolvedHash,
      storage: this.mtprotoStorage,
      getProxy: () => (this.db.proxy.enabled ? this.db.proxy : null),
    });

    if (!this.mtprotoStorage.hasAuthKey()) {
      const savedSession = readEncryptedSecretFile(this.sessionFilePath);
      if (savedSession) {
        try {
          await client.importSession(savedSession, true);
          this.mtprotoStorage.flushSync();
        } catch {
          // Ignore stale session string
        }
      }
    }

    this.client = client;
    this.currentApiHash = resolvedHash;
    return client;
  }

  private async getAccountOwnerId(): Promise<string> {
    if (this.currentUserId) return this.currentUserId;
    if (this.db.lastUserId) {
      this.currentUserId = this.db.lastUserId;
      return this.currentUserId;
    }
    throw new Error('NOT_CONNECTED');
  }

  private async withResolvedFolderPeer<T>(
    folderId: number | null,
    operation: (client: TelegramClient, peer: 'self' | number) => Promise<T>,
  ): Promise<T> {
    const client = await this.ensureClient();
    const peer = folderIdToPeer(folderId);
    try {
      return await operation(client, peer);
    } catch (err) {
      if (folderId !== null && folderId !== 0 && isPeerCacheMissError(err)) {
        await this.scanDriveFolders().catch(() => undefined);
        this.mtprotoStorage?.flushSync();
        return await operation(client, peer);
      }
      throw err;
    }
  }

  private async fetchSingleMessage(folderId: number | null, messageId: number): Promise<Message> {
    const messages = await this.withResolvedFolderPeer(folderId, (client, peer) =>
      client.getMessages(peer, [messageId]),
    );
    const msg = messages[0];
    if (!msg) throw new Error('MESSAGE_NOT_FOUND');
    return msg;
  }

  private async *streamTelegramRange(
    folderId: number | null,
    messageId: number,
    start: number,
    endInclusive: number,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const msg = await this.fetchSingleMessage(folderId, messageId);
    const media = msg.media as unknown as { location?: unknown } | null;
    if (!media) throw new Error('MEDIA_NOT_FOUND');

    const alignedOffset = Math.floor(start / 4096) * 4096;
    let skipBytes = start - alignedOffset;
    let remaining = endInclusive - start + 1;

    const client = await this.ensureClient();
    const iterable = client.downloadAsIterable(msg.media as Parameters<TelegramClient['downloadAsIterable']>[0], {
      offset: alignedOffset,
      partSize: 512,
      abortSignal: signal,
    });

    for await (const rawChunk of iterable) {
      if (signal.aborted || remaining <= 0) break;
      let chunk = rawChunk;
      if (skipBytes > 0) {
        if (chunk.byteLength <= skipBytes) {
          skipBytes -= chunk.byteLength;
          continue;
        }
        chunk = chunk.subarray(skipBytes);
        skipBytes = 0;
      }
      if (chunk.byteLength > remaining) {
        chunk = chunk.subarray(0, remaining);
      }
      remaining -= chunk.byteLength;
      this.db.bandwidth.downloaded += chunk.byteLength;
      yield chunk;
      if (remaining <= 0) break;
    }
  }

  private async downloadRawTelegramBytes(
    folderId: number | null,
    messageId: number,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const msg = await this.fetchSingleMessage(folderId, messageId);
    if (!msg.media) throw new Error('MEDIA_NOT_FOUND');
    const total = ((msg.media as unknown as { fileSize?: number }).fileSize ?? 0);
    const chunks: Uint8Array[] = [];
    let downloaded = 0;
    const client = await this.ensureClient();
    for await (const chunk of client.downloadAsIterable(
      msg.media as Parameters<TelegramClient['downloadAsIterable']>[0],
      { partSize: 512, abortSignal: signal },
    )) {
      chunks.push(chunk);
      downloaded += chunk.byteLength;
      this.db.bandwidth.downloaded += chunk.byteLength;
      onProgress?.(downloaded, total || downloaded);
    }
    const merged = new Uint8Array(downloaded);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  }

  private async ensureSplitManifestLoaded(
    folderId: number | null,
    messageId: number,
  ): Promise<SplitFileManifest | null> {
    const key = fileCompositeKey(folderId, messageId);
    const cached = this.db.splitManifests?.[key];
    if (cached && Array.isArray(cached.parts) && cached.parts.length > 0) {
      return cached;
    }

    const msg = await this.fetchSingleMessage(folderId, messageId);
    const parsedCaption = parseSplitManifestFromMessage(msg);
    if (!parsedCaption) {
      return null;
    }

    if (parsedCaption.inlineManifest) {
      this.db.splitManifests[key] = parsedCaption.inlineManifest;
      this.scheduleSave();
      return parsedCaption.inlineManifest;
    }

    // For ultra-large manifests (>85 parts / >160 GB) whose part list exceeded caption length,
    // read the full JSON body from the lightweight .tgmanifest-<groupId>.json document.
    const rawBytes = await this.downloadRawTelegramBytes(folderId, messageId);
    const fullManifest = parseSplitManifestJsonBytes(rawBytes);
    if (fullManifest) {
      this.db.splitManifests[key] = fullManifest;
      this.scheduleSave();
      return fullManifest;
    }

    return null;
  }

  private async *streamFileRange(
    folderId: number | null,
    messageId: number,
    start: number,
    endInclusive: number,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const manifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
    if (manifest && !manifest.encrypted) {
      const slices = resolveRangeAcrossParts(manifest.parts, start, endInclusive);
      for (const slice of slices) {
        if (signal.aborted) break;
        for await (const chunk of this.streamTelegramRange(
          folderId,
          slice.messageId,
          slice.partLocalStart,
          slice.partLocalEndInclusive,
          signal,
        )) {
          if (signal.aborted) break;
          yield chunk;
        }
      }
      return;
    }

    yield* this.streamTelegramRange(folderId, messageId, start, endInclusive, signal);
  }

  private async streamFullFileToDisk(
    folderId: number | null,
    messageId: number,
    targetPath: string,
    onProgress?: (pct: number) => void,
    promptToken?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmpOut = `${targetPath}.tmp`;
    const key = fileCompositeKey(folderId, messageId);
    const encRec = this.vault.getEncryptedFileRecord(key);
    const manifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
    const abortSig = signal ?? new AbortController().signal;

    const writeChunkWithBackpressure = async (ws: fs.WriteStream, buf: Uint8Array) => {
      if (!ws.write(Buffer.from(buf))) {
        await new Promise<void>(resolve => ws.once('drain', resolve));
      }
    };

    const ws = fs.createWriteStream(tmpOut);
    try {
      if (manifest && (manifest.encrypted || encRec)) {
        let doneParts = 0;
        for (const part of manifest.parts) {
          if (abortSig.aborted) throw new Error('CANCELLED');
          const rawPart = await this.downloadRawTelegramBytes(folderId, part.id, undefined, abortSig);
          const plainPart = this.vault.decryptBuffer(rawPart, { promptToken }).plaintext;
          await writeChunkWithBackpressure(ws, plainPart);
          doneParts++;
          onProgress?.(Math.round((doneParts / manifest.parts.length) * 100));
        }
      } else if (encRec) {
        const rawBytes = await this.downloadRawTelegramBytes(
          folderId,
          messageId,
          (done, total) => {
            if (total > 0) onProgress?.(Math.round((done / total) * 100));
          },
          abortSig,
        );
        const plain = this.vault.decryptBuffer(rawBytes, { promptToken }).plaintext;
        await writeChunkWithBackpressure(ws, plain);
      } else {
        const total = manifest
          ? manifest.totalSize
          : (((await this.fetchSingleMessage(folderId, messageId)).media as { fileSize?: number } | null)?.fileSize ?? 0);
        let done = 0;
        if (total > 0) {
          for await (const chunk of this.streamFileRange(folderId, messageId, 0, total - 1, abortSig)) {
            await writeChunkWithBackpressure(ws, chunk);
            done += chunk.byteLength;
            onProgress?.(Math.min(99, Math.round((done / total) * 100)));
          }
        }
      }
      await new Promise<void>(resolve => ws.end(() => resolve()));
      fs.renameSync(tmpOut, targetPath);
      onProgress?.(100);
    } catch (err) {
      await new Promise<void>(resolve => ws.end(() => resolve()));
      fs.rmSync(tmpOut, { force: true });
      throw err;
    }
  }

  private async listFolderFiles(
    folderId: number | null,
    onChunk?: (chunk: MappedTelegramFile[]) => void,
  ): Promise<MappedTelegramFile[]> {
    const out: MappedTelegramFile[] = [];
    const vaultUnlocked = this.vault.getStatus().is_unlocked;
    let offset: { id: number; date: number } | undefined;
    let manifestCachedDirty = false;

    for (let page = 0; page < 5; page++) {
      const history = await this.withResolvedFolderPeer(folderId, (client, peer) =>
        client.getHistory(peer, { limit: 100, offset }),
      );
      if (history.length === 0) break;
      const pageFiles: MappedTelegramFile[] = [];
      for (const msg of history) {
        // Hide raw split-file parts so the user only sees one unified file
        if (isSplitPartMessage(msg)) {
          continue;
        }

        const key = fileCompositeKey(folderId, msg.id);
        const splitParsed = parseSplitManifestFromMessage(msg);
        if (splitParsed) {
          if (splitParsed.inlineManifest && !this.db.splitManifests[key]) {
            this.db.splitManifests[key] = splitParsed.inlineManifest;
            manifestCachedDirty = true;
          }
          const mappedSplit = mapSplitManifestToTelegramFile(
            msg,
            folderId,
            splitParsed.header,
            this.db.splitManifests[key] ?? splitParsed.inlineManifest ?? undefined,
            {
              customName: this.db.fileRenames[key],
              favorite: this.db.favorites.includes(key),
              encryptedRecord: this.vault.getEncryptedFileRecord(key),
              vaultUnlocked,
            },
          );
          out.push(mappedSplit);
          pageFiles.push(mappedSplit);
          continue;
        }

        const mapped = mapMessageToTelegramFile(msg, folderId, {
          customName: this.db.fileRenames[key],
          favorite: this.db.favorites.includes(key),
          encryptedRecord: this.vault.getEncryptedFileRecord(key),
          vaultUnlocked,
        });
        if (mapped) {
          out.push(mapped);
          pageFiles.push(mapped);
        }
      }
      if (pageFiles.length > 0 && onChunk) {
        onChunk(pageFiles);
      }
      if (!history.next) break;
      offset = history.next;
    }

    this.filesCache.set(String(folderId ?? 'saved'), out);
    this.mtprotoStorage?.flushSync();
    if (manifestCachedDirty || out.length >= 0) {
      this.scheduleSave();
    }
    return out;
  }

  private async scanDriveFolders(): Promise<StoredFolderMeta[]> {
    const client = await this.ensureClient();
    const discovered = new Map<number, string>();

    for await (const dialog of client.iterDialogs({ archived: 'keep', limit: 400 })) {
      const peer = dialog.peer;
      if (peer.type === 'chat' && (peer.chatType === 'channel' || peer.chatType === 'supergroup')) {
        const title = peer.title ?? '';
        if (title.startsWith(TG_DRIVE_CHANNEL_PREFIX)) {
          const cleanName = title.slice(TG_DRIVE_CHANNEL_PREFIX.length).trim() || title;
          const rawId = (peer.raw as { id: number }).id;
          discovered.set(rawId, cleanName);
        }
      }
    }

    let nextOrder = this.db.folders.length;
    for (const [id, name] of discovered.entries()) {
      const existing = this.db.folders.find(f => f.id === id);
      if (existing) {
        existing.name = name;
      } else {
        this.db.folders.push({
          id,
          name,
          group_id: null,
          sort_order: nextOrder++,
          is_hidden: false,
          created_at: new Date().toISOString(),
        });
      }
    }
    this.db.folders.sort((a, b) => a.sort_order - b.sort_order);
    this.mtprotoStorage?.flushSync();
    this.scheduleSave();
    return this.db.folders;
  }

  private async createDriveFolder(name: string): Promise<StoredFolderMeta> {
    const client = await this.ensureClient();
    const clean = name.trim();
    if (!clean) throw new Error('Folder name cannot be empty.');
    const chat = await client.createChannel({
      title: `${TG_DRIVE_CHANNEL_PREFIX}${clean}`,
      description: 'Private cloud folder managed by Telegram Drive',
    });
    const rawId = (chat.raw as { id: number }).id;
    const meta: StoredFolderMeta = {
      id: rawId,
      name: clean,
      group_id: null,
      sort_order: this.db.folders.length,
      is_hidden: false,
      created_at: new Date().toISOString(),
    };
    this.db.folders.push(meta);
    await this.persistMtprotoSession();
    this.scheduleSave();
    return meta;
  }

  private async deleteTelegramMessage(folderId: number | null, messageId: number): Promise<void> {
    const client = await this.ensureClient();
    const peer = folderIdToPeer(folderId);
    const key = fileCompositeKey(folderId, messageId);
    const splitManifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);

    if (splitManifest && splitManifest.parts.length > 0) {
      const allIds = [...splitManifest.parts.map(p => p.id), messageId];
      for (let i = 0; i < allIds.length; i += 100) {
        await client.deleteMessagesById(peer, allIds.slice(i, i + 100), { revoke: true }).catch(() => undefined);
      }
    } else {
      await client.deleteMessagesById(peer, [messageId], { revoke: true });
    }

    delete this.db.splitManifests[key];
    delete this.db.fileRenames[key];
    this.db.favorites = this.db.favorites.filter(k => k !== key);
    this.vault.removeEncryptedFile(key);
    this.scheduleSave();
  }

  private async performSplitUploadFile(params: {
    filePath: string;
    originalName: string;
    originalMime: string;
    totalSourceBytes: number;
    folderId: number | null;
    transferId: string;
    isEncrypted: boolean;
    protectionMode?: string;
    promptToken?: number;
    protectMetadata?: boolean;
    signal?: AbortSignal;
    onProgress?: (uploaded: number, total: number, speed: number) => void;
  }): Promise<number> {
    const client = await this.ensureClient();
    const peer = folderIdToPeer(params.folderId);
    const stat = fs.statSync(params.filePath);
    const partSize = params.isEncrypted ? ENCRYPTED_SPLIT_PART_SIZE_BYTES : SPLIT_PART_SIZE_BYTES;
    const plan = computeSplitPartPlan(params.totalSourceBytes, partSize);
    const fingerprint = `${path.resolve(params.filePath)}|${stat.size}|${Math.floor(stat.mtimeMs)}|${params.folderId ?? 'saved'}|${params.isEncrypted ? params.protectionMode : 'plain'}`;

    let checkpoint = this.db.splitUploadCheckpoints[fingerprint];
    if (
      !checkpoint ||
      checkpoint.totalSize !== params.totalSourceBytes ||
      checkpoint.partSize !== partSize
    ) {
      checkpoint = {
        fingerprint,
        groupId: nodeCrypto.randomBytes(6).toString('hex'),
        fileName: params.originalName,
        folderId: params.folderId,
        totalSize: params.totalSourceBytes,
        partSize,
        completedParts: {},
        updatedAt: Date.now(),
      };
      this.db.splitUploadCheckpoints[fingerprint] = checkpoint;
      this.scheduleSave();
    }

    // Verify any previously completed parts on Telegram for seamless Auto-Resume
    const completedIndices = Object.keys(checkpoint.completedParts).map(Number);
    if (completedIndices.length > 0) {
      const checkIds = completedIndices.map(idx => checkpoint!.completedParts[idx].messageId);
      const aliveIds = new Set<number>();
      for (let i = 0; i < checkIds.length; i += 100) {
        const batch = checkIds.slice(i, i + 100);
        const existingMsgs = await this.withResolvedFolderPeer(params.folderId, (c, p) =>
          c.getMessages(p, batch),
        ).catch(() => []);
        for (const m of existingMsgs) {
          if (m && m.media) aliveIds.add(m.id);
        }
      }
      for (const idx of completedIndices) {
        if (!aliveIds.has(checkpoint.completedParts[idx].messageId)) {
          delete checkpoint.completedParts[idx];
        }
      }
    }

    const resumedPartsCount = Object.keys(checkpoint.completedParts).length;
    this.emitEvent('split-file-notice', {
      transferId: params.transferId,
      fileName: params.originalName,
      totalBytes: params.totalSourceBytes,
      partsCount: plan.length,
      resumedParts: resumedPartsCount,
    });

    const stagedPassphrase =
      params.isEncrypted && params.protectionMode === 'passphrase'
        ? this.vault.consumeStagedPassphrase(params.promptToken)
        : null;
    if (params.isEncrypted && params.protectionMode === 'passphrase' && !stagedPassphrase) {
      throw new Error('PASSPHRASE_REQUIRED');
    }

    let vaultId: string | undefined;
    const startedAt = Date.now();
    let completedPlainBytes = plan.reduce(
      (sum, item) => (checkpoint!.completedParts[item.index] ? sum + item.size : sum),
      0,
    );
    const initialResumedBytes = completedPlainBytes;

    for (const item of plan) {
      if (params.signal?.aborted) throw new Error('CANCELLED');
      const existingPart = checkpoint.completedParts[item.index];
      if (existingPart) {
        if (params.isEncrypted && !vaultId && this.vault.getStatus().vault_id) {
          vaultId = this.vault.getStatus().vault_id ?? undefined;
        }
        continue;
      }

      const partFileName = buildSplitPartFileName(checkpoint.groupId, item.index, plan.length);
      let partUploadBytes = item.size;
      let uploadedPartFile: Awaited<ReturnType<TelegramClient['uploadFile']>>;

      if (params.isEncrypted) {
        const sliceBuf = Buffer.allocUnsafe(item.size);
        const fd = fs.openSync(params.filePath, 'r');
        try {
          let readSoFar = 0;
          while (readSoFar < item.size) {
            const r = fs.readSync(fd, sliceBuf, readSoFar, item.size - readSoFar, item.offset + readSoFar);
            if (r <= 0) break;
            readSoFar += r;
          }
        } finally {
          fs.closeSync(fd);
        }
        const enc = this.vault.encryptBuffer(new Uint8Array(sliceBuf.buffer, sliceBuf.byteOffset, item.size), {
          mode: params.protectionMode === 'passphrase' ? 'passphrase' : 'vault',
          passphrase: stagedPassphrase,
          originalName: `${params.originalName}.part${item.index + 1}`,
          originalMime: 'application/octet-stream',
          protectMetadata: params.protectMetadata,
        });
        vaultId = enc.vaultId;
        partUploadBytes = enc.ciphertext.byteLength;

        uploadedPartFile = await client.uploadFile({
          file: enc.ciphertext,
          fileName: partFileName,
          fileSize: partUploadBytes,
          fileMime: 'application/octet-stream',
          abortSignal: params.signal,
          progressCallback: (done, tot) => {
            const ratio = tot > 0 ? done / tot : 0;
            const overallDone = Math.min(
              params.totalSourceBytes,
              completedPlainBytes + Math.round(item.size * ratio),
            );
            const newlyTransferred = Math.max(0, overallDone - initialResumedBytes);
            const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
            const speed = Math.round(newlyTransferred / elapsedSec);
            const pct = Math.min(99, Math.round((overallDone / params.totalSourceBytes) * 100));
            params.onProgress?.(overallDone, params.totalSourceBytes, speed);
            this.emitEvent('upload-progress', {
              id: params.transferId,
              progress: pct,
              uploaded_bytes: overallDone,
              total_bytes: params.totalSourceBytes,
              speed_bytes_per_sec: speed,
            });
          },
        });
      } else {
        const readStream = fs.createReadStream(params.filePath, {
          start: item.offset,
          end: item.offset + item.size - 1,
          highWaterMark: 1024 * 1024,
        });
        uploadedPartFile = await client.uploadFile({
          file: readStream,
          fileName: partFileName,
          fileSize: item.size,
          fileMime: 'application/octet-stream',
          abortSignal: params.signal,
          progressCallback: done => {
            const overallDone = Math.min(params.totalSourceBytes, completedPlainBytes + done);
            const newlyTransferred = Math.max(0, overallDone - initialResumedBytes);
            const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
            const speed = Math.round(newlyTransferred / elapsedSec);
            const pct = Math.min(99, Math.round((overallDone / params.totalSourceBytes) * 100));
            params.onProgress?.(overallDone, params.totalSourceBytes, speed);
            this.emitEvent('upload-progress', {
              id: params.transferId,
              progress: pct,
              uploaded_bytes: overallDone,
              total_bytes: params.totalSourceBytes,
              speed_bytes_per_sec: speed,
            });
          },
        });
      }

      const partCaption = buildSplitPartCaption(checkpoint.groupId, item.index, plan.length, partUploadBytes);
      const sentPart = await this.withResolvedFolderPeer(params.folderId, (c, p) =>
        c.sendMedia(p, {
          type: 'document',
          file: uploadedPartFile,
          fileName: partFileName,
          caption: partCaption,
        }),
      );

      this.db.bandwidth.uploaded += partUploadBytes;
      checkpoint.completedParts[item.index] = {
        messageId: sentPart.id,
        size: partUploadBytes,
      };
      checkpoint.updatedAt = Date.now();
      completedPlainBytes += item.size;
      this.flushDatabase();
    }

    const orderedParts = plan.map(item => {
      const rec = checkpoint!.completedParts[item.index];
      if (!rec) throw new Error(`SPLIT_PART_MISSING:${item.index}`);
      return { id: rec.messageId, size: rec.size };
    });

    const totalStoredSize = params.isEncrypted
      ? orderedParts.reduce((s, p) => s + p.size, 0)
      : params.totalSourceBytes;

    const manifest: SplitFileManifest = {
      v: 1,
      groupId: checkpoint.groupId,
      name: params.originalName,
      mime: params.originalMime,
      totalSize: totalStoredSize,
      partSize,
      parts: orderedParts,
      createdAt: new Date().toISOString(),
      ...(params.isEncrypted
        ? {
            encrypted: {
              mode: params.protectionMode === 'passphrase' ? 'passphrase' : 'vault',
              vaultId,
              protectMetadata: Boolean(params.protectMetadata),
            },
          }
        : {}),
    };

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestFileName = buildSplitManifestFileName(checkpoint.groupId);
    const uploadedManifest = await client.uploadFile({
      file: manifestBytes,
      fileName: manifestFileName,
      fileSize: manifestBytes.byteLength,
      fileMime: 'application/json',
      abortSignal: params.signal,
    });

    const sentManifest = await this.withResolvedFolderPeer(params.folderId, (c, p) =>
      c.sendMedia(p, {
        type: 'document',
        file: uploadedManifest,
        fileName: manifestFileName,
        caption: buildSplitManifestCaption(manifest),
      }),
    );

    const manifestKey = fileCompositeKey(params.folderId, sentManifest.id);
    this.db.splitManifests[manifestKey] = manifest;
    delete this.db.splitUploadCheckpoints[fingerprint];

    if (params.isEncrypted) {
      this.vault.registerEncryptedFile({
        key: manifestKey,
        mode: params.protectionMode === 'passphrase' ? 'passphrase' : 'vault',
        vaultId,
        originalName: params.originalName,
        originalSize: params.totalSourceBytes,
        protectMetadata: Boolean(params.protectMetadata),
      });
    }

    this.emitEvent('upload-progress', {
      id: params.transferId,
      progress: 100,
      uploaded_bytes: params.totalSourceBytes,
      total_bytes: params.totalSourceBytes,
      speed_bytes_per_sec: 0,
    });
    this.flushDatabase();
    return sentManifest.id;
  }

  private async performUploadFile(params: {
    filePath: string;
    fileName?: string;
    folderId: number | null;
    transferId: string;
    protectionMode?: string;
    promptToken?: number;
    protectMetadata?: boolean;
    videoUploadMode?: 'file' | 'media';
    videoFilenameCaption?: boolean;
    signal?: AbortSignal;
    onProgress?: (uploaded: number, total: number, speed: number) => void;
  }): Promise<number> {
    const client = await this.ensureClient();
    const stat = fs.statSync(params.filePath);
    const originalName = params.fileName || path.basename(params.filePath);
    const originalMime = guessMimeType(originalName);

    const isEncrypted =
      params.protectionMode === 'vault' || params.protectionMode === 'passphrase';

    // Seamless background splitting for large files (>1.92 GiB plain, >256 MiB encrypted)
    if (shouldSplitUpload(stat.size, isEncrypted)) {
      return await this.performSplitUploadFile({
        filePath: params.filePath,
        originalName,
        originalMime,
        totalSourceBytes: stat.size,
        folderId: params.folderId,
        transferId: params.transferId,
        isEncrypted,
        protectionMode: params.protectionMode,
        promptToken: params.promptToken,
        protectMetadata: params.protectMetadata,
        signal: params.signal,
        onProgress: params.onProgress,
      });
    }

    let uploadSource: string | Uint8Array = params.filePath;
    let uploadName = originalName;
    let totalBytes = stat.size;
    let vaultId: string | undefined;

    if (isEncrypted) {
      const plainBytes = new Uint8Array(fs.readFileSync(params.filePath));
      const encrypted = this.vault.encryptBuffer(plainBytes, {
        mode: params.protectionMode === 'passphrase' ? 'passphrase' : 'vault',
        promptToken: params.promptToken,
        originalName,
        originalMime,
        protectMetadata: params.protectMetadata,
      });
      uploadSource = encrypted.ciphertext;
      uploadName = encrypted.uploadFileName;
      totalBytes = encrypted.ciphertext.byteLength;
      vaultId = encrypted.vaultId;
    }

    const startedAt = Date.now();
    const uploaded = await client.uploadFile({
      file: uploadSource,
      fileName: uploadName,
      fileSize: totalBytes,
      fileMime: isEncrypted ? 'application/octet-stream' : originalMime,
      abortSignal: params.signal,
      progressCallback: (done, tot) => {
        const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
        const speed = Math.round(done / elapsedSec);
        const pct = tot > 0 ? Math.min(99, Math.round((done / tot) * 100)) : 0;
        params.onProgress?.(done, tot || totalBytes, speed);
        this.emitEvent('upload-progress', {
          id: params.transferId,
          progress: pct,
          uploaded_bytes: done,
          total_bytes: tot || totalBytes,
          speed_bytes_per_sec: speed,
        });
      },
    });

    const isStreamableVideo =
      !isEncrypted &&
      params.videoUploadMode === 'media' &&
      /\.(mp4|mov|webm|mkv)$/i.test(originalName);

    const caption =
      isStreamableVideo && params.videoFilenameCaption === false ? '' : isEncrypted && params.protectMetadata ? '' : originalName;

    const sent = await this.withResolvedFolderPeer(params.folderId, (c, p) =>
      c.sendMedia(
        p,
        isStreamableVideo
          ? {
              type: 'video',
              file: uploaded,
              fileName: uploadName,
              supportsStreaming: true,
              caption,
            }
          : {
              type: 'document',
              file: uploaded,
              fileName: uploadName,
              caption,
            },
      ),
    );

    this.db.bandwidth.uploaded += totalBytes;

    if (isEncrypted) {
      this.vault.registerEncryptedFile({
        key: fileCompositeKey(params.folderId, sent.id),
        mode: params.protectionMode === 'passphrase' ? 'passphrase' : 'vault',
        vaultId,
        originalName,
        originalSize: stat.size,
        protectMetadata: Boolean(params.protectMetadata),
      });
    }

    this.emitEvent('upload-progress', {
      id: params.transferId,
      progress: 100,
      uploaded_bytes: totalBytes,
      total_bytes: totalBytes,
      speed_bytes_per_sec: 0,
    });
    this.scheduleSave();
    return sent.id;
  }

  private async performDownloadFile(params: {
    folderId: number | null;
    messageId: number;
    savePath: string;
    transferId: string;
    collisionPolicy?: 'overwrite' | 'skip' | 'keep_both';
    promptToken?: number;
    signal?: AbortSignal;
    onProgress?: (downloaded: number, total: number, speed: number) => void;
  }): Promise<{ finalPath: string; outcome: 'saved' | 'overwritten' | 'skipped' | 'kept_both' }> {
    const resolved = resolveCollisionSavePath(params.savePath, params.collisionPolicy ?? 'keep_both');
    if (resolved.skip) {
      return { finalPath: resolved.finalPath, outcome: 'skipped' };
    }

    fs.mkdirSync(path.dirname(resolved.finalPath), { recursive: true });
    const key = fileCompositeKey(params.folderId, params.messageId);
    const encRec = this.vault.getEncryptedFileRecord(key);
    const splitManifest = await this.ensureSplitManifestLoaded(params.folderId, params.messageId).catch(() => null);
    const startedAt = Date.now();
    const tmpDest = `${resolved.finalPath}.tdpart`;

    const writeWithDrain = async (ws: fs.WriteStream, buf: Uint8Array) => {
      if (!ws.write(Buffer.from(buf))) {
        await new Promise<void>(r => ws.once('drain', r));
      }
    };

    if (splitManifest && (splitManifest.encrypted || encRec)) {
      // Encrypted split file: decrypt each part sequentially into tmpDest (low RAM)
      const stagedPass =
        (splitManifest.encrypted?.mode ?? encRec?.mode) === 'passphrase'
          ? this.vault.consumeStagedPassphrase(params.promptToken)
          : null;
      const totalCipherBytes = splitManifest.parts.reduce((s, p) => s + p.size, 0);
      let downloadedCipher = 0;
      const ws = fs.createWriteStream(tmpDest);
      try {
        for (const part of splitManifest.parts) {
          if (params.signal?.aborted) throw new Error('CANCELLED');
          const rawPart = await this.downloadRawTelegramBytes(
            params.folderId,
            part.id,
            partDone => {
              const cur = downloadedCipher + partDone;
              const elapsed = Math.max(0.1, (Date.now() - startedAt) / 1000);
              const speed = Math.round(cur / elapsed);
              const pct = totalCipherBytes > 0 ? Math.min(98, Math.round((cur / totalCipherBytes) * 98)) : 0;
              params.onProgress?.(cur, totalCipherBytes, speed);
              this.emitEvent('download-progress', {
                id: params.transferId,
                message_id: params.messageId,
                progress: pct,
                downloaded_bytes: cur,
                total_bytes: totalCipherBytes,
                speed_bytes_per_sec: speed,
              });
            },
            params.signal,
          );
          downloadedCipher += rawPart.byteLength;
          const plainPart = this.vault.decryptBuffer(rawPart, {
            promptToken: params.promptToken,
            passphrase: stagedPass,
          }).plaintext;
          await writeWithDrain(ws, plainPart);
        }
        await new Promise<void>(r => ws.end(() => r()));
        fs.renameSync(tmpDest, resolved.finalPath);
      } catch (err) {
        await new Promise<void>(r => ws.end(() => r()));
        fs.rmSync(tmpDest, { force: true });
        throw err;
      }
    } else if (encRec) {
      const rawBytes = await this.downloadRawTelegramBytes(
        params.folderId,
        params.messageId,
        (done, tot) => {
          const elapsed = Math.max(0.1, (Date.now() - startedAt) / 1000);
          const speed = Math.round(done / elapsed);
          const pct = tot > 0 ? Math.min(95, Math.round((done / tot) * 95)) : 0;
          params.onProgress?.(done, tot, speed);
          this.emitEvent('download-progress', {
            id: params.transferId,
            message_id: params.messageId,
            progress: pct,
            downloaded_bytes: done,
            total_bytes: tot,
            speed_bytes_per_sec: speed,
          });
        },
        params.signal,
      );
      const { plaintext } = this.vault.decryptBuffer(rawBytes, { promptToken: params.promptToken });
      fs.writeFileSync(resolved.finalPath, Buffer.from(plaintext));
    } else {
      // Plain file (single OR multi-part split of any size, e.g. 4 GB – 100 GB):
      // Supports 1 MiB-aligned Auto-Resume from .tdpart if interrupted by network drop or pause!
      let total = 0;
      if (splitManifest) {
        total = splitManifest.totalSize;
      } else {
        const msg = await this.fetchSingleMessage(params.folderId, params.messageId);
        if (!msg.media) throw new Error('MEDIA_NOT_FOUND');
        total = ((msg.media as unknown as { fileSize?: number }).fileSize ?? 0);
      }

      const resumeUnit = 1024 * 1024; // 1 MiB alignment
      let resumeOffset = 0;
      if (fs.existsSync(tmpDest) && total > resumeUnit) {
        try {
          const existingBytes = fs.statSync(tmpDest).size;
          const aligned = Math.floor(existingBytes / resumeUnit) * resumeUnit;
          if (aligned > 0 && aligned < total) {
            if (existingBytes !== aligned) {
              fs.truncateSync(tmpDest, aligned);
            }
            resumeOffset = aligned;
          } else if (existingBytes >= total) {
            fs.rmSync(tmpDest, { force: true });
          }
        } catch {
          resumeOffset = 0;
        }
      }

      const stream = fs.createWriteStream(tmpDest, {
        flags: resumeOffset > 0 ? 'a' : 'w',
      });
      let done = resumeOffset;
      const abortSig = params.signal ?? new AbortController().signal;

      try {
        if (total > 0 && resumeOffset < total) {
          for await (const chunk of this.streamFileRange(
            params.folderId,
            params.messageId,
            resumeOffset,
            total - 1,
            abortSig,
          )) {
            if (abortSig.aborted) throw new Error('CANCELLED');
            await writeWithDrain(stream, chunk);
            done += chunk.byteLength;
            const newlyDownloaded = Math.max(0, done - resumeOffset);
            const elapsed = Math.max(0.1, (Date.now() - startedAt) / 1000);
            const speed = Math.round(newlyDownloaded / elapsed);
            const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
            params.onProgress?.(done, total, speed);
            this.emitEvent('download-progress', {
              id: params.transferId,
              message_id: params.messageId,
              progress: pct,
              downloaded_bytes: done,
              total_bytes: total,
              speed_bytes_per_sec: speed,
            });
          }
        } else if (total === 0) {
          const msg = await this.fetchSingleMessage(params.folderId, params.messageId);
          if (!msg.media) throw new Error('MEDIA_NOT_FOUND');
          const client = await this.ensureClient();
          for await (const chunk of client.downloadAsIterable(
            msg.media as Parameters<TelegramClient['downloadAsIterable']>[0],
            { partSize: 512, abortSignal: abortSig },
          )) {
            if (abortSig.aborted) throw new Error('CANCELLED');
            await writeWithDrain(stream, chunk);
            done += chunk.byteLength;
            this.db.bandwidth.downloaded += chunk.byteLength;
          }
        }
      } catch (err) {
        await new Promise<void>(r => stream.end(() => r()));
        if (this.explicitlyCancelledTransfers.has(params.transferId)) {
          this.explicitlyCancelledTransfers.delete(params.transferId);
          fs.rmSync(tmpDest, { force: true });
        }
        throw err;
      }

      await new Promise<void>(r => stream.end(() => r()));
      if (!splitManifest && fs.existsSync(tmpDest) && fs.statSync(tmpDest).size >= 16) {
        const headBuf = Buffer.alloc(16);
        const fd = fs.openSync(tmpDest, 'r');
        try {
          fs.readSync(fd, headBuf, 0, 16, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (VaultRuntime.hasEncryptedMagic(headBuf)) {
          const cipherBytes = new Uint8Array(fs.readFileSync(tmpDest));
          const { plaintext } = this.vault.decryptBuffer(cipherBytes, { promptToken: params.promptToken });
          fs.writeFileSync(tmpDest, Buffer.from(plaintext));
        }
      }
      fs.renameSync(tmpDest, resolved.finalPath);
    }

    const finalBytes = fs.existsSync(resolved.finalPath) ? fs.statSync(resolved.finalPath).size : 1;
    this.emitEvent('download-progress', {
      id: params.transferId,
      message_id: params.messageId,
      progress: 100,
      downloaded_bytes: finalBytes,
      total_bytes: finalBytes,
      speed_bytes_per_sec: 0,
    });
    this.scheduleSave();
    return { finalPath: resolved.finalPath, outcome: resolved.outcome };
  }

  private pumpTransferQueue(): void {
    const jobs = [...this.transfers.values()].sort((a, b) => a.queuePosition - b.queuePosition);
    const activeUploads = jobs.filter(
      j => j.direction === 'upload' && ['uploading', 'encrypting'].includes(j.status),
    ).length;
    const activeDownloads = jobs.filter(
      j => j.direction === 'download' && ['downloading', 'decrypting'].includes(j.status),
    ).length;

    let freeUploads = Math.max(0, this.maxConcurrentUploads - activeUploads);
    let freeDownloads = Math.max(0, this.maxConcurrentDownloads - activeDownloads);

    const now = Date.now();
    for (const job of jobs) {
      if (job.status !== 'pending') continue;
      if (job.retryAt && job.retryAt > now) continue;
      if (job.direction === 'upload' && freeUploads > 0) {
        freeUploads--;
        void this.executeQueuedTransfer(job);
      } else if (job.direction === 'download' && freeDownloads > 0) {
        freeDownloads--;
        void this.executeQueuedTransfer(job);
      }
    }
  }

  private updateTransferJob(job: TransferJobRecord, patch: Partial<TransferJobRecord>): TransferJobRecord {
    Object.assign(job, patch, {
      revision: job.revision + 1,
      updatedAt: Date.now(),
    });
    this.emitEvent('transfer-upserted', { ...job });
    return job;
  }

  private async executeQueuedTransfer(job: TransferJobRecord): Promise<void> {
    const abort = new AbortController();
    this.activeAbortControllers.set(job.id, abort);
    this.updateTransferJob(job, {
      status: job.direction === 'upload' ? 'uploading' : 'downloading',
      error: undefined,
    });

    try {
      if (job.direction === 'upload') {
        let localPath = job.path;
        let cleanupTmp = false;
        if (job.kind === 'url_upload' && job.url) {
          const parsedUrl = new URL(job.url);
          if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Only HTTP/HTTPS URLs are supported.');
          }
          const resp = await fetch(job.url, { signal: abort.signal });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          localPath = path.join(getPortablePaths().stagingCacheDir, `${job.id}_${job.filename}`);
          fs.writeFileSync(localPath, buf);
          cleanupTmp = true;
        }
        if (!localPath || !fs.existsSync(localPath)) {
          throw new Error('SOURCE_FILE_NOT_FOUND');
        }
        try {
          const msgId = await this.performUploadFile({
            filePath: localPath,
            fileName: job.filename,
            folderId: job.folderId,
            transferId: job.id,
            protectionMode: job.protectionMode,
            promptToken: job.promptToken,
            protectMetadata: job.protectMetadata,
            videoUploadMode: job.videoUploadMode,
            videoFilenameCaption: job.videoFilenameCaption,
            signal: abort.signal,
            onProgress: (done, tot, speed) => {
              this.updateTransferJob(job, {
                transferredBytes: done,
                totalBytes: tot,
                progress: tot > 0 ? Math.min(99, Math.round((done / tot) * 100)) : 0,
                speedBytesPerSec: speed,
              });
            },
          });
          this.updateTransferJob(job, {
            messageId: msgId,
            status: 'completed',
            progress: 100,
            transferredBytes: job.totalBytes,
            speedBytesPerSec: 0,
          });
        } finally {
          if (cleanupTmp && localPath) fs.rmSync(localPath, { force: true });
          if (job.tempZipPath) fs.rmSync(job.tempZipPath, { force: true });
        }
      } else {
        const defaultDownloads = path.join(os.homedir(), 'Downloads', job.filename);
        const outcome = await this.performDownloadFile({
          folderId: job.folderId,
          messageId: job.messageId ?? 0,
          savePath: job.savePath || defaultDownloads,
          transferId: job.id,
          collisionPolicy: job.collisionPolicy,
          promptToken: job.promptToken,
          signal: abort.signal,
          onProgress: (done, tot, speed) => {
            this.updateTransferJob(job, {
              transferredBytes: done,
              totalBytes: tot,
              progress: tot > 0 ? Math.min(99, Math.round((done / tot) * 100)) : 0,
              speedBytesPerSec: speed,
            });
          },
        });
        this.updateTransferJob(job, {
          savePath: outcome.finalPath,
          downloadOutcome: outcome.outcome,
          status: 'completed',
          progress: 100,
          transferredBytes: job.totalBytes,
          speedBytesPerSec: 0,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (abort.signal.aborted || msg === 'CANCELLED') {
        if (job.status !== 'paused') {
          this.updateTransferJob(job, { status: 'cancelled', speedBytesPerSec: 0 });
        }
      } else if (msg.includes('VAULT_LOCKED') || msg.includes('PASSPHRASE_REQUIRED')) {
        this.updateTransferJob(job, {
          status: 'waiting_for_unlock',
          error: msg,
          errorCategory: 'unlock',
          speedBytesPerSec: 0,
        });
      } else if (isTransientTransferNetworkError(err)) {
        const prevAttempts = Number((job as unknown as { _autoRetries?: number })._autoRetries ?? 0);
        if (prevAttempts < 5) {
          (job as unknown as { _autoRetries?: number })._autoRetries = prevAttempts + 1;
          const delayMs = Math.min(20_000, 2000 * 2 ** prevAttempts);
          this.updateTransferJob(job, {
            status: 'pending',
            error: `Network interrupted — auto-resuming in ${Math.round(delayMs / 1000)}s…`,
            errorCategory: 'network',
            retryAt: Date.now() + delayMs,
            speedBytesPerSec: 0,
          });
          setTimeout(() => {
            if (job.status === 'pending') {
              this.pumpTransferQueue();
            }
          }, delayMs);
        } else {
          this.updateTransferJob(job, {
            status: 'failed',
            error: msg,
            errorCategory: 'network',
            speedBytesPerSec: 0,
          });
        }
      } else {
        this.updateTransferJob(job, {
          status: 'failed',
          error: msg,
          errorCategory: 'other',
          speedBytesPerSec: 0,
        });
      }
    } finally {
      this.activeAbortControllers.delete(job.id);
      this.pumpTransferQueue();
    }
  }

  private refreshFolderWatchers(): void {
    for (const watcher of this.syncWatchers.values()) {
      watcher.close();
    }
    this.syncWatchers.clear();

    for (const pair of this.db.syncPairs) {
      if (!pair.is_active || !fs.existsSync(pair.local_path)) continue;
      try {
        const watcher = fs.watch(pair.local_path, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          const full = path.join(pair.local_path, filename);
          if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            pair.last_synced_at = new Date().toISOString();
            this.scheduleSave();
          }
        });
        this.syncWatchers.set(pair.id, watcher);
      } catch {
        // Ignore non-watchable network/removable paths
      }
    }
  }

  private collectAllWorkspaceFiles(ownerId: string) {
    const foldersById = new Map(this.db.folders.map(f => [f.id, f.name]));
    const out: Array<MappedTelegramFile & { key: string; folderName: string; tags: string[]; collectionIds: string[] }> = [];

    for (const [folderKey, list] of this.filesCache.entries()) {
      const folderId = folderKey === 'saved' ? null : Number.parseInt(folderKey, 10);
      const folderName = folderId === null ? 'Saved Messages' : (foldersById.get(folderId) ?? `Folder ${folderId}`);
      for (const f of list) {
        const key = fileCompositeKey(folderId, f.id);
        out.push({
          ...f,
          key,
          folder_id: folderId,
          folderName,
          is_favorite: this.db.favorites.includes(key),
          tags: this.db.fileTags[`${ownerId}:${key}`] ?? [],
          collectionIds: this.db.fileCollections[`${ownerId}:${key}`] ?? [],
        });
      }
    }
    return out;
  }

  private buildWorkspaceSnapshot(ownerId: string, cursor?: string | null, limit = 256) {
    const allFiles = this.collectAllWorkspaceFiles(ownerId);
    const startIdx = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const slice = allFiles.slice(startIdx, startIdx + limit);
    const nextCursor = startIdx + limit < allFiles.length ? String(startIdx + limit) : null;
    return {
      ownerId,
      files: slice,
      collections: this.db.collections[ownerId] ?? [],
      searches: this.db.savedSearches[ownerId] ?? [],
      scans: [
        {
          folderId: null,
          folderName: 'Saved Messages',
          complete: this.filesCache.has('saved'),
          updatedAt: Date.now(),
        },
        ...this.db.folders.map(f => ({
          folderId: f.id,
          folderName: f.name,
          complete: this.filesCache.has(String(f.id)),
          updatedAt: Date.now(),
        })),
      ],
      nextCursor,
      totalFiles: allFiles.length,
    };
  }

  public async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    switch (cmd) {
      // ── Startup & Health ───────────────────────────────────────────
      case 'cmd_get_startup_health':
        return {
          ok: true,
          streaming_port: this.servers.mediaPort,
          portable_mode: true,
          data_dir: getPortablePaths().dataRoot,
        };

      case 'cmd_get_stream_info':
        return {
          base_url: `http://127.0.0.1:${this.servers.mediaPort}`,
          port: this.servers.mediaPort,
          token: this.servers.streamToken,
          operation_token: this.servers.operationToken,
        };

      case 'cmd_check_network_reachable':
      case 'cmd_check_android_network':
        return true;

      // ── API Hash & Authentication ──────────────────────────────────
      case 'cmd_store_api_hash': {
        const apiHash = String(args.apiHash ?? '').trim();
        if (apiHash) writeEncryptedSecretFile(this.apiHashFilePath, apiHash);
        return null;
      }
      case 'cmd_load_api_hash':
        return readEncryptedSecretFile(this.apiHashFilePath);
      case 'cmd_clear_api_hash':
        fs.rmSync(this.apiHashFilePath, { force: true });
        removeResilientBackupsSync(this.apiHashFilePath);
        this.currentApiHash = null;
        return null;

      case 'cmd_get_saved_session_info': {
        const hasSession =
          fs.existsSync(this.sessionFilePath) || fs.existsSync(this.mtprotoStorageFilePath);
        const hasApiHash = Boolean(readEncryptedSecretFile(this.apiHashFilePath));
        return {
          apiId: this.db.apiId,
          hasApiHash,
          hasSession,
          lastUserId: this.db.lastUserId,
        };
      }

      case 'cmd_connect': {
        const apiId = Number(args.apiId || this.db.apiId || 0);
        await this.ensureClient(apiId);
        return true;
      }

      case 'cmd_check_connection': {
        const hasSessionOnDisk =
          fs.existsSync(this.sessionFilePath) || fs.existsSync(this.mtprotoStorageFilePath);
        if (!hasSessionOnDisk) return false;
        try {
          const client = await this.ensureClient();
          const me = await client.getMe();
          this.currentUserId = String(me.id);
          this.db.lastUserId = this.currentUserId;
          await this.persistMtprotoSession();
          this.flushDatabase();
          return true;
        } catch (err) {
          if (isFatalTelegramAuthError(err)) {
            this.currentUserId = null;
            this.db.lastUserId = null;
            this.mtprotoStorage?.clearDisk();
            fs.rmSync(this.sessionFilePath, { force: true });
            this.flushDatabase();
            return false;
          }
          // Preserve authenticated state across offline PC boot / temporary network outage
          if (this.db.lastUserId) {
            this.currentUserId = this.db.lastUserId;
            return true;
          }
          return false;
        }
      }

      case 'cmd_auth_request_code': {
        const phone = String(args.phone ?? '').trim();
        const apiId = Number(args.apiId);
        const apiHash = String(args.apiHash ?? '').trim();
        this.pendingAuth = { phone, apiId, apiHash };
        if (apiHash) writeEncryptedSecretFile(this.apiHashFilePath, apiHash);

        const client = await this.ensureClient(apiId, apiHash);
        const res = await client.sendCode({ phone });
        if (res instanceof User) {
          this.currentUserId = String(res.id);
          this.db.lastUserId = this.currentUserId;
          await this.persistMtprotoSession();
          this.flushDatabase();
          return {
            status: 'authorized',
            delivery: 'telegram_app',
            numericCode: true,
          };
        }
        this.pendingAuth.phoneCodeHash = (res as SentCode).phoneCodeHash;
        return mapSentCodeResult(res as SentCode);
      }

      case 'cmd_auth_resend_code': {
        const client = await this.ensureClient();
        if (!this.pendingAuth.phone || !this.pendingAuth.phoneCodeHash) {
          throw new Error('NO_ACTIVE_CODE_REQUEST');
        }
        const res = await client.resendCode({
          phone: this.pendingAuth.phone,
          phoneCodeHash: this.pendingAuth.phoneCodeHash,
        });
        this.pendingAuth.phoneCodeHash = res.phoneCodeHash;
        return mapSentCodeResult(res);
      }

      case 'cmd_auth_cancel_code': {
        this.pendingAuth = {};
        return null;
      }

      case 'cmd_auth_sign_in': {
        const code = String(args.code ?? '').trim();
        const client = await this.ensureClient();
        if (!this.pendingAuth.phone || !this.pendingAuth.phoneCodeHash) {
          throw new Error('NO_ACTIVE_CODE_REQUEST');
        }
        try {
          const user = await client.signIn({
            phone: this.pendingAuth.phone,
            phoneCodeHash: this.pendingAuth.phoneCodeHash,
            phoneCode: code,
          });
          this.currentUserId = String(user.id);
          this.db.lastUserId = this.currentUserId;
          await this.persistMtprotoSession();
          this.flushDatabase();
          return { success: true };
        } catch (err) {
          const errStr = String(err);
          if (errStr.includes('SESSION_PASSWORD_NEEDED') || errStr.toLowerCase().includes('password')) {
            return { success: false, next_step: 'password' };
          }
          throw err;
        }
      }

      case 'cmd_auth_check_password': {
        const password = String(args.password ?? '');
        if (this.qrState.needsPassword && this.qrState.providePassword) {
          const providePw = this.qrState.providePassword;
          this.qrState.providePassword = undefined;
          this.qrState.needsPassword = false;
          const verified = new Promise<void>((resolve, reject) => {
            this.qrState.pendingPasswordResult = { resolve, reject };
          });
          providePw(password);
          await verified;
          return { success: true };
        }
        const client = await this.ensureClient();
        const user = await client.checkPassword(password);
        this.currentUserId = String(user.id);
        this.db.lastUserId = this.currentUserId;
        await this.persistMtprotoSession();
        this.flushDatabase();
        return { success: true };
      }

      case 'cmd_auth_qr_login': {
        const apiId = Number(args.apiId || this.db.apiId || 0);
        const apiHash =
          String(args.apiHash ?? '').trim() ||
          readEncryptedSecretFile(this.apiHashFilePath) ||
          '';
        if (apiHash) writeEncryptedSecretFile(this.apiHashFilePath, apiHash);
        this.qrState.abort?.abort();
        const abort = new AbortController();
        this.qrState = {
          latestUrl: null,
          scanned: false,
          needsPassword: false,
          authorized: false,
          error: null,
          abort,
        };
        const client = await this.ensureClient(apiId, apiHash);

        const firstUrlPromise = new Promise<string>((resolve, reject) => {
          let settledFirstUrl = false;
          const timer = setTimeout(() => {
            if (!settledFirstUrl) {
              settledFirstUrl = true;
              abort.abort();
              reject(new Error('QR_GENERATION_TIMEOUT'));
            }
          }, 20_000);

          void runRobustQrSignIn(client, {
            abortSignal: abort.signal,
            pollIntervalMs: 1800,
            onUrlUpdated: (url, expiresAt) => {
              this.qrState.latestUrl = url;
              this.emitEvent('qr-auth-update', {
                status: 'url',
                url,
                expiresAt: expiresAt.getTime(),
              });
              if (!settledFirstUrl) {
                settledFirstUrl = true;
                clearTimeout(timer);
                resolve(url);
              }
            },
            onQrScanned: () => {
              this.qrState.scanned = true;
              this.emitEvent('qr-auth-update', { status: 'scanned' });
            },
            password: () =>
              new Promise<string>(resPw => {
                this.qrState.needsPassword = true;
                this.qrState.providePassword = resPw;
                this.emitEvent('qr-auth-update', { status: 'password_required' });
              }),
            invalidPasswordCallback: () => {
              const pending = this.qrState.pendingPasswordResult;
              this.qrState.pendingPasswordResult = undefined;
              this.qrState.needsPassword = true;
              pending?.reject(new Error('PASSWORD_HASH_INVALID'));
            },
          })
            .then(async user => {
              this.currentUserId = String(user.id);
              this.db.lastUserId = this.currentUserId;
              await this.persistMtprotoSession();
              this.flushDatabase();
              this.qrState.authorized = true;
              this.emitEvent('qr-auth-update', { status: 'authorized' });
              const pending = this.qrState.pendingPasswordResult;
              this.qrState.pendingPasswordResult = undefined;
              pending?.resolve();
            })
            .catch(err => {
              clearTimeout(timer);
              if (abort.signal.aborted) return;
              const normalized = err instanceof Error ? err : new Error(String(err));
              this.qrState.error = normalized.message;
              this.emitEvent('qr-auth-update', {
                status: 'error',
                error: normalized.message,
              });
              const pending = this.qrState.pendingPasswordResult;
              this.qrState.pendingPasswordResult = undefined;
              pending?.reject(normalized);
              if (!settledFirstUrl) {
                settledFirstUrl = true;
                reject(normalized);
              }
            });
        });

        return await firstUrlPromise;
      }

      case 'cmd_auth_qr_cancel': {
        this.qrState.abort?.abort();
        this.qrState.abort = null;
        return null;
      }

      case 'cmd_auth_qr_poll': {
        if (this.qrState.authorized) {
          return { success: true };
        }
        if (this.qrState.needsPassword) {
          return { success: true, next_step: 'password' };
        }
        if (this.qrState.error) {
          throw new Error(this.qrState.error);
        }
        return {
          success: false,
          url: this.qrState.latestUrl,
          scanned: this.qrState.scanned,
        };
      }

      case 'cmd_logout': {
        let remoteRevoked = false;
        this.qrState.abort?.abort();
        if (this.client) {
          try {
            await this.client.logOut();
            remoteRevoked = true;
          } catch {
            // Continue local cleanup even if offline
          }
          await this.client.destroy().catch(() => undefined);
          this.client = null;
          this.currentApiHash = null;
        }
        this.currentUserId = null;
        this.db.lastUserId = null;
        this.db.cachedFilesByFolder = {};
        this.filesCache.clear();
        this.vault.lock();
        this.mtprotoStorage?.clearDisk();
        fs.rmSync(this.sessionFilePath, { force: true });
        removeResilientBackupsSync(this.sessionFilePath);
        this.flushDatabase();
        return { signed_out: true, remote_session_revoked: remoteRevoked };
      }

      case 'cmd_workspace_account':
        return await this.getAccountOwnerId();

      // ── Folders & Groups ───────────────────────────────────────────
      case 'cmd_scan_folders':
        return await this.scanDriveFolders();

      case 'cmd_get_folders':
      case 'cmd_get_enriched_folders': {
        return [...this.db.folders]
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(f => {
            const cached = this.filesCache.get(String(f.id)) ?? [];
            const totalSize = cached.reduce((s, item) => s + (item.size || 0), 0);
            return {
              ...f,
              display_order: f.sort_order,
              file_count: cached.length,
              total_size: totalSize,
              total_size_str: formatByteSize(totalSize),
            };
          });
      }

      case 'cmd_create_folder':
        return await this.createDriveFolder(String(args.name ?? ''));

      case 'cmd_rename_folder': {
        const folderId = Number(args.folderId);
        const newName = String(args.newName ?? '').trim();
        const client = await this.ensureClient();
        await client.setChatTitle(folderIdToPeer(folderId), `${TG_DRIVE_CHANNEL_PREFIX}${newName}`);
        const found = this.db.folders.find(f => f.id === folderId);
        if (found) found.name = newName;
        this.scheduleSave();
        return null;
      }

      case 'cmd_delete_folder': {
        const folderId = Number(args.folderId);
        const client = await this.ensureClient();
        await client.deleteChannel(folderIdToPeer(folderId));
        this.db.folders = this.db.folders.filter(f => f.id !== folderId);
        this.filesCache.delete(String(folderId));
        this.scheduleSave();
        return null;
      }

      case 'cmd_toggle_folder_visibility': {
        const folderId = Number(args.folderId);
        const found = this.db.folders.find(f => f.id === folderId);
        if (!found) throw new Error('FOLDER_NOT_FOUND');
        found.is_hidden = args.isHidden !== undefined ? Boolean(args.isHidden) : !found.is_hidden;
        this.scheduleSave();
        return found;
      }

      case 'cmd_export_folder_invite': {
        const folderId = Number(args.folderId);
        const client = await this.ensureClient();
        const link = await client.exportInviteLink(folderIdToPeer(folderId));
        return { link: link.link, is_revoked: false };
      }

      case 'cmd_update_folder_order': {
        const folderId = Number(args.folderId);
        const newOrder = Number(args.newOrder);
        const found = this.db.folders.find(f => f.id === folderId);
        if (found) found.sort_order = newOrder;
        this.scheduleSave();
        return null;
      }

      case 'cmd_set_folder_group':
      case 'cmd_assign_folder_to_group': {
        const folderId = Number(args.folderId ?? args.channelId);
        const groupId = args.groupId === null || args.groupId === undefined ? null : Number(args.groupId);
        const found = this.db.folders.find(f => f.id === folderId);
        if (found) found.group_id = groupId;
        this.scheduleSave();
        return null;
      }

      case 'cmd_get_groups':
        return [...this.db.groups]
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(g => ({ ...g, display_order: g.sort_order }));

      case 'cmd_create_group': {
        const id = Date.now();
        this.db.groups.push({
          id,
          name: String(args.name ?? 'Group'),
          color_hex: String(args.colorHex ?? '#38bdf8'),
          sort_order: this.db.groups.length,
        });
        this.scheduleSave();
        return id;
      }

      case 'cmd_update_group': {
        const g = this.db.groups.find(item => item.id === Number(args.groupId));
        if (g) {
          if (args.name !== undefined) g.name = String(args.name);
          if (args.colorHex !== undefined) g.color_hex = String(args.colorHex);
        }
        this.scheduleSave();
        return null;
      }

      case 'cmd_rename_group': {
        const g = this.db.groups.find(item => item.id === Number(args.groupId));
        if (g) g.name = String(args.newName ?? g.name);
        this.scheduleSave();
        return null;
      }

      case 'cmd_update_group_color': {
        const g = this.db.groups.find(item => item.id === Number(args.groupId));
        if (g) g.color_hex = String(args.colorHex ?? g.color_hex);
        this.scheduleSave();
        return null;
      }

      case 'cmd_update_group_order': {
        const g = this.db.groups.find(item => item.id === Number(args.groupId));
        if (g) g.sort_order = Number(args.newOrder ?? g.sort_order);
        this.scheduleSave();
        return null;
      }

      case 'cmd_delete_group': {
        const gid = Number(args.groupId);
        this.db.groups = this.db.groups.filter(item => item.id !== gid);
        for (const f of this.db.folders) {
          if (f.group_id === gid) f.group_id = null;
        }
        this.scheduleSave();
        return null;
      }

      // ── Files, Thumbnails, Previews & Archives ─────────────────────
      case 'cmd_get_cached_files': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        return this.filesCache.get(String(folderId ?? 'saved')) ?? [];
      }

      case 'cmd_get_files': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const ownerId =
          typeof args.ownerId === 'string' && args.ownerId
            ? args.ownerId
            : (this.currentUserId ?? '');
        const requestId = typeof args.requestId === 'string' ? args.requestId : '';
        const files = await this.listFolderFiles(folderId, chunk => {
          this.emitEvent('folder-load-chunk', {
            ownerId,
            folderId,
            requestId,
            files: chunk,
          });
        });
        return {
          ownerId,
          folderId,
          requestId,
          files,
          complete: true,
        };
      }

      case 'cmd_get_offline_files':
      case 'cmd_get_file_activity':
      case 'cmd_list_cached_files':
        return [];

      case 'cmd_touch_file_inventory':
      case 'cmd_record_file_opened':
      case 'cmd_set_file_activity_flag':
        return null;

      case 'cmd_get_storage_insight': {
        const ownerId = this.currentUserId ?? '';
        const allFiles = ownerId ? this.collectAllWorkspaceFiles(ownerId) : [];
        const bySizeKey = new Map<string, number>();
        for (const f of allFiles) {
          const k = `${f.name}:${f.size}`;
          bySizeKey.set(k, (bySizeKey.get(k) ?? 0) + 1);
        }
        let duplicateGroups = 0;
        for (const count of bySizeKey.values()) {
          if (count > 1) duplicateGroups++;
        }
        return {
          files: allFiles,
          complete: true,
          scanned_count: allFiles.length,
          duplicate_groups: duplicateGroups,
        };
      }

      case 'cmd_search_files': {
        const q = String(args.query ?? '').toLowerCase();
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const list = await this.listFolderFiles(folderId);
        return list.filter(f => f.name.toLowerCase().includes(q));
      }

      case 'cmd_get_favorite_files': {
        const ownerId = await this.getAccountOwnerId();
        return this.collectAllWorkspaceFiles(ownerId).filter(f => f.is_favorite);
      }

      case 'cmd_toggle_favorite': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const key = fileCompositeKey(folderId, messageId);
        const idx = this.db.favorites.indexOf(key);
        const nextVal = idx === -1;
        if (nextVal) this.db.favorites.push(key);
        else this.db.favorites.splice(idx, 1);
        this.scheduleSave();
        return nextVal;
      }

      case 'cmd_delete_file': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        await this.deleteTelegramMessage(folderId, messageId);
        const cacheKey = String(folderId ?? 'saved');
        const list = this.filesCache.get(cacheKey);
        if (list) {
          this.filesCache.set(
            cacheKey,
            list.filter(f => f.id !== messageId),
          );
        }
        return null;
      }

      case 'cmd_rename_file': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const newName = String(args.newName ?? '').trim();
        if (!newName) throw new Error('Filename cannot be empty.');
        const key = fileCompositeKey(folderId, messageId);
        this.db.fileRenames[key] = newName;
        try {
          const client = await this.ensureClient();
          await client.editMessage({
            chatId: folderIdToPeer(folderId),
            message: messageId,
            text: newName,
          });
        } catch {
          // Local rename map still persists even when Telegram disallows caption edit
        }
        this.scheduleSave();
        return null;
      }

      case 'cmd_move_files': {
        const sourceFolderId =
          args.sourceFolderId === null || args.sourceFolderId === undefined
            ? null
            : Number(args.sourceFolderId);
        const targetFolderId =
          args.targetFolderId === null || args.targetFolderId === undefined
            ? null
            : Number(args.targetFolderId);
        const messageIds = (args.messageIds as number[]) ?? [];
        const client = await this.ensureClient();
        const plainIds: number[] = [];

        for (const msgId of messageIds) {
          const splitManifest = await this.ensureSplitManifestLoaded(sourceFolderId, msgId).catch(() => null);
          if (!splitManifest) {
            plainIds.push(msgId);
            continue;
          }

          // Move all split parts in order, then upload updated manifest in target folder
          const oldPartIds = splitManifest.parts.map(p => p.id);
          const newPartIds: number[] = [];
          for (let offset = 0; offset < oldPartIds.length; offset += 80) {
            const batch = oldPartIds.slice(offset, offset + 80);
            const fwdBatch = await client.forwardMessagesById({
              fromChatId: folderIdToPeer(sourceFolderId),
              toChatId: folderIdToPeer(targetFolderId),
              messages: batch,
              noAuthor: true,
            });
            for (const m of fwdBatch) {
              if (m) newPartIds.push(m.id);
            }
          }

          if (newPartIds.length === splitManifest.parts.length) {
            const updatedManifest: SplitFileManifest = {
              ...splitManifest,
              parts: splitManifest.parts.map((p, idx) => ({ id: newPartIds[idx], size: p.size })),
            };
            const manifestBytes = new TextEncoder().encode(JSON.stringify(updatedManifest));
            const manifestFileName = buildSplitManifestFileName(updatedManifest.groupId);
            const uploadedManifest = await client.uploadFile({
              file: manifestBytes,
              fileName: manifestFileName,
              fileSize: manifestBytes.byteLength,
              fileMime: 'application/json',
            });
            const sentNewManifest = await this.withResolvedFolderPeer(targetFolderId, (c, p) =>
              c.sendMedia(p, {
                type: 'document',
                file: uploadedManifest,
                fileName: manifestFileName,
                caption: buildSplitManifestCaption(updatedManifest),
              }),
            );

            const oldKey = fileCompositeKey(sourceFolderId, msgId);
            const newKey = fileCompositeKey(targetFolderId, sentNewManifest.id);
            this.db.splitManifests[newKey] = updatedManifest;
            delete this.db.splitManifests[oldKey];

            const enc = this.vault.getEncryptedFileRecord(oldKey);
            if (enc) {
              this.vault.registerEncryptedFile({ ...enc, key: newKey });
              this.vault.removeEncryptedFile(oldKey);
            }
            if (this.db.fileRenames[oldKey]) {
              this.db.fileRenames[newKey] = this.db.fileRenames[oldKey];
              delete this.db.fileRenames[oldKey];
            }

            const deleteAllOld = [...oldPartIds, msgId];
            for (let offset = 0; offset < deleteAllOld.length; offset += 100) {
              await client
                .deleteMessagesById(folderIdToPeer(sourceFolderId), deleteAllOld.slice(offset, offset + 100), {
                  revoke: true,
                })
                .catch(() => undefined);
            }
          }
        }

        if (plainIds.length > 0) {
          const forwarded = await client.forwardMessagesById({
            fromChatId: folderIdToPeer(sourceFolderId),
            toChatId: folderIdToPeer(targetFolderId),
            messages: plainIds,
            noAuthor: true,
          });
          for (let i = 0; i < plainIds.length; i++) {
            const oldKey = fileCompositeKey(sourceFolderId, plainIds[i]);
            const newMsg = forwarded[i];
            if (newMsg) {
              const newKey = fileCompositeKey(targetFolderId, newMsg.id);
              const enc = this.vault.getEncryptedFileRecord(oldKey);
              if (enc) this.vault.registerEncryptedFile({ ...enc, key: newKey });
              if (this.db.fileRenames[oldKey]) {
                this.db.fileRenames[newKey] = this.db.fileRenames[oldKey];
              }
            }
          }
          await client.deleteMessagesById(folderIdToPeer(sourceFolderId), plainIds, { revoke: true });
        }
        this.scheduleSave();
        return null;
      }

      case 'cmd_get_thumbnail': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const thumbPath = path.join(
          getPortablePaths().thumbnailsCacheDir,
          `thumb_${folderId ?? 'saved'}_${messageId}.jpg`,
        );
        if (fs.existsSync(thumbPath)) return thumbPath;

        try {
          const msg = await this.fetchSingleMessage(folderId, messageId);
          const media = msg.media as unknown as {
            thumbnails?: Array<{ width?: number }>;
            type?: string;
            fileSize?: number;
          } | null;
          if (!media) return null;
          const client = await this.ensureClient();
          if (media.thumbnails && media.thumbnails.length > 0) {
            const thumb = media.thumbnails[media.thumbnails.length - 1];
            const buf = await client.downloadAsBuffer(
              thumb as unknown as Parameters<TelegramClient['downloadAsBuffer']>[0],
            );
            fs.writeFileSync(thumbPath, Buffer.from(buf));
            return thumbPath;
          }
          if (media.type === 'photo' || ((media.fileSize ?? Infinity) < 2 * 1024 * 1024)) {
            const buf = await client.downloadAsBuffer(
              msg.media as Parameters<TelegramClient['downloadAsBuffer']>[0],
            );
            fs.writeFileSync(thumbPath, Buffer.from(buf));
            return thumbPath;
          }
        } catch {
          return null;
        }
        return null;
      }

      case 'cmd_get_display_preview':
      case 'cmd_get_preview': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const key = fileCompositeKey(folderId, messageId);
        const splitManifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
        let resolvedName = '';
        let totalSize = 0;
        if (splitManifest) {
          resolvedName = this.db.fileRenames[key] || splitManifest.name;
          totalSize = splitManifest.totalSize;
        } else {
          const msg = await this.fetchSingleMessage(folderId, messageId);
          const mapped = mapMessageToTelegramFile(msg, folderId, {
            customName: this.db.fileRenames[key],
            encryptedRecord: this.vault.getEncryptedFileRecord(key),
          });
          resolvedName = mapped?.name ?? '';
          totalSize = mapped?.size ?? 0;
        }
        const ext = path.extname(resolvedName) || '.bin';
        const previewPath = path.join(
          getPortablePaths().previewsCacheDir,
          `preview_${folderId ?? 'saved'}_${messageId}${ext}`,
        );
        if (fs.existsSync(previewPath)) return previewPath;

        await this.streamFullFileToDisk(
          folderId,
          messageId,
          previewPath,
          pct => {
            this.emitEvent('preview-progress', {
              folder_id: folderId,
              message_id: messageId,
              downloaded_bytes: Math.round((pct / 100) * totalSize),
              total_bytes: totalSize,
              percent: Math.min(99, pct),
            });
          },
          typeof args.promptToken === 'number' ? args.promptToken : undefined,
        );
        return previewPath;
      }

      case 'cmd_set_preview_pinned': {
        const key = fileCompositeKey(
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId),
          Number(args.messageId),
        );
        if (args.pinned) {
          if (!this.db.pinnedPreviews.includes(key)) this.db.pinnedPreviews.push(key);
        } else {
          this.db.pinnedPreviews = this.db.pinnedPreviews.filter(k => k !== key);
        }
        this.scheduleSave();
        return null;
      }

      case 'cmd_delete_preview_for_message': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const prefix = `preview_${folderId ?? 'saved'}_${messageId}`;
        const dir = getPortablePaths().previewsCacheDir;
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { force: true });
        }
        return null;
      }

      case 'cmd_list_archive_contents':
      case 'cmd_list_archive_entries': {
        const previewPath = String(
          await this.invoke('cmd_get_preview', {
            folderId: args.folderId,
            messageId: args.messageId,
            promptToken: args.promptToken,
          }),
        );
        const bytes = new Uint8Array(fs.readFileSync(previewPath));
        return listZipEntriesFromBytes(bytes);
      }

      case 'cmd_extract_archive_entry': {
        const previewPath = String(
          await this.invoke('cmd_get_preview', {
            folderId: args.folderId,
            messageId: args.messageId,
            promptToken: args.promptToken,
          }),
        );
        const entryPath = String(args.entryPath ?? '');
        const extracted = extractSingleZipEntry(new Uint8Array(fs.readFileSync(previewPath)), entryPath);
        const dest =
          typeof args.savePath === 'string' && args.savePath
            ? args.savePath
            : path.join(getPortablePaths().tempDir, path.basename(entryPath));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(extracted));
        return dest;
      }

      case 'cmd_zip_folder': {
        const folderPath = String(args.folderPath ?? '');
        const entries: Record<string, Uint8Array> = {};
        const walk = (dir: string, relBase: string) => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
            if (ent.isDirectory()) walk(full, rel);
            else if (ent.isFile()) entries[rel] = new Uint8Array(fs.readFileSync(full));
          }
        };
        walk(folderPath, '');
        const zipped = createZipFromEntries(entries);
        const zipDest = path.join(
          getPortablePaths().tempDir,
          `${path.basename(folderPath)}_${Date.now()}.zip`,
        );
        fs.writeFileSync(zipDest, Buffer.from(zipped));
        return zipDest;
      }

      case 'cmd_delete_temp_zip': {
        const target = String(args.path ?? '');
        if (target && target.startsWith(getPortablePaths().tempDir)) {
          fs.rmSync(target, { force: true });
        }
        return null;
      }

      case 'cmd_validate_dropped_paths': {
        const rawPaths = (args.paths as string[]) ?? [];
        const files: string[] = [];
        const folders: string[] = [];
        const rejected: string[] = [];
        for (const p of rawPaths) {
          try {
            const st = fs.statSync(p);
            if (st.isDirectory()) folders.push(p);
            else if (st.isFile()) files.push(p);
            else rejected.push(p);
          } catch {
            rejected.push(p);
          }
        }
        return { files, folders, rejected };
      }

      // ── Direct Upload / Download & Desktop Transfer Queue ──────────
      case 'initiate_upload':
      case 'cmd_upload_file': {
        const req = (args.req as Record<string, unknown> | undefined) ?? args;
        const filePath = String(req.path ?? req.file_path ?? args.path ?? '');
        const folderId =
          req.folder_id === null || req.folder_id === undefined
            ? args.folderId === null || args.folderId === undefined
              ? null
              : Number(args.folderId)
            : Number(req.folder_id);
        const transferId = String(req.id ?? args.id ?? args.transferId ?? `up_${Date.now()}`);
        const abort = new AbortController();
        this.activeAbortControllers.set(transferId, abort);
        this.directActiveDirections.set(transferId, 'upload');
        try {
          return await this.performUploadFile({
            filePath,
            folderId,
            transferId,
            protectionMode: (req.protection_mode ?? args.protectionMode) as string | undefined,
            promptToken: (req.prompt_token ?? args.promptToken) as number | undefined,
            protectMetadata: Boolean(req.protect_metadata ?? args.protectMetadata),
            videoUploadMode: (req.video_upload_mode ?? args.videoUploadMode) as 'file' | 'media' | undefined,
            videoFilenameCaption: (req.video_filename_caption ?? args.videoFilenameCaption) as boolean | undefined,
            signal: abort.signal,
          });
        } finally {
          this.activeAbortControllers.delete(transferId);
          this.directActiveDirections.delete(transferId);
        }
      }

      case 'cmd_upload_from_url': {
        const req = (args.req as Record<string, unknown> | undefined) ?? args;
        const url = String(req.url ?? args.url ?? '');
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error('Only HTTP and HTTPS URLs are permitted.');
        }
        const filename =
          String(req.filename ?? args.filename ?? '') ||
          path.basename(parsed.pathname) ||
          `remote_${Date.now()}.bin`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const tmpFile = path.join(getPortablePaths().stagingCacheDir, `${Date.now()}_${filename}`);
        fs.writeFileSync(tmpFile, Buffer.from(await resp.arrayBuffer()));
        const transferId = String(req.id ?? args.id ?? args.transferId ?? `url_${Date.now()}`);
        this.directActiveDirections.set(transferId, 'upload');
        try {
          return await this.performUploadFile({
            filePath: tmpFile,
            fileName: filename,
            folderId:
              req.folder_id === null || req.folder_id === undefined ? null : Number(req.folder_id),
            transferId,
          });
        } finally {
          this.directActiveDirections.delete(transferId);
          fs.rmSync(tmpFile, { force: true });
        }
      }

      case 'cmd_download_file': {
        const req = (args.req as Record<string, unknown> | undefined) ?? args;
        const messageId = Number(req.message_id ?? args.messageId);
        const savePath = String(req.save_path ?? args.savePath ?? '');
        const folderId =
          req.folder_id === null || req.folder_id === undefined
            ? args.folderId === null || args.folderId === undefined
              ? null
              : Number(args.folderId)
            : Number(req.folder_id);
        const transferId = String(req.id ?? args.id ?? args.transferId ?? `dl_${messageId}`);
        const abort = new AbortController();
        this.activeAbortControllers.set(transferId, abort);
        this.directActiveDirections.set(transferId, 'download');
        try {
          return await this.performDownloadFile({
            folderId,
            messageId,
            savePath,
            transferId,
            collisionPolicy: (req.collision_policy ?? args.collisionPolicy) as
              | 'overwrite'
              | 'skip'
              | 'keep_both'
              | undefined,
            promptToken: (req.prompt_token ?? args.promptToken) as number | undefined,
            signal: abort.signal,
          });
        } finally {
          this.activeAbortControllers.delete(transferId);
          this.directActiveDirections.delete(transferId);
        }
      }

      case 'cmd_cancel_transfer': {
        const id = String(args.transferId ?? args.id ?? '');
        this.explicitlyCancelledTransfers.add(id);
        this.activeAbortControllers.get(id)?.abort();
        const job = this.transfers.get(id);
        if (job) this.updateTransferJob(job, { status: 'cancelled', speedBytesPerSec: 0 });
        return null;
      }

      case 'cmd_transfer_list':
        return [...this.transfers.values()].sort((a, b) => a.queuePosition - b.queuePosition);

      case 'cmd_transfer_enqueue_many': {
        const requests = (args.requests as Array<Record<string, unknown>>) ?? [];
        const created: TransferJobRecord[] = [];
        for (const req of requests) {
          const id = String(req.id);
          const now = Date.now();
          let totalBytes = Number(req.totalBytes ?? 0);
          if (!totalBytes && typeof req.path === 'string' && fs.existsSync(req.path)) {
            totalBytes = fs.statSync(req.path).size;
          }
          const job: TransferJobRecord = {
            id,
            ownerId: (req.ownerId as string | null) ?? this.currentUserId,
            direction: req.direction as 'upload' | 'download',
            kind: req.kind as 'local_upload' | 'url_upload' | 'download',
            status: (req.initialStatus as string) || 'pending',
            path: req.path as string | undefined,
            url: req.url as string | undefined,
            folderId:
              req.folderId === null || req.folderId === undefined ? null : Number(req.folderId),
            messageId: typeof req.messageId === 'number' ? req.messageId : undefined,
            filename: String(req.filename ?? 'file'),
            savePath: req.savePath as string | undefined,
            collisionPolicy: req.collisionPolicy as 'overwrite' | 'skip' | 'keep_both' | undefined,
            protectionMode: req.protectionMode as string | undefined,
            promptToken: req.promptToken as number | undefined,
            protectMetadata: Boolean(req.protectMetadata),
            videoUploadMode: req.videoUploadMode as 'file' | 'media' | undefined,
            videoFilenameCaption: req.videoFilenameCaption as boolean | undefined,
            tempZipPath: req.tempZipPath as string | undefined,
            progress: 0,
            transferredBytes: 0,
            totalBytes,
            speedBytesPerSec: 0,
            queuePosition: this.transfers.size,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          this.transfers.set(id, job);
          this.emitEvent('transfer-upserted', { ...job });
          created.push(job);
        }
        this.pumpTransferQueue();
        return created;
      }

      case 'cmd_transfer_set_limits': {
        this.maxConcurrentUploads = Math.max(1, Number(args.maxUploads ?? 3));
        this.maxConcurrentDownloads = Math.max(1, Number(args.maxDownloads ?? 3));
        this.pumpTransferQueue();
        return null;
      }

      case 'cmd_transfer_pause': {
        const job = this.transfers.get(String(args.id));
        if (!job) throw new Error('TRANSFER_NOT_FOUND');
        this.updateTransferJob(job, { status: 'paused', speedBytesPerSec: 0 });
        this.activeAbortControllers.get(job.id)?.abort();
        return job;
      }

      case 'cmd_transfer_resume':
      case 'cmd_transfer_retry': {
        const job = this.transfers.get(String(args.id));
        if (!job) throw new Error('TRANSFER_NOT_FOUND');
        (job as unknown as { _autoRetries?: number })._autoRetries = 0;
        this.updateTransferJob(job, { status: 'pending', error: undefined, retryAt: undefined });
        this.pumpTransferQueue();
        return job;
      }

      case 'cmd_transfer_cancel': {
        const job = this.transfers.get(String(args.id));
        if (!job) throw new Error('TRANSFER_NOT_FOUND');
        this.explicitlyCancelledTransfers.add(job.id);
        this.updateTransferJob(job, { status: 'cancelled', speedBytesPerSec: 0 });
        this.activeAbortControllers.get(job.id)?.abort();
        return job;
      }

      case 'cmd_transfer_pause_all':
      case 'cmd_transfer_resume_all':
      case 'cmd_transfer_cancel_all': {
        const direction = String(args.direction);
        const affected: TransferJobRecord[] = [];
        for (const job of this.transfers.values()) {
          if (job.direction !== direction) continue;
          if (cmd === 'cmd_transfer_pause_all' && ['pending', 'uploading', 'downloading'].includes(job.status)) {
            this.updateTransferJob(job, { status: 'paused', speedBytesPerSec: 0 });
            this.activeAbortControllers.get(job.id)?.abort();
            affected.push(job);
          } else if (cmd === 'cmd_transfer_resume_all' && job.status === 'paused') {
            (job as unknown as { _autoRetries?: number })._autoRetries = 0;
            this.updateTransferJob(job, { status: 'pending', retryAt: undefined });
            affected.push(job);
          } else if (cmd === 'cmd_transfer_cancel_all' && !['completed', 'cancelled'].includes(job.status)) {
            this.explicitlyCancelledTransfers.add(job.id);
            this.updateTransferJob(job, { status: 'cancelled', speedBytesPerSec: 0 });
            this.activeAbortControllers.get(job.id)?.abort();
            affected.push(job);
          }
        }
        this.pumpTransferQueue();
        return affected;
      }

      case 'cmd_transfer_clear_terminal': {
        const direction = String(args.direction);
        const includeFailed = Boolean(args.includeFailedAndCancelled);
        const removed: string[] = [];
        for (const [id, job] of this.transfers.entries()) {
          if (job.direction !== direction) continue;
          const isTerminal =
            job.status === 'completed' ||
            (includeFailed && (job.status === 'failed' || job.status === 'cancelled'));
          if (isTerminal) {
            this.transfers.delete(id);
            this.emitEvent('transfer-removed', id);
            removed.push(id);
          }
        }
        return removed;
      }

      case 'cmd_transfer_supply_prompt_token': {
        const job = this.transfers.get(String(args.id));
        if (job) {
          job.promptToken = Number(args.promptToken);
          this.updateTransferJob(job, { status: 'pending', error: undefined });
          this.pumpTransferQueue();
        }
        return null;
      }

      case 'cmd_transfer_activity': {
        const ownerId = String(args.ownerId ?? (await this.getAccountOwnerId()));
        const jobs = [...this.transfers.values()]
          .filter(j => !j.ownerId || j.ownerId === ownerId)
          .map(j => ({ ...j, ownerId }));
        return { ownerId, jobs, legacy: [] };
      }

      case 'cmd_transfer_adopt_legacy':
      case 'cmd_transfer_discard_legacy':
        return null;

      // ── Zero-Knowledge Vault & Encryption ──────────────────────────
      case 'cmd_get_encryption_capabilities':
        return this.vault.getCapabilities();
      case 'cmd_get_vault_status':
        return this.vault.getStatus();
      case 'cmd_get_crypto_inventory':
        return this.vault.getInventory();
      case 'cmd_get_encryption_settings':
        return this.vault.getSettings();
      case 'cmd_update_encryption_settings': {
        const updated = this.vault.updateSettings(
          (args.settings as Record<string, unknown>) ?? {},
        );
        this.scheduleSave();
        return updated;
      }
      case 'cmd_create_vault':
        this.vault.createVault(String(args.passphrase ?? ''));
        this.scheduleSave();
        this.emitEvent('vault-unlocked', {});
        return null;
      case 'cmd_unlock_vault': {
        const sid = this.vault.unlock(String(args.passphrase ?? ''));
        for (const job of this.transfers.values()) {
          if (job.status === 'waiting_for_unlock' && job.protectionMode === 'vault') {
            this.updateTransferJob(job, { status: 'pending', error: undefined });
          }
        }
        this.pumpTransferQueue();
        this.emitEvent('vault-unlocked', {});
        return sid;
      }
      case 'cmd_lock_vault':
        this.vault.lock();
        this.emitEvent('vault-locked', {});
        return null;
      case 'cmd_record_vault_activity':
        this.vault.recordActivity();
        return null;
      case 'cmd_change_vault_passphrase':
        this.vault.changePassphrase(
          String(args.currentPassphrase ?? ''),
          String(args.newPassphrase ?? ''),
        );
        this.scheduleSave();
        return null;
      case 'cmd_generate_recovery_key':
        return this.vault.generateRecoveryKey();
      case 'cmd_export_vault_recovery': {
        if (args.recoveryPassphrase !== undefined) {
          return this.vault.exportVaultRecovery(String(args.recoveryPassphrase ?? ''));
        }
        return this.vault.exportVaultRecovery(
          String(args.currentPassphrase ?? ''),
          String(args.recoveryKey ?? ''),
        );
      }
      case 'cmd_verify_vault_recovery':
        return this.vault.verifyVaultRecovery(
          String(args.bundleBase64 ?? args.recoveryJson ?? ''),
          String(args.recoveryPassphrase ?? args.recoveryKey ?? ''),
        );
      case 'cmd_import_vault_recovery':
        this.vault.importVaultRecovery(
          String(args.bundleBase64 ?? args.recoveryJson ?? ''),
          String(args.recoveryPassphrase ?? args.recoveryKey ?? ''),
          args.vaultPassphrase !== undefined || args.newPassphrase !== undefined
            ? String(args.vaultPassphrase ?? args.newPassphrase ?? '')
            : undefined,
        );
        this.scheduleSave();
        return null;
      case 'cmd_stage_file_passphrase':
        return this.vault.stagePassphrase(String(args.passphrase ?? ''));
      case 'cmd_get_file_encryption_info':
        return this.vault.getFileEncryptionInfo(
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId),
          Number(args.messageId),
        );
      case 'cmd_set_desktop_lock_on_sleep': {
        const enabled = Boolean(args.enabled);
        this.vault.updateSettings({ lockOnSleep: enabled });
        this.db.desktopPreferences.lockOnSleep = enabled;
        this.scheduleSave();
        return null;
      }

      // ── Workspace, Collections, Tags & Local Search ────────────────
      case 'cmd_workspace_read': {
        const ownerId = String(args.ownerId);
        return this.buildWorkspaceSnapshot(
          ownerId,
          args.cursor as string | null | undefined,
          Number(args.limit ?? 256),
        );
      }

      case 'cmd_workspace_index': {
        const ownerId = String(args.ownerId);
        const folderIds = (args.folderIds as Array<number | null>) ?? [null];
        for (const fid of folderIds) {
          await this.listFolderFiles(fid).catch(() => undefined);
        }
        return this.buildWorkspaceSnapshot(ownerId, null, 256);
      }

      case 'cmd_workspace_mutate': {
        const ownerId = String(args.ownerId);
        const mutation = args.mutation as Record<string, unknown>;
        const collections = [...(this.db.collections[ownerId] ?? [])];
        const searches = [...(this.db.savedSearches[ownerId] ?? [])];

        switch (mutation.type) {
          case 'save_collection': {
            const col = mutation.collection as { id: string; name: string; color: string; icon: string; coverKey: string | null };
            const idx = collections.findIndex(c => c.id === col.id);
            if (idx >= 0) collections[idx] = col;
            else collections.push(col);
            this.db.collections[ownerId] = collections;
            break;
          }
          case 'remove_collection': {
            const cid = String(mutation.id);
            this.db.collections[ownerId] = collections.filter(c => c.id !== cid);
            for (const k of Object.keys(this.db.fileCollections)) {
              if (k.startsWith(`${ownerId}:`)) {
                this.db.fileCollections[k] = this.db.fileCollections[k].filter(id => id !== cid);
              }
            }
            break;
          }
          case 'assign': {
            const keys = (mutation.keys as string[]) ?? [];
            const cid = String(mutation.collection);
            const add = Boolean(mutation.add);
            for (const key of keys) {
              const mapKey = `${ownerId}:${key}`;
              const cur = new Set(this.db.fileCollections[mapKey] ?? []);
              if (add) cur.add(cid);
              else cur.delete(cid);
              this.db.fileCollections[mapKey] = [...cur];
            }
            break;
          }
          case 'tag': {
            const keys = (mutation.keys as string[]) ?? [];
            const tag = String(mutation.tag).trim();
            const add = Boolean(mutation.add);
            for (const key of keys) {
              const mapKey = `${ownerId}:${key}`;
              const cur = new Set(this.db.fileTags[mapKey] ?? []);
              if (add && tag) cur.add(tag);
              else cur.delete(tag);
              this.db.fileTags[mapKey] = [...cur];
            }
            break;
          }
          case 'save_search': {
            const s = mutation.search as { id: string };
            const idx = searches.findIndex(item => (item as { id: string }).id === s.id);
            if (idx >= 0) searches[idx] = s;
            else searches.push(s);
            this.db.savedSearches[ownerId] = searches;
            break;
          }
          case 'remove_search': {
            const sid = String(mutation.id);
            this.db.savedSearches[ownerId] = searches.filter(
              item => (item as { id: string }).id !== sid,
            );
            break;
          }
          case 'favorite': {
            const key = String(mutation.key);
            const val = Boolean(mutation.value);
            if (val && !this.db.favorites.includes(key)) this.db.favorites.push(key);
            if (!val) this.db.favorites = this.db.favorites.filter(k => k !== key);
            break;
          }
        }
        this.scheduleSave();
        return this.buildWorkspaceSnapshot(ownerId, null, 256);
      }

      case 'cmd_search_local': {
        const ownerId = String(args.ownerId);
        const qObj = (args.query as Record<string, unknown>) ?? {};
        const text = String(qObj.query ?? '').trim().toLowerCase();
        const offset = Number(qObj.offset ?? 0);
        const limit = Number(qObj.limit ?? 256);
        let candidates = this.collectAllWorkspaceFiles(ownerId);
        if (text) {
          candidates = candidates.filter(f => f.name.toLowerCase().includes(text));
        }
        if (qObj.favoritesOnly) {
          candidates = candidates.filter(f => f.is_favorite);
        }
        const slice = candidates.slice(offset, offset + limit);
        return {
          files: slice,
          indexId: `idx_${ownerId}`,
          total: candidates.length,
          nextOffset: offset + limit < candidates.length ? offset + limit : null,
          indexed: true,
          complete: true,
          offline: false,
        };
      }

      // ── Playback History & Media Helpers ───────────────────────────
      case 'cmd_playback_read': {
        const ownerId = String(args.ownerId);
        const state = this.db.playback[ownerId] ?? {
          items: [],
          queue: [],
          preferences: { volume: 1, speed: 1 },
        };
        return { ownerId, ...state };
      }

      case 'cmd_playback_mutate': {
        const ownerId = String(args.ownerId);
        const state = this.db.playback[ownerId] ?? {
          items: [],
          queue: [],
          preferences: { volume: 1, speed: 1 },
        };
        const mut = args.mutation as Record<string, unknown>;
        const file = mut.file as { folderId: number | null; messageId: number } | undefined;
        const mediaId = file ? `${ownerId}:${file.folderId ?? 'saved'}:${file.messageId}` : '';

        if (mut.type === 'progress' && file) {
          const vol = Number(mut.volume ?? state.preferences.volume);
          const spd = Number(mut.speed ?? state.preferences.speed);
          state.preferences = { volume: vol, speed: spd };
          const existingIdx = state.items.findIndex(i => i.mediaId === mediaId);
          const nextRec = {
            ...(existingIdx >= 0 ? state.items[existingIdx] : { bookmarks: [] }),
            ...file,
            mediaId,
            ownerId,
            positionMs: Number(mut.positionMs ?? 0),
            durationMs: Number(mut.durationMs ?? 0),
            completed: false,
            volume: vol,
            speed: spd,
            updatedAt: Date.now(),
          };
          if (existingIdx >= 0) state.items[existingIdx] = nextRec;
          else state.items.unshift(nextRec);
        } else if (mut.type === 'finish' && file) {
          const existing = state.items.find(i => i.mediaId === mediaId);
          if (existing) {
            existing.completed = true;
            existing.positionMs = Number(mut.durationMs ?? existing.durationMs ?? 0);
            existing.updatedAt = Date.now();
          }
        } else if (mut.type === 'restart' && file) {
          const existing = state.items.find(i => i.mediaId === mediaId);
          if (existing) existing.positionMs = 0;
        } else if (mut.type === 'forget' && file) {
          state.items = state.items.filter(i => i.mediaId !== mediaId);
        } else if (mut.type === 'bookmark' && file) {
          const existing = state.items.find(i => i.mediaId === mediaId);
          if (existing) {
            const bookmarks = (existing.bookmarks as Array<{ positionMs: number; label: string }>) ?? [];
            bookmarks.push({
              positionMs: Number(mut.positionMs ?? 0),
              label: String(mut.label ?? 'Bookmark'),
            });
            existing.bookmarks = bookmarks;
          }
        } else if (mut.type === 'remove_bookmark' && file) {
          const existing = state.items.find(i => i.mediaId === mediaId);
          if (existing) {
            const bookmarks = (existing.bookmarks as Array<{ positionMs: number; label: string }>) ?? [];
            existing.bookmarks = bookmarks.filter(b => b.positionMs !== Number(mut.positionMs));
          }
        } else if (mut.type === 'enqueue') {
          const files = (mut.files as Array<Record<string, unknown>>) ?? [];
          state.queue.push(...files);
        } else if (mut.type === 'remove_queue' && file) {
          state.queue = state.queue.filter(
            q => !(q.folderId === file.folderId && q.messageId === file.messageId),
          );
        } else if (mut.type === 'clear_queue') {
          state.queue = [];
        }

        this.db.playback[ownerId] = state;
        this.scheduleSave();
        return { ownerId, ...state };
      }

      case 'cmd_get_android_playback_history':
        return [];

      case 'cmd_get_video_metadata':
        return {
          duration_secs: null,
          width: null,
          height: null,
          video_codec: null,
          audio_codec: null,
          container: null,
          needs_transcode: false,
        };

      case 'cmd_get_cached_variants': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId ?? 0);
        const fileKey = this.transcoder.makeFileKey(this.currentUserId, folderId, messageId);
        return this.transcoder.getCachedVariants(fileKey);
      }

      case 'cmd_get_transcode_capabilities':
        return this.transcoder.getCapabilities(this.db.transcodeCacheMaxGb);

      case 'cmd_get_ffmpeg_status': {
        if (args.forceRefresh) {
          resetFfmpegDetectionCache();
        }
        return {
          ...resolveFfmpegDetails(),
          installState: getFfmpegInstallState(),
        };
      }

      case 'cmd_install_ffmpeg': {
        const details = await installPortableFfmpeg(payload => {
          this.emitEvent('ffmpeg-install-progress', payload);
        });
        return {
          ...details,
          capabilities: this.transcoder.getCapabilities(this.db.transcodeCacheMaxGb),
        };
      }

      case 'cmd_cancel_ffmpeg_install':
        cancelPortableFfmpegInstall();
        return null;

      case 'cmd_prepare_transcoded_stream': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const quality = String(args.quality ?? '720p');
        const fileKey = this.transcoder.makeFileKey(this.currentUserId, folderId, messageId);
        const key = fileCompositeKey(folderId, messageId);
        const encRec = this.vault.getEncryptedFileRecord(key);
        const splitManifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
        const isEnc = Boolean(encRec || splitManifest?.encrypted);
        const folderSeg = folderId === null ? 'home' : String(folderId);
        const directInputUrl = !isEnc
          ? `http://127.0.0.1:${this.servers.mediaPort}/stream/${folderSeg}/${messageId}?token=${encodeURIComponent(this.servers.streamToken)}`
          : undefined;

        return await this.transcoder.prepareTranscode({
          fileKey,
          quality,
          directInputUrl,
          ensureSourceCached: async (targetPath, onProgress) => {
            await this.streamFullFileToDisk(folderId, messageId, targetPath, onProgress);
          },
        });
      }

      case 'cmd_get_transcode_status':
        return this.transcoder.getJobStatus(String(args.jobId ?? ''));

      case 'cmd_get_master_playlist_info': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const fileKey = this.transcoder.makeFileKey(this.currentUserId, folderId, messageId);
        return this.transcoder.getMasterPlaylistInfo(fileKey);
      }

      case 'cmd_prepare_fmp4_stream': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const fileKey = this.transcoder.makeFileKey(this.currentUserId, folderId, messageId);
        const key = fileCompositeKey(folderId, messageId);
        const encRec = this.vault.getEncryptedFileRecord(key);
        const splitManifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
        const isEnc = Boolean(encRec || splitManifest?.encrypted);
        const folderSeg = folderId === null ? 'home' : String(folderId);
        const directInputUrl = !isEnc
          ? `http://127.0.0.1:${this.servers.mediaPort}/stream/${folderSeg}/${messageId}?token=${encodeURIComponent(this.servers.streamToken)}`
          : undefined;

        return await this.transcoder.prepareFmp4Remux({
          fileKey,
          directInputUrl,
          ensureSourceCached: async targetPath => {
            await this.streamFullFileToDisk(folderId, messageId, targetPath);
          },
        });
      }

      case 'cmd_get_fmp4_status':
        return this.transcoder.getFmp4Status(String(args.fileKey ?? ''));

      case 'cmd_set_transcode_cache_limit':
        this.db.transcodeCacheMaxGb = Math.max(1, Number(args.maxGb ?? 5));
        this.scheduleSave();
        return null;

      case 'cmd_clear_transcode_cache':
        return this.transcoder.clearCache(
          typeof args.fileKey === 'string' && args.fileKey ? args.fileKey : undefined,
          typeof args.quality === 'string' && args.quality ? args.quality : undefined,
        );

      // ── Cleanup, Offline Packs & Device Storage ────────────────────
      case 'cmd_cleanup_list': {
        const ownerId = String(args.ownerId);
        return this.db.removals[ownerId] ?? [];
      }

      case 'cmd_cleanup_schedule': {
        const ownerId = String(args.ownerId);
        const keys = (args.keys as string[]) ?? [];
        const days = Math.max(0, Number(args.retentionDays ?? 7));
        const allFiles = new Map(this.collectAllWorkspaceFiles(ownerId).map(f => [f.key, f]));
        const list = this.db.removals[ownerId] ?? [];
        const outcomes: Array<{ key: string; scheduled: boolean; error: string | null }> = [];
        const now = Date.now();

        for (const key of keys) {
          const file = allFiles.get(key);
          if (!file) {
            outcomes.push({ key, scheduled: false, error: 'FILE_NOT_FOUND' });
            continue;
          }
          if (days === 0) {
            await this.deleteTelegramMessage(file.folder_id, file.id);
          } else {
            list.push({
              id: nodeCrypto.randomUUID(),
              key,
              file,
              requestedAt: now,
              deleteAfter: now + days * 86_400_000,
              status: 'pending',
              error: null,
            });
          }
          outcomes.push({ key, scheduled: true, error: null });
        }
        this.db.removals[ownerId] = list;
        this.scheduleSave();
        return outcomes;
      }

      case 'cmd_cleanup_restore': {
        const ownerId = String(args.ownerId);
        const key = String(args.key);
        const list = this.db.removals[ownerId] ?? [];
        const found = list.find(r => r.key === key);
        if (!found) throw new Error('REMOVAL_NOT_FOUND');
        found.status = 'restored';
        this.scheduleSave();
        return found;
      }

      case 'cmd_offline_packs_list': {
        const ownerId = String(args.ownerId);
        const freeBytes = fs.statfsSync(getPortablePaths().dataRoot).bavail * fs.statfsSync(getPortablePaths().dataRoot).bsize;
        return {
          ownerId,
          packs: this.db.offlinePacks[ownerId] ?? [],
          freeBytes,
          reserveBytes: 512 * 1024 * 1024,
          network: { known: true, connected: true, wifi: true },
        };
      }

      case 'cmd_offline_pack_create': {
        const ownerId = String(args.ownerId);
        const name = String(args.name ?? 'Offline Pack');
        const fileKeys = (args.fileKeys as string[]) ?? [];
        const allFiles = new Map(this.collectAllWorkspaceFiles(ownerId).map(f => [f.key, f]));
        const now = Date.now();
        const packId = nodeCrypto.randomUUID();
        const items = fileKeys
          .map(k => allFiles.get(k))
          .filter(Boolean)
          .map(file => ({
            file,
            status: 'pending',
            downloadedBytes: 0,
            error: null,
          }));
        const pack = {
          id: packId,
          ownerId,
          name,
          wifiOnly: Boolean(args.wifiOnly),
          expiresAt: (args.expiresAt as number | null) ?? null,
          createdAt: now,
          updatedAt: now,
          status: 'running',
          waitingReason: null,
          autoResume: true,
          activeRun: packId,
          files: items,
        };
        const packs = this.db.offlinePacks[ownerId] ?? [];
        packs.unshift(pack);
        this.db.offlinePacks[ownerId] = packs;
        this.scheduleSave();

        void (async () => {
          const packDir = path.join(getPortablePaths().offlineCacheDir, packId);
          fs.mkdirSync(packDir, { recursive: true });
          for (const item of items) {
            if (!item.file) continue;
            try {
              item.status = 'downloading';
              const dest = path.join(packDir, `${item.file.id}_${item.file.name}`);
              await this.performDownloadFile({
                folderId: item.file.folder_id,
                messageId: item.file.id,
                savePath: dest,
                transferId: `offline_${packId}_${item.file.id}`,
                collisionPolicy: 'overwrite',
              });
              item.status = 'ready';
              item.downloadedBytes = item.file.size;
            } catch (e) {
              item.status = 'error';
              (item as { error: string | null }).error = e instanceof Error ? e.message : String(e);
            }
          }
          pack.status = items.every(i => i.status === 'ready') ? 'ready' : 'error';
          pack.updatedAt = Date.now();
          this.scheduleSave();
        })();

        return pack;
      }

      case 'cmd_offline_pack_action': {
        const ownerId = String(args.ownerId);
        const packId = String(args.packId);
        const action = String(args.action);
        const packs = this.db.offlinePacks[ownerId] ?? [];
        const idx = packs.findIndex(p => p.id === packId);
        if (idx < 0) return null;
        if (action === 'remove') {
          packs.splice(idx, 1);
          fs.rmSync(path.join(getPortablePaths().offlineCacheDir, packId), { recursive: true, force: true });
          this.scheduleSave();
          return null;
        }
        const pack = packs[idx];
        if (action === 'pause') pack.status = 'paused';
        else if (action === 'cancel') pack.status = 'cancelled';
        else if (action === 'start' || action === 'retry') pack.status = 'ready';
        pack.updatedAt = Date.now();
        this.scheduleSave();
        return pack;
      }

      case 'cmd_offline_pack_path': {
        const packId = String(args.packId);
        const fileKey = String(args.fileKey);
        const msgId = fileKey.split(':')[1] ?? '';
        const packDir = path.join(getPortablePaths().offlineCacheDir, packId);
        if (fs.existsSync(packDir)) {
          const found = fs.readdirSync(packDir).find(n => n.startsWith(`${msgId}_`));
          if (found) return path.join(packDir, found);
        }
        throw new Error('OFFLINE_FILE_NOT_READY');
      }

      case 'cmd_storage_read': {
        const ownerId = String(args.ownerId);
        const paths = getPortablePaths();
        const previews = measureDirectory(paths.previewsCacheDir);
        const thumbs = measureDirectory(paths.thumbnailsCacheDir);
        const offline = measureDirectory(paths.offlineCacheDir);
        const staging = measureDirectory(paths.stagingCacheDir);
        const statFs = fs.statfsSync(paths.dataRoot);
        const freeBytes = statFs.bavail * statFs.bsize;
        const limits = this.db.storageLimits[ownerId] ?? {
          previews: 2 * 1024 * 1024 * 1024,
          thumbnails: 512 * 1024 * 1024,
          converted: 5 * 1024 * 1024 * 1024,
        };
        return {
          ownerId,
          freeBytes,
          limits,
          categories: [
            { id: 'kept', bytes: offline.bytes, reclaimableBytes: offline.bytes, fileCount: offline.fileCount, measured: true },
            { id: 'previews', bytes: previews.bytes, reclaimableBytes: previews.bytes, fileCount: previews.fileCount, measured: true },
            { id: 'thumbnails', bytes: thumbs.bytes, reclaimableBytes: thumbs.bytes, fileCount: thumbs.fileCount, measured: true },
            { id: 'nativePreviews', bytes: 0, reclaimableBytes: 0, fileCount: 0, measured: true },
            { id: 'converted', bytes: 0, reclaimableBytes: 0, fileCount: 0, measured: true },
            { id: 'downloads', bytes: 0, reclaimableBytes: 0, fileCount: 0, measured: true },
            { id: 'staging', bytes: staging.bytes, reclaimableBytes: staging.bytes, fileCount: staging.fileCount, measured: true },
          ],
        };
      }

      case 'cmd_storage_clear': {
        const category = String(args.category);
        const paths = getPortablePaths();
        const map: Record<string, string> = {
          kept: paths.offlineCacheDir,
          previews: paths.previewsCacheDir,
          thumbnails: paths.thumbnailsCacheDir,
          staging: paths.stagingCacheDir,
        };
        const dir = map[category];
        if (dir && fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });
        }
        return null;
      }

      case 'cmd_storage_limits': {
        const ownerId = String(args.ownerId);
        this.db.storageLimits[ownerId] = args.limits as {
          previews: number;
          thumbnails: number;
          converted: number;
        };
        this.scheduleSave();
        return null;
      }

      case 'cmd_get_offline_cache_status': {
        const paths = getPortablePaths();
        const previews = measureDirectory(paths.previewsCacheDir);
        return {
          total_bytes: previews.bytes,
          pinned_bytes: 0,
          file_count: previews.fileCount,
          pinned_count: this.db.pinnedPreviews.length,
          max_bytes: Math.round(this.db.previewCacheMaxGb * 1024 * 1024 * 1024),
        };
      }

      case 'cmd_set_preview_cache_limit':
        this.db.previewCacheMaxGb = Number(args.maxGb ?? 2);
        this.scheduleSave();
        return null;

      case 'cmd_clean_preview_cache': {
        const dir = getPortablePaths().previewsCacheDir;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        return null;
      }

      case 'cmd_clean_cache': {
        const paths = getPortablePaths();
        for (const dir of [paths.previewsCacheDir, paths.thumbnailsCacheDir, paths.stagingCacheDir]) {
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });
        }
        return null;
      }

      // ── Share Links, Folder Sync, Settings Sync, Proxy, Servers ────
      case 'cmd_create_share': {
        const ownerId = String(args.ownerId);
        const id = nodeCrypto.randomBytes(8).toString('hex');
        const pw = args.password ? String(args.password) : null;
        const expiryHours = typeof args.expiryHours === 'number' ? args.expiryHours : null;
        const record: ShareRecord = {
          id,
          owner_id: ownerId,
          folder_id:
            args.folderId === null || args.folderId === undefined ? null : Number(args.folderId),
          message_id: Number(args.messageId),
          file_name: String(args.fileName ?? 'file'),
          file_size: Number(args.fileSize ?? 0),
          link: `http://127.0.0.1:${this.servers.mediaPort}/s/${id}`,
          password_protected: Boolean(pw),
          password_hash: pw ? nodeCrypto.createHash('sha256').update(pw).digest('hex') : null,
          expires_at: expiryHours
            ? new Date(Date.now() + expiryHours * 3600_000).toISOString()
            : null,
          created_at: new Date().toISOString(),
          download_count: 0,
        };
        this.db.shares.unshift(record);
        this.scheduleSave();
        return record;
      }

      case 'cmd_list_shares': {
        const ownerId = String(args.ownerId ?? '');
        return this.db.shares.filter(s => !ownerId || s.owner_id === ownerId);
      }

      case 'cmd_revoke_share': {
        const id = String(args.id);
        this.db.shares = this.db.shares.filter(s => s.id !== id);
        this.scheduleSave();
        return null;
      }

      case 'cmd_add_sync_pair': {
        const pair: StoredSyncPair = {
          id: Date.now(),
          ownerId: String(args.ownerId ?? ''),
          local_path: String(args.localPath ?? ''),
          channel_id: Number(args.channelId ?? 0),
          label: args.label ? String(args.label) : undefined,
          is_active: true,
          sync_direction: String(args.syncDirection ?? 'bidirectional'),
          conflict_policy: String(args.conflictPolicy ?? 'keep_both'),
          exclude_patterns: (args.excludePatterns as string[]) ?? [],
          last_synced_at: new Date().toISOString(),
        };
        this.db.syncPairs.push(pair);
        this.refreshFolderWatchers();
        this.scheduleSave();
        return pair;
      }

      case 'cmd_preview_sync_pair': {
        const req = (args.request as Record<string, unknown>) ?? {};
        const localPath = String(req.localPath ?? req.local_path ?? '');
        const measured = measureDirectory(localPath);
        return {
          preview_token: nodeCrypto.randomUUID(),
          local_files_count: measured.fileCount,
          local_bytes: measured.bytes,
          uploads_planned: measured.fileCount,
          downloads_planned: 0,
          conflicts_planned: 0,
        };
      }

      case 'cmd_update_sync_pair': {
        const req = (args.request as Record<string, unknown>) ?? {};
        const pid = Number(req.pairId ?? req.id ?? 0);
        const found = this.db.syncPairs.find(p => p.id === pid);
        if (!found) throw new Error('SYNC_PAIR_NOT_FOUND');
        found.is_active = Boolean(args.isActive);
        if (req.localPath) found.local_path = String(req.localPath);
        if (req.channelId) found.channel_id = Number(req.channelId);
        this.refreshFolderWatchers();
        this.scheduleSave();
        return found;
      }

      case 'cmd_set_sync_pair_active': {
        const found = this.db.syncPairs.find(p => p.id === Number(args.pairId));
        if (found) found.is_active = Boolean(args.isActive);
        this.refreshFolderWatchers();
        this.scheduleSave();
        return null;
      }

      case 'cmd_remove_sync_pair': {
        const pid = Number(args.pairId);
        this.db.syncPairs = this.db.syncPairs.filter(p => p.id !== pid);
        this.refreshFolderWatchers();
        this.scheduleSave();
        return null;
      }

      case 'cmd_get_sync_settings':
        return {
          enabled: this.db.syncPairs.some(p => p.is_active),
          scanner_enabled: false,
          scan_interval_seconds: 300,
        };

      case 'cmd_toggle_sync': {
        const enabled = Boolean(args.enabled);
        for (const p of this.db.syncPairs) p.is_active = enabled;
        this.refreshFolderWatchers();
        this.scheduleSave();
        this.emitEvent('sync-status-changed', {});
        return {
          enabled,
          scanner_enabled: false,
          scan_interval_seconds: 300,
        };
      }

      case 'cmd_set_sync_scanner':
        return {
          enabled: this.db.syncPairs.some(p => p.is_active),
          scanner_enabled: Boolean(args.scannerEnabled),
          scan_interval_seconds: Number(args.scanIntervalSeconds ?? 300),
        };

      case 'cmd_get_sync_pairs': {
        const ownerId = String(args.ownerId ?? '');
        return this.db.syncPairs.filter(p => !ownerId || p.ownerId === ownerId);
      }

      case 'cmd_get_sync_status': {
        const ownerId = String(args.ownerId ?? '');
        const pairs = this.db.syncPairs.filter(p => !ownerId || p.ownerId === ownerId);
        const conflicts = this.db.syncConflicts.filter(c => !ownerId || c.ownerId === ownerId);
        const activePairs = pairs.filter(p => p.is_active).length;
        return {
          enabled: activePairs > 0,
          running: this.syncWatchers.size > 0,
          activePairs,
          pendingOps: 0,
          conflicts: conflicts.length,
          lastError: null,
          pairs: pairs.map(p => ({
            pairId: p.id,
            localPath: p.local_path,
            channelId: p.channel_id,
            label: p.label,
            isActive: p.is_active,
            syncDirection: p.sync_direction,
            watching: this.syncWatchers.has(p.id),
            syncing: false,
            pendingCount: 0,
            conflictCount: conflicts.filter(c => c.pair_id === p.id).length,
            lastSyncedAt: p.last_synced_at,
          })),
        };
      }

      case 'cmd_get_sync_conflicts': {
        const ownerId = String(args.ownerId ?? '');
        return this.db.syncConflicts.filter(c => !ownerId || c.ownerId === ownerId);
      }

      case 'cmd_resolve_conflict': {
        const pid = Number(args.pairId);
        const relPath = String(args.path ?? '');
        this.db.syncConflicts = this.db.syncConflicts.filter(
          c => !(c.pair_id === pid && c.relative_path === relPath),
        );
        this.scheduleSave();
        return null;
      }

      case 'cmd_get_settings_sync_status': {
        try {
          const client = await this.ensureClient();
          const history = await client.getHistory('self', { limit: 40 });
          const syncMsg = history.find(m => m.text?.startsWith(SETTINGS_SYNC_MARKER));
          if (!syncMsg?.text) {
            return { available: false, updated_at: null, device_id: null, current_device: false };
          }
          const idx = syncMsg.text.indexOf('{');
          const parsed = JSON.parse(syncMsg.text.slice(idx)) as {
            updated_at: number;
            device_id: string;
          };
          return {
            available: true,
            updated_at: parsed.updated_at,
            device_id: parsed.device_id,
            current_device: parsed.device_id === this.db.deviceId,
          };
        } catch {
          return { available: false, updated_at: null, device_id: null, current_device: false };
        }
      }

      case 'cmd_upload_settings_sync': {
        const client = await this.ensureClient();
        const settings = (args.settings as Record<string, unknown>) ?? {};
        const passphrase = String(args.passphrase ?? '');
        const { payloadText, updatedAt } = encryptSettingsSyncPayload(
          settings,
          passphrase,
          this.db.deviceId,
        );
        const history = await client.getHistory('self', { limit: 40 });
        const old = history.filter(m => m.text?.startsWith(SETTINGS_SYNC_MARKER)).map(m => m.id);
        if (old.length > 0) {
          await client.deleteMessagesById('self', old, { revoke: true }).catch(() => undefined);
        }
        await client.sendText('self', payloadText);
        return {
          available: true,
          updated_at: updatedAt,
          device_id: this.db.deviceId,
          current_device: true,
        };
      }

      case 'cmd_download_settings_sync': {
        const client = await this.ensureClient();
        const passphrase = String(args.passphrase ?? '');
        const history = await client.getHistory('self', { limit: 40 });
        const syncMsg = history.find(m => m.text?.startsWith(SETTINGS_SYNC_MARKER));
        if (!syncMsg?.text) throw new Error('SETTINGS_SYNC_NOT_FOUND');
        return decryptSettingsSyncPayload(syncMsg.text, passphrase);
      }

      // ── Network, Proxy, Local API & WebDAV ─────────────────────────
      case 'cmd_apply_proxy_settings': {
        const cfg = (args.config ?? args.settings ?? args) as Partial<ProxySettingsConfig>;
        this.db.proxy = {
          enabled: Boolean(cfg.enabled),
          type: (cfg.type as 'socks5' | 'http' | 'mtproto') ?? 'socks5',
          host: String(cfg.host ?? '127.0.0.1'),
          port: Number(cfg.port ?? 1080),
          username: cfg.username ? String(cfg.username) : undefined,
          password: cfg.password ? String(cfg.password) : undefined,
          secret: cfg.secret ? String(cfg.secret) : undefined,
        };
        this.scheduleSave();
        return true;
      }

      case 'cmd_clear_proxy_secret':
        this.db.proxy.password = undefined;
        this.db.proxy.secret = undefined;
        this.scheduleSave();
        return null;

      case 'cmd_apply_vpn_compat_settings':
        this.db.vpnCompat = {
          enabled: Boolean(args.enabled),
          preferIpv4: Boolean(args.preferIpv4 ?? true),
          bindInterface: (args.bindInterface as string | null) ?? null,
        };
        this.scheduleSave();
        return true;

      case 'cmd_reconnect_with_network_settings': {
        if (this.client) {
          await this.persistMtprotoSession();
          await this.client.destroy().catch(() => undefined);
          this.client = null;
          this.currentApiHash = null;
        }
        if (this.db.apiId) {
          const client = await this.ensureClient(this.db.apiId);
          await client.getMe();
        }
        return true;
      }

      case 'cmd_check_latency': {
        const t0 = performance.now();
        if (this.client) {
          await this.client.getMe();
        }
        return Math.max(1, Math.round(performance.now() - t0));
      }

      case 'cmd_get_proxy_status': {
        const t0 = performance.now();
        try {
          if (this.client) await this.client.getMe();
          return { reachable: true, latency_ms: Math.max(1, Math.round(performance.now() - t0)) };
        } catch {
          return { reachable: false, latency_ms: 0 };
        }
      }

      case 'cmd_test_proxy_traffic': {
        try {
          const client = await this.ensureClient();
          await client.getMe();
          return true;
        } catch {
          return false;
        }
      }

      case 'cmd_detect_vpn': {
        const nets = os.networkInterfaces();
        return Object.keys(nets).some(name =>
          /tun|tap|wg|wireguard|tailscale|vpn|proton|nord|warp/i.test(name),
        );
      }

      case 'cmd_get_bandwidth':
        return {
          date: new Date().toISOString().slice(0, 10),
          up_bytes: this.db.bandwidth.uploaded,
          down_bytes: this.db.bandwidth.downloaded,
          limit_bytes: this.db.weeklyQuotaBytes ?? 0,
          period: 'weekly',
          uploaded_bytes: this.db.bandwidth.uploaded,
          downloaded_bytes: this.db.bandwidth.downloaded,
        };

      case 'cmd_set_weekly_quota': {
        const nextLimit = Math.max(0, Number(args.limitBytes ?? 0));
        this.db.weeklyQuotaBytes = Number.isFinite(nextLimit) ? Math.round(nextLimit) : 0;
        this.scheduleSave();
        return {
          date: new Date().toISOString().slice(0, 10),
          up_bytes: this.db.bandwidth.uploaded,
          down_bytes: this.db.bandwidth.downloaded,
          limit_bytes: this.db.weeklyQuotaBytes,
          period: 'weekly',
          uploaded_bytes: this.db.bandwidth.uploaded,
          downloaded_bytes: this.db.bandwidth.downloaded,
        };
      }

      case 'cmd_migrate_proxy_secret':
      case 'cmd_set_native_language':
      case 'cmd_workspace_cancel_asset':
        return null;

      case 'cmd_workspace_asset': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const kind = String(args.kind ?? 'preview');
        if (kind === 'thumbnail') {
          const thumb = await this.invoke('cmd_get_thumbnail', { folderId, messageId });
          return { path: thumb, cached: Boolean(thumb) };
        }
        const prev = await this.invoke('cmd_get_preview', {
          folderId,
          messageId,
          promptToken: args.promptToken,
        });
        return { path: prev, cached: Boolean(prev) };
      }

      case 'cmd_get_detailed_transcode_cache':
        return this.transcoder.scanCache(this.db.transcodeCacheMaxGb);

      case 'cmd_get_detailed_cache_info': {
        const paths = getPortablePaths();
        const previews = measureDirectory(paths.previewsCacheDir);
        return {
          entries: [],
          total_bytes: previews.bytes,
          max_bytes: Math.round(this.db.previewCacheMaxGb * 1024 * 1024 * 1024),
          scan_in_progress: false,
          last_scanned_at: Date.now(),
          last_error: null,
        };
      }

      case 'cmd_get_cache_info': {
        const paths = getPortablePaths();
        const previews = measureDirectory(paths.previewsCacheDir);
        const thumbs = measureDirectory(paths.thumbnailsCacheDir);
        return {
          total_bytes: previews.bytes + thumbs.bytes,
          file_count: previews.fileCount + thumbs.fileCount,
        };
      }

      case 'cmd_get_api_settings':
        return {
          ...this.db.apiSettings,
          running: this.servers.isApiRunning(),
          bind_address: '127.0.0.1',
        };

      case 'cmd_update_api_settings': {
        if (typeof args.enabled === 'boolean') this.db.apiSettings.enabled = args.enabled;
        if (typeof args.port === 'number') this.db.apiSettings.port = args.port;
        await this.servers.configureApiServer({
          enabled: this.db.apiSettings.enabled,
          port: this.db.apiSettings.port,
          apiKey: this.db.apiSettings.api_key,
        });
        this.scheduleSave();
        return {
          ...this.db.apiSettings,
          running: this.servers.isApiRunning(),
          bind_address: '127.0.0.1',
        };
      }

      case 'cmd_regenerate_api_key': {
        this.db.apiSettings.api_key = nodeCrypto.randomBytes(24).toString('hex');
        if (this.db.apiSettings.enabled) {
          await this.servers.configureApiServer({
            enabled: true,
            port: this.db.apiSettings.port,
            apiKey: this.db.apiSettings.api_key,
          });
        }
        this.scheduleSave();
        return this.db.apiSettings.api_key;
      }

      case 'cmd_get_webdav_settings':
        return {
          enabled: this.db.webdavSettings.enabled,
          port: this.db.webdavSettings.port,
          running: this.servers.isWebDavRunning(),
          has_token: Boolean(this.db.webdavSettings.token_hash),
          token_preview: this.db.webdavSettings.token_preview,
          mount_url: `http://127.0.0.1:${this.db.webdavSettings.port}/`,
        };

      case 'cmd_regenerate_webdav_token': {
        const rawToken = nodeCrypto.randomBytes(20).toString('hex');
        this.db.webdavSettings.token_hash = nodeCrypto
          .createHash('sha256')
          .update(rawToken)
          .digest('hex');
        this.db.webdavSettings.token_preview = `${rawToken.slice(0, 6)}…${rawToken.slice(-4)}`;
        if (this.db.webdavSettings.enabled) {
          await this.servers.configureWebDavServer({
            enabled: true,
            port: this.db.webdavSettings.port,
            tokenHash: this.db.webdavSettings.token_hash,
          });
        }
        this.scheduleSave();
        return {
          token: rawToken,
          mount_url: `http://127.0.0.1:${this.db.webdavSettings.port}/`,
        };
      }

      case 'cmd_update_webdav_settings': {
        if (typeof args.enabled === 'boolean') this.db.webdavSettings.enabled = args.enabled;
        if (typeof args.port === 'number') this.db.webdavSettings.port = args.port;
        await this.servers.configureWebDavServer({
          enabled: this.db.webdavSettings.enabled,
          port: this.db.webdavSettings.port,
          tokenHash: this.db.webdavSettings.token_hash,
        });
        this.scheduleSave();
        return {
          enabled: this.db.webdavSettings.enabled,
          port: this.db.webdavSettings.port,
          running: this.servers.isWebDavRunning(),
          has_token: Boolean(this.db.webdavSettings.token_hash),
          token_preview: this.db.webdavSettings.token_preview,
          mount_url: `http://127.0.0.1:${this.db.webdavSettings.port}/`,
        };
      }

      // ── Desktop Lifecycle, Open Externally, Diagnostics & Updater ──
      case 'cmd_get_desktop_preferences':
        return this.getDesktopPreferences();

      case 'cmd_update_desktop_preferences': {
        this.db.desktopPreferences = {
          ...this.db.desktopPreferences,
          ...((args.preferences as Record<string, unknown>) ?? {}),
        };
        this.scheduleSave();
        return this.getDesktopPreferences();
      }

      case 'cmd_get_notification_permission':
      case 'cmd_request_notification_permission':
        return 'granted';

      case 'cmd_desktop_frontend_ready':
      case 'cmd_desktop_frontend_unready':
        return null;

      case 'cmd_open_file_externally': {
        const p = String(args.path ?? '');
        if (p && fs.existsSync(p)) {
          await shell.openPath(p);
        }
        return null;
      }

      case 'cmd_get_system_diagnostics': {
        const paths = getPortablePaths();
        return JSON.stringify(
          {
            app: 'Telegram Drive (Portable Desktop)',
            version: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron,
            node: process.versions.node,
            portableDataRoot: paths.dataRoot,
            connected: Boolean(this.client),
            streamingPort: this.servers.mediaPort,
            vaultState: this.vault.getStatus().state,
          },
          null,
          2,
        );
      }

      case 'cmd_check_github_update':
        return await checkGithubUpdate(String(args.currentVersion ?? app.getVersion()));

      case 'cmd_install_github_update': {
        await downloadAndInstallWindowsUpdate(
          String(args.downloadUrl ?? ''),
          String(args.assetName ?? 'Telegram-Drive-portable-setup.exe'),
          percent => this.emitEvent('update-download-progress', { progress: percent }),
          async () => {
            await this.shutdown();
            this.lifecycleHooks.flushStoresSync?.();
          },
        );
        return true;
      }

      // ── Portable App Relocation & Data Migration ───────────────────
      case 'cmd_get_portable_migration_info':
        return getPortableMigrationInfo();

      case 'cmd_relocate_portable_app': {
        const destinationDir = String(args.destinationDir ?? '');
        const mode = args.mode === 'move' ? 'move' : 'copy';
        const includeCaches = args.includeCaches !== false;
        return await relocatePortableApp(
          { destinationDir, mode, includeCaches },
          {
            flushAllSync: () => this.flushSync(),
            onProgress: payload => this.emitEvent('migration-progress', payload),
          },
        );
      }

      case 'cmd_launch_relocated_app': {
        const targetDir = String(args.targetDir ?? '');
        const executablePath = String(args.executablePath ?? '');
        const mode = args.mode === 'move' ? 'move' : 'copy';
        return launchRelocatedAppAndExit(
          { targetDir, executablePath, mode },
          () => {
            this.flushSync();
            if (this.lifecycleHooks.triggerAppQuit) {
              this.lifecycleHooks.triggerAppQuit();
            } else {
              app.quit();
            }
          },
        );
      }

      case 'cmd_export_portable_data':
      case 'cmd_export_portable_bundle': {
        const outputFilePath = String(args.outputFilePath ?? args.outputPath ?? '');
        if (!outputFilePath) throw new Error('MIGRATION_OUTPUT_REQUIRED');
        return exportPortableDataBundle(outputFilePath, {
          flushAllSync: () => this.flushSync(),
        });
      }

      case 'cmd_import_portable_data':
      case 'cmd_import_portable_bundle': {
        const sourcePath = String(args.sourcePath ?? '');
        if (!sourcePath) throw new Error('MIGRATION_SOURCE_REQUIRED');
        if (this.client) {
          await this.client.destroy().catch(() => undefined);
          this.client = null;
          this.currentApiHash = null;
        }
        this.mtprotoStorage = null;
        const result = importPortableDataBundleOrFolder(sourcePath);
        this.lifecycleHooks.reloadStoresSync?.();
        this.loadDatabase();
        this.hydrateFilesCacheFromDb();
        this.currentUserId = this.db.lastUserId ?? null;
        this.vault.loadPersisted(this.db.vaultData);
        return result;
      }

      case 'cmd_create_device_link': {
        const apiId = Number(this.db.apiId || 0);
        const apiHash =
          this.currentApiHash ||
          readEncryptedSecretFile(this.apiHashFilePath) ||
          '';
        if (!apiId || !apiHash) {
          throw new Error('API_CREDENTIALS_MISSING');
        }
        const primaryClient = await this.ensureClient(apiId, apiHash);
        const me = await primaryClient.getMe();
        const password = typeof args.password === 'string' ? args.password : undefined;

        return await mintDeviceLinkBundle({
          apiId,
          apiHash,
          userId: String(me.id),
          primaryClient,
          password,
          createGuestClient: async () =>
            await createNodeTelegramClient({
              apiId,
              apiHash,
              storage: new MemoryStorage(),
              getProxy: () => (this.db.proxy.enabled ? this.db.proxy : null),
            }),
        });
      }

      case 'cmd_import_device_link': {
        const rawCode = String(args.code ?? '');
        const payload = unpackDeviceLinkToken(rawCode);

        this.qrState.abort?.abort();
        if (this.client) {
          await this.client.destroy().catch(() => undefined);
          this.client = null;
          this.currentApiHash = null;
        }
        if (this.mtprotoStorage) {
          this.mtprotoStorage.clearDisk();
          this.mtprotoStorage = null;
        }
        fs.rmSync(this.sessionFilePath, { force: true });
        removeResilientBackupsSync(this.sessionFilePath);

        writeEncryptedSecretFile(this.apiHashFilePath, payload.apiHash);
        writeEncryptedSecretFile(this.sessionFilePath, payload.session);
        this.db.apiId = payload.apiId;

        const client = await this.ensureClient(payload.apiId, payload.apiHash);
        await client.importSession(payload.session, true);
        const me = await client.getMe();
        this.currentUserId = String(me.id);
        this.db.lastUserId = this.currentUserId;
        await this.persistMtprotoSession();
        this.flushDatabase();

        return {
          success: true,
          apiId: payload.apiId,
          userId: this.currentUserId,
        };
      }

      default:
        return null;
    }
  }

  public async shutdown(): Promise<void> {
    for (const watcher of this.syncWatchers.values()) watcher.close();
    this.syncWatchers.clear();
    this.transcoder.shutdownAll();
    await this.persistMtprotoSession();
    this.flushSync();
    await this.servers.stopAll();
    if (this.client) {
      await this.client.destroy().catch(() => undefined);
      this.client = null;
    }
    this.mtprotoStorage?.flushSync();
  }
}
