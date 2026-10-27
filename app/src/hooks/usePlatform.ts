import { useState, useEffect } from 'react';
import { type } from '@tauri-apps/plugin-os';

export function usePlatform() {
  const [platformInfo, setPlatformInfo] = useState({
    isMobile: false,
    isDesktop: true,
    isAndroid: false,
  });

  useEffect(() => {
    try {
      const osType = type();
      const isAndroid = osType === 'android';

      setPlatformInfo({
        isMobile: isAndroid,
        isDesktop: !isAndroid,
        isAndroid,
      });
    } catch {
      const ua = navigator.userAgent.toLowerCase();
      const isAndroid = ua.includes('android');

      setPlatformInfo({
        isMobile: isAndroid,
        isDesktop: !isAndroid,
        isAndroid,
      });
    }
  }, []);

  return platformInfo;
}
