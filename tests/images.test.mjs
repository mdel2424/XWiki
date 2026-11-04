import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalImage, recoverImage, imageSource } from '../src/images.js';
test('failed Wikimedia PNG and GIF thumbnails retry the original, then stay hidden after a second failure', () => {
  for (const name of ['Example.png', 'Animation.gif', 'Diagram.svg']) {
    const source = `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}/900px-${name}.png`;
    const original = `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}`;
    assert.equal(originalImage(source), original);
    let removed = 0;
    const image = { src: source, dataset: {}, closest: () => ({ remove: () => removed++ }) };
    recoverImage(image);
    assert.equal(image.src, original);
    assert.equal(imageSource(source), original);
    assert.equal(removed, 0);
    recoverImage(image);
    assert.equal(removed, 1);
    assert.equal(imageSource(source), null);
  }
});
test('originals, foreign hosts and formats browsers cannot display have no fallback', () => {
  for (const source of ['bad', 'https://evil.example/wikipedia/commons/thumb/a/ab/X.png/900px-X.png',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.gif',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.tif/900px-X.tif.jpg']) assert.equal(originalImage(source), null);
});
