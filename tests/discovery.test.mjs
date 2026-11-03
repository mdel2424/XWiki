import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryWeight, discoveryOrder } from '../src/discovery.js';

test('discovery heavily suppresses under-five posts and favors broadly linked articles with a cap', () => {
  assert.ok(discoveryWeight(0) > 0);
  for (const count of [0, 1, 2, 3, 4]) assert.ok(discoveryWeight(count) <= discoveryWeight(5) * .04);
  const weights = [5, 10, 20, 50, 100].map(discoveryWeight);
  assert.ok(weights.every((weight, i) => !i || weight > weights[i - 1]));
  assert.ok(discoveryWeight(20) / discoveryWeight(5) > 2);
  assert.ok(discoveryWeight(100) / discoveryWeight(5) > 6);
  assert.equal(discoveryWeight(1000000), discoveryWeight(100));
  assert.equal(discoveryWeight(-10), discoveryWeight(0));
  assert.equal(discoveryWeight(NaN), discoveryWeight(0));
});

test('weighted draws favor higher-linked articles among eligible peers', () => {
  let popularFirst = 0;
  const trials = 6000;
  for (let seed = 0; seed < trials; seed++) popularFirst += discoveryOrder([5, 20], seed)[0] === 1;
  const expected = discoveryWeight(20) / (discoveryWeight(5) + discoveryWeight(20));
  assert.ok(Math.abs(popularFirst / trials - expected) < .025);
  assert.ok(popularFirst / trials > .67 && popularFirst / trials < .76);
});

test('single-link discoveries remain possible but rare against five-link posts', () => {
  let singleFirst = 0;
  for (let seed = 0; seed < 6000; seed++) singleFirst += discoveryOrder([1, 5], seed)[0] === 0;
  assert.ok(singleFirst > 0 && singleFirst < 180);
});

test('an archive dominated by low-link articles still yields an average above ten with few under-five draws', () => {
  // A skew resembling the real archive: 85% have fewer than five linkers.
  const counts = [[8500, 1], [850, 7], [400, 14], [180, 30], [70, 75]].flatMap(([size, count]) => Array(size).fill(count));
  let total = 0, low = 0, draws = 0;
  for (let seed = 0; seed < 30; seed++) {
    for (const index of discoveryOrder(counts, seed).slice(0, 96)) {
      total += counts[index]; low += counts[index] < 5; draws++;
    }
  }
  assert.ok(total / draws > 10);
  assert.ok(low / draws < .1);
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
