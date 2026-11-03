import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWikiUrl, extractArticles, articlesFromHits, mergeArticles, applyEnrichment, uniqueAuthors,
  rankArticles, searchArticles, plainText, YEAR, sixMonthsAgo } from '../src/core.js';
import { AlgoliaScanner, enrichArticles, fetchJson } from '../src/services.js';

const hit = (id, author, url, createdAt = 1000) => ({ objectID: String(id), author, url, created_at_i: createdAt, _tags: ['story'], title: 'A discussion' });
test('canonicalizes desktop/mobile, fragments, language and Unicode without losing parentheses', () => {
  const a = parseWikiUrl('http://en.m.wikipedia.org/wiki/Conway%27s_Game_of_Life#History');
  assert.equal(a.id, "en:Conway's Game of Life");
  assert.equal(parseWikiUrl('https://en.wikipedia.org/w/index.php?title=Dyson_sphere&oldid=3').id, 'en:Dyson sphere');
  assert.equal(parseWikiUrl('https://fr.wikipedia.org/wiki/Th%C3%A9orie_des_jeux').id, 'fr:Théorie des jeux');
  assert.equal(parseWikiUrl('https://en.wikipedia.org/wiki/Lisp_(programming_language)').title, 'Lisp (programming language)');
  assert.equal(parseWikiUrl('https://en.wikipedia.org/wiki/Star_Trek:_Voyager').title, 'Star Trek: Voyager');
});
test('rejects unrelated domains, non-article namespaces and dangerous schemes', () => {
  for (const url of ['https://en.wikipedia.org.evil.com/wiki/A', 'javascript:alert(1)', 'https://wikipedia.org/wiki/A',
    'https://en.wikipedia.org/wiki/Special:Random', 'https://en.wikipedia.org/wiki/Talk:Earth',
    'https://en.wikipedia.org/wiki/Category:Physics', 'https://en.wikipedia.org/wiki/Main_Page',
    'https://en.wikipedia.org/wiki/%ZZ']) assert.equal(parseWikiUrl(url), null, url);
});
test('extracts all distinct Wikipedia anchors from comments and story text', () => {
  const articles = extractArticles({ comment_text: '<p>See <a href="https://en.m.wikipedia.org/wiki/Earth#X">link</a> and <a href="https://en.wikipedia.org/wiki/Earth">earth</a> <a href="https://de.wikipedia.org/wiki/Erde">Erde</a>',
    story_text: '<a href="https://en.wikipedia.org/w/index.php?title=Moon&amp;oldid=2">moon</a>' });
  assert.deepEqual(articles.map(a => a.id).sort(), ['de:Erde', 'en:Earth', 'en:Moon']);
});
test('collects stories and comments, counts distinct people, deduplicates repeated pages', () => {
  const hits = [hit(1, 'alice', 'https://en.wikipedia.org/wiki/Earth'), hit(2, 'alice', 'https://en.wikipedia.org/wiki/Earth'),
    { objectID: '3', author: 'bob', created_at_i: 1001, _tags: ['comment'], story_id: 42,
      story_title: 'Planet &amp; science', comment_text: '<p>Try <a href="https://en.wikipedia.org/wiki/Earth">Earth</a>' }];
  const articles = articlesFromHits([...hits, ...hits]);
  assert.equal(articles.length, 1);
  assert.equal(articles[0].mentions.length, 3);
  assert.equal(uniqueAuthors(articles[0]), 2);
  const comment = articles[0].mentions.find(m => m.id === '3');
  assert.equal(comment.storyId, '42');
  assert.equal(comment.storyTitle, 'Planet & science');
  assert.equal(comment.text, 'Try Earth');
  assert.equal(comment.kind, 'comment');
});
test('Top ranks distinct authors; Rising excludes stale mentions', () => {
  const now = 1800000000;
  const articles = articlesFromHits([hit(1, 'a', 'https://en.wikipedia.org/wiki/Earth', now - YEAR - 1),
    hit(2, 'b', 'https://en.wikipedia.org/wiki/Earth', now - 240 * 86400),
    hit(3, 'c', 'https://en.wikipedia.org/wiki/Moon', now - 100)]);
  assert.equal(rankArticles(articles, 'top', { now })[0].title, 'Earth');
  assert.deepEqual(rankArticles(articles, 'rising', { now }).map(a => a.title), ['Moon']);
});
test('six-month cutoff clamps month ends and includes its boundary', () => {
  const now = Date.parse('2026-10-31T12:00:00Z') / 1000;
  const since = sixMonthsAgo(now);
  assert.equal(new Date(since * 1000).toISOString(), '2026-04-30T12:00:00.000Z');
  const pool = articlesFromHits([hit(1, 'a', 'https://en.wikipedia.org/wiki/Earth', since - 1),
    hit(2, 'b', 'https://en.wikipedia.org/wiki/Moon', since), hit(3, 'future', 'https://en.wikipedia.org/wiki/Mars', now + 1)]);
  assert.deepEqual(rankArticles(pool, 'rising', { now }).map(a => a.title), ['Moon']);
});
test('weighted random is repeat-free and deterministic with supplied randomness', () => {
  const articles = articlesFromHits([hit(1, 'a', 'https://en.wikipedia.org/wiki/Earth'), hit(2, 'b', 'https://en.wikipedia.org/wiki/Moon')]);
  const ranked = rankArticles(articles, 'random', { random: () => .5 });
  assert.equal(new Set(ranked.map(a => a.id)).size, articles.length);
  assert.ok(rankArticles(articles, 'random', { random: () => 0 }).every(Boolean));
});
test('metadata survives mention updates, search includes summaries, HTML stays plain', () => {
  const [article] = articlesFromHits([hit(1, 'a', 'https://en.wikipedia.org/wiki/Earth')]);
  const merged = mergeArticles([{ ...article, extract: 'A pale blue planet', firstParagraph: 'A complete paragraph.', thumbnail: 'https://example.org/image.png' }], [article]);
  assert.equal(merged[0].extract, 'A pale blue planet');
  assert.equal(merged[0].firstParagraph, 'A complete paragraph.');
  assert.equal(searchArticles(merged, 'BLUE planet').length, 1);
  assert.equal(plainText('<p>A &amp; B<br><img src=x onerror=alert(1)>&#x1F30D;'), 'A & B\n🌍');
});
test('scanner splits crowded time windows, visits every page, and preserves boundaries', async () => {
  const calls = [];
  const scanner = new AlgoliaScanner({ start: 0, end: 100, request: async raw => {
    const url = new URL(raw); const filter = url.searchParams.get('numericFilters');
    const page = Number(url.searchParams.get('page')); calls.push([filter, page]);
    if (filter === 'created_at_i>=0,created_at_i<100') return { nbHits: 1200, nbPages: 10, hits: [] };
    return { nbHits: 200, nbPages: 2, hits: [hit(`${filter}:${page}`, 'user', 'https://en.wikipedia.org/wiki/Earth')] };
  } });
  let count = 0;
  while (!scanner.exhausted) { await scanner.next(); count++; }
  assert.equal(count, 4);
  assert.deepEqual(calls.slice(1), [['created_at_i>=50,created_at_i<100', 0], ['created_at_i>=50,created_at_i<100', 1],
    ['created_at_i>=0,created_at_i<50', 0], ['created_at_i>=0,created_at_i<50', 1]]);
});
test('scanner retries a failed page without advancing and restores checkpoints', async () => {
  let failed = false;
  const scanner = new AlgoliaScanner({ start: 0, end: 100, request: async () => {
    if (!failed) { failed = true; throw new Error('Offline'); }
    return { nbHits: 0, nbPages: 0, hits: [] };
  } });
  await assert.rejects(scanner.next(), /Offline/);
  const restored = new AlgoliaScanner({ request: scanner.request });
  restored.restore(scanner.checkpoint());
  await restored.next();
  assert.equal(restored.exhausted, true);
});
test('scanner reports unsplittable API truncation instead of silently dropping data', async () => {
  const scanner = new AlgoliaScanner({ start: 0, end: 1, request: async () => ({ nbHits: 1001 }) });
  await assert.rejects(scanner.next(), /1,000 hits/);
});
test('redirect enrichment merges aliases, preserves mentions and tracks source IDs', async () => {
  const articles = articlesFromHits([hit(1, 'a', 'https://en.wikipedia.org/wiki/Bikeshedding'),
    hit(2, 'b', 'https://en.wikipedia.org/wiki/Parkinson%27s_law_of_triviality')]);
  const enriched = await enrichArticles(articles, { request: async () => ({ query: {
    redirects: [{ from: 'Bikeshedding', to: "Parkinson's law of triviality" }],
    pages: [{ title: "Parkinson's law of triviality", extract: 'The law', terms: { description: ['A familiar detail'] } }],
  } }) });
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].mentions.length, 2);
  assert.equal(enriched[0].sourceIds.length, 2);
  assert.equal(enriched[0].metadataLoaded, true);
});
test('HTTP failures propagate instead of becoming an empty feed', async () => {
  await assert.rejects(fetchJson('https://example.org', { fetcher: async () => ({ ok: false, status: 429 }) }), /429/);
});

test('late enrichment retains fresh mentions and does not merge different articles from one comment', () => {
  const initial = articlesFromHits([{ objectID: '1', author: 'a', created_at_i: 10, _tags: ['comment'],
    comment_text: '<a href="https://en.wikipedia.org/wiki/Earth">Earth</a> <a href="https://en.wikipedia.org/wiki/Moon">Moon</a>' }]);
  const enriched = initial.map(a => ({ ...a, sourceIds: [a.id], extract: a.title, metadataLoaded: true }));
  const current = mergeArticles(initial, articlesFromHits([hit(2, 'b', 'https://en.wikipedia.org/wiki/Earth')]));
  const result = applyEnrichment(current, enriched);
  assert.equal(result.length, 2);
  assert.equal(result.find(a => a.title === 'Earth').mentions.length, 2);
  assert.equal(result.find(a => a.title === 'Moon').mentions.length, 1);
});
