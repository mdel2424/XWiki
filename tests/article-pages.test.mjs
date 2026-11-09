import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMainPage } from '../src/article-pages.js';
import { parseWikiUrl } from '../src/core.js';
import { HOME_FEEDS, FEED_SORTS } from '../src/topics.js';

test('main-page filtering covers languages, normalized URLs, and preserves genuine article names', () => {
  for (const [lang, title] of [['en', 'Main Page'], ['en', 'main_page'], ['ja', 'メインページ'], ['ru', 'Заглавная страница'], ['fr', 'Wikipédia:Accueil principal']]) {
    assert.equal(isMainPage({ lang, title }), true, `${lang}:${title}`);
    assert.equal(parseWikiUrl(`https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`), null);
  }
  for (const title of ['Wikipedia', 'Japanese Wikipedia', 'Main Page (film)', 'Main page design']) {
    assert.equal(isMainPage({ lang: 'en', title }), false);
    assert.ok(parseWikiUrl(`https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`));
  }
});

test('Home keeps its existing feed identifier and sort choices follow the requested order', () => {
  assert.deepEqual(HOME_FEEDS[0], { id: 'for-you', label: 'Home' });
  assert.deepEqual(FEED_SORTS.map(sort => sort.label), ['For You (HN)', 'Top (HN)', 'Rising (HN)', 'Top (Wikipedia)']);
});
