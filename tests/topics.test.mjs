import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesTopic } from '../src/topics.js';

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
  ]) assert.equal(matchesTopic(article, topic), true, `${topic}: ${article.title}`);
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
