import type { Settings } from '../types/settings';

export interface AndroidTransferEnvironment {
  connected: boolean;
  metered: boolean;
  roaming: boolean;
  charging: boolean;
  batteryLow: boolean;
  storageLow: boolean;
  freeBytes: number;
  powerSaveMode: boolean;
  backgroundRestricted: boolean;
}

export interface AndroidTransferGate {
  allowed: boolean;
  reason?: string;
}

const GIB = 1024 ** 3;
const STORAGE_SAFETY_MARGIN_BYTES = 256 * 1024 ** 2;

export function evaluateAndroidTransferPolicy(
  environment: AndroidTransferEnvironment | undefined,
  settings: Pick<Settings,
    | 'androidWifiOnlyTransfers'
    | 'androidAllowRoaming'
    | 'androidRequireCharging'
    | 'androidPauseOnLowBattery'
    | 'androidMinimumFreeStorageGb'>,
  requiredDownloadBytes = 0,
): AndroidTransferGate {
  if (!environment) return { allowed: false, reason: 'Checking Android transfer conditions' };
  if (!environment.connected) return { allowed: false, reason: 'Waiting for a network connection' };
  if (settings.androidWifiOnlyTransfers && environment.metered) {
    return { allowed: false, reason: 'Waiting for an unmetered Wi-Fi connection' };
  }
  if (!settings.androidAllowRoaming && environment.roaming) {
    return { allowed: false, reason: 'Transfers are paused while roaming' };
  }
  if (settings.androidRequireCharging && !environment.charging) {
    return { allowed: false, reason: 'Waiting for the device to charge' };
  }
  if (settings.androidPauseOnLowBattery && environment.batteryLow && !environment.charging) {
    return { allowed: false, reason: 'Transfers are paused while the battery is low' };
  }
  // Only enforce full storage reserve when a download size is specified; zero-copy uploads need minimal scratch space.
  if (requiredDownloadBytes > 0) {
    if (environment.storageLow) {
      return { allowed: false, reason: 'Android reports that device storage is low' };
    }
    const configuredReserve = Math.max(0.25, settings.androidMinimumFreeStorageGb) * GIB;
    const required = Math.max(0, requiredDownloadBytes) + STORAGE_SAFETY_MARGIN_BYTES;
    if (environment.freeBytes < Math.max(configuredReserve, required)) {
      return { allowed: false, reason: 'Not enough free storage for this transfer' };
    }
  } else if (environment.freeBytes > 0 && environment.freeBytes < 64 * 1024 * 1024) {
    return { allowed: false, reason: 'Device storage is critically full (< 64 MB free)' };
  }
  return { allowed: true };
}
