import hashlib
import html
import json
import re
import sqlite3
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

YEAR = 365 * 86400
NAMESPACES = re.compile(r'^(special|talk|user|user talk|wikipedia|wikipedia talk|file|file talk|mediawiki|template|template talk|help|category|portal|draft|module|book|timedtext|media):', re.I)
TYPE_NAMES = {1: 'story', 2: 'comment', 3: 'poll', 4: 'pollopt', 5: 'job'}


def plain_text(value):
    return html.unescape(re.sub(r'<[^>]*>', '', re.sub(r'<(?:p\b[^>]*|br\s*/?)>', '\n', value or '', flags=re.I))).strip()


def wiki_url(raw):
    try:
        url = urlsplit(html.unescape(raw))
        host = re.fullmatch(r'([a-z]{2,12}(?:-[a-z]+)?)(?:\.m)?\.wikipedia\.org', url.hostname or '', re.I)
        if url.scheme not in ('http', 'https') or not host or host[1] in ('www', 'meta', 'commons'):
            return None
        encoded_title = url.path[6:] if url.path.startswith('/wiki/') else None
        if encoded_title is not None and re.search(r'%(?![0-9a-fA-F]{2})', encoded_title):
            return None
        title = unquote(encoded_title, errors='strict') if encoded_title is not None else (
            parse_qs(url.query).get('title', [''])[0] if url.path == '/w/index.php' else '')
        import unicodedata
        title = unicodedata.normalize('NFC', re.sub(r'\s+', ' ', title.replace('_', ' ')).strip())
        if not title or NAMESPACES.match(title) or title == 'Main Page':
            return None
        title = title[0].upper() + title[1:]
        lang = host[1].lower()
        return {'id': f'{lang}:{title}', 'lang': lang, 'title': title,
                'url': f'https://{lang}.wikipedia.org/wiki/{quote(title.replace(" ", "_"), safe="")}' }
    except (ValueError, UnicodeError):
        return None


def extract_articles(row):
    text = row.get('text') or ''
    if 'wikipedia.org' not in ((row.get('url') or '') + ' ' + text).lower():
        return []
    urls = [row.get('url') or '']
    urls += re.findall(r'''href\s*=\s*["']([^"']+)["']''', text, re.I)
    urls += re.findall(r'''https?://[^\s<>"']+''', text, re.I)
    articles = {}
    for raw in urls:
        article = wiki_url(raw)
        if article:
            articles[article['id']] = article
    return list(articles.values())


def timestamp(value):
    if value is None:
        return 0
    if hasattr(value, 'timestamp'):
        # HF timestamps without a zone represent UTC, independent of the host timezone.
        from datetime import timezone
        return int(value.replace(tzinfo=value.tzinfo or timezone.utc).timestamp())
    if isinstance(value, str) and not value.isdigit():
        from datetime import datetime, timezone
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return int(parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp())
    return int(value)


def connect(file, readonly=False):
    if readonly and Path(file).is_file():
        db = sqlite3.connect(Path(file).resolve().as_uri() + '?mode=ro', uri=True, timeout=60)
        db.row_factory = sqlite3.Row
        return db
    Path(file).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(file, timeout=60)
    db.row_factory = sqlite3.Row
    db.executescript('''
        PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=60000;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS nodes(
            id INTEGER PRIMARY KEY, parent INTEGER, kind TEXT, title TEXT,
            root INTEGER, deleted INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS nodes_unresolved ON nodes(parent) WHERE root IS NULL;
        CREATE TABLE IF NOT EXISTS articles(
            id TEXT PRIMARY KEY, lang TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
            metadata TEXT NOT NULL DEFAULT '{}', enriched_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS aliases(alias TEXT PRIMARY KEY, canonical TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mentions(
            item_id INTEGER NOT NULL, article_id TEXT NOT NULL REFERENCES articles(id),
            author TEXT, created_at INTEGER, kind TEXT, text TEXT, score INTEGER,
            PRIMARY KEY(item_id,article_id));
        CREATE INDEX IF NOT EXISTS mentions_article ON mentions(article_id,created_at);
        CREATE TABLE IF NOT EXISTS stats(
            article_id TEXT PRIMARY KEY REFERENCES articles(id), people INTEGER, mentions INTEGER,
            recent_people INTEGER, recent_mentions INTEGER, latest INTEGER);
        CREATE TABLE IF NOT EXISTS shards(
            path TEXT PRIMARY KEY, oid TEXT, revision TEXT, rows INTEGER DEFAULT 0,
            complete INTEGER DEFAULT 0, max_id INTEGER DEFAULT 0, min_id INTEGER,
            max_time INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS retry_ids(id INTEGER PRIMARY KEY, reason TEXT, attempts INTEGER DEFAULT 1);
        CREATE VIRTUAL TABLE IF NOT EXISTS article_search USING fts5(id UNINDEXED,title,description,extract,categories);
    ''')
    return db


def get_meta(db, key, default=None):
    row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default


def set_meta(db, key, value):
    db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, json.dumps(value)))


def ingest(db, rows):
    """All parent edges are retained; full text is retained only for Wikipedia mentions."""
    count, maximum, earliest, latest = 0, 0, None, 0
    for row in rows:
        if row.get('id') is None:
            continue
        item_id = int(row['id'])
        kind = TYPE_NAMES.get(row.get('type'), row.get('type', 'unknown'))
        parent = int(row['parent']) if row.get('parent') else None
        deleted = bool(row.get('deleted') or row.get('dead'))
        created = timestamp(row.get('time'))
        root = item_id if kind in ('story', 'poll', 'job') else None
        if parent and root is None:
            ancestor = db.execute('SELECT root FROM nodes WHERE id=?', (parent,)).fetchone()
            root = ancestor[0] if ancestor else None
        previous = db.execute('SELECT parent,root,kind FROM nodes WHERE id=?', (item_id,)).fetchone() if deleted else None
        # Deleted API items can omit parent/type. Retain structural information for descendants.
        if deleted and previous:
            parent, root, kind = previous['parent'], previous['root'], previous['kind']
        db.execute('''INSERT INTO nodes VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            parent=excluded.parent,kind=excluded.kind,title=excluded.title,root=excluded.root,deleted=excluded.deleted''',
            (item_id, parent, kind, plain_text(row.get('title')), root, int(deleted)))
        db.execute('DELETE FROM mentions WHERE item_id=?', (item_id,))
        if not deleted and kind in ('story', 'comment', 'poll'):
            for article in extract_articles(row):
                alias = db.execute('SELECT canonical FROM aliases WHERE alias=?', (article['id'],)).fetchone()
                article_id = alias[0] if alias else article['id']
                if not alias:
                    db.execute('INSERT OR IGNORE INTO articles(id,lang,title,url) VALUES (?,?,?,?)',
                               (article_id, article['lang'], article['title'], article['url']))
                db.execute('INSERT OR IGNORE INTO mentions VALUES (?,?,?,?,?,?,?)',
                           (item_id, article_id, row.get('by') or '[deleted]', created, kind,
                            plain_text(row.get('text')), int(row.get('score') or 0)))
        count += 1
        maximum = max(maximum, item_id)
        earliest = min(earliest, item_id) if earliest is not None else item_id
        latest = max(latest, created)
    return {'rows': count, 'max_id': maximum, 'min_id': earliest, 'max_time': latest}


def resolve_threads(db):
    # The partial index excludes already-resolved nodes; repeated passes handle out-of-order shards.
    for _ in range(1000):
        changed = db.execute('''UPDATE nodes SET root=(SELECT p.root FROM nodes p WHERE p.id=nodes.parent)
            WHERE root IS NULL AND EXISTS (SELECT 1 FROM nodes p WHERE p.id=nodes.parent AND p.root IS NOT NULL)''').rowcount
        if not changed:
            return
    raise RuntimeError('Thread resolution exceeded 1,000 levels; possible corrupt parent graph.')


def refresh_stats(db, now=None):
    now = int(now or time.time())
    db.execute('DELETE FROM stats')
    db.execute('''INSERT INTO stats SELECT article_id,
        count(DISTINCT CASE WHEN author!='[deleted]' THEN author END),count(*),
        count(DISTINCT CASE WHEN author!='[deleted]' AND created_at>=? THEN author END),
        sum(CASE WHEN created_at>=? THEN 1 ELSE 0 END),max(created_at)
        FROM mentions GROUP BY article_id''', (now - YEAR, now - YEAR))
    db.execute('DELETE FROM article_search')
    db.execute('''INSERT INTO article_search SELECT a.id,a.title,
        coalesce(json_extract(a.metadata,'$.description'),''),
        coalesce(json_extract(a.metadata,'$.extract'),''),
        coalesce(json_extract(a.metadata,'$.categories'),'') FROM articles a JOIN stats s ON s.article_id=a.id''')
    set_meta(db, 'stats_at', now)
    counts = db.execute('SELECT count(*),max(id) FROM nodes').fetchone()
    set_meta(db, 'catalog_counts', {
        'items': counts[0], 'maxId': counts[1],
        'mentions': db.execute('SELECT count(*) FROM mentions').fetchone()[0],
        'unresolved': db.execute('SELECT count(*) FROM mentions m JOIN nodes n ON n.id=m.item_id WHERE n.root IS NULL').fetchone()[0]})


def merge_metadata(db, original_id, article):
    canonical = article['id']
    db.execute('''INSERT INTO articles(id,lang,title,url,metadata,enriched_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,metadata=excluded.metadata,enriched_at=excluded.enriched_at''',
        (canonical, article['lang'], article['title'], article['url'], json.dumps(article), int(time.time())))
    if original_id != canonical:
        db.execute('INSERT OR IGNORE INTO mentions SELECT item_id,?,author,created_at,kind,text,score FROM mentions WHERE article_id=?', (canonical, original_id))
        db.execute('DELETE FROM mentions WHERE article_id=?', (original_id,))
        db.execute('DELETE FROM stats WHERE article_id=?', (original_id,))
        db.execute('UPDATE aliases SET canonical=? WHERE canonical=?', (canonical, original_id))
        db.execute('INSERT OR REPLACE INTO aliases VALUES (?,?)', (original_id, canonical))
        db.execute('DELETE FROM articles WHERE id=?', (original_id,))


def article_payload(db, row, context_limit=2, context_offset=0):
    result = {'id': row['id'], 'lang': row['lang'], 'title': row['title'], 'url': row['url'],
              **json.loads(row['metadata']), 'metadataLoaded': bool(row['enriched_at'])}
    stats = db.execute('SELECT * FROM stats WHERE article_id=?', (row['id'],)).fetchone()
    if stats:
        result['metrics'] = {'distinctLinkers': stats['people'], 'mentionCount': stats['mentions'],
            'recentLinkers': stats['recent_people'], 'recentMentionCount': stats['recent_mentions'],
            'latestMention': stats['latest'], 'asOf': get_meta(db, 'stats_at')}
    mentions = db.execute('''SELECT m.*,n.root,r.title FROM mentions m LEFT JOIN nodes n ON n.id=m.item_id
        LEFT JOIN nodes r ON r.id=n.root WHERE m.article_id=? ORDER BY m.created_at DESC,m.item_id DESC LIMIT ? OFFSET ?''',
        (row['id'], context_limit, context_offset)).fetchall()
    result['mentions'] = [{'id': str(m['item_id']), 'author': m['author'], 'createdAt': m['created_at'],
        'kind': 'comment' if m['kind'] == 'comment' else 'story', 'storyId': str(m['root']) if m['root'] else None,
        'storyTitle': m['title'] or 'Hacker News discussion', 'text': m['text'], 'points': m['score']} for m in mentions]
    return result


def status(db):
    counts = get_meta(db, 'catalog_counts')
    if counts is None:
        rows = db.execute('SELECT count(*),max(id) FROM nodes').fetchone()
        counts = {'items': rows[0], 'maxId': rows[1],
            'mentions': db.execute('SELECT count(*) FROM mentions').fetchone()[0],
            'unresolved': db.execute('SELECT count(*) FROM mentions m JOIN nodes n ON n.id=m.item_id WHERE n.root IS NULL').fetchone()[0]}
    snapshot = get_meta(db, 'snapshot')
    shards = db.execute('SELECT count(*),coalesce(sum(complete),0),max(max_time) FROM shards WHERE revision=?',
                        (snapshot['revision'],)).fetchone() if snapshot else db.execute(
                        'SELECT count(*),coalesce(sum(complete),0),max(max_time) FROM shards').fetchone()
    return {'articles': db.execute('SELECT count(*) FROM stats').fetchone()[0],
        'mentions': counts['mentions'],
        'itemsIndexed': counts['items'], 'maxItemId': counts['maxId'], 'shardsKnown': shards[0], 'shardsImported': shards[1],
        'sourceLatestTime': shards[2], 'snapshot': snapshot,
        'tail': get_meta(db, 'tail'), 'statsAt': get_meta(db, 'stats_at'),
        'retryCount': db.execute('SELECT count(*) FROM retry_ids').fetchone()[0], 'unresolvedMentions': counts['unresolved'],
        'gaps': get_meta(db, 'gaps', []), 'gapsCheckedAt': get_meta(db, 'gaps_checked_at'),
        'needsSetup': counts['items'] == 0}


def feed(db, mode='for-you', limit=60, offset=0, query='', seeds=(), mix_seed=0):
    limit, offset = max(1, min(int(limit), 100)), max(0, int(offset))
    where, params = '', []
    if query.strip():
        terms = re.findall(r'[^\W_]{2,}', query, re.UNICODE)[:12]
        if not terms:
            return {'articles': [], 'nextCursor': None}
        expression = ' AND '.join('"' + word.replace('"', '') + '"*' for word in terms)
        where = ' AND a.id IN (SELECT id FROM article_search WHERE article_search MATCH ?)'
        params.append(expression)
    if mode == 'rising':
        where += ' AND s.recent_mentions>0'
    if mode == 'random':
        # Stable per request/session seed, allowing offset pagination without duplicate random draws.
        salt = int(hashlib.sha256(str(seeds).encode()).hexdigest()[:7], 16)
        order = f'((a.rowid * 1103515245 + {salt}) & 2147483647)'
    elif mode == 'rising':
        order = 's.recent_people DESC,s.recent_mentions DESC,a.id'
    else:
        order = 's.people DESC,s.mentions DESC,a.id'
    priority_ids = []
    if mode == 'for-you' and seeds and not query:
        for seed in list(seeds)[:12]:
            row = db.execute('SELECT * FROM articles WHERE id=?', (seed,)).fetchone()
            if not row:
                continue
            metadata = json.loads(row['metadata'])
            words = list(dict.fromkeys(re.findall(r'[^\W_]{4,}', row['title'] + ' ' + metadata.get('description', ''), re.UNICODE)))[:8]
            if words:
                expression = ' OR '.join('"' + word + '"' for word in words)
                priority_ids.extend(r[0] for r in db.execute('SELECT id FROM article_search WHERE article_search MATCH ? ORDER BY rank LIMIT 80', (expression,)))
        priority_ids = list(dict.fromkeys(priority_ids))
    if priority_ids:
        placeholders = ','.join('?' for _ in priority_ids)
        order = f'CASE WHEN a.id IN ({placeholders}) THEN 0 ELSE 1 END,' + order
        params.extend(priority_ids)
    rows = db.execute(f'''SELECT a.* FROM articles a JOIN stats s ON a.id=s.article_id
        WHERE 1=1 {where} ORDER BY {order} LIMIT ? OFFSET ?''', [*params, limit + 1, offset]).fetchall()
    # For You mixes popular, related and recent candidates; the browser applies the personal ranker.
    recent, popular = [], []
    if mode == 'for-you' and offset == 0 and not query:
        recent = db.execute('SELECT a.* FROM articles a JOIN stats s ON a.id=s.article_id ORDER BY s.latest DESC,a.id LIMIT 30').fetchall()
        popular = db.execute('SELECT a.* FROM articles a JOIN stats s ON a.id=s.article_id ORDER BY s.people DESC,s.mentions DESC,a.id LIMIT 40').fetchall()
    discovery = []
    if mode == 'for-you' and not query:
        salt = int(hashlib.sha256(str(mix_seed).encode()).hexdigest()[:7], 16)
        discovery = db.execute('''SELECT a.* FROM articles a JOIN stats s ON a.id=s.article_id
            ORDER BY ((a.rowid * 1103515245 + ?) & 2147483647) LIMIT 12 OFFSET ?''',
            (salt, offset // limit * 12)).fetchall()
    unique = {r['id']: r for r in [*rows[:limit], *popular, *recent, *discovery]}
    return {'articles': [article_payload(db, row) for row in unique.values()],
        'nextCursor': offset + limit if len(rows) > limit else None, 'mode': mode,
        'statsAt': get_meta(db, 'stats_at'), 'source': 'archive'}


def missing_ranges(db):
    """Enumerate absent IDs, not just min/max shard ranges (HN can also have null IDs)."""
    previous, gaps = None, []
    for (item_id,) in db.execute('SELECT id FROM nodes ORDER BY id'):
        if previous is not None and item_id > previous + 1:
            gaps.append([previous + 1, item_id - 1])
        previous = item_id
    set_meta(db, 'gaps', gaps)
    set_meta(db, 'gaps_checked_at', int(time.time()))
    return gaps
