import time
from urllib.parse import quote, urlencode
from .sources import request_json
from .store import merge_metadata, wiki_url


def enrich(db, limit=100, request=request_json, log=print):
    rows = db.execute('''SELECT a.* FROM articles a JOIN stats s ON a.id=s.article_id
        WHERE a.enriched_at<? ORDER BY a.enriched_at,s.people DESC LIMIT ?''', (int(time.time()) - 30 * 86400, limit)).fetchall()
    groups = {}
    for row in rows:
        groups.setdefault(row['lang'], []).append(row)
    for lang, entries in groups.items():
        for start in range(0, len(entries), 20):
            batch = entries[start:start + 20]
            params = {'action': 'query', 'format': 'json', 'formatversion': 2, 'redirects': 1,
                'prop': 'extracts|pageimages|pageterms|categories|links', 'exintro': 1, 'explaintext': 1,
                'exsentences': 5, 'piprop': 'thumbnail', 'pilicense': 'any', 'pithumbsize': 960, 'pilimit': 20,
                'wbptterms': 'description', 'clshow': '!hidden', 'cllimit': 50, 'pllimit': 50, 'plnamespace': 0,
                'titles': '|'.join(row['title'] for row in batch)}
            data = request(f'https://{lang}.wikipedia.org/w/api.php?{urlencode(params)}')
            aliases = {item['from']: item['to'] for item in data.get('query', {}).get('normalized', []) + data.get('query', {}).get('redirects', [])}
            pages = {page['title']: page for page in data.get('query', {}).get('pages', [])}
            with db:
                for row in batch:
                    title, visited = row['title'], set()
                    while title in aliases and title not in visited:
                        visited.add(title)
                        title = aliases[title]
                    page = pages.get(title)
                    if not page or page.get('missing') or page.get('invalid'):
                        continue
                    article = wiki_url(f'https://{lang}.wikipedia.org/wiki/' + quote(title.replace(' ', '_'), safe=''))
                    if not article:
                        continue
                    article.update({'extract': page.get('extract', ''),
                        'description': page.get('terms', {}).get('description', [''])[0],
                        'thumbnail': page.get('thumbnail', {}).get('source', ''),
                        'categories': [c['title'].removeprefix('Category:') for c in page.get('categories', [])],
                        'related': [link['title'] for link in page.get('links', [])],
                        'imageMetadataVersion': 1, 'metadataLoaded': True})
                    merge_metadata(db, row['id'], article)
            log(f'Wikipedia metadata: {lang}, {len(batch)} titles')
            time.sleep(.25)
