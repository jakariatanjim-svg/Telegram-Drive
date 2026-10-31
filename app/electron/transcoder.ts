import childProcess from 'node:child_process';
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatByteSize } from '../shared/mtprotoHelpers';
import { getPortablePaths } from './portablePaths';

export interface TranscodePreset {
  quality: '360p' | '480p' | '720p' | '1080p' | '1440p' | '2160p';
  height: number;
  videoBitrate: string;
  maxRate: string;
  bufSize: string;
  audioBitrate: string;
}

export const TRANSCODE_PRESETS: Record<string, TranscodePreset> = {
  '360p': {
    quality: '360p',
    height: 360,
    videoBitrate: '900k',
    maxRate: '1200k',
    bufSize: '2400k',
    audioBitrate: '96k',
  },
  '480p': {
    quality: '480p',
    height: 480,
    videoBitrate: '1600k',
    maxRate: '2200k',
    bufSize: '4400k',
    audioBitrate: '128k',
  },
  '720p': {
    quality: '720p',
    height: 720,
    videoBitrate: '3500k',
    maxRate: '4500k',
    bufSize: '9000k',
    audioBitrate: '160k',
  },
  '1080p': {
    quality: '1080p',
    height: 1080,
    videoBitrate: '6500k',
    maxRate: '8500k',
    bufSize: '17000k',
    audioBitrate: '192k',
  },
  '1440p': {
    quality: '1440p',
    height: 1440,
    videoBitrate: '12000k',
    maxRate: '16000k',
    bufSize: '32000k',
    audioBitrate: '192k',
  },
  '2160p': {
    quality: '2160p',
    height: 2160,
    videoBitrate: '24000k',
    maxRate: '32000k',
    bufSize: '64000k',
    audioBitrate: '256k',
  },
};

export interface TranscodeJobState {
  job_id: string;
  fileKey: string;
  quality: string;
  status: 'pending' | 'caching' | 'transcoding' | 'ready' | 'error' | 'cancelled';
  progress: number;
  playlist_url: string | null;
  error: string | null;
  process?: childProcess.ChildProcess;
}

export interface CacheEntryRecord {
  file_key: string;
  quality: string;
  size_bytes: number;
  playlist_exists: boolean;
}

let cachedFfmpegPath: string | null | undefined;

export function resolveFfmpegExecutable(): string | null {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;

  const paths = getPortablePaths();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const localCandidates = [
    path.join(paths.installDir, `ffmpeg${ext}`),
    path.join(paths.installDir, 'bin', `ffmpeg${ext}`),
    path.join(paths.dataRoot, 'bin', `ffmpeg${ext}`),
    path.join(process.resourcesPath ?? '', `ffmpeg${ext}`),
  ];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const programData = process.env.ProgramData ?? 'C:\\ProgramData';
    localCandidates.push(
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      path.join(programData, 'chocolatey', 'bin', 'ffmpeg.exe'),
      path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
    );
  }

  for (const candidate of localCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }

  try {
    const res = childProcess.spawnSync('ffmpeg', ['-version'], {
      stdio: 'ignore',
      timeout: 2500,
      windowsHide: true,
    });
    if (res.status === 0) {
      cachedFfmpegPath = 'ffmpeg';
      return 'ffmpeg';
    }
  } catch {
    // Not in PATH
  }

  cachedFfmpegPath = null;
  return null;
}

export function resetFfmpegDetectionCache(): void {
  cachedFfmpegPath = undefined;
}

export class VideoTranscodeManager {
  private jobs = new Map<string, TranscodeJobState>();
  private fmp4Jobs = new Map<string, { status: 'preparing' | 'ready' | 'error'; error: string | null }>();

  public getTranscodeRootDir(): string {
    const dir = getPortablePaths().transcodeCacheDir;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public makeFileKey(ownerId: string | null, folderId: number | null, messageId: number): string {
    const safeOwner = (ownerId || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeFolder = folderId === null ? 'saved' : String(Math.abs(folderId));
    return `${safeOwner}_${safeFolder}_${messageId}`;
  }

  public getCapabilities(maxCacheGb: number) {
    // Re-check PATH if previously unavailable so newly installed FFmpeg is picked up automatically
    if (!cachedFfmpegPath) {
      resetFfmpegDetectionCache();
    }
    const ffmpegBin = resolveFfmpegExecutable();
    const available = Boolean(ffmpegBin);
    const cacheInfo = this.scanCache(maxCacheGb);

    return {
      available,
      ffmpeg_available: available,
      hardware_encoder: null,
      mode: available ? ('hls' as const) : ('original' as const),
      variants: Object.values(TRANSCODE_PRESETS).map(preset => ({
        label: preset.quality,
        height: preset.height,
        available,
      })),
      cache_size_bytes: cacheInfo.total_bytes,
      max_cache_gb: maxCacheGb,
      entries: cacheInfo.entries,
    };
  }

  public scanCache(maxCacheGb: number): {
    entries: CacheEntryRecord[];
    total_bytes: number;
    max_bytes: number;
    scan_in_progress: boolean;
    last_scanned_at: number;
    last_error: null;
  } {
    const root = this.getTranscodeRootDir();
    const entries: CacheEntryRecord[] = [];
    let totalBytes = 0;

    if (fs.existsSync(root)) {
      let fileKeys: fs.Dirent[] = [];
      try {
        fileKeys = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        fileKeys = [];
      }

      for (const fkEntry of fileKeys) {
        if (!fkEntry.isDirectory()) continue;
        const fkDir = path.join(root, fkEntry.name);
        let subEntries: fs.Dirent[] = [];
        try {
          subEntries = fs.readdirSync(fkDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const sub of subEntries) {
          const fullSub = path.join(fkDir, sub.name);
          if (sub.isDirectory()) {
            const size = this.measureDirBytes(fullSub);
            totalBytes += size;
            entries.push({
              file_key: fkEntry.name,
              quality: sub.name,
              size_bytes: size,
              playlist_exists: fs.existsSync(path.join(fullSub, 'playlist.m3u8')),
            });
          } else if (sub.isFile()) {
            try {
              const size = fs.statSync(fullSub).size;
              totalBytes += size;
              entries.push({
                file_key: fkEntry.name,
                quality: sub.name === 'remux.fmp4' ? 'fmp4' : 'original',
                size_bytes: size,
                playlist_exists: true,
              });
            } catch {
              // ignore
            }
          }
        }
      }
    }

    return {
      entries,
      total_bytes: totalBytes,
      max_bytes: Math.round(maxCacheGb * 1024 * 1024 * 1024),
      scan_in_progress: false,
      last_scanned_at: Date.now(),
      last_error: null,
    };
  }

  private measureDirBytes(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    const stack = [dir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let items: fs.Dirent[] = [];
      try {
        items = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const it of items) {
        const full = path.join(cur, it.name);
        if (it.isDirectory()) stack.push(full);
        else if (it.isFile()) {
          try {
            total += fs.statSync(full).size;
          } catch {
            // ignore
          }
        }
      }
    }
    return total;
  }

  public getCachedVariants(fileKey: string): string[] {
    const fkDir = path.join(this.getTranscodeRootDir(), fileKey);
    if (!fs.existsSync(fkDir)) return [];
    const ready: string[] = [];
    for (const quality of Object.keys(TRANSCODE_PRESETS)) {
      if (fs.existsSync(path.join(fkDir, quality, 'playlist.m3u8'))) {
        ready.push(quality);
      }
    }
    return ready;
  }

  public getMasterPlaylistInfo(fileKey: string) {
    const variants = this.getCachedVariants(fileKey).map(q => {
      const preset = TRANSCODE_PRESETS[q];
      return {
        bandwidth: Number.parseInt(preset.videoBitrate, 10) * 1000,
        resolution: `${Math.round((preset.height * 16) / 9)}x${preset.height}`,
        quality: q,
        playlist_path: `/hls/${fileKey}/${q}/playlist.m3u8`,
      };
    });
    return {
      file_key: fileKey,
      variants,
      master_playlist_url: variants[0]?.playlist_path ?? null,
    };
  }

  public clearCache(fileKey?: string, quality?: string): string {
    const root = this.getTranscodeRootDir();
    let freed = 0;

    if (fileKey && quality) {
      const target = path.join(root, path.basename(fileKey), path.basename(quality));
      freed = this.measureDirBytes(target);
      fs.rmSync(target, { recursive: true, force: true });
    } else if (fileKey) {
      const target = path.join(root, path.basename(fileKey));
      freed = this.measureDirBytes(target);
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      freed = this.measureDirBytes(root);
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
    }

    return `Cleared ${formatByteSize(freed)}`;
  }

  public getJobStatus(jobId: string): TranscodeJobState {
    const found = this.jobs.get(jobId);
    if (!found) {
      return {
        job_id: jobId,
        fileKey: '',
        quality: '',
        status: 'error',
        progress: 0,
        playlist_url: null,
        error: 'TRANSCODE_JOB_NOT_FOUND',
      };
    }
    return {
      job_id: found.job_id,
      fileKey: found.fileKey,
      quality: found.quality,
      status: found.status,
      progress: found.progress,
      playlist_url: found.playlist_url,
      error: found.error,
    };
  }

  public async prepareTranscode(params: {
    fileKey: string;
    quality: string;
    ensureSourceCached: (targetPath: string, onProgress: (pct: number) => void) => Promise<void>;
  }): Promise<{
    job_id: string;
    status: string;
    progress: number;
    playlist_url: string | null;
    error: string | null;
  }> {
    const ffmpegBin = resolveFfmpegExecutable();
    if (!ffmpegBin) {
      return {
        job_id: '',
        status: 'error',
        progress: 0,
        playlist_url: null,
        error: 'FFMPEG_NOT_AVAILABLE',
      };
    }

    const preset = TRANSCODE_PRESETS[params.quality];
    if (!preset) {
      return {
        job_id: '',
        status: 'error',
        progress: 0,
        playlist_url: null,
        error: `UNSUPPORTED_QUALITY:${params.quality}`,
      };
    }

    const fkDir = path.join(this.getTranscodeRootDir(), params.fileKey);
    const outDir = path.join(fkDir, preset.quality);
    const playlistFile = path.join(outDir, 'playlist.m3u8');
    const playlistUrl = `/hls/${params.fileKey}/${preset.quality}/playlist.m3u8`;

    if (fs.existsSync(playlistFile)) {
      return {
        job_id: `cached_${params.fileKey}_${preset.quality}`,
        status: 'ready',
        progress: 1,
        playlist_url: playlistUrl,
        error: null,
      };
    }

    // Reuse an already-running job for the same file+quality
    for (const existing of this.jobs.values()) {
      if (
        existing.fileKey === params.fileKey &&
        existing.quality === preset.quality &&
        (existing.status === 'caching' || existing.status === 'transcoding' || existing.status === 'pending')
      ) {
        return {
          job_id: existing.job_id,
          status: existing.status,
          progress: existing.progress,
          playlist_url: existing.playlist_url,
          error: existing.error,
        };
      }
    }

    const jobId = nodeCrypto.randomUUID();
    const job: TranscodeJobState = {
      job_id: jobId,
      fileKey: params.fileKey,
      quality: preset.quality,
      status: 'caching',
      progress: 0.02,
      playlist_url: null,
      error: null,
    };
    this.jobs.set(jobId, job);

    void (async () => {
      try {
        fs.mkdirSync(outDir, { recursive: true });
        const sourcePath = path.join(fkDir, 'source.media');
        if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size === 0) {
          await params.ensureSourceCached(sourcePath, pct => {
            job.status = 'caching';
            job.progress = Math.min(0.45, Math.max(0.02, (pct / 100) * 0.45));
          });
        }

        job.status = 'transcoding';
        job.progress = 0.5;

        const segPattern = path.join(outDir, 'seg_%04d.ts');
        const args = [
          '-y',
          '-i',
          sourcePath,
          '-vf',
          `scale=-2:${preset.height}`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-b:v',
          preset.videoBitrate,
          '-maxrate',
          preset.maxRate,
          '-bufsize',
          preset.bufSize,
          '-c:a',
          'aac',
          '-b:a',
          preset.audioBitrate,
          '-ac',
          '2',
          '-f',
          'hls',
          '-hls_time',
          '4',
          '-hls_playlist_type',
          'vod',
          '-hls_segment_filename',
          segPattern,
          playlistFile,
        ];

        await new Promise<void>((resolve, reject) => {
          const proc = childProcess.spawn(ffmpegBin, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
          });
          job.process = proc;
          let stderrTail = '';
          proc.stderr?.on('data', chunk => {
            stderrTail = (stderrTail + chunk.toString()).slice(-1200);
            job.progress = Math.min(0.95, job.progress + 0.01);
          });
          proc.on('error', reject);
          proc.on('close', code => {
            if (code === 0 && fs.existsSync(playlistFile)) {
              resolve();
            } else {
              reject(new Error(stderrTail.trim() || `FFmpeg exited with code ${code}`));
            }
          });
        });

        job.status = 'ready';
        job.progress = 1;
        job.playlist_url = playlistUrl;
      } catch (err) {
        job.status = 'error';
        job.error = err instanceof Error ? err.message : String(err);
      }
    })();

    return {
      job_id: jobId,
      status: 'started',
      progress: job.progress,
      playlist_url: null,
      error: null,
    };
  }

  public async prepareFmp4Remux(params: {
    fileKey: string;
    ensureSourceCached: (targetPath: string) => Promise<void>;
  }): Promise<{ url: string; output_file_key: string; status: string }> {
    const ffmpegBin = resolveFfmpegExecutable();
    if (!ffmpegBin) {
      throw new Error('FFMPEG_NOT_AVAILABLE');
    }

    const fkDir = path.join(this.getTranscodeRootDir(), params.fileKey);
    const outFile = path.join(fkDir, 'remux.fmp4');
    const url = `/fmp4/${params.fileKey}/remux.fmp4`;

    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
      this.fmp4Jobs.set(params.fileKey, { status: 'ready', error: null });
      return { url, output_file_key: params.fileKey, status: 'ready' };
    }

    const existing = this.fmp4Jobs.get(params.fileKey);
    if (existing?.status === 'preparing') {
      return { url, output_file_key: params.fileKey, status: 'preparing' };
    }

    this.fmp4Jobs.set(params.fileKey, { status: 'preparing', error: null });

    void (async () => {
      try {
        fs.mkdirSync(fkDir, { recursive: true });
        const sourcePath = path.join(fkDir, 'source.media');
        if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size === 0) {
          await params.ensureSourceCached(sourcePath);
        }
        const tmpOut = `${outFile}.tmp`;
        await new Promise<void>((resolve, reject) => {
          const proc = childProcess.spawn(
            ffmpegBin,
            [
              '-y',
              '-i',
              sourcePath,
              '-c',
              'copy',
              '-movflags',
              '+frag_keyframe+empty_moov+default_base_moof',
              '-f',
              'mp4',
              tmpOut,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
          );
          let errTail = '';
          proc.stderr?.on('data', d => {
            errTail = (errTail + d.toString()).slice(-800);
          });
          proc.on('error', reject);
          proc.on('close', code => {
            if (code === 0 && fs.existsSync(tmpOut)) {
              fs.renameSync(tmpOut, outFile);
              resolve();
            } else {
              fs.rmSync(tmpOut, { force: true });
              reject(new Error(errTail.trim() || `fMP4 remux failed (${code})`));
            }
          });
        });
        this.fmp4Jobs.set(params.fileKey, { status: 'ready', error: null });
      } catch (err) {
        this.fmp4Jobs.set(params.fileKey, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return { url, output_file_key: params.fileKey, status: 'preparing' };
  }

  public getFmp4Status(fileKey: string): { status: string; error: string | null } {
    const outFile = path.join(this.getTranscodeRootDir(), path.basename(fileKey), 'remux.fmp4');
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
      return { status: 'ready', error: null };
    }
    return this.fmp4Jobs.get(fileKey) ?? { status: 'error', error: 'FMP4_JOB_NOT_FOUND' };
  }

  public resolveHlsAssetPath(fileKey: string, quality: string, assetName: string): string | null {
    const safeFk = path.basename(fileKey);
    const safeQ = path.basename(quality);
    const safeAsset = path.basename(assetName);
    const candidate = path.join(this.getTranscodeRootDir(), safeFk, safeQ, safeAsset);
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
  }

  public resolveFmp4Path(fileKey: string): string | null {
    const safeFk = path.basename(fileKey);
    const candidate = path.join(this.getTranscodeRootDir(), safeFk, 'remux.fmp4');
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
  }

  public shutdownAll(): void {
    for (const job of this.jobs.values()) {
      if (job.process && !job.process.killed) {
        try {
          job.process.kill();
        } catch {
          // ignore
        }
      }
    }
    this.jobs.clear();
  }
}
