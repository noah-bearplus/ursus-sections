import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.liquid': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export interface StaticServer {
  url: string;
  origin: string;
  close(): Promise<void>;
}

export interface ServeOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  host?: string;
}

/**
 * Minimal static server so Playwright (and people) can load workspace files over http —
 * fonts/CORS and clipboard need it. Supports byte ranges because Safari will not play video without them.
 */
export async function serveDir(dir: string, opts: ServeOptions = {}): Promise<StaticServer> {
  const root = resolve(dir);
  const server: Server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      let file = normalize(join(root, urlPath));
      if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      const st = await stat(file).catch(() => null);
      if (st?.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      const headers = {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'access-control-allow-origin': '*',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start > end || start >= body.length) {
          res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end();
          return;
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}` });
        res.end(body.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, host, ok);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const origin = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  return {
    url: origin + '/',
    origin,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
