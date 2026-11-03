import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AlgoliaScanner, fetchJson, enrichArticles } from '../src/services.js';
import { mergeArticles, applyEnrichment } from '../src/core.js';

const { values } = parseArgs({ options: {
  since: { type: 'string', default: '2007-01-01' }, until: { type: 'string' },
  output: { type: 'string', default: 'data/feed-index.json' },
  checkpoint: { type: 'string', default: '.index-cache/checkpoint.json' },
  resume: { type: 'boolean', default: false }, enrich: { type: 'boolean', default: false },
  'max-pages': { type: 'string' },
} });
const start = Math.floor(Date.parse(values.since) / 1000);
const end = values.until ? Math.floor(Date.parse(values.until) / 1000) : Math.floor(Date.now() / 1000);
if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Use valid dates with --since before --until (exclusive).');
const limit = values['max-pages'] == null ? Infinity : Number(values['max-pages']);
if (!(limit > 0)) throw new Error('--max-pages must be a positive number.');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(url) {
  for (let attempt = 0; ; attempt++) {
    await delay(250);
    try { return await fetchJson(url, { headers: { 'User-Agent': 'WikiHackMobile-indexer/0.1 (personal Wikipedia reader)' } }); }
    catch (error) { if (attempt >= 3) throw error; await delay(1000 * 2 ** attempt); }
  }
}
const scanner = new AlgoliaScanner({ start, end, request });
let articles = [];
let range = { start, end };
if (values.resume) {
  const previous = JSON.parse(await readFile(values.checkpoint, 'utf8'));
  scanner.restore(previous.scanner);
  articles = previous.articles;
  range = previous.range;
  console.log(`Resuming ${articles.length} articles at page ${scanner.pages}. Saved date range takes precedence.`);
}
async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
}
async function checkpoint() {
  await atomicWrite(values.checkpoint, { scanner: scanner.checkpoint(), range, articles });
}
let stop = false;
process.on('SIGINT', () => { stop = true; console.log('Finishing this batch and saving checkpoint…'); });
const initialPages = scanner.pages;
try {
  while (!scanner.exhausted && !stop && scanner.pages - initialPages < limit) {
    articles = mergeArticles(articles, await scanner.next());
    if (scanner.pages % 10 === 0) await checkpoint();
    console.log(`Page ${scanner.pages} · ${articles.length.toLocaleString()} articles · scanning ${new Date((scanner.pending.at(-1)?.end || scanner.cursor) * 1000).toISOString().slice(0, 10)}`);
  }
  if (values.enrich && !stop) {
    const toEnrich = articles.filter(a => !a.metadataLoaded);
    for (let i = 0; i < toEnrich.length && !stop; i += 12) {
      const batch = toEnrich.slice(i, i + 12);
      const enriched = await enrichArticles(batch, { request });
      articles = applyEnrichment(articles, enriched);
      console.log(`Enriched metadata batch ${Math.floor(i / 12) + 1}`);
    }
  }
} catch (error) {
  await checkpoint();
  console.error(`Stopped: ${error.message}. Checkpoint saved; rerun with --resume.`);
  process.exitCode = 1;
}
await checkpoint();
const completed = scanner.exhausted;
await atomicWrite(values.output, {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  coverage: { ...range, completed, source: 'Algolia HN Search',
    note: 'Only exact Wikipedia URLs found in indexed story URLs, story text, and comment text. Not guaranteed to include every historical HN mention.' },
  articles,
});
console.log(`Wrote ${articles.length.toLocaleString()} articles to ${values.output}. Requested interval ${completed ? 'complete' : 'partially scanned'}.`);
