import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedSession } from '../src/feed-session.js';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const page = (id, nextCursor = null) => ({ articles: [{ id }], nextCursor });

test('tabs keep separate candidates and pagination cursors', async () => {
  const feeds = new FeedSession();
  await feeds.load(async () => page('personal', 60));
  feeds.select('for-you', 'top');
  await feeds.load(async ({ mode, sort, cursor }) => { assert.equal(mode, 'for-you'); assert.equal(sort, 'top'); assert.equal(cursor, 0); return page('all-time', 120); });
  feeds.select('for-you', 'rising');
  await feeds.load(async () => page('recent', 180));
  feeds.select('for-you', 'for-you');
  assert.deepEqual(feeds.tab().ids, ['personal']);
  await feeds.load(async ({ cursor }) => { assert.equal(cursor, 60); return page('next-personal'); });
  assert.deepEqual(feeds.tab().ids, ['personal', 'next-personal']);
  assert.equal(feeds.tab('for-you', 'top').cursor, 120);
  assert.equal(feeds.tab('for-you', 'rising').cursor, 180);
  assert.equal(feeds.select('random'), false);
});
test('topic lists own their cursors and cannot replace another selected list', async () => {
  const feeds = new FeedSession(), pending = deferred();
  feeds.select('math');
  const math = feeds.load(() => pending.promise);
  feeds.select('science');
  await feeds.load(async () => page('quantum', { random: 60, top: 6, rising: 6 }));
  pending.resolve(page('algebra', { random: 70, top: 8, rising: 9 }));
  assert.equal((await math).current, false);
  assert.deepEqual(feeds.tab().ids, ['quantum']);
  feeds.select('math');
  await feeds.load(async ({ cursor }) => {
    assert.deepEqual(cursor, { random: 70, top: 8, rising: 9 });
    return page('geometry');
  });
  assert.deepEqual(feeds.tab().ids, ['algebra', 'geometry']);
  assert.equal(feeds.tab('computing').ids, null);
  assert.equal(feeds.tab('for-you').ids, null);
});
test('rapid tab switches cannot commit an old response over the active tab', async () => {
  const feeds = new FeedSession(), first = deferred(), second = deferred();
  const personal = feeds.load(() => first.promise);
  feeds.select('for-you', 'top');
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
  assert.equal(feeds.tab('for-you', 'top').ids, null);
  feeds.canonicalize([{ id: 'canonical', sourceIds: ['new'] }]);
  assert.deepEqual(feeds.tab().ids, ['canonical']);
});

test('each topic/sort pair owns its candidates and late sort responses cannot replace the active sort', async () => {
  const feeds = new FeedSession(), pending = deferred();
  feeds.select('math', 'for-you');
  const discovery = feeds.load(() => pending.promise);
  feeds.select('math', 'wikipedia');
  await feeds.load(async ({ mode, sort, cursor }) => {
    assert.deepEqual([mode, sort, cursor], ['math', 'wikipedia', 0]);
    return page('most-read', 2);
  });
  pending.resolve(page('personal-math', { random: 40, top: 4, rising: 4 }));
  assert.equal((await discovery).current, false);
  assert.deepEqual(feeds.tab().ids, ['most-read']);
  feeds.select('science', 'wikipedia');
  assert.equal(feeds.tab().ids, null);
  feeds.select('math', 'wikipedia');
  await feeds.load(async ({ cursor }) => { assert.equal(cursor, 2); return page('next-most-read'); });
  assert.deepEqual(feeds.tab().ids, ['most-read', 'next-most-read']);
  feeds.select('math', 'for-you');
  assert.deepEqual(feeds.tab().ids, ['personal-math']);
  assert.deepEqual(feeds.tab().cursor, { random: 40, top: 4, rising: 4 });
  assert.equal(feeds.select('math', 'invalid'), false);
});

test('a published snapshot change invalidates every topic/sort and pending request', async () => {
  const feeds = new FeedSession(), pending = deferred();
  feeds.select('math', 'wikipedia');
  const old = feeds.load(() => pending.promise);
  feeds.select('science', 'top');
  await feeds.load(async () => page('old-physics', 10));
  feeds.invalidate();
  pending.resolve(page('old-math', 20));
  assert.equal((await old).stale, true);
  assert.equal(feeds.tab().ids, null);
  assert.equal(feeds.tab('math', 'wikipedia').ids, null);
  assert.equal(feeds.tab().cursor, 0);
});
