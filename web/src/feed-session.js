export const FEED_MODES = ['for-you', 'top', 'rising'];

// Each tab owns its page/cursor. Responses cannot commit over newer requests.
export class FeedSession {
  constructor() {
    this.mode = 'for-you';
    this.tabs = new Map(FEED_MODES.map(mode => [mode, { ids: null, cursor: 0, ticket: 0, loading: false }]));
  }
  select(mode) {
    if (!this.tabs.has(mode)) return false;
    this.mode = mode;
    return true;
  }
  tab(mode = this.mode) { return this.tabs.get(mode); }
  canonicalize(enriched) {
    for (const tab of this.tabs.values()) {
      if (!tab.ids) continue;
      for (const article of enriched) {
        tab.ids = [...new Set(tab.ids.map(id => article.sourceIds?.includes(id) ? article.id : id))];
      }
    }
  }
  async load(loader, { mode = this.mode, reset = false } = {}) {
    const tab = this.tab(mode), ticket = ++tab.ticket;
    const cursor = reset ? 0 : tab.cursor ?? 0;
    tab.loading = true;
    try {
      const response = await loader({ mode, cursor });
      if (ticket !== tab.ticket) return { stale: true, current: false };
      tab.ids = [...new Set([...(reset ? [] : tab.ids || []), ...response.articles.map(a => a.id)])];
      tab.cursor = response.nextCursor;
      return { response, stale: false, current: this.mode === mode };
    } catch (error) {
      if (ticket !== tab.ticket) return { stale: true, current: false };
      throw error;
    } finally {
      if (ticket === tab.ticket) tab.loading = false;
    }
  }
}
