import { parseWikiUrl } from './core.js';

export function excerpt(text = '', limit = 280) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.lastIndexOf(' ', limit);
  return clean.slice(0, cut >= limit * .65 ? cut : limit).trimEnd() + '…';
}

export function wikipediaLink(article) {
  // Only allow real Wikipedia article URLs, including when restoring browser-local snapshots.
  const parsed = parseWikiUrl(article.url);
  if (!parsed) return 'https://www.wikipedia.org/';
  return parsed.url;
}
