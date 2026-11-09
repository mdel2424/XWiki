"""Validate leading Wikipedia candidates against sustained, recent article readership."""
import concurrent.futures
import json
import statistics
import time
import threading
import urllib.parse
from pathlib import Path
from .wikipedia import articles, cache_db, payload, request_json


def sustained_views(pageviews):
    values = [v for v in (pageviews or {}).values() if isinstance(v, int) and not isinstance(v, bool) and v >= 0]
    return (statistics.median(values) if len(values) >= 14 else None), len(values)


def audit(catalog='data/catalog', cache='.data/wikipedia-popularity.sqlite'):
    catalog = Path(catalog)
    manifest = json.loads((catalog / 'manifest.json').read_text())
    db = cache_db(cache)
    cards = {a['_index']: a for a in articles(catalog, manifest)}
    topics = json.loads((catalog / manifest['generation'] / manifest['topicIndex']['path']).read_text())['topics']
    topic_sets = [set(indices) for indices in topics.values()]
    known = {(lang, title) for lang, title, at in db.execute('SELECT lang,title,checked_at FROM verified_readership') if at >= time.time() - 7 * 86400}
    def key(i):
        article = cards[i]
        row = db.execute('SELECT canonical FROM popularity WHERE lang=? AND title=?', (article['lang'], article['title'])).fetchone()
        return article['lang'], row[0] if row else article['title']
    lock, scheduled = threading.Lock(), [0.0]
    def fetch(batch):
        lang, titles = batch
        params = {'action': 'query', 'format': 'json', 'formatversion': 2, 'redirects': 1, 'prop': 'pageviews', 'pvipdays': 30, 'titles': '|'.join(titles)}
        for attempt in range(3):
            try:
                with lock:
                    delay = max(0, scheduled[0] - time.monotonic())
                    scheduled[0] = max(scheduled[0], time.monotonic()) + 1 / 3
                if delay:
                    time.sleep(delay)
                data = request_json(f'https://{lang}.wikipedia.org/w/api.php?' + urllib.parse.urlencode(params))
                if 'error' in data or 'continue' in data:
                    raise RuntimeError('Incomplete Wikipedia readership response')
                query = data.get('query', {})
                aliases = {a['from']: a['to'] for name in ['normalized', 'redirects'] for a in query.get(name, [])}
                pages = {p['title']: p for p in query.get('pages', [])}
                rows = []
                for title in titles:
                    canonical, seen = title, set()
                    while canonical in aliases and canonical not in seen:
                        seen.add(canonical); canonical = aliases[canonical]
                    score, days = sustained_views(pages.get(canonical, {}).get('pageviews'))
                    rows.append((lang, title, score, days, int(time.time())))
                return rows
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2 ** (attempt + 1))
    try:
        for iteration in range(20):
            data = payload(catalog, manifest, cache)
            redirects = data['redirects']
            allowed = [{redirects.get(str(i), i) for i in indices} for indices in topic_sets]
            wanted = set(data['order'][:500 if iteration == 0 else 120])
            for group in allowed:
                wanted.update([i for i in data['order'] if i in group][:40 if iteration == 0 else 12])
            missing = {key(i) for i in wanted} - known
            if not missing:
                print('Wikipedia audit: leading Home and topic rankings are verified.', flush=True)
                return
            groups = {}
            for lang, title in sorted(missing):
                groups.setdefault(lang, []).append(title)
            batches = [(lang, titles[i:i + 20]) for lang, titles in groups.items() for i in range(0, len(titles), 20)]
            print(f'Wikipedia audit pass {iteration + 1}: checking {len(missing)} candidates in {len(batches)} batches.', flush=True)
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                futures = [pool.submit(fetch, batch) for batch in batches]
                for future in concurrent.futures.as_completed(futures):
                    rows = future.result()
                    with db:
                        db.executemany('INSERT OR REPLACE INTO verified_readership VALUES (?,?,?,?,?)', rows)
                    known.update((row[0], row[1]) for row in rows)
            time.sleep(.5)
        raise RuntimeError('Audit frontier has not stabilized; rerun to continue cached validation.')
    finally:
        db.close()
