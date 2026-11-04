import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, DEFAULT_PINS, DEFAULT_TOPIC_ORDER, homeFeeds, normalizePins, normalizeTopicOrder, moveTopic, matchesTopic, predictionTopics } from '../src/topics.js';

test('all 21 topic groups use Wikipedia predictions, regardless of article wording', () => {
  assert.equal(TOPICS.length, 21);
  for (const topic of TOPICS) {
    const model = topic.models[0] + (topic.models[0].endsWith('.') ? 'Example' : '');
    const article = { title: 'An unfamiliar subject', topicPredictions: { [model]: 0.8 } };
    assert.equal(matchesTopic(article, topic.id), true, topic.label);
    assert.equal(matchesTopic({ title: topic.label, description: topic.label, categories: [topic.label] }, topic.id), false, 'Keywords alone never classify an article');
  }
  assert.equal(matchesTopic({ title: 'Feudalism', topicPredictions: { 'History_and_Society.History': 0.904 } }, 'history'), true);
  assert.equal(matchesTopic({ title: 'History of mathematics', topicPredictions: { 'STEM.Mathematics': 0.9 } }, 'history'), false);
  assert.equal(matchesTopic({ title: 'Unscored article' }, 'for-you'), true);
  assert.equal(matchesTopic({ title: 'Unscored article' }, 'top'), true);
});

test('prediction membership is multilabel, uses the standard threshold, and matches whole model paths', () => {
  assert.deepEqual(predictionTopics({ 'STEM.Physics': 0.5, 'STEM.Mathematics': 0.499, 'Culture.Biography.Biography*': 0.9 }), ['people', 'science']);
  assert.deepEqual(predictionTopics({ 'History and Society.History': 0.9 }), ['history']);
  assert.deepEqual(predictionTopics({ 'STEM.PhysicsExtra': 0.9, 'Culture.BiographyFake': 0.9 }), []);
  for (const score of [true, '0.9', NaN, Infinity, -1, 1.01]) assert.deepEqual(predictionTopics({ 'STEM.Physics': score }), []);
  for (const scores of [null, [], 'STEM.Physics']) assert.deepEqual(predictionTopics(scores), []);
  assert.equal(matchesTopic({ topics: ['history', 'people'] }, 'history'), true, 'Static index memberships work without embedding scores in every card');
});

test('saved pins migrate to new groups without losing empty choices or duplicating groups', () => {
  assert.deepEqual(normalizePins(null), DEFAULT_PINS);
  assert.deepEqual(normalizePins('broken'), DEFAULT_PINS);
  assert.deepEqual(normalizePins(['computer-science', 'physics', 'psychology', 'arts-culture', 'computing', 'invalid', 'for-you']), ['computing', 'science', 'society', 'arts']);
  assert.deepEqual(homeFeeds([]).map(feed => feed.id), ['for-you']);
  assert.deepEqual(homeFeeds(['history', 'philosophy']).map(feed => feed.id), ['for-you', 'history', 'philosophy']);
  const pins = ['biology'];
  assert.deepEqual(homeFeeds(pins, 'history').map(feed => feed.id), ['for-you', 'biology', 'history']);
  assert.deepEqual(pins, ['biology'], 'Opening a topic does not pin it');
});

test('picker defaults alphabetically and migrates custom order before appending new groups', () => {
  const labels = normalizeTopicOrder(null).map(id => TOPICS.find(topic => topic.id === id).label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, 'en')));
  const custom = normalizeTopicOrder(['physics', 'history', 'science', 'unknown', 'computer-science']);
  assert.deepEqual(custom.slice(0, 3), ['science', 'history', 'computing']);
  assert.equal(new Set(custom).size, TOPICS.length);
  assert.deepEqual(custom.slice(3), DEFAULT_TOPIC_ORDER.filter(id => !['science', 'history', 'computing'].includes(id)));
  assert.deepEqual(normalizeTopicOrder('broken'), DEFAULT_TOPIC_ORDER);
});

test('reordering changes position while preserving pins and their default subject order', () => {
  const moved = moveTopic(null, 'physics', 0);
  assert.deepEqual(moved, ['science', ...DEFAULT_TOPIC_ORDER.filter(id => id !== 'science')]);
  assert.equal(moveTopic(moved, 'science', 99).at(-1), 'science');
  assert.equal(moveTopic(moved, 'history', -1)[0], 'history');
  assert.deepEqual(homeFeeds(DEFAULT_PINS).map(feed => feed.id), ['for-you', 'computing', 'science', 'history']);
  assert.deepEqual(homeFeeds(DEFAULT_PINS, 'for-you', moved).map(feed => feed.id), ['for-you', 'science', 'computing', 'history']);
  assert.deepEqual(homeFeeds([], 'for-you', moved).map(feed => feed.id), ['for-you']);
});
