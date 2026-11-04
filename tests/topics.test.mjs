import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, DEFAULT_PINS, DEFAULT_TOPIC_ORDER, homeFeeds, normalizePins, normalizeTopicOrder, moveTopic, matchesTopic } from '../src/topics.js';

test('topic lists recognize subjects from titles, descriptions and categories', () => {
  for (const [topic, article] of [
    ['math', { title: 'Linear algebra' }],
    ['math', { title: 'Ada', description: 'A mathematician' }],
    ['math', { title: 'Unfamiliar theorem', categories: ['Topology'] }],
    ['computer-science', { title: 'Rust (programming language)' }],
    ['computer-science', { title: 'B-tree', description: 'A data structure' }],
    ['computer-science', { title: 'Perceptron', categories: ['Machine learning'] }],
    ['physics', { title: 'Quantum entanglement' }],
    ['physics', { title: 'Noether', description: 'A physicist' }],
    ['physics', { title: 'M31', categories: ['Astronomy'] }],
    ['philosophy', { title: 'Epistemology' }],
    ['history', { title: 'A vanished city', categories: ['Archaeology'] }],
    ['biology', { title: 'DNA', description: 'A molecule carrying genetic information' }],
    ['psychology', { title: 'Attention', categories: ['Cognitive psychology'] }],
    ['economics', { title: 'Inflation' }],
    ['engineering', { title: 'An unfamiliar machine', categories: ['Electrical engineering'] }],
    ['arts-culture', { title: 'Art' }],
    ['arts-culture', { title: 'A composer', description: 'A writer of music' }],
  ]) assert.equal(matchesTopic(article, topic), true, `${topic}: ${article.title}`);
});

test('ambiguous word prefixes do not classify unrelated subjects as arts or math', () => {
  assert.equal(matchesTopic({ title: 'Artificial intelligence' }, 'arts-culture'), false);
  assert.equal(matchesTopic({ title: 'Article (grammar)' }, 'arts-culture'), false);
  assert.equal(matchesTopic({ title: 'Mathias', description: 'A given name' }, 'math'), false);
  assert.equal(matchesTopic({ title: 'Mathematics' }, 'math'), true);
});

test('pin preferences preserve empty choices, remove unknown or duplicate IDs, and keep For you', () => {
  assert.equal(TOPICS.length, 10);
  assert.deepEqual(normalizePins(null), DEFAULT_PINS);
  assert.deepEqual(normalizePins('broken'), DEFAULT_PINS);
  assert.deepEqual(normalizePins(['history', 'invalid', 'history', 'for-you', 'biology']), ['history', 'biology']);
  assert.deepEqual(homeFeeds([]).map(feed => feed.id), ['for-you']);
  assert.deepEqual(homeFeeds(['history', 'philosophy']).map(feed => feed.id), ['for-you', 'history', 'philosophy']);
  const pins = ['biology'];
  assert.deepEqual(homeFeeds(pins, 'history').map(feed => feed.id), ['for-you', 'biology', 'history']);
  assert.deepEqual(pins, ['biology'], 'Opening an unpinned topic never changes preferences');
});

test('picker defaults to alphabetical order, preserving custom order and appending new topics', () => {
  assert.deepEqual(normalizeTopicOrder(null).map(id => TOPICS.find(topic => topic.id === id).label),
    ['Arts & Culture', 'Biology', 'Computer Science', 'Economics', 'Engineering', 'History', 'Math', 'Philosophy', 'Physics', 'Psychology']);
  const custom = normalizeTopicOrder(['physics', 'history', 'physics', 'unknown']);
  assert.deepEqual(custom.slice(0, 2), ['physics', 'history']);
  assert.equal(new Set(custom).size, TOPICS.length);
  assert.deepEqual(custom.slice(2), DEFAULT_TOPIC_ORDER.filter(id => !['physics', 'history'].includes(id)));
  assert.deepEqual(normalizeTopicOrder('broken'), DEFAULT_TOPIC_ORDER);
});

test('reordering changes only position, and pinned tabs follow custom order without changing pin membership', () => {
  const moved = moveTopic(null, 'physics', 0);
  assert.deepEqual(moved, ['physics', ...DEFAULT_TOPIC_ORDER.filter(id => id !== 'physics')]);
  assert.equal(moveTopic(moved, 'physics', 99).at(-1), 'physics');
  assert.equal(moveTopic(moved, 'history', -1)[0], 'history');
  assert.deepEqual(homeFeeds(DEFAULT_PINS).map(feed => feed.id), ['for-you', 'computer-science', 'physics', 'history']);
  assert.deepEqual(homeFeeds(DEFAULT_PINS, 'for-you', moved).map(feed => feed.id), ['for-you', 'physics', 'computer-science', 'history']);
  assert.deepEqual(homeFeeds([], 'for-you', moved).map(feed => feed.id), ['for-you']);
});

test('incidental mentions in body text cannot turn an unrelated article into a topic post', () => {
  const article = { title: 'Local history', description: 'The history of a small town', categories: ['History'],
    extract: 'A mathematician, computer programmer and quantum physicist once visited this town.' };
  for (const topic of ['math', 'computer-science', 'physics']) assert.equal(matchesTopic(article, topic), false);
  assert.equal(matchesTopic({ title: 'Astronomical suffering', categories: ['Ethics'] }, 'physics'), false);
  assert.equal(matchesTopic({ title: 'Mechanical Turk', description: 'A chess-playing hoax' }, 'physics'), false);
  assert.equal(matchesTopic(article, 'for-you'), true);
  assert.equal(matchesTopic(article, 'top'), true);
});
