// Match the article's subject metadata, rather than incidental words in its body.
export const TOPICS = [
  { id: 'math', label: 'Math', terms: ['math', 'algebra', 'geometr', 'calculus', 'topolog', 'arithmet',
    'statistic', 'probabil', 'combinator', 'theorem', 'number theor', 'formal logic', 'fractal', 'trigonometr'] },
  { id: 'computer-science', label: 'Computer Science', terms: ['computer', 'computing', 'computation',
    'programming', 'algorithm', 'software', 'data structure', 'operating system', 'database', 'cryptograph',
    'machine learning', 'artificial intelligence', 'neural network', 'information theor', 'cybersecur', 'compiler'] },
  { id: 'physics', label: 'Physics', terms: ['physics', 'physicist', 'quantum', 'relativit', 'mechanics',
    'thermodynamic', 'electromagnet', 'cosmolog', 'astronomy', 'astronomer', 'astrophysic', 'gravitat', 'optics', 'photon'] },
];

export const HOME_FEEDS = [{ id: 'for-you', label: 'For you' }, ...TOPICS];
export const RANKED_FEEDS = [{ id: 'top', label: 'Top' }, { id: 'rising', label: 'Rising' }];
export const topicFor = mode => TOPICS.find(topic => topic.id === mode);
export const isPersonalized = mode => HOME_FEEDS.some(feed => feed.id === mode);

const matchers = new Map(TOPICS.map(topic => [topic.id, new RegExp(`\\b(?:${topic.terms.join('|').replaceAll(' ', '\\s+')})`, 'i')]));
export function matchesTopic(article, mode) {
  const matcher = matchers.get(mode);
  return !matcher || matcher.test([article.title, article.description, ...(article.categories || [])].filter(Boolean).join('\n'));
}
