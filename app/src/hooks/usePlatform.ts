import { useState } from 'react';
import { type } from '@tauri-apps/plugin-os';

function detectPlatformInfo() {
  try {
    const osType = type();
    const isAndroid = osType === 'android';
    return {
      isMobile: isAndroid,
      isDesktop: !isAndroid,
      isAndroid,
    };
  } catch {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
    const isAndroid = ua.includes('android');
    return {
      isMobile: isAndroid,
      isDesktop: !isAndroid,
      isAndroid,
    };
  }
}

export function usePlatform() {
  const [platformInfo] = useState(detectPlatformInfo);
  return platformInfo;
}
