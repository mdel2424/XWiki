"""Publish Wikipedia's native pageview popularity ranking for the exported archive."""
import argparse
import concurrent.futures
import gzip
import hashlib
import json
import math
import os
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
from collections import Counter
from pathlib import Path
from .article_pages import is_main_page

SOURCE = {'kind': 'wikimedia-popularity', 'field': 'popularity_score', 'metric': 'traffic-adjusted-pageview-share',
          'url': 'https://www.mediawiki.org/wiki/Extension:CirrusSearch/Schema#popularity_score',
          'normalization': 'mean-project-pageviews', 'normalizationDays': 30,
          'normalizationUrl': 'https://www.mediawiki.org/wiki/Extension:PageViewInfo#meta=siteviews_(pvis)'}
USER_AGENT = 'xWiki/0.2 (https://github.com/mdel2424/XWiki; Wikipedia popularity ranking)'


def cache_db(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('''CREATE TABLE IF NOT EXISTS popularity (
        lang TEXT NOT NULL, title TEXT NOT NULL, canonical TEXT, status TEXT NOT NULL,
        score REAL, checked_at INTEGER NOT NULL, PRIMARY KEY(lang,title))''')
    db.execute('''CREATE TABLE IF NOT EXISTS project_traffic (
        lang TEXT PRIMARY KEY, daily_views REAL, days INTEGER NOT NULL,
        first_day TEXT, last_day TEXT, checked_at INTEGER NOT NULL)''')
    db.execute('''CREATE TABLE IF NOT EXISTS verified_readership (
        lang TEXT NOT NULL, title TEXT NOT NULL, score REAL, days INTEGER NOT NULL,
        checked_at INTEGER NOT NULL, PRIMARY KEY(lang,title))''')
    return db


def articles(catalog, manifest):
    for file in sorted((Path(catalog) / manifest['generation'] / 'articles').glob('*.json')):
        yield from json.loads(file.read_text())


def valid_score(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def decode(titles, data, checked_at):
    if 'error' in data:
        raise RuntimeError(data['error'].get('info', data['error'].get('code', 'Wikipedia error')))
    query = data.get('query', {})
    aliases = {a['from']: a['to'] for name in ('normalized', 'converted', 'redirects') for a in query.get(name, [])}
    pages = {p['title']: p for p in query.get('pages', [])}
    result = []
    for title in titles:
        canonical, seen = title, set()
        while canonical in aliases and canonical not in seen:
            seen.add(canonical)
            canonical = aliases[canonical]
        page = pages.get(canonical)
        values = [doc.get('source', {}).get('popularity_score') for doc in (page or {}).get('cirrusdoc', [])]
        score = next((value for value in values if valid_score(value)), None)
        status = 'missing' if not page or 'missing' in page or 'invalid' in page else 'scored' if score is not None else 'unavailable'
        result.append((title, canonical, status, score if status == 'scored' else None, checked_at))
    return result


def request_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                body = response.read()
                if response.headers.get('Content-Encoding') == 'gzip':
                    body = gzip.decompress(body)
            return json.loads(body)
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 2:
                raise
            try:
                delay = float(error.headers.get('Retry-After', 15))
            except ValueError:
                delay = 15
            time.sleep(max(1, min(60, delay)))


def collect_traffic(catalog='data/catalog', cache='.data/wikipedia-popularity.sqlite', refresh=False):
    """Convert per-wiki view shares to comparable readership across language editions."""
    manifest = json.loads((Path(catalog) / 'manifest.json').read_text())
    db = cache_db(cache)
    known = set() if refresh else {row[0] for row in db.execute('SELECT lang FROM project_traffic')}
    languages = sorted({article['lang'] for article in articles(catalog, manifest)} - known)
    if not languages:
        db.close()
        return
    matrix = request_json('https://meta.wikimedia.org/w/api.php?action=sitematrix&format=json&smtype=language&smsiteprop=url')['sitematrix']
    hosts = {site['url'] for item in matrix.values() if isinstance(item, dict) for site in item.get('site', [])}
    lock, scheduled = threading.Lock(), [0.0]
    def fetch(lang):
        values = {}
        if f'https://{lang}.wikipedia.org' in hosts:
            for attempt in range(3):
                try:
                    with lock:
                        delay = max(0, scheduled[0] - time.monotonic())
                        scheduled[0] = max(scheduled[0], time.monotonic()) + 2
                    if delay:
                        time.sleep(delay)
                    data = request_json(f'https://{lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&meta=siteviews&pvisdays=30')
                    if 'error' in data:
                        raise RuntimeError(data['error'])
                    values = {day: value for day, value in data.get('query', {}).get('siteviews', {}).items() if valid_score(value)}
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(2 ** (attempt + 1))
        dates = sorted(values)
        return (lang, sum(values.values()) / len(values) if len(values) >= 7 else None, len(values),
                dates[0] if dates else None, dates[-1] if dates else None, int(time.time()))
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for row in pool.map(fetch, languages):
                with db:
                    db.execute('INSERT OR REPLACE INTO project_traffic VALUES (?,?,?,?,?,?)', row)
        print(f'Wikipedia traffic: {len(languages)} language editions checked.', flush=True)
    finally:
        db.close()


def collect(catalog='data/catalog', cache='.data/wikipedia-popularity.sqlite', refresh=False, workers=8, rate=4):
    collect_traffic(catalog, cache, refresh)
    manifest = json.loads((Path(catalog) / 'manifest.json').read_text())
    db = cache_db(cache)
    known = set() if refresh else set(db.execute('SELECT lang,title FROM popularity'))
    groups = {}
    for article in articles(catalog, manifest):
        key = article['lang'], article['title']
        if key not in known:
            groups.setdefault(key[0], []).append(key[1])
            known.add(key)
    batches = [(lang, titles[i:i + 50]) for lang, titles in groups.items() for i in range(0, len(titles), 50)]
    print(f'Wikipedia popularity: {sum(map(len, groups.values())):,} entries in {len(batches):,} batches; cached results retained.', flush=True)
    hosts = set()
    if batches:
        matrix = request_json('https://meta.wikimedia.org/w/api.php?action=sitematrix&format=json&smtype=language&smsiteprop=url')['sitematrix']
        hosts = {site['url'] for item in matrix.values() if isinstance(item, dict) for site in item.get('site', [])}
    lock, scheduled = threading.Lock(), [0.0]
    def fetch(batch):
        lang, titles = batch
        now = int(time.time())
        if f'https://{lang}.wikipedia.org' not in hosts:
            return lang, [(title, title, 'unsupported', None, now) for title in titles]
        invalid = [(title, title, 'missing', None, now) for title in titles if '|' in title]
        titles = [title for title in titles if '|' not in title]
        if not titles:
            return lang, invalid
        params = {'action': 'query', 'format': 'json', 'formatversion': 2, 'redirects': 1,
                  'converttitles': 1, 'prop': 'cirrusdoc', 'cdincludes': 'popularity_score', 'maxlag': 5, 'titles': '|'.join(titles)}
        for attempt in range(5):
            try:
                with lock:
                    delay = max(0, scheduled[0] - time.monotonic())
                    scheduled[0] = max(scheduled[0], time.monotonic()) + 1 / rate
                if delay:
                    time.sleep(delay)
                data = request_json(f'https://{lang}.wikipedia.org/w/api.php?' + urllib.parse.urlencode(params))
                if 'continue' in data:
                    raise RuntimeError('Incomplete popularity batch; refusing to cache truncated results.')
                return lang, invalid + decode(titles, data, int(time.time()))
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** (attempt + 1))
    failures, started = 0, time.monotonic()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(fetch, batch): batch for batch in batches}
            for completed, future in enumerate(concurrent.futures.as_completed(futures), 1):
                try:
                    lang, rows = future.result()
                    with db:
                        db.executemany('INSERT OR REPLACE INTO popularity VALUES (?,?,?,?,?,?)', [(lang, *row) for row in rows])
                except Exception as error:
                    failures += 1
                    print(f'Wikipedia popularity batch failed ({futures[future][0]}): {error}', flush=True)
                if completed % 100 == 0 or completed == len(batches):
                    print(f'Wikipedia popularity: {completed:,}/{len(batches):,} batches; {failures} failed; {time.monotonic()-started:.0f}s.', flush=True)
    finally:
        db.close()
    if failures:
        raise RuntimeError(f'{failures} failed batches; rerun to resume from the cache.')


def payload(catalog, manifest, cache=None):
    count = manifest['articleCount']
    scores, seen = [None] * count, set()
    canonical, originals, original_keys = {}, {}, {}
    coverage = Counter(articles=count, checked=0, scored=0, unavailable=0, missing=0, unsupported=0, notChecked=0)
    checked_at = manifest['generatedAt']
    db = sqlite3.connect(f'file:{Path(cache).resolve()}?mode=ro', uri=True) if cache and Path(cache).is_file() else None
    traffic, verified = {}, {}
    try:
        if db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='verified_readership'").fetchone():
                verified = {(lang, title): (value, at) for lang, title, value, days, at in db.execute('SELECT * FROM verified_readership')
                            if at >= time.time() - 7 * 86400 and (value is None or valid_score(value))}
            for lang, daily, days, first, last, at in db.execute('SELECT * FROM project_traffic'):
                traffic[lang] = {'dailyViews': daily, 'days': days, 'firstDay': first, 'lastDay': last, 'checkedAt': at}
                checked_at = max(checked_at, at)
        for article in articles(catalog, manifest):
            i = article['_index']
            if not isinstance(i, int) or not 0 <= i < count or i in seen:
                raise ValueError('Invalid article order; Wikipedia ranking not published.')
            seen.add(i)
            key = article['lang'], article['title']
            originals[key] = i
            original_keys[i] = key
            canonical[i] = key
            value, status = article.get('wikipediaPopularity'), 'notChecked'
            if valid_score(value):
                scores[i], status = value, 'scored'
            elif db:
                row = db.execute('SELECT status,score,checked_at,canonical FROM popularity WHERE lang=? AND title=?', key).fetchone()
                if row:
                    status, value, at, title = row
                    canonical[i] = article['lang'], title
                    if status not in ('scored', 'unavailable', 'missing', 'unsupported') or status == 'scored' and not valid_score(value):
                        raise ValueError('Invalid cached Wikipedia popularity.')
                    if status == 'scored':
                        project = traffic.get(article['lang'])
                        if project is None:
                            raise ValueError('Missing project traffic; rerun the Wikipedia collector before publishing.')
                        if valid_score(project['dailyViews']):
                            scores[i] = value * project['dailyViews']
                        else:
                            status = 'unavailable'
                    checked_at = max(checked_at, at)
            coverage[status] += 1
            coverage['checked'] += status != 'notChecked'
    finally:
        if db:
            db.close()
    if len(seen) != count:
        raise ValueError('Incomplete catalogue; Wikipedia ranking not published.')
    groups = {}
    for i, key in canonical.items():
        groups.setdefault(key, []).append(i)
    redirects, representatives, excluded, reviewed = {}, [], [], []
    for key, members in groups.items():
        if is_main_page(*key) or any(is_main_page(*original_keys[i]) for i in members):
            excluded.extend(members)
            continue
        candidate = originals.get(key)
        representative = candidate if candidate in members else min(members)
        # The canonical title is preferred when it exists in this archive.
        # Its score can be supplied by any redirect checked during this snapshot.
        values = [scores[i] for i in members if scores[i] is not None]
        scores[representative] = max(values) if values else None
        if key in verified:
            scores[representative], at = verified[key]
            reviewed.append(representative)
            checked_at = max(checked_at, at)
        representatives.append(representative)
        redirects.update({str(i): representative for i in members if i != representative})
    order = sorted(representatives, key=lambda i: (scores[i] is None, -(scores[i] or 0), i))
    coverage.update(ranked=len(order), redirects=len(redirects), excluded=len(excluded), reviewed=len(reviewed))
    return {'kind': 'xwiki-wikipedia-index', 'version': 1, 'generation': manifest['generation'],
            'generatedAt': checked_at, 'source': SOURCE, 'coverage': dict(coverage),
            'projectTraffic': traffic, 'scores': scores, 'order': order, 'redirects': redirects, 'excluded': sorted(excluded),
            'reviewed': sorted(reviewed), 'reviewMetric': 'median-daily-pageviews', 'reviewWindowDays': 30,
            'excludedIds': [f'{original_keys[i][0]}:{original_keys[i][1]}' for i in sorted(excluded)]}


def index_metadata(data):
    encoded = json.dumps(data, separators=(',', ':')).encode()
    metadata = {'path': f'wikipedia-{hashlib.sha256(encoded).hexdigest()[:16]}.json', 'version': 1,
                'source': SOURCE, 'coverage': data['coverage'], 'generatedAt': data['generatedAt'],
                'review': {'metric': data['reviewMetric'], 'windowDays': data['reviewWindowDays'], 'articles': len(data['reviewed'])},
                'excluded': data['excluded'], 'excludedIds': data['excludedIds']}
    return encoded, metadata


def publish(catalog='data/catalog', cache='.data/wikipedia-popularity.sqlite'):
    catalog = Path(catalog)
    manifest_file = catalog / 'manifest.json'
    original = manifest_file.read_bytes()
    manifest = json.loads(original)
    if manifest.get('kind') != 'wikihack-static' or not manifest.get('articleCount'):
        raise ValueError('Expected a complete xWiki catalogue.')
    data = payload(catalog, manifest, cache)
    if data['coverage']['notChecked']:
        raise ValueError('Wikipedia popularity collection is incomplete; rerun to resume before publishing.')
    encoded, metadata = index_metadata(data)
    file = catalog / manifest['generation'] / metadata['path']
    temporary = file.with_suffix('.tmp')
    temporary.write_bytes(encoded)
    os.replace(temporary, file)
    if manifest_file.read_bytes() != original:
        raise ValueError('Catalogue changed during Wikipedia indexing; rerun publication.')
    manifest['wikipediaIndex'] = metadata
    files = list((catalog / manifest['generation']).rglob('*.json'))
    manifest.update(dataFiles=len(files), dataBytes=sum(f.stat().st_size for f in files))
    temporary = manifest_file.with_suffix('.wikipedia.tmp')
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')))
    os.replace(temporary, manifest_file)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', default='data/catalog')
    parser.add_argument('--cache', default='.data/wikipedia-popularity.sqlite')
    parser.add_argument('--export-only', action='store_true')
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--audit-only', action='store_true')
    args = parser.parse_args()
    if not args.export_only and not args.audit_only:
        collect(args.catalog, args.cache, args.refresh)
    if not args.export_only:
        from .wiki_audit import audit
        audit(args.catalog, args.cache)
    print(json.dumps(publish(args.catalog, args.cache), indent=2))

if __name__ == '__main__':
    main()
