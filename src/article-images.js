import rules from './article-image-rules.json' with { type: 'json' };

export const BODY_IMAGE_VERSION = 2;
export function wikimediaImageUrl(source) {
  try {
    const url = new URL(source, 'https://en.wikipedia.org');
    return url.protocol === 'https:' && rules.hosts.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

export function articleImageCandidate(attributes, blocked = false) {
  if (blocked || rules.blockedClasses.some(cls => (attributes.class || '').split(/\s+/).includes(cls))) return null;
  const width = Number(attributes.width), height = Number(attributes.height);
  if (width > 0 && width < rules.minWidth || height > 0 && height < rules.minHeight) return null;
  const source = wikimediaImageUrl(attributes.src);
  if (!source) return null;
  const match = new URL(source).pathname.match(/^\/wikipedia\/[^/]+\/(?:thumb\/)?[^/]+\/[^/]+\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  let file;
  try { file = decodeURIComponent(match[1]); } catch { return null; }
  if (rules.skipFilePrefixes.some(prefix => file.toLowerCase().startsWith(prefix.toLowerCase()))) return null;
  return { source, file };
}

export function firstArticleImage(html) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const root = document.querySelector('.mw-parser-output') || document.body;
  const blocked = rules.blockedClasses.map(cls => `.${cls}`).join(',');
  for (const image of root.querySelectorAll('img')) {
    const candidate = articleImageCandidate(Object.fromEntries([...image.attributes].map(a => [a.name, a.value])), Boolean(image.closest(blocked)));
    if (candidate) return candidate;
  }
  return null;
}

const cache = new Map();
export async function fetchArticleImage(article, { request, parse = firstArticleImage } = {}) {
  if (article.thumbnail) return article;
  if (!/^[a-z][a-z0-9-]{0,24}$/.test(article.lang) || !article.title || article.title.includes('|')) return article;
  if (!(article.imageMetadataVersion >= 1)) {
    const leadParams = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', origin: '*',
      prop: 'pageimages', piprop: 'thumbnail', pilicense: 'any', pithumbsize: '960', redirects: '1', titles: article.title });
    const data = await request(`https://${article.lang}.wikipedia.org/w/api.php?${leadParams}`);
    if (data.error || !data.query?.pages) throw new Error('Article images are unavailable.');
    const thumbnail = data.query.pages.map(page => wikimediaImageUrl(page.thumbnail?.source)).find(Boolean);
    if (thumbnail) return { ...article, thumbnail, thumbnailSource: 'lead', imageMetadataVersion: BODY_IMAGE_VERSION };
  }
  const key = `${article.lang}:${article.title}`;
  if (!cache.has(key)) {
    const pending = (async () => {
      const params = new URLSearchParams({ action: 'parse', format: 'json', formatversion: '2', origin: '*',
        page: article.title, redirects: '1', prop: 'text', disableeditsection: '1' });
      const data = await request(`https://${article.lang}.wikipedia.org/w/api.php?${params}`);
      if (data.error || typeof data.parse?.text !== 'string') throw new Error('Article images are unavailable.');
      const candidate = parse(data.parse.text);
      if (!candidate) return '';
      // Use the file API rather than constructing resized thumbnail URLs.
      try {
        const infoParams = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', origin: '*',
          titles: `File:${candidate.file}`, prop: 'imageinfo', iiprop: 'url', iiurlwidth: '960' });
        const info = await request(`https://${article.lang}.wikipedia.org/w/api.php?${infoParams}`);
        const image = info.query?.pages?.flatMap(page => page.imageinfo || []).find(Boolean);
        return wikimediaImageUrl(image?.thumburl) || candidate.source;
      } catch { return candidate.source; }
    })().catch(error => { cache.delete(key); throw error; });
    cache.set(key, pending);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  const thumbnail = await cache.get(key);
  return { ...article, thumbnail, thumbnailSource: thumbnail ? 'article' : undefined, imageMetadataVersion: BODY_IMAGE_VERSION };
}
