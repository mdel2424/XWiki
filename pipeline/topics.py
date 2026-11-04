"""Publish a compact topic index from Wikimedia predictions, without rewriting article cards."""
import argparse
import hashlib
import json
import os
import sqlite3
from functools import lru_cache
from collections import Counter
from pathlib import Path

TAXONOMY = Path(__file__).resolve().parent.parent / 'src/topic-definitions.json'
THRESHOLD = 0.5
SOURCE = {'kind': 'wikimedia-articletopic', 'field': 'classification.prediction.articletopic',
          'url': 'https://wikitech.wikimedia.org/wiki/Search/articletopic', 'threshold': THRESHOLD}


@lru_cache(maxsize=1)
def definitions():
    return json.loads(TAXONOMY.read_text())


def prediction_topics(scores):
    if not isinstance(scores, dict):
        return []
    normalize = lambda label: label.replace('_', ' ').lower()
    labels = [normalize(label) for label, score in scores.items()
              if isinstance(label, str) and isinstance(score, (float, int)) and not isinstance(score, bool)
              and THRESHOLD <= score <= 1]
    return [topic['id'] for topic in definitions() if any(
        any(label.startswith(normalize(pattern)) if pattern.endswith('.') else label == normalize(pattern)
            for label in labels) for pattern in topic['models'])]


def topic_payload(root, manifest, cache=None):
    topics = {topic['id']: [] for topic in definitions()}
    coverage = Counter(articles=manifest['articleCount'], checked=0, predicted=0, unscored=0,
                       missing=0, unsupported=0, notChecked=0, classified=0)
    db = None
    if cache and Path(cache).is_file():
        db = sqlite3.connect(f'file:{Path(cache).resolve()}?mode=ro', uri=True)
    checked_at = manifest['generatedAt']
    seen = set()
    try:
        for file in sorted((Path(root) / 'articles').glob('*.json')):
            for article in json.loads(file.read_text()):
                ordinal = article.get('_index')
                if not isinstance(ordinal, int) or not 0 <= ordinal < manifest['articleCount'] or ordinal in seen:
                    raise ValueError('Invalid article order; refusing to publish topic index.')
                seen.add(ordinal)
                scores = article.get('topicPredictions')
                status = 'predicted' if isinstance(scores, dict) and scores else 'unscored' if isinstance(scores, dict) else 'notChecked'
                if scores is None and db:
                    row = db.execute('SELECT scores,status,checked_at FROM predictions WHERE lang=? AND title=?',
                                     (article['lang'], article['title'])).fetchone()
                    if row:
                        scores, status = json.loads(row[0]), row[1]
                        checked_at = max(checked_at, row[2])
                if status not in coverage:
                    raise ValueError('Unknown prediction status.')
                coverage[status] += 1
                if status != 'notChecked':
                    coverage['checked'] += 1
                memberships = prediction_topics(scores)
                if memberships:
                    coverage['classified'] += 1
                for topic in memberships:
                    topics[topic].append(ordinal)
    finally:
        if db:
            db.close()
    if len(seen) != manifest['articleCount']:
        raise ValueError('Incomplete catalogue; refusing to publish topic index.')
    return {'kind': 'xwiki-topic-index', 'version': 1, 'generation': manifest['generation'],
            'generatedAt': checked_at, 'source': SOURCE, 'coverage': dict(coverage),
            'topics': {key: sorted(values) for key, values in topics.items()}}


def index_metadata(payload):
    encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
    path = 'topics-' + hashlib.sha256(encoded).hexdigest()[:16] + '.json'
    metadata = {'path': path, 'version': 1, 'source': SOURCE, 'coverage': payload['coverage'],
                'counts': {key: len(values) for key, values in payload['topics'].items()}}
    return encoded, metadata


def publish(catalog='data/catalog', cache='.data/topic-predictions.sqlite'):
    catalog = Path(catalog)
    manifest_file = catalog / 'manifest.json'
    original = manifest_file.read_bytes()
    manifest = json.loads(original)
    if manifest.get('kind') != 'wikihack-static' or not manifest.get('articleCount'):
        raise ValueError('Not a complete XWiki catalogue.')
    root = catalog / manifest['generation']
    payload = topic_payload(root, manifest, cache)
    if payload['coverage']['checked'] < manifest.get('topicIndex', {}).get('coverage', {}).get('checked', 0):
        raise ValueError('Refusing to replace topic predictions with lower coverage.')
    encoded, metadata = index_metadata(payload)
    temporary = root / (metadata['path'] + '.tmp')
    temporary.write_bytes(encoded)
    os.replace(temporary, root / metadata['path'])
    if manifest_file.read_bytes() != original:
        raise ValueError('Catalogue changed during topic indexing; rerun against the new snapshot.')
    manifest['topicIndex'] = metadata
    files = list(root.rglob('*.json'))
    manifest['dataFiles'], manifest['dataBytes'] = len(files), sum(file.stat().st_size for file in files)
    temporary = catalog / 'manifest.topics.tmp'
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')))
    os.replace(temporary, manifest_file)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', default='data/catalog')
    parser.add_argument('--cache', default='.data/topic-predictions.sqlite')
    parser.add_argument('--export-only', action='store_true', help='Use cached predictions without making API requests')
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    if not args.export_only:
        from .topic_predictions import collect
        collect(args.catalog, args.cache, refresh=args.refresh)
    print(json.dumps(publish(args.catalog, args.cache), indent=2))

if __name__ == '__main__':
    main()
