import type { Message } from '@mtcute/core';
import type { EncryptedFileRecord } from './cryptoVault';
import { formatByteSize, guessMimeType, type MappedTelegramFile } from './mtprotoHelpers';

/**
 * 1,920 MiB (2,013,265,920 bytes).
 * - Safely under Telegram's 2,000 MiB standard per-message upload limit.
 * - Exact multiple of 1 MiB (1,048,576 B) and 512 KiB (524,288 B), ensuring
 *   MTProto range-download chunk boundaries align cleanly across parts.
 */
export const SPLIT_PART_SIZE_BYTES = 1920 * 1024 * 1024;

/**
 * Smaller 256 MiB chunk size when Vault/Passphrase encryption is enabled on a
 * multi-GB file so encryption buffers stay comfortably inside memory limits.
 */
export const ENCRYPTED_SPLIT_PART_SIZE_BYTES = 256 * 1024 * 1024;

export const SPLIT_PART_MARKER = '#TG_SPLIT_PART_V1:';
export const SPLIT_MANIFEST_MARKER = '#TG_SPLIT_MANIFEST_V1:';

export interface SplitPartDescriptor {
  id: number;
  size: number;
}

export interface SplitFileManifest {
  v: 1;
  groupId: string;
  name: string;
  mime: string;
  totalSize: number;
  partSize: number;
  parts: SplitPartDescriptor[];
  createdAt: string;
  encrypted?: {
    mode: 'vault' | 'passphrase';
    vaultId?: string;
    protectMetadata?: boolean;
  };
}

export interface SplitManifestCaptionHeader {
  v: 1;
  g: string;
  name: string;
  mime: string;
  size: number;
  partSize: number;
  count: number;
  createdAt: string;
  /** Present when the compact part tuple list fits inside Telegram's 1024-char caption limit. */
  parts?: Array<[number, number]>;
  enc?: {
    m: 'vault' | 'passphrase';
    vid?: string;
    pm?: boolean;
  };
}

export interface SplitPartPlanItem {
  index: number;
  offset: number;
  size: number;
}

export interface SplitRangeSlice {
  partIndex: number;
  messageId: number;
  partLocalStart: number;
  partLocalEndInclusive: number;
}

export interface SplitUploadCheckpoint {
  fingerprint: string;
  groupId: string;
  fileName: string;
  folderId: number | null;
  totalSize: number;
  partSize: number;
  completedParts: Record<number, { messageId: number; size: number }>;
  updatedAt: number;
}

export function shouldSplitUpload(totalBytes: number, isEncrypted = false): boolean {
  const limit = isEncrypted ? ENCRYPTED_SPLIT_PART_SIZE_BYTES : SPLIT_PART_SIZE_BYTES;
  return Number.isFinite(totalBytes) && totalBytes > limit;
}

export function computeSplitPartPlan(
  totalBytes: number,
  partSize = SPLIT_PART_SIZE_BYTES,
): SplitPartPlanItem[] {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return [];
  const safePartSize = Math.max(1024 * 1024, Math.floor(partSize));
  const plan: SplitPartPlanItem[] = [];
  let offset = 0;
  let index = 0;
  while (offset < totalBytes) {
    const size = Math.min(safePartSize, totalBytes - offset);
    plan.push({ index, offset, size });
    offset += size;
    index++;
  }
  return plan;
}

export function buildSplitPartFileName(groupId: string, index: number, totalParts: number): string {
  const width = Math.max(4, String(totalParts).length);
  const idxStr = String(index + 1).padStart(width, '0');
  const totStr = String(totalParts).padStart(width, '0');
  return `.tgpart-${groupId}-${idxStr}of${totStr}.bin`;
}

export function buildSplitPartCaption(
  groupId: string,
  index: number,
  totalParts: number,
  size: number,
): string {
  return `${SPLIT_PART_MARKER}${JSON.stringify({ g: groupId, i: index, n: totalParts, s: size })}`;
}

export function buildSplitManifestFileName(groupId: string): string {
  return `.tgmanifest-${groupId}.json`;
}

export function buildSplitManifestCaption(manifest: SplitFileManifest): string {
  const baseHeader: SplitManifestCaptionHeader = {
    v: 1,
    g: manifest.groupId,
    name: manifest.encrypted?.protectMetadata ? `encrypted_${manifest.groupId}.tgd` : manifest.name,
    mime: manifest.encrypted ? 'application/octet-stream' : manifest.mime,
    size: manifest.totalSize,
    partSize: manifest.partSize,
    count: manifest.parts.length,
    createdAt: manifest.createdAt,
    ...(manifest.encrypted
      ? {
          enc: {
            m: manifest.encrypted.mode,
            vid: manifest.encrypted.vaultId,
            pm: manifest.encrypted.protectMetadata,
          },
        }
      : {}),
  };

  const withInlineParts: SplitManifestCaptionHeader = {
    ...baseHeader,
    parts: manifest.parts.map(p => [p.id, p.size]),
  };
  const candidate = `${SPLIT_MANIFEST_MARKER}${JSON.stringify(withInlineParts)}`;
  if (candidate.length <= 1000) {
    return candidate;
  }
  return `${SPLIT_MANIFEST_MARKER}${JSON.stringify(baseHeader)}`;
}

export function isSplitPartMessage(msg: Message | null | undefined): boolean {
  if (!msg) return false;
  if (typeof msg.text === 'string' && msg.text.startsWith(SPLIT_PART_MARKER)) {
    return true;
  }
  const media = msg.media as unknown as { fileName?: string | null } | null;
  const fileName = media?.fileName ?? '';
  return /^\.tgpart-[a-z0-9_-]+-\d+of\d+\.bin$/i.test(fileName);
}

export function parseSplitManifestFromMessage(
  msg: Message | null | undefined,
): { header: SplitManifestCaptionHeader; inlineManifest: SplitFileManifest | null } | null {
  if (!msg || typeof msg.text !== 'string' || !msg.text.startsWith(SPLIT_MANIFEST_MARKER)) {
    return null;
  }
  const rawJson = msg.text.slice(SPLIT_MANIFEST_MARKER.length).trim();
  try {
    const header = JSON.parse(rawJson) as SplitManifestCaptionHeader;
    if (!header || header.v !== 1 || !header.g || !Number.isFinite(header.size)) {
      return null;
    }
    let inlineManifest: SplitFileManifest | null = null;
    if (Array.isArray(header.parts) && header.parts.length === header.count && header.count > 0) {
      inlineManifest = {
        v: 1,
        groupId: header.g,
        name: header.name,
        mime: header.mime || guessMimeType(header.name),
        totalSize: header.size,
        partSize: header.partSize,
        parts: header.parts.map(([id, size]) => ({ id: Number(id), size: Number(size) })),
        createdAt: header.createdAt || (msg.date instanceof Date ? msg.date.toISOString() : new Date().toISOString()),
        ...(header.enc
          ? {
              encrypted: {
                mode: header.enc.m,
                vaultId: header.enc.vid,
                protectMetadata: header.enc.pm,
              },
            }
          : {}),
      };
    }
    return { header, inlineManifest };
  } catch {
    return null;
  }
}

export function parseSplitManifestJsonBytes(bytes: Uint8Array): SplitFileManifest | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as SplitFileManifest;
    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.groupId !== 'string' ||
      !Array.isArray(parsed.parts) ||
      parsed.parts.length === 0
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function mapSplitManifestToTelegramFile(
  msg: Message,
  folderId: number | null,
  header: SplitManifestCaptionHeader,
  cachedManifest: SplitFileManifest | undefined,
  overrides: {
    customName?: string;
    favorite?: boolean;
    encryptedRecord?: EncryptedFileRecord;
    vaultUnlocked?: boolean;
  } = {},
): MappedTelegramFile {
  const rawDate =
    cachedManifest?.createdAt ||
    header.createdAt ||
    (msg.date instanceof Date ? msg.date.toISOString() : new Date().toISOString());

  const encRec = overrides.encryptedRecord;
  const encMeta = cachedManifest?.encrypted ?? (header.enc ? {
    mode: header.enc.m,
    vaultId: header.enc.vid,
    protectMetadata: header.enc.pm,
  } : undefined);

  const realName =
    overrides.customName ||
    encRec?.originalName ||
    cachedManifest?.name ||
    header.name ||
    `file_${msg.id}`;

  const totalSize = encRec?.originalSize ?? cachedManifest?.totalSize ?? header.size ?? 0;
  const mime =
    (cachedManifest && !cachedManifest.encrypted ? cachedManifest.mime : '') ||
    (!header.enc ? header.mime : '') ||
    guessMimeType(realName);

  let encryptionState: MappedTelegramFile['encryption_state'] = 'plain';
  let encryptionInfo: MappedTelegramFile['encryption'] = undefined;

  if (encRec || encMeta) {
    const mode = encRec?.mode ?? encMeta?.mode ?? 'vault';
    encryptionState =
      mode === 'vault' && overrides.vaultUnlocked ? 'encrypted_unlocked' : 'encrypted_locked';
    encryptionInfo = {
      state: encryptionState,
      envelope_version: 1,
      protection_mode: mode,
      metadata_protected: Boolean(encRec?.protectMetadata ?? encMeta?.protectMetadata),
      ciphertext_size: cachedManifest?.totalSize ?? header.size ?? totalSize,
    };
  }

  return {
    id: msg.id,
    name: realName,
    size: totalSize,
    sizeStr: formatByteSize(totalSize),
    type: 'file',
    mime_type: mime,
    created_at: rawDate,
    folder_id: folderId,
    is_favorite: Boolean(overrides.favorite),
    encryption_state: encryptionState,
    encryption: encryptionInfo,
    vault_id: encRec?.vaultId ?? encMeta?.vaultId ?? null,
    protect_metadata: Boolean(encRec?.protectMetadata ?? encMeta?.protectMetadata),
    is_split: true,
    split_parts_count: cachedManifest?.parts.length ?? header.count,
  };
}

export function resolveRangeAcrossParts(
  parts: SplitPartDescriptor[],
  start: number,
  endInclusive: number,
): SplitRangeSlice[] {
  if (!Array.isArray(parts) || parts.length === 0 || endInclusive < start || start < 0) {
    return [];
  }
  const slices: SplitRangeSlice[] = [];
  let partOffset = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.size <= 0) continue;
    const partStart = partOffset;
    const partEnd = partOffset + part.size - 1;

    if (endInclusive >= partStart && start <= partEnd) {
      const overlapStart = Math.max(start, partStart);
      const overlapEnd = Math.min(endInclusive, partEnd);
      slices.push({
        partIndex: i,
        messageId: part.id,
        partLocalStart: overlapStart - partStart,
        partLocalEndInclusive: overlapEnd - partStart,
      });
    }

    partOffset += part.size;
    if (partOffset > endInclusive) break;
  }

  return slices;
}
