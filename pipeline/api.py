"""Bounded read API invoked by the local web server; no arbitrary SQL is accepted."""
import argparse
import json
from urllib.parse import parse_qs, unquote, urlsplit
from .store import article_payload, connect, feed, status


def route(db, raw_url):
    url = urlsplit(raw_url)
    query = parse_qs(url.query)
    one = lambda name, default='': query.get(name, [default])[0]
    if url.path == '/api/status':
        value = status(db)
        value['gapRangeCount'] = len(value['gaps'])
        value['gaps'] = value['gaps'][:100]
        return 200, value
    if url.path == '/api/feed':
        mode = one('mode', 'for-you')
        if mode not in ('for-you', 'top', 'rising', 'random'):
            return 400, {'error': 'Unknown feed mode.'}
        limit, cursor = int(one('limit', '60')), int(one('cursor', '0'))
        if not 1 <= limit <= 100 or not 0 <= cursor <= 10000000:
            return 400, {'error': 'Invalid pagination.'}
        mix = int(one('mix', '0'))
        if not 0 <= mix <= 2147483647:
            return 400, {'error': 'Invalid discovery seed.'}
        return 200, feed(db, mode, limit, cursor, one('q')[:200], query.get('seed', [])[:12], mix_seed=mix)
    if url.path.startswith('/api/articles/'):
        article_id = unquote(url.path[len('/api/articles/'):])
        alias = db.execute('SELECT canonical FROM aliases WHERE alias=?', (article_id,)).fetchone()
        row = db.execute('SELECT * FROM articles WHERE id=?', (alias[0] if alias else article_id,)).fetchone()
        if not row:
            return 404, {'error': 'Article not found.'}
        cursor = int(one('cursor', '0'))
        if cursor < 0:
            return 400, {'error': 'Invalid pagination.'}
        payload = article_payload(db, row, context_limit=50, context_offset=cursor)
        count = payload.get('metrics', {}).get('mentionCount', 0)
        payload['nextCursor'] = cursor + len(payload['mentions']) if cursor + len(payload['mentions']) < count else None
        return 200, payload
    return 404, {'error': 'Unknown API endpoint.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default='.data/wikihack.sqlite')
    parser.add_argument('--url', required=True)
    args = parser.parse_args()
    db = connect(args.db, readonly=True)
    try:
        try:
            code, body = route(db, args.url)
        except (ValueError, TypeError):
            code, body = 400, {'error': 'Invalid request parameters.'}
        print(json.dumps({'status': code, 'body': body}))
    finally:
        db.close()
