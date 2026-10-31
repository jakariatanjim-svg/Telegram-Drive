import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
} from 'electron';
import { DesktopEngine } from './engine';
import { atomicWriteFileSync } from './mtprotoNode';
import { initPortablePaths } from './portablePaths';

// CRITICAL PORTABLE REQUIREMENT:
// Redirect ALL Electron & Chromium paths into `<InstallDir>/data/` BEFORE `app.whenReady()`.
const portablePaths = initPortablePaths(app);

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'tdfile',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
const storeCache = new Map<string, Record<string, unknown>>();

function sendRendererEvent(event: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('td:event', event, payload);
  }
}

const engine = new DesktopEngine(sendRendererEvent);

function extractDeepLinks(argv: string[]): string[] {
  return argv.filter(arg => /^tgdrive:\/\//i.test(arg));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const urls = extractDeepLinks(argv);
    if (urls.length > 0) {
      sendRendererEvent('td:deep-link', urls);
    }
  });
}

function resolveAppIconPath(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'packaging', 'icon.ico'),
    path.resolve(__dirname, '..', 'packaging', 'icon.png'),
    path.resolve(process.cwd(), 'packaging', 'icon.ico'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function readJsonStore(storeName: string): Record<string, unknown> {
  const safeName = path.basename(storeName || 'store.json');
  if (storeCache.has(safeName)) {
    return storeCache.get(safeName)!;
  }
  const filePath = path.join(portablePaths.storesDir, safeName);
  let loaded: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      loaded = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      loaded = {};
    }
  }
  storeCache.set(safeName, loaded);
  return loaded;
}

function saveJsonStore(storeName: string): void {
  const safeName = path.basename(storeName || 'store.json');
  const data = storeCache.get(safeName) ?? {};
  const filePath = path.join(portablePaths.storesDir, safeName);
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

function flushAllStoresSync(): void {
  for (const storeName of storeCache.keys()) {
    try {
      saveJsonStore(storeName);
    } catch {
      // Best-effort flush
    }
  }
}

function reloadAllStoresSync(): void {
  storeCache.clear();
}

engine.setLifecycleHooks({
  flushStoresSync: flushAllStoresSync,
  reloadStoresSync: reloadAllStoresSync,
  triggerAppQuit: () => {
    isQuitting = true;
    app.quit();
  },
});

function setupTray(): void {
  if (tray) return;
  const iconPath = resolveAppIconPath();
  if (!fs.existsSync(iconPath)) return;

  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img);
  tray.setToolTip('Telegram Drive');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Telegram Drive',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Transfers',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
        sendRendererEvent('desktop-navigation', { target: 'transfers' });
      },
    },
    {
      label: 'Settings',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
        sendRendererEvent('desktop-navigation', { target: 'settings' });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Telegram Drive',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    title: 'Telegram Drive',
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [width, height] = mainWindow.getSize();
    sendRendererEvent('tauri://resize', { width, height });
  });

  mainWindow.on('close', event => {
    if (isQuitting) return;
    const prefs = engine.getDesktopPreferences();
    if (prefs.backgroundModeEnabled !== false && prefs.closeBehavior === 'background') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|tg:|mailto:)/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadURL('app://telegram-drive/index.html');
  }
}

function resolveStaticMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}

function registerProtocols(): void {
  const distDir = path.resolve(__dirname, '..', 'dist');

  protocol.handle('app', request => {
    const reqUrl = new URL(request.url);
    let relPath = decodeURIComponent(reqUrl.pathname);
    if (!relPath || relPath === '/') relPath = '/index.html';

    const candidate = path.normalize(path.join(distDir, relPath));
    if (!candidate.startsWith(distDir)) {
      return new Response('Forbidden', { status: 403 });
    }

    const finalFile =
      fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        ? candidate
        : path.join(distDir, 'index.html');

    const body = fs.readFileSync(finalFile);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': resolveStaticMimeType(finalFile),
        'Cache-Control': 'no-cache',
      },
    });
  });

  protocol.handle('tdfile', request => {
    const reqUrl = new URL(request.url);
    const rawPath = reqUrl.searchParams.get('path') ?? decodeURIComponent(reqUrl.pathname.replace(/^\//, ''));
    if (!rawPath || !fs.existsSync(rawPath)) {
      return new Response('Not Found', { status: 404 });
    }
    return net.fetch(pathToFileURL(rawPath).href);
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('td:invoke', async (_e, cmd: string, args: Record<string, unknown>) => {
    return await engine.invoke(cmd, args ?? {});
  });

  ipcMain.on('td:client-event', (_e, eventName: string, payload: unknown) => {
    sendRendererEvent(eventName, payload);
  });

  ipcMain.handle('td:window', async (_e, action: string, payload?: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    switch (action) {
      case 'minimize':
        mainWindow.minimize();
        return null;
      case 'toggleMaximize':
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
        return null;
      case 'close':
        mainWindow.close();
        return null;
      case 'isMaximized':
        return mainWindow.isMaximized();
      case 'setFullscreen':
        mainWindow.setFullScreen(Boolean(payload));
        return null;
      case 'isFullscreen':
        return mainWindow.isFullScreen();
      case 'setFocus':
        mainWindow.focus();
        return null;
      case 'show':
        mainWindow.show();
        return null;
      case 'hide':
        mainWindow.hide();
        return null;
      case 'setTitle':
        mainWindow.setTitle(String(payload ?? 'Telegram Drive'));
        return null;
      default:
        return null;
    }
  });

  ipcMain.handle(
    'td:store',
    async (_e, storeName: string, action: string, key?: string, value?: unknown) => {
      const store = readJsonStore(storeName);
      switch (action) {
        case 'get':
          return key !== undefined && key in store ? store[key] : null;
        case 'set':
          if (key !== undefined) {
            store[key] = value;
            saveJsonStore(storeName);
          }
          return null;
        case 'delete':
          if (key !== undefined && key in store) {
            delete store[key];
            saveJsonStore(storeName);
            return true;
          }
          return false;
        case 'clear':
          for (const k of Object.keys(store)) delete store[k];
          saveJsonStore(storeName);
          return null;
        case 'keys':
          return Object.keys(store);
        case 'entries':
          return Object.entries(store);
        case 'save':
          saveJsonStore(storeName);
          return null;
        default:
          return null;
      }
    },
  );

  ipcMain.handle('td:dialog', async (_e, kind: 'open' | 'save', opts: Record<string, unknown> = {}) => {
    const rawFilters = (opts.filters as Array<{ name: string; extensions: string[] }> | undefined) ?? undefined;
    if (kind === 'save') {
      const res = await dialog.showSaveDialog(mainWindow!, {
        title: typeof opts.title === 'string' ? opts.title : undefined,
        defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
        filters: rawFilters,
      });
      return res.canceled ? null : (res.filePath ?? null);
    }

    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [];
    if (opts.directory) properties.push('openDirectory');
    else properties.push('openFile');
    if (opts.multiple) properties.push('multiSelections');

    const res = await dialog.showOpenDialog(mainWindow!, {
      title: typeof opts.title === 'string' ? opts.title : undefined,
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      filters: rawFilters,
      properties,
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return opts.multiple ? res.filePaths : res.filePaths[0];
  });

  ipcMain.handle('td:open-external', async (_e, url: string) => {
    if (typeof url === 'string' && /^(https?:|tg:|mailto:)/i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('td:open-path', async (_e, targetPath: string) => {
    if (typeof targetPath === 'string' && fs.existsSync(targetPath)) {
      await shell.openPath(targetPath);
    }
  });

  ipcMain.handle('td:reveal-path', async (_e, targetPath: string) => {
    if (typeof targetPath === 'string' && fs.existsSync(targetPath)) {
      shell.showItemInFolder(targetPath);
    }
  });

  ipcMain.handle('td:clipboard', async (_e, action: 'read' | 'write', text?: string) => {
    if (action === 'write') {
      clipboard.writeText(String(text ?? ''));
      return null;
    }
    return clipboard.readText();
  });
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerProtocols();
  registerIpcHandlers();
  await engine.initialize();

  powerMonitor.on('suspend', () => {
    engine.flushSync();
    const prefs = engine.getDesktopPreferences();
    if (prefs.lockOnSleep !== false) {
      engine.vault.lock();
    }
  });

  powerMonitor.on('shutdown', () => {
    isQuitting = true;
    engine.flushSync();
    try {
      session.defaultSession.flushStorageData();
    } catch {
      // Ignore
    }
  });

  setupTray();
  createMainWindow();
});

// Windows emits 'session-end' when the user restarts, shuts down, or signs out of Windows.
(app as unknown as NodeJS.EventEmitter).on('session-end', () => {
  isQuitting = true;
  engine.flushSync();
  try {
    session.defaultSession.flushStorageData();
  } catch {
    // Ignore
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  engine.flushSync();
});

app.on('will-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (!shutdownPromise) {
    engine.flushSync();
    const forceTimer = setTimeout(() => {
      shutdownComplete = true;
      app.quit();
    }, 5000);
    shutdownPromise = (async () => {
      try {
        await engine.shutdown();
        session.defaultSession.flushStorageData();
      } catch {
        // Best-effort graceful shutdown
      } finally {
        clearTimeout(forceTimer);
        flushAllStoresSync();
        shutdownComplete = true;
        app.quit();
      }
    })();
  }
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit();
  }
});
