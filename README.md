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

The current full export contains **201,844 articles and 697,007 HN mentions**, about **613 MB** of published files. The build enforces a 950 MB budget. It contains every linked mention in the imported snapshot, not the 49-million-item source database or its parent graph. Generated data, the database and `dist/` are ignored by Git.

## Publish on GitHub Pages

The repository includes [`.github/workflows/pages.yml`](.github/workflows/pages.yml), a manually triggered Pages workflow. It downloads a prepared catalogue from a GitHub Release, builds the static site, and deploys `dist/`. Large generated files stay out of Git history.

1. Push the project source to your GitHub repository.
2. Build and package the catalogue locally:

   ```sh
   npm run build
   npm run package:catalog
   ```

3. Create a release tagged **`static-data`** and attach **`catalogue.tar.gz`**. You can use GitHub's Releases UI or, from your authenticated repository checkout:

   ```sh
   gh release create static-data catalogue.tar.gz --title "Static catalogue" --notes "Prepared WikiHack catalogue"
   ```

4. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**.
5. In **Actions → Publish static WikiHack → Run workflow**, use the `static-data` release tag.

The workflow has the Pages and OIDC permissions required by GitHub. It does not need a database, API host, Python packages, or a full archive download in CI. All browser data paths are relative to the site, so both `https://OWNER.github.io/REPO/` and custom domains work. No deployment or remote release has been created automatically.

For subsequent data updates, regenerate the catalogue, replace the release asset, and rerun the workflow:

```sh
npm run data:tail
npm run build
npm run package:catalog
gh release upload static-data catalogue.tar.gz --clobber
```

Source-only changes can reuse the existing catalogue release. A published snapshot changes only when you rebuild and deploy it. Pull-to-refresh checks for an updated manifest and changes the random mix; it does not run the ingestion pipeline.

## How the static data works

`web/data/catalog/manifest.json` points to a versioned snapshot containing:

- Article-card shards, with global HN counts and Wikipedia metadata.
- Separate Rising and recent-order pages. Top order is implicit in document ordinals.
- Prefix-search posting shards covering the entire exported catalogue.
- ID/redirect lookup shards.
- Small comment blocks. Per-article offsets retrieve the original HN comments a page at a time, rather than downloading whole discussions or the full comment archive.

The browser lazily fetches these files and caches a bounded number of shards. Search and candidate selection execute in JavaScript. Images and optional fresh summaries can load directly from Wikimedia; no WikiHack backend is required. Preview descriptions are explicitly labelled when no catalogue has been built.

## Feed and controls

For you mixes **50% interest-ranked**, **40% all-time popular** and **10% discovery** candidate lanes. Hearts boost related titles, summaries and Wikipedia categories. Not interested downranks related topics. X marks only that post as seen, with Undo. Seen state and hearts persist locally; they are never public HN votes. Top and Rising use HN counts rather than hearts. Random discovery is integrated into For you.

The three post actions are comments, heart and X. Dates, save/share buttons and the refresh button are removed. Pull down at the top to refresh, or press R on desktop. Each tab owns its cursor and stale requests cannot overwrite the current tab. Previews end near 280 characters; **Read on Wikipedia** uses a normal HTTPS link, with cover images beneath the text.

## Offline data preparation

Python 3.10+ with SQLite FTS5 and DuckDB is required for data preparation only:

```sh
npm run data:setup
npm run data:sync     # Full, resumable Hugging Face archive backfill
npm run data:tail     # Official HN new IDs, updates, retries and overlap
npm run data:enrich -- --limit 1000
npm run data:export   # Full static export to web/data/catalog/
```

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

Firefox tests pass against a **static-only** server mounted under `/WikiHack-mobile/`. They check reading links, feedback persistence, tabs and delayed responses, pull-to-refresh, full-catalogue search, context files, and phone/desktop widths. They assert that no `/api` request is made. Export tests cover full context counts, pagination across file boundaries, Unicode search, redirect lookup, atomic replacement and budget failures. A physical phone and actual GitHub deployment remain separate checks.

## Structure

```text
.github/workflows/pages.yml   GitHub Pages deployment from a prepared release asset
web/                         Static website source
web/src/static-catalog.js     Browser-side retrieval, search and pagination
web/data/catalog/            Generated static data (ignored)
pipeline/                    Offline import/enrichment/export tools
pipeline/static_export.py    Complete sharded catalogue generator
scripts/build-static.mjs     Build deployable dist/
scripts/package-catalog.mjs  Package a catalogue release asset
scripts/serve.mjs            Static file preview only
tests/                      Data, retrieval and Firefox browser tests
dist/                       Deploy this directory (generated, ignored)
```

Preferences and seen history stay in localStorage. Untrusted HN comments are escaped plain text. Wikipedia text is CC BY-SA; article histories and image pages provide attribution and image-specific licences. Independent of X, Wikipedia, Hacker News and the original WikiHack.
