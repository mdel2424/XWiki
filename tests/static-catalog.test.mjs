import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { StaticCatalog } from '../web/src/static-catalog.js';
const exec = promisify(execFile);

test('the full static client works under a GitHub Pages project subpath without any API', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'wikihack-static-'));
  try {
    await exec(process.env.PYTHON || 'python3', ['-c', `
import sys,time
from pipeline.store import *
from pipeline.static_export import export_static
db=connect(sys.argv[1]+'/fixture.sqlite');now=int(time.time())
with db:
 ingest(db,[{'id':1,'type':'story','title':'Root discussion'},
  *[{'id':i,'type':'comment','parent':1,'by':str(i),'time':now-i,'text':'<a href="https://en.wikipedia.org/wiki/Earth">Earth</a>'} for i in range(2,9)],
  {'id':9,'type':'story','by':'moon','time':now,'url':'https://en.wikipedia.org/wiki/Moon'},
  {'id':10,'type':'story','by':'old','time':1,'url':'https://en.wikipedia.org/wiki/G%C3%B6del'}])
 resolve_threads(db);refresh_stats(db)
export_static(db,sys.argv[1]+'/catalog',article_size=2,context_size=2,rank_size=2)
db.close()
`, temporary]);
    const requests = [];
    const base = new URL('https://example.github.io/WikiHack-mobile/data/catalog/');
    const catalog = new StaticCatalog({ base, fetcher: async url => {
      requests.push(url);
      assert.ok(url.startsWith(base.href));
      assert.ok(!url.includes('/api/'));
      return { ok: true, json: async () => JSON.parse(await readFile(path.join(temporary, 'catalog', new URL(url).pathname.slice(base.pathname.length)), 'utf8')) };
    } });
    await catalog.open();
    const top = await catalog.feed({ mode: 'top', limit: 1 });
    assert.equal(top.articles[0].title, 'Earth');
    assert.equal(top.articles[0].metrics.distinctLinkers, 7);
    assert.equal(top.nextCursor, 1);
    assert.equal(requests.filter(url => url.includes('/articles/')).length, 1);
    const context = await catalog.article('en:Earth', { cursor: 1, limit: 4 });
    assert.equal(context.mentions.length, 4);
    assert.equal(context.mentions[0].id, '3');
    assert.equal(context.mentions[0].storyTitle, 'Root discussion');
    assert.equal(context.nextCursor, 5);
    assert.equal((await catalog.article('en:Earth', { cursor: 5, limit: 4 })).nextCursor, null);
    const rising = await catalog.feed({ mode: 'rising' });
    assert.ok(!rising.articles.some(a => a.title === 'Gödel'));
    assert.equal((await catalog.search('ear')).articles[0].title, 'Earth');
    assert.equal((await catalog.search('Gö')).articles[0].title, 'Gödel');
    assert.equal((await catalog.search('no-such-title')).articles.length, 0);
    assert.ok((await catalog.feed({ mode: 'for-you', seeds: [{ title: 'Moon' }], mix: 22 })).articles.length > 0);
    const commentsBefore = requests.filter(url => url.includes('/context/')).length;
    await catalog.article('en:Earth', { cursor: 1, limit: 4 });
    assert.equal(requests.filter(url => url.includes('/context/')).length, commentsBefore);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
