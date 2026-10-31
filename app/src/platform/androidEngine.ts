import { SentCode, User, type Message } from '@mtcute/core';
import { BaseTelegramClient, IdbStorage, TelegramClient, WebCryptoProvider, WebPlatform, WebSocketTransport } from '@mtcute/web';
import mtcuteWasmUrl from '@mtcute/wasm/mtcute.wasm?url';
import {
  VaultRuntime,
  decryptSettingsSyncPayload,
  encryptSettingsSyncPayload,
  type EncryptedFileRecord,
  type PersistedVaultRecord,
  type VaultStateSettings,
} from '../../shared/cryptoVault';
import {
  SETTINGS_SYNC_MARKER,
  TG_DRIVE_CHANNEL_PREFIX,
  extractSingleZipEntry,
  formatByteSize,
  guessMimeType,
  listZipEntriesFromBytes,
  mapMessageToTelegramFile,
  mapSentCodeResult,
  type MappedTelegramFile,
} from '../../shared/mtprotoHelpers';
import {
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
  type SplitPartDescriptor,
  type SplitUploadCheckpoint,
} from '../../shared/splitFiles';
import {
  GITHUB_LATEST_RELEASE_API,
  GITHUB_RELEASES_URL,
  compareVersions,
  formatDisplayVersion,
  parseMajorMinor,
  pickPlatformReleaseAsset,
  type GithubLatestReleasePayload,
} from '../../shared/versioning';
import { dispatchLocalEvent } from './eventBus';
import { isAndroidNative, TelegramDriveNative, type MediaStreamRequestEvent } from './nativeBridge';
import { runRobustQrSignIn } from '../../shared/qrAuthLoop';

const STATE_STORAGE_KEY = 'telegram_drive_android_state_v1';
const STATE_BOOTSTRAP_KEY = 'telegram_drive_android_boot_v2';
const ANDROID_IDB_NAME = 'telegram-drive-android-state-db';
const ANDROID_IDB_STORE = 'kv';
const ANDROID_IDB_STATE_KEY = 'state_v2';
const ANDROID_ENCRYPTED_SPLIT_PART_LOW_RAM = 64 * 1024 * 1024; // 64 MiB on <3.2 GiB RAM phones
const ANDROID_ENCRYPTED_SPLIT_PART_NORMAL = 128 * 1024 * 1024; // 128 MiB on 4 GB+ RAM phones

function openAndroidStateDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('INDEXEDDB_UNAVAILABLE'));
      return;
    }
    const req = indexedDB.open(ANDROID_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ANDROID_IDB_STORE)) {
        db.createObjectStore(ANDROID_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('INDEXEDDB_OPEN_FAILED'));
  });
}

async function idbGetState<T>(key: string): Promise<T | null> {
  const db = await openAndroidStateDb();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(ANDROID_IDB_STORE, 'readonly');
      const store = tx.objectStore(ANDROID_IDB_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('INDEXEDDB_GET_FAILED'));
    });
  } finally {
    db.close();
  }
}

async function idbSetState<T>(key: string, value: T): Promise<void> {
  const db = await openAndroidStateDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ANDROID_IDB_STORE, 'readwrite');
      const store = tx.objectStore(ANDROID_IDB_STORE);
      store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('INDEXEDDB_SET_FAILED'));
    });
  } finally {
    db.close();
  }
}

async function idbClearState(): Promise<void> {
  const db = await openAndroidStateDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ANDROID_IDB_STORE, 'readwrite');
      tx.objectStore(ANDROID_IDB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('INDEXEDDB_CLEAR_FAILED'));
    });
  } finally {
    db.close();
  }
}

function isTransientAndroidError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/ABORT|CANCEL|FILE_UNREADABLE|VAULT_LOCKED|PASSPHRASE|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|MESSAGE_NOT_FOUND|MEDIA_NOT_FOUND|ENOSPC|No space left/i.test(text)) {
    return false;
  }
  return /TIMEOUT|TIMED_OUT|NETWORK|DISCONNECT|SOCKET|FETCH|RESET|ECONN|EOF|CONNECTION|FLOOD_WAIT|502|503|504|WebSocket|Failed to fetch/i.test(
    text,
  ) || (typeof navigator !== 'undefined' && navigator.onLine === false);
}

async function waitOnlineOrDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('ABORTED');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onOnline = () => finish();
    const onAbort = () => finish(new Error('ABORTED'));
    const timer = window.setTimeout(() => finish(), ms);
    window.addEventListener('online', onOnline, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface AndroidPersistedState {
  deviceId: string;
  apiId: number | null;
  lastUserId?: string | null;
  cachedFilesByFolder?: Record<string, MappedTelegramFile[]>;
  weeklyQuotaBytes?: number;
  hasAuthorizedSession?: boolean;
  folders: Array<{
    id: number;
    name: string;
    group_id: number | null;
    sort_order: number;
    is_hidden: boolean;
    created_at: string;
  }>;
  groups: Array<{
    id: number;
    name: string;
    color_hex: string;
    sort_order: number;
  }>;
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
  storageLimits: Record<string, { previews: number; thumbnails: number; converted: number }>;
  previewCacheMaxGb: number;
  vaultData: {
    vault: PersistedVaultRecord | null;
    settings: VaultStateSettings | null;
    encryptedFiles: EncryptedFileRecord[];
  };
  bandwidth: { uploaded: number; downloaded: number };
  splitManifests?: Record<string, SplitFileManifest>;
  splitUploadCheckpoints?: Record<string, SplitUploadCheckpoint>;
  ultraLowRamNoticeShown?: boolean;
  dataSaverEnabled?: boolean;
}

function folderIdToPeer(folderId: number | null | undefined): 'self' | number {
  if (folderId === null || folderId === undefined || folderId === 0) return 'self';
  return folderId > 0 ? -1000000000000 - folderId : folderId;
}

function fileCompositeKey(folderId: number | null | undefined, messageId: number): string {
  return `${folderId ?? 'saved'}:${messageId}`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class AndroidWebEngine {
  private state: AndroidPersistedState;
  private readonly vault = new VaultRuntime();
  private client: TelegramClient | null = null;
  private currentApiHash: string | null = null;
  private currentUserId: string | null = null;
  private wasmModulePromise: Promise<WebAssembly.Module> | null = null;
  private filesCache = new Map<string, MappedTelegramFile[]>();
  private blobUrlCache = new Map<string, string>();
  private activeAborts = new Map<string, AbortController>();
  private explicitlyCancelledTransfers = new Set<string>();
  private pendingFilesByPath = new Map<string, File>();
  private stateHydratedPromise: Promise<void>;
  private saveDebounceTimer: number | null = null;
  private mobileDataNoticeShownInSession = false;
  private cachedUltraLowRam: boolean | null = null;
  private cachedSystemDataSaver = false;
  private mediaServerPromise: Promise<{ port: number; token: string; baseUrl: string }> | null = null;
  private activeMediaStreamAborts = new Map<string, AbortController>();

  private pendingAuth: {
    phone?: string;
    phoneCodeHash?: string;
    apiId?: number;
    apiHash?: string;
  } = {};

  private qrState: {
    latestUrl: string | null;
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
    needsPassword: false,
    authorized: false,
    error: null,
    abort: null,
  };

  constructor() {
    this.state = this.loadState();
    this.applyHydratedState(this.state);
    this.stateHydratedPromise = this.hydrateStateFromIndexedDb();
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      void navigator.storage.persist().catch(() => undefined);
    }
  }

  private applyHydratedState(next: AndroidPersistedState): void {
    this.state = next;
    if (!this.state.splitManifests) this.state.splitManifests = {};
    if (!this.state.splitUploadCheckpoints) this.state.splitUploadCheckpoints = {};
    this.currentUserId = this.state.lastUserId ?? null;
    this.filesCache.clear();
    const savedFiles = this.state.cachedFilesByFolder ?? {};
    for (const [k, files] of Object.entries(savedFiles)) {
      if (Array.isArray(files)) this.filesCache.set(k, files);
    }
    this.vault.loadPersisted(this.state.vaultData);
  }

  private async hydrateStateFromIndexedDb(): Promise<void> {
    try {
      const idbStored = await idbGetState<Partial<AndroidPersistedState>>(ANDROID_IDB_STATE_KEY);
      if (idbStored && typeof idbStored === 'object') {
        const merged: AndroidPersistedState = {
          ...this.state,
          ...idbStored,
        };
        this.applyHydratedState(merged);
        // Remove legacy oversized localStorage entry once IndexedDB is authoritative
        try {
          localStorage.removeItem(STATE_STORAGE_KEY);
        } catch {
          // ignore
        }
        return;
      }

      // First run after upgrade: migrate existing localStorage state into IndexedDB
      await idbSetState(ANDROID_IDB_STATE_KEY, this.state);
      try {
        localStorage.removeItem(STATE_STORAGE_KEY);
      } catch {
        // ignore
      }
    } catch {
      // Fallback gracefully if IndexedDB is unavailable in restricted environment
    }
  }

  public registerBrowserSelectedFile(pseudoPath: string, file: File): void {
    this.pendingFilesByPath.set(pseudoPath, file);
  }

  private loadState(): AndroidPersistedState {
    const defaults: AndroidPersistedState = {
      deviceId: crypto.randomUUID(),
      apiId: null,
      lastUserId: null,
      cachedFilesByFolder: {},
      weeklyQuotaBytes: 0,
      hasAuthorizedSession: false,
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
      storageLimits: {},
      previewCacheMaxGb: 2,
      vaultData: {
        vault: null,
        settings: null,
        encryptedFiles: [],
      },
      bandwidth: { uploaded: 0, downloaded: 0 },
      splitManifests: {},
      splitUploadCheckpoints: {},
      ultraLowRamNoticeShown: false,
      dataSaverEnabled: false,
    };
    try {
      const bootRaw = localStorage.getItem(STATE_BOOTSTRAP_KEY);
      const legacyRaw = localStorage.getItem(STATE_STORAGE_KEY);
      const parsedBoot = bootRaw ? (JSON.parse(bootRaw) as Partial<AndroidPersistedState>) : {};
      const parsedLegacy = legacyRaw ? (JSON.parse(legacyRaw) as Partial<AndroidPersistedState>) : {};
      return { ...defaults, ...parsedLegacy, ...parsedBoot };
    } catch {
      // ignore
    }
    return defaults;
  }

  private saveState(): void {
    this.state.vaultData = this.vault.exportPersisted();
    const cached: Record<string, MappedTelegramFile[]> = {};
    for (const [k, files] of this.filesCache.entries()) {
      cached[k] = files;
    }
    this.state.cachedFilesByFolder = cached;

    // Write tiny bootstrap metadata to localStorage (~200 bytes — never hits 5 MB limit)
    try {
      localStorage.setItem(
        STATE_BOOTSTRAP_KEY,
        JSON.stringify({
          deviceId: this.state.deviceId,
          apiId: this.state.apiId,
          lastUserId: this.state.lastUserId,
          hasAuthorizedSession: this.state.hasAuthorizedSession,
          ultraLowRamNoticeShown: this.state.ultraLowRamNoticeShown,
          dataSaverEnabled: this.state.dataSaverEnabled,
        }),
      );
    } catch {
      // ignore
    }

    // Persist full unlimited state (folders, cachedFilesByFolder, split manifests, vault) to IndexedDB
    if (this.saveDebounceTimer !== null) {
      window.clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = window.setTimeout(() => {
      this.saveDebounceTimer = null;
      void idbSetState(ANDROID_IDB_STATE_KEY, this.state).catch(() => {
        // Fallback only if IndexedDB fails
        try {
          const slim = { ...this.state, cachedFilesByFolder: {} };
          localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(slim));
        } catch {
          // ignore
        }
      });
    }, 80);
  }

  private async checkEnvironmentForQuietNotices(
    fileSize: number,
    action: 'upload' | 'download' | 'stream',
  ): Promise<void> {
    if (!isAndroidNative()) return;
    try {
      const env = await TelegramDriveNative.getTransferEnvironment();
      this.cachedUltraLowRam = Boolean(env.ultraLowRam);
      this.cachedSystemDataSaver = Boolean(env.systemDataSaver);

      // 1. Silent hardware RAM check: ONLY on <3.2 GiB RAM phones (1-3 GB RAM), ONCE EVER, non-blocking
      if (
        env.ultraLowRam &&
        !this.state.ultraLowRamNoticeShown &&
        fileSize >= 512 * 1024 * 1024
      ) {
        this.state.ultraLowRamNoticeShown = true;
        this.saveState();
        dispatchLocalEvent('quiet-hardware-notice', {
          kind: 'ultra-low-ram',
          deviceRamBytes: env.deviceRamBytes ?? 0,
        });
      }

      // 2. Mobile Data notice: non-Wi-Fi metered connection on large files (>=100 MB), ONCE per session
      if (
        env.connected &&
        !env.wifi_connected &&
        env.metered &&
        !this.mobileDataNoticeShownInSession &&
        fileSize >= 100 * 1024 * 1024
      ) {
        this.mobileDataNoticeShownInSession = true;
        dispatchLocalEvent('quiet-hardware-notice', {
          kind: 'mobile-data',
          action,
          sizeBytes: fileSize,
          dataSaverActive: Boolean(this.state.dataSaverEnabled || env.systemDataSaver),
        });
      }
    } catch {
      // Never block transfers on environment telemetry
    }
  }

  private async isUltraLowRamDevice(): Promise<boolean> {
    if (!isAndroidNative()) return false;
    if (this.cachedUltraLowRam !== null) return this.cachedUltraLowRam;
    try {
      const env = await TelegramDriveNative.getTransferEnvironment();
      this.cachedUltraLowRam = Boolean(env.ultraLowRam);
      this.cachedSystemDataSaver = Boolean(env.systemDataSaver);
      return this.cachedUltraLowRam;
    } catch {
      return false;
    }
  }

  private isEffectiveDataSaver(): boolean {
    return Boolean(this.state.dataSaverEnabled || this.cachedSystemDataSaver);
  }

  private async runWithTransientRetry<T>(
    transferId: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      if (signal.aborted || this.explicitlyCancelledTransfers.has(transferId)) {
        throw new Error('ABORTED');
      }
      try {
        return await fn();
      } catch (err) {
        if (
          signal.aborted ||
          this.explicitlyCancelledTransfers.has(transferId) ||
          !isTransientAndroidError(err) ||
          attempt >= 4
        ) {
          throw err;
        }
        attempt += 1;
        const backoffMs = Math.min(20_000, 1500 * Math.pow(2, attempt - 1));
        await waitOnlineOrDelay(backoffMs, signal);
      }
    }
  }

  private async ensureSplitManifestLoaded(
    folderId: number | null,
    messageId: number,
    existingMsg?: Message,
  ): Promise<SplitFileManifest | null> {
    const key = fileCompositeKey(folderId, messageId);
    const cached = this.state.splitManifests?.[key];
    if (cached && cached.parts.length > 0) {
      return cached;
    }

    const msg = existingMsg ?? (await this.fetchMessage(folderId, messageId));
    const parsedHeader = parseSplitManifestFromMessage(msg);
    if (!parsedHeader) return null;

    if (parsedHeader.inlineManifest && parsedHeader.inlineManifest.parts.length === parsedHeader.header.count) {
      if (!this.state.splitManifests) this.state.splitManifests = {};
      this.state.splitManifests[key] = parsedHeader.inlineManifest;
      this.saveState();
      return parsedHeader.inlineManifest;
    }

    if (msg.media) {
      const client = await this.ensureClient();
      const bytes = await client.downloadAsBuffer(
        msg.media as Parameters<TelegramClient['downloadAsBuffer']>[0],
      );
      const docParsed = parseSplitManifestJsonBytes(bytes);
      if (docParsed && docParsed.parts.length > 0) {
        if (!this.state.splitManifests) this.state.splitManifests = {};
        this.state.splitManifests[key] = docParsed;
        this.saveState();
        return docParsed;
      }
    }
    return parsedHeader.inlineManifest;
  }

  private async deleteSplitAwareMessage(folderId: number | null, messageId: number): Promise<void> {
    const client = await this.ensureClient();
    const peer = folderIdToPeer(folderId);
    const key = fileCompositeKey(folderId, messageId);
    let manifest: SplitFileManifest | null = this.state.splitManifests?.[key] ?? null;
    if (!manifest) {
      try {
        manifest = await this.ensureSplitManifestLoaded(folderId, messageId);
      } catch {
        manifest = null;
      }
    }

    const idsToDelete: number[] = [];
    if (manifest && manifest.parts.length > 0) {
      for (const p of manifest.parts) {
        if (p.id > 0) idsToDelete.push(p.id);
      }
    }
    idsToDelete.push(messageId);

    for (let i = 0; i < idsToDelete.length; i += 100) {
      const batch = idsToDelete.slice(i, i + 100);
      await client.deleteMessagesById(peer, batch, { revoke: true });
    }

    if (this.state.splitManifests && key in this.state.splitManifests) {
      delete this.state.splitManifests[key];
      this.saveState();
    }
  }

  private async streamAndroidByteRange(
    folderId: number | null,
    messageId: number,
    startByte: number,
    endByte: number,
    onChunk: (chunk: Uint8Array) => Promise<boolean | void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = await this.ensureClient();
    const manifest = await this.ensureSplitManifestLoaded(folderId, messageId);

    if (manifest && manifest.parts.length > 0) {
      const slices = resolveRangeAcrossParts(manifest.parts, startByte, endByte);
      for (const slice of slices) {
        if (signal?.aborted) break;
        const partMsg = await this.fetchMessage(folderId, slice.messageId);
        if (!partMsg.media) throw new Error('SPLIT_PART_MEDIA_MISSING');

        const sliceLen = slice.partLocalEndInclusive - slice.partLocalStart + 1;
        const alignedOffset = Math.floor(slice.partLocalStart / 4096) * 4096;
        let skipBytes = slice.partLocalStart - alignedOffset;
        let remaining = sliceLen;
        const alignedLimit = Math.ceil((skipBytes + remaining) / 4096) * 4096;

        for await (const rawChunk of client.downloadAsIterable(
          partMsg.media as Parameters<TelegramClient['downloadAsIterable']>[0],
          {
            offset: alignedOffset,
            limit: alignedLimit,
            partSize: 512,
            abortSignal: signal,
          },
        )) {
          if (signal?.aborted) break;
          let buf: Uint8Array = rawChunk;
          if (skipBytes > 0) {
            if (buf.byteLength <= skipBytes) {
              skipBytes -= buf.byteLength;
              continue;
            }
            buf = buf.subarray(skipBytes);
            skipBytes = 0;
          }
          if (buf.byteLength > remaining) {
            buf = buf.subarray(0, remaining);
          }
          if (buf.byteLength > 0) {
            remaining -= buf.byteLength;
            this.state.bandwidth.downloaded += buf.byteLength;
            const keepGoing = await onChunk(buf);
            if (keepGoing === false) return;
          }
          if (remaining <= 0) break;
        }
      }
      return;
    }

    const msg = await this.fetchMessage(folderId, messageId);
    if (!msg.media) throw new Error('MEDIA_NOT_FOUND');
    const alignedOffset = Math.floor(startByte / 4096) * 4096;
    let skipBytes = startByte - alignedOffset;
    let remaining = endByte - startByte + 1;
    const alignedLimit = Math.ceil((skipBytes + remaining) / 4096) * 4096;

    for await (const rawChunk of client.downloadAsIterable(
      msg.media as Parameters<TelegramClient['downloadAsIterable']>[0],
      {
        offset: alignedOffset,
        limit: alignedLimit,
        partSize: 512,
        abortSignal: signal,
      },
    )) {
      if (signal?.aborted) break;
      let buf: Uint8Array = rawChunk;
      if (skipBytes > 0) {
        if (buf.byteLength <= skipBytes) {
          skipBytes -= buf.byteLength;
          continue;
        }
        buf = buf.subarray(skipBytes);
        skipBytes = 0;
      }
      if (buf.byteLength > remaining) {
        buf = buf.subarray(0, remaining);
      }
      if (buf.byteLength > 0) {
        remaining -= buf.byteLength;
        this.state.bandwidth.downloaded += buf.byteLength;
        const keepGoing = await onChunk(buf);
        if (keepGoing === false) return;
      }
      if (remaining <= 0) break;
    }
  }

  private async ensureAndroidMediaServer(): Promise<{ port: number; token: string; baseUrl: string }> {
    if (!this.mediaServerPromise) {
      this.mediaServerPromise = (async () => {
        await TelegramDriveNative.addListener('mediaStreamRequest', (ev: MediaStreamRequestEvent) => {
          void this.handleAndroidMediaStreamRequest(ev);
        });
        await TelegramDriveNative.addListener('mediaStreamAbort', ({ reqId }) => {
          this.activeMediaStreamAborts.get(reqId)?.abort();
          this.activeMediaStreamAborts.delete(reqId);
        });
        return await TelegramDriveNative.startLocalMediaServer();
      })();
    }
    return this.mediaServerPromise;
  }

  private async handleAndroidMediaStreamRequest(ev: MediaStreamRequestEvent): Promise<void> {
    const abort = new AbortController();
    this.activeMediaStreamAborts.set(ev.reqId, abort);
    try {
      const folderId =
        ev.folder === 'home' || ev.folder === 'saved' || ev.folder === '0'
          ? null
          : Number.parseInt(ev.folder, 10);
      const messageId = Number(ev.messageId);
      const manifest = await this.ensureSplitManifestLoaded(folderId, messageId);
      let totalSize = 0;
      let mimeType = 'application/octet-stream';

      if (manifest) {
        totalSize = manifest.totalSize;
        mimeType = manifest.mime || guessMimeType(manifest.name);
      } else {
        const msg = await this.fetchMessage(folderId, messageId);
        const key = fileCompositeKey(folderId, messageId);
        const mapped = mapMessageToTelegramFile(msg, folderId, {
          customName: this.state.fileRenames[key],
          encryptedRecord: this.vault.getEncryptedFileRecord(key),
          vaultUnlocked: this.vault.getStatus().is_unlocked,
        });
        totalSize = mapped?.size || ((msg.media as unknown as { fileSize?: number })?.fileSize ?? 0);
        mimeType = mapped?.mime_type || guessMimeType(mapped?.name ?? '');
      }

      if (totalSize > 0) {
        void this.checkEnvironmentForQuietNotices(totalSize, 'stream');
      }

      if (totalSize <= 0) {
        await TelegramDriveNative.respondMediaStreamHeader({
          reqId: ev.reqId,
          status: 404,
          mimeType,
          totalSize: 0,
          start: 0,
          end: 0,
          acceptRanges: true,
        });
        return;
      }

      const rangeText = (ev.range || '').trim();
      let status = 200;
      let start = 0;
      let end = totalSize - 1;

      if (rangeText.startsWith('bytes=')) {
        status = 206;
        const spec = rangeText.slice(6).split(',')[0].trim();
        const [startStr, endStr] = spec.split('-');
        if (startStr === '' && endStr) {
          const suffixLen = Number.parseInt(endStr, 10);
          start = Math.max(0, totalSize - (Number.isFinite(suffixLen) ? suffixLen : 65536));
          end = totalSize - 1;
        } else {
          start = Number.parseInt(startStr, 10) || 0;
          if (endStr && endStr.trim() !== '') {
            end = Math.min(totalSize - 1, Number.parseInt(endStr, 10));
          } else {
            // Cap open-ended Range window to keep Mobile Data & RAM lean (players auto-request next range)
            const windowBytes = this.isEffectiveDataSaver()
              ? 2 * 1024 * 1024
              : 16 * 1024 * 1024;
            end = Math.min(totalSize - 1, start + windowBytes - 1);
          }
        }
      }

      if (start < 0 || start >= totalSize || end < start) {
        await TelegramDriveNative.respondMediaStreamHeader({
          reqId: ev.reqId,
          status: 416,
          mimeType,
          totalSize,
          start: 0,
          end: 0,
          acceptRanges: true,
        });
        return;
      }

      await TelegramDriveNative.respondMediaStreamHeader({
        reqId: ev.reqId,
        status,
        mimeType,
        totalSize,
        start,
        end,
        acceptRanges: true,
      });

      if (ev.method === 'HEAD') {
        await TelegramDriveNative.endMediaStream({ reqId: ev.reqId });
        return;
      }

      await this.streamAndroidByteRange(
        folderId,
        messageId,
        start,
        end,
        async chunk => {
          if (abort.signal.aborted) return false;
          const res = await TelegramDriveNative.pushMediaStreamChunk({
            reqId: ev.reqId,
            data: uint8ToBase64(chunk),
          });
          if (res.closed) {
            abort.abort();
            return false;
          }
          return true;
        },
        abort.signal,
      );

      await TelegramDriveNative.endMediaStream({ reqId: ev.reqId });
    } catch (err) {
      await TelegramDriveNative.endMediaStream({
        reqId: ev.reqId,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    } finally {
      this.activeMediaStreamAborts.delete(ev.reqId);
    }
  }

  private createNativeChunkReadableStream(
    nativePath: string,
    sliceOffset: number,
    sliceLength: number,
    signal: AbortSignal,
  ): ReadableStream<Uint8Array> {
    let cursor = 0;
    const chunkSize = 1024 * 1024; // 1 MiB low-RAM native bridge slices
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal.aborted) {
          controller.error(new Error('ABORTED'));
          return;
        }
        const remaining = sliceLength - cursor;
        if (remaining <= 0) {
          controller.close();
          return;
        }
        const toRead = Math.min(chunkSize, remaining);
        const res = await TelegramDriveNative.readFileChunkBase64({
          path: nativePath,
          offset: sliceOffset + cursor,
          length: toRead,
        });
        if (!res.bytesRead || !res.data) {
          controller.close();
          return;
        }
        const bytes = base64ToUint8(res.data);
        cursor += bytes.byteLength;
        controller.enqueue(bytes);
        if (cursor >= sliceLength) {
          controller.close();
        }
      },
    });
  }

  private async readSliceIntoUint8(
    browserFile: File | undefined,
    nativePath: string,
    sliceOffset: number,
    sliceLength: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (browserFile) {
      const buf = await browserFile.slice(sliceOffset, sliceOffset + sliceLength).arrayBuffer();
      return new Uint8Array(buf);
    }
    const out = new Uint8Array(sliceLength);
    let cursor = 0;
    const step = 1024 * 1024;
    while (cursor < sliceLength) {
      if (signal.aborted) throw new Error('ABORTED');
      const toRead = Math.min(step, sliceLength - cursor);
      const res = await TelegramDriveNative.readFileChunkBase64({
        path: nativePath,
        offset: sliceOffset + cursor,
        length: toRead,
      });
      if (!res.bytesRead || !res.data) break;
      const chunk = base64ToUint8(res.data);
      out.set(chunk.subarray(0, Math.min(chunk.byteLength, sliceLength - cursor)), cursor);
      cursor += chunk.byteLength;
    }
    return cursor === sliceLength ? out : out.subarray(0, cursor);
  }

  private async performAndroidSplitUpload(params: {
    transferId: string;
    rawPath: string;
    browserFile?: File;
    folderId: number | null;
    originalName: string;
    originalSize: number;
    lastModifiedMs: number;
    isEncrypted: boolean;
    protectionMode?: string;
    promptToken?: number;
    protectMetadata: boolean;
    abort: AbortController;
  }): Promise<number> {
    const {
      transferId,
      rawPath,
      browserFile,
      folderId,
      originalName,
      originalSize,
      lastModifiedMs,
      isEncrypted,
      protectionMode,
      promptToken,
      protectMetadata,
      abort,
    } = params;

    const client = await this.ensureClient();
    const peer = folderIdToPeer(folderId);
    const originalMime = guessMimeType(originalName);
    const ultraLowRam = isEncrypted ? await this.isUltraLowRamDevice() : false;
    const partSizeLimit = isEncrypted
      ? ultraLowRam
        ? ANDROID_ENCRYPTED_SPLIT_PART_LOW_RAM
        : ANDROID_ENCRYPTED_SPLIT_PART_NORMAL
      : SPLIT_PART_SIZE_BYTES;

    const partPlans = computeSplitPartPlan(originalSize, partSizeLimit);
    const partCount = partPlans.length;

    const resolvedPassphrase =
      isEncrypted && protectionMode === 'passphrase' && promptToken !== undefined
        ? this.vault.consumeStagedPassphrase(promptToken)
        : undefined;
    if (isEncrypted && protectionMode === 'passphrase' && !resolvedPassphrase) {
      throw new Error('PASSPHRASE_PROMPT_REQUIRED');
    }

    const checkpointKey = `${folderId ?? 'saved'}:${rawPath}:${originalSize}:${lastModifiedMs}:${isEncrypted ? (protectionMode ?? 'vault') : 'plain'}`;
    if (!this.state.splitUploadCheckpoints) this.state.splitUploadCheckpoints = {};

    let checkpoint = this.state.splitUploadCheckpoints[checkpointKey];
    if (checkpoint && checkpoint.partSize === partSizeLimit && checkpoint.totalSize === originalSize) {
      const doneIds = Object.values(checkpoint.completedParts).map(p => p.messageId);
      if (doneIds.length > 0) {
        try {
          const msgs = await client.getMessages(peer, doneIds.slice(0, 100));
          const existingSet = new Set(msgs.filter((m): m is Message => Boolean(m)).map(m => m.id));
          for (const [idxStr, meta] of Object.entries(checkpoint.completedParts)) {
            if (!existingSet.has(meta.messageId)) {
              delete checkpoint.completedParts[Number(idxStr)];
            }
          }
        } catch {
          // Keep existing checkpoint on transient error
        }
      }
    } else {
      checkpoint = {
        fingerprint: checkpointKey,
        groupId: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        fileName: originalName,
        folderId,
        totalSize: originalSize,
        partSize: partSizeLimit,
        completedParts: {},
        updatedAt: Date.now(),
      };
      this.state.splitUploadCheckpoints[checkpointKey] = checkpoint;
      this.saveState();
    }

    const groupId = checkpoint.groupId;
    dispatchLocalEvent('split-file-notice', {
      id: transferId,
      fileName: originalName,
      totalBytes: originalSize,
      partCount,
    });

    const t0 = Date.now();
    let vaultId: string | undefined;

    for (const plan of partPlans) {
      if (abort.signal.aborted) throw new Error('ABORTED');
      if (checkpoint.completedParts[plan.index]) continue;

      const completedPlainBefore = partPlans
        .slice(0, plan.index)
        .reduce((acc, p) => acc + p.size, 0);

      await this.runWithTransientRetry(transferId, abort.signal, async () => {
        const partName = buildSplitPartFileName(groupId, plan.index, partCount);
        let uploadedPartSize = plan.size;

        let uploadInput: Blob | Uint8Array | ReadableStream<Uint8Array>;
        if (!isEncrypted) {
          uploadInput = browserFile
            ? browserFile.slice(plan.offset, plan.offset + plan.size)
            : this.createNativeChunkReadableStream(
                rawPath,
                plan.offset,
                plan.size,
                abort.signal,
              );
        } else {
          const plainSlice = await this.readSliceIntoUint8(
            browserFile,
            rawPath,
            plan.offset,
            plan.size,
            abort.signal,
          );
          const enc = this.vault.encryptBuffer(plainSlice, {
            mode: protectionMode === 'passphrase' ? 'passphrase' : 'vault',
            passphrase: resolvedPassphrase,
            originalName: `${originalName}.part${plan.index + 1}`,
            originalMime: 'application/octet-stream',
            protectMetadata: true,
          });
          vaultId = enc.vaultId;
          uploadedPartSize = enc.ciphertext.byteLength;
          uploadInput = enc.ciphertext;
        }

        const uploaded = await client.uploadFile({
          file: uploadInput as unknown as Parameters<TelegramClient['uploadFile']>[0]['file'],
          fileName: partName,
          fileSize: uploadedPartSize,
          fileMime: 'application/octet-stream',
          partSize: 512,
          abortSignal: abort.signal,
          progressCallback: (done, tot) => {
            const frac = tot > 0 ? Math.min(1, done / tot) : 0;
            const overallDone = Math.min(
              originalSize,
              completedPlainBefore + Math.round(frac * plan.size),
            );
            const speed = Math.round(overallDone / Math.max(0.1, (Date.now() - t0) / 1000));
            dispatchLocalEvent('upload-progress', {
              id: transferId,
              progress: Math.min(99, Math.round((overallDone / originalSize) * 100)),
              uploaded_bytes: overallDone,
              total_bytes: originalSize,
              speed_bytes_per_sec: speed,
              part_index: plan.index + 1,
              part_count: partCount,
            });
          },
        });

        const partCaption = buildSplitPartCaption(groupId, plan.index, partCount, uploadedPartSize);
        const sentPart = await client.sendMedia(peer, {
          type: 'document',
          file: uploaded,
          fileName: partName,
          caption: partCaption,
        });

        this.state.bandwidth.uploaded += uploadedPartSize;
        checkpoint.completedParts[plan.index] = {
          messageId: sentPart.id,
          size: uploadedPartSize,
        };
        checkpoint.updatedAt = Date.now();
        this.saveState();
      });
    }

    const orderedParts: SplitPartDescriptor[] = partPlans.map(p => {
      const saved = checkpoint.completedParts[p.index];
      if (!saved) throw new Error(`SPLIT_PART_MISSING_${p.index}`);
      return { id: saved.messageId, size: saved.size };
    });

    const manifestPayload: SplitFileManifest = {
      v: 1,
      groupId,
      name: originalName,
      mime: originalMime,
      totalSize: originalSize,
      partSize: partSizeLimit,
      parts: orderedParts,
      createdAt: new Date().toISOString(),
      ...(isEncrypted
        ? {
            encrypted: {
              mode: protectionMode === 'passphrase' ? 'passphrase' : 'vault',
              vaultId,
              protectMetadata,
            },
          }
        : {}),
    };

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestPayload));
    const manifestName = buildSplitManifestFileName(groupId);
    const manifestCaption = buildSplitManifestCaption(manifestPayload);

    const sentManifest = await this.runWithTransientRetry(transferId, abort.signal, async () => {
      const uploadedManifest = await client.uploadFile({
        file: manifestBytes,
        fileName: manifestName,
        fileSize: manifestBytes.byteLength,
        fileMime: 'application/json',
        abortSignal: abort.signal,
      });
      return await client.sendMedia(peer, {
        type: 'document',
        file: uploadedManifest,
        fileName: manifestName,
        caption: manifestCaption,
      });
    });

    const finalKey = fileCompositeKey(folderId, sentManifest.id);
    if (!this.state.splitManifests) this.state.splitManifests = {};
    this.state.splitManifests[finalKey] = manifestPayload;
    delete this.state.splitUploadCheckpoints[checkpointKey];

    if (isEncrypted) {
      this.vault.registerEncryptedFile({
        key: finalKey,
        mode: protectionMode === 'passphrase' ? 'passphrase' : 'vault',
        vaultId,
        originalName,
        originalSize,
        protectMetadata,
      });
    }
    this.saveState();

    dispatchLocalEvent('upload-progress', {
      id: transferId,
      progress: 100,
      uploaded_bytes: originalSize,
      total_bytes: originalSize,
      speed_bytes_per_sec: 0,
      part_index: partCount,
      part_count: partCount,
    });
    return sentManifest.id;
  }

  private async storeSecret(key: string, value: string): Promise<void> {
    if (isAndroidNative()) {
      await TelegramDriveNative.secureSet({ key, value });
      return;
    }
    localStorage.setItem(`td_sec_${key}`, value);
  }

  private async loadSecret(key: string): Promise<string | null> {
    if (isAndroidNative()) {
      const res = await TelegramDriveNative.secureGet({ key });
      return res.value ?? null;
    }
    return localStorage.getItem(`td_sec_${key}`);
  }

  private async removeSecret(key: string): Promise<void> {
    if (isAndroidNative()) {
      await TelegramDriveNative.secureRemove({ key });
      return;
    }
    localStorage.removeItem(`td_sec_${key}`);
  }

  private async getWasmModule(): Promise<WebAssembly.Module> {
    if (!this.wasmModulePromise) {
      this.wasmModulePromise = (async () => {
        const res = await fetch(mtcuteWasmUrl);
        if (!res.ok) {
          throw new Error(`Failed to load mtcute.wasm (${res.status})`);
        }
        const buf = await res.arrayBuffer();
        return WebAssembly.compile(buf);
      })().catch(err => {
        this.wasmModulePromise = null;
        throw err;
      });
    }
    return this.wasmModulePromise;
  }

  private async ensureClient(apiId?: number, apiHash?: string): Promise<TelegramClient> {
    const resolvedId = apiId ?? this.state.apiId ?? this.pendingAuth.apiId ?? 0;
    const resolvedHash =
      apiHash || (await this.loadSecret('api_hash')) || this.pendingAuth.apiHash || '';

    if (!resolvedId || !resolvedHash) {
      throw new Error('API_CREDENTIALS_MISSING');
    }

    if (this.client && this.state.apiId === resolvedId && this.currentApiHash === resolvedHash) {
      return this.client;
    }

    if (this.client) {
      await this.client.destroy().catch(() => undefined);
      this.client = null;
      this.currentApiHash = null;
    }

    this.state.apiId = resolvedId;
    this.saveState();

    const wasmModule = await this.getWasmModule();
    const baseClient = new BaseTelegramClient({
      apiId: resolvedId,
      apiHash: resolvedHash,
      storage: new IdbStorage('telegram-drive-mtproto-session'),
      storageOptions: {
        saveInterval: 1000,
      },
      updates: false,
      crypto: new WebCryptoProvider({ wasmInput: wasmModule }),
      transport: new WebSocketTransport(),
      platform: new WebPlatform(),
      initConnectionOptions: {
        deviceModel: 'Telegram Drive Android',
        systemVersion: 'Android',
        appVersion: '1.0',
        systemLangCode: navigator.language.split('-')[0] || 'en',
        langCode: navigator.language.split('-')[0] || 'en',
      },
    });

    this.client = new TelegramClient({
      client: baseClient,
      disableUpdates: true,
    });
    this.currentApiHash = resolvedHash;
    return this.client;
  }

  private async getOwnerId(): Promise<string> {
    if (this.currentUserId) return this.currentUserId;
    if (this.state.lastUserId) {
      this.currentUserId = this.state.lastUserId;
      return this.currentUserId;
    }
    throw new Error('NOT_CONNECTED');
  }

  private async fetchMessage(folderId: number | null, messageId: number): Promise<Message> {
    const client = await this.ensureClient();
    const msgs = await client.getMessages(folderIdToPeer(folderId), [messageId]);
    if (!msgs[0]) throw new Error('MESSAGE_NOT_FOUND');
    return msgs[0];
  }

  private async downloadRawBytes(
    folderId: number | null,
    messageId: number,
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const msg = await this.fetchMessage(folderId, messageId);
    if (!msg.media) throw new Error('MEDIA_NOT_FOUND');
    const total = ((msg.media as unknown as { fileSize?: number }).fileSize ?? 0);
    const client = await this.ensureClient();
    const chunks: Uint8Array[] = [];
    let done = 0;

    for await (const chunk of client.downloadAsIterable(
      msg.media as Parameters<TelegramClient['downloadAsIterable']>[0],
      { partSize: 512, abortSignal: signal },
    )) {
      chunks.push(chunk);
      done += chunk.byteLength;
      this.state.bandwidth.downloaded += chunk.byteLength;
      onProgress?.(done, total || done);
    }

    const merged = new Uint8Array(done);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  }

  private async listFiles(
    folderId: number | null,
    onChunk?: (chunk: MappedTelegramFile[]) => void,
  ): Promise<MappedTelegramFile[]> {
    const client = await this.ensureClient();
    const peer = folderIdToPeer(folderId);
    const out: MappedTelegramFile[] = [];
    const vaultUnlocked = this.vault.getStatus().is_unlocked;
    let offset: { id: number; date: number } | undefined;
    let splitCacheDirty = false;

    for (let page = 0; page < 4; page++) {
      const history = await client.getHistory(peer, { limit: 100, offset });
      if (history.length === 0) break;
      const pageFiles: MappedTelegramFile[] = [];
      for (const msg of history) {
        if (isSplitPartMessage(msg)) continue;

        const key = fileCompositeKey(folderId, msg.id);
        const parsedSplit = parseSplitManifestFromMessage(msg);
        if (parsedSplit) {
          let manifest = this.state.splitManifests?.[key] ?? parsedSplit.inlineManifest;
          if (!manifest) {
            manifest = await this.ensureSplitManifestLoaded(folderId, msg.id, msg);
          } else if (!this.state.splitManifests?.[key]) {
            if (!this.state.splitManifests) this.state.splitManifests = {};
            this.state.splitManifests[key] = manifest;
            splitCacheDirty = true;
          }

          const mappedSplit = mapSplitManifestToTelegramFile(
            msg,
            folderId,
            parsedSplit.header,
            manifest ?? undefined,
            {
              customName: this.state.fileRenames[key],
              favorite: this.state.favorites.includes(key),
              encryptedRecord: this.vault.getEncryptedFileRecord(key),
              vaultUnlocked,
            },
          );
          out.push(mappedSplit);
          pageFiles.push(mappedSplit);
          continue;
        }

        const mapped = mapMessageToTelegramFile(msg, folderId, {
          customName: this.state.fileRenames[key],
          favorite: this.state.favorites.includes(key),
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
    if (splitCacheDirty || out.length >= 0) {
      this.saveState();
    }
    return out;
  }

  private collectWorkspaceFiles(ownerId: string) {
    const folderNames = new Map(this.state.folders.map(f => [f.id, f.name]));
    const out: Array<MappedTelegramFile & { key: string; folderName: string; tags: string[]; collectionIds: string[] }> = [];
    for (const [fKey, list] of this.filesCache.entries()) {
      const folderId = fKey === 'saved' ? null : Number.parseInt(fKey, 10);
      const folderName = folderId === null ? 'Saved Messages' : (folderNames.get(folderId) ?? `Folder ${folderId}`);
      for (const file of list) {
        const key = fileCompositeKey(folderId, file.id);
        out.push({
          ...file,
          key,
          folder_id: folderId,
          folderName,
          is_favorite: this.state.favorites.includes(key),
          tags: this.state.fileTags[`${ownerId}:${key}`] ?? [],
          collectionIds: this.state.fileCollections[`${ownerId}:${key}`] ?? [],
        });
      }
    }
    return out;
  }

  public async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.stateHydratedPromise;
    switch (cmd) {
      case 'cmd_get_startup_health':
        return { ok: true, streaming_port: 14201 };

      case 'cmd_set_data_saver_mode': {
        this.state.dataSaverEnabled = Boolean(args.enabled);
        this.saveState();
        return { enabled: this.state.dataSaverEnabled };
      }

      case 'cmd_get_android_capabilities': {
        if (isAndroidNative()) {
          const env = await TelegramDriveNative.getTransferEnvironment().catch(() => null);
          if (env) {
            this.cachedUltraLowRam = Boolean(env.ultraLowRam);
            this.cachedSystemDataSaver = Boolean(env.systemDataSaver);
          }
          return {
            ultraLowRam: Boolean(env?.ultraLowRam),
            deviceRamBytes: env?.deviceRamBytes ?? 0,
            systemDataSaver: Boolean(env?.systemDataSaver),
            effectiveDataSaver: Boolean(this.state.dataSaverEnabled || env?.systemDataSaver),
            metered: Boolean(env?.metered && !env?.wifi_connected),
          };
        }
        return {
          ultraLowRam: false,
          deviceRamBytes: 0,
          systemDataSaver: false,
          effectiveDataSaver: Boolean(this.state.dataSaverEnabled),
          metered: false,
        };
      }

      case 'cmd_check_network_reachable':
      case 'cmd_check_android_network':
        return navigator.onLine !== false;

      case 'cmd_store_api_hash':
        await this.storeSecret('api_hash', String(args.apiHash ?? '').trim());
        return null;
      case 'cmd_load_api_hash':
        return await this.loadSecret('api_hash');
      case 'cmd_clear_api_hash':
        await this.removeSecret('api_hash');
        this.currentApiHash = null;
        return null;

      case 'cmd_get_saved_session_info': {
        const hasApiHash = Boolean(await this.loadSecret('api_hash'));
        return {
          apiId: this.state.apiId,
          hasApiHash,
          hasSession: Boolean(this.state.hasAuthorizedSession),
          lastUserId: this.state.lastUserId ?? null,
        };
      }

      case 'cmd_connect':
        await this.ensureClient(Number(args.apiId || this.state.apiId || 0));
        return true;

      case 'cmd_check_connection': {
        try {
          if (this.state.hasAuthorizedSession === false && !this.currentUserId) {
            return false;
          }
          const client = await this.ensureClient();
          const me = await client.getMe();
          this.currentUserId = String(me.id);
          this.state.lastUserId = this.currentUserId;
          this.state.hasAuthorizedSession = true;
          this.saveState();
          return true;
        } catch (err) {
          const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
          if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_DUPLICATED|USER_DEACTIVATED|SESSION_REVOKED|SESSION_EXPIRED/i.test(text)) {
            this.currentUserId = null;
            this.state.lastUserId = null;
            this.state.hasAuthorizedSession = false;
            this.saveState();
            return false;
          }
          if (this.state.hasAuthorizedSession && this.state.lastUserId) {
            this.currentUserId = this.state.lastUserId;
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
        if (apiHash) await this.storeSecret('api_hash', apiHash);
        const client = await this.ensureClient(apiId, apiHash);
        const res = await client.sendCode({ phone });
        if (res instanceof User) {
          this.currentUserId = String(res.id);
          this.state.lastUserId = this.currentUserId;
          this.state.hasAuthorizedSession = true;
          this.saveState();
          return { status: 'authorized', delivery: 'telegram_app', numericCode: true };
        }
        this.pendingAuth.phoneCodeHash = (res as SentCode).phoneCodeHash;
        return mapSentCodeResult(res as SentCode);
      }

      case 'cmd_auth_resend_code': {
        const client = await this.ensureClient();
        const res = await client.resendCode({
          phone: this.pendingAuth.phone!,
          phoneCodeHash: this.pendingAuth.phoneCodeHash!,
        });
        this.pendingAuth.phoneCodeHash = res.phoneCodeHash;
        return mapSentCodeResult(res);
      }

      case 'cmd_auth_cancel_code':
        this.pendingAuth = {};
        return null;

      case 'cmd_auth_sign_in': {
        const client = await this.ensureClient();
        if (!this.pendingAuth.phone || !this.pendingAuth.phoneCodeHash) {
          throw new Error('NO_ACTIVE_CODE_REQUEST');
        }
        try {
          const user = await client.signIn({
            phone: this.pendingAuth.phone,
            phoneCodeHash: this.pendingAuth.phoneCodeHash,
            phoneCode: String(args.code ?? '').trim(),
          });
          this.currentUserId = String(user.id);
          this.state.lastUserId = this.currentUserId;
          this.state.hasAuthorizedSession = true;
          this.saveState();
          return { success: true };
        } catch (err) {
          if (String(err).includes('SESSION_PASSWORD_NEEDED') || String(err).toLowerCase().includes('password')) {
            return { success: false, next_step: 'password' };
          }
          throw err;
        }
      }

      case 'cmd_auth_check_password': {
        const pw = String(args.password ?? '');
        if (this.qrState.needsPassword && this.qrState.providePassword) {
          const providePw = this.qrState.providePassword;
          this.qrState.providePassword = undefined;
          this.qrState.needsPassword = false;
          const verified = new Promise<void>((resolve, reject) => {
            this.qrState.pendingPasswordResult = { resolve, reject };
          });
          providePw(pw);
          await verified;
          return { success: true };
        }
        const client = await this.ensureClient();
        const user = await client.checkPassword(pw);
        this.currentUserId = String(user.id);
        this.state.lastUserId = this.currentUserId;
        this.state.hasAuthorizedSession = true;
        this.saveState();
        return { success: true };
      }

      case 'cmd_auth_qr_login': {
        const apiId = Number(args.apiId || this.state.apiId || 0);
        const apiHash = String(args.apiHash ?? '').trim() || (await this.loadSecret('api_hash')) || '';
        if (apiHash) await this.storeSecret('api_hash', apiHash);
        this.qrState.abort?.abort();
        const abort = new AbortController();
        this.qrState = {
          latestUrl: null,
          needsPassword: false,
          authorized: false,
          error: null,
          abort,
        };
        const client = await this.ensureClient(apiId, apiHash);
        return await new Promise<string>((resolve, reject) => {
          let settledFirstUrl = false;
          const timer = window.setTimeout(() => {
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
              dispatchLocalEvent('qr-auth-update', {
                status: 'url',
                url,
                expiresAt: expiresAt.getTime(),
              });
              if (!settledFirstUrl) {
                settledFirstUrl = true;
                window.clearTimeout(timer);
                resolve(url);
              }
            },
            onQrScanned: () => {
              dispatchLocalEvent('qr-auth-update', { status: 'scanned' });
            },
            password: () =>
              new Promise<string>(resPw => {
                this.qrState.needsPassword = true;
                this.qrState.providePassword = resPw;
                dispatchLocalEvent('qr-auth-update', { status: 'password_required' });
              }),
            invalidPasswordCallback: () => {
              const pending = this.qrState.pendingPasswordResult;
              this.qrState.pendingPasswordResult = undefined;
              this.qrState.needsPassword = true;
              pending?.reject(new Error('PASSWORD_HASH_INVALID'));
            },
          })
            .then(user => {
              this.currentUserId = String(user.id);
              this.state.lastUserId = this.currentUserId;
              this.state.hasAuthorizedSession = true;
              this.saveState();
              this.qrState.authorized = true;
              dispatchLocalEvent('qr-auth-update', { status: 'authorized' });
              const pending = this.qrState.pendingPasswordResult;
              this.qrState.pendingPasswordResult = undefined;
              pending?.resolve();
            })
            .catch(err => {
              window.clearTimeout(timer);
              if (abort.signal.aborted) return;
              const normalized = err instanceof Error ? err : new Error(String(err));
              this.qrState.error = normalized.message;
              dispatchLocalEvent('qr-auth-update', {
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
      }

      case 'cmd_auth_qr_cancel': {
        this.qrState.abort?.abort();
        this.qrState.abort = null;
        return null;
      }

      case 'cmd_auth_qr_poll':
        if (this.qrState.authorized) return { success: true };
        if (this.qrState.needsPassword) return { success: true, next_step: 'password' };
        if (this.qrState.error) throw new Error(this.qrState.error);
        return { success: false, url: this.qrState.latestUrl };

      case 'cmd_logout': {
        let revoked = false;
        this.qrState.abort?.abort();
        if (this.client) {
          try {
            await this.client.logOut();
            revoked = true;
          } catch {
            // ignore offline error
          }
          await this.client.destroy().catch(() => undefined);
          this.client = null;
          this.currentApiHash = null;
        }
        this.currentUserId = null;
        this.state.lastUserId = null;
        this.state.cachedFilesByFolder = {};
        this.state.splitManifests = {};
        this.state.splitUploadCheckpoints = {};
        this.filesCache.clear();
        this.state.hasAuthorizedSession = false;
        await idbClearState().catch(() => undefined);
        this.saveState();
        this.vault.lock();
        return { signed_out: true, remote_session_revoked: revoked };
      }

      case 'cmd_workspace_account':
        return await this.getOwnerId();

      // ── Folders & Groups ───────────────────────────────────────────
      case 'cmd_scan_folders': {
        const client = await this.ensureClient();
        for await (const dialog of client.iterDialogs({ archived: 'keep', limit: 300 })) {
          const peer = dialog.peer;
          if (peer.type === 'chat' && (peer.chatType === 'channel' || peer.chatType === 'supergroup')) {
            const title = peer.title ?? '';
            if (title.startsWith(TG_DRIVE_CHANNEL_PREFIX)) {
              const rawId = (peer.raw as { id: number }).id;
              const cleanName = title.slice(TG_DRIVE_CHANNEL_PREFIX.length).trim() || title;
              const existing = this.state.folders.find(f => f.id === rawId);
              if (existing) existing.name = cleanName;
              else {
                this.state.folders.push({
                  id: rawId,
                  name: cleanName,
                  group_id: null,
                  sort_order: this.state.folders.length,
                  is_hidden: false,
                  created_at: new Date().toISOString(),
                });
              }
            }
          }
        }
        this.saveState();
        return this.state.folders;
      }

      case 'cmd_get_folders':
      case 'cmd_get_enriched_folders':
        return [...this.state.folders]
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(f => {
            const list = this.filesCache.get(String(f.id)) ?? [];
            const total = list.reduce((s, item) => s + (item.size || 0), 0);
            return {
              ...f,
              display_order: f.sort_order,
              file_count: list.length,
              total_size: total,
              total_size_str: formatByteSize(total),
            };
          });

      case 'cmd_create_folder': {
        const clean = String(args.name ?? '').trim();
        const client = await this.ensureClient();
        const chat = await client.createChannel({
          title: `${TG_DRIVE_CHANNEL_PREFIX}${clean}`,
          description: 'Private cloud folder managed by Telegram Drive',
        });
        const meta = {
          id: (chat.raw as { id: number }).id,
          name: clean,
          group_id: null,
          sort_order: this.state.folders.length,
          is_hidden: false,
          created_at: new Date().toISOString(),
        };
        this.state.folders.push(meta);
        this.saveState();
        return meta;
      }

      case 'cmd_rename_folder': {
        const folderId = Number(args.folderId);
        const newName = String(args.newName ?? '').trim();
        const client = await this.ensureClient();
        await client.setChatTitle(folderIdToPeer(folderId), `${TG_DRIVE_CHANNEL_PREFIX}${newName}`);
        const f = this.state.folders.find(i => i.id === folderId);
        if (f) f.name = newName;
        this.saveState();
        return null;
      }

      case 'cmd_delete_folder': {
        const folderId = Number(args.folderId);
        const client = await this.ensureClient();
        await client.deleteChannel(folderIdToPeer(folderId));
        this.state.folders = this.state.folders.filter(i => i.id !== folderId);
        this.saveState();
        return null;
      }

      case 'cmd_toggle_folder_visibility': {
        const f = this.state.folders.find(i => i.id === Number(args.folderId));
        if (!f) throw new Error('FOLDER_NOT_FOUND');
        f.is_hidden = args.isHidden !== undefined ? Boolean(args.isHidden) : !f.is_hidden;
        this.saveState();
        return f;
      }

      case 'cmd_export_folder_invite': {
        const client = await this.ensureClient();
        const link = await client.exportInviteLink(folderIdToPeer(Number(args.folderId)));
        return { link: link.link, is_revoked: false };
      }

      case 'cmd_update_folder_order': {
        const f = this.state.folders.find(i => i.id === Number(args.folderId));
        if (f) f.sort_order = Number(args.newOrder);
        this.saveState();
        return null;
      }

      case 'cmd_set_folder_group':
      case 'cmd_assign_folder_to_group': {
        const fid = Number(args.folderId ?? args.channelId);
        const f = this.state.folders.find(i => i.id === fid);
        if (f) f.group_id = args.groupId === null || args.groupId === undefined ? null : Number(args.groupId);
        this.saveState();
        return null;
      }

      case 'cmd_get_groups':
        return [...this.state.groups]
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(g => ({ ...g, display_order: g.sort_order }));

      case 'cmd_create_group': {
        const id = Date.now();
        this.state.groups.push({
          id,
          name: String(args.name ?? 'Group'),
          color_hex: String(args.colorHex ?? '#38bdf8'),
          sort_order: this.state.groups.length,
        });
        this.saveState();
        return id;
      }

      case 'cmd_update_group': {
        const g = this.state.groups.find(i => i.id === Number(args.groupId));
        if (g) {
          if (args.name !== undefined) g.name = String(args.name);
          if (args.colorHex !== undefined) g.color_hex = String(args.colorHex);
        }
        this.saveState();
        return null;
      }

      case 'cmd_rename_group': {
        const g = this.state.groups.find(i => i.id === Number(args.groupId));
        if (g) g.name = String(args.newName ?? g.name);
        this.saveState();
        return null;
      }

      case 'cmd_update_group_color': {
        const g = this.state.groups.find(i => i.id === Number(args.groupId));
        if (g) g.color_hex = String(args.colorHex ?? g.color_hex);
        this.saveState();
        return null;
      }

      case 'cmd_update_group_order': {
        const g = this.state.groups.find(i => i.id === Number(args.groupId));
        if (g) g.sort_order = Number(args.newOrder ?? g.sort_order);
        this.saveState();
        return null;
      }

      case 'cmd_delete_group': {
        const gid = Number(args.groupId);
        this.state.groups = this.state.groups.filter(i => i.id !== gid);
        for (const f of this.state.folders) {
          if (f.group_id === gid) f.group_id = null;
        }
        this.saveState();
        return null;
      }

      // ── Files, Thumbnails, Previews & Transfers ────────────────────
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
        const files = await this.listFiles(folderId, chunk => {
          dispatchLocalEvent('folder-load-chunk', {
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
        return [];

      case 'cmd_touch_file_inventory':
      case 'cmd_record_file_opened':
      case 'cmd_set_file_activity_flag':
        return null;

      case 'cmd_get_storage_insight': {
        const ownerId = this.currentUserId ?? '';
        const allFiles = ownerId ? this.collectWorkspaceFiles(ownerId) : [];
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
        const list = await this.listFiles(
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId),
        );
        return list.filter(f => f.name.toLowerCase().includes(q));
      }

      case 'cmd_get_favorite_files':
        return this.collectWorkspaceFiles(await this.getOwnerId()).filter(f => f.is_favorite);

      case 'cmd_toggle_favorite': {
        const key = fileCompositeKey(
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId),
          Number(args.messageId),
        );
        const idx = this.state.favorites.indexOf(key);
        if (idx === -1) this.state.favorites.push(key);
        else this.state.favorites.splice(idx, 1);
        this.saveState();
        return idx === -1;
      }

      case 'cmd_delete_file': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        await this.deleteSplitAwareMessage(folderId, messageId);
        return null;
      }

      case 'cmd_rename_file': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const newName = String(args.newName ?? '').trim();
        this.state.fileRenames[fileCompositeKey(folderId, messageId)] = newName;
        this.saveState();
        return null;
      }

      case 'cmd_move_files': {
        const src =
          args.sourceFolderId === null || args.sourceFolderId === undefined
            ? null
            : Number(args.sourceFolderId);
        const dst =
          args.targetFolderId === null || args.targetFolderId === undefined
            ? null
            : Number(args.targetFolderId);
        const ids = (args.messageIds as number[]) ?? [];
        const client = await this.ensureClient();
        const plainIds: number[] = [];

        for (const msgId of ids) {
          const srcKey = fileCompositeKey(src, msgId);
          let manifest = this.state.splitManifests?.[srcKey] ?? null;
          if (!manifest) {
            manifest = await this.ensureSplitManifestLoaded(src, msgId).catch(() => null);
          }

          if (manifest && manifest.parts.length > 0) {
            const newParts: SplitPartDescriptor[] = [];
            for (let i = 0; i < manifest.parts.length; i += 100) {
              const slice = manifest.parts.slice(i, i + 100);
              const forwarded = await client.forwardMessagesById({
                fromChatId: folderIdToPeer(src),
                toChatId: folderIdToPeer(dst),
                messages: slice.map(p => p.id),
                noAuthor: true,
              });
              for (let j = 0; j < slice.length; j++) {
                newParts.push({
                  id: forwarded[j]?.id ?? slice[j].id,
                  size: slice[j].size,
                });
              }
            }
            const nextManifest: SplitFileManifest = {
              ...manifest,
              parts: newParts,
            };
            const manifestBytes = new TextEncoder().encode(JSON.stringify(nextManifest));
            const manifestName = buildSplitManifestFileName(nextManifest.groupId);
            const uploadedManifest = await client.uploadFile({
              file: manifestBytes,
              fileName: manifestName,
              fileSize: manifestBytes.byteLength,
              fileMime: 'application/json',
            });
            const sentManifest = await client.sendMedia(folderIdToPeer(dst), {
              type: 'document',
              file: uploadedManifest,
              fileName: manifestName,
              caption: buildSplitManifestCaption(nextManifest),
            });

            const dstKey = fileCompositeKey(dst, sentManifest.id);
            if (!this.state.splitManifests) this.state.splitManifests = {};
            this.state.splitManifests[dstKey] = nextManifest;
            if (this.state.fileRenames[srcKey]) {
              this.state.fileRenames[dstKey] = this.state.fileRenames[srcKey];
              delete this.state.fileRenames[srcKey];
            }
            const encRec = this.vault.getEncryptedFileRecord(srcKey);
            if (encRec) {
              this.vault.registerEncryptedFile({ ...encRec, key: dstKey });
            }
            await this.deleteSplitAwareMessage(src, msgId);
            this.saveState();
          } else {
            plainIds.push(msgId);
          }
        }

        if (plainIds.length > 0) {
          await client.forwardMessagesById({
            fromChatId: folderIdToPeer(src),
            toChatId: folderIdToPeer(dst),
            messages: plainIds,
            noAuthor: true,
          });
          await client.deleteMessagesById(folderIdToPeer(src), plainIds, { revoke: true });
        }
        return null;
      }

      case 'cmd_get_thumbnail': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const cacheKey = `thumb:${folderId ?? 'saved'}:${messageId}`;
        if (this.blobUrlCache.has(cacheKey)) return this.blobUrlCache.get(cacheKey)!;
        if (this.isEffectiveDataSaver() && !args.force) return null;

        try {
          const msg = await this.fetchMessage(folderId, messageId);
          const media = msg.media as unknown as { thumbnails?: unknown[]; type?: string; fileSize?: number } | null;
          if (!media) return null;
          const client = await this.ensureClient();
          let bytes: Uint8Array | null = null;
          if (media.thumbnails && media.thumbnails.length > 0) {
            bytes = await client.downloadAsBuffer(
              media.thumbnails[media.thumbnails.length - 1] as Parameters<TelegramClient['downloadAsBuffer']>[0],
            );
          } else if (media.type === 'photo' || ((media.fileSize ?? Infinity) < 1_500_000)) {
            bytes = await client.downloadAsBuffer(
              msg.media as Parameters<TelegramClient['downloadAsBuffer']>[0],
            );
          }
          if (!bytes) return null;
          const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }));
          this.blobUrlCache.set(cacheKey, url);
          return url;
        } catch {
          return null;
        }
      }

      case 'cmd_get_display_preview':
      case 'cmd_get_preview': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const cacheKey = `prev:${folderId ?? 'saved'}:${messageId}`;
        if (this.blobUrlCache.has(cacheKey)) return this.blobUrlCache.get(cacheKey)!;

        // For split or large media (>120 MiB) on Android native, stream directly via local HTTP Range server
        const splitManifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
        if (splitManifest) {
          if (!splitManifest.encrypted && isAndroidNative()) {
            void this.checkEnvironmentForQuietNotices(splitManifest.totalSize, 'stream');
            const srv = await this.ensureAndroidMediaServer();
            const fSeg = folderId === null ? 'saved' : String(folderId);
            return `${srv.baseUrl}/stream/${fSeg}/${messageId}?token=${srv.token}`;
          }
          throw new Error('PREVIEW_TOO_LARGE_USE_STREAM_OR_DOWNLOAD');
        }

        const msg = await this.fetchMessage(folderId, messageId);
        const key = fileCompositeKey(folderId, messageId);
        const mapped = mapMessageToTelegramFile(msg, folderId, {
          customName: this.state.fileRenames[key],
          encryptedRecord: this.vault.getEncryptedFileRecord(key),
          vaultUnlocked: this.vault.getStatus().is_unlocked,
        });
        const mediaSize = mapped?.size || ((msg.media as unknown as { fileSize?: number })?.fileSize ?? 0);
        const mime = mapped?.mime_type || guessMimeType(mapped?.name ?? '');
        const isMappedEncrypted = Boolean(
          mapped?.encryption || (mapped?.encryption_state && mapped.encryption_state !== 'plain'),
        );

        if (
          isAndroidNative() &&
          !isMappedEncrypted &&
          mediaSize > 48 * 1024 * 1024 &&
          (mime.startsWith('video/') || mime.startsWith('audio/'))
        ) {
          void this.checkEnvironmentForQuietNotices(mediaSize, 'stream');
          const srv = await this.ensureAndroidMediaServer();
          const fSeg = folderId === null ? 'saved' : String(folderId);
          return `${srv.baseUrl}/stream/${fSeg}/${messageId}?token=${srv.token}`;
        }

        void this.checkEnvironmentForQuietNotices(mediaSize, 'stream');
        const rawBytes = await this.downloadRawBytes(folderId, messageId, (done, total) => {
          dispatchLocalEvent('preview-progress', {
            folder_id: folderId,
            message_id: messageId,
            downloaded_bytes: done,
            total_bytes: total,
            percent: total > 0 ? Math.min(99, Math.round((done / total) * 99)) : 0,
          });
        });
        const plain = VaultRuntime.hasEncryptedMagic(rawBytes)
          ? this.vault.decryptBuffer(rawBytes, {
              promptToken: typeof args.promptToken === 'number' ? args.promptToken : undefined,
            }).plaintext
          : rawBytes;
        const url = URL.createObjectURL(new Blob([plain as unknown as BlobPart], { type: mime }));
        this.blobUrlCache.set(cacheKey, url);
        return url;
      }

      case 'cmd_set_preview_pinned': {
        const key = fileCompositeKey(
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId),
          Number(args.messageId),
        );
        if (args.pinned) {
          if (!this.state.pinnedPreviews.includes(key)) this.state.pinnedPreviews.push(key);
        } else {
          this.state.pinnedPreviews = this.state.pinnedPreviews.filter(k => k !== key);
        }
        this.saveState();
        return null;
      }

      case 'cmd_delete_preview_for_message': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const cacheKey = `prev:${folderId ?? 'saved'}:${messageId}`;
        const url = this.blobUrlCache.get(cacheKey);
        if (url) {
          URL.revokeObjectURL(url);
          this.blobUrlCache.delete(cacheKey);
        }
        return null;
      }

      case 'cmd_list_archive_contents':
      case 'cmd_list_archive_entries': {
        const previewUrl = String(
          await this.invoke('cmd_get_preview', {
            folderId: args.folderId,
            messageId: args.messageId,
            promptToken: args.promptToken,
          }),
        );
        const bytes = new Uint8Array(await (await fetch(previewUrl)).arrayBuffer());
        return listZipEntriesFromBytes(bytes);
      }

      case 'cmd_extract_archive_entry': {
        const previewUrl = String(
          await this.invoke('cmd_get_preview', {
            folderId: args.folderId,
            messageId: args.messageId,
            promptToken: args.promptToken,
          }),
        );
        const entryPath = String(args.entryPath ?? '');
        const extracted = extractSingleZipEntry(
          new Uint8Array(await (await fetch(previewUrl)).arrayBuffer()),
          entryPath,
        );
        const fileName = entryPath.split('/').pop() || 'extracted.bin';
        if (isAndroidNative()) {
          const saved = await TelegramDriveNative.writeFileBase64({
            directory: 'downloads',
            filename: fileName,
            data: uint8ToBase64(extracted),
            mimeType: guessMimeType(fileName),
          });
          return saved.path;
        }
        return URL.createObjectURL(new Blob([extracted as unknown as BlobPart]));
      }

      case 'cmd_stage_android_upload':
        return String(args.path ?? '');
      case 'cmd_delete_android_staged_upload': {
        this.pendingFilesByPath.delete(String(args.path ?? ''));
        return null;
      }

      case 'initiate_upload':
      case 'cmd_upload_file': {
        const req = (args.req as Record<string, unknown> | undefined) ?? args;
        const rawPath = String(req.path ?? req.file_path ?? args.path ?? '');
        const folderId =
          req.folder_id === null || req.folder_id === undefined ? null : Number(req.folder_id);
        const transferId = String(req.id ?? args.id ?? `up_${Date.now()}`);
        this.explicitlyCancelledTransfers.delete(transferId);
        const abort = new AbortController();
        this.activeAborts.set(transferId, abort);

        try {
          const protectionMode = (req.protection_mode ?? args.protectionMode) as string | undefined;
          const isEncrypted = protectionMode === 'vault' || protectionMode === 'passphrase';
          const promptToken = (req.prompt_token ?? args.promptToken) as number | undefined;
          const protectMetadata = Boolean(req.protect_metadata ?? args.protectMetadata);

          const browserFile = this.pendingFilesByPath.get(rawPath);
          let originalName = rawPath.split(/[\\/]/).pop() || 'upload.bin';
          let originalSize = Number(req.file_size ?? args.fileSize ?? 0);
          let lastModifiedMs = 0;

          if (browserFile) {
            originalName = browserFile.name || originalName;
            originalSize = browserFile.size;
            lastModifiedMs = browserFile.lastModified || 0;
          } else if (isAndroidNative()) {
            const info = await TelegramDriveNative.getFileInfo({ path: rawPath });
            if (info.name) originalName = info.name;
            if (info.size > 0) originalSize = info.size;
          } else {
            throw new Error('FILE_UNREADABLE');
          }

          if (typeof req.file_name === 'string' && req.file_name.trim()) {
            originalName = req.file_name.trim();
          }

          void this.checkEnvironmentForQuietNotices(originalSize, 'upload');

          const ultraLowRam = isEncrypted ? await this.isUltraLowRamDevice() : false;
          const encryptedSplitThreshold = ultraLowRam
            ? ANDROID_ENCRYPTED_SPLIT_PART_LOW_RAM
            : ANDROID_ENCRYPTED_SPLIT_PART_NORMAL;

          if (
            shouldSplitUpload(originalSize, isEncrypted) ||
            (isEncrypted && originalSize > encryptedSplitThreshold)
          ) {
            return await this.performAndroidSplitUpload({
              transferId,
              rawPath,
              browserFile,
              folderId,
              originalName,
              originalSize,
              lastModifiedMs,
              isEncrypted,
              protectionMode,
              promptToken,
              protectMetadata,
              abort,
            });
          }

          let uploadName = originalName;
          let uploadByteLength = originalSize;
          let vaultId: string | undefined;
          const resolvedPassphrase =
            isEncrypted && protectionMode === 'passphrase' && promptToken !== undefined
              ? this.vault.consumeStagedPassphrase(promptToken)
              : undefined;
          if (isEncrypted && protectionMode === 'passphrase' && !resolvedPassphrase) {
            throw new Error('PASSPHRASE_PROMPT_REQUIRED');
          }

          let encryptedPayload: Uint8Array | null = null;
          if (isEncrypted) {
            const fileBytes = await this.readSliceIntoUint8(
              browserFile,
              rawPath,
              0,
              originalSize,
              abort.signal,
            );
            const enc = this.vault.encryptBuffer(fileBytes, {
              mode: protectionMode === 'passphrase' ? 'passphrase' : 'vault',
              passphrase: resolvedPassphrase,
              originalName,
              originalMime: guessMimeType(originalName),
              protectMetadata,
            });
            encryptedPayload = enc.ciphertext;
            uploadByteLength = enc.ciphertext.byteLength;
            uploadName = enc.uploadFileName;
            vaultId = enc.vaultId;
          }

          const client = await this.ensureClient();
          const t0 = Date.now();
          const sent = await this.runWithTransientRetry(transferId, abort.signal, async () => {
            const uploadSource: File | Uint8Array | ReadableStream<Uint8Array> = encryptedPayload
              ? encryptedPayload
              : browserFile
                ? browserFile
                : this.createNativeChunkReadableStream(rawPath, 0, originalSize, abort.signal);

            const uploaded = await client.uploadFile({
              file: uploadSource as unknown as Parameters<TelegramClient['uploadFile']>[0]['file'],
              fileName: uploadName,
              fileSize: uploadByteLength,
              fileMime: isEncrypted ? 'application/octet-stream' : guessMimeType(originalName),
              abortSignal: abort.signal,
              progressCallback: (done, tot) => {
                const speed = Math.round(done / Math.max(0.1, (Date.now() - t0) / 1000));
                dispatchLocalEvent('upload-progress', {
                  id: transferId,
                  progress: tot > 0 ? Math.min(99, Math.round((done / tot) * 100)) : 0,
                  uploaded_bytes: done,
                  total_bytes: tot || uploadByteLength,
                  speed_bytes_per_sec: speed,
                });
              },
            });

            return await client.sendMedia(folderIdToPeer(folderId), {
              type: 'document',
              file: uploaded,
              fileName: uploadName,
              caption: isEncrypted ? '' : originalName,
            });
          });

          this.state.bandwidth.uploaded += uploadByteLength;

          if (isEncrypted) {
            this.vault.registerEncryptedFile({
              key: fileCompositeKey(folderId, sent.id),
              mode: protectionMode === 'passphrase' ? 'passphrase' : 'vault',
              vaultId,
              originalName,
              originalSize,
              protectMetadata,
            });
          }
          this.saveState();
          dispatchLocalEvent('upload-progress', {
            id: transferId,
            progress: 100,
            uploaded_bytes: uploadByteLength,
            total_bytes: uploadByteLength,
            speed_bytes_per_sec: 0,
          });
          return sent.id;
        } finally {
          this.activeAborts.delete(transferId);
          this.explicitlyCancelledTransfers.delete(transferId);
        }
      }

      case 'cmd_download_file': {
        const req = (args.req as Record<string, unknown> | undefined) ?? args;
        const messageId = Number(req.message_id ?? args.messageId);
        const folderId =
          req.folder_id === null || req.folder_id === undefined ? null : Number(req.folder_id);
        const transferId = String(req.id ?? args.id ?? `dl_${messageId}`);
        const savePath = String(req.save_path ?? args.savePath ?? `telegram_${messageId}`);
        const fileName = savePath.split(/[\\/]/).pop() || `telegram_${messageId}`;
        const promptToken = (req.prompt_token ?? args.promptToken) as number | undefined;
        this.explicitlyCancelledTransfers.delete(transferId);
        const abort = new AbortController();
        this.activeAborts.set(transferId, abort);

        try {
          const splitManifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
          const key = fileCompositeKey(folderId, messageId);
          const encRecord = this.vault.getEncryptedFileRecord(key);
          const isEncrypted = Boolean(splitManifest?.encrypted || encRecord);

          // Native Android low-RAM streaming + .tdpart Auto-Resume + Split Auto-Merge path
          if (isAndroidNative()) {
            let expectedTotal = 0;
            if (splitManifest) {
              expectedTotal = splitManifest.totalSize;
            } else {
              const msg = await this.fetchMessage(folderId, messageId);
              expectedTotal =
                encRecord?.originalSize ||
                ((msg.media as unknown as { fileSize?: number })?.fileSize ?? 0);
            }

            void this.checkEnvironmentForQuietNotices(expectedTotal, 'download');

            if (!isEncrypted) {
              const resumeKey = `dl_${folderId ?? 'saved'}_${messageId}_${expectedTotal}`;
              const sink = await TelegramDriveNative.openDownloadSink({
                resumeKey,
                expectedTotalBytes: expectedTotal,
              });
              let currentOffset = sink.existingBytes || 0;
              const t0 = Date.now();
              let succeeded = false;

              try {
                while (currentOffset < expectedTotal || expectedTotal === 0) {
                  if (abort.signal.aborted) throw new Error('ABORTED');
                  let flushBuf = new Uint8Array(1024 * 1024);
                  let flushLen = 0;

                  const flushPending = async () => {
                    if (flushLen <= 0) return;
                    const slice = flushBuf.subarray(0, flushLen);
                    await TelegramDriveNative.appendDownloadChunkBase64({
                      sinkId: sink.sinkId,
                      data: uint8ToBase64(slice),
                    });
                    currentOffset += flushLen;
                    flushLen = 0;
                    const tot = expectedTotal || currentOffset;
                    const speed = Math.round(
                      Math.max(0, currentOffset - (sink.existingBytes || 0)) /
                        Math.max(0.1, (Date.now() - t0) / 1000),
                    );
                    dispatchLocalEvent('download-progress', {
                      id: transferId,
                      message_id: messageId,
                      progress: tot > 0 ? Math.min(99, Math.round((currentOffset / tot) * 99)) : 0,
                      downloaded_bytes: currentOffset,
                      total_bytes: tot,
                      speed_bytes_per_sec: speed,
                    });
                  };

                  try {
                    const targetEnd = expectedTotal > 0 ? expectedTotal - 1 : Number.MAX_SAFE_INTEGER;
                    await this.streamAndroidByteRange(
                      folderId,
                      messageId,
                      currentOffset,
                      targetEnd,
                      async chunk => {
                        let cOff = 0;
                        while (cOff < chunk.byteLength) {
                          const space = flushBuf.byteLength - flushLen;
                          const copyLen = Math.min(space, chunk.byteLength - cOff);
                          flushBuf.set(chunk.subarray(cOff, cOff + copyLen), flushLen);
                          flushLen += copyLen;
                          cOff += copyLen;
                          if (flushLen >= flushBuf.byteLength) {
                            await flushPending();
                          }
                        }
                        return !abort.signal.aborted;
                      },
                      abort.signal,
                    );
                    await flushPending();
                    break;
                  } catch (streamErr) {
                    await flushPending().catch(() => undefined);
                    if (
                      abort.signal.aborted ||
                      this.explicitlyCancelledTransfers.has(transferId) ||
                      !isTransientAndroidError(streamErr)
                    ) {
                      throw streamErr;
                    }
                    await waitOnlineOrDelay(3000, abort.signal);
                  }
                }

                const finalized = await TelegramDriveNative.finalizeDownloadSink({
                  sinkId: sink.sinkId,
                  directory: 'downloads',
                  filename: fileName,
                  mimeType: guessMimeType(fileName),
                });
                succeeded = true;
                this.saveState();
                dispatchLocalEvent('download-progress', {
                  id: transferId,
                  message_id: messageId,
                  progress: 100,
                  downloaded_bytes: currentOffset,
                  total_bytes: expectedTotal || currentOffset,
                  speed_bytes_per_sec: 0,
                });
                return { finalPath: finalized.path, outcome: 'saved' };
              } finally {
                if (!succeeded) {
                  await TelegramDriveNative.abortDownloadSink({
                    sinkId: sink.sinkId,
                    deletePartial: this.explicitlyCancelledTransfers.has(transferId),
                  }).catch(() => undefined);
                }
              }
            }

            // Encrypted split file on Android Native: decrypt part-by-part into sink
            if (splitManifest && splitManifest.parts.length > 0) {
              const resolvedPassphrase =
                (splitManifest.encrypted?.mode === 'passphrase' || encRecord?.mode === 'passphrase') &&
                promptToken !== undefined
                  ? this.vault.consumeStagedPassphrase(promptToken)
                  : undefined;

              const sink = await TelegramDriveNative.openDownloadSink({
                resumeKey: `dl_enc_${folderId ?? 'saved'}_${messageId}_${Date.now()}`,
                expectedTotalBytes: 0,
              });
              let writtenPlain = 0;
              let succeeded = false;
              const t0 = Date.now();
              try {
                for (let idx = 0; idx < splitManifest.parts.length; idx++) {
                  if (abort.signal.aborted) throw new Error('ABORTED');
                  const part = splitManifest.parts[idx];
                  const cipherPart = await this.runWithTransientRetry(transferId, abort.signal, () =>
                    this.downloadRawBytes(
                      folderId,
                      part.id,
                      (done, tot) => {
                        const approx = writtenPlain + Math.round((done / Math.max(1, tot)) * part.size);
                        const speed = Math.round(approx / Math.max(0.1, (Date.now() - t0) / 1000));
                        dispatchLocalEvent('download-progress', {
                          id: transferId,
                          message_id: messageId,
                          progress: Math.min(99, Math.round((approx / Math.max(1, expectedTotal)) * 99)),
                          downloaded_bytes: approx,
                          total_bytes: expectedTotal,
                          speed_bytes_per_sec: speed,
                          part_index: idx + 1,
                          part_count: splitManifest.parts.length,
                        });
                      },
                      abort.signal,
                    ),
                  );
                  const plainPart = VaultRuntime.hasEncryptedMagic(cipherPart)
                    ? this.vault.decryptBuffer(cipherPart, { passphrase: resolvedPassphrase }).plaintext
                    : cipherPart;

                  const step = 1024 * 1024;
                  for (let pOff = 0; pOff < plainPart.byteLength; pOff += step) {
                    const sub = plainPart.subarray(pOff, Math.min(plainPart.byteLength, pOff + step));
                    await TelegramDriveNative.appendDownloadChunkBase64({
                      sinkId: sink.sinkId,
                      data: uint8ToBase64(sub),
                    });
                  }
                  writtenPlain += plainPart.byteLength;
                }
                const finalized = await TelegramDriveNative.finalizeDownloadSink({
                  sinkId: sink.sinkId,
                  directory: 'downloads',
                  filename: fileName,
                  mimeType: guessMimeType(fileName),
                });
                succeeded = true;
                this.saveState();
                dispatchLocalEvent('download-progress', {
                  id: transferId,
                  message_id: messageId,
                  progress: 100,
                  downloaded_bytes: writtenPlain,
                  total_bytes: writtenPlain,
                  speed_bytes_per_sec: 0,
                });
                return { finalPath: finalized.path, outcome: 'saved' };
              } finally {
                if (!succeeded) {
                  await TelegramDriveNative.abortDownloadSink({
                    sinkId: sink.sinkId,
                    deletePartial: true,
                  }).catch(() => undefined);
                }
              }
            }
          }

          // Fallback (encrypted single file or browser test mode)
          const t0 = Date.now();
          let plain: Uint8Array;
          if (splitManifest && splitManifest.parts.length > 0) {
            const resolvedPassphrase =
              splitManifest.encrypted?.mode === 'passphrase' && promptToken !== undefined
                ? this.vault.consumeStagedPassphrase(promptToken)
                : undefined;
            const partBuffers: Uint8Array[] = [];
            let totalLen = 0;
            for (const part of splitManifest.parts) {
              const rawPart = await this.downloadRawBytes(folderId, part.id, undefined, abort.signal);
              const dec = VaultRuntime.hasEncryptedMagic(rawPart)
                ? this.vault.decryptBuffer(rawPart, { passphrase: resolvedPassphrase }).plaintext
                : rawPart;
              partBuffers.push(dec);
              totalLen += dec.byteLength;
            }
            plain = new Uint8Array(totalLen);
            let off = 0;
            for (const b of partBuffers) {
              plain.set(b, off);
              off += b.byteLength;
            }
          } else {
            const rawBytes = await this.runWithTransientRetry(transferId, abort.signal, () =>
              this.downloadRawBytes(
                folderId,
                messageId,
                (done, tot) => {
                  const speed = Math.round(done / Math.max(0.1, (Date.now() - t0) / 1000));
                  dispatchLocalEvent('download-progress', {
                    id: transferId,
                    message_id: messageId,
                    progress: tot > 0 ? Math.min(98, Math.round((done / tot) * 98)) : 0,
                    downloaded_bytes: done,
                    total_bytes: tot,
                    speed_bytes_per_sec: speed,
                  });
                },
                abort.signal,
              ),
            );
            plain = VaultRuntime.hasEncryptedMagic(rawBytes)
              ? this.vault.decryptBuffer(rawBytes, { promptToken }).plaintext
              : rawBytes;
          }

          let finalPath = savePath;
          if (isAndroidNative()) {
            const written = await TelegramDriveNative.writeFileBase64({
              directory: 'downloads',
              filename: fileName,
              data: uint8ToBase64(plain),
              mimeType: guessMimeType(fileName),
            });
            finalPath = written.path;
          } else {
            const blobUrl = URL.createObjectURL(
              new Blob([plain as unknown as BlobPart], { type: guessMimeType(fileName) }),
            );
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = fileName;
            a.click();
          }

          dispatchLocalEvent('download-progress', {
            id: transferId,
            message_id: messageId,
            progress: 100,
            downloaded_bytes: plain.byteLength,
            total_bytes: plain.byteLength,
            speed_bytes_per_sec: 0,
          });
          return { finalPath, outcome: 'saved' };
        } finally {
          this.activeAborts.delete(transferId);
          this.explicitlyCancelledTransfers.delete(transferId);
        }
      }

      case 'cmd_cancel_transfer': {
        const id = String(args.transferId ?? args.id ?? '');
        if (id) this.explicitlyCancelledTransfers.add(id);
        this.activeAborts.get(id)?.abort();
        return null;
      }

      // ── Vault & Encryption ─────────────────────────────────────────
      case 'cmd_get_encryption_capabilities':
        return this.vault.getCapabilities();
      case 'cmd_get_vault_status':
        return this.vault.getStatus();
      case 'cmd_get_crypto_inventory':
        return this.vault.getInventory();
      case 'cmd_get_encryption_settings':
        return this.vault.getSettings();
      case 'cmd_update_encryption_settings': {
        const res = this.vault.updateSettings((args.settings as Record<string, unknown>) ?? {});
        this.saveState();
        return res;
      }
      case 'cmd_create_vault':
        this.vault.createVault(String(args.passphrase ?? ''));
        this.saveState();
        dispatchLocalEvent('vault-unlocked', {});
        return null;
      case 'cmd_unlock_vault': {
        const sid = this.vault.unlock(String(args.passphrase ?? ''));
        dispatchLocalEvent('vault-unlocked', {});
        return sid;
      }
      case 'cmd_lock_vault':
        this.vault.lock();
        dispatchLocalEvent('vault-locked', {});
        return null;
      case 'cmd_record_vault_activity':
        this.vault.recordActivity();
        return null;
      case 'cmd_change_vault_passphrase':
        this.vault.changePassphrase(String(args.currentPassphrase ?? ''), String(args.newPassphrase ?? ''));
        this.saveState();
        return null;
      case 'cmd_generate_recovery_key':
        return this.vault.generateRecoveryKey();
      case 'cmd_export_vault_recovery': {
        if (args.recoveryPassphrase !== undefined) {
          return this.vault.exportVaultRecovery(String(args.recoveryPassphrase ?? ''));
        }
        return this.vault.exportVaultRecovery(String(args.currentPassphrase ?? ''), String(args.recoveryKey ?? ''));
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
        this.saveState();
        return null;
      case 'cmd_stage_file_passphrase':
        return this.vault.stagePassphrase(String(args.passphrase ?? ''));
      case 'cmd_get_file_encryption_info':
        return this.vault.getFileEncryptionInfo(
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId),
          Number(args.messageId),
        );

      // ── Workspace, Playback, Cleanup & Offline Packs ───────────────
      case 'cmd_workspace_read':
      case 'cmd_workspace_index': {
        const ownerId = String(args.ownerId);
        if (cmd === 'cmd_workspace_index') {
          for (const fid of ((args.folderIds as Array<number | null>) ?? [null])) {
            await this.listFiles(fid).catch(() => undefined);
          }
        }
        const files = this.collectWorkspaceFiles(ownerId);
        return {
          ownerId,
          files,
          collections: this.state.collections[ownerId] ?? [],
          searches: this.state.savedSearches[ownerId] ?? [],
          scans: [],
          nextCursor: null,
          totalFiles: files.length,
        };
      }

      case 'cmd_workspace_mutate': {
        const ownerId = String(args.ownerId);
        const files = this.collectWorkspaceFiles(ownerId);
        return {
          ownerId,
          files,
          collections: this.state.collections[ownerId] ?? [],
          searches: this.state.savedSearches[ownerId] ?? [],
          scans: [],
          nextCursor: null,
          totalFiles: files.length,
        };
      }

      case 'cmd_search_local': {
        const ownerId = String(args.ownerId);
        const q = String((args.query as Record<string, unknown> | undefined)?.query ?? '').toLowerCase();
        const files = this.collectWorkspaceFiles(ownerId).filter(f => !q || f.name.toLowerCase().includes(q));
        return {
          files,
          indexId: `idx_${ownerId}`,
          total: files.length,
          nextOffset: null,
          indexed: true,
          complete: true,
          offline: !navigator.onLine,
        };
      }

      case 'cmd_playback_read': {
        const ownerId = String(args.ownerId);
        const s = this.state.playback[ownerId] ?? { items: [], queue: [], preferences: { volume: 1, speed: 1 } };
        return { ownerId, ...s };
      }

      case 'cmd_playback_mutate': {
        const ownerId = String(args.ownerId);
        const s = this.state.playback[ownerId] ?? { items: [], queue: [], preferences: { volume: 1, speed: 1 } };
        this.state.playback[ownerId] = s;
        this.saveState();
        return { ownerId, ...s };
      }

      case 'cmd_cleanup_list':
        return this.state.removals[String(args.ownerId)] ?? [];
      case 'cmd_cleanup_schedule':
        return [];
      case 'cmd_offline_packs_list':
        return {
          ownerId: String(args.ownerId),
          packs: this.state.offlinePacks[String(args.ownerId)] ?? [],
          freeBytes: 8 * 1024 * 1024 * 1024,
          reserveBytes: 512 * 1024 * 1024,
          network: { known: true, connected: navigator.onLine !== false, wifi: true },
        };

      case 'cmd_storage_read':
        return {
          ownerId: String(args.ownerId),
          freeBytes: null,
          limits: this.state.storageLimits[String(args.ownerId)] ?? {
            previews: 2 * 1024 * 1024 * 1024,
            thumbnails: 512 * 1024 * 1024,
            converted: 2 * 1024 * 1024 * 1024,
          },
          categories: [
            { id: 'kept', bytes: 0, reclaimableBytes: 0, fileCount: 0, measured: true },
            { id: 'previews', bytes: 0, reclaimableBytes: 0, fileCount: 0, measured: true },
            { id: 'thumbnails', bytes: 0, reclaimableBytes: 0, fileCount: 0, measured: true },
          ],
        };

      case 'cmd_get_settings_sync_status': {
        try {
          const client = await this.ensureClient();
          const history = await client.getHistory('self', { limit: 30 });
          const syncMsg = history.find(m => m.text?.startsWith(SETTINGS_SYNC_MARKER));
          if (!syncMsg?.text) return { available: false, updated_at: null, device_id: null, current_device: false };
          const parsed = JSON.parse(syncMsg.text.slice(syncMsg.text.indexOf('{'))) as { updated_at: number; device_id: string };
          return {
            available: true,
            updated_at: parsed.updated_at,
            device_id: parsed.device_id,
            current_device: parsed.device_id === this.state.deviceId,
          };
        } catch {
          return { available: false, updated_at: null, device_id: null, current_device: false };
        }
      }

      case 'cmd_upload_settings_sync': {
        const client = await this.ensureClient();
        const { payloadText, updatedAt } = encryptSettingsSyncPayload(
          (args.settings as Record<string, unknown>) ?? {},
          String(args.passphrase ?? ''),
          this.state.deviceId,
        );
        await client.sendText('self', payloadText);
        return { available: true, updated_at: updatedAt, device_id: this.state.deviceId, current_device: true };
      }

      case 'cmd_download_settings_sync': {
        const client = await this.ensureClient();
        const history = await client.getHistory('self', { limit: 30 });
        const syncMsg = history.find(m => m.text?.startsWith(SETTINGS_SYNC_MARKER));
        if (!syncMsg?.text) throw new Error('SETTINGS_SYNC_NOT_FOUND');
        return decryptSettingsSyncPayload(syncMsg.text, String(args.passphrase ?? ''));
      }

      // ── Android Native Features (Keystore, Biometrics, FLAG_SECURE, Foreground Service) ──
      case 'cmd_get_android_transfer_environment': {
        if (isAndroidNative()) {
          return await TelegramDriveNative.getTransferEnvironment();
        }
        const online = navigator.onLine !== false;
        const avail = 16 * 1024 * 1024 * 1024;
        return {
          connected: online,
          metered: false,
          roaming: false,
          charging: true,
          batteryLow: false,
          storageLow: false,
          freeBytes: avail,
          powerSaveMode: false,
          backgroundRestricted: false,
          network_connected: online,
          wifi_connected: true,
          battery_percent: 100,
          power_save_mode: false,
          available_storage_bytes: avail,
          notification_permission: 'granted',
          recovery_supported: true,
        };
      }

      case 'cmd_get_android_authentication_available':
        return isAndroidNative()
          ? (await TelegramDriveNative.isBiometricAvailable()).available
          : false;

      case 'cmd_android_authenticate':
        return isAndroidNative()
          ? (await TelegramDriveNative.authenticate({ reason: String(args.reason ?? 'Unlock Telegram Drive') })).authenticated
          : true;

      case 'cmd_configure_android_privacy':
        return isAndroidNative()
          ? (await TelegramDriveNative.setPrivacyScreen({ enabled: Boolean(args.privacyScreen ?? args.enabled) })).applied
          : false;

      case 'cmd_start_foreground_service':
        if (isAndroidNative()) await TelegramDriveNative.startForegroundService({});
        return null;

      case 'cmd_update_foreground_service':
        if (isAndroidNative()) await TelegramDriveNative.updateForegroundService(args);
        return null;

      case 'cmd_stop_foreground_service':
        if (isAndroidNative()) await TelegramDriveNative.stopForegroundService();
        return null;

      case 'cmd_get_pending_android_transfer_action':
        return isAndroidNative()
          ? (await TelegramDriveNative.getPendingTransferAction()).action
          : '';

      case 'cmd_get_pending_share_count':
        return isAndroidNative()
          ? (await TelegramDriveNative.getPendingShareCount()).count
          : 0;

      case 'cmd_list_cached_files':
        return isAndroidNative()
          ? (await TelegramDriveNative.listSharedCachedFiles()).files
          : [];

      case 'cmd_remove_cached_path':
        if (isAndroidNative()) await TelegramDriveNative.removeSharedCachedFile({ uri: String(args.uri ?? '') });
        return null;

      case 'cmd_open_file_externally':
        if (isAndroidNative()) await TelegramDriveNative.openFileExternally({ path: String(args.path ?? '') });
        return null;

      case 'cmd_open_android_stream_player':
        if (isAndroidNative()) {
          await TelegramDriveNative.openStreamPlayer({
            streamUrl: String(args.streamUrl ?? ''),
            title: String(args.title ?? ''),
            mimeType: String(args.mimeType ?? 'video/*'),
          });
        }
        return null;

      case 'cmd_upload_from_url': {
        const rawUrl = String(args.url ?? '').trim();
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const transferId = String(args.id ?? `url_${Date.now()}`);
        const res = await fetch(rawUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const guessedName =
          String(args.filename ?? '').trim() ||
          decodeURIComponent(new URL(rawUrl).pathname.split('/').pop() || '') ||
          `remote_${Date.now()}`;
        const client = await this.ensureClient();
        const sent = await client.sendMedia(folderIdToPeer(folderId), {
          type: 'document',
          file: bytes,
          fileName: guessedName,
          fileMime: res.headers.get('content-type') || guessMimeType(guessedName),
        });
        this.state.bandwidth.uploaded += bytes.byteLength;
        this.saveState();
        dispatchLocalEvent('remote-upload-progress', {
          id: transferId,
          progress: 100,
          downloaded_bytes: bytes.byteLength,
          total_bytes: bytes.byteLength,
        });
        return sent.id;
      }

      case 'cmd_storage_clear':
        for (const url of this.blobUrlCache.values()) URL.revokeObjectURL(url);
        this.blobUrlCache.clear();
        return null;

      case 'cmd_storage_limits': {
        const ownerId = String(args.ownerId ?? '');
        if (ownerId && args.limits) {
          this.state.storageLimits[ownerId] = args.limits as {
            previews: number;
            thumbnails: number;
            converted: number;
          };
          this.saveState();
        }
        return null;
      }

      case 'cmd_get_transcode_capabilities':
        return {
          ffmpeg_available: false,
          hardware_encoder: null,
          cache_size_bytes: 0,
          max_cache_gb: 2,
          entries: [],
        };

      case 'cmd_get_cached_variants':
        return [];

      case 'cmd_set_transcode_cache_limit':
        return null;

      case 'cmd_clear_transcode_cache':
        return 'Cleared 0 B';

      case 'cmd_get_proxy_status':
        return { reachable: navigator.onLine !== false, latency_ms: 1 };

      case 'cmd_apply_proxy_settings':
      case 'cmd_test_proxy_traffic':
        return true;

      case 'cmd_clear_proxy_secret':
      case 'cmd_reconnect_with_network_settings':
        return null;

      case 'cmd_detect_vpn':
        return false;

      case 'cmd_get_api_settings':
        return {
          enabled: false,
          running: false,
          port: 49210,
          bind_address: '127.0.0.1',
          api_key: '',
        };

      case 'cmd_get_webdav_settings':
        return {
          enabled: false,
          running: false,
          port: 49211,
          bind_address: '127.0.0.1',
          username: 'tgdrive',
          has_token: false,
          token_preview: '',
          mount_url: 'http://127.0.0.1:49211/',
        };

      case 'cmd_get_bandwidth':
        return {
          date: new Date().toISOString().slice(0, 10),
          up_bytes: this.state.bandwidth.uploaded,
          down_bytes: this.state.bandwidth.downloaded,
          limit_bytes: this.state.weeklyQuotaBytes ?? 0,
          period: 'weekly',
          uploaded_bytes: this.state.bandwidth.uploaded,
          downloaded_bytes: this.state.bandwidth.downloaded,
        };

      case 'cmd_set_weekly_quota': {
        const nextLimit = Math.max(0, Number(args.limitBytes ?? 0));
        this.state.weeklyQuotaBytes = Number.isFinite(nextLimit) ? Math.round(nextLimit) : 0;
        this.saveState();
        return {
          date: new Date().toISOString().slice(0, 10),
          up_bytes: this.state.bandwidth.uploaded,
          down_bytes: this.state.bandwidth.downloaded,
          limit_bytes: this.state.weeklyQuotaBytes,
          period: 'weekly',
          uploaded_bytes: this.state.bandwidth.uploaded,
          downloaded_bytes: this.state.bandwidth.downloaded,
        };
      }

      case 'cmd_configure_android_transfer_recovery':
      case 'cmd_migrate_proxy_secret':
      case 'cmd_set_native_language':
      case 'cmd_workspace_cancel_asset':
        return null;

      case 'cmd_get_notification_permission':
      case 'cmd_request_notification_permission': {
        if (isAndroidNative()) {
          const env = await TelegramDriveNative.getTransferEnvironment().catch(() => null);
          return env?.notification_permission ?? 'granted';
        }
        return 'granted';
      }

      case 'cmd_get_android_playback_history':
      case 'cmd_transfer_list':
      case 'cmd_get_sync_pairs':
      case 'cmd_get_sync_conflicts':
      case 'cmd_list_shares':
        return [];

      case 'cmd_transfer_activity':
        return { activeCount: this.activeAborts.size, pausedCount: 0, queuedCount: 0 };

      case 'cmd_get_stream_info': {
        if (!isAndroidNative()) return null;
        if (args.messageId !== undefined && args.messageId !== null) {
          const folderId =
            args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
          const messageId = Number(args.messageId);
          const key = fileCompositeKey(folderId, messageId);
          const encRec = this.vault.getEncryptedFileRecord(key);
          const splitManifest = await this.ensureSplitManifestLoaded(folderId, messageId).catch(() => null);
          if (encRec || splitManifest?.encrypted) {
            return null;
          }
        }
        const srv = await this.ensureAndroidMediaServer();
        return {
          port: srv.port,
          token: srv.token,
          base_url: srv.baseUrl,
          operation_token: null,
        };
      }

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

      case 'cmd_get_sync_settings':
        return {
          enabled: false,
          scanner_enabled: false,
          scan_interval_seconds: 300,
        };

      case 'cmd_get_sync_status':
        return {
          enabled: false,
          running: false,
          activePairs: 0,
          pendingOps: 0,
          conflicts: 0,
          lastError: null,
          pairs: [],
        };

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

      case 'cmd_set_preview_cache_limit':
        this.state.previewCacheMaxGb = Number(args.maxGb ?? 2);
        this.saveState();
        return null;

      case 'cmd_get_detailed_transcode_cache':
      case 'cmd_get_detailed_cache_info':
        return {
          entries: [],
          total_bytes: 0,
          max_bytes: Math.round(this.state.previewCacheMaxGb * 1024 * 1024 * 1024),
          scan_in_progress: false,
          last_scanned_at: Date.now(),
          last_error: null,
        };

      case 'cmd_get_cache_info':
        return {
          total_bytes: 0,
          file_count: this.blobUrlCache.size,
        };

      case 'cmd_get_offline_cache_status':
        return {
          total_bytes: 0,
          pinned_bytes: 0,
          file_count: this.blobUrlCache.size,
          pinned_count: this.state.pinnedPreviews.length,
          max_bytes: Math.round(this.state.previewCacheMaxGb * 1024 * 1024 * 1024),
        };

      case 'cmd_clean_preview_cache':
      case 'cmd_clean_cache': {
        for (const url of this.blobUrlCache.values()) URL.revokeObjectURL(url);
        this.blobUrlCache.clear();
        return null;
      }

      case 'cmd_check_latency': {
        const t0 = performance.now();
        if (this.client) await this.client.getMe();
        return Math.max(1, Math.round(performance.now() - t0));
      }

      case 'cmd_get_system_diagnostics':
        return JSON.stringify(
          {
            app: 'Telegram Drive (Android)',
            platform: 'android',
            connected: Boolean(this.client),
            vaultState: this.vault.getStatus().state,
          },
          null,
          2,
        );

      // ── GitHub Releases APK Auto-Updater ───────────────────────────
      case 'cmd_check_github_update': {
        const currentVersion = formatDisplayVersion(String(args.currentVersion ?? '1.0'), '1.0');
        const res = await fetch(GITHUB_LATEST_RELEASE_API, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (res.status === 404) {
          return {
            available: false,
            currentVersion,
            latestVersion: null,
            downloadUrl: null,
            assetName: null,
            assetSize: 0,
            releaseUrl: GITHUB_RELEASES_URL,
          };
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as GithubLatestReleasePayload;
        const parsedLatest = parseMajorMinor(payload.tag_name ?? payload.name ?? '');
        if (!parsedLatest) {
          return {
            available: false,
            currentVersion,
            latestVersion: null,
            downloadUrl: null,
            assetName: null,
            assetSize: 0,
            releaseUrl: payload.html_url || GITHUB_RELEASES_URL,
          };
        }
        const asset = pickPlatformReleaseAsset(payload.assets, 'android');
        const isNewer = compareVersions(parsedLatest.display, currentVersion) > 0;
        return {
          available: Boolean(isNewer && asset),
          currentVersion,
          latestVersion: parsedLatest.display,
          downloadUrl: asset?.browser_download_url ?? null,
          assetName: asset?.name ?? null,
          assetSize: asset?.size ?? 0,
          releaseUrl: payload.html_url || GITHUB_RELEASES_URL,
        };
      }

      case 'cmd_install_github_update': {
        const downloadUrl = String(args.downloadUrl ?? '');
        const assetName = String(args.assetName ?? 'Telegram-Drive.apk');
        if (isAndroidNative() && downloadUrl) {
          await TelegramDriveNative.downloadAndInstallApk({ downloadUrl, fileName: assetName });
        } else {
          window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
        }
        return true;
      }

      default:
        return null;
    }
  }
}

export const androidEngine = new AndroidWebEngine();
