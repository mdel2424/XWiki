import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, emptyProfile, feedback, canonicalizeProfile, hidden } from '../src/recommendations.js';
import { excerpt, wikipediaLink } from '../src/reading.js';

const article = (id, title, category, people = 10) => ({ id, title, lang: 'en',
  url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`,
  description: category, categories: [category], extract: `${title} is related to ${category}.`, mentions: [],
  metrics: { distinctLinkers: people, mentionCount: people, latestMention: 1700000000 } });
const python = article('en:Python', 'Python programming', 'Programming languages');
const lisp = article('en:Lisp', 'Lisp programming', 'Programming languages');
const saturn = article('en:Saturn', 'Saturn', 'Astronomy', 500);
const options = { now: 1800000000000, seed: 3, diversify: false };

test('a heart boosts related content above unrelated all-time popularity', () => {
  const pool = [lisp, saturn];
  assert.equal(recommend(pool, emptyProfile(), options)[0].id, saturn.id);
  const ranked = recommend(pool, feedback(emptyProfile(), python, 'like'), options);
  assert.equal(ranked[0].id, lisp.id);
  assert.match(ranked[0].recommendation.reason, /Because you liked Python/);
});
test('not interested hides the exact article and lowers related-topic scores', () => {
  const profile = feedback(emptyProfile(), python, 'reject');
  const before = recommend([python, lisp, saturn], emptyProfile(), options);
  const after = recommend([python, lisp, saturn], profile, options);
  assert.ok(!after.some(a => a.id === python.id));
  assert.ok(after.find(a => a.id === lisp.id).recommendation.score < before.find(a => a.id === lisp.id).recommendation.score);
  assert.equal(after[0].id, saturn.id);
});
test('unlike and undo restore the original profile without accumulated weights', () => {
  let profile = feedback(emptyProfile(), python, 'like', 123);
  profile = feedback(profile, python, 'like', 123);
  assert.equal(Object.keys(profile.likes).length, 1);
  assert.deepEqual(feedback(profile, python, 'unlike'), emptyProfile());
  assert.deepEqual(feedback(feedback(emptyProfile(), python, 'reject'), python, 'undo-reject'), emptyProfile());
});
test('For you explicitly mixes 50% interest, 40% all-time popular and 10% discovery', () => {
  const pool = Array.from({ length: 30 }, (_, i) => article(`en:${i}`, `Article ${i}`, i % 2 ? 'Programming languages' : `Topic ${i}`, 1000 - i));
  const ranked = recommend(pool, feedback(emptyProfile(), python, 'like'), { seed: 20 });
  for (let i = 0; i < ranked.length; i += 10) {
    const block = ranked.slice(i, i + 10);
    assert.equal(block.filter(a => a.recommendation.lane === 'interest').length, 5);
    assert.equal(block.filter(a => a.recommendation.lane === 'popular').length, 4);
    assert.equal(block.filter(a => a.recommendation.lane === 'discovery').length, 1);
  }
  assert.equal(new Set(ranked.map(a => a.id)).size, pool.length);
});
test('reloading a persisted feedback profile gives the same personalized order', () => {
  const profile = feedback(emptyProfile(), python, 'like');
  assert.deepEqual(recommend([lisp, saturn], profile, options), recommend([lisp, saturn], JSON.parse(JSON.stringify(profile)), options));
});
test('Wikipedia redirects preserve hearts and negative signals without duplicating them', () => {
  let profile = feedback(emptyProfile(), python, 'like', 123);
  profile = feedback(profile, saturn, 'reject', 456);
  const canonical = { ...python, id: 'en:Python (programming language)', sourceIds: [python.id] };
  const next = canonicalizeProfile(profile, [canonical]);
  assert.equal(Object.keys(next.likes).length, 1);
  assert.equal(next.likes[canonical.id].at, 123);
  assert.equal(next.likes[python.id], undefined);
  assert.equal(next.rejected[saturn.id].at, 456);
});
test('seen posts stay hidden after reload without penalizing their category or removing hearts', () => {
  const liked = feedback(emptyProfile(), python, 'like', 10);
  const seen = JSON.parse(JSON.stringify(feedback(liked, python, 'seen', 20)));
  assert.equal(hidden(python, seen), true);
  assert.equal(seen.likes[python.id].at, 10);
  assert.deepEqual(seen.rejected, {});
  assert.ok(!recommend([python, lisp, saturn], seen, options).some(a => a.id === python.id));
  const score = p => recommend([lisp, saturn], p, options).find(a => a.id === lisp.id).recommendation.score;
  assert.equal(score(seen), score(liked));
  assert.equal(hidden(python, feedback(seen, python, 'undo-seen')), false);
});
test('seen feedback hides redirect aliases as well as the canonical article', () => {
  const seen = feedback(emptyProfile(), python, 'seen');
  const canonical = { ...python, id: 'en:Python (programming language)', sourceIds: [python.id] };
  const migrated = canonicalizeProfile(seen, [canonical]);
  assert.equal(hidden(python, migrated), true);
  assert.equal(hidden(canonical, migrated), true);
});
test('empty and metadata-free candidates remain usable', () => {
  assert.deepEqual(recommend([]), []);
  assert.equal(recommend([{ id: 'empty', title: '', mentions: [] }])[0].id, 'empty');
});
test('post text ends at a word boundary with an ellipsis and stays bounded', () => {
  const text = 'The history of computing and mathematical discovery. '.repeat(30);
  const preview = excerpt(text);
  assert.ok(preview.length <= 281);
  assert.ok(preview.endsWith('…'));
  assert.equal(excerpt('A short summary.'), 'A short summary.');
  assert.equal(excerpt('x'.repeat(300)).length, 281);
});
test('reading always uses a normal HTTPS Wikipedia article link', () => {
  assert.equal(wikipediaLink(python), 'https://en.wikipedia.org/wiki/Python_programming');
  assert.equal(wikipediaLink({ url: 'http://en.m.wikipedia.org/wiki/Earth#History' }), 'https://en.wikipedia.org/wiki/Earth');
});
test('restored or untrusted reading URLs cannot navigate to arbitrary schemes or origins', () => {
  for (const url of ['javascript:alert(1)', 'https://evil.example/wiki/Earth', 'https://en.wikipedia.org.evil.example/wiki/Earth']) {
    assert.equal(wikipediaLink({ url }), 'https://www.wikipedia.org/');
  }
});
