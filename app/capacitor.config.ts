import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.telegramdrive.app',
  appName: 'Telegram Drive',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
