# WikiHack — fully static mobile web

A dark, X-style Wikipedia feed sourced from Hacker News. Firefox mobile is the primary target. **The published website is plain HTML, CSS, JavaScript and JSON. It has no application server, runtime Python, SQLite endpoint, or `/api` requests.**

## Local preview

```sh
npm start
# http://localhost:4173/
```

Node 22+ is needed only for this convenient static file server. Any ordinary static host can serve the finished site. `HOST=0.0.0.0 npm start` allows opening the computer's LAN IP from a phone on the same trusted Wi-Fi network.

## Build the complete site

With the imported archive in `.data/wikihack.sqlite`:

```sh
npm run build
npm run preview
```

`build` exports the catalogue and assembles **`dist/`**, including `.nojekyll`. To reuse an existing export without rebuilding data:

```sh
npm run build -- --reuse-data
```

The current full export contains **201,844 articles and 697,007 HN mentions**, about **613 MB** of published files. The build enforces a 950 MB budget. It contains every linked mention in the imported snapshot, not the 49-million-item source database or its parent graph. The exported `data/catalog/` is committed so a fresh checkout can deploy immediately. The local database and `dist/` are ignored by Git.

## Publish on GitHub Pages

The website lives at the **repository root**: `index.html`, `style.css`, `src/`, `images/` and `data/`. The committed catalogue is ready to serve; deployment does not require Python, a database or a release asset.

1. In the repository's **Settings → Pages → Build and deployment**, choose **GitHub Actions** as the source.
2. Commit these setup changes and push to **`main`**.
3. The **Publish GitHub Pages** workflow builds and deploys automatically. You can also run it from **Actions → Publish GitHub Pages → Run workflow**.

The expected project URL is **https://mdel2424.github.io/WikiHack-mobile/**. The workflow's deployment result supplies the actual URL. All browser paths are relative, including catalogue fetches, so the repository subpath and custom domains work.

The [Pages workflow](.github/workflows/pages.yml) copies only the root website files into `dist/`, adds `.nojekyll`, and uploads that directory to Pages. Pipeline tools, tests and local databases are excluded from the published artifact. `dist/` is build output; there is no separate `web/` source directory. No npm dependencies are required by the deployment build.

For subsequent data updates:

```sh
npm run data:tail
npm run data:enrich -- --limit 1000
npm run data:export
npm run build -- --reuse-data
# Commit the updated data/catalog/ files and push to main.
```

Source-only changes use the committed catalogue. Pull-to-refresh checks for an updated manifest and changes the random mix; it does not run the ingestion pipeline. `npm run package:catalog` remains an optional archive/backup command and is not part of deployment.

## How the static data works

`data/catalog/manifest.json` points to a versioned snapshot containing:

- Article-card shards, with global HN counts and Wikipedia metadata.
- A compact popularity-weight index for weighted discovery without fetching every article card.
- Separate Rising and recent-order pages. Top order is implicit in document ordinals.
- Prefix-search posting shards covering the entire exported catalogue.
- ID/redirect lookup shards.
- Small comment blocks. Per-article offsets retrieve the original HN comments a page at a time, rather than downloading whole discussions or the full comment archive.

The browser lazily fetches these files and caches a bounded number of shards. Search and candidate selection execute in JavaScript. Images and optional fresh summaries can load directly from Wikimedia; no WikiHack backend is required. Preview descriptions are explicitly labelled when no catalogue has been built.

## Feed and controls

**Home** has **For you** and your pinned topics in a horizontally scrollable tab bar. **Topics** opens a picker for **Math**, **Computer Science**, **Physics**, **Philosophy**, **History**, **Biology**, **Psychology**, **Economics**, **Engineering**, and **Arts & Culture**. Open a row to browse its feed or use the pin button to add/remove it from Home. Math, Computer Science and Physics start pinned. Pins are saved in this browser, in the order you pin them, and all topics can be unpinned. For you is always available. Opening an unpinned topic shows it temporarily in the tab bar without saving a pin; unpinning the selected topic returns to For you.

Topic lists use the same personalized discovery feed, restricted to articles whose titles, descriptions or Wikipedia categories identify that subject. Candidate search spans the full catalogue; incidental mentions in body text do not qualify an article. Each list owns its candidates and pagination cursor. Likes, Not interested and seen feedback apply across all lists.

**Search** contains article lookup and the **Top** and **Rising** pages. Top ranks the full archive by all-time distinct HN linkers, breaking ties by mention totals. Rising ranks activity within the last six calendar months, measured when the ranking is built; older and future-dated mentions do not contribute. Entering a query shows search results; choosing a ranking clears the query. Home and Search remember their selected tabs independently during a session.

**For you** repeats **8 random discoveries, 1 Rising post and 1 Top post** per ten posts. Random draws span the complete catalogue but strongly suppress articles linked by fewer than five distinct HN users. Their draw weight is only 2–4% of a five-linker article's weight. Above that threshold, weight grows as `(min(linkers, 100) / 5)^0.65`, favoring articles with 10+ linkers while capping the advantage of extremely popular posts. Rare low-link discoveries remain possible. The Top and Rising picks are shuffled from the leading 1,000 articles in each ranking, rather than served in popularity order. Refresh changes all three shuffled selections. Each lane keeps its own cursor, refills around overlaps and seen posts, and excludes duplicates across pages. If a lane runs out of eligible posts, remaining discoveries fill the feed.

Hearts boost related titles, summaries and Wikipedia categories within the discovery lane, including topic lists. Topic lists select their featured Top and Rising candidates within that subject. Not interested downranks similar discoveries. X marks only that post as seen, with Undo. Seen state and hearts persist locally; they are never public HN votes. Top and Rising in Search retain their published ranking order regardless of hearts.

The three post actions are comments, heart and X, grouped together beneath each post. The header cogwheel opens Settings. Dates, save/share buttons and the refresh button are removed. Pull down at the top to refresh, or press R on desktop. Each tab owns its cursor and stale requests cannot overwrite the current tab. Previews end near 280 characters. **Read more** expands inline to the complete first paragraph; **Read less** collapses it. Visible posts prefetch and cache their first paragraph before offering expansion. Preview and expanded text use that same paragraph, so tapping Read more never fetches replacement text. Short paragraphs show no Read more button. Cached text remains available offline. Clicking the post body, title or cover opens the article through a normal HTTPS Wikipedia link. Comments, hearts, dismissal and expansion act independently. The three action icons use equal spacing and fixed touch targets, including after liking a post.

## Offline data preparation

Python 3.10+ with SQLite FTS5 and DuckDB is required for data preparation only:

```sh
npm run data:setup
npm run data:sync     # Full, resumable Hugging Face archive backfill
npm run data:tail     # Official HN new IDs, updates, retries and overlap
npm run data:enrich -- --limit 1000
npm run data:export   # Full static export to data/catalog/
```

With a committed export but no source database, rebuild just the six-month ranking from the original exported HN comments:

```sh
npm run data:rank
```

This publishes a new immutable Rising index and switches the manifest atomically, preserving all-time article order and original comment files. Commit the updated manifest and new rank directory before deploying. A full `data:export` also generates the six-month ranking and discovery weights automatically. Use `npm run data:weights` to add or rebuild just the discovery weights from an existing export. Static rankings advance when regenerated and published.

Additional commands are `data:watch`, `data:status`, `data:audit`, and `data:fill-gaps`. Exporting `--limit N` is explicitly marked partial; the default exports the full catalogue. The exporter reads a consistent SQLite snapshot, verifies comment offsets, stages output before replacement, and retains an existing export if generation fails or exceeds its size budget.

Sources are [Open Index's HN archive](https://huggingface.co/datasets/open-index/hacker-news), the [official HN API](https://github.com/HackerNews/API), and Wikimedia. See [pipeline details](docs/pipeline.md) for gaps, deletion handling and coverage limits.

## Tests

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm ci
npx playwright install firefox
npm run test:ui
```

Firefox tests pass against a **static-only** server mounted under `/WikiHack-mobile/`. They check first-paragraph expansion/collapse and caching, whole-post Wikipedia links and keyboard access, action alignment, feedback persistence, tabs, pull-to-refresh, full-catalogue search, context files, and phone/desktop widths. They assert that no `/api` request is made. Export tests cover full context counts, pagination across file boundaries, Unicode search, redirect lookup, atomic replacement and budget failures. Unit tests also cover delayed tab responses and the 8:1:1 feed mix across pagination. A physical phone and actual GitHub deployment remain separate checks.

## Structure

```text
index.html                   Website entry point at repository root
style.css                    Mobile-first dark layout
src/                         Browser application modules
src/static-catalog.js        Static retrieval, search and pagination
src/topics.js                Home lists and subject matching
images/                      Bundled icons and illustrations
data/catalog/                Complete exported catalogue (committed)
.nojekyll                    Serve the root as plain static files
.github/workflows/pages.yml  Deploy on pushes to main or manual runs
pipeline/                    Offline import/enrichment/export tools
scripts/build-static.mjs     Assemble root website files into dist/
scripts/serve.mjs            Static file preview only
tests/                       Data, retrieval and Firefox browser tests
dist/                        Pages artifact (generated, ignored)
```

Preferences and seen history stay in localStorage. Untrusted HN comments are escaped plain text. Wikipedia text is CC BY-SA; article histories and image pages provide attribution and image-specific licences. Independent of X, Wikipedia, Hacker News and the original WikiHack.
