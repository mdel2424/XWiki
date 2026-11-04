import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeViews, readershipWeight, fetchReadership } from '../src/readership.js';
import { recommend, emptyProfile, feedback } from '../src/recommendations.js';
const now = 1800000000000;
const post = (id, views, linkers = 2) => ({ id, title: id, lang: 'en', mentions: [], metrics: { distinctLinkers: linkers },
  readership: { dailyViews: views, days: 30, checkedAt: now } });

test('low readership and few HN linkers compound the penalty while popular articles have a small capped boost', () => {
  assert.equal(readershipWeight(post('quiet', 0), now), .35);
  assert.equal(readershipWeight(post('established', 0, 20), now), .7);
  assert.equal(readershipWeight(post('normal', 100), now), 1);
  assert.equal(readershipWeight(post('popular', 10000), now), 1.15);
  assert.equal(readershipWeight(post('celebrity', 10000000), now), 1.15);
  for (const value of [null, { dailyViews: null }, { dailyViews: -1 }, { dailyViews: NaN },
    { dailyViews: 1, days: 30, checkedAt: now - 2 * 86400000 }]) {
    assert.equal(readershipWeight({ readership: value }, now), 1, 'Unknown, invalid or stale traffic is neutral');
  }
});

test('daily counts preserve zero and ignore missing days without assuming missing data means unpopular', () => {
  assert.equal(summarizeViews({ a: null, b: 0 }), null);
  assert.deepEqual(summarizeViews(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, i === 7 ? null : 0])), now), { dailyViews: 0, days: 7, checkedAt: now });
});

test('batched traffic resolves aliases, survives failure and caches successful results', async () => {
  const articles = [{ id: 'en:ReadershipAlias', title: 'ReadershipAlias', lang: 'en' }];
  let calls = 0;
  const request = async raw => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.searchParams.get('prop'), 'pageviews');
    assert.equal(url.searchParams.get('pvipdays'), '30');
    return { query: { redirects: [{ from: 'ReadershipAlias', to: 'Actual' }], pages: [{ title: 'Actual', pageviews: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i, 50])) }] } };
  };
  const result = await fetchReadership(articles, { request, now });
  assert.equal(result[0].readership.dailyViews, 50);
  assert.equal(result[0].id, articles[0].id, 'Traffic lookup does not change feed identity');
  await fetchReadership(articles, { request, now });
  assert.equal(calls, 1);
  const unavailable = [{ id: 'en:TrafficOffline', title: 'TrafficOffline', lang: 'en' }];
  assert.deepEqual(await fetchReadership(unavailable, { request: async () => { throw new Error('offline'); }, now }), unavailable);
});

test('random discovery softly favors readership, retains rare posts, and respects stronger personal signals', () => {
  const quiet = post('quiet', 0), popular = post('popular', 10000);
  let popularFirst = 0;
  for (let seed = 0; seed < 1000; seed++) popularFirst += recommend([quiet, popular], emptyProfile(), { seed, now })[0].id === popular.id;
  assert.ok(popularFirst > 700 && popularFirst < 850);
  const related = { ...quiet, title: 'Algebra proofs', categories: ['Mathematics'] };
  const liked = { ...related, id: 'liked' };
  const ranked = recommend([related, popular], feedback(emptyProfile(), liked, 'like'), { now });
  assert.equal(ranked[0].id, quiet.id);
});
