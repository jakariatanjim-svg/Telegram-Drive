import { isAndroidNative } from '../nativeBridge';

export type OsType = 'windows' | 'android';

export function type(): OsType {
  if (isAndroidNative()) return 'android';
  if (typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)) {
    return 'android';
  }
  return 'windows';
}

export function platform(): OsType {
  return type();
}
