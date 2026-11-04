import { mergeArticles, applyEnrichment, uniqueAuthors, searchArticles, safeHttps, rankArticles } from './core.js';
import { enrichArticles, readStorage, writeStorage, fetchFirstParagraph } from './services.js';
import { recommend, emptyProfile, feedback, hidden, canonicalizeProfile } from './recommendations.js';
import { FeedSession } from './feed-session.js';
import { StaticCatalog } from './static-catalog.js';
import { attachPullRefresh } from './pull-refresh.js';
import { SAMPLE_ARTICLES } from './samples.js';
import { icon } from './icons.js';
import { excerpt, firstParagraph, wikipediaLink } from './reading.js';
import { HOME_FEEDS, RANKED_FEEDS, homeFeeds, normalizePins, normalizeTopicOrder, isPersonalized, matchesTopic, topicFor } from './topics.js';
import { attachTopicReorder } from './topic-reorder.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const external = 'target="_blank" rel="noopener noreferrer"';
const wikiTarget = external;
const wikiHref = wikipediaLink;
const catalog = new StaticCatalog();
const feeds = new FeedSession();
const cached = readStorage('feed', { articles: [] });
const storedProfile = readStorage('profile-v1', emptyProfile());
const profile = storedProfile.version === 1 && storedProfile.likes && storedProfile.rejected ? storedProfile : emptyProfile();
const storedTopicOrder = readStorage('topic-order-v1', null);
const state = {
  articles: cached.articles || [], profile,
  settings: readStorage('settings', { images: true }), page: 'home', mode: 'for-you', homeMode: 'for-you', exploreMode: 'top',
  visible: 12, order: [], query: '', backend: null, archive: null, searchIds: null, searchCursor: null,
  searchLoading: false,
  pins: normalizePins(readStorage('pinned-topics-v1', null)),
  topicOrder: Array.isArray(storedTopicOrder) ? normalizeTopicOrder(storedTopicOrder) : null,
  loading: true, offline: false, ready: false, paused: false, seed: Math.floor(Math.random() * 1e9),
};
let observer, toastTimer, returnFocus, searchTimer, undoAction, homeScroll = 0, homeVisible = 12, generation = 0, searchTicket = 0;
let refreshingFeed = false;
const hydrating = new Set();
const expanded = new Set(), paragraphAttempts = new Set();
const compactCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const paragraphText = article => firstParagraph(article.firstParagraph || (article.sample ? article.extract : '') || article.description || 'An article linked in a Hacker News discussion.');
const collection = () => state.articles.length ? state.articles : SAMPLE_ARTICLES;
const liked = article => Boolean(state.profile.likes[article.id]);
const isHidden = article => hidden(article, state.profile);
const isSearching = () => state.page === 'explore' && Boolean(state.query.trim());
const isFeedPage = () => state.page === 'home' || state.page === 'explore' && !isSearching();
const pullIsRefreshing = () => $('#pull-refresh').dataset.state === 'refreshing';
const metrics = article => ({
  people: article.metrics?.distinctLinkers ?? uniqueAuthors(article),
  count: article.metrics?.mentionCount ?? article.mentions?.length ?? 0,
});

function toast(message, undo = null) {
  undoAction = undo;
  $('#toast').innerHTML = `<span>${esc(message)}</span>${undo ? '<button data-action="undo">Undo</button>' : ''}`;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').classList.remove('show'); undoAction = null; }, undo ? 7000 : 3500);
}
function cache() { writeStorage('feed', { articles: state.articles.slice(0, 600) }); }
function ranked(articles = collection(), offset = 0) {
  const tabIds = state.backend === 'static' && (!state.offline || feeds.tab().ids !== null) ? new Set(feeds.tab().ids || []) : null;
  const eligible = articles.filter(a => !isHidden(a) && matchesTopic(a, state.mode) && (!tabIds || tabIds.has(a.id)));
  if (isPersonalized(state.mode)) return recommend(eligible, state.profile, { seed: state.seed, sources: feeds.tab().sources, offset });
  // Published rank files are authoritative; keep their complete-archive order.
  if (state.backend === 'static' && feeds.tab().ids !== null) {
    const byId = new Map(eligible.map(a => [a.id, a]));
    return (feeds.tab().ids || []).map(id => byId.get(id)).filter(Boolean);
  }
  if (state.mode === 'top' || state.mode === 'rising') return rankArticles(eligible, state.mode);
  return eligible;
}
function resetOrder(preserve = []) {
  const keep = new Set(preserve), next = ranked(collection().filter(a => !keep.has(a.id)), preserve.length);
  state.order = [...preserve, ...next.filter(a => !keep.has(a.id)).map(a => a.id)];
  const reasons = new Map(next.map(a => [a.id, a.recommendation]));
  for (const article of collection()) if (reasons.has(article.id)) article.recommendation = reasons.get(article.id);
}
function viewArticles() {
  // The cached collection is a fallback, not the initial personalized feed.
  if (isFeedPage() && !state.ready) return [];
  if (state.page === 'likes') return Object.values(state.profile.likes).filter(a => !isHidden(a)).reverse();
  if (isSearching()) {
    return state.searchIds ? state.searchIds.map(id => collection().find(a => a.id === id)).filter(a => a && !isHidden(a)) : searchArticles(collection().filter(a => !isHidden(a)), state.query);
  }
  const map = new Map(collection().map(a => [a.id, a]));
  return state.order.map(id => map.get(id)).filter(a => a && !isHidden(a) && matchesTopic(a, state.mode));
}
function nav(page, label, name) {
  return `<button class="nav-item ${state.page === page ? 'active' : ''}" data-nav="${page}" aria-label="${label}" ${state.page === page ? 'aria-current="page"' : ''}>${icon(name)}<span class="sr-only">${label}</span></button>`;
}
function feedTabs(items, label) {
  return `<div class="feed-tabs" role="tablist" aria-label="${label}">${items.map(({ id, label }) => {
    const selected = state.mode === id && !isSearching();
    return `<button role="tab" id="tab-${id}" aria-controls="timeline" aria-selected="${selected}" tabindex="${selected || isSearching() && id === state.exploreMode ? 0 : -1}" data-mode="${id}">${label}</button>`;
  }).join('')}</div>`;
}
function homeTabBar() {
  return `<div class="home-tabs-host">${feedTabs(homeFeeds(state.pins, state.homeMode, state.topicOrder), 'Home feeds')}</div>`;
}
function browseTopics() {
  showSheet('Topics', `<p class="topics-intro">Pin favorites. Drag to reorder.</p><p id="topic-sort-hint" class="sr-only">On a reorder handle, press Space to pick up a topic, use arrow keys to move it, then Space or Enter to save. Escape cancels.</p><p id="pin-status" class="sr-only" role="status" aria-live="polite">${state.pins.length} topics pinned</p><p id="topic-order-status" class="sr-only" role="status" aria-live="polite"></p><div class="topic-list" role="list" aria-label="Topic order">${normalizeTopicOrder(state.topicOrder).map(id => {
    const topic = topicFor(id);
    const pinned = state.pins.includes(topic.id);
    return `<div class="topic-row" role="listitem" data-topic-id="${topic.id}"><button class="topic-open" data-action="open-topic" data-topic="${topic.id}"><span class="topic-symbol" aria-hidden="true">${icon('hash')}</span><span class="topic-copy"><strong>${esc(topic.label)}</strong><span>${esc(topic.description)}</span></span></button><button class="topic-pin ${pinned ? 'pinned' : ''}" data-action="pin-topic" data-topic="${topic.id}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(topic.label)}" aria-pressed="${pinned}" title="${pinned ? 'Unpin from' : 'Pin to'} Home">${icon('pin')}</button><button class="topic-reorder" type="button" aria-label="Reorder ${esc(topic.label)}" aria-describedby="topic-sort-hint" aria-pressed="false" title="Drag to reorder">${icon('drag-handle')}</button></div>`;
  }).join('')}</div>`);
  $('#sheet').scrollTop = 0;
  attachTopicReorder({
    list: $('.topic-list'),
    announce: message => { $('#topic-order-status').textContent = message; },
    save: order => {
      if (!writeStorage('topic-order-v1', order)) { toast('Device storage is full. Topic order could not be saved.'); return false; }
      state.topicOrder = order;
      $('.home-tabs-host').innerHTML = feedTabs(homeFeeds(state.pins, state.homeMode, order), 'Home feeds');
      return true;
    },
  });
}
function togglePin(button) {
  const topic = topicFor(button.dataset.topic);
  if (!topic) return;
  const wasPinned = state.pins.includes(topic.id);
  const next = wasPinned ? state.pins.filter(id => id !== topic.id) : [...state.pins, topic.id];
  if (!writeStorage('pinned-topics-v1', next)) { toast('Device storage is full. Pins could not be saved.'); return; }
  state.pins = next;
  button.classList.toggle('pinned', !wasPinned);
  button.setAttribute('aria-pressed', String(!wasPinned));
  button.setAttribute('aria-label', `${wasPinned ? 'Pin' : 'Unpin'} ${topic.label}`);
  button.title = `${wasPinned ? 'Pin to' : 'Unpin from'} Home`;
  if (wasPinned && state.homeMode === topic.id) {
    state.homeMode = 'for-you'; state.visible = 12; homeScroll = 0; homeVisible = 12;
    activateFeed('for-you'); renderPage(); ensureFeed();
  }
  $('.home-tabs-host').innerHTML = feedTabs(homeFeeds(state.pins, state.homeMode, state.topicOrder), 'Home feeds');
  $('#pin-status').textContent = `${next.length} ${next.length === 1 ? 'topic' : 'topics'} pinned`;
}
function shell() {
  $('#app').innerHTML = `<main class="phone-shell">
    <header class="app-header"><div class="topbar"><button class="settings-button" data-nav="settings" aria-label="Settings">${icon('settings')}</button>
      <button class="header-brand" data-nav="home" aria-label="XWiki home">XWiki</button>
      ${state.page === 'home' ? `<button class="topics-button" data-action="topics" aria-label="Browse topics" aria-haspopup="dialog" title="Topics">${icon('timeline-settings')}</button>` : '<span class="header-spacer" aria-hidden="true"></span>'}</div>
      ${state.page === 'home' ? homeTabBar() : state.page === 'explore' ? `<h1 class="sr-only">Search</h1><div class="search-wrap"><label class="search-field">${icon('search')}<input id="search" type="search" aria-label="Search articles" placeholder="Search Wikipedia articles on HN" value="${esc(state.query)}" autocomplete="off"></label></div>${feedTabs(RANKED_FEEDS, 'Archive rankings')}` : `<div class="page-heading"><h1>${({ likes: 'Likes', settings: 'Settings' })[state.page]}</h1></div>`}
    </header><div id="page-content"></div>
    <nav class="bottom-nav" aria-label="Navigation">${nav('home', 'Home', 'home')}${nav('explore', 'Search', 'search')}${nav('likes', 'Likes', 'heart')}${nav('settings', 'Settings', 'settings')}</nav>
  </main>`;
  renderPage();
}
function sourceNote() {
  const text = !state.ready ? 'Loading your feed…' : !state.articles.length ? (state.loading ? 'Connecting · preview collection' : 'Offline preview · no invented HN activity') :
    state.backend === 'static' ? `${state.archive?.articles?.toLocaleString() || 'Archive'} articles · ${topicFor(state.mode) ? `Personalized · ${topicFor(state.mode).label}` : 'Personalized for you'}` : 'Static catalogue not built';
  return `<button class="source-note" data-action="sources"><span class="status-dot"></span>${esc(text)}${icon('info')}</button>`;
}
function renderPage() {
  if (state.page === 'settings') { renderSettings(); return; }
  $('#page-content').innerHTML = `${state.page === 'home' ? sourceNote() : ''}
    ${state.page === 'likes' ? '<div class="library-intro"><h2>Your kind of interesting.</h2><p>Hearts boost related categories in For you and your topic lists.</p></div>' : ''}
    <div id="timeline"></div><div id="load-area"></div>`;
  renderTimeline();
}
function card(article, index) {
  const stats = metrics(article), media = safeHttps(article.thumbnail);
  const paragraph = paragraphText(article), open = expanded.has(article.id);
  const canExpand = Boolean(article.firstParagraph || article.sample) && paragraph !== excerpt(paragraph);
  return `<article class="article-card" data-id="${esc(article.id)}">
    <div class="post-avatar" aria-hidden="true">W</div><div class="post-body">
      <div class="post-byline"><strong>Wikipedia</strong><span class="verified" aria-label="Wikipedia source">${icon('check')}</span><span class="handle">@${esc(article.lang)}wiki</span>
        <div class="menu-wrap"><button class="more-button" data-action="menu" aria-label="More options" aria-haspopup="menu" aria-expanded="false" aria-controls="post-menu-${index}">${icon('more')}</button>
          <div class="post-menu" id="post-menu-${index}" role="menu" hidden><button role="menuitem" data-action="not-interested">${icon('dislike')}Not interested in this post</button><button role="menuitem" data-action="why">${icon('info')}Why this post?</button><button role="menuitem" data-action="context">${icon('comment')}View HN sources</button></div></div>
      </div>
      ${article.sample ? '<div class="preview-tag">Preview collection</div>' : `<button class="mention-label" data-action="context"><span class="hn-mini">Y</span> Linked by ${stats.people.toLocaleString()} ${stats.people === 1 ? 'person' : 'people'} on HN</button>`}
      <a class="article-title" href="${esc(wikiHref(article))}" ${wikiTarget}><h2>${esc(article.title)}</h2></a>
      <p class="article-extract" id="post-text-${index}">${esc(open ? paragraph : excerpt(paragraph))}</p>
      ${canExpand || open ? `<button class="read-more" data-action="expand" aria-expanded="${open}" aria-controls="post-text-${index}">${open ? 'Read less' : 'Read more'}</button>` : ''}
      ${state.settings.images !== false && (media || article.illustration) ? `<a class="article-media ${!media ? 'illustration-media' : ''}" href="${esc(wikiHref(article))}" ${wikiTarget} aria-label="Open ${esc(article.title)} on Wikipedia"><img src="${esc(media || `images/${article.illustration}.svg`)}" alt="${media ? esc(article.title) + ' — Wikipedia lead image' : 'WikiHack illustration'}" loading="lazy" referrerpolicy="no-referrer"><span class="media-caption">${media ? 'wikipedia.org' : 'WikiHack illustration'}</span></a>` : ''}
    </div>
    <div class="post-actions">
      <button data-action="context" aria-label="View Hacker News mentions" title="${stats.count.toLocaleString()} HN mentions">${icon('comment')}<span>${article.sample ? '' : compactCount.format(stats.count)}</span></button>
      <button class="heart-button ${liked(article) ? 'liked' : ''}" data-action="like" aria-label="${liked(article) ? 'Unlike article' : 'Like article'}" aria-pressed="${liked(article)}">${icon('heart')}</button>
      <button class="seen-button" data-action="seen" aria-label="Mark as seen" title="I've seen this post. Don't show it again.">${icon('close')}</button>
    </div>
    </article>`;
}
function renderTimeline() {
  if (!$('#timeline')) return;
  const articles = viewArticles();
  const waiting = isFeedPage() ? state.loading || !state.ready || pullIsRefreshing() : isSearching() && state.searchLoading;
  $('#timeline').setAttribute('aria-busy', String(Boolean(waiting)));
  $('#timeline').setAttribute('role', isFeedPage() ? 'tabpanel' : 'region');
  if (isFeedPage()) {
    $('#timeline').setAttribute('aria-labelledby', `tab-${state.mode}`);
    $('#timeline').removeAttribute('aria-label');
  } else {
    $('#timeline').removeAttribute('aria-labelledby');
    $('#timeline').setAttribute('aria-label', isSearching() ? 'Search results' : 'Liked articles');
  }
  for (const button of document.querySelectorAll('[data-mode]')) {
    const selected = button.dataset.mode === state.mode && !isSearching();
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected || isSearching() && button.dataset.mode === state.exploreMode ? 0 : -1;
  }
  const topic = state.page === 'home' && topicFor(state.mode);
  const emptyTitle = topic ? `No ${topic.label} posts yet.` : state.page === 'likes' ? 'Give your curiosity a heart.' : 'Nothing here yet.';
  const emptyText = topic ? 'Try another topic or refresh this list.' : state.page === 'likes' ? 'Like an article to find more posts with related categories.' : 'Try another search or load more articles.';
  $('#timeline').innerHTML = articles.length ? articles.slice(0, state.visible).map(card).join('') : waiting ? (pullIsRefreshing() ? '' : '<div class="feed-loading" role="status"><span class="loader" aria-hidden="true"></span><span>Loading posts…</span></div>') : `<div class="empty-state">${icon(state.page === 'likes' ? 'heart' : 'search')}<h2>${esc(emptyTitle)}</h2><p>${esc(emptyText)}</p></div>`;
  renderMore(articles); hydrate(articles.slice(0, state.visible)); hydrateParagraphs(articles.slice(0, state.visible));
}
function renderMore(articles = viewArticles()) {
  if (!$('#load-area')) return;
  const loading = isSearching() ? state.searchLoading : isFeedPage() && (state.loading || !state.ready);
  observer?.disconnect();
  // Initial loads use the timeline spinner; pull-to-refresh owns its indicator.
  if (pullIsRefreshing() || loading && !articles.length) {
    $('#load-area').replaceChildren();
    return;
  }
  const more = articles.length > state.visible || isSearching() && state.searchCursor !== null || isFeedPage() && (state.backend === 'static' && feeds.tab().cursor !== null);
  $('#load-area').innerHTML = more ? `<button class="load-more" data-action="more" ${loading ? 'disabled' : ''}>${loading ? '<span class="loader" aria-hidden="true"></span><span class="sr-only">Loading more posts…</span>' : state.offline ? 'Retry connection' : 'Show more posts'}</button>` : articles.length ? '<p class="end-note">You’re caught up with this collection.</p>' : '';
  if (more && state.ready && !loading && !state.offline && (articles.length > state.visible || isSearching() || !state.paused)) {
    observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) loadMore(); }, { rootMargin: '250px' });
    observer.observe($('.load-more'));
  }
}
function anchoredRender(id) {
  const before = [...document.querySelectorAll('.article-card')].find(el => el.dataset.id === id), top = before?.getBoundingClientRect().top;
  renderTimeline();
  const after = [...document.querySelectorAll('.article-card')].find(el => el.dataset.id === id);
  if (top != null && after) scrollBy(0, after.getBoundingClientRect().top - top);
}
function rerankAfter(article, remove = false) {
  const ids = state.order, index = ids.indexOf(article.id);
  resetOrder(index < 0 ? [] : ids.slice(0, index + (remove ? 0 : 1)).filter(id => !hidden({ id }, state.profile)));
  anchoredRender(remove ? ids[index + 1] : article.id);
}
function persistProfile(next) {
  if (!writeStorage('profile-v1', next)) { toast('Device storage is full. Preference could not be saved.'); return false; }
  state.profile = next; return true;
}
function renderSettings() {
  const stats = state.archive;
  $('#page-content').innerHTML = `<div class="settings-content">
    <section><h2>Your timeline. Your taste.</h2><p>Hearts boost related posts in For you and your topic lists. “Not interested” hides that post and reduces similar recommendations. X marks only that article as seen and hides it. Preferences stay in this browser.</p><div class="stats-row"><span><strong>${Object.keys(state.profile.likes).length}</strong> liked</span><span><strong>${Object.keys(state.profile.rejected).length}</strong> not interested</span><span><strong>${Object.keys(state.profile.seen || {}).length}</strong> seen</span></div><button class="setting-button" data-action="reset-profile">Reset recommendations ${icon('chevron')}</button></section>
    <section><h3>Display</h3><div class="setting-row"><span>Dark mode<small>The X-style black interface.</small></span>${icon('moon')}</div><label class="setting-row"><span>Article images<small>Turn off to save data.</small></span><input id="images-toggle" type="checkbox" role="switch" aria-label="Show article images" ${state.settings.images !== false ? 'checked' : ''}></label></section>
    <section><h3>HN archive</h3><p>${stats?.articles ? `${stats.articles.toLocaleString()} articles from ${stats.mentions.toLocaleString()} linked mentions. ${stats.shardsImported.toLocaleString()}/${stats.snapshot?.expectedShards || stats.shardsKnown} shards imported.` : 'Build the static catalogue to browse the imported archive.'}</p><button class="setting-button" data-action="sources">Dataset, freshness & coverage ${icon('chevron')}</button></section>
    <p class="version-note">Pull down at the top of your feed to refresh · Press R on desktop</p></div>`;
}
function findArticle(element) {
  const id = element.closest('[data-id]')?.dataset.id || $('#sheet').dataset.id;
  return collection().find(a => a.id === id) || state.profile.likes[id];
}
function showSheet(title, body, id = '') {
  const dialog = $('#sheet');
  if (!dialog.open) returnFocus = document.activeElement;
  dialog.dataset.id = id;
  dialog.innerHTML = `<div class="sheet-handle"></div><header class="sheet-header"><h2 id="sheet-title">${esc(title)}</h2><button class="icon-button" data-action="close" aria-label="Close panel">${icon('close')}</button></header><div class="sheet-content">${body}</div>`;
  if (!dialog.open) dialog.showModal();
}
function closeSheet() { $('#sheet').close(); }
function updateParagraph(article) {
  for (const post of document.querySelectorAll('.article-card')) {
    if (post.dataset.id !== article.id) continue;
    const open = expanded.has(article.id), button = post.querySelector('[data-action="expand"]');
    post.querySelector('.article-extract').textContent = open ? paragraphText(article) : excerpt(paragraphText(article));
    if (button) {
      button.textContent = open ? 'Read less' : 'Read more';
      button.setAttribute('aria-expanded', String(open));

    }
  }
}
function toggleParagraph(article) {
  if (!article.firstParagraph && !article.sample) return;
  if (expanded.has(article.id)) expanded.delete(article.id);
  else expanded.add(article.id);
  updateParagraph(article);
}
async function hydrateParagraphs(articles) {
  const missing = articles.filter(a => !a.sample && !a.firstParagraph && !paragraphAttempts.has(a.id));
  if (!missing.length) return;
  missing.forEach(a => paragraphAttempts.add(a.id));
  await Promise.allSettled(missing.map(async article => {
    const paragraph = await fetchFirstParagraph(article);
    const current = collection().find(a => a.id === article.id || a.sourceIds?.includes(article.id)) || article;
    current.firstParagraph = paragraph;
    paragraphAttempts.add(current.id);
    if (state.profile.likes[current.id]) {
      state.profile.likes[current.id].firstParagraph = paragraph;
      writeStorage('profile-v1', state.profile);
    }
  }));
  cache();
  if (['home', 'likes', 'explore'].includes(state.page)) renderTimeline();
}
function mentionMarkup(m) {
  return `<div class="mention"><div class="mention-meta"><span class="hn-mini">Y</span><strong>${esc(m.author)}</strong></div><p class="muted">${m.kind === 'comment' ? 'Linked in a comment' : 'Submitted as a story'}</p>${m.storyId ? `<a class="story-title" href="https://news.ycombinator.com/item?id=${encodeURIComponent(m.storyId)}" ${external}>${esc(m.storyTitle)}</a>` : '<p class="muted">Parent thread has not been resolved yet.</p>'}${m.text ? `<blockquote>${esc(m.text)}</blockquote>` : ''}<a class="mention-link" href="https://news.ycombinator.com/item?id=${encodeURIComponent(m.id)}" ${external}>Read original ${m.kind === 'comment' ? 'comment' : 'discussion'} ${icon('external')}</a></div>`;
}
async function context(article, cursor = 0) {
  const stamp = ++generation;
  if (!cursor) showSheet('Hacker News context', `<h3>${esc(article.title)}</h3><div id="mentions">${article.sample ? '<p class="muted">This is a preview article. No HN counts, users, or comments are invented.</p>' : '<p class="muted">Loading original mentions…</p>'}</div>`, article.id);
  if (article.sample) return;
  let payload = article;
  if (state.backend === 'static') {
    try { payload = await catalog.article(article.id, { cursor }); }
    catch { toast('Couldn’t load archive context. Showing cached mentions.'); }
  }
  if (generation !== stamp || !$('#sheet').open || $('#sheet').dataset.id !== article.id) return;
  const markup = `<p class="context-count">${metrics(payload).count.toLocaleString()} linked mentions · ${metrics(payload).people.toLocaleString()} distinct people</p>${(payload.mentions || []).map(mentionMarkup).join('')}${payload.nextCursor != null ? `<button class="secondary-button" data-action="more-context" data-cursor="${payload.nextCursor}">Load earlier mentions</button>` : ''}`;
  if (cursor) { $('#mentions .context-count')?.remove(); $('#mentions [data-action="more-context"]')?.remove(); $('#mentions').insertAdjacentHTML('beforeend', markup); }
  else $('#mentions').innerHTML = markup;
}
function sources() {
  const data = state.archive;
  showSheet('Feed sources & coverage', `<div class="about-content"><h3>From HN to your timeline.</h3><p>This site loads a prebuilt catalogue, a search index and paginated original HN comments. It needs only static file hosting. Hearts, seen posts and personalized ranking stay in your browser.</p><h4>The catalogue</h4><p>${data ? `${data.articles.toLocaleString()} articles and ${data.mentions.toLocaleString()} linked mentions in this snapshot.` : 'No static catalogue is available yet. Run npm run build in the project directory after importing the archive.'}</p><p>Source: <a href="https://huggingface.co/datasets/open-index/hacker-news" ${external}>Open Index HN archive</a>, supplemented by official HN updates during offline data preparation. The snapshot covers the imported data, rather than a claim that every HN item is present.</p><h4>Your For you feed</h4><p>Hearts boost related titles, summaries and Wikipedia categories. “Not interested” downranks similar topics. X hides only that article. For you mixes 80% weighted random discoveries, 10% Rising and 10% Top. Articles linked by fewer than five people appear rarely. The discovery draw favors broader HN interest, especially articles linked by ten or more people, while keeping some room for rare discoveries. Top and Rising picks in For you are shuffled from each ranking’s leading 1,000 articles. Hearts influence discovery order. Home topic lists use the same personalized feed, limited to the selected subject. Browse Topics to open any list and pin favorites to Home. Pins stay saved in this browser. Search contains the Top and Rising pages. Top counts distinct HN linkers across all time; Rising ranks distinct linkers during the six calendar months before the ranking was built.</p><p>Pull to refresh checks for a newly published catalogue and changes the random mix. Static data updates when its owner rebuilds and republishes it. Images and optional fresh Wikipedia summaries load directly from Wikimedia.</p><p class="attribution">Wikipedia text is CC BY-SA; article histories and image pages provide attribution. Independent of X, HN, Wikipedia and the original WikiHack.</p></div>`);
}
function navigate(page) {
  if (state.page === 'home') { homeScroll = scrollY; homeVisible = state.visible; }
  if (page === state.page && page === 'home') { scrollTo(0, 0); return; }
  observer?.disconnect(); state.page = page; state.visible = page === 'home' ? homeVisible : 12;
  activateFeed(page === 'explore' ? state.exploreMode : state.homeMode);
  shell(); scrollTo(0, page === 'home' ? homeScroll : 0);
  if (page === 'explore') $('#search')?.focus({ preventScroll: true });
  ensureFeed();
}
function activateFeed(mode) {
  feeds.select(mode); state.mode = mode;
  state.loading = !state.ready || feeds.tab().loading || state.backend === 'static' && feeds.tab().ids === null;
  state.paused = feeds.tab().cursor === null;
  resetOrder();
}
function ensureFeed() {
  if (state.backend !== 'static') return;
  if (isSearching()) {
    if (state.searchIds === null) searchCatalogue(state.query);
  } else if (isFeedPage() && feeds.tab().ids === null && !feeds.tab().loading) load({ refresh: true });
}
async function hydrate(articles) {
  if (state.page === 'likes') return;
  const missing = articles.filter(a => !a.sample && !a.metadataLoaded && !hydrating.has(a.id)).slice(0, 12);
  if (!missing.length) return;
  missing.forEach(a => hydrating.add(a.id));
  try {
    const enriched = await enrichArticles(missing);
    state.articles = applyEnrichment(state.articles, enriched);
    feeds.canonicalize(enriched);
    for (const article of enriched) for (const id of article.sourceIds || []) {
      if (expanded.delete(id)) expanded.add(article.id);
    }
    for (const article of enriched) state.order = [...new Set(state.order.map(id => article.sourceIds.includes(id) ? article.id : id))];
    const nextProfile = canonicalizeProfile(state.profile, enriched);
    if (JSON.stringify(nextProfile) !== JSON.stringify(state.profile)) persistProfile(nextProfile);
    cache(); if (state.page === 'home' || state.page === 'explore') renderTimeline();
  } catch { /* Original article and HN links remain available. */ }
}
async function load({ refresh = false, preserve = null } = {}) {
  const requestedMode = state.mode;
  if (!refresh && state.loading) return;
  state.loading = true; state.offline = false; observer?.disconnect(); renderMore();
  try {
    let incoming;
    if (state.backend === 'static') {
      const pending = feeds.load(({ mode, cursor }) => catalog.feed({ mode, cursor, mix: state.seed, exclude: [...(refresh ? [] : feeds.tab(mode).ids || []), ...Object.keys(state.profile.seen || {}), ...Object.keys(state.profile.rejected)] }), { mode: requestedMode, reset: refresh });
      renderTimeline();
      const result = await pending;
      if (result.stale) return;
      incoming = result.response.articles;
      state.articles = mergeArticles(state.articles, incoming);
      cache();
      if (!result.current) return;
    } else { state.paused = true; return; }
    state.paused = incoming.length === 0;
    if (preserve) resetOrder(preserve);
    else if (refresh || !state.order.length) resetOrder();
    else resetOrder(state.order);
    cache();
  } catch {
    if (requestedMode === state.mode) {
      state.offline = true;
      if (!state.ready || feeds.tab().ids === null) resetOrder();
      toast('Couldn’t refresh. Your cached collection is available.');
    }
  }
  finally {
    state.loading = state.backend === 'static' ? feeds.tab().loading : false; state.ready = true;
    if (state.page === 'home' || state.page === 'explore') { renderTimeline(); if ($('.source-note')) $('.source-note').outerHTML = sourceNote(); }
  }
}
async function refreshFeed() {
  if (state.page !== 'home' || state.loading || refreshingFeed) return;
  refreshingFeed = true;
  const mode = state.mode;
  state.seed++;
  state.visible = 12;
  try {
    try { const manifest = await catalog.open(); state.archive = manifest.coverage; state.backend = 'static'; } catch { /* Keep the cached collection available offline. */ }
    if (state.page === 'home' && mode === state.mode) await load({ refresh: true });
  } finally { refreshingFeed = false; }
}
async function loadMore() {
  if (isSearching() ? state.searchLoading : state.loading) return;
  if (viewArticles().length > state.visible) { state.visible += 12; renderTimeline(); }
  else if (isFeedPage() && state.backend === 'static') await load();
  else if (isSearching() && state.searchCursor !== null) await searchCatalogue(state.query, state.searchCursor);
}
function selectFeed(mode) {
  const items = state.page === 'home' ? HOME_FEEDS : RANKED_FEEDS;
  if (!items.some(feed => feed.id === mode)) return;
  if (state.page === 'home') state.homeMode = mode;
  else {
    state.exploreMode = mode; state.query = ''; state.searchLoading = false;
    searchTicket++; clearTimeout(searchTimer);
  }
  state.visible = 12; activateFeed(mode);
  shell(); scrollTo(0, 0);
  const tab = $(`#tab-${state.mode}`);
  tab.focus({ preventScroll: true }); tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  ensureFeed();
}
function closeMenus() {
  document.querySelectorAll('.post-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('[data-action="menu"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action], [data-nav], [data-mode]');
  if (!event.target.closest('.menu-wrap')) closeMenus();
  if (!button) {
    const post = event.target.closest('.article-card');
    if (post && !event.defaultPrevented && event.button === 0 &&
        !event.target.closest('a, button, input, textarea, select, [role="button"]') && !window.getSelection()?.toString().trim()) {
      post.querySelector('.article-title').click();
    }
    return;
  }
  if (button.disabled) return;
  if (button.dataset.nav) { navigate(button.dataset.nav); return; }
  if (button.dataset.mode) { selectFeed(button.dataset.mode); return; }
  const action = button.dataset.action, article = findArticle(button);
  if (action === 'menu') {
    const menu = button.parentElement.querySelector('.post-menu'), open = menu.hidden;
    closeMenus(); menu.hidden = !open; button.setAttribute('aria-expanded', open);
    if (open) menu.querySelector('button').focus({ preventScroll: true }); return;
  }
  closeMenus();
  if (action === 'topics') browseTopics();
  else if (action === 'pin-topic') togglePin(button);
  else if (action === 'open-topic' && topicFor(button.dataset.topic)) { closeSheet(); selectFeed(button.dataset.topic); }
  else if (action === 'close') closeSheet();
  else if (action === 'sources') sources();
  else if (action === 'expand' && article) await toggleParagraph(article);
  else if (action === 'context' && article) await context(article);
  else if (action === 'more-context' && article) await context(article, Number(button.dataset.cursor));
  else if (action === 'why' && article) showSheet('Why this post?', `<h3>${esc(article.title)}</h3><p>${esc(isPersonalized(state.mode) ? article.recommendation?.reason || 'Discovered in Hacker News discussions.' : 'This feed is ranked by HN mentions, not your likes.')}</p><p class="muted">Hearts boost similar topics in For you and your topic lists. “Not interested” hides a post and downranks similar recommendations. You can reset this in Settings.</p>`, article.id);
  else if (action === 'like' && article) {
    const isLiked = liked(article);
    if (!persistProfile(feedback(state.profile, article, isLiked ? 'unlike' : 'like'))) return;
    if (state.page === 'home' && isPersonalized(state.mode)) rerankAfter(article); else anchoredRender(article.id);
    if (!isLiked) toast('Liked. You’ll see more related posts in For you.');
    if (state.backend === 'static' && state.page === 'home' && isPersonalized(state.mode) && !isLiked && !state.loading) {
      await load({ refresh: true, preserve: state.order.slice(0, state.order.indexOf(article.id) + 1) });
    }
  } else if (action === 'not-interested' && article) {
    const wasLiked = state.profile.likes[article.id];
    if (!persistProfile(feedback(state.profile, article, 'reject'))) return;
    if (state.page === 'home') rerankAfter(article, true); else renderTimeline();
    toast('You’ll see fewer posts like this.', () => {
      let next = feedback(state.profile, article, 'undo-reject');
      if (wasLiked) next = feedback(next, wasLiked, 'like');
      if (persistProfile(next)) { resetOrder(); renderTimeline(); }
    });
  } else if (action === 'seen' && article) {
    if (!persistProfile(feedback(state.profile, article, 'seen'))) return;
    if (state.page === 'home') rerankAfter(article, true); else renderTimeline();
    toast('Marked as seen. This post won’t appear again.', () => {
      if (persistProfile(feedback(state.profile, article, 'undo-seen'))) { resetOrder(); renderTimeline(); }
    });
  } else if (action === 'undo') { const undo = undoAction; undoAction = null; undo?.(); $('#toast').classList.remove('show'); }
  else if (action === 'more') await loadMore();
  else if (action === 'reset-profile') showSheet('Reset recommendations?', '<p>This removes your hearts and “Not interested” feedback. Seen posts stay hidden.</p><button class="primary-button" data-action="confirm-reset">Reset recommendations</button><button class="secondary-button" data-action="close">Keep my preferences</button>');
  else if (action === 'confirm-reset') { if (persistProfile({ ...emptyProfile(), seen: state.profile.seen || {} })) { resetOrder(); closeSheet(); renderSettings(); toast('Recommendations reset.'); } }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'search') return;
  state.query = event.target.value; state.visible = 12;
  state.searchIds = null; state.searchCursor = null;
  searchTicket++; clearTimeout(searchTimer);
  state.searchLoading = Boolean(state.query.trim() && state.backend === 'static');
  renderTimeline();
  if (state.searchLoading) searchTimer = setTimeout(() => searchCatalogue(state.query), 250);
  else ensureFeed();
});
document.addEventListener('change', event => {
  if (event.target.id === 'images-toggle') { state.settings.images = event.target.checked; writeStorage('settings', state.settings); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMenus();
  if (event.key === '/' && !$('#sheet').open && document.activeElement.tagName !== 'INPUT') { event.preventDefault(); navigate('explore'); }
  if (event.key.toLowerCase() === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey &&
      !$('#sheet').open && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); refreshFeed(); }
  if (event.target.matches('[data-mode]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const tabs = [...document.querySelectorAll('[data-mode]')], index = tabs.indexOf(event.target);
    tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].click();
  }
  const menu = event.target.closest('.post-menu');
  if (menu && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const items = [...menu.querySelectorAll('button')], index = items.indexOf(event.target); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
});
$('#sheet').addEventListener('click', event => { if (event.target === $('#sheet')) closeSheet(); });
$('#sheet').addEventListener('close', () => { generation++; returnFocus?.focus({ preventScroll: true }); });
document.addEventListener('error', event => { if (event.target.tagName === 'IMG') event.target.closest('.article-media')?.remove(); }, true);
window.addEventListener('online', () => { if (state.offline) load({ refresh: true }); });

attachPullRefresh({
  target: document, atTop: () => scrollY <= 0,
  enabled: () => state.page === 'home' && !state.loading && !$('#sheet').open,
  refresh: refreshFeed,
  onState: (phase, distance) => {
    const indicator = $('#pull-refresh');
    const wasRefreshing = pullIsRefreshing();
    indicator.dataset.state = phase;
    indicator.style.setProperty('--pull-distance', `${distance}px`);
    indicator.innerHTML = phase === 'idle' ? '' : `${phase === 'refreshing' ? '<span class="loader" aria-hidden="true"></span>' : icon('arrow', 'pull-arrow')}<span>${phase === 'refreshing' ? 'Refreshing…' : phase === 'armed' ? 'Release to refresh' : 'Pull down to refresh'}</span>`;
    if (phase === 'refreshing' || wasRefreshing) renderTimeline();
  },
});

async function searchCatalogue(query, cursor = 0) {
  const ticket = ++searchTicket;
  state.searchLoading = true; renderTimeline();
  try {
    const response = await catalog.search(query, { cursor });
    state.articles = mergeArticles(state.articles, response.articles);
    if (ticket === searchTicket && state.query === query) {
      state.searchIds = [...new Set([...(cursor ? state.searchIds || [] : []), ...response.articles.map(a => a.id)])];
      state.searchCursor = response.nextCursor;
    }
  } catch { if (ticket === searchTicket && isSearching()) toast('Couldn’t load static search files. Showing cached matches.'); }
  finally {
    if (ticket === searchTicket) {
      state.searchLoading = false;
      if (isSearching()) renderTimeline();
    }
  }
}
async function boot() {
  document.documentElement.dataset.theme = 'dark'; shell();
  try {
    const manifest = await catalog.open();
    state.archive = manifest.coverage; state.backend = 'static';
    await load({ refresh: true });
    if (isSearching()) ensureFeed();
  } catch {
    state.ready = true; state.loading = false; state.paused = true; state.offline = true;
    resetOrder();
    renderPage();
  }
}
boot();
