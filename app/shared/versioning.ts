export const GITHUB_REPO = 'jakariatanjim-svg/Telegram-Drive';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases/latest`;
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface ParsedVersion {
  major: number;
  minor: number;
  display: string;
}

export function parseMajorMinor(raw: string | null | undefined): ParsedVersion | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^v/i, '').split('-')[0].trim();
  const parts = cleaned.split('.');
  if (parts.length < 2) return null;
  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || minor < 0) {
    return null;
  }
  return {
    major,
    minor,
    display: `${major}.${minor}`,
  };
}

export function formatDisplayVersion(raw: string | null | undefined, fallback = '1.0'): string {
  return parseMajorMinor(raw)?.display ?? fallback;
}

/**
 * Numeric comparison of vX.Y versions:
 * returns > 0 if candidate > current, 0 if equal, < 0 if older.
 */
export function compareVersions(candidateRaw: string, currentRaw: string): number {
  const candidate = parseMajorMinor(candidateRaw);
  const current = parseMajorMinor(currentRaw);
  if (!candidate || !current) return 0;
  if (candidate.major !== current.major) {
    return candidate.major - current.major;
  }
  return candidate.minor - current.minor;
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
