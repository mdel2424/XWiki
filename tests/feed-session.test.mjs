import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedSession } from '../web/src/feed-session.js';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const page = (id, nextCursor = null) => ({ articles: [{ id }], nextCursor });

test('tabs keep separate candidates and pagination cursors', async () => {
  const feeds = new FeedSession();
  await feeds.load(async () => page('personal', 60));
  feeds.select('top');
  await feeds.load(async ({ mode, cursor }) => { assert.equal(mode, 'top'); assert.equal(cursor, 0); return page('all-time', 120); });
  feeds.select('rising');
  await feeds.load(async () => page('recent', 180));
  feeds.select('for-you');
  assert.deepEqual(feeds.tab().ids, ['personal']);
  await feeds.load(async ({ cursor }) => { assert.equal(cursor, 60); return page('next-personal'); });
  assert.deepEqual(feeds.tab().ids, ['personal', 'next-personal']);
  assert.equal(feeds.tab('top').cursor, 120);
  assert.equal(feeds.tab('rising').cursor, 180);
  assert.equal(feeds.select('random'), false);
});
test('rapid tab switches cannot commit an old response over the active tab', async () => {
  const feeds = new FeedSession(), first = deferred(), second = deferred();
  const personal = feeds.load(() => first.promise);
  feeds.select('top');
  const popular = feeds.load(() => second.promise);
  first.resolve(page('old-personal', 60));
  assert.equal((await personal).current, false);
  assert.equal(feeds.tab().loading, true);
  assert.equal(feeds.tab().ids, null);
  second.resolve(page('popular', 120));
  assert.equal((await popular).current, true);
  assert.deepEqual(feeds.tab().ids, ['popular']);
  assert.equal(feeds.tab().cursor, 120);
});
test('a refresh supersedes an older request, including stale failures', async () => {
  const feeds = new FeedSession(), first = deferred(), second = deferred();
  const old = feeds.load(() => first.promise);
  const fresh = feeds.load(() => second.promise, { reset: true });
  first.reject(new Error('late timeout'));
  assert.equal((await old).stale, true);
  assert.equal(feeds.tab().loading, true);
  second.resolve(page('fresh'));
  await fresh;
  assert.deepEqual(feeds.tab().ids, ['fresh']);
  assert.equal(feeds.tab().loading, false);
});
test('refresh replaces the selected page, deduplicates IDs, and preserves other tabs', async () => {
  const feeds = new FeedSession();
  await feeds.load(async () => page('old', 60));
  await feeds.load(async ({ cursor }) => { assert.equal(cursor, 0); return { articles: [{ id: 'new' }, { id: 'new' }], nextCursor: 10 }; }, { reset: true });
  assert.deepEqual(feeds.tab().ids, ['new']);
  assert.equal(feeds.tab().cursor, 10);
  assert.equal(feeds.tab('top').ids, null);
  feeds.canonicalize([{ id: 'canonical', sourceIds: ['new'] }]);
  assert.deepEqual(feeds.tab().ids, ['canonical']);
});
