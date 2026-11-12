# Developing xWiki

See the [main README](../README.md) for the app demo and feature overview, and the [pipeline notes](pipeline.md) for archive coverage and ranking details.

## Preview locally

Node.js 22 or later is sufficient to serve the bundled site:

```sh
npm start
# http://localhost:4173/
```

The application is served from the repository root. No dependency installation or database is needed for this preview. To open it from a phone on the same trusted Wi-Fi network:

```sh
HOST=0.0.0.0 npm start
# Open http://<this computer's LAN IP>:4173/ on the phone.
```

## Build

Use the committed catalogue to assemble the deployable site:

```sh
npm run build -- --reuse-data
npm run preview
```

The build copies `index.html`, `site.webmanifest`, `style.css`, `src/`, `images/`, and `data/` into `dist/` and adds `.nojekyll`. The bundled export contains 201,844 articles and 697,007 HN mentions, about 631 MB of published files. The build enforces a 950 MB budget. `dist/` and the local database are ignored by Git.

With an imported archive at `.data/wikihack.sqlite`, `npm run build` exports fresh data before assembling the site. Use `--reuse-data` for UI changes and builds that should retain the existing snapshot.

## GitHub Pages

In the repository's **Settings → Pages → Build and deployment**, choose **GitHub Actions** as the source. The [Publish GitHub Pages workflow](../.github/workflows/pages.yml) builds and deploys pushes to `main`; it can also be started manually from the Actions tab.

The deployed app is at <https://mdel2424.github.io/XWiki/>. Paths are relative so the site also works under another project subpath or a custom domain. Deployment uses the committed catalogue and needs no Python environment or application server.

## Data preparation

Python 3.10 or later, SQLite FTS5, and DuckDB are used for offline data preparation:

```sh
npm run data:setup
npm run data:sync                    # Resumable archive backfill
npm run data:tail                    # New HN IDs, updates, retries and overlap
npm run data:enrich -- --limit 1000
npm run data:export                  # Export to data/catalog/
npm run build -- --reuse-data
```

Commit the updated catalogue along with source changes before deploying. Pull-to-refresh checks for a published snapshot and changes the discovery mix; it does not ingest HN data.

To update ranking indexes from an existing export without the source database:

```sh
npm run data:rank       # Rebuild the six-month Rising ranking
npm run data:weights    # Rebuild discovery weights
npm run data:topics     # Cache Wikipedia topic predictions and publish the topic index
npm run data:wikipedia  # Cache Wikipedia popularity and publish its ranking
```

Additional commands include `data:watch`, `data:status`, `data:audit`, and `data:fill-gaps`. `package:catalog` creates an optional archive for backup or distribution. Full exports include HN rankings, discovery weights, topic memberships, and a Wikipedia ranking from their local caches; exports with `--limit N` are marked partial.

The exporter reads a consistent SQLite snapshot, checks comment offsets, and stages output before replacing the catalogue. If generation fails or exceeds its budget, the existing export is retained. See [pipeline notes](pipeline.md) for gaps, deletion handling, source provenance, and coverage limits.

## Browser data

`data/catalog/manifest.json` points to a versioned snapshot containing article cards, search postings, rankings, ID/redirect lookups, discovery weights, Wikipedia topic memberships and popularity ranking, and paginated HN comments. The client fetches shards as needed and keeps a bounded cache.

Recommendations, likes, seen history, and pins stay in the browser. Personalized candidate batches fetch recent Wikipedia pageviews for a bounded readership preference; unavailable traffic remains neutral. Counts are cached for a day, and low readership is penalized most when HN linking is also low. Saved preferences use localStorage. Topic membership comes exclusively from Wikipedia’s article-topic predictions at a confidence of at least 0.5. The shared `src/topic-definitions.json` maps model labels into 21 display groups. Titles, summaries, and categories do not decide membership. Unscored articles remain available in For you and search. The Home tab replaces the former For you tab. One toolbar beneath the topics combines the sort button and archive count. Sort choices appear in this order: For You (HN), Top (HN), Rising (HN), Top (Wikipedia). For You (HN) is the default and applies the same personalization and 80/10/10 discovery mix within each group. Top (Wikipedia), Top (HN), and Rising (HN) filter the complete published rankings by topic and preserve their order regardless of likes. Topic classification confidence never ranks posts. Each topic/sort pair owns its candidates, source lanes, request tickets, and pagination cursor. Search is search-only and does not change the Home selection. Original HN comment text is escaped before rendering. Article previews prefer the Wikipedia lead image. If none exists, a separate background request parses the article and selects the first substantial body image in reading order, skipping navigation, maintenance notices and small decorative icons. Body diagrams use contain sizing to keep the whole image visible. Results, including successful no-image checks, are cached in the feed; image display settings apply to these requests. Offline metadata enrichment uses the same selection rules.

The topic picker defaults to alphabetical order. Dragging a handle saves a custom order separately from pin membership; pinned Home tabs follow that custom order. Without a saved order, the Home defaults remain Computing, Physics & Chemistry, History. Existing saved pins and orders migrate to the broader groups; Psychology becomes Society & Education. Reordering supports mouse and touch, edge scrolling, and Space/arrow/Enter keyboard controls with Escape to cancel. New topics are appended alphabetically to saved orders.

## Tests

```sh
npm test
# With a project Python environment:
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'

# Browser checks:
npm ci
npx playwright install firefox
npm run test:ui
```

The browser suite serves a generated fixture catalogue under a project subpath and checks reading, feedback, all four topic sorts, delayed sort responses, search-only navigation, pin persistence, loading indicators, navigation, and mobile/desktop layouts. Node and Python tests cover retrieval, recommendation behavior, delayed responses, export integrity, and pagination. Screenshots generated by tests go in the ignored `test-results/` directory; the README uses screenshots of the real catalogue in `docs/screenshots/`.

## Project layout

```text
index.html                    App entry point
site.webmanifest              Home-screen metadata and icons
style.css                     Dark, responsive interface
src/app.js                    UI and navigation
src/topic-definitions.json     Shared 21-group model taxonomy
src/topics.js                 Membership, pin defaults and preference migration
src/topic-reorder.js          Pointer and keyboard topic reordering
src/static-catalog.js         Static retrieval, search and pagination
src/recommendations.js        Local recommendation ranking
pipeline/wikipedia.py         Wikipedia popularity collection and static ranking
images/                       Icons and illustrations
data/catalog/                 Exported article catalogue (committed)
docs/screenshots/             README demo screenshots
docs/pipeline.md              Data provenance, coverage and ranking
pipeline/                     Offline data tools
scripts/build-static.mjs      Assemble dist/
scripts/serve.mjs             Static preview server
tests/                        Unit, export and browser checks
.github/workflows/pages.yml   GitHub Pages deployment
dist/                         Generated deployment output (ignored)
```
