import type { UploadProtectionIntent } from '../types/encryption';
import type { VideoUploadMode } from '../types/settings';

const TELEGRAM_MEDIA_VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);

export function supportsTelegramMediaUpload(path: string): boolean {
  const cleanPath = path.split(/[?#]/, 1)[0];
  const extension = cleanPath.split('.').pop()?.toLowerCase();
  return Boolean(extension && TELEGRAM_MEDIA_VIDEO_EXTENSIONS.has(extension));
}

/**
 * Telegram can only inspect and stream plaintext video bytes. Protected files
 * stay encrypted documents even when streamable media is selected.
 */
export function effectiveVideoUploadMode(
  path: string,
  protection: UploadProtectionIntent,
  preference: VideoUploadMode,
): VideoUploadMode {
  return preference === 'media'
    && protection.mode === 'standard'
    && supportsTelegramMediaUpload(path)
    ? 'media'
    : 'file';
}
