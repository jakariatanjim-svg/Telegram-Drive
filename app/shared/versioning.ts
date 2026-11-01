export const GITHUB_REPO = 'jakariatanjim-svg/Telegram-Drive';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases/latest`;
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number | null;
  display: string;
}

/**
 * Parses both 1-dot `vX.Y` (e.g. `1.0`, `4.4`) and 2-dot `vX.Y.Z` (e.g. `1.0.0`, `1.0.2`) versions.
 */
export function parseMajorMinor(raw: string | null | undefined): ParsedVersion | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^v/i, '').split('-')[0].trim();
  const parts = cleaned.split('.');
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!parts.every(p => /^\d+$/.test(p))) return null;

  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1], 10);
  const patch = parts.length === 3 ? Number.parseInt(parts[2], 10) : null;
  if (
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < 0 ||
    minor < 0 ||
    (patch !== null && (!Number.isInteger(patch) || patch < 0))
  ) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    display: patch !== null ? `${major}.${minor}.${patch}` : `${major}.${minor}`,
  };
}

export function resolveRuntimeAppVersion(pkgVersion: string): string {
  try {
    const envVer = (import.meta as unknown as { env?: Record<string, string | undefined> })?.env
      ?.VITE_RELEASE_VERSION;
    if (envVer && envVer.trim()) {
      return envVer.trim();
    }
  } catch {
    // Node / Electron main process context
  }
  return pkgVersion;
}

export function formatDisplayVersion(raw: string | null | undefined, fallback = '1.0'): string {
  return parseMajorMinor(raw)?.display ?? fallback;
}

/**
 * Numeric comparison across both `vX.Y` and `vX.Y.Z`:
 * returns > 0 if candidate > current, 0 if equal (e.g. `4.5` == `4.5.0`), < 0 if older.
 */
export function compareVersions(candidateRaw: string, currentRaw: string): number {
  const candidate = parseMajorMinor(candidateRaw);
  const current = parseMajorMinor(currentRaw);
  if (!candidate || !current) return 0;
  if (candidate.major !== current.major) {
    return candidate.major - current.major;
  }
  if (candidate.minor !== current.minor) {
    return candidate.minor - current.minor;
  }
  return (candidate.patch ?? 0) - (current.patch ?? 0);
}

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GithubLatestReleasePayload {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  assets?: GithubReleaseAsset[];
}

export function pickPlatformReleaseAsset(
  assets: GithubReleaseAsset[] | undefined,
  targetPlatform: 'windows' | 'android',
): GithubReleaseAsset | null {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  if (targetPlatform === 'windows') {
    return (
      assets.find(a => /-portable-setup\.exe$/i.test(a.name)) ??
      assets.find(a => /\.exe$/i.test(a.name)) ??
      null
    );
  }
  return assets.find(a => /\.apk$/i.test(a.name)) ?? null;
}
