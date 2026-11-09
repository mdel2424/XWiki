import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleImageCandidate, fetchArticleImage } from '../src/article-images.js';
import { mergeArticles } from '../src/core.js';

const source = '//thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Z_diagram.svg/320px-Z_diagram.svg.png';

test('body image candidates accept article illustrations and skip icons, notices and untrusted URLs', () => {
  const attrs = { src: source, width: '320', height: '220' };
  assert.equal(articleImageCandidate(attrs).file, 'Z_diagram.svg');
  assert.match(articleImageCandidate(attrs).source, /^https:\/\/thumb.wikimedia.org\//);
  assert.equal(articleImageCandidate(attrs, true), null);
  assert.equal(articleImageCandidate({ ...attrs, width: '20' }), null);
  assert.equal(articleImageCandidate({ ...attrs, src: source.replace('Z_diagram', 'Ambox_notice') }), null);
  assert.equal(articleImageCandidate({ ...attrs, src: 'https://evil.example/photo.jpg' }), null);
  assert.equal(articleImageCandidate({ ...attrs, src: 'javascript:alert(1)' }), null);
});

test('fallback resolves a proper thumbnail, caches it, and leaves lead images unchanged', async () => {
  const article = { id: 'en:FallbackTest', title: 'FallbackTest', lang: 'en', imageMetadataVersion: 1 };
  const thumbnail = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Z_diagram.svg/960px-Z_diagram.svg.png';
  let calls = 0;
  const request = async raw => {
    calls++;
    const p = new URL(raw).searchParams;
    if (p.get('action') === 'parse') return { parse: { text: '<article>Fixture</article>' } };
    assert.equal(p.get('titles'), 'File:Z_diagram.svg');
    assert.equal(p.get('iiurlwidth'), '960');
    return { query: { pages: [{ imageinfo: [{ thumburl: thumbnail }] }] } };
  };
  const parse = () => articleImageCandidate({ src: source, width: 320, height: 220 });
  const enriched = await fetchArticleImage(article, { request, parse });
  assert.equal(enriched.thumbnail, thumbnail);
  assert.equal(enriched.thumbnailSource, 'article');
  assert.equal(enriched.imageMetadataVersion, 2);
  await fetchArticleImage(article, { request, parse });
  assert.equal(calls, 2);
  const existing = { ...article, thumbnail };
  assert.equal(await fetchArticleImage(existing, { request, parse }), existing);
  assert.equal(calls, 2);
});

test('articles without usable images are cached, while temporary failures can be retried', async () => {
  const article = { id: 'en:NoBodyImage', title: 'NoBodyImage', lang: 'en', imageMetadataVersion: 1 };
  const result = await fetchArticleImage(article, { request: async () => ({ parse: { text: '' } }), parse: () => null });
  assert.equal(result.thumbnail, '');
  assert.equal(result.imageMetadataVersion, 2);
  const broken = { ...article, id: 'en:ImageFailure', title: 'ImageFailure' };
  await assert.rejects(fetchArticleImage(broken, { request: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal((await fetchArticleImage(broken, { request: async () => ({ parse: { text: '' } }), parse: () => null })).imageMetadataVersion, 2);
});

test('old static metadata cannot undo a completed body image check or its image source', () => {
  const article = { id: 'en:Cached', title: 'Cached', mentions: [], imageMetadataVersion: 2, thumbnail: 'https://upload.wikimedia.org/photo.png', thumbnailSource: 'article' };
  const merged = mergeArticles([article], [{ ...article, imageMetadataVersion: 1, thumbnail: '', thumbnailSource: undefined }]);
  assert.equal(merged[0].thumbnailSource, 'article');
  assert.equal(merged[0].thumbnail, article.thumbnail);
  assert.equal(merged[0].imageMetadataVersion, 2);
});
