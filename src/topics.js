// Match the article's subject metadata, rather than incidental words in its body.
export const TOPICS = [
  { id: 'math', label: 'Math', description: 'Algebra, geometry, probability and proofs', terms: ['math', 'mathemat', 'algebra', 'geometr', 'calculus', 'topolog', 'arithmet',
    'statistic', 'probabil', 'combinator', 'theorem', 'number theor', 'formal logic', 'fractal', 'trigonometr'] },
  { id: 'computer-science', label: 'Computer Science', description: 'Algorithms, software and computing', terms: ['computer', 'computing', 'computation',
    'programming', 'algorithm', 'software', 'data structure', 'operating system', 'database', 'cryptograph',
    'machine learning', 'artificial intelligence', 'neural network', 'information theor', 'cybersecur', 'compiler'] },
  { id: 'physics', label: 'Physics', description: 'Matter, energy, space and the universe', terms: ['physics', 'physicist', 'quantum', 'relativit', 'mechanics',
    'thermodynamic', 'electromagnet', 'cosmolog', 'astronomy', 'astronomer', 'astrophysic', 'gravitat', 'optics', 'photon'] },
  { id: 'philosophy', label: 'Philosophy', description: 'Ethics, logic and political thought',
    terms: ['philosoph', 'ethic', 'epistemolog', 'metaphysic', 'ontolog', 'existential', 'phenomenolog',
      'aesthetics', 'stoic', 'moral', 'political thought', 'logic'] },
  { id: 'history', label: 'History', description: 'Civilizations, archaeology and history of ideas',
    terms: ['histor', 'archaeolog', 'ancient', 'medieval', 'civilization', 'civilisation', 'dynasty',
      'empire', 'world war', 'renaissance', 'antiquity', 'historiograph'] },
  { id: 'biology', label: 'Biology', description: 'Evolution, genetics and the living world',
    terms: ['biolog', 'evolution', 'genetic', 'neuroscien', 'ecolog', 'biochem', 'botan', 'zoolog',
      'microbiolog', 'organism', 'physiolog', 'anatom', 'species'] },
  { id: 'psychology', label: 'Psychology', description: 'Cognition, behavior and decision-making',
    terms: ['psycholog', 'cognit', 'perception', 'behavioral', 'behavioural', 'decision making',
      'mental process', 'psychotherap', 'psychiatr', 'personality', 'emotion', 'consciousness'] },
  { id: 'economics', label: 'Economics', description: 'Markets, incentives and institutions',
    terms: ['econom', 'macroeconom', 'microeconom', 'finance', 'monetary', 'fiscal', 'game theor', 'incentive', 'inflation',
      'banking', 'capitalism', 'market structure'] },
  { id: 'engineering', label: 'Engineering', description: 'Machines, infrastructure and electronics',
    terms: ['engineer', 'mechanical', 'electrical', 'infrastructure', 'robotic', 'control system',
      'manufactur', 'aerospac', 'power generation', 'electronic', 'semiconductor', 'construction', 'turbine'] },
  { id: 'arts-culture', label: 'Arts & Culture', description: 'Literature, music, architecture and film',
    terms: ['art', 'music', 'literatur', 'architectur', 'cinema', 'film', 'theatre', 'theater',
      'paint', 'sculpt', 'poetry', 'novel', 'cultural', 'folklore', 'dance', 'design'] },
];

export const HOME_FEEDS = [{ id: 'for-you', label: 'For you' }, ...TOPICS];
export const RANKED_FEEDS = [{ id: 'top', label: 'Top' }, { id: 'rising', label: 'Rising' }];
export const topicFor = mode => TOPICS.find(topic => topic.id === mode);
export const isPersonalized = mode => HOME_FEEDS.some(feed => feed.id === mode);

export const EXACT_TOPIC_TERMS = ['art', 'math'];
export const DEFAULT_PINS = ['math', 'computer-science', 'physics'];
export function normalizePins(value) {
  return Array.isArray(value) ? [...new Set(value.filter(id => topicFor(id)))] : [...DEFAULT_PINS];
}
export function homeFeeds(pins, active = 'for-you') {
  const ids = normalizePins(pins);
  // An unpinned topic can be opened without silently pinning it.
  if (topicFor(active) && !ids.includes(active)) ids.push(active);
  return [HOME_FEEDS[0], ...ids.map(topicFor)];
}

const matchers = new Map(TOPICS.map(topic => [topic.id, new RegExp(`\\b(?:${topic.terms.map(term =>
  term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+') + (EXACT_TOPIC_TERMS.includes(term) ? '\\b' : '')
).join('|')})`, 'i')]));
export function matchesTopic(article, mode) {
  const matcher = matchers.get(mode);
  return !matcher || matcher.test([article.title, article.description, ...(article.categories || [])].filter(Boolean).join('\n'));
}
