import { readershipWeight } from './readership.js';
import { sixMonthsAgo } from './core.js';
// Local, explainable content-based recommendations. No claim to reproduce X's model.
const STOP = new Set(('the and for that this with from into are was were has have had but not its their they them ' +
  'which who what when where how than then also such can may will would could should about over under between ' +
  'being been some other these those more most first used using use known called one two new wikipedia article ' +
  'category articles pages containing all external links sources references').split(' '));

export function tokens(text = '') {
  return (String(text).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu) || [])
    .filter(word => !STOP.has(word) && !/^\d+$/.test(word));
}

export function features(article) {
  const weights = new Map();
  const add = (key, weight) => weights.set(key, (weights.get(key) || 0) + weight);
  const lang = article.lang || 'en';
  for (const [text, weight] of [[article.title, 3], [article.description, 2], [article.extract, 1]]) {
    for (const word of new Set(tokens(text))) add(`${lang}:word:${word}`, weight);
  }
  for (const category of (article.categories || []).slice(0, 40)) {
    const label = category.replace(/^Category:/i, '').toLowerCase();
    add(`${lang}:category:${label}`, 4);
    for (const word of new Set(tokens(label))) add(`${lang}:word:${word}`, 1);
  }
  for (const link of (article.related || []).slice(0, 40)) add(`${lang}:link:${String(link).toLowerCase()}`, 1.5);
  return weights;
}

function vectors(articles) {
  const documents = articles.map(features);
  const frequencies = new Map();
  for (const document of documents) for (const key of document.keys()) frequencies.set(key, (frequencies.get(key) || 0) + 1);
  return documents.map(document => {
    const vector = new Map();
    let norm = 0;
    for (const [key, weight] of document) {
      const value = (1 + Math.log(weight)) * (1 + Math.log((articles.length + 1) / (frequencies.get(key) + 1)));
      vector.set(key, value); norm += value * value;
    }
    const length = Math.sqrt(norm) || 1;
    return new Map([...vector].map(([key, value]) => [key, value / length]));
  });
}
export function cosine(a, b) {
  let sum = 0;
  for (const [key, value] of a) sum += value * (b.get(key) || 0);
  return sum;
}

export function emptyProfile() { return { version: 1, likes: {}, rejected: {}, seen: {} }; }
export function hidden(article, profile) { return Boolean(profile.rejected[article.id] || profile.seen?.[article.id]); }
export function snapshot(article) {
  return Object.fromEntries(['id', 'title', 'lang', 'description', 'extract', 'firstParagraph', 'categories', 'related', 'url', 'illustration', 'sample', 'mentions', 'metrics', 'thumbnail', 'readership', 'topics', 'topicPredictions', '_index']
    .filter(key => article[key] !== undefined).map(key => [key, article[key]]));
}
export function feedback(profile, article, action, now = Date.now()) {
  const next = { version: 1, likes: { ...profile.likes }, rejected: { ...profile.rejected }, seen: { ...profile.seen } };
  if (action === 'like') { next.likes[article.id] = { ...snapshot(article), at: now }; delete next.rejected[article.id]; }
  else if (action === 'unlike') delete next.likes[article.id];
  else if (action === 'reject') { next.rejected[article.id] = { ...snapshot(article), at: now }; delete next.likes[article.id]; }
  else if (action === 'undo-reject') delete next.rejected[article.id];
  else if (action === 'seen') {
    for (const id of [article.id, ...(article.sourceIds || [])]) next.seen[id] = { id, at: now };
  } else if (action === 'undo-seen') {
    for (const id of [article.id, ...(article.sourceIds || [])]) delete next.seen[id];
  }
  return next;
}

export function canonicalizeProfile(profile, enriched) {
  const next = { version: 1, likes: { ...profile.likes }, rejected: { ...profile.rejected }, seen: { ...profile.seen } };
  for (const article of enriched) {
    const aliases = new Set([article.id, ...(article.sourceIds || [])]);
    for (const field of ['likes', 'rejected', 'seen']) {
      const originals = Object.values(next[field]).filter(value => aliases.has(value.id));
      if (!originals.length) continue;
      if (field === 'seen') {
        const at = Math.max(...originals.map(value => value.at || 0));
        for (const id of aliases) next.seen[id] = { id, at };
        continue;
      }
      for (const id of aliases) delete next[field][id];
      next[field][article.id] = { ...(field === 'seen' ? { id: article.id } : snapshot(article)), at: Math.max(...originals.map(value => value.at || 0)) };
    }
  }
  return next;
}

function noise(id, seed) {
  let hash = 2166136261;
  for (const char of `${seed}:${id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15; hash = Math.imul(hash, 0x846ca68b);
  return ((hash ^ hash >>> 16) >>> 0) / 4294967296;
}
export function recommend(articles, profile = emptyProfile(), { now = Date.now(), seed = 0, diversify = true, sources = null, offset = 0 } = {}) {
  const candidates = articles.filter(a => !hidden(a, profile));
  const positive = Object.values(profile.likes).slice(-100);
  const negative = Object.values(profile.rejected).slice(-100);
  const all = [...candidates, ...positive, ...negative];
  const encoded = vectors(all);
  const likedVectors = encoded.slice(candidates.length, candidates.length + positive.length);
  const rejectedVectors = encoded.slice(candidates.length + positive.length);
  const pool = candidates.map((article, i) => {
    const vector = encoded[i];
    const positiveMatches = likedVectors.map((v, j) => ({ value: cosine(vector, v), title: positive[j].title }));
    positiveMatches.sort((a, b) => b.value - a.value);
    const affinity = positiveMatches.slice(0, 3).reduce((sum, m, j) => sum + m.value / (j + 1), 0);
    const aversion = Math.max(0, ...rejectedVectors.map(v => cosine(vector, v)));
    const linkers = article.metrics?.distinctLinkers ?? new Set((article.mentions || []).map(m => m.author)).size;
    const quality = Math.min(1, Math.log1p(linkers) / 8);
    const latest = article.metrics?.latestMention || Math.max(0, ...(article.mentions || []).map(m => m.createdAt));
    const recency = latest ? Math.exp(-Math.max(0, now / 1000 - latest) / (90 * 86400)) : 0;
    return { article, vector, aversion, quality, linkers, affinity,
      score: .15 * Math.log(readershipWeight(article, now)) + .45 * quality + .1 * recency + 4 * affinity - 6 * aversion + .1 * noise(article.id, seed) - (profile.likes[article.id] ? .4 : 0),
      reason: affinity > .12 ? `Because you liked ${positiveMatches[0].title}` : 'From the HN collection' };
  });
  // Eight archive-wide discoveries, one six-month trend, one all-time top post.
  const pattern = ['random', 'random', 'random', 'random', 'rising', 'random', 'random', 'random', 'random', 'top'];
  const byId = new Map(pool.map(candidate => [candidate.article.id, candidate]));
  const fromSource = lane => sources?.[lane] ? sources[lane].map(id => byId.get(id)).filter(Boolean) : [...pool];
  const random = fromSource('random').sort((a, b) =>
    (Math.pow(noise(b.article.id, seed), 1 / readershipWeight(b.article, now)) + b.affinity - 6 * b.aversion) - (Math.pow(noise(a.article.id, seed), 1 / readershipWeight(a.article, now)) + a.affinity - 6 * a.aversion));
  const queues = {
    random,
    top: sources ? fromSource('top').sort((a, b) => noise(b.article.id, `top:${seed}`) - noise(a.article.id, `top:${seed}`)) : [...pool].sort((a, b) => b.linkers - a.linkers || (b.article.metrics?.mentionCount || 0) - (a.article.metrics?.mentionCount || 0)),
    rising: sources ? fromSource('rising').sort((a, b) => noise(b.article.id, `rising:${seed}`) - noise(a.article.id, `rising:${seed}`)) : pool.filter(c => (c.article.metrics?.recentMentionCount > 0 && c.article.metrics?.latestMention >= sixMonthsAgo(now / 1000)) ||
      c.article.mentions?.some(m => m.createdAt >= sixMonthsAgo(now / 1000))).sort((a, b) => (b.article.metrics?.recentLinkers || 0) - (a.article.metrics?.recentLinkers || 0)),
    interest: [...pool].sort((a, b) => b.score - a.score),
  };
  const ranked = [], used = new Set();
  while (ranked.length < pool.length) {
    let lane = diversify ? pattern[(offset + ranked.length) % pattern.length] : 'interest';
    let next = queues[lane].find(candidate => !used.has(candidate.article.id));
    // Small or exhausted archives may not have enough unused posts in a lane.
    if (!next) { lane = 'random'; next = random.find(candidate => !used.has(candidate.article.id)); }
    if (!next) {
      lane = ['rising', 'top'].find(name => queues[name].some(candidate => !used.has(candidate.article.id)));
      if (!lane) break;
      next = queues[lane].find(candidate => !used.has(candidate.article.id));
    }
    used.add(next.article.id);
    const reason = lane === 'top' ? 'Popular across Hacker News · all time' : lane === 'rising' ? 'Trending on Hacker News · last six months' :
      next.affinity > .12 ? next.reason : 'Random discovery from the HN archive';
    ranked.push({ ...next.article, recommendation: { score: next.score, reason, lane } });
  }
  return ranked;
}
