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
  GITHUB_LATEST_RELEASE_API,
  GITHUB_RELEASES_URL,
  compareVersions,
  formatDisplayVersion,
  parseMajorMinor,
  pickPlatformReleaseAsset,
  type GithubLatestReleasePayload,
} from '../../shared/versioning';
import { dispatchLocalEvent } from './eventBus';
import { isAndroidNative, TelegramDriveNative } from './nativeBridge';

const STATE_STORAGE_KEY = 'telegram_drive_android_state_v1';

interface AndroidPersistedState {
  deviceId: string;
  apiId: number | null;
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
  private currentUserId: string | null = null;
  private wasmBytesPromise: Promise<Uint8Array> | null = null;
  private filesCache = new Map<string, MappedTelegramFile[]>();
  private blobUrlCache = new Map<string, string>();
  private activeAborts = new Map<string, AbortController>();
  private pendingFilesByPath = new Map<string, File>();

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
  } = {
    latestUrl: null,
    needsPassword: false,
    authorized: false,
    error: null,
    abort: null,
  };

  constructor() {
    this.state = this.loadState();
    this.vault.loadPersisted(this.state.vaultData);
  }

  public registerBrowserSelectedFile(pseudoPath: string, file: File): void {
    this.pendingFilesByPath.set(pseudoPath, file);
  }

  private loadState(): AndroidPersistedState {
    const defaults: AndroidPersistedState = {
      deviceId: crypto.randomUUID(),
      apiId: null,
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
    };
    try {
      const raw = localStorage.getItem(STATE_STORAGE_KEY);
      if (raw) {
        return { ...defaults, ...(JSON.parse(raw) as Partial<AndroidPersistedState>) };
      }
    } catch {
      // ignore
    }
    return defaults;
  }

  private saveState(): void {
    this.state.vaultData = this.vault.exportPersisted();
    try {
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // ignore quota errors
    }
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

  private async getWasmBytes(): Promise<Uint8Array> {
    this.wasmBytesPromise ??= fetch(mtcuteWasmUrl)
      .then(r => r.arrayBuffer())
      .then(buf => new Uint8Array(buf));
    return this.wasmBytesPromise;
  }

  private async ensureClient(apiId?: number, apiHash?: string): Promise<TelegramClient> {
    const resolvedId = apiId ?? this.state.apiId ?? this.pendingAuth.apiId ?? 0;
    const resolvedHash =
      apiHash || (await this.loadSecret('api_hash')) || this.pendingAuth.apiHash || '';

    if (!resolvedId || !resolvedHash) {
      throw new Error('API_CREDENTIALS_MISSING');
    }

    if (this.client && this.state.apiId === resolvedId) {
      return this.client;
    }

    if (this.client) {
      await this.client.destroy().catch(() => undefined);
      this.client = null;
    }

    this.state.apiId = resolvedId;
    this.saveState();

    const wasmBytes = await this.getWasmBytes();
    const baseClient = new BaseTelegramClient({
      apiId: resolvedId,
      apiHash: resolvedHash,
      storage: new IdbStorage('telegram-drive-mtproto-session'),
      crypto: new WebCryptoProvider({ wasmInput: wasmBytes }),
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
    return this.client;
  }

  private async getOwnerId(): Promise<string> {
    if (this.currentUserId) return this.currentUserId;
    const client = await this.ensureClient();
    const me = await client.getMe();
    this.currentUserId = String(me.id);
    return this.currentUserId;
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

  private async listFiles(folderId: number | null): Promise<MappedTelegramFile[]> {
    const client = await this.ensureClient();
    const peer = folderIdToPeer(folderId);
    const out: MappedTelegramFile[] = [];
    let offset: { id: number; date: number } | undefined;

    for (let page = 0; page < 4; page++) {
      const history = await client.getHistory(peer, { limit: 100, offset });
      if (history.length === 0) break;
      for (const msg of history) {
        const key = fileCompositeKey(folderId, msg.id);
        const mapped = mapMessageToTelegramFile(msg, folderId, {
          customName: this.state.fileRenames[key],
          favorite: this.state.favorites.includes(key),
          encryptedRecord: this.vault.getEncryptedFileRecord(key),
        });
        if (mapped) out.push(mapped);
      }
      if (!history.next) break;
      offset = history.next;
    }

    this.filesCache.set(String(folderId ?? 'saved'), out);
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
    switch (cmd) {
      case 'cmd_get_startup_health':
        return { ok: true, streaming_port: 14201 };

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
        return null;

      case 'cmd_connect':
        await this.ensureClient(Number(args.apiId));
        return true;

      case 'cmd_check_connection': {
        try {
          const client = await this.ensureClient();
          const me = await client.getMe();
          this.currentUserId = String(me.id);
          return true;
        } catch {
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
        try {
          const user = await client.signIn({
            phone: this.pendingAuth.phone!,
            phoneCodeHash: this.pendingAuth.phoneCodeHash!,
            phoneCode: String(args.code ?? '').trim(),
          });
          this.currentUserId = String(user.id);
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
          this.qrState.providePassword(pw);
          return { success: true };
        }
        const client = await this.ensureClient();
        const user = await client.checkPassword(pw);
        this.currentUserId = String(user.id);
        return { success: true };
      }

      case 'cmd_auth_qr_login': {
        const apiId = Number(args.apiId);
        const apiHash = String(args.apiHash ?? '').trim();
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
          const timer = window.setTimeout(() => reject(new Error('QR_GENERATION_TIMEOUT')), 20_000);
          void client
            .signInQr({
              abortSignal: abort.signal,
              onUrlUpdated: url => {
                this.qrState.latestUrl = url;
                window.clearTimeout(timer);
                resolve(url);
              },
              password: () =>
                new Promise<string>(resPw => {
                  this.qrState.needsPassword = true;
                  this.qrState.providePassword = resPw;
                }),
            })
            .then(user => {
              this.currentUserId = String(user.id);
              this.qrState.authorized = true;
            })
            .catch(err => {
              window.clearTimeout(timer);
              this.qrState.error = err instanceof Error ? err.message : String(err);
              reject(err);
            });
        });
      }

      case 'cmd_auth_qr_poll':
        if (this.qrState.authorized) return { success: true };
        if (this.qrState.needsPassword) return { success: true, next_step: 'password' };
        if (this.qrState.error) throw new Error(this.qrState.error);
        return { success: false, url: this.qrState.latestUrl };

      case 'cmd_logout': {
        let revoked = false;
        if (this.client) {
          try {
            await this.client.logOut();
            revoked = true;
          } catch {
            // ignore offline error
          }
          await this.client.destroy().catch(() => undefined);
          this.client = null;
        }
        this.currentUserId = null;
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

      case 'cmd_set_folder_group': {
        const f = this.state.folders.find(i => i.id === Number(args.folderId));
        if (f) f.group_id = args.groupId === null || args.groupId === undefined ? null : Number(args.groupId);
        this.saveState();
        return null;
      }

      case 'cmd_get_groups':
        return [...this.state.groups].sort((a, b) => a.sort_order - b.sort_order);

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
        this.saveState();
        return null;
      }

      // ── Files, Thumbnails, Previews & Transfers ────────────────────
      case 'cmd_get_files':
        return await this.listFiles(
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId),
        );

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
        const client = await this.ensureClient();
        await client.deleteMessagesById(folderIdToPeer(folderId), [messageId], { revoke: true });
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
        await client.forwardMessagesById({
          fromChatId: folderIdToPeer(src),
          toChatId: folderIdToPeer(dst),
          messages: ids,
          noAuthor: true,
        });
        await client.deleteMessagesById(folderIdToPeer(src), ids, { revoke: true });
        return null;
      }

      case 'cmd_get_thumbnail': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const cacheKey = `thumb:${folderId ?? 'saved'}:${messageId}`;
        if (this.blobUrlCache.has(cacheKey)) return this.blobUrlCache.get(cacheKey)!;

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

      case 'cmd_get_preview': {
        const folderId =
          args.folderId === null || args.folderId === undefined ? null : Number(args.folderId);
        const messageId = Number(args.messageId);
        const cacheKey = `prev:${folderId ?? 'saved'}:${messageId}`;
        if (this.blobUrlCache.has(cacheKey)) return this.blobUrlCache.get(cacheKey)!;

        const msg = await this.fetchMessage(folderId, messageId);
        const key = fileCompositeKey(folderId, messageId);
        const mapped = mapMessageToTelegramFile(msg, folderId, {
          customName: this.state.fileRenames[key],
          encryptedRecord: this.vault.getEncryptedFileRecord(key),
        });
        const rawBytes = await this.downloadRawBytes(folderId, messageId);
        const plain = VaultRuntime.hasEncryptedMagic(rawBytes)
          ? this.vault.decryptBuffer(rawBytes, {
              promptToken: typeof args.promptToken === 'number' ? args.promptToken : undefined,
            }).plaintext
          : rawBytes;
        const mime = mapped?.mime_type || guessMimeType(mapped?.name ?? '');
        const url = URL.createObjectURL(new Blob([plain as unknown as BlobPart], { type: mime }));
        this.blobUrlCache.set(cacheKey, url);
        return url;
      }

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
        const abort = new AbortController();
        this.activeAborts.set(transferId, abort);

        try {
          let fileBytes: Uint8Array;
          let originalName = rawPath.split(/[\\/]/).pop() || 'upload.bin';

          const browserFile = this.pendingFilesByPath.get(rawPath);
          if (browserFile) {
            originalName = browserFile.name;
            fileBytes = new Uint8Array(await browserFile.arrayBuffer());
          } else if (isAndroidNative()) {
            const readRes = await TelegramDriveNative.readFileBase64({ path: rawPath });
            originalName = readRes.name || originalName;
            fileBytes = base64ToUint8(readRes.data);
          } else {
            throw new Error('FILE_UNREADABLE');
          }

          const protectionMode = (req.protection_mode ?? args.protectionMode) as string | undefined;
          const isEncrypted = protectionMode === 'vault' || protectionMode === 'passphrase';
          let uploadData = fileBytes;
          let uploadName = originalName;
          let vaultId: string | undefined;

          if (isEncrypted) {
            const enc = this.vault.encryptBuffer(fileBytes, {
              mode: protectionMode === 'passphrase' ? 'passphrase' : 'vault',
              promptToken: (req.prompt_token ?? args.promptToken) as number | undefined,
              originalName,
              originalMime: guessMimeType(originalName),
              protectMetadata: Boolean(req.protect_metadata ?? args.protectMetadata),
            });
            uploadData = enc.ciphertext;
            uploadName = enc.uploadFileName;
            vaultId = enc.vaultId;
          }

          const client = await this.ensureClient();
          const t0 = Date.now();
          const uploaded = await client.uploadFile({
            file: uploadData,
            fileName: uploadName,
            fileSize: uploadData.byteLength,
            fileMime: isEncrypted ? 'application/octet-stream' : guessMimeType(originalName),
            abortSignal: abort.signal,
            progressCallback: (done, tot) => {
              const speed = Math.round(done / Math.max(0.1, (Date.now() - t0) / 1000));
              dispatchLocalEvent('upload-progress', {
                id: transferId,
                progress: tot > 0 ? Math.min(99, Math.round((done / tot) * 100)) : 0,
                uploaded_bytes: done,
                total_bytes: tot || uploadData.byteLength,
                speed_bytes_per_sec: speed,
              });
            },
          });

          const sent = await client.sendMedia(folderIdToPeer(folderId), {
            type: 'document',
            file: uploaded,
            fileName: uploadName,
            caption: isEncrypted ? '' : originalName,
          });
          this.state.bandwidth.uploaded += uploadData.byteLength;

          if (isEncrypted) {
            this.vault.registerEncryptedFile({
              key: fileCompositeKey(folderId, sent.id),
              mode: protectionMode === 'passphrase' ? 'passphrase' : 'vault',
              vaultId,
              originalName,
              originalSize: fileBytes.byteLength,
              protectMetadata: Boolean(req.protect_metadata ?? args.protectMetadata),
            });
          }
          this.saveState();
          dispatchLocalEvent('upload-progress', {
            id: transferId,
            progress: 100,
            uploaded_bytes: uploadData.byteLength,
            total_bytes: uploadData.byteLength,
            speed_bytes_per_sec: 0,
          });
          return sent.id;
        } finally {
          this.activeAborts.delete(transferId);
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
        const abort = new AbortController();
        this.activeAborts.set(transferId, abort);

        try {
          const t0 = Date.now();
          const rawBytes = await this.downloadRawBytes(
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
          );
          const plain = VaultRuntime.hasEncryptedMagic(rawBytes)
            ? this.vault.decryptBuffer(rawBytes, {
                promptToken: (req.prompt_token ?? args.promptToken) as number | undefined,
              }).plaintext
            : rawBytes;

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
        }
      }

      case 'cmd_cancel_transfer': {
        this.activeAborts.get(String(args.transferId ?? args.id ?? ''))?.abort();
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
        const res = this.vault.updateSettings((args.settings as Partial<VaultStateSettings>) ?? {});
        this.saveState();
        return res;
      }
      case 'cmd_create_vault':
        this.vault.createVault(String(args.passphrase ?? ''));
        this.saveState();
        return null;
      case 'cmd_unlock_vault':
        return this.vault.unlock(String(args.passphrase ?? ''));
      case 'cmd_lock_vault':
        this.vault.lock();
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
      case 'cmd_export_vault_recovery':
        return this.vault.exportVaultRecovery(String(args.currentPassphrase ?? ''), String(args.recoveryKey ?? ''));
      case 'cmd_verify_vault_recovery':
        return this.vault.verifyVaultRecovery(String(args.recoveryJson ?? ''), String(args.recoveryKey ?? ''));
      case 'cmd_import_vault_recovery':
        this.vault.importVaultRecovery(
          String(args.recoveryJson ?? ''),
          String(args.recoveryKey ?? ''),
          String(args.newPassphrase ?? ''),
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
        return {
          network_connected: navigator.onLine !== false,
          wifi_connected: true,
          roaming: false,
          metered: false,
          battery_percent: 100,
          charging: true,
          power_save_mode: false,
          available_storage_bytes: 16 * 1024 * 1024 * 1024,
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

      case 'cmd_get_bandwidth':
        return {
          uploaded_bytes: this.state.bandwidth.uploaded,
          downloaded_bytes: this.state.bandwidth.downloaded,
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
