import nodeCrypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { guessMimeType, type MappedTelegramFile } from '../shared/mtprotoHelpers';

export interface ShareRecord {
  id: string;
  owner_id: string;
  folder_id: number | null;
  message_id: number;
  file_name: string;
  file_size: number;
  link: string;
  password_protected: boolean;
  password_hash?: string | null;
  expires_at: string | null;
  created_at: string;
  download_count: number;
}

export interface StreamServerCallbacks {
  resolveFileMeta: (folderId: number | null, messageId: number) => Promise<{
    name: string;
    size: number;
    mimeType: string;
    encrypted: boolean;
  }>;
  readPlainRange: (
    folderId: number | null,
    messageId: number,
    start: number,
    endInclusive: number,
    signal: AbortSignal,
  ) => AsyncGenerator<Uint8Array>;
  readDecryptedFull: (folderId: number | null, messageId: number) => Promise<Uint8Array>;
  getShare: (id: string) => ShareRecord | undefined;
  incrementShareDownload: (id: string) => void;
  listFolders: () => Promise<Array<{ id: number; name: string }>>;
  listFiles: (folderId: number | null) => Promise<MappedTelegramFile[]>;
  uploadBuffer: (folderId: number | null, fileName: string, data: Uint8Array) => Promise<void>;
  deleteFile: (folderId: number | null, messageId: number) => Promise<void>;
  createFolder: (name: string) => Promise<{ id: number; name: string }>;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseRangeHeader(rangeHeader: string | undefined, totalSize: number): { start: number; end: number } | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=') || totalSize <= 0) return null;
  const spec = rangeHeader.slice(6).split(',')[0].trim();
  const [startStr, endStr] = spec.split('-');
  let start = startStr ? Number.parseInt(startStr, 10) : NaN;
  let end = endStr ? Number.parseInt(endStr, 10) : totalSize - 1;
  if (Number.isNaN(start) && !Number.isNaN(end)) {
    start = Math.max(0, totalSize - end);
    end = totalSize - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= totalSize) {
    return null;
  }
  end = Math.min(end, totalSize - 1);
  if (end < start) return null;
  return { start, end };
}

export class LocalServersManager {
  private mediaServer: http.Server | null = null;
  private apiServer: http.Server | null = null;
  private webdavServer: http.Server | null = null;

  public mediaPort = 14201;
  public readonly streamToken = nodeCrypto.randomBytes(24).toString('hex');
  public readonly operationToken = nodeCrypto.randomBytes(16).toString('hex');

  constructor(private readonly callbacks: StreamServerCallbacks) {}

  async startMediaServer(preferredPort = 14201): Promise<number> {
    if (this.mediaServer) return this.mediaPort;

    const createHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handleMediaRequest(req, res).catch(err => {
        if (!res.headersSent) {
          res.writeHead(500, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
        }
        res.end(err instanceof Error ? err.message : 'Stream server error');
      });
    };

    const tryListen = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const srv = http.createServer(createHandler);
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => {
          srv.removeAllListeners('error');
          this.mediaServer = srv;
          const addr = srv.address() as AddressInfo;
          this.mediaPort = addr.port;
          resolve(addr.port);
        });
      });

    try {
      return await tryListen(preferredPort);
    } catch {
      return await tryListen(0);
    }
  }

  private async handleMediaRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Authorization, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.mediaPort}`);
    const parts = url.pathname.split('/').filter(Boolean);

    // /stream/:folder/:messageId
    if (parts[0] === 'stream' && parts.length >= 3) {
      const queryToken = url.searchParams.get('token');
      const authHeader = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (queryToken !== this.streamToken && authHeader !== this.streamToken) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized stream token');
        return;
      }

      const folderRaw = parts[1];
      const folderId =
        folderRaw === 'home' || folderRaw === 'saved' || folderRaw === 'null'
          ? null
          : Number.parseInt(folderRaw, 10);
      const messageId = Number.parseInt(parts[2], 10);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        res.writeHead(400);
        res.end('Invalid message ID');
        return;
      }

      await this.streamTelegramMessage(req, res, folderId, messageId);
      return;
    }

    // /s/:shareId or /share/:shareId
    if ((parts[0] === 's' || parts[0] === 'share') && parts[1]) {
      const share = this.callbacks.getShare(parts[1]);
      if (!share) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Share link not found or revoked.');
        return;
      }
      if (share.expires_at && Date.parse(share.expires_at) <= Date.now()) {
        res.writeHead(410, { 'Content-Type': 'text/plain' });
        res.end('Share link has expired.');
        return;
      }
      if (share.password_protected && share.password_hash) {
        const supplied = url.searchParams.get('pw') ?? '';
        const suppliedHash = nodeCrypto.createHash('sha256').update(supplied).digest('hex');
        if (suppliedHash !== share.password_hash) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Protected Share</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#1e293b;padding:24px;border-radius:14px;width:320px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;margin:12px 0}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#38bdf8;color:#0f172a;font-weight:700;cursor:pointer}</style></head>
<body><form method="GET"><h3>${escapeXml(share.file_name)}</h3><p style="font-size:13px;color:#94a3b8">Enter password to download:</p>
<input type="password" name="pw" autofocus required /><button type="submit">Download</button></form></body></html>`);
          return;
        }
      }
      this.callbacks.incrementShareDownload(share.id);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(share.file_name)}`,
      );
      await this.streamTelegramMessage(req, res, share.folder_id, share.message_id);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  private async streamTelegramMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    folderId: number | null,
    messageId: number,
  ): Promise<void> {
    const meta = await this.callbacks.resolveFileMeta(folderId, messageId);
    const mimeType = meta.mimeType || guessMimeType(meta.name);

    if (meta.encrypted) {
      const fullPlain = await this.callbacks.readDecryptedFull(folderId, messageId);
      const total = fullPlain.byteLength;
      const range = parseRangeHeader(req.headers.range, total);
      if (range) {
        const slice = fullPlain.subarray(range.start, range.end + 1);
        res.writeHead(206, {
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
          'Content-Length': String(slice.byteLength),
        });
        res.end(Buffer.from(slice));
      } else {
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
        });
        res.end(Buffer.from(fullPlain));
      }
      return;
    }

    const total = meta.size;
    const range = parseRangeHeader(req.headers.range, total);
    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, total - 1);
    const contentLength = total > 0 ? end - start + 1 : 0;

    if (range) {
      res.writeHead(206, {
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(contentLength),
      });
    } else {
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        ...(total > 0 ? { 'Content-Length': String(total) } : {}),
      });
    }

    if (req.method === 'HEAD' || total === 0) {
      res.end();
      return;
    }

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    try {
      for await (const chunk of this.callbacks.readPlainRange(
        folderId,
        messageId,
        start,
        end,
        abortController.signal,
      )) {
        if (abortController.signal.aborted || res.destroyed) break;
        const ok = res.write(Buffer.from(chunk));
        if (!ok) {
          await new Promise<void>(resolve => res.once('drain', resolve));
        }
      }
    } catch {
      // Client closed stream during seek; safe to end quietly.
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  async configureApiServer(opts: { enabled: boolean; port: number; apiKey: string }): Promise<boolean> {
    if (this.apiServer) {
      await new Promise<void>(resolve => this.apiServer!.close(() => resolve()));
      this.apiServer = null;
    }
    if (!opts.enabled || !opts.apiKey) return false;

    const srv = http.createServer((req, res) => {
      void (async () => {
        const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
        if (auth !== opts.apiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
        if (req.method === 'GET' && url.pathname === '/api/v1/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/folders') {
          const folders = await this.callbacks.listFolders();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ folders }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/files') {
          const rawFolder = url.searchParams.get('folderId');
          const folderId = rawFolder ? Number.parseInt(rawFolder, 10) : null;
          const files = await this.callbacks.listFiles(Number.isFinite(folderId) ? folderId : null);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ files }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      })().catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
      });
    });

    return await new Promise<boolean>(resolve => {
      srv.once('error', () => resolve(false));
      srv.listen(opts.port, '127.0.0.1', () => {
        this.apiServer = srv;
        resolve(true);
      });
    });
  }

  isApiRunning(): boolean {
    return Boolean(this.apiServer?.listening);
  }

  async configureWebDavServer(opts: { enabled: boolean; port: number; tokenHash: string | null }): Promise<boolean> {
    if (this.webdavServer) {
      await new Promise<void>(resolve => this.webdavServer!.close(() => resolve()));
      this.webdavServer = null;
    }
    if (!opts.enabled || !opts.tokenHash) return false;

    const srv = http.createServer((req, res) => {
      void (async () => {
        res.setHeader('DAV', '1, 2');
        res.setHeader('MS-Author-Via', 'DAV');
        if (req.method === 'OPTIONS') {
          res.writeHead(200, {
            Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND',
          });
          res.end();
          return;
        }

        const auth = req.headers.authorization ?? '';
        let authorized = false;
        if (auth.startsWith('Basic ')) {
          const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
          const pass = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
          const hash = nodeCrypto.createHash('sha256').update(pass).digest('hex');
          authorized = hash === opts.tokenHash;
        } else if (auth.startsWith('Bearer ')) {
          const hash = nodeCrypto.createHash('sha256').update(auth.slice(7)).digest('hex');
          authorized = hash === opts.tokenHash;
        }
        if (!authorized) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Telegram Drive WebDAV"' });
          res.end('Unauthorized');
          return;
        }

        const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
        const segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));

        if (req.method === 'PROPFIND') {
          const folders = await this.callbacks.listFolders();
          if (segments.length === 0) {
            const rootItems = [
              { href: '/', displayName: 'Telegram Drive', isDir: true, size: 0 },
              { href: '/Saved%20Messages/', displayName: 'Saved Messages', isDir: true, size: 0 },
              ...folders.map(f => ({
                href: `/${encodeURIComponent(f.name)}/`,
                displayName: f.name,
                isDir: true,
                size: 0,
              })),
            ];
            const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${rootItems
              .map(
                item => `<D:response><D:href>${item.href}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(
                  item.displayName,
                )}</D:displayname><D:resourcetype>${
                  item.isDir ? '<D:collection/>' : ''
                }</D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
              )
              .join('')}</D:multistatus>`;
            res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
            res.end(xml);
            return;
          }

          const folderName = segments[0];
          const folder =
            folderName === 'Saved Messages'
              ? { id: null as number | null, name: 'Saved Messages' }
              : folders.find(f => f.name === folderName);
          if (!folder) {
            res.writeHead(404);
            res.end();
            return;
          }
          const files = await this.callbacks.listFiles(folder.id);
          const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">
<D:response><D:href>/${encodeURIComponent(folderName)}/</D:href><D:propstat><D:prop><D:displayname>${escapeXml(
            folderName,
          )}</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
${files
  .map(
    file => `<D:response><D:href>/${encodeURIComponent(folderName)}/${encodeURIComponent(
      file.name,
    )}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(
      file.name,
    )}</D:displayname><D:getcontentlength>${file.size}</D:getcontentlength><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  )
  .join('')}</D:multistatus>`;
          res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
          res.end(xml);
          return;
        }

        if (req.method === 'MKCOL' && segments.length === 1) {
          await this.callbacks.createFolder(segments[0]);
          res.writeHead(201);
          res.end();
          return;
        }

        if (segments.length >= 2) {
          const folders = await this.callbacks.listFolders();
          const folderId =
            segments[0] === 'Saved Messages'
              ? null
              : (folders.find(f => f.name === segments[0])?.id ?? null);
          const targetName = segments[segments.length - 1];

          if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
            await this.callbacks.uploadBuffer(folderId, targetName, Buffer.concat(chunks));
            res.writeHead(201);
            res.end();
            return;
          }

          const files = await this.callbacks.listFiles(folderId);
          const file = files.find(f => f.name === targetName);
          if (!file) {
            res.writeHead(404);
            res.end();
            return;
          }

          if (req.method === 'DELETE') {
            await this.callbacks.deleteFile(folderId, file.id);
            res.writeHead(204);
            res.end();
            return;
          }

          if (req.method === 'GET' || req.method === 'HEAD') {
            await this.streamTelegramMessage(req, res, folderId, file.id);
            return;
          }
        }

        res.writeHead(405);
        res.end();
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });

    return await new Promise<boolean>(resolve => {
      srv.once('error', () => resolve(false));
      srv.listen(opts.port, '127.0.0.1', () => {
        this.webdavServer = srv;
        resolve(true);
      });
    });
  }

  isWebDavRunning(): boolean {
    return Boolean(this.webdavServer?.listening);
  }

  async stopAll(): Promise<void> {
    for (const srv of [this.mediaServer, this.apiServer, this.webdavServer]) {
      if (srv) {
        await new Promise<void>(resolve => srv.close(() => resolve()));
      }
    }
    this.mediaServer = null;
    this.apiServer = null;
    this.webdavServer = null;
  }
}
