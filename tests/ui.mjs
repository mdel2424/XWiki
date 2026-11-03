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
  merge_metadata(db,a['id'],{**a,'extract':(topic+' is an interesting field of scientific discovery. ')*14,'description':topic,**({'firstParagraph':'Short first paragraph.'} if i==0 else {}),'categories':[topic],'thumbnail':'https://upload.wikimedia.org/wikihack-fixture.svg'})
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
  const paragraphRequests = [];
  const fullParagraph = title => `${title} begins with a complete first paragraph. ` + 'This sentence explains the topic in more detail for readers. '.repeat(10).trim();
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
  await context.route('https://en.wikipedia.org/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/w/api.php') {
      paragraphRequests.push(url.href);
      assert.equal(url.searchParams.get('exsentences'), null, 'Expansion fetches the whole paragraph');
      assert.equal(url.searchParams.get('explaintext'), null, 'HTML keeps paragraph boundaries');
      const title = url.searchParams.get('titles');
      await route.fulfill({ json: { query: { pages: [{ title, extract: `<p>${fullParagraph(title)}</p><p>SECOND PARAGRAPH STAYS ON WIKIPEDIA.</p>` }] } } });
    } else await route.fulfill({ contentType: 'text/html', body: '<title>Wikipedia article</title><p>Wikipedia</p>' });
  });
  // Hold each startup stage so preview/cached posts cannot hide a startup flash.
  for (const warm of [false, true]) {
    for (const failure of [null, 'manifest', 'feed']) {
      const startup = await context.newPage();
      const cachedArticle = { id: 'en:Cached topic', title: 'Cached topic', lang: 'en',
        extract: 'A previously cached post.', mentions: [], sample: true };
      await startup.addInitScript(({ warm, article }) => {
        localStorage.clear();
        if (warm) {
          localStorage.setItem('wikihack:feed', JSON.stringify({ articles: [article] }));
          localStorage.setItem('wikihack:profile-v1', JSON.stringify({ version: 1,
            likes: { [article.id]: article }, rejected: {}, seen: {} }));
        }
      }, { warm, article: cachedArticle });
      const manifest = Promise.withResolvers(), feed = Promise.withResolvers();
      const manifestRequested = Promise.withResolvers(), feedRequested = Promise.withResolvers();
      await startup.route('**/data/catalog/manifest.json', async route => {
        manifestRequested.resolve();
        await manifest.promise;
        if (failure === 'manifest') await route.abort();
        else await route.fallback();
      });
      await startup.route('**/data/catalog/*/articles/*.json', async route => {
        feedRequested.resolve();
        await feed.promise;
        if (failure === 'feed') await route.abort();
        else await route.fallback();
      });
      try {
        await startup.goto('https://wikihack.test/WikiHack-mobile/');
        await Promise.race([manifestRequested.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Startup manifest request timed out')), 10000))]);
        const checkLoading = async () => {
          await startup.locator('.feed-loading').waitFor();
          assert.equal(await startup.locator('#timeline').getAttribute('aria-busy'), 'true');
          assert.equal(await startup.locator('.article-card').count(), 0, 'No generic/cached posts during startup');
          assert.match(await startup.locator('.source-note').textContent(), /Loading your feed/);
          assert.equal(await startup.locator('.end-note').count(), 0);
        };
        await checkLoading();
        manifest.resolve();
        if (failure !== 'manifest') {
          await Promise.race([feedRequested.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Startup feed request timed out')), 10000))]);
          await checkLoading();
          feed.resolve();
        }
        await startup.waitForFunction(() => document.querySelector('#timeline')?.getAttribute('aria-busy') === 'false');
        await startup.locator('.article-card').first().waitFor();
        if (failure) {
          if (warm) assert.equal(await startup.locator('.article-title h2').first().textContent(), cachedArticle.title);
          else assert.ok(await startup.locator('.preview-tag').count() > 0, 'Offline preview remains available');
        } else {
          assert.equal(await startup.locator('.preview-tag').count(), 0);
          assert.equal(await startup.locator(`[data-id="${cachedArticle.id}"]`).count(), 0);
          assert.match(await startup.locator('.source-note').textContent(), /Personalized for you/);
        }
      } finally {
        manifest.resolve(); feed.resolve();
        await startup.evaluate(() => localStorage.clear());
        await startup.close();
      }
    }
  }
  paragraphRequests.length = 0;
  console.log(`PASS (${engine}): startup waits for the personalized feed on fresh and cached sessions; manifest/feed failures retain offline fallbacks.`);
  const page = await context.newPage();
  await page.goto('https://wikihack.test/WikiHack-mobile/');
  await page.locator('.mention-label').first().waitFor();
  await page.locator('.article-card .read-more').first().waitFor();
  assert.equal(await page.getByRole('tab', { name: 'For you', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
  const first = page.locator('.article-card').filter({ has: page.locator('.read-more') }).first();
  const firstId = await first.getAttribute('data-id');
  const settings = page.locator('.topbar').getByRole('button', { name: 'Settings', exact: true });
  assert.equal(await settings.locator('svg').count(), 1);
  assert.equal(await settings.textContent(), '');
  const actions = await first.locator('.post-actions > button').evaluateAll(buttons => buttons.map(b => {
    const rect = b.getBoundingClientRect(); return { left: rect.left, right: rect.right };
  }));
  assert.ok(actions[2].right - actions[0].left <= 280, 'Post actions form a balanced footer');
  assert.ok(Math.abs((actions[0].right - actions[0].left) - (actions[2].right - actions[2].left)) < .5, 'Equal action touch targets');
  assert.ok(actions[1].left - actions[0].right <= 10);
  const checkActionAlignment = async () => {
    const icons = await first.locator('.post-actions > button svg').evaluateAll(elements => elements.map(el => {
      const box = el.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }));
    assert.ok(Math.max(...icons.map(i => i.y)) - Math.min(...icons.map(i => i.y)) < .5, 'All three icons share a vertical center');
    assert.ok(Math.abs((icons[1].x - icons[0].x) - (icons[2].x - icons[1].x)) < .5, 'All three icons have equal horizontal spacing');
  };
  await checkActionAlignment();
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
  const readLink = first.locator('.article-title');
  const wikipediaUrl = await readLink.getAttribute('href');
  assert.match(wikipediaUrl, /^https:\/\/en\.wikipedia\.org\/wiki\//);
  assert.equal(await readLink.getAttribute('target'), '_blank');
  assert.equal(await first.getByRole('link', { name: 'Read on Wikipedia', exact: true }).count(), 0);
  assert.equal(await page.locator('a[href^="intent:"],a[href^="wikihack:"]').count(), 0);
  assert.equal(await first.evaluate(el => Boolean(el.querySelector('.read-more').compareDocumentPosition(el.querySelector('.article-media')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  const title = await first.locator('.article-title h2').textContent();
  const requestsBeforeExpand = paragraphRequests.length;
  const previewBeforeExpand = await first.locator('.article-extract').textContent();
  await first.getByRole('button', { name: 'Read more', exact: true }).click();
  const readLess = first.getByRole('button', { name: 'Read less', exact: true });
  assert.equal(paragraphRequests.length, requestsBeforeExpand, 'Expansion is synchronous and does not fetch or replace text');
  assert.ok(fullParagraph(title).startsWith(previewBeforeExpand.slice(0, -1)));
  assert.equal(await readLess.getAttribute('aria-expanded'), 'true');
  assert.equal(await first.locator('.article-extract').textContent(), fullParagraph(title));
  assert.ok((await first.locator('.article-extract').textContent()).length > 281);
  assert.ok(!(await first.locator('.article-extract').textContent()).includes('SECOND PARAGRAPH'));
  assert.equal(context.pages().length, 1, 'Read more expands without opening Wikipedia');
  assert.equal(await page.locator('dialog').evaluate(d => d.open), false);
  await readLess.click();
  assert.ok((await first.locator('.article-extract').textContent()).length <= 281);
  await first.getByRole('button', { name: 'Read more', exact: true }).click();
  assert.equal(paragraphRequests.length, requestsBeforeExpand, 'A cached paragraph does not refetch');
  for (const target of [first.locator('.post-avatar'), first.locator('.article-extract'), first.locator('.article-media')]) {
    const opened = page.waitForEvent('popup');
    await target.click();
    const wikipedia = await opened;
    await wikipedia.waitForURL(wikipediaUrl);
    assert.equal(wikipedia.url(), wikipediaUrl);
    await wikipedia.close();
  }
  const keyboardOpen = page.waitForEvent('popup');
  await readLink.focus(); await readLink.press('Enter');
  const keyboardWikipedia = await keyboardOpen;
  await keyboardWikipedia.waitForURL(wikipediaUrl); await keyboardWikipedia.close();
  await first.getByRole('button', { name: 'Like article', exact: true }).click();
  await page.locator(`[data-id="${firstId}"]`).getByRole('button', { name: 'Unlike article', exact: true }).waitFor();
  await checkActionAlignment();
  assert.equal(context.pages().length, 1, 'Like does not open Wikipedia');
  assert.equal(await first.locator('.article-extract').textContent(), fullParagraph(title), 'Expansion survives feedback renders');
  await page.getByRole('button', { name: 'Likes', exact: true }).click();
  assert.equal(await page.locator('.article-card').count(), 1);
  await page.reload();
  await page.locator('.mention-label').first().waitFor();
  await page.getByRole('button', { name: 'Likes', exact: true }).click();
  assert.equal(await page.locator('.article-card').count(), 1, 'Hearts persist after reload');
  await first.getByRole('button', { name: 'Read more', exact: true }).click();
  assert.equal(await first.locator('.article-extract').textContent(), fullParagraph(title), 'Cached paragraphs work after reload');
  assert.equal(paragraphRequests.filter(raw => new URL(raw).searchParams.get('titles') === title).length, 1);
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
  if (![seenId, dismissId].includes('en:Programming language 0')) {
  const shortPost = page.locator('.article-card').filter({ has: page.getByRole('heading', { name: 'Programming language 0', exact: true }) });
  assert.equal(await shortPost.locator('.article-extract').textContent(), 'Short first paragraph.');
  assert.equal(await shortPost.locator('.read-more').count(), 0, 'Short paragraphs have no expansion control');
  }
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
    await checkActionAlignment();
  }
  assert.deepEqual(errors, []);
  assert.ok(requests.some(url => url.includes('/search/')));
  assert.ok(requests.some(url => url.includes('/context/')));
  assert.ok(!requests.some(url => url.includes('/api/')));
  console.log(`PASS (${engine}): dark For you, paragraph expansion/collapse and caching, whole-post Wikipedia links, aligned actions, image placement, hearts, persistent feedback, dropdown dismissal/Undo, seen state, pull-to-refresh, tab isolation, static archive context/search at a project subpath, responsive layout.`);
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
