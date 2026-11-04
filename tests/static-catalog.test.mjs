import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { StaticCatalog, bucket, searchTerms } from '../src/static-catalog.js';
import { matchesTopic } from '../src/topics.js';
import { recommend, emptyProfile } from '../src/recommendations.js';
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

test('topic feeds paginate the full archive with personal discovery lanes and exclude incidental matches', async () => {
  const count = 1320;
  const categories = ['Algebra', 'Computer science', 'Quantum physics', 'Ethics', 'Archaeology',
    'Genetics', 'Cognitive psychology', 'Macroeconomics', 'Electronic engineering', 'Visual art', 'Unrelated'];
  const all = Array.from({ length: count }, (_, i) => ({ id: `en:Topic${i}`, title: `Topic ${i}`, _index: i,
    mentions: [], categories: [categories[i % categories.length]],
    extract: 'An incidental mention of mathematics, computer programming, quantum physics, philosophy, history, biology, psychology, economics, engineering and art.',
    metrics: { distinctLinkers: 10, mentionCount: count - i } }));
  const postings = Array.from({ length: 256 }, () => ({}));
  for (const article of all) for (const term of searchTerms(`${article.title} ${article.categories.join(' ')} ${article.extract}`)) {
    (postings[bucket(term.slice(0, 2), 256)][term] ||= []).push(article._index);
  }
  for (const weighted of [false, true]) {
    const manifest = { kind: 'wikihack-static', version: 1, generation: 'v-topics', articleCount: count,
      articleShardSize: 256, rankShardSize: 512, risingCount: count, searchBuckets: 256,
      ...(weighted ? { discoveryWeights: 'discovery-weights.json' } : {}) };
    const catalog = new StaticCatalog({ base: new URL('https://example.test/catalog/'), fetcher: async raw => {
      const file = new URL(raw).pathname;
      const shard = Number(file.split('/').at(-1).split('.')[0]);
      let value;
      if (file.endsWith('/manifest.json')) value = manifest;
      else if (file.endsWith('/discovery-weights.json')) value = all.map(() => 10);
      else if (file.includes('/search/')) value = postings[shard];
      else if (file.includes('/articles/')) value = all.slice(shard * 256, shard * 256 + 256);
      else if (file.includes('/rising/')) value = all.map(a => a._index).reverse().slice(shard * 512, shard * 512 + 512);
      else throw new Error(`Unexpected topic request: ${file}`);
      return { ok: true, json: async () => value };
    } });
    await catalog.open();
    for (const [category, mode] of ['math', 'computer-science', 'physics', 'philosophy', 'history',
      'biology', 'psychology', 'economics', 'engineering', 'arts-culture'].entries()) {
      const exclude = [`en:Topic${category}`], visited = new Set(exclude);
      let cursor = 0, pages = 0;
      do {
        const result = await catalog.feed({ mode, cursor, mix: 42, exclude: [...visited] });
        assert.ok(result.articles.every(a => matchesTopic(a, mode)), `${mode} is subject-specific`);
        assert.ok(result.articles.every(a => !visited.has(a.id)), `${mode} excludes hidden and previous posts`);
        if (pages === 0) {
          const ranked = recommend(result.articles, emptyProfile(), { seed: 42, sources: result.sources });
          assert.equal(ranked.length, 60, `${mode} produces a full first page`);
          assert.deepEqual(Object.fromEntries(['random', 'top', 'rising'].map(lane =>
            [lane, ranked.filter(a => a.recommendation.lane === lane).length])), { random: 48, top: 6, rising: 6 });
        }
        result.articles.forEach(a => visited.add(a.id));
        if (result.nextCursor) assert.ok(result.nextCursor.random > (cursor.random || 0));
        cursor = result.nextCursor;
        assert.ok(++pages < 20, 'Topic pagination finishes');
      } while (cursor);
      assert.equal(visited.size, count / categories.length, `${mode} reaches every relevant article, even beyond the first global page`);
    }
  }
});

test('FYP samples the full archive, shuffles featured ranks, and keeps 8:1:1 across pages', async () => {
  const count = 10000;
  const all = Array.from({ length: count }, (_, i) => ({ id: `en:Article${i}`, title: `Article ${i}`, _index: i,
    mentions: [], metrics: { distinctLinkers: Math.max(1, Math.floor((count - i) / 100)), mentionCount: count - i } }));
  const manifest = { kind: 'wikihack-static', version: 1, generation: 'v-test', articleCount: count,
    articleShardSize: 256, rankShardSize: 512, risingCount: 1100, risingPath: 'rising-6m-test',
    discoveryWeights: 'discovery-weights.json' };
  const base = new URL('https://example.github.io/WikiHack-mobile/data/catalog/');
  const catalog = new StaticCatalog({ base, fetcher: async raw => {
    const file = new URL(raw).pathname.slice(base.pathname.length);
    let value;
    if (file === 'manifest.json') value = manifest;
    else if (file.endsWith('/discovery-weights.json')) value = all.map(a => Math.min(255, a.metrics.distinctLinkers));
    else if (file.includes('/articles/')) {
      const start = Number(file.split('/').at(-1).split('.')[0]) * 256;
      value = all.slice(start, start + 256);
    } else if (file.includes('/rising-6m-test/')) {
      const start = Number(file.split('/').at(-1).split('.')[0]) * 512;
      value = Array.from({ length: Math.min(512, 1100 - start) }, (_, i) => 2000 + start + i);
    } else throw new Error(`Unexpected request: ${file}`);
    return { ok: true, json: async () => value };
  } });
  await catalog.open();
  const top = await catalog.feed({ mode: 'top' });
  const rising = await catalog.feed({ mode: 'rising' });
  assert.deepEqual(top.articles.map(a => a._index), Array.from({ length: 60 }, (_, i) => i));
  assert.deepEqual(rising.articles.map(a => a._index), Array.from({ length: 60 }, (_, i) => 2000 + i));
  let cursor = 0;
  const seen = [], featured = { top: [], rising: [] };
  for (let page = 0; page < 3; page++) {
    const result = await catalog.feed({ mix: 42, cursor, exclude: seen });
    const ranked = recommend(result.articles, emptyProfile(), { seed: 42, sources: result.sources, offset: seen.length });
    assert.equal(ranked.length, 60);
    assert.ok(ranked.every(a => !seen.includes(a.id)));
    for (let start = 0; start < 60; start += 10) {
      const block = ranked.slice(start, start + 10);
      for (const [lane, quota] of [['random', 8], ['rising', 1], ['top', 1]]) {
        assert.equal(block.filter(a => a.recommendation.lane === lane).length, quota);
        assert.ok(block.filter(a => a.recommendation.lane === lane).every(a => result.sources[lane].includes(a.id)));
      }
    }
    for (const lane of ['top', 'rising']) featured[lane].push(...ranked.filter(a => a.recommendation.lane === lane).map(a => a._index));
    assert.ok(ranked.filter(a => a.recommendation.lane === 'random').some(a => a._index >= 3000), 'random comes from beyond both featured pools');
    seen.push(...ranked.map(a => a.id)); cursor = result.nextCursor;
  }
  assert.equal(new Set(seen).size, 180);
  for (const lane of ['top', 'rising']) assert.notDeepEqual(featured[lane], [...featured[lane]].sort((a, b) => a - b));
  const again = await catalog.feed({ mix: 42 });
  const fresh = await catalog.feed({ mix: 43 });
  for (const lane of ['random', 'top', 'rising']) {
    assert.notDeepEqual(fresh.sources[lane], again.sources[lane], `${lane} changes with refresh`);
  }
});
