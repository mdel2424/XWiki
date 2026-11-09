"""Generate a complete, versioned static catalogue without publishing the HN database."""
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
import unicodedata
from pathlib import Path

from .store import six_months_ago, status
from .topics import topic_payload, index_metadata
from .wikipedia import payload as wikipedia_payload, index_metadata as wikipedia_metadata

STOP = set('a an the and of to in on for with from by is are was were it its as at that this or not be'.split())


def search_terms(text):
    return sorted(set(word for word in re.findall(r'[^\W_]+', unicodedata.normalize('NFKC', text).lower()) if word not in STOP))


def bucket(text, count):
    value = 2166136261
    for byte in text.encode('utf-8'):
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return value % count


def export_static(db, output='data/catalog', limit=None, article_size=256, context_size=128, rank_size=512, max_bytes=900_000_000, topic_cache=None, wikipedia_cache=None):
    destination = Path(output).resolve()
    if destination.is_dir() and any(destination.iterdir()):
        marker = destination / 'manifest.json'
        if not marker.exists() or json.loads(marker.read_text()).get('kind') != 'wikihack-static':
            raise ValueError('Refusing to replace a directory that is not a generated WikiHack catalogue.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.catalog-build-', dir=destination.parent))
    generation = f'v-{time.time_ns():x}'
    root = stage / generation
    total_bytes, files = 0, 0

    def write(relative, value):
        nonlocal total_bytes, files
        encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        total_bytes += len(encoded)
        if total_bytes > max_bytes:
            raise ValueError(f'Static catalogue exceeds the {max_bytes:,}-byte publishing budget. Existing export was kept.')
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded)
        files += 1

    try:
        db.execute('SAVEPOINT static_export')
        now = int(time.time())
        # Recompute aggregates in this read snapshot: a concurrent sync cannot mix
        # new comments with stale counts/offsets. No persistent database writes.
        query = '''WITH counts AS (SELECT article_id,count(*) AS total,
            count(DISTINCT CASE WHEN author!='[deleted]' THEN author END) AS people,
            count(DISTINCT CASE WHEN author!='[deleted]' AND created_at BETWEEN ? AND ? THEN author END) AS recent_people,
            sum(CASE WHEN created_at BETWEEN ? AND ? THEN 1 ELSE 0 END) AS recent_total,max(created_at) AS latest
            FROM mentions GROUP BY article_id)
            SELECT a.*,c.total,c.people,c.recent_people,c.recent_total,c.latest
            FROM articles a JOIN counts c ON c.article_id=a.id
            ORDER BY c.people DESC,c.total DESC,a.id'''
        params = [six_months_ago(now), now, six_months_ago(now), now]
        if limit is not None:
            query += ' LIMIT ?'
            params.append(limit)
        rows = db.execute(query, params).fetchall()
        if not rows:
            raise ValueError('No HN-linked articles to export. Import data before building the static site.')
        db.execute('DROP TABLE IF EXISTS temp.static_ord')
        db.execute('CREATE TEMP TABLE static_ord(article_id TEXT PRIMARY KEY,ordinal INTEGER UNIQUE)')
        db.executemany('INSERT INTO static_ord VALUES (?,?)', ((row['id'], i) for i, row in enumerate(rows)))
        postings = [{} for _ in range(256)]
        lookup = [{} for _ in range(64)]
        cards, context_offset = [], 0
        for ordinal, row in enumerate(rows):
            metadata = json.loads(row['metadata'])
            card = {**metadata, 'id': row['id'], 'lang': row['lang'], 'title': row['title'], 'url': row['url'],
                '_index': ordinal, 'metadataLoaded': bool(row['enriched_at']), 'mentions': [],
                'context': {'start': context_offset, 'count': row['total']},
                'metrics': {'distinctLinkers': row['people'], 'mentionCount': row['total'],
                    'recentLinkers': row['recent_people'], 'recentMentionCount': row['recent_total'],
                    'latestMention': row['latest'], 'asOf': now}}
            cards.append(card)
            context_offset += row['total']
            lookup[bucket(row['id'], 64)][row['id']] = ordinal
            text = ' '.join([row['title'], metadata.get('description', ''), metadata.get('extract', ''), ' '.join(metadata.get('categories', []))])
            for term in search_terms(text):
                postings[bucket(term[:2], 256)].setdefault(term, []).append(ordinal)
            if len(cards) == article_size:
                write(f'articles/{ordinal // article_size}.json', cards)
                cards = []
        if cards:
            write(f'articles/{(len(rows) - 1) // article_size}.json', cards)
        write('discovery-weights.json', [min(255, row['people']) for row in rows])
        for alias in db.execute('SELECT x.alias,o.ordinal FROM aliases x JOIN static_ord o ON o.article_id=x.canonical'):
            lookup[bucket(alias['alias'], 64)][alias['alias']] = alias['ordinal']
        for i, values in enumerate(lookup):
            write(f'ids/{i}.json', values)
        for i, values in enumerate(postings):
            write(f'search/{i}.json', values)

        for name, order, condition in [('rising', 'recent_people DESC,recent_total DESC,id', lambda r: r['recent_total'] > 0),
                                        ('recent', 'latest DESC,id', lambda r: True)]:
            if name == 'rising':
                ranked = sorted((i for i, r in enumerate(rows) if condition(r)), key=lambda i: (-rows[i]['recent_people'], -rows[i]['recent_total'], rows[i]['id']))
                rising_count = len(ranked)
            else:
                ranked = sorted(range(len(rows)), key=lambda i: (-rows[i]['latest'], rows[i]['id']))
            for start in range(0, len(ranked), rank_size):
                write(f'{name}/{start // rank_size}.json', ranked[start:start + rank_size])

        comments, exported_mentions = [], 0
        # A single streamed join retains all original comments, including nested roots.
        query = '''SELECT m.*,n.root,r.title FROM mentions m JOIN static_ord o ON o.article_id=m.article_id
            LEFT JOIN nodes n ON n.id=m.item_id LEFT JOIN nodes r ON r.id=n.root
            ORDER BY o.ordinal,m.created_at DESC,m.item_id DESC'''
        for mention in db.execute(query):
            comments.append({'id': str(mention['item_id']), 'author': mention['author'], 'createdAt': mention['created_at'],
                'kind': 'comment' if mention['kind'] == 'comment' else 'story',
                'storyId': str(mention['root']) if mention['root'] else None,
                'storyTitle': mention['title'] or 'Hacker News discussion', 'text': mention['text'], 'points': mention['score']})
            exported_mentions += 1
            if len(comments) == context_size:
                write(f'context/{(exported_mentions - 1) // context_size}.json', comments)
                comments = []
        if comments:
            write(f'context/{(exported_mentions - 1) // context_size}.json', comments)
        if exported_mentions != context_offset:
            raise ValueError('Comment counts changed during export; refusing to publish mismatched context offsets.')
        coverage = status(db)
        gaps = coverage.pop('gaps', [])
        coverage.update({'gapRangeCount': len(gaps), 'articles': len(rows), 'mentions': exported_mentions,
                         'statsAt': now, 'exportLimited': limit is not None})
        manifest = {'kind': 'wikihack-static', 'version': 1, 'generation': generation, 'generatedAt': now,
            'articleCount': len(rows), 'mentionCount': exported_mentions, 'risingCount': rising_count,
            'articleShardSize': article_size, 'contextShardSize': context_size, 'rankShardSize': rank_size,
            'idBuckets': 64, 'searchBuckets': 256, 'coverage': coverage,
            'risingWindowMonths': 6, 'risingSince': six_months_ago(now), 'risingAsOf': now,
            'discoveryWeights': 'discovery-weights.json',
            'dataBytes': total_bytes, 'dataFiles': files}
        payload = topic_payload(root, manifest, topic_cache)
        _, metadata = index_metadata(payload)
        write(metadata['path'], payload)
        manifest.update({'topicIndex': metadata, 'dataBytes': total_bytes, 'dataFiles': files})
        wikipedia = wikipedia_payload(stage, manifest, wikipedia_cache)
        _, metadata = wikipedia_metadata(wikipedia)
        write(metadata['path'], wikipedia)
        manifest.update({'wikipediaIndex': metadata, 'dataBytes': total_bytes, 'dataFiles': files})
        (stage / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        db.execute('DROP TABLE static_ord')
        db.execute('RELEASE static_export')
        backup = destination.with_name(destination.name + '.previous')
        if backup.exists():
            raise ValueError(f'Previous export backup already exists: {backup}')
        if destination.exists():
            os.replace(destination, backup)
        try:
            os.replace(stage, destination)
        except Exception:
            if backup.exists():
                os.replace(backup, destination)
            raise
        if backup.exists():
            shutil.rmtree(backup)
        return manifest
    except Exception:
        try:
            db.execute('ROLLBACK TO static_export')
            db.execute('RELEASE static_export')
        except Exception:
            pass
        shutil.rmtree(stage, ignore_errors=True)
        raise
