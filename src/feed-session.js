import { HOME_FEEDS, FEED_SORTS } from './topics.js';

export const FEED_MODES = HOME_FEEDS.map(feed => feed.id);

// Each topic/sort pair owns its cursor. Responses cannot commit over newer requests.
export class FeedSession {
  constructor() {
    this.mode = 'for-you';
    this.sort = 'for-you';
    this.tabs = new Map(FEED_MODES.flatMap(mode => FEED_SORTS.map(sort => [`${mode}:${sort.id}`, { ids: null, sources: null, cursor: 0, ticket: 0, loading: false }])));
  }
  select(mode, sort = this.sort) {
    if (!this.tab(mode, sort)) return false;
    this.mode = mode; this.sort = sort;
    return true;
  }
  tab(mode = this.mode, sort = this.sort) { return this.tabs.get(`${mode}:${sort}`); }
  invalidate() {
    for (const tab of this.tabs.values()) {
      Object.assign(tab, { ids: null, sources: null, cursor: 0, loading: false, ticket: tab.ticket + 1 });
    }
  }
  canonicalize(enriched) {
    for (const tab of this.tabs.values()) {
      if (!tab.ids) continue;
      for (const article of enriched) {
        if (tab.sources) for (const lane of Object.keys(tab.sources)) {
          tab.sources[lane] = [...new Set(tab.sources[lane].map(id => article.sourceIds?.includes(id) ? article.id : id))];
        }
        tab.ids = [...new Set(tab.ids.map(id => article.sourceIds?.includes(id) ? article.id : id))];
      }
    }
  }
  async load(loader, { mode = this.mode, sort = this.sort, reset = false } = {}) {
    const tab = this.tab(mode, sort), ticket = ++tab.ticket;
    const cursor = reset ? 0 : tab.cursor ?? 0;
    tab.loading = true;
    try {
      const response = await loader({ mode, sort, cursor });
      if (ticket !== tab.ticket) return { stale: true, current: false };
      tab.ids = [...new Set([...(reset ? [] : tab.ids || []), ...response.articles.map(a => a.id)])];
      if (response.sources) {
        tab.sources = Object.fromEntries(Object.entries(response.sources).map(([lane, ids]) =>
          [lane, [...new Set([...(reset ? [] : tab.sources?.[lane] || []), ...ids])]]));
      }
      tab.cursor = response.nextCursor;
      return { response, stale: false, current: this.mode === mode && this.sort === sort };
    } catch (error) {
      if (ticket !== tab.ticket) return { stale: true, current: false };
      throw error;
    } finally {
      if (ticket === tab.ticket) tab.loading = false;
    }
  }
}
