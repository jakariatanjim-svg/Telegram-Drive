import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localeCatalogPacking } from "./scripts/locale-catalog-packing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platformDir = path.resolve(__dirname, "src/platform/tauri");

export default defineConfig(async () => ({
  plugins: [
    localeCatalogPacking(),
    react(),
  ],

  resolve: {
    alias: {
      "@tauri-apps/api/core": path.join(platformDir, "core.ts"),
      "@tauri-apps/api/event": path.join(platformDir, "event.ts"),
      "@tauri-apps/api/window": path.join(platformDir, "window.ts"),
      "@tauri-apps/api/webview": path.join(platformDir, "webview.ts"),
      "@tauri-apps/plugin-store": path.join(platformDir, "plugin-store.ts"),
      "@tauri-apps/plugin-dialog": path.join(platformDir, "plugin-dialog.ts"),
      "@tauri-apps/plugin-os": path.join(platformDir, "plugin-os.ts"),
      "@tauri-apps/plugin-opener": path.join(platformDir, "plugin-opener.ts"),
      "@tauri-apps/plugin-shell": path.join(platformDir, "plugin-shell.ts"),
      "@tauri-apps/plugin-clipboard-manager": path.join(platformDir, "plugin-clipboard-manager.ts"),
      "@tauri-apps/plugin-deep-link": path.join(platformDir, "plugin-deep-link.ts"),
    },
  },

  optimizeDeps: {
    entries: ["index.html"],
  },

  build: {
    manifest: true,
    chunkSizeWarningLimit: 900,
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/android/**", "**/release/**", "**/dist-electron/**", "**/data/**", "**/data-dev/**"],
    },
  },
}));
