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
    this.vault.loadPersisted(this.state.vaultData);
  }

  public registerBrowserSelectedFile(pseudoPath: string, file: File): void {
    this.pendingFilesByPath.set(pseudoPath, file);
  }

  private loadState(): AndroidPersistedState {
    const defaults: AndroidPersistedState = {
      deviceId: crypto.randomUUID(),
      apiId: null,
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

    for (let page = 0; page < 4; page++) {
      const history = await client.getHistory(peer, { limit: 100, offset });
      if (history.length === 0) break;
      const pageFiles: MappedTelegramFile[] = [];
      for (const msg of history) {
        const key = fileCompositeKey(folderId, msg.id);
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
        this.currentApiHash = null;
        return null;

      case 'cmd_connect':
        await this.ensureClient(Number(args.apiId));
        return true;

      case 'cmd_check_connection': {
        try {
          if (this.state.hasAuthorizedSession === false && !this.currentUserId) {
            return false;
          }
          const client = await this.ensureClient();
          const me = await client.getMe();
          this.currentUserId = String(me.id);
          this.state.hasAuthorizedSession = true;
          this.saveState();
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
        this.state.hasAuthorizedSession = true;
        this.saveState();
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
          let settledFirstUrl = false;
          const timer = window.setTimeout(() => {
            if (!settledFirstUrl) {
              settledFirstUrl = true;
              abort.abort();
              reject(new Error('QR_GENERATION_TIMEOUT'));
            }
          }, 20_000);

          void client
            .signInQr({
              abortSignal: abort.signal,
              onUrlUpdated: url => {
                this.qrState.latestUrl = url;
                if (!settledFirstUrl) {
                  settledFirstUrl = true;
                  window.clearTimeout(timer);
                  resolve(url);
                }
              },
              password: () =>
                new Promise<string>(resPw => {
                  this.qrState.needsPassword = true;
                  this.qrState.providePassword = resPw;
                }),
              invalidPasswordCallback: () => {
                const pending = this.qrState.pendingPasswordResult;
                this.qrState.pendingPasswordResult = undefined;
                pending?.reject(new Error('PASSWORD_HASH_INVALID'));
              },
            })
            .then(user => {
              this.currentUserId = String(user.id);
              this.state.hasAuthorizedSession = true;
              this.saveState();
              this.qrState.authorized = true;
              const pending = this.qrState.pendingPasswordResult;
              this.qrState.pendingPasswordResult = undefined;
              pending?.resolve();
            })
            .catch(err => {
              window.clearTimeout(timer);
              const normalized = err instanceof Error ? err : new Error(String(err));
              this.qrState.error = normalized.message;
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
        this.state.hasAuthorizedSession = false;
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

      case 'cmd_get_display_preview':
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
          vaultUnlocked: this.vault.getStatus().is_unlocked,
        });
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
        const mime = mapped?.mime_type || guessMimeType(mapped?.name ?? '');
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
        const abort = new AbortController();
        this.activeAborts.set(transferId, abort);

        try {
          const protectionMode = (req.protection_mode ?? args.protectionMode) as string | undefined;
          const isEncrypted = protectionMode === 'vault' || protectionMode === 'passphrase';
          let originalName = rawPath.split(/[\\/]/).pop() || 'upload.bin';
          let originalSize = 0;
          let uploadSource: File | Uint8Array;
          let uploadByteLength = 0;
          let uploadName = originalName;
          let vaultId: string | undefined;

          const browserFile = this.pendingFilesByPath.get(rawPath);
          if (browserFile && !isEncrypted) {
            originalName = browserFile.name;
            originalSize = browserFile.size;
            uploadName = originalName;
            uploadSource = browserFile;
            uploadByteLength = browserFile.size;
          } else {
            let fileBytes: Uint8Array;
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
            originalSize = fileBytes.byteLength;
            uploadSource = fileBytes;
            uploadByteLength = fileBytes.byteLength;
            uploadName = originalName;

            if (isEncrypted) {
              const enc = this.vault.encryptBuffer(fileBytes, {
                mode: protectionMode === 'passphrase' ? 'passphrase' : 'vault',
                promptToken: (req.prompt_token ?? args.promptToken) as number | undefined,
                originalName,
                originalMime: guessMimeType(originalName),
                protectMetadata: Boolean(req.protect_metadata ?? args.protectMetadata),
              });
              uploadSource = enc.ciphertext;
              uploadByteLength = enc.ciphertext.byteLength;
              uploadName = enc.uploadFileName;
              vaultId = enc.vaultId;
            }
          }

          const client = await this.ensureClient();
          const t0 = Date.now();
          const uploaded = await client.uploadFile({
            file: uploadSource,
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

          const sent = await client.sendMedia(folderIdToPeer(folderId), {
            type: 'document',
            file: uploaded,
            fileName: uploadName,
            caption: isEncrypted ? '' : originalName,
          });
          this.state.bandwidth.uploaded += uploadByteLength;

          if (isEncrypted) {
            this.vault.registerEncryptedFile({
              key: fileCompositeKey(folderId, sent.id),
              mode: protectionMode === 'passphrase' ? 'passphrase' : 'vault',
              vaultId,
              originalName,
              originalSize,
              protectMetadata: Boolean(req.protect_metadata ?? args.protectMetadata),
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
          limit_bytes: 0,
          period: 'weekly',
          uploaded_bytes: this.state.bandwidth.uploaded,
          downloaded_bytes: this.state.bandwidth.downloaded,
        };

      case 'cmd_set_weekly_quota':
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

      case 'cmd_get_stream_info':
        return null;

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
