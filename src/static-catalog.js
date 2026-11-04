import { discoveryOrder } from './discovery.js';
import { matchesTopic, topicFor, isPersonalized } from './topics.js';

const STOP = new Set('a an the and of to in on for with from by is are was were it its as at that this or not be'.split(' '));
export function searchTerms(text = '') {
  return [...new Set((String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(t => !STOP.has(t)))];
}
export function bucket(text, count) {
  let value = 2166136261;
  for (const byte of new TextEncoder().encode(text)) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value % count;
}
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function sample(count, start, size, seed) {
  if (!count) return [];
  let stride = 1 + bucket(String(seed), Math.max(1, count - 1));
  while (gcd(stride, count) !== 1) stride++;
  const shift = bucket(`offset:${seed}`, count);
  return Array.from({ length: Math.max(0, Math.min(size, count - start)) }, (_, i) => (shift + (start + i) * stride) % count);
}

export class StaticCatalog {
  constructor({ base = new URL('../data/catalog/', import.meta.url), fetcher = fetch } = {}) {
    this.base = new URL(base); this.fetcher = fetcher; this.manifest = null; this.cache = new Map(); this.discovery = null;
    this.topicIndex = null; this.articleTopics = null; this.topicDataPromise = null;
  }
  async read(path, { fresh = false } = {}) {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) throw new Error('Invalid static catalogue path.');
    if (!fresh && this.cache.has(url.href)) {
      const value = this.cache.get(url.href); this.cache.delete(url.href); this.cache.set(url.href, value); return value;
    }
    // Firefox's native fetch must not receive StaticCatalog as its `this` value.
    const fetcher = this.fetcher;
    const promise = fetcher(url.href, { cache: fresh ? 'no-cache' : 'default' }).then(response => {
      if (!response.ok) throw new Error(`Static data request failed (${response.status})`);
      return response.json();
    }).catch(error => { this.cache.delete(url.href); throw error; });
    if (!fresh) { this.cache.set(url.href, promise); if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value); }
    return promise;
  }
  async open() {
    const manifest = await this.read('manifest.json', { fresh: true });
    if (manifest.kind !== 'wikihack-static' || manifest.version !== 1 || !manifest.articleCount ||
        !/^v-[a-z0-9]+$/.test(manifest.generation)) throw new Error('Static catalogue is missing or unsupported.');
    if (this.manifest?.generation !== manifest.generation || this.manifest?.risingPath !== manifest.risingPath ||
        this.manifest?.discoveryWeights !== manifest.discoveryWeights || this.manifest?.topicIndex?.path !== manifest.topicIndex?.path) {
      this.cache.clear(); this.discovery = null; this.topicIndex = null; this.articleTopics = null; this.topicDataPromise = null;
    }
    this.manifest = manifest;
    return manifest;
  }
  file(path) { if (!this.manifest) throw new Error('Open the catalogue first.'); return `${this.manifest.generation}/${path}`; }
  async discoveryOrder(seed) {
    if (!this.manifest.discoveryWeights) return null; // Older exports still work.
    if (this.discovery?.seed === seed) return this.discovery.order;
    const order = this.read(this.file(this.manifest.discoveryWeights)).then(linkers => {
      if (!Array.isArray(linkers) || linkers.length !== this.manifest.articleCount ||
          linkers.some(count => !Number.isInteger(count) || count < 0 || count > 255)) throw new Error('Invalid discovery weights.');
      return discoveryOrder(linkers, seed);
    }).catch(error => {
      if (this.discovery?.order === order) this.discovery = null;
      throw error;
    });
    this.discovery = { seed, order };
    return order;
  }
  async cards(indices) {
    const size = this.manifest.articleShardSize;
    const unique = [...new Set(indices)].filter(i => Number.isInteger(i) && i >= 0 && i < this.manifest.articleCount);
    const groups = [...new Set(unique.map(i => Math.floor(i / size)))];
    const shards = new Map(await Promise.all(groups.map(async group => [group, await this.read(this.file(`articles/${group}.json`))])));
    return unique.map(i => {
      const article = shards.get(Math.floor(i / size))[i % size];
      return this.articleTopics ? { ...article, topics: this.articleTopics[i] || [] } : article;
    });
  }
  async index(id) {
    const ids = await this.read(this.file(`ids/${bucket(id, this.manifest.idBuckets)}.json`));
    return ids[id];
  }
  async ranks(name, start, size) {
    const count = name === 'rising' ? this.manifest.risingCount : this.manifest.articleCount;
    const ids = [], width = this.manifest.rankShardSize;
    for (let position = start; position < Math.min(count, start + size);) {
      const values = await this.read(this.file(`${name === 'rising' ? this.manifest.risingPath || name : name}/${Math.floor(position / width)}.json`));
      const part = values.slice(position % width, Math.min(width, position % width + start + size - position));
      ids.push(...part); position += part.length;
      if (!part.length) break;
    }
    return ids;
  }
  async matches(query, { any = false, exact = [] } = {}) {
    const terms = searchTerms(query).slice(0, 16);
    if (!terms.length) return [];
    const groups = [...new Set(terms.map(t => bucket(t.slice(0, 2), this.manifest.searchBuckets)))];
    const shards = new Map(await Promise.all(groups.map(async group => [group, await this.read(this.file(`search/${group}.json`))])));
    const hits = new Map();
    for (const term of terms) {
      const ids = new Set();
      const values = shards.get(bucket(term.slice(0, 2), this.manifest.searchBuckets));
      for (const [word, postings] of Object.entries(values)) {
        if (term.length === 1 || exact.includes(term) ? word === term : word.startsWith(term)) for (const id of postings) ids.add(id);
      }
      for (const id of ids) hits.set(id, (hits.get(id) || 0) + 1);
    }
    return [...hits].filter(([, score]) => any || score === terms.length)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
  }
  async search(query, { cursor = 0, limit = 60 } = {}) {
    const ids = query.trim() ? await this.matches(query) : Array.from({ length: this.manifest.articleCount }, (_, i) => i);
    return { articles: await this.cards(ids.slice(cursor, cursor + limit)), nextCursor: cursor + limit < ids.length ? cursor + limit : null };
  }
  async topicData() {
    if (!this.manifest.topicIndex?.path) throw new Error('Wikipedia topic predictions are unavailable in this catalogue.');
    if (!this.topicDataPromise) {
      const generation = this.manifest.generation;
      const pending = this.read(this.file(this.manifest.topicIndex.path)).then(data => {
        if (data.kind !== 'xwiki-topic-index' || data.version !== 1 || data.generation !== generation ||
            data.coverage?.articles !== this.manifest.articleCount || !data.topics ||
            data.source?.kind !== 'wikimedia-articletopic') throw new Error('Invalid Wikipedia topic index.');
        const assignments = new Array(this.manifest.articleCount);
        for (const [topic, indices] of Object.entries(data.topics)) {
          if (!Array.isArray(indices)) throw new Error('Invalid Wikipedia topic membership.');
          const seen = new Set();
          for (const index of indices) {
            if (!Number.isInteger(index) || index < 0 || index >= assignments.length || seen.has(index)) throw new Error('Invalid Wikipedia topic membership.');
            seen.add(index); (assignments[index] ||= []).push(topic);
          }
        }
        if (this.manifest.generation !== generation || this.topicDataPromise !== pending) throw new Error('Catalogue changed while loading topics.');
        this.topicIndex = data; this.articleTopics = assignments;
        return data;
      }).catch(error => {
        if (this.topicDataPromise === pending) this.topicDataPromise = null;
        throw error;
      });
      this.topicDataPromise = pending;
    }
    return this.topicDataPromise;
  }
  async topicPool(topic) {
    const data = await this.topicData();
    return data.topics[topic.id] || [];
  }
  async feed({ mode = 'for-you', cursor = 0, limit = 60, mix = 0, exclude = [] } = {}) {
    if (!isPersonalized(mode)) {
      const count = mode === 'rising' ? this.manifest.risingCount : this.manifest.articleCount;
      const ids = mode === 'rising' ? await this.ranks('rising', cursor, limit) :
        Array.from({ length: Math.max(0, Math.min(limit, count - cursor)) }, (_, i) => cursor + i);
      return { articles: await this.cards(ids), nextCursor: cursor + limit < count ? cursor + limit : null, mode };
    }
    // Each lane owns its shuffled cursor. Refill around overlaps and seen posts
    // rather than counting the same article toward two quotas.
    const size = Math.max(10, Math.ceil(limit / 10) * 10);
    const positions = typeof cursor === 'object' ? { ...cursor } : { random: 0, rising: 0, top: 0 };
    const used = new Set(exclude), sources = { random: [], rising: [], top: [] }, articles = [];
    const topic = topicFor(mode);
    let pools;
    if (topic) {
      const candidates = await this.topicPool(topic), allowed = new Set(candidates);
      const [weighted, rising] = await Promise.all([
        this.discoveryOrder(mix), this.ranks('rising', 0, this.manifest.risingCount),
      ]);
      pools = { top: candidates.slice(0, 1000), rising: rising.filter(id => allowed.has(id)).slice(0, 1000),
        random: weighted ? Array.from(weighted).filter(id => allowed.has(id)) : candidates };
    }
    const take = async (lane, wanted) => {
      // Featured lanes sample the leading 1,000; random spans the entire archive.
      const count = pools ? pools[lane].length : lane === 'random' ? this.manifest.articleCount :
        Math.min(1000, lane === 'rising' ? this.manifest.risingCount : this.manifest.articleCount);
      while (sources[lane].length < wanted && positions[lane] < count) {
        const remaining = wanted - sources[lane].length;
        let draw, indices;
        if (pools) {
          draw = lane === 'random' && this.manifest.discoveryWeights ?
            Array.from({ length: Math.min(remaining, count - positions[lane]) }, (_, i) => positions[lane] + i) :
            sample(count, positions[lane], remaining, `${lane}:${mix}`);
          indices = draw.map(position => pools[lane][position]);
        } else {
          const weighted = lane === 'random' ? await this.discoveryOrder(mix) : null;
          draw = weighted ? Array.from(weighted.subarray(positions[lane], positions[lane] + remaining)) :
            sample(count, positions[lane], remaining, `${lane}:${mix}`);
          indices = lane === 'rising' ? (await Promise.all(draw.map(async position =>
            (await this.ranks('rising', position, 1))[0]))).filter(i => i != null) : draw;
        }
        positions[lane] += draw.length;
        for (const article of await this.cards(indices)) {
          if (used.has(article.id) || !matchesTopic(article, mode)) continue;
          used.add(article.id); sources[lane].push(article.id); articles.push(article);
        }
      }
    };
    await take('top', size / 10);
    await take('rising', size / 10);
    await take('random', size * .8);
    return { articles, sources, nextCursor: positions.random < (pools?.random.length ?? this.manifest.articleCount) ? positions : null, mode };
  }

  async article(id, { cursor = 0, limit = 50 } = {}) {
    const index = await this.index(id);
    if (index == null) throw new Error('Article is not in this snapshot.');
    const [article] = await this.cards([index]);
    const { start, count } = article.context, size = this.manifest.contextShardSize;
    const mentions = [];
    for (let position = start + cursor; position < start + Math.min(count, cursor + limit);) {
      const block = await this.read(this.file(`context/${Math.floor(position / size)}.json`));
      const part = block.slice(position % size, position % size + Math.min(size - position % size, start + Math.min(count, cursor + limit) - position));
      mentions.push(...part); position += part.length;
      if (!part.length) throw new Error('Incomplete static comment block.');
    }
    return { ...article, mentions, nextCursor: cursor + mentions.length < count ? cursor + mentions.length : null };
  }
}
