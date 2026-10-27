import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const FILE_MAGIC = new Uint8Array([0x54, 0x47, 0x44, 0x31]); // "TGD1"
const PBKDF2_ITERATIONS = 210_000;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function deriveKeyFromPassphrase(passphrase: string, salt: Uint8Array): Uint8Array {
  return pbkdf2(sha256, utf8ToBytes(passphrase.normalize('NFKC')), salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: 32,
  });
}

function deriveSubkey(masterKey: Uint8Array, info: string, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKey, salt, utf8ToBytes(info), 32);
}

function sealBytes(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce, aad);
  const encrypted = cipher.encrypt(plaintext);
  const out = new Uint8Array(24 + encrypted.length);
  out.set(nonce, 0);
  out.set(encrypted, 24);
  return out;
}

function openBytes(key: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (sealed.length < 24 + 16) {
    throw new Error('INVALID_CIPHERTEXT');
  }
  const nonce = sealed.subarray(0, 24);
  const ciphertext = sealed.subarray(24);
  const cipher = xchacha20poly1305(key, nonce, aad);
  return cipher.decrypt(ciphertext);
}

export interface PersistedVaultRecord {
  vaultId: string;
  createdAt: string;
  saltHex: string;
  wrappedMasterKeyB64: string;
  fingerprint: string;
}

export interface VaultStateSettings {
  defaultUploadMode: 'standard' | 'vault' | 'passphrase';
  protectMetadata: boolean;
  lockTimeoutMinutes: number;
  lockOnSleep: boolean;
}

export const DEFAULT_VAULT_SETTINGS: VaultStateSettings = {
  defaultUploadMode: 'standard',
  protectMetadata: false,
  lockTimeoutMinutes: 15,
  lockOnSleep: true,
};

export interface FileCipherHeader {
  v: 1;
  mode: 'vault' | 'passphrase';
  vaultId?: string;
  saltB64: string;
  originalName: string;
  originalMime?: string;
  originalSize: number;
  protectMetadata: boolean;
}

export interface EncryptedFileRecord {
  key: string;
  mode: 'vault' | 'passphrase';
  vaultId?: string;
  originalName: string;
  originalSize: number;
  protectMetadata: boolean;
}

export class VaultRuntime {
  private vault: PersistedVaultRecord | null = null;
  private unlockedMasterKey: Uint8Array | null = null;
  private sessionId: number | null = null;
  private nextSessionId = 1;
  private lastActivityMs = Date.now();
  private settings: VaultStateSettings = { ...DEFAULT_VAULT_SETTINGS };
  private stagedPassphrases = new Map<number, { passphrase: string; expiresAt: number }>();
  private nextPromptToken = 1000;
  private encryptedFiles = new Map<string, EncryptedFileRecord>();

  loadPersisted(data: {
    vault?: PersistedVaultRecord | null;
    settings?: Partial<VaultStateSettings> | null;
    encryptedFiles?: EncryptedFileRecord[] | null;
  }): void {
    this.vault = data.vault ?? null;
    if (data.settings) {
      this.settings = { ...DEFAULT_VAULT_SETTINGS, ...data.settings };
    }
    this.encryptedFiles.clear();
    for (const rec of data.encryptedFiles ?? []) {
      this.encryptedFiles.set(rec.key, rec);
    }
  }

  exportPersisted(): {
    vault: PersistedVaultRecord | null;
    settings: VaultStateSettings;
    encryptedFiles: EncryptedFileRecord[];
  } {
    return {
      vault: this.vault,
      settings: { ...this.settings },
      encryptedFiles: [...this.encryptedFiles.values()],
    };
  }

  private checkIdleTimeout(): void {
    if (!this.unlockedMasterKey) return;
    const timeoutMin = this.settings.lockTimeoutMinutes;
    if (timeoutMin > 0 && Date.now() - this.lastActivityMs > timeoutMin * 60_000) {
      this.lock();
    }
  }

  recordActivity(): void {
    this.checkIdleTimeout();
    if (this.unlockedMasterKey) {
      this.lastActivityMs = Date.now();
    }
  }

  getSettings(): VaultStateSettings {
    return { ...this.settings };
  }

  updateSettings(next: Partial<VaultStateSettings>): VaultStateSettings {
    this.settings = { ...this.settings, ...next };
    return this.getSettings();
  }

  getStatus() {
    this.checkIdleTimeout();
    if (!this.vault) {
      return {
        state: 'uninitialized' as const,
        vaultId: null,
        sessionId: null,
      };
    }
    if (this.unlockedMasterKey && this.sessionId !== null) {
      return {
        state: 'unlocked' as const,
        vaultId: this.vault.vaultId,
        sessionId: this.sessionId,
      };
    }
    return {
      state: 'locked' as const,
      vaultId: this.vault.vaultId,
      sessionId: null,
    };
  }

  getCapabilities() {
    return {
      supported: true,
      algorithms: ['XChaCha20-Poly1305', 'PBKDF2-HMAC-SHA256', 'HKDF-SHA256'],
      streamingDecryption: true,
      metadataProtection: true,
      recoveryKit: true,
    };
  }

  getInventory() {
    let vaultProtectedFiles = 0;
    let passphraseProtectedFiles = 0;
    for (const rec of this.encryptedFiles.values()) {
      if (rec.mode === 'vault') vaultProtectedFiles++;
      else passphraseProtectedFiles++;
    }
    return {
      vaultConfigured: Boolean(this.vault),
      vaultUnlocked: Boolean(this.unlockedMasterKey),
      vaultId: this.vault?.vaultId ?? null,
      vaultFingerprint: this.vault?.fingerprint ?? null,
      vaultProtectedFiles,
      passphraseProtectedFiles,
      legacyEncryptedFiles: 0,
    };
  }

  createVault(passphrase: string): void {
    if (!passphrase || passphrase.length < 6) {
      throw new Error('VAULT_PASSPHRASE_TOO_SHORT');
    }
    const masterKey = randomBytes(32);
    const salt = randomBytes(16);
    const wrappingKey = deriveKeyFromPassphrase(passphrase, salt);
    const vaultId = bytesToHex(randomBytes(8));
    const wrapped = sealBytes(wrappingKey, masterKey, utf8ToBytes(vaultId));
    const fingerprint = bytesToHex(sha256(masterKey)).slice(0, 16).toUpperCase();
    this.vault = {
      vaultId,
      createdAt: new Date().toISOString(),
      saltHex: bytesToHex(salt),
      wrappedMasterKeyB64: toBase64(wrapped),
      fingerprint,
    };
    this.unlockedMasterKey = masterKey;
    this.sessionId = this.nextSessionId++;
    this.lastActivityMs = Date.now();
  }

  unlock(passphrase: string): number {
    if (!this.vault) {
      throw new Error('VAULT_NOT_INITIALIZED');
    }
    const salt = hexToBytes(this.vault.saltHex);
    const wrappingKey = deriveKeyFromPassphrase(passphrase, salt);
    const wrapped = fromBase64(this.vault.wrappedMasterKeyB64);
    let masterKey: Uint8Array;
    try {
      masterKey = openBytes(wrappingKey, wrapped, utf8ToBytes(this.vault.vaultId));
    } catch {
      throw new Error('INVALID_PASSPHRASE');
    }
    this.unlockedMasterKey = masterKey;
    this.sessionId = this.nextSessionId++;
    this.lastActivityMs = Date.now();
    return this.sessionId;
  }

  lock(): void {
    if (this.unlockedMasterKey) {
      this.unlockedMasterKey.fill(0);
    }
    this.unlockedMasterKey = null;
    this.sessionId = null;
  }

  changePassphrase(currentPassphrase: string, newPassphrase: string): void {
    if (!this.vault) throw new Error('VAULT_NOT_INITIALIZED');
    if (!newPassphrase || newPassphrase.length < 6) {
      throw new Error('VAULT_PASSPHRASE_TOO_SHORT');
    }
    const oldSalt = hexToBytes(this.vault.saltHex);
    const oldWrappingKey = deriveKeyFromPassphrase(currentPassphrase, oldSalt);
    let masterKey: Uint8Array;
    try {
      masterKey = openBytes(
        oldWrappingKey,
        fromBase64(this.vault.wrappedMasterKeyB64),
        utf8ToBytes(this.vault.vaultId),
      );
    } catch {
      throw new Error('INVALID_PASSPHRASE');
    }
    const newSalt = randomBytes(16);
    const newWrappingKey = deriveKeyFromPassphrase(newPassphrase, newSalt);
    const rewrapped = sealBytes(newWrappingKey, masterKey, utf8ToBytes(this.vault.vaultId));
    this.vault = {
      ...this.vault,
      saltHex: bytesToHex(newSalt),
      wrappedMasterKeyB64: toBase64(rewrapped),
    };
    this.unlockedMasterKey = masterKey;
    if (this.sessionId === null) {
      this.sessionId = this.nextSessionId++;
    }
    this.lastActivityMs = Date.now();
  }

  generateRecoveryKey(): string {
    const raw = randomBytes(32);
    const groups: string[] = [];
    for (let g = 0; g < 8; g++) {
      let chunk = '';
      for (let i = 0; i < 4; i++) {
        chunk += RECOVERY_ALPHABET[raw[g * 4 + i] % RECOVERY_ALPHABET.length];
      }
      groups.push(chunk);
    }
    return groups.join('-');
  }

  private normalizeRecoveryKey(recoveryKey: string): string {
    return recoveryKey.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  }

  exportVaultRecovery(currentPassphrase: string, recoveryKey: string): string {
    if (!this.vault) throw new Error('VAULT_NOT_INITIALIZED');
    const oldSalt = hexToBytes(this.vault.saltHex);
    const oldWrappingKey = deriveKeyFromPassphrase(currentPassphrase, oldSalt);
    let masterKey: Uint8Array;
    try {
      masterKey = openBytes(
        oldWrappingKey,
        fromBase64(this.vault.wrappedMasterKeyB64),
        utf8ToBytes(this.vault.vaultId),
      );
    } catch {
      throw new Error('INVALID_PASSPHRASE');
    }
    const kitSalt = randomBytes(16);
    const recoveryWrapKey = deriveKeyFromPassphrase(this.normalizeRecoveryKey(recoveryKey), kitSalt);
    const sealedMaster = sealBytes(recoveryWrapKey, masterKey, utf8ToBytes(this.vault.vaultId));
    return JSON.stringify(
      {
        format: 'telegram-drive-recovery-v1',
        vaultId: this.vault.vaultId,
        fingerprint: this.vault.fingerprint,
        createdAt: new Date().toISOString(),
        saltHex: bytesToHex(kitSalt),
        sealedMasterKeyB64: toBase64(sealedMaster),
      },
      null,
      2,
    );
  }

  verifyVaultRecovery(recoveryJson: string, recoveryKey: string) {
    const parsed = JSON.parse(recoveryJson) as {
      format?: string;
      vaultId?: string;
      fingerprint?: string;
      createdAt?: string;
      saltHex?: string;
      sealedMasterKeyB64?: string;
    };
    if (
      parsed.format !== 'telegram-drive-recovery-v1' ||
      !parsed.vaultId ||
      !parsed.saltHex ||
      !parsed.sealedMasterKeyB64
    ) {
      throw new Error('INVALID_RECOVERY_KIT');
    }
    const recoveryWrapKey = deriveKeyFromPassphrase(
      this.normalizeRecoveryKey(recoveryKey),
      hexToBytes(parsed.saltHex),
    );
    let masterKey: Uint8Array;
    try {
      masterKey = openBytes(
        recoveryWrapKey,
        fromBase64(parsed.sealedMasterKeyB64),
        utf8ToBytes(parsed.vaultId),
      );
    } catch {
      throw new Error('INVALID_RECOVERY_KEY');
    }
    const fingerprint = bytesToHex(sha256(masterKey)).slice(0, 16).toUpperCase();
    masterKey.fill(0);
    return {
      vaultId: parsed.vaultId,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      fingerprint,
      matchesExistingVault: Boolean(this.vault && this.vault.vaultId === parsed.vaultId),
    };
  }

  importVaultRecovery(recoveryJson: string, recoveryKey: string, newPassphrase: string): void {
    if (!newPassphrase || newPassphrase.length < 6) {
      throw new Error('VAULT_PASSPHRASE_TOO_SHORT');
    }
    const parsed = JSON.parse(recoveryJson) as {
      format?: string;
      vaultId: string;
      createdAt?: string;
      saltHex: string;
      sealedMasterKeyB64: string;
    };
    if (parsed.format !== 'telegram-drive-recovery-v1') {
      throw new Error('INVALID_RECOVERY_KIT');
    }
    const recoveryWrapKey = deriveKeyFromPassphrase(
      this.normalizeRecoveryKey(recoveryKey),
      hexToBytes(parsed.saltHex),
    );
    let masterKey: Uint8Array;
    try {
      masterKey = openBytes(
        recoveryWrapKey,
        fromBase64(parsed.sealedMasterKeyB64),
        utf8ToBytes(parsed.vaultId),
      );
    } catch {
      throw new Error('INVALID_RECOVERY_KEY');
    }
    const newSalt = randomBytes(16);
    const newWrappingKey = deriveKeyFromPassphrase(newPassphrase, newSalt);
    const wrapped = sealBytes(newWrappingKey, masterKey, utf8ToBytes(parsed.vaultId));
    const fingerprint = bytesToHex(sha256(masterKey)).slice(0, 16).toUpperCase();
    this.vault = {
      vaultId: parsed.vaultId,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      saltHex: bytesToHex(newSalt),
      wrappedMasterKeyB64: toBase64(wrapped),
      fingerprint,
    };
    this.unlockedMasterKey = masterKey;
    this.sessionId = this.nextSessionId++;
    this.lastActivityMs = Date.now();
  }

  stagePassphrase(passphrase: string): number {
    const now = Date.now();
    for (const [tok, entry] of this.stagedPassphrases.entries()) {
      if (entry.expiresAt <= now) this.stagedPassphrases.delete(tok);
    }
    const token = this.nextPromptToken++;
    this.stagedPassphrases.set(token, {
      passphrase,
      expiresAt: now + 15 * 60_000,
    });
    return token;
  }

  consumeStagedPassphrase(token?: number | null): string | null {
    if (typeof token !== 'number') return null;
    const entry = this.stagedPassphrases.get(token);
    if (!entry) return null;
    this.stagedPassphrases.delete(token);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.passphrase;
  }

  registerEncryptedFile(record: EncryptedFileRecord): void {
    this.encryptedFiles.set(record.key, record);
  }

  removeEncryptedFile(key: string): void {
    this.encryptedFiles.delete(key);
  }

  getEncryptedFileRecord(key: string): EncryptedFileRecord | undefined {
    return this.encryptedFiles.get(key);
  }

  getFileEncryptionInfo(folderId: number | null | undefined, messageId: number) {
    const key = `${folderId ?? 'saved'}:${messageId}`;
    const rec = this.encryptedFiles.get(key);
    if (!rec) {
      return {
        state: 'plain' as const,
        requiresVaultUnlock: false,
        requiresPassphrase: false,
        protectMetadata: false,
      };
    }
    const isVault = rec.mode === 'vault';
    this.checkIdleTimeout();
    return {
      state: isVault ? ('encrypted_v2_vault' as const) : ('encrypted_v2_passphrase' as const),
      requiresVaultUnlock: isVault && !this.unlockedMasterKey,
      requiresPassphrase: !isVault,
      protectMetadata: rec.protectMetadata,
      vaultId: rec.vaultId ?? null,
    };
  }

  encryptBuffer(
    plaintext: Uint8Array,
    opts: {
      mode: 'vault' | 'passphrase';
      promptToken?: number | null;
      passphrase?: string | null;
      originalName: string;
      originalMime?: string;
      protectMetadata?: boolean;
    },
  ): { ciphertext: Uint8Array; uploadFileName: string; vaultId?: string } {
    const salt = randomBytes(16);
    let fileKey: Uint8Array;
    let vaultId: string | undefined;

    if (opts.mode === 'vault') {
      this.checkIdleTimeout();
      if (!this.vault || !this.unlockedMasterKey) {
        throw new Error('VAULT_LOCKED');
      }
      vaultId = this.vault.vaultId;
      fileKey = deriveSubkey(this.unlockedMasterKey, 'telegram-drive-file-v1', salt);
      this.lastActivityMs = Date.now();
    } else {
      const pass = opts.passphrase ?? this.consumeStagedPassphrase(opts.promptToken);
      if (!pass) {
        throw new Error('PASSPHRASE_REQUIRED');
      }
      fileKey = deriveKeyFromPassphrase(pass, salt);
    }

    const headerObj: FileCipherHeader = {
      v: 1,
      mode: opts.mode,
      vaultId,
      saltB64: toBase64(salt),
      originalName: opts.originalName,
      originalMime: opts.originalMime,
      originalSize: plaintext.byteLength,
      protectMetadata: Boolean(opts.protectMetadata),
    };
    const headerJson = utf8ToBytes(JSON.stringify(headerObj));
    const publicPrefix = utf8ToBytes(
      JSON.stringify({
        m: opts.mode,
        s: toBase64(salt),
        v: vaultId ?? null,
      }),
    );
    const sealedHeader = sealBytes(fileKey, headerJson, FILE_MAGIC);
    const sealedBody = sealBytes(fileKey, plaintext, sealedHeader.subarray(0, 24));

    // Layout: "TGD1" (4) | prefixLen u32be (4) | prefix | headerLen u32be (4) | sealedHeader | sealedBody
    const total = 4 + 4 + publicPrefix.length + 4 + sealedHeader.length + sealedBody.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set(FILE_MAGIC, 0);
    view.setUint32(4, publicPrefix.length, false);
    out.set(publicPrefix, 8);
    const hOffset = 8 + publicPrefix.length;
    view.setUint32(hOffset, sealedHeader.length, false);
    out.set(sealedHeader, hOffset + 4);
    out.set(sealedBody, hOffset + 4 + sealedHeader.length);

    const uploadFileName = opts.protectMetadata
      ? `vault-${bytesToHex(randomBytes(6))}.tgd`
      : `${opts.originalName}.tgd`;

    return { ciphertext: out, uploadFileName, vaultId };
  }

  static hasEncryptedMagic(buf: Uint8Array): boolean {
    return (
      buf.byteLength >= 16 &&
      buf[0] === FILE_MAGIC[0] &&
      buf[1] === FILE_MAGIC[1] &&
      buf[2] === FILE_MAGIC[2] &&
      buf[3] === FILE_MAGIC[3]
    );
  }

  decryptBuffer(
    ciphertext: Uint8Array,
    opts?: { promptToken?: number | null; passphrase?: string | null },
  ): { plaintext: Uint8Array; header: FileCipherHeader } {
    if (!VaultRuntime.hasEncryptedMagic(ciphertext)) {
      return {
        plaintext: ciphertext,
        header: {
          v: 1,
          mode: 'vault',
          saltB64: '',
          originalName: '',
          originalSize: ciphertext.byteLength,
          protectMetadata: false,
        },
      };
    }

    const view = new DataView(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength);
    const prefixLen = view.getUint32(4, false);
    const prefixEnd = 8 + prefixLen;
    if (prefixEnd + 4 > ciphertext.byteLength) {
      throw new Error('CORRUPTED_ENCRYPTED_FILE');
    }
    const prefix = JSON.parse(new TextDecoder().decode(ciphertext.subarray(8, prefixEnd))) as {
      m: 'vault' | 'passphrase';
      s: string;
      v?: string | null;
    };
    const salt = fromBase64(prefix.s);
    const headerLen = view.getUint32(prefixEnd, false);
    const headerStart = prefixEnd + 4;
    const headerEnd = headerStart + headerLen;
    if (headerEnd > ciphertext.byteLength) {
      throw new Error('CORRUPTED_ENCRYPTED_FILE');
    }
    const sealedHeader = ciphertext.subarray(headerStart, headerEnd);
    const sealedBody = ciphertext.subarray(headerEnd);

    let fileKey: Uint8Array;
    if (prefix.m === 'vault') {
      this.checkIdleTimeout();
      if (!this.unlockedMasterKey) {
        throw new Error('VAULT_LOCKED');
      }
      fileKey = deriveSubkey(this.unlockedMasterKey, 'telegram-drive-file-v1', salt);
      this.lastActivityMs = Date.now();
    } else {
      const pass = opts?.passphrase ?? this.consumeStagedPassphrase(opts?.promptToken);
      if (!pass) {
        throw new Error('PASSPHRASE_REQUIRED');
      }
      fileKey = deriveKeyFromPassphrase(pass, salt);
    }

    let headerBytes: Uint8Array;
    try {
      headerBytes = openBytes(fileKey, sealedHeader, FILE_MAGIC);
    } catch {
      throw new Error(prefix.m === 'vault' ? 'VAULT_KEY_MISMATCH' : 'INVALID_PASSPHRASE');
    }
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as FileCipherHeader;
    const plaintext = openBytes(fileKey, sealedBody, sealedHeader.subarray(0, 24));
    return { plaintext, header };
  }
}

export function encryptSettingsSyncPayload(
  settings: Record<string, unknown>,
  passphrase: string,
  deviceId: string,
): { payloadText: string; updatedAt: number } {
  if (!passphrase || passphrase.length < 4) {
    throw new Error('PASSPHRASE_REQUIRED');
  }
  const updatedAt = Date.now();
  const salt = randomBytes(16);
  const key = deriveKeyFromPassphrase(passphrase, salt);
  const inner = utf8ToBytes(JSON.stringify({ settings, updatedAt, deviceId }));
  const sealed = sealBytes(key, inner, utf8ToBytes('TDSS1'));
  const envelope = {
    marker: '#TG_DRIVE_SETTINGS_SYNC_V1',
    updated_at: updatedAt,
    device_id: deviceId,
    salt_b64: toBase64(salt),
    data_b64: toBase64(sealed),
  };
  return {
    payloadText: `#TG_DRIVE_SETTINGS_SYNC_V1\n${JSON.stringify(envelope)}`,
    updatedAt,
  };
}

export function decryptSettingsSyncPayload(
  payloadText: string,
  passphrase: string,
): { settings: Record<string, unknown>; updated_at: number; device_id: string } {
  const jsonStart = payloadText.indexOf('{');
  if (jsonStart < 0) throw new Error('SETTINGS_SYNC_CORRUPT');
  const envelope = JSON.parse(payloadText.slice(jsonStart)) as {
    updated_at: number;
    device_id: string;
    salt_b64: string;
    data_b64: string;
  };
  const key = deriveKeyFromPassphrase(passphrase, fromBase64(envelope.salt_b64));
  let decrypted: Uint8Array;
  try {
    decrypted = openBytes(key, fromBase64(envelope.data_b64), utf8ToBytes('TDSS1'));
  } catch {
    throw new Error('INVALID_PASSPHRASE');
  }
  const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as {
    settings: Record<string, unknown>;
    updatedAt: number;
    deviceId: string;
  };
  return {
    settings: parsed.settings ?? {},
    updated_at: parsed.updatedAt ?? envelope.updated_at,
    device_id: parsed.deviceId ?? envelope.device_id,
  };
}
