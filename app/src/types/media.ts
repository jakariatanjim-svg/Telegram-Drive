export type StreamingQuality =
  | '360p'
  | '480p'
  | '720p'
  | '1080p'
  | '1440p'
  | '2160p'
  | 'original';

export interface StreamingSettings {
  quality: StreamingQuality;
  adaptiveMode: boolean;
}

export interface VideoTrackInfo {
  id: number;
  type: 'video' | 'audio';
  width?: number;
  height?: number;
  bitrate?: number;
  codec?: string;
  duration?: number;
}

/**
 * Artificial client-side bandwidth throttling is disabled (0 = unlimited) so all
 * users stream at full speed without supporter-tier caps.
 */
export const QUALITY_THROTTLE_MAP: Record<StreamingQuality, number> = {
  '360p': 0,
  '480p': 0,
  '720p': 0,
  '1080p': 0,
  '1440p': 0,
  '2160p': 0,
  original: 0,
};

/** Thresholds for adaptive quality switching, ordered highest to lowest. */
export const ADAPTIVE_THRESHOLDS: { minKbps: number; quality: StreamingQuality }[] = [
  { minKbps: 14000, quality: '2160p' },
  { minKbps: 8000, quality: '1440p' },
  { minKbps: 4000, quality: '1080p' },
  { minKbps: 2000, quality: '720p' },
  { minKbps: 800, quality: '480p' },
  { minKbps: 0, quality: '360p' },
];

/** Resolve display label for quality presets; 2160p renders concisely as 4K. */
export function qualityLabel(quality: StreamingQuality, originalLabel: string): string {
  if (quality === 'original') return originalLabel;
  if (quality === '2160p') return '4K';
  return quality;
}

export const HLS_QUALITIES: StreamingQuality[] = [
  '360p',
  '480p',
  '720p',
  '1080p',
  '1440p',
  '2160p',
];

export interface TranscodeCapabilities {
  available: boolean;
  ffmpeg_available?: boolean;
  hardware_encoder?: string | null;
  variants: QualityVariant[];
  mode: 'hls' | 'original';
  cache_size_bytes?: number;
  max_cache_gb?: number;
  entries?: CacheEntry[];
}

export interface QualityVariant {
  label: string;
  height: number;
  available: boolean;
}

export interface TranscodePrepareResult {
  job_id: string;
  status: 'started' | 'pending' | 'caching' | 'transcoding' | 'ready' | 'error' | 'cancelled';
  progress: number;
  playlist_url: string | null;
  error: string | null;
}

export interface TranscodeStatusResult {
  job_id: string;
  status: 'pending' | 'caching' | 'transcoding' | 'ready' | 'error' | 'cancelled';
  progress: number;
  error: string | null;
  playlist_url: string | null;
}

export interface MasterPlaylistInfo {
  file_key: string;
  variants: MasterVariant[];
  master_playlist_url: string | null;
}

export interface MasterVariant {
  bandwidth: number;
  resolution: string;
  quality: string;
  playlist_path: string;
}

export interface CacheEntry {
  file_key: string;
  quality: string;
  size_bytes: number;
  playlist_exists: boolean;
}

export interface DetailedCacheInfo {
  entries: CacheEntry[];
  total_bytes: number;
  max_bytes: number;
  scan_in_progress: boolean;
  last_scanned_at: number | null;
  last_error: string | null;
}

export type TranscodeJobPhase = 'idle' | 'preparing' | 'caching' | 'transcoding' | 'ready' | 'failed';
