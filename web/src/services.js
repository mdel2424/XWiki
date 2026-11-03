import { articlesFromHits, mergeArticles, wikiUrl } from './core.js';

export async function fetchJson(url, { timeout = 12000, fetcher = fetch, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

export function algoliaUrl({ start, end, page = 0, popular = false }) {
  const params = new URLSearchParams({ query: 'wikipedia.org', tags: '(story,comment)',
    hitsPerPage: '100', page: String(page), typoTolerance: 'false', restrictSearchableAttributes: 'url,story_text,comment_text' });
  if (start != null) params.set('numericFilters', `created_at_i>=${start},created_at_i<${end}`);
  return `https://hn.algolia.com/api/v1/${popular ? 'search' : 'search_by_date'}?${params}`;
}

/** Splits crowded windows BEFORE paging, avoiding Algolia's 1,000-result ceiling. */
export class AlgoliaScanner {
  constructor({ start = 1167609600, end = Math.floor(Date.now() / 1000), request = fetchJson } = {}) {
    this.start = start;
    this.cursor = end;
    this.pending = [];
    this.request = request;
    this.pages = 0;
  }
  get exhausted() { return this.cursor <= this.start && this.pending.length === 0; }
  async popular() {
    const data = await this.request(algoliaUrl({ popular: true }));
    return articlesFromHits(data.hits || []);
  }
  async next() {
    if (!this.pending.length) {
      if (this.exhausted) return [];
      const start = Math.max(this.start, this.cursor - 30 * 86400);
      this.pending.push({ start, end: this.cursor, page: 0 });
      this.cursor = start;
    }
    const window = this.pending[this.pending.length - 1];
    const data = await this.request(algoliaUrl(window));
    if (data.nbHits > 900 && window.end - window.start > 1) {
      const midpoint = Math.floor((window.start + window.end) / 2);
      this.pending.pop();
      this.pending.push({ start: window.start, end: midpoint, page: 0 },
        { start: midpoint, end: window.end, page: 0 });
      return this.next();
    }
    // A one-second bucket cannot be split further. Never silently claim it is complete.
    if (data.nbHits > 1000) throw new Error('More than 1,000 hits in one second; use the HN archive for this interval.');
    this.pages++;
    window.page++;
    if (window.page >= (data.nbPages || 1)) this.pending.pop();
    return articlesFromHits(data.hits || []);
  }
  checkpoint() {
    return { start: this.start, cursor: this.cursor, pending: this.pending.map(w => ({ ...w })), pages: this.pages };
  }
  restore(checkpoint) {
    this.start = checkpoint.start;
    this.cursor = checkpoint.cursor;
    this.pending = checkpoint.pending.map(w => ({ ...w }));
    this.pages = checkpoint.pages;
  }
}

export async function enrichArticles(articles, { request = fetchJson } = {}) {
  const enriched = [];
  const byLanguage = Map.groupBy ? Map.groupBy(articles, a => a.lang) : articles.reduce((groups, a) => {
    if (!groups.has(a.lang)) groups.set(a.lang, []);
    groups.get(a.lang).push(a);
    return groups;
  }, new Map());
  for (const [lang, entries] of byLanguage) {
    for (let i = 0; i < entries.length; i += 12) {
      const batch = entries.slice(i, i + 12);
      const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2',
        origin: '*', prop: 'extracts|pageimages|pageterms|categories|links', exintro: '1', explaintext: '1',
        exsentences: '5', piprop: 'thumbnail', pithumbsize: '900', pilimit: '12',
        wbptterms: 'description', clshow: '!hidden', cllimit: '50', pllimit: '50', plnamespace: '0',
        redirects: '1', titles: batch.map(a => a.title).join('|') });
      const data = await request(`https://${lang}.wikipedia.org/w/api.php?${params}`);
      const aliases = new Map([...(data.query?.normalized || []), ...(data.query?.redirects || [])].map(r => [r.from, r.to]));
      for (const article of batch) {
        let title = article.title;
        const visited = new Set();
        while (aliases.has(title) && !visited.has(title)) { visited.add(title); title = aliases.get(title); }
        const page = data.query?.pages?.find(p => p.title === title);
        enriched.push({ ...article, sourceIds: [article.id], id: `${lang}:${title}`, title, url: wikiUrl(lang, title),
          extract: page?.extract || article.extract || '',
          description: page?.terms?.description?.[0] || article.description || '',
          thumbnail: page?.thumbnail?.source || article.thumbnail || '',
          categories: page?.categories?.map(c => c.title.replace(/^Category:/, '')) || article.categories || [],
          related: page?.links?.map(link => link.title) || article.related || [],
          metadataLoaded: Boolean(page && !page.missing) });
      }
    }
  }
  return mergeArticles([], enriched);
}

export function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`wikihack:${key}`)) ?? fallback; } catch { return fallback; }
}
export function writeStorage(key, value) {
  try { localStorage.setItem(`wikihack:${key}`, JSON.stringify(value)); return true; } catch { return false; }
}
