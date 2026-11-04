"""Cache Wikimedia's indexed article-topic predictions for the exported catalogue."""
import argparse
import concurrent.futures
import gzip
import json
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

FAMILIES = ('classification.prediction.articletopic/', 'classification.ores.articletopic/')
USER_AGENT = 'XWiki/0.2 (https://github.com/mdel2424/XWiki; Wikipedia topic index)'


def parse_predictions(documents):
    for family in FAMILIES:
        scores = {}
        for document in documents or []:
            for tag in document.get('source', {}).get('weighted_tags', []):
                if not isinstance(tag, str) or not tag.startswith(family):
                    continue
                topic, separator, score = tag[len(family):].rpartition('|')
                if not separator:
                    continue
                try:
                    probability = int(score) / 1000
                except ValueError:
                    continue
                if topic and 0 <= probability <= 1:
                    scores[topic] = max(scores.get(topic, 0), probability)
        if scores:
            return scores
    return {}


def decode_batch(titles, data):
    if 'error' in data:
        raise RuntimeError(data['error'].get('info', data['error'].get('code', 'Wikipedia API error')))
    query = data.get('query', {})
    aliases = {item['from']: item['to'] for name in ('normalized', 'converted', 'redirects') for item in query.get(name, [])}
    pages = {page['title']: page for page in query.get('pages', [])}
    result = []
    for original in titles:
        canonical, visited = original, set()
        while canonical in aliases and canonical not in visited:
            visited.add(canonical)
            canonical = aliases[canonical]
        page = pages.get(canonical)
        if not page or 'missing' in page or 'invalid' in page:
            result.append((original, canonical, 'missing', {}))
        else:
            scores = parse_predictions(page.get('cirrusdoc'))
            result.append((original, canonical, 'predicted' if scores else 'unscored', scores))
    return result


def open_cache(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('''CREATE TABLE IF NOT EXISTS predictions (
        lang TEXT NOT NULL, title TEXT NOT NULL, canonical TEXT, status TEXT NOT NULL,
        scores TEXT NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY(lang,title))''')
    return db


def collect(catalog='data/catalog', cache='.data/topic-predictions.sqlite', workers=4, rate=4, refresh=False, log=print):
    catalog = Path(catalog)
    manifest = json.loads((catalog / 'manifest.json').read_text())
    root = catalog / manifest['generation']
    db = open_cache(cache)
    known = set() if refresh else set(db.execute('SELECT lang,title FROM predictions'))
    groups = {}
    for file in sorted((root / 'articles').glob('*.json')):
        for article in json.loads(file.read_text()):
            key = (article['lang'], article['title'])
            if key not in known:
                groups.setdefault(key[0], []).append(key[1])
                known.add(key)
    batches = [(lang, titles[i:i + 50]) for lang, titles in groups.items() for i in range(0, len(titles), 50)]
    log(f'Topic predictions: {sum(map(len, groups.values())):,} articles in {len(batches):,} batches; existing cache retained.', flush=True)
    hosts = set()
    if batches:
        request = urllib.request.Request('https://meta.wikimedia.org/w/api.php?action=sitematrix&format=json&smtype=language&smsiteprop=url', headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(request, timeout=45) as response:
            matrix = json.load(response)['sitematrix']
        hosts = {site['url'] for language in matrix.values() if isinstance(language, dict)
                 for site in language.get('site', [])}
    lock, next_request = threading.Lock(), [0.0]
    def fetch(batch):
        lang, titles = batch
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,24}', lang) or f'https://{lang}.wikipedia.org' not in hosts:
            return lang, [(title, title, 'unsupported', {}) for title in titles]
        # A literal pipe is invalid in a MediaWiki title and would split the API list.
        invalid = [(title, title, 'missing', {}) for title in titles if '|' in title]
        titles = [title for title in titles if '|' not in title]
        if not titles:
            return lang, invalid
        params = {'action': 'query', 'prop': 'cirrusdoc', 'cdincludes': 'weighted_tags', 'redirects': 1,
            'converttitles': 1, 'titles': '|'.join(titles), 'format': 'json', 'formatversion': 2,
            'maxlag': 5, 'maxage': 3600, 'smaxage': 3600}
        url = f'https://{lang}.wikipedia.org/w/api.php?{urllib.parse.urlencode(params)}'
        for attempt in range(5):
            try:
                with lock:
                    delay = max(0, next_request[0] - time.monotonic())
                    next_request[0] = max(next_request[0], time.monotonic()) + 1 / rate
                if delay:
                    time.sleep(delay)
                request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip'})
                with urllib.request.urlopen(request, timeout=45) as response:
                    body = response.read()
                    if response.headers.get('Content-Encoding') == 'gzip':
                        body = gzip.decompress(body)
                data = json.loads(body)
                if data.get('error', {}).get('code') in ('maxlag', 'ratelimited', 'readonly'):
                    raise RuntimeError(data['error']['code'])
                return lang, invalid + decode_batch(titles, data)
            except urllib.error.HTTPError as error:
                if error.code in (400, 404, 410):
                    return lang, [(title, title, 'unsupported', {}) for title in titles]
                if attempt == 4:
                    raise
                time.sleep(min(60, 2 ** (attempt + 1)))
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(min(60, 2 ** (attempt + 1)))
    completed, failures, started = 0, 0, time.monotonic()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(fetch, batch): batch for batch in batches}
            for future in concurrent.futures.as_completed(futures):
                try:
                    lang, results = future.result()
                    now = int(time.time())
                    with db:
                        db.executemany('INSERT OR REPLACE INTO predictions VALUES (?,?,?,?,?,?)',
                            [(lang, title, canonical, status, json.dumps(scores, separators=(',', ':')), now)
                             for title, canonical, status, scores in results])
                except Exception as error:
                    failures += 1
                    log(f'Topic prediction batch failed ({futures[future][0]}): {error}', flush=True)
                completed += 1
                if completed % 100 == 0 or completed == len(batches):
                    log(f'Topic predictions: {completed:,}/{len(batches):,} batches; {failures} failed; {time.monotonic()-started:.0f}s.', flush=True)
    finally:
        db.close()
    if failures:
        raise RuntimeError(f'{failures} batches failed. Successful batches are cached; rerun to resume.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', default='data/catalog')
    parser.add_argument('--cache', default='.data/topic-predictions.sqlite')
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--rate', type=float, default=4)
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.workers <= 8 or not 0 < args.rate <= 5:
        parser.error('Use 1-8 workers and at most five requests per second.')
    collect(args.catalog, args.cache, args.workers, args.rate, args.refresh)

if __name__ == '__main__':
    main()
