// Firefox UI against an exported static catalogue under a GitHub Pages subpath. No API exists.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { createPreviewServer } from '../scripts/serve.mjs';

const exec = promisify(execFile);
const temporary = await mkdtemp(path.join(tmpdir(), 'wikihack-ui-'));
const database = path.join(temporary, 'fixture.sqlite');
const website = path.join(temporary, 'site');
const server = createPreviewServer({ directory: website, basePath: '/WikiHack-mobile' });
let browser;
const engine = process.env.BROWSER || 'firefox';
if (!['firefox', 'chromium', 'webkit'].includes(engine)) throw new Error('BROWSER must be firefox, chromium, or webkit.');
try {
  await mkdir(website);
  for (const item of ['index.html', 'style.css', 'src', 'images']) await cp(item, path.join(website, item), { recursive: true });
  await exec(process.env.PYTHON || 'python3', ['-c', `
import sys,time
from pipeline.store import *
from pipeline.static_export import export_static
db=connect(sys.argv[1]);now=int(time.time())
with db:
 for i in range(30):
  topic='Astronomy' if i%2 else 'Programming languages'
  title=('Planet ' if i%2 else 'Programming language ')+str(i)
  url='https://en.wikipedia.org/wiki/'+title.replace(' ','_')
  ingest(db,[{'id':i*2+1,'type':'story','title':title,'by':'fixture-user'+str(i),'time':now-1000,'url':url}])
  a=wiki_url(url)
  merge_metadata(db,a['id'],{**a,'extract':(topic+' is an interesting field of scientific discovery. ')*14,'description':topic,'categories':[topic],'thumbnail':'https://upload.wikimedia.org/wikihack-fixture.svg'})
 resolve_threads(db);refresh_stats(db)
export_static(db,sys.argv[2]+'/data/catalog')
db.close()
`, database, website]);
  browser = await ({ firefox, chromium, webkit })[engine].launch({ headless: true });
  // Firefox does not support Playwright's isMobile option; use a touch viewport
  // with the actual engine's user agent rather than impersonating Chrome.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  const requests = [];
  context.on('page', page => page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); }));
  await context.route('https://wikihack.test/**', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    assert.ok(url.pathname.startsWith('/WikiHack-mobile/'));
    assert.ok(!url.pathname.includes('/api/'));
    const result = await new Promise(resolve => {
      let status, headers;
      server.emit('request', { url: url.pathname + url.search, method: 'GET' }, {
        writeHead(code, values = {}) { status = code; headers = values; },
        end(body) { resolve({ status, headers, body }); },
      });
    });
    await route.fulfill(result);
  });
  await context.route('https://upload.wikimedia.org/**', route => readFile('images/orbit.svg').then(body => route.fulfill({ body, contentType: 'image/svg+xml' })));
  const page = await context.newPage();
  await page.goto('https://wikihack.test/WikiHack-mobile/');
  await page.locator('.mention-label').first().waitFor();
  assert.equal(await page.getByRole('tab', { name: 'For you', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
  const first = page.locator('.article-card').first();
  const firstId = await first.getAttribute('data-id');
  const settings = page.locator('.topbar').getByRole('button', { name: 'Settings', exact: true });
  assert.equal(await settings.locator('svg').count(), 1);
  assert.equal(await settings.textContent(), '');
  const actions = await first.locator('.post-actions > button').evaluateAll(buttons => buttons.map(b => {
    const rect = b.getBoundingClientRect(); return { left: rect.left, right: rect.right };
  }));
  assert.ok(actions[2].right - actions[0].left < 200, 'Post actions form a compact group');
  assert.ok(actions[1].left - actions[0].right <= 10);
  await settings.click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Random', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Refresh feed', exact: true }).count(), 0);
  assert.equal(await first.locator('.post-actions > button').count(), 3);
  assert.equal(await first.locator('.post-date').count(), 0);
  assert.deepEqual(await first.locator('.post-actions > button').evaluateAll(buttons => buttons.map(b => b.dataset.action)), ['context', 'like', 'seen']);
  assert.ok((await first.locator('.article-extract').textContent()).length <= 281);
  assert.ok((await first.locator('.article-extract').textContent()).endsWith('…'));
  const readLink = first.getByRole('link', { name: 'Read on Wikipedia', exact: true });
  assert.match(await readLink.getAttribute('href'), /^https:\/\/en\.wikipedia\.org\/wiki\//);
  assert.equal(await readLink.getAttribute('target'), '_blank');
  assert.equal(await page.locator('a[href^="intent:"],a[href^="wikihack:"]').count(), 0);
  assert.equal(await first.evaluate(el => Boolean(el.querySelector('.wiki-readmore').compareDocumentPosition(el.querySelector('.article-media')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  await first.getByRole('button', { name: 'Like article', exact: true }).click();
  await page.locator(`[data-id="${firstId}"]`).getByRole('button', { name: 'Unlike article', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Likes', exact: true }).click();
  assert.equal(await page.locator('.article-card').count(), 1);
  await page.reload();
  await page.locator('.mention-label').first().waitFor();
  await page.getByRole('button', { name: 'Likes', exact: true }).click();
  assert.equal(await page.locator('.article-card').count(), 1, 'Hearts persist after reload');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const dismiss = page.locator('.article-card').nth(1);
  const dismissId = await dismiss.getAttribute('data-id');
  await dismiss.getByRole('button', { name: 'More options' }).click();
  await dismiss.getByRole('menuitem', { name: 'Not interested in this post' }).click();
  assert.equal(await page.locator(`.article-card[data-id="${dismissId}"]`).count(), 0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.locator(`.article-card[data-id="${dismissId}"]`).count(), 1);
  const seen = page.locator('.article-card').nth(1);
  const seenId = await seen.getAttribute('data-id');
  await seen.getByRole('button', { name: 'Mark as seen', exact: true }).click();
  assert.equal(await page.locator(`.article-card[data-id="${seenId}"]`).count(), 0);
  await page.reload();
  await page.locator('.mention-label').first().waitFor();
  assert.equal(await page.locator(`.article-card[data-id="${seenId}"]`).count(), 0);
  // Rising data is also fetched for FYP, so tab switching can use the cache.
  // FeedSession tests separately hold delayed responses to verify race handling.
  await page.getByRole('tab', { name: 'Rising', exact: true }).click();
  await page.getByRole('tab', { name: 'Top', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#timeline').getAttribute('aria-busy') === 'false');
  assert.equal(await page.getByRole('tab', { name: 'Top', exact: true }).getAttribute('aria-selected'), 'true');
  for (const tab of ['Rising', 'Top', 'For you']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#timeline').getAttribute('aria-busy') === 'false');
    assert.equal(await page.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator(`.article-card[data-id="${seenId}"]`).count(), 0);
  }
  await page.evaluate(() => scrollTo(0, 0));
  const refreshed = page.waitForResponse(r => r.url().endsWith('/data/catalog/manifest.json'));
  await page.evaluate(() => {
    const target = document.querySelector('#timeline');
    const dispatch = (type, y) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: y == null ? [] : [{ target, clientX: 180, clientY: y }] });
      target.dispatchEvent(event);
    };
    dispatch('touchstart', 150); dispatch('touchmove', 320); dispatch('touchend', null);
  });
  await refreshed;
  await page.waitForFunction(() => document.querySelector('#pull-refresh').dataset.state === 'idle');
  assert.equal(await page.locator(`.article-card[data-id="${seenId}"]`).count(), 0);
  await page.getByRole('button', { name: 'View Hacker News mentions' }).first().click();
  await page.locator('.mention').first().waitFor();
  assert.ok(await page.locator('dialog a[href*="news.ycombinator.com/item?id="]').count() >= 2);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').evaluate(d => d.open), false);
  await page.getByRole('button', { name: 'Explore', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search articles' }).fill('Programming');
  await page.locator('.article-card').first().waitFor();
  for (const title of await page.locator('.article-title h2').allTextContents()) assert.ok(title.includes('Programming'));
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('tab', { name: 'Top', exact: true }).click();
  await page.getByRole('tab', { name: 'Top', exact: true }).press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: 'For you', exact: true }).getAttribute('aria-selected'), 'true');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/dark-mobile-feed.png' });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}px`);
    assert.ok((await page.locator('.phone-shell').boundingBox()).width <= 600);
  }
  assert.deepEqual(errors, []);
  assert.ok(requests.some(url => url.includes('/search/')));
  assert.ok(requests.some(url => url.includes('/context/')));
  assert.ok(!requests.some(url => url.includes('/api/')));
  console.log(`PASS (${engine}): dark For you, truncation, image placement, HTTPS reading links, hearts, persistent feedback, dropdown dismissal/Undo, seen state, pull-to-refresh, tab isolation, static archive context/search at a project subpath, responsive layout.`);
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
