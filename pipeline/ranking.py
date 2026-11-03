"""Rebuild six-month Rising ranks from a static export, without the source database."""
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from .store import six_months_ago


def refresh_rising(output='data/catalog', now=None):
    output = Path(output)
    manifest_path = output / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('kind') != 'wikihack-static' or manifest.get('version') != 1:
        raise ValueError('Expected a WikiHack static catalogue.')
    root = output / manifest['generation']
    now = int(time.time() if now is None else now)
    since = six_months_ago(now)
    stage = Path(tempfile.mkdtemp(prefix='.rising-build-', dir=output))
    published = None
    try:
        def comments():
            for number in range((manifest['mentionCount'] + manifest['contextShardSize'] - 1) // manifest['contextShardSize']):
                yield from json.loads((root / f'context/{number}.json').read_text())

        mentions = iter(comments())
        ranked, offset = [], 0
        for number in range((manifest['articleCount'] + manifest['articleShardSize'] - 1) // manifest['articleShardSize']):
            for article in json.loads((root / f'articles/{number}.json').read_text()):
                if article['context']['start'] != offset:
                    raise ValueError('Invalid context offsets; existing ranking was kept.')
                people, count = set(), 0
                for _ in range(article['context']['count']):
                    mention = next(mentions)
                    offset += 1
                    if since <= mention['createdAt'] <= now:
                        count += 1
                        if mention['author'] != '[deleted]':
                            people.add(mention['author'])
                if count:
                    ranked.append((-len(people), -count, article['id'], article['_index']))
        if offset != manifest['mentionCount'] or next(mentions, None) is not None:
            raise ValueError('Incomplete comment archive; existing ranking was kept.')
        ranked.sort()
        width = manifest['rankShardSize']
        for start in range(0, len(ranked), width):
            (stage / f'{start // width}.json').write_text(json.dumps([row[3] for row in ranked[start:start + width]], separators=(',', ':')))
        # Immutable rank paths let an already-open client finish its old snapshot.
        name = f'rising-6m-{time.time_ns():x}'
        published = root / name
        os.replace(stage, published)
        manifest.update(risingPath=name, risingCount=len(ranked), risingWindowMonths=6,
                        risingSince=since, risingAsOf=now)
        files = list(root.rglob('*.json'))
        manifest.update(dataBytes=sum(p.stat().st_size for p in files), dataFiles=len(files))
        with tempfile.NamedTemporaryFile(mode='w', dir=output, prefix='.manifest-', delete=False) as pending:
            json.dump(manifest, pending, ensure_ascii=False, separators=(',', ':'))
            pending_path = Path(pending.name)
        try:
            os.replace(pending_path, manifest_path)
        finally:
            pending_path.unlink(missing_ok=True)
        return manifest
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        if published:
            shutil.rmtree(published, ignore_errors=True)
        raise


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='data/catalog')
    args = parser.parse_args()
    manifest = refresh_rising(args.output)
    print(f"Ranked {manifest['risingCount']:,} articles from the last six calendar months.")
