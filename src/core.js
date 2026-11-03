export const YEAR = 365 * 24 * 60 * 60;
export function sixMonthsAgo(now = Date.now() / 1000) {
  const date = new Date(now * 1000), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - 6);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime() / 1000;
}
const NAMESPACES = /^(special|talk|user|user talk|wikipedia|wikipedia talk|file|file talk|mediawiki|template|template talk|help|category|portal|draft|module|book|timedtext|media):/i;

export function decodeEntities(value = '') {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[code.toLowerCase()] ?? match;
  });
}

export function plainText(html = '') {
  return decodeEntities(String(html).replace(/<p\b[^>]*>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')).trim();
}

export function wikiUrl(lang, title) {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

export function parseWikiUrl(raw) {
  try {
    const url = new URL(decodeEntities(raw));
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.match(/^([a-z]{2,12}(?:-[a-z]+)?)(?:\.m)?\.wikipedia\.org$/i);
    if (!host || ['www', 'meta', 'commons'].includes(host[1])) return null;
    let title = url.pathname.startsWith('/wiki/') ? decodeURIComponent(url.pathname.slice(6)) :
      url.pathname === '/w/index.php' ? url.searchParams.get('title') : null;
    if (!title) return null;
    title = title.replaceAll('_', ' ').replace(/\s+/g, ' ').trim().normalize('NFC');
    if (!title || NAMESPACES.test(title) || title === 'Main Page') return null;
    title = title.charAt(0).toUpperCase() + title.slice(1);
    const lang = host[1].toLowerCase();
    return { id: `${lang}:${title}`, lang, title, url: wikiUrl(lang, title) };
  } catch { return null; }
}

export function extractArticles(hit) {
  const candidates = [hit.url ?? ''];
  // HN comment anchors often have shortened visible text; the full href is authoritative.
  for (const text of [hit.comment_text, hit.story_text]) {
    if (!text) continue;
    for (const match of text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) candidates.push(match[0]);
  }
  const articles = new Map();
  for (const candidate of candidates) {
    const article = parseWikiUrl(candidate);
    if (article) articles.set(article.id, article);
  }
  return [...articles.values()];
}

export function mentionFromHit(hit) {
  const comment = hit._tags?.includes('comment') || hit.comment_text != null;
  return {
    id: String(hit.objectID), kind: comment ? 'comment' : 'story',
    author: hit.author || '[deleted]', createdAt: Number(hit.created_at_i) || 0,
    storyId: String(comment ? hit.story_id || hit.objectID : hit.objectID),
    storyTitle: plainText(hit.story_title || hit.title || 'Hacker News discussion'),
    text: plainText(hit.comment_text || hit.story_text || ''), points: Number(hit.points) || 0,
  };
}

export function mergeArticles(existing, incoming) {
  const map = new Map(existing.map(article => [article.id, { ...article, mentions: [...article.mentions] }]));
  for (const article of incoming) {
    const previous = map.get(article.id);
    if (!previous) { map.set(article.id, { ...article, mentions: [...article.mentions] }); continue; }
    const mentions = new Map(previous.mentions.map(mention => [mention.id, mention]));
    for (const mention of article.mentions) mentions.set(mention.id, mention);
    map.set(article.id, { ...previous, ...article, sourceIds: [...new Set([...(previous.sourceIds || []), ...(article.sourceIds || [])])], extract: article.extract || previous.extract,
      firstParagraph: article.firstParagraph || previous.firstParagraph,
      thumbnail: article.thumbnail || previous.thumbnail, description: article.description || previous.description,
      mentions: [...mentions.values()].sort((a, b) => b.createdAt - a.createdAt), sample: false });
  }
  return [...map.values()];
}

export function articlesFromHits(hits) {
  let articles = [];
  for (const hit of hits) {
    if (!hit.objectID || hit._tags?.includes('dead') || hit._tags?.includes('deleted')) continue;
    const mention = mentionFromHit(hit);
    articles = mergeArticles(articles, extractArticles(hit).map(article => ({ ...article, mentions: [mention] })));
  }
  return articles;
}

/** Metadata requests may finish after fresh mentions have arrived. Keep both. */
export function applyEnrichment(existing, enriched) {
  let result = existing;
  for (const article of enriched) {
    const ids = new Set([article.id, ...(article.sourceIds || [])]);
    const originals = result.filter(a => ids.has(a.id));
    const mentions = mergeArticles([], originals.map(a => ({ ...a, id: article.id })));
    const replacement = mergeArticles(mentions, [article]);
    result = mergeArticles(result.filter(a => !ids.has(a.id)), replacement);
  }
  return result;
}

export function uniqueAuthors(article, since = 0, until = Infinity) {
  if (since === 0 && article.metrics?.distinctLinkers != null) return article.metrics.distinctLinkers;
  return new Set(article.mentions.filter(m => m.createdAt >= since && m.createdAt <= until && m.author !== '[deleted]').map(m => m.author)).size;
}

export function rankArticles(articles, mode, { now = Date.now() / 1000, random = Math.random } = {}) {
  if (mode === 'random') {
    // Exponential race: weighted sampling without replacement. sqrt tempers popularity bias.
    return articles.map(article => ({ article, key: -Math.log(Math.max(Number.MIN_VALUE, random())) /
      Math.sqrt(1 + uniqueAuthors(article)) })).sort((a, b) => a.key - b.key).map(x => x.article);
  }
  const since = mode === 'rising' ? sixMonthsAgo(now) : 0;
  return articles.filter(a => mode !== 'rising' || a.sample || a.mentions.some(m => m.createdAt >= since && m.createdAt <= now))
    .slice().sort((a, b) => uniqueAuthors(b, since, mode === 'rising' ? now : Infinity) - uniqueAuthors(a, since, mode === 'rising' ? now : Infinity) ||
      b.mentions.filter(m => m.createdAt >= since && (mode !== 'rising' || m.createdAt <= now)).length - a.mentions.filter(m => m.createdAt >= since && (mode !== 'rising' || m.createdAt <= now)).length ||
      a.title.localeCompare(b.title));
}

export function searchArticles(articles, query) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return articles.filter(article => {
    const text = `${article.title} ${article.description || ''} ${article.extract || ''}`.toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export function safeHttps(url) {
  try { return new URL(url).protocol === 'https:' ? url : ''; } catch { return ''; }
}
