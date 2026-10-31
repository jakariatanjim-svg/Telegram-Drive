import { unzipSync, zipSync } from 'fflate';
import type { Message, SentCode } from '@mtcute/core';
import type { EncryptedFileRecord } from './cryptoVault';

export const TG_DRIVE_CHANNEL_PREFIX = '[TG-Drive] ';
export const SETTINGS_SYNC_MARKER = '#TG_DRIVE_SETTINGS_SYNC_V1';

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** idx;
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    m4v: 'video/mp4',
    ts: 'video/mp2t',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    iso: 'application/x-iso9660-image',
    json: 'application/json',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
    apk: 'application/vnd.android.package-archive',
    exe: 'application/vnd.microsoft.portable-executable',
    msi: 'application/x-msi',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function mapSentCodeResult(sent: SentCode) {
  const mapDelivery = (t: string) => {
    switch (t) {
      case 'app':
        return 'telegram_app' as const;
      case 'sms':
        return 'sms' as const;
      case 'call':
        return 'call' as const;
      case 'flash_call':
        return 'flash_call' as const;
      case 'missed_call':
        return 'missed_call' as const;
      case 'email':
        return 'email' as const;
      case 'email_required':
        return 'email_setup' as const;
      case 'fragment':
        return 'fragment' as const;
      case 'firebase':
        return 'firebase' as const;
      case 'sms_word':
        return 'sms_word' as const;
      case 'sms_phrase':
        return 'sms_phrase' as const;
      default:
        return 'unsupported' as const;
    }
  };
  const delivery = mapDelivery(sent.type);
  const nextDelivery = sent.nextType && sent.nextType !== 'none' ? mapDelivery(sent.nextType) : undefined;
  return {
    status: 'code_required' as const,
    delivery,
    codeLength: sent.length > 0 ? sent.length : 5,
    resendAfterSeconds: sent.timeout > 0 ? sent.timeout : undefined,
    nextDelivery,
    numericCode: delivery !== 'sms_word' && delivery !== 'sms_phrase',
  };
}

export interface MappedTelegramFile {
  id: number;
  name: string;
  size: number;
  sizeStr: string;
  type: 'file';
  mime_type?: string;
  created_at?: string;
  folder_id: number | null;
  is_favorite?: boolean;
  encryption_state?: 'plain' | 'encrypted_unlocked' | 'encrypted_locked';
  encryption?: {
    state: 'plain' | 'encrypted_unlocked' | 'encrypted_locked';
    envelope_version?: number;
    protection_mode?: 'vault' | 'passphrase';
    metadata_protected?: boolean;
    ciphertext_size?: number;
  };
  vault_id?: string | null;
  protect_metadata?: boolean;
  caption?: string;
  is_split?: boolean;
  split_parts_count?: number;
}

export function mapMessageToTelegramFile(
  msg: Message,
  folderId: number | null,
  overrides: {
    customName?: string;
    favorite?: boolean;
    encryptedRecord?: EncryptedFileRecord;
    vaultUnlocked?: boolean;
  } = {},
): MappedTelegramFile | null {
  if (!msg || !msg.media) return null;
  if (msg.text && msg.text.startsWith(SETTINGS_SYNC_MARKER)) return null;
  if (msg.text && msg.text.startsWith('#TG_SPLIT_PART_V1:')) return null;

  const media = msg.media as unknown as {
    type?: string;
    fileName?: string | null;
    fileSize?: number | null;
    mimeType?: string | null;
    width?: number;
    height?: number;
  };

  const mediaType = media.type ?? '';
  if (!['document', 'video', 'audio', 'voice', 'photo', 'animation'].includes(mediaType)) {
    return null;
  }

  const rawDate = msg.date instanceof Date ? msg.date.toISOString() : new Date().toISOString();
  let fallbackName = `telegram_${msg.id}`;
  if (mediaType === 'photo') fallbackName = `photo_${msg.id}.jpg`;
  else if (mediaType === 'video') fallbackName = `video_${msg.id}.mp4`;
  else if (mediaType === 'audio') fallbackName = `audio_${msg.id}.mp3`;
  else if (mediaType === 'voice') fallbackName = `voice_${msg.id}.ogg`;

  const rawFileName = media.fileName || (msg.text && !msg.text.includes('\n') && msg.text.length < 180 ? msg.text.trim() : '') || fallbackName;
  const isTgd = rawFileName.toLowerCase().endsWith('.tgd');
  const encRec = overrides.encryptedRecord;

  const displayName =
    overrides.customName ||
    encRec?.originalName ||
    (isTgd && rawFileName.length > 4 ? rawFileName.slice(0, -4) : rawFileName);

  const size = encRec?.originalSize ?? (typeof media.fileSize === 'number' ? media.fileSize : 0);
  const mime = media.mimeType || guessMimeType(displayName);

  let encryptionState: MappedTelegramFile['encryption_state'] = 'plain';
  let encryptionInfo: MappedTelegramFile['encryption'] = undefined;
  if (encRec || isTgd) {
    const mode = encRec?.mode ?? 'vault';
    encryptionState =
      mode === 'vault' && overrides.vaultUnlocked ? 'encrypted_unlocked' : 'encrypted_locked';
    encryptionInfo = {
      state: encryptionState,
      envelope_version: 1,
      protection_mode: mode,
      metadata_protected: Boolean(encRec?.protectMetadata),
      ciphertext_size: typeof media.fileSize === 'number' ? media.fileSize : size,
    };
  }

  return {
    id: msg.id,
    name: displayName,
    size,
    sizeStr: formatByteSize(size),
    type: 'file',
    mime_type: mime,
    created_at: rawDate,
    folder_id: folderId,
    is_favorite: Boolean(overrides.favorite),
    encryption_state: encryptionState,
    encryption: encryptionInfo,
    vault_id: encRec?.vaultId ?? null,
    protect_metadata: encRec?.protectMetadata ?? false,
    caption: msg.text || undefined,
  };
}

export function listZipEntriesFromBytes(zipBytes: Uint8Array) {
  const unzipped = unzipSync(zipBytes);
  return Object.entries(unzipped).map(([entryPath, content]) => {
    const isDir = entryPath.endsWith('/');
    const cleanName = entryPath.replace(/\/$/, '').split('/').pop() || entryPath;
    return {
      path: entryPath,
      name: cleanName,
      size: content.byteLength,
      compressed_size: content.byteLength,
      is_dir: isDir,
    };
  });
}

export function extractSingleZipEntry(zipBytes: Uint8Array, targetEntryPath: string): Uint8Array {
  const unzipped = unzipSync(zipBytes, {
    filter: file => file.name === targetEntryPath,
  });
  const found = unzipped[targetEntryPath];
  if (!found) {
    throw new Error(`Archive entry not found: ${targetEntryPath}`);
  }
  return found;
}

export function createZipFromEntries(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries, { level: 6 });
}
