// Минимальный продакшн-сервер: раздаёт собранный фронтенд (dist/) и проксирует
// запросы к публичным API бирж (обход CORS). Без внешних зависимостей.
//   npm run build && npm start   →  http://localhost:8080
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROXY_TARGETS } from './proxy-targets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function proxy(req, res, prefix, target) {
  const url = new URL(req.url.slice(prefix.length) || '/', target);
  const upstream = https.request(
    url,
    {
      method: req.method,
      // Yahoo без «браузерного» User-Agent отвечает 429
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 BackTester/0.1' },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, {
        'content-type': up.headers['content-type'] || 'application/json',
        'access-control-allow-origin': '*',
      });
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  });
  upstream.end();
}

function serveStatic(req, res) {
  const clean = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(DIST, clean);
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found. Run `npm run build` first.');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http
  .createServer((req, res) => {
    for (const [prefix, target] of Object.entries(PROXY_TARGETS)) {
      if (req.url.startsWith(prefix + '/')) return proxy(req, res, prefix, target);
    }
    serveStatic(req, res);
  })
  .listen(PORT, () => console.log(`BackTester: http://localhost:${PORT}`));
