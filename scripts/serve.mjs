import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
export function createPreviewServer({ directory = process.env.STATIC_DIR || defaultRoot, basePath = '' } = {}) {
  const root = path.resolve(directory);
  const prefix = basePath.replace(/\/$/, '');
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (prefix && !url.pathname.startsWith(prefix + '/')) throw new Error('Not found');
      const pathname = url.pathname.slice(prefix.length);
      const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      const file = path.resolve(root, `.${relative}`);
      if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new Error('Not found');
      res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  const server = createPreviewServer();
  server.on('error', error => { console.error(`Preview server could not start: ${error.message}`); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log(`WikiHack: http://${host === '127.0.0.1' || host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (host === '0.0.0.0') console.log(`On your phone, open http://<this computer's LAN IP>:${port} on the same network.`);
  });
}
