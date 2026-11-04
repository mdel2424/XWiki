import definitions from './topic-definitions.json' with { type: 'json' };

export const TOPICS = definitions;
export const TOPIC_THRESHOLD = 0.5;
export const TOPIC_ALIASES = { 'computer-science': 'computing', physics: 'science', psychology: 'society', 'arts-culture': 'arts' };
export const canonicalTopic = id => TOPIC_ALIASES[id] || id;

export const HOME_FEEDS = [{ id: 'for-you', label: 'For you' }, ...TOPICS];
export const RANKED_FEEDS = [{ id: 'top', label: 'Top' }, { id: 'rising', label: 'Rising' }];
export const topicFor = mode => TOPICS.find(topic => topic.id === canonicalTopic(mode));
export const isPersonalized = mode => HOME_FEEDS.some(feed => feed.id === canonicalTopic(mode));

export const DEFAULT_PINS = ['computing', 'science', 'history'];
export const DEFAULT_TOPIC_ORDER = [...TOPICS].sort((a, b) => a.label.localeCompare(b.label, 'en')).map(topic => topic.id);
export function normalizeTopicOrder(value) {
  const saved = Array.isArray(value) ? [...new Set(value.map(canonicalTopic).filter(id => topicFor(id)))] : [];
  return [...saved, ...DEFAULT_TOPIC_ORDER.filter(id => !saved.includes(id))];
}
export function moveTopic(order, id, index) {
  id = canonicalTopic(id);
  const ids = normalizeTopicOrder(order);
  if (!ids.includes(id)) return ids;
  ids.splice(ids.indexOf(id), 1);
  ids.splice(Math.max(0, Math.min(ids.length, index)), 0, id);
  return ids;
}
export function normalizePins(value) {
  return Array.isArray(value) ? [...new Set(value.map(canonicalTopic).filter(id => topicFor(id)))] : [...DEFAULT_PINS];
}
export function homeFeeds(pins, active = 'for-you', order = null) {
  active = canonicalTopic(active);
  let ids = normalizePins(pins);
  if (order) ids = normalizeTopicOrder(order).filter(id => ids.includes(id));
  // An unpinned topic can be opened without silently pinning it.
  if (topicFor(active) && !ids.includes(active)) ids.push(active);
  return [HOME_FEEDS[0], ...ids.map(topicFor)];
}

const normalizeModel = value => value.replaceAll('_', ' ').toLowerCase();
export function predictionTopics(predictions) {
  if (!predictions || typeof predictions !== 'object' || Array.isArray(predictions)) return [];
  const accepted = Object.entries(predictions).filter(([label, score]) => typeof score === 'number' && Number.isFinite(score) && score >= TOPIC_THRESHOLD && score <= 1).map(([label]) => normalizeModel(label));
  return TOPICS.filter(topic => topic.models.some(pattern => accepted.some(label => {
    const model = normalizeModel(pattern);
    return model.endsWith('.') ? label.startsWith(model) : label === model;
  }))).map(topic => topic.id);
}
export function matchesTopic(article, mode) {
  const topic = topicFor(mode);
  if (!topic) return true;
  // Unclassified articles stay in For you; neither titles nor categories imply membership.
  return (article.topics || []).map(canonicalTopic).includes(topic.id) || predictionTopics(article.topicPredictions).includes(topic.id);
}
