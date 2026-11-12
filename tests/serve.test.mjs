import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../scripts/serve.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);

// Exercise the actual HTTP request handler without opening a listening socket.
function request(url, options = {}) {
  const server = createPreviewServer(options);
  return new Promise((resolve, reject) => {
    const response = {
      status: null,
      headers: {},
      writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body: String(body) }); },
    };
    server.on('error', reject);
    server.emit('request', { url }, response);
  });
}

test('preview serves the homepage and its bundled assets', async () => {
  const homepage = await request('/');
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers['Content-Type'], /^text\/html/);
  assert.match(homepage.body, /<title>xWiki<\/title>/);
  for (const [url, type] of [
    ['/index.html', 'text/html'],
    ['/src/app.js', 'text/javascript'],
    ['/style.css?v=1', 'text/css'],
    ['/data/feed-index.json', 'application/json'],
    ['/images/favicon.svg', 'image/svg+xml'],
  ]) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.ok(response.headers['Content-Type'].startsWith(type), url);
    assert.ok(response.body.length > 0, url);
  }
});

test('a static-only server serves exported data at a repository subpath and has no API', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wikihack-static-server-'));
  const website = path.join(directory, 'site');
  try {
    await mkdir(website);
    await writeFile(path.join(website, 'index.html'), '<h1>Static WikiHack</h1>');
    await exec(process.env.PYTHON || 'python3', ['-c', `
import sys
from pipeline.store import connect,ingest,resolve_threads,refresh_stats
from pipeline.static_export import export_static
from pathlib import Path
root=Path(sys.argv[1]);db=connect(str(root/'fixture.sqlite'))
with db:
 ingest(db,[{'id':1,'type':'story','title':'Fixture discussion','by':'fixture-user','time':1700000000,'url':'https://en.wikipedia.org/wiki/Earth'}])
 resolve_threads(db);refresh_stats(db)
export_static(db,root/'site/data/catalog')
db.close()
`, directory]);
    const options = { directory: website, basePath: '/WikiHack-mobile' };
    assert.equal((await request('/WikiHack-mobile/', options)).status, 200);
    const response = await request('/WikiHack-mobile/data/catalog/manifest.json', options);
    assert.equal(response.status, 200);
    const manifest = JSON.parse(response.body);
    assert.equal(manifest.articleCount, 1);
    const cards = JSON.parse((await request(`/WikiHack-mobile/data/catalog/${manifest.generation}/articles/0.json`, options)).body);
    assert.equal(cards[0].title, 'Earth');
    assert.equal((await request('/api/feed', options)).status, 404);
    assert.equal((await request('/WikiHack-mobile/api/feed', options)).status, 404);
    assert.equal((await request('/', options)).status, 404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('preview rejects missing files, directories, malformed paths and traversal', async () => {
  for (const url of ['/missing.html', '/src/', '/%ZZ', '/..%2f..%2f..%2fpackage.json', '/.git/config', '/%2egit/config']) {
    assert.equal((await request(url)).status, 404, url);
  }
});
