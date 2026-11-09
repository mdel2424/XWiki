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
  for (const item of ['index.html', 'site.webmanifest', 'style.css', 'src', 'images']) await cp(item, path.join(website, item), { recursive: true });
  await exec(process.env.PYTHON || 'python3', ['-c', `
import sys,time
from pipeline.store import *
from pipeline.static_export import export_static
db=connect(sys.argv[1]);now=int(time.time())
with db:
 for i in range(30):
  topic=['Programming languages','Physics','Mathematics'][i%3]
  model=['STEM.Computing','STEM.Physics','STEM.Mathematics'][i%3]
  title=['Programming language ','Quantum field ','Algebra '][i%3]+str(i)
  url='https://en.wikipedia.org/wiki/'+title.replace(' ','_')
  ingest(db,[{'id':i*2+1,'type':'story','title':title,'by':'fixture-user'+str(i),'time':now-1000,'url':url}])
  a=wiki_url(url)
  merge_metadata(db,a['id'],{**a,'extract':(topic+' is an interesting field of scientific discovery. ')*14,'description':topic,**({'firstParagraph':'Short first paragraph.'} if i==0 else {}),'categories':[topic],'topicPredictions':{model:0.9},'wikipediaPopularity':(i+1)*0.000001,'thumbnail':'https://upload.wikimedia.org/wikihack-fixture.svg'})
 for j,(topic,model) in enumerate([
  ('Ethics','Culture.Philosophy_and_religion'),('Archaeology','History_and_Society.History'),
  ('Genetics','STEM.Biology'),('Cognitive psychology','History_and_Society.Society'),
  ('Macroeconomics','History_and_Society.Business_and_economics'),('Electronic engineering','STEM.Engineering'),
  ('Visual art','Culture.Visual_arts.Visual_arts*'),('Coastland','Geography.Geographical'),
  ('Courts','History_and_Society.Politics_and_government'),('Memes','Culture.Internet_culture'),
  ('Inventors','Culture.Biography.Biography*'),('Railways','History_and_Society.Transportation'),
  ('Novels','Culture.Literature'),('Cinema','Culture.Media.Films'),('Nebulae','STEM.Space'),
  ('Climate','STEM.Earth_and_environment'),('Cuisine','Culture.Food_and_drink'),('Running','Culture.Sports')]):
  for k in range(3):
   title=topic+' '+str(k);url='https://en.wikipedia.org/wiki/'+title.replace(' ','_')
   ingest(db,[{'id':1000+j*3+k,'type':'story','title':title,'by':'new-topic-user','time':now-1000,'url':url}])
   a=wiki_url(url)
   merge_metadata(db,a['id'],{**a,'description':topic,'extract':(topic+' is a field of study. ')*14,'categories':[topic],'topicPredictions':{model:0.9},'wikipediaPopularity':(31+j*3+k)*0.000001,'thumbnail':'https://upload.wikimedia.org/wikihack-fixture.svg'})
 resolve_threads(db);refresh_stats(db)
export_static(db,sys.argv[2]+'/data/catalog')
db.close()
`, database, website]);
  const fixtureManifest = JSON.parse(await readFile(path.join(website, 'data/catalog/manifest.json'), 'utf8'));
  const fixtureRoot = path.join(website, 'data/catalog', fixtureManifest.generation);
  const fixtureCards = JSON.parse(await readFile(path.join(fixtureRoot, 'articles/0.json'), 'utf8'));
  const fixtureTopics = JSON.parse(await readFile(path.join(fixtureRoot, fixtureManifest.topicIndex.path), 'utf8')).topics;
  const fixtureWikipedia = JSON.parse(await readFile(path.join(fixtureRoot, fixtureManifest.wikipediaIndex.path), 'utf8'));
  const fixtureRising = JSON.parse(await readFile(path.join(fixtureRoot, 'rising/0.json'), 'utf8'));
  browser = await ({ firefox, chromium, webkit })[engine].launch({ headless: true });
  // Firefox uses a narrow desktop viewport for native mouse pointer events.
  // Chromium also exercises native touch input through its DevTools protocol.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: engine !== 'firefox' });
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
      if (url.searchParams.get('prop') === 'pageviews') {
        assert.equal(url.searchParams.get('pvipdays'), '30');
        await route.fulfill({ json: { query: { pages: url.searchParams.get('titles').split('|').map(title => ({
          title, pageviews: Object.fromEntries(Array.from({ length: 30 }, (_, day) => [day, 100])),
        })) } } });
        return;
      }
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
          assert.match(await startup.locator('.source-note').textContent(), /Loading/);
          assert.equal(await startup.locator('.end-note').count(), 0);
          assert.equal(await startup.locator('.loader:visible').count(), 1, 'Initial load shows only one spinner');
          assert.equal(await startup.locator('#load-area').textContent(), '', 'No duplicate footer loading control');
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
          assert.match(await startup.locator('.source-note').textContent(), /84 articles/);
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
  assert.equal(await page.getByRole('tab', { name: 'Home', exact: true }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Home', 'Computing', 'Physics & Chemistry', 'History']);
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
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  assert.equal(await page.getByRole('tab').count(), 0, 'Search has no ranking tabs');
  assert.equal(await page.locator('.sort-button').count(), 0, 'Sorting belongs on Home');
  assert.equal(await page.locator('.article-card').count(), 0, 'Empty Search does not display an unrelated feed');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Home', exact: true }).getAttribute('aria-selected'), 'true');
  await page.evaluate(() => scrollTo(0, 0));
  const refreshed = page.waitForResponse(r => r.url().endsWith('/data/catalog/manifest.json'));
  const pullLoading = await page.evaluate(() => {
    const target = document.querySelector('#timeline');
    const dispatch = (type, y) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: y == null ? [] : [{ target, clientX: 180, clientY: y }] });
      target.dispatchEvent(event);
    };
    dispatch('touchstart', 150); dispatch('touchmove', 320); dispatch('touchend', null);
    return { spinners: document.querySelectorAll('.loader').length,
      busy: document.querySelector('#timeline').getAttribute('aria-busy') };
  });
  assert.deepEqual(pullLoading, { spinners: 1, busy: 'true' }, 'Pull-to-refresh owns the single loading indicator');
  await refreshed;
  await page.waitForFunction(() => document.querySelector('#pull-refresh').dataset.state === 'idle');
  assert.equal(await page.locator(`.article-card[data-id="${seenId}"]`).count(), 0);
  await page.getByRole('button', { name: 'View Hacker News mentions' }).first().click();
  await page.locator('.mention').first().waitFor();
  assert.ok(await page.locator('dialog a[href*="news.ycombinator.com/item?id="]').count() >= 2);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').evaluate(d => d.open), false);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const searchLoaded = page.waitForResponse(response => /\/search\/\d+\.json$/.test(response.url()));
  await page.getByRole('searchbox', { name: 'Search articles' }).fill('Programming');
  await searchLoaded;
  await page.waitForFunction(() => document.querySelector('#timeline').getAttribute('aria-busy') === 'false');
  await page.locator('.article-card').first().waitFor();
  for (const title of await page.locator('.article-title h2').allTextContents()) assert.ok(title.includes('Programming'));
  if (![seenId, dismissId].includes('en:Programming language 0')) {
  const shortPost = page.locator('.article-card').filter({ has: page.getByRole('heading', { name: 'Programming language 0', exact: true }) });
  assert.equal(await shortPost.locator('.article-extract').textContent(), 'Short first paragraph.');
  assert.equal(await shortPost.locator('.read-more').count(), 0, 'Short paragraphs have no expansion control');
  }
  await page.getByRole('searchbox', { name: 'Search articles' }).fill('');
  assert.equal(await page.locator('.article-card').count(), 0, 'Clearing search restores the search prompt');
  assert.equal(await page.getByRole('tab').count(), 0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Home', exact: true }).getAttribute('aria-selected'), 'true');
  const mathRequested = Promise.withResolvers(), releaseMath = Promise.withResolvers();
  await page.getByRole('button', { name: 'Browse topics', exact: true }).click();
  await page.getByRole('button', { name: 'Pin Mathematics', exact: true }).click();
  await page.keyboard.press('Escape');
  const mathShard = '**/topics-*.json';
  await page.route(mathShard, async route => { mathRequested.resolve(); await releaseMath.promise; await route.fallback(); });
  await page.getByRole('tab', { name: 'Mathematics', exact: true }).click();
  await mathRequested.promise;
  assert.equal(await page.locator('.article-card').count(), 0, 'A new topic never flashes unrelated posts');
  assert.equal(await page.locator('.loader:visible').count(), 1, 'Topic loading shows only one spinner');
  await page.getByRole('tab', { name: 'Physics & Chemistry', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Physics & Chemistry', exact: true }).getAttribute('aria-selected'), 'true');
  const mathResponse = page.waitForResponse(response => /topics-[^/]+\.json$/.test(response.url()));
  releaseMath.resolve(); await mathResponse;
  await page.waitForFunction(() => document.querySelector('#timeline').getAttribute('aria-busy') === 'false');
  assert.ok((await page.locator('.article-title h2').allTextContents()).every(title => title.startsWith('Quantum field ')));
  await page.unroute(mathShard);
  for (const [tab, prefix] of [['Mathematics', 'Algebra '], ['Computing', 'Programming language '], ['Physics & Chemistry', 'Quantum field ']]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#timeline').getAttribute('aria-busy') === 'false');
    const titles = await page.locator('.article-title h2').allTextContents();
    assert.ok(titles.length > 0, `${tab} finds articles from the full archive`);
    assert.ok(titles.every(title => title.startsWith(prefix)), `${tab} contains only its subject`);
    assert.equal(await page.locator(`.article-card[data-id="${seenId}"]`).count(), 0);
  }
  await page.getByRole('tab', { name: 'Mathematics', exact: true }).click();
  const topicPost = page.locator('.article-card').filter({ has: page.getByRole('button', { name: 'Like article', exact: true }) }).first();
  const topicId = await topicPost.getAttribute('data-id');
  await topicPost.getByRole('button', { name: 'Like article', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#timeline').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator(`[data-id="${topicId}"]`).getByRole('button', { name: 'Unlike article', exact: true }).count(), 1);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/math-mobile-feed.png' });
  const waitFeed = () => page.waitForFunction(() => document.querySelector('#timeline').getAttribute('aria-busy') === 'false');
  const chooseSort = async label => {
    await page.getByRole('button', { name: /^Sort posts:/ }).click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  };
  const expectedTitles = async (topic, sort) => {
    const hidden = await page.evaluate(() => {
      const profile = JSON.parse(localStorage.getItem('wikihack:profile-v1'));
      return [...Object.keys(profile.seen || {}), ...Object.keys(profile.rejected || {})];
    });
    const allowed = new Set(fixtureTopics[topic]);
    const indices = sort === 'wikipedia' ? fixtureWikipedia.order : sort === 'rising' ? fixtureRising : fixtureTopics[topic];
    return indices.filter(i => allowed.has(i) && !hidden.includes(fixtureCards[i].id)).slice(0, 12).map(i => fixtureCards[i].title);
  };
  assert.equal(await page.getByRole('button', { name: 'Sort posts: For You (HN)', exact: true }).count(), 1);
  assert.equal(await page.locator('.source-note').count(), 1);
  assert.equal(await page.locator('.feed-sort .source-note').count(), 1, 'Article count and sorting share one toolbar');
  assert.equal(await page.locator('#page-content > .source-note').count(), 0, 'No second count header');
  await page.locator('#sort-button').click();
  assert.deepEqual(await page.getByRole('menuitemradio').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['For You (HN)', 'Top (HN)', 'Rising (HN)', 'Top (Wikipedia)']);
  await page.keyboard.press('Escape');
  const sortButtonBox = await page.locator('#sort-button').boundingBox();
  const topicTabsBox = await page.locator('.home-tabs-host').boundingBox();
  assert.ok(sortButtonBox.y >= topicTabsBox.y + topicTabsBox.height, 'Sort control sits beneath the topic tabs');
  const wikipediaRequested = Promise.withResolvers(), releaseWikipedia = Promise.withResolvers();
  await page.route('**/wikipedia-*.json', async route => { wikipediaRequested.resolve(); await releaseWikipedia.promise; await route.fallback(); });
  await chooseSort('Top (Wikipedia)');
  await wikipediaRequested.promise;
  assert.equal(await page.locator('.article-card').count(), 0, 'Changing sort clears the previous sort while loading');
  assert.equal(await page.locator('.loader:visible').count(), 1);
  await chooseSort('Top (HN)');
  await waitFeed();
  assert.deepEqual(await page.locator('.article-title h2').allTextContents(), await expectedTitles('math', 'top'));
  const wikipediaResponse = page.waitForResponse(response => /wikipedia-[^/]+\.json$/.test(response.url()));
  releaseWikipedia.resolve(); await wikipediaResponse;
  await waitFeed();
  assert.equal(await page.getByRole('button', { name: 'Sort posts: Top (HN)', exact: true }).count(), 1, 'Late Wikipedia response cannot change the active sort');
  assert.deepEqual(await page.locator('.article-title h2').allTextContents(), await expectedTitles('math', 'top'));
  await page.unroute('**/wikipedia-*.json');
  for (const [label, sort] of [['Top (Wikipedia)', 'wikipedia'], ['Top (HN)', 'top'], ['Rising (HN)', 'rising']]) {
    await chooseSort(label); await waitFeed();
    assert.deepEqual(await page.locator('.article-title h2').allTextContents(), await expectedTitles('math', sort), `${label} orders only Mathematics`);
    const activeTopic = await page.getByRole('tab', { name: 'Mathematics', exact: true }).boundingBox();
    assert.ok(activeTopic.x >= -1 && activeTopic.x + activeTopic.width <= 391, 'Sorting keeps the selected topic visible');
  }
  await chooseSort('Top (Wikipedia)'); await waitFeed();
  await page.getByRole('tab', { name: 'Computing', exact: true }).click(); await waitFeed();
  assert.equal(await page.getByRole('button', { name: 'Sort posts: Top (Wikipedia)', exact: true }).count(), 1);
  assert.deepEqual(await page.locator('.article-title h2').allTextContents(), await expectedTitles('computing', 'wikipedia'), 'The selected sort follows topic changes');
  const wikiOrderBeforeLike = await page.locator('.article-title h2').allTextContents();
  const wikiLike = page.getByRole('button', { name: 'Like article', exact: true }).first();
  await wikiLike.click();
  assert.deepEqual(await page.locator('.article-title h2').allTextContents(), wikiOrderBeforeLike, 'Likes do not reorder Wikipedia rankings');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  assert.equal(await page.getByRole('tab').count(), 0);
  assert.equal(await page.locator('.sort-button').count(), 0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Sort posts: Top (Wikipedia)', exact: true }).count(), 1, 'Navigation preserves the Home sort');
  await page.locator('#sort-button').press('ArrowDown');
  assert.equal(await page.getByRole('menuitemradio', { name: 'Top (Wikipedia)', exact: true }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await waitFeed();
  assert.equal(await page.getByRole('button', { name: 'Sort posts: Rising (HN)', exact: true }).count(), 1);
  await page.locator('#sort-button').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sort-button').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#sort-button').evaluate(button => button === document.activeElement), true);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#sort-button').click();
    assert.equal(await page.getByRole('menuitemradio').count(), 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Sort menu fits ${width}px`);
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#sort-button').click();
  await page.screenshot({ path: 'test-results/feed-sorting.png' });
  await page.keyboard.press('Escape');
  await chooseSort('For You (HN)'); await waitFeed();
  await page.getByRole('tab', { name: 'Mathematics', exact: true }).click(); await waitFeed();

  await page.getByRole('button', { name: 'Search', exact: true }).click();
  assert.equal(await page.getByRole('tab').count(), 0, 'Search stays search-only after a topic visit');
  await page.screenshot({ path: 'test-results/search.png' });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Mathematics', exact: true }).getAttribute('aria-selected'), 'true');
  await page.locator(`[data-id="${topicId}"]`).getByRole('button', { name: 'Mark as seen', exact: true }).click();
  await page.getByRole('tab', { name: 'Home', exact: true }).click();
  assert.equal(await page.locator(`[data-id="${topicId}"]`).count(), 0, 'Topic feedback applies to the main For you feed');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/dark-mobile-feed.png' });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}px`);
    assert.ok((await page.locator('.phone-shell').boundingBox()).width <= 600);
    await checkActionAlignment();
    await page.getByRole('tab', { name: 'Physics & Chemistry', exact: true }).press('End');
    assert.equal(await page.getByRole('tab', { name: 'Mathematics', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('tab', { name: 'Mathematics', exact: true }).press('Home');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Browse topics', exact: true }).click();
  assert.equal(await page.locator('.topic-open').count(), 21);
  const topicLabels = await page.locator('.topic-copy strong').evaluateAll(elements => elements.map(element => element.firstChild.textContent));
  assert.deepEqual(topicLabels, [...topicLabels].sort((a, b) => a.localeCompare(b, 'en')));
  assert.ok(await page.locator('.topic-count').count() === 21, 'Topic counts come from the prediction index');
  await page.screenshot({ path: 'test-results/topics-picker.png' });
  const newTopics = [['Philosophy & Religion', 'Ethics '], ['History', 'Archaeology '], ['Biology & Medicine', 'Genetics '],
    ['Society & Education', 'Cognitive psychology '], ['Business & Economics', 'Macroeconomics '],
    ['Engineering & Tech', 'Electronic engineering '], ['Art, Music & Design', 'Visual art '], ['Places', 'Coastland '], ['Politics & Law', 'Courts '],
    ['Internet Culture', 'Memes '], ['People', 'Inventors '], ['Transportation', 'Railways '],
    ['Language & Literature', 'Novels '], ['Film, TV & Games', 'Cinema '], ['Space', 'Nebulae '],
    ['Earth & Environment', 'Climate '], ['Food & Drink', 'Cuisine '], ['Sports', 'Running ']];
  for (const [topic] of newTopics) {
    const pin = page.getByRole('button', { name: `Pin ${topic}`, exact: true });
    if (await pin.count()) await pin.click();
    assert.equal(await page.getByRole('button', { name: `Unpin ${topic}`, exact: true }).getAttribute('aria-pressed'), 'true');
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Browse topics' }).evaluate(el => el === document.activeElement), true);
  assert.equal(await page.getByRole('tab').count(), 22);
  for (const [topic, prefix] of newTopics) {
    await page.getByRole('tab', { name: topic, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#timeline').getAttribute('aria-busy') === 'false');
    const titles = await page.locator('.article-title h2').allTextContents();
    assert.ok(titles.length > 0 && titles.every(title => title.startsWith(prefix)), `${topic} only shows its subject`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.screenshot({ path: 'test-results/pinned-topics-feed.png' });
  await page.reload();
  await page.locator('.mention-label').first().waitFor();
  assert.equal(await page.getByRole('tab').count(), 22, 'Pins persist after reload');
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Browse topics' }).click();
  await page.getByRole('button', { name: 'Unpin History', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('tab', { name: 'History', exact: true }).count(), 0);
  assert.equal(await page.getByRole('tab', { name: 'Home', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Browse topics' }).click();
  await page.locator('[data-action="open-topic"][data-topic="history"]').click();
  await page.waitForFunction(() => document.querySelector('#timeline').getAttribute('aria-busy') === 'false');
  assert.equal(await page.getByRole('tab', { name: 'History', exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok((await page.locator('.article-title h2').allTextContents()).every(title => title.startsWith('Archaeology ')));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wikihack:pinned-topics-v1')).includes('history')), false);
  await page.getByRole('tab', { name: 'Home', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'History', exact: true }).count(), 0, 'Opening a topic does not pin it');
  await page.getByRole('button', { name: 'Browse topics' }).click();
  while (await page.locator('.topic-pin[aria-pressed="true"]').count()) await page.locator('.topic-pin[aria-pressed="true"]').first().click();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('.mention-label').first().waitFor();
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Home'], 'All topics can be unpinned without restoring defaults');
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('button', { name: 'Browse topics' }).click();
  await page.getByRole('button', { name: 'Pin Art, Music & Design', exact: true }).click();
  assert.equal(await page.evaluate(() => document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth), true, 'Topic picker fits a narrow phone');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Browse topics' }).click();
  for (const topic of ['Computing', 'Physics & Chemistry', 'History']) await page.getByRole('button', { name: `Pin ${topic}`, exact: true }).click();
  await page.locator('dialog').evaluate(dialog => { dialog.scrollTop = 0; });
  const pickerOrder = () => page.locator('.topic-row').evaluateAll(rows => rows.map(row => row.dataset.topicId));
  const originalOrder = await pickerOrder();
  const pinsBeforeDrag = await page.evaluate(() => localStorage.getItem('wikihack:pinned-topics-v1'));
  const historyHandle = page.getByRole('button', { name: 'Reorder Biology & Medicine', exact: true });
  await historyHandle.scrollIntoViewIfNeeded();
  const historyBox = await historyHandle.boundingBox();
  const artsBox = await page.locator('.topic-row[data-topic-id="arts"]').boundingBox();
  await page.mouse.move(historyBox.x + historyBox.width / 2, historyBox.y + historyBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(historyBox.x + historyBox.width / 2, artsBox.y + 4, { steps: 15 });
  await page.mouse.up();
  assert.deepEqual(await pickerOrder(), ['biology', ...originalOrder.filter(id => id !== 'biology')], 'Dragging moves only the chosen topic');
  assert.equal(await page.evaluate(() => localStorage.getItem('wikihack:pinned-topics-v1')), pinsBeforeDrag, 'Dragging preserves pins');
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Home', 'Art, Music & Design', 'Computing', 'History', 'Physics & Chemistry']);
  await page.reload();
  await page.locator('.article-card').first().waitFor();
  await page.getByRole('button', { name: 'Browse topics' }).click();
  assert.equal((await pickerOrder())[0], 'biology', 'Dragged order persists after reload');
  const physicsHandle = page.getByRole('button', { name: 'Reorder Physics & Chemistry', exact: true });
  await physicsHandle.focus();
  await physicsHandle.press('Space');
  await physicsHandle.press('Home');
  await physicsHandle.press('Enter');
  assert.equal((await pickerOrder())[0], 'science', 'Keyboard reordering works');
  const savedOrder = await pickerOrder();
  await physicsHandle.press('Space');
  await physicsHandle.press('ArrowDown');
  await physicsHandle.press('Escape');
  assert.deepEqual(await pickerOrder(), savedOrder, 'Escape restores the original order');
  assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), true, 'Canceling a reorder keeps the picker open');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wikihack:topic-order-v1'))), savedOrder);
  if (engine === 'chromium') {
    const client = await context.newCDPSession(page);
    const touch = (type, x = 0, y = 0) => client.send('Input.dispatchTouchEvent', {
      type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y, id: 0 }],
    });
    await page.locator('dialog').evaluate(dialog => { dialog.scrollTop = 0; });
    const csHandle = page.getByRole('button', { name: 'Reorder Computing', exact: true });
    const csBox = await csHandle.boundingBox();
    const firstBox = await page.locator('.topic-row').first().boundingBox();
    await touch('touchStart', csBox.x + csBox.width / 2, csBox.y + csBox.height / 2);
    await touch('touchMove', csBox.x + csBox.width / 2, firstBox.y + 8);
    await touch('touchEnd');
    assert.equal((await pickerOrder())[0], 'computing', 'A native touch drag reorders topics');
    const topBox = await csHandle.boundingBox();
    const dialogBox = await page.locator('dialog').boundingBox();
    await touch('touchStart', topBox.x + topBox.width / 2, topBox.y + topBox.height / 2);
    await touch('touchMove', topBox.x + topBox.width / 2, dialogBox.y + dialogBox.height - 6);
    await page.waitForFunction(() => document.querySelector('.topic-row:last-child').dataset.topicId === 'computing' && document.querySelector('dialog').scrollTop > 0);
    await touch('touchEnd');
    const touchOrder = await pickerOrder();
    const lastBox = await csHandle.boundingBox();
    await touch('touchStart', lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2);
    await touch('touchMove', lastBox.x + lastBox.width / 2, lastBox.y - 80);
    await touch('touchCancel');
    assert.deepEqual(await pickerOrder(), touchOrder, 'An interrupted touch gesture restores the order');
    const beforeScroll = await page.locator('dialog').evaluate(dialog => dialog.scrollTop);
    await touch('touchStart', 130, 300);
    for (let y = 340; y <= 640; y += 40) await touch('touchMove', 130, y);
    await touch('touchEnd');
    await page.waitForFunction(before => document.querySelector('dialog').scrollTop < before, beforeScroll);
    assert.deepEqual(await pickerOrder(), touchOrder, 'Swiping the row text scrolls without reordering');
    await client.detach();
  }
  const beforeFailedSave = await pickerOrder();
  await page.evaluate(() => {
    window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'wikihack:topic-order-v1') throw new DOMException('Full', 'QuotaExceededError');
      return window.originalSetItem.call(this, key, value);
    };
  });
  const firstHandle = page.locator('.topic-reorder').first();
  await firstHandle.focus(); await firstHandle.press('Space'); await firstHandle.press('End'); await firstHandle.press('Enter');
  assert.deepEqual(await pickerOrder(), beforeFailedSave, 'A failed save restores the displayed order');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wikihack:topic-order-v1'))), beforeFailedSave);
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; delete window.originalSetItem; });
  await page.screenshot({ path: 'test-results/topics-reorder.png' });
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    localStorage.setItem('wikihack:pinned-topics-v1', JSON.stringify(['physics', 'history', 'computer-science', 'arts-culture', 'psychology']));
    localStorage.setItem('wikihack:topic-order-v1', JSON.stringify(['physics', 'history', 'computer-science', 'arts-culture', 'psychology']));
  });
  await page.reload();
  await page.locator('.article-card').first().waitFor();
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Home', 'Physics & Chemistry', 'History', 'Computing', 'Art, Music & Design', 'Society & Education'], 'Existing pins and custom order migrate to the new groups');
  await page.getByRole('button', { name: 'Browse topics' }).click();
  assert.deepEqual((await pickerOrder()).slice(0, 5), ['science', 'history', 'computing', 'arts', 'society']);
  assert.equal((await pickerOrder()).length, 21, 'New groups are appended to a saved order');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  assert.ok(requests.some(url => url.includes('/search/')));
  assert.ok(requests.some(url => url.includes('/context/')));
  assert.ok(!requests.some(url => url.includes('/api/')));
  console.log(`PASS (${engine}): topic sorting, search-only navigation, delayed topic/sort responses, shared feedback, dark For you, reading, actions, pull-to-refresh, archive context/search and responsive layout.`);
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
