import { fetchJson } from './services.js';

const cache = new Map();
const DAY = 86400000;

// Thirty days smooth daily fluctuations. Missing/null counts are not zero views.
export function summarizeViews(pageviews, checkedAt = Date.now()) {
  const values = Object.values(pageviews || {}).filter(value => Number.isInteger(value) && value >= 0);
  if (values.length < 7) return null;
  return { dailyViews: values.reduce((sum, value) => sum + value, 0) / values.length, days: values.length, checkedAt };
}

export function readershipWeight(article, now = Date.now()) {
  const data = article.readership;
  if (!data || !Number.isFinite(data.dailyViews) || data.dailyViews < 0 || !Number.isInteger(data.days) || data.days < 7 || data.days > 30 ||
      !Number.isFinite(data.checkedAt) || now - data.checkedAt > DAY || data.checkedAt > now) return 1;
  const views = data.dailyViews;
  const interest = Math.min(1, Math.log1p(views) / Math.log1p(100));
  const linkers = article.metrics?.distinctLinkers ?? new Set((article.mentions || []).map(m => m.author)).size;
  // Strongest penalty requires BOTH weak HN interest and low Wikipedia readership.
  const lowTraffic = (.7 + .3 * interest) * (linkers < 5 ? .5 + .5 * interest : 1);
  const boost = .15 * Math.min(1, Math.max(0, Math.log10(Math.max(100, views) / 100) / 2));
  return lowTraffic + boost;
}

export async function fetchReadership(articles, { request = url => fetchJson(url, { timeout: 3500 }), now = Date.now() } = {}) {
  const groups = new Map();
  for (const article of articles) {
    const saved = cache.get(article.id) || article.readership;
    if (saved && now - saved.checkedAt < DAY && saved.checkedAt <= now) { cache.set(article.id, saved); continue; }
    if (!/^[a-z][a-z0-9-]{0,24}$/.test(article.lang) || article.title.includes('|')) continue;
    if (!groups.has(article.lang)) groups.set(article.lang, []);
    groups.get(article.lang).push(article);
  }
  const tasks = [];
  for (const [lang, entries] of groups) for (let i = 0; i < entries.length; i += 20) {
    const batch = entries.slice(i, i + 20);
    tasks.push(async () => {
      try {
        const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', origin: '*',
          prop: 'pageviews', pvipdays: '30', redirects: '1', titles: batch.map(a => a.title).join('|') });
        const data = await request(`https://${lang}.wikipedia.org/w/api.php?${params}`);
        const aliases = new Map([...(data.query?.normalized || []), ...(data.query?.redirects || [])].map(a => [a.from, a.to]));
        for (const article of batch) {
          let title = article.title;
          const seen = new Set();
          while (aliases.has(title) && !seen.has(title)) { seen.add(title); title = aliases.get(title); }
          const page = data.query?.pages?.find(p => p.title === title);
          const summary = summarizeViews(page?.pageviews, now);
          cache.set(article.id, summary || { checkedAt: now });
        }
      } catch { /* Unavailable traffic is neutral; browsing remains available offline. */ }
    });
  }
  // Bound external request concurrency even for multilingual candidate pages.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => {
    while (cursor < tasks.length) await tasks[cursor++]();
  }));
  const result = articles.map(article => cache.get(article.id) ? { ...article, readership: cache.get(article.id) } : article);
  while (cache.size > 2000) cache.delete(cache.keys().next().value);
  return result;
}
