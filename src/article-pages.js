import mainPages from './wiki-main-pages.json' with { type: 'json' };

const normalize = title => String(title || '').normalize('NFKC').replaceAll('_', ' ').replace(/\s+/g, ' ').trim().toLowerCase();
export function isMainPage(article) {
  const title = normalize(article.title);
  return Boolean(title && mainPages.pages[article.lang] && title === normalize(mainPages.pages[article.lang]));
}
