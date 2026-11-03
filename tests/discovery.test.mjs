import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryWeight, discoveryOrder } from '../src/discovery.js';

test('discovery weights have diminishing returns, an exploration floor and a popularity cap', () => {
  const weights = [0, 1, 10, 100, 255].map(discoveryWeight);
  assert.equal(weights[0], 1);
  assert.ok(weights.every((weight, i) => !i || weight > weights[i - 1]));
  assert.ok(discoveryWeight(100) / discoveryWeight(1) > 2.8);
  assert.ok(discoveryWeight(100) / discoveryWeight(1) < 3);
  assert.equal(discoveryWeight(1000000), discoveryWeight(255));
  assert.equal(discoveryWeight(-10), 1);
  assert.equal(discoveryWeight(NaN), 1);
});

test('weighted draws favor highly linked articles without excluding single-link discoveries', () => {
  let popularFirst = 0;
  const trials = 6000;
  for (let seed = 0; seed < trials; seed++) popularFirst += discoveryOrder([1, 100], seed)[0] === 1;
  const expected = discoveryWeight(100) / (discoveryWeight(1) + discoveryWeight(100));
  assert.ok(Math.abs(popularFirst / trials - expected) < .025);
  assert.ok(popularFirst / trials > .7 && popularFirst / trials < .8);
});

test('weighted order is repeat-free, reproducible, refreshable and handles empty catalogues', () => {
  const counts = Array.from({ length: 300 }, (_, i) => i % 50);
  const first = discoveryOrder(counts, 42);
  assert.equal(new Set(first).size, counts.length);
  assert.deepEqual([...first].sort((a, b) => a - b), counts.map((_, i) => i));
  assert.deepEqual(first, discoveryOrder(counts, 42));
  assert.notDeepEqual(first, discoveryOrder(counts, 43));
  assert.deepEqual([...discoveryOrder([], 42)], []);
  assert.deepEqual([...discoveryOrder([0], 42)], [0]);
});
