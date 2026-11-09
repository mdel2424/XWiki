"""Choose the first substantial article image, in rendered reading order."""
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlencode, urlsplit

RULES = json.loads((Path(__file__).resolve().parent.parent / 'src/article-image-rules.json').read_text())
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


def image_url(source):
    if not source:
        return None
    source = 'https:' + source if source.startswith('//') else source
    url = urlsplit(source)
    return source if url.scheme == 'https' and url.hostname in RULES['hosts'] else None


def candidate(attrs, blocked=False):
    if blocked or set(attrs.get('class', '').split()) & set(RULES['blockedClasses']):
        return None
    def dimension(name):
        try:
            return float(attrs.get(name, 0))
        except (TypeError, ValueError):
            return 0
    if 0 < dimension('width') < RULES['minWidth'] or 0 < dimension('height') < RULES['minHeight']:
        return None
    source = image_url(attrs.get('src'))
    if not source:
        return None
    match = re.match(r'^/wikipedia/[^/]+/(?:thumb/)?[^/]+/[^/]+/([^/]+)(?:/|$)', urlsplit(source).path)
    if not match:
        return None
    file = unquote(match[1])
    if any(file.lower().startswith(prefix.lower()) for prefix in RULES['skipFilePrefixes']):
        return None
    return {'source': source, 'file': file}


class ArticleImages(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.first = [], None

    def handle_starttag(self, tag, attrs):
        attrs = {key: value or '' for key, value in attrs}
        blocked = bool(self.stack and self.stack[-1][1]) or bool(set(attrs.get('class', '').split()) & set(RULES['blockedClasses']))
        if tag == 'img' and self.first is None:
            self.first = candidate(attrs, blocked)
        if tag not in VOID:
            self.stack.append((tag, blocked))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break


def first_article_image(html):
    parser = ArticleImages()
    parser.feed(html)
    return parser.first


def fetch_article_image(lang, title, request):
    params = {'action': 'parse', 'format': 'json', 'formatversion': 2, 'page': title,
              'redirects': 1, 'prop': 'text', 'disableeditsection': 1}
    data = request(f'https://{lang}.wikipedia.org/w/api.php?{urlencode(params)}')
    if 'error' in data or not isinstance(data.get('parse', {}).get('text'), str):
        raise ValueError('Article images are unavailable.')
    image = first_article_image(data['parse']['text'])
    if not image:
        return ''
    params = {'action': 'query', 'format': 'json', 'formatversion': 2, 'titles': 'File:' + image['file'],
              'prop': 'imageinfo', 'iiprop': 'url', 'iiurlwidth': 960}
    try:
        data = request(f'https://{lang}.wikipedia.org/w/api.php?{urlencode(params)}')
        for page in data.get('query', {}).get('pages', []):
            for info in page.get('imageinfo', []):
                if image_url(info.get('thumburl')):
                    return info['thumburl']
    except Exception:
        pass  # The article's existing thumbnail is still a usable fallback.
    return image['source']
