"""Add popularity weights to an existing static catalogue without the HN database."""
import hashlib
import json
import os
import tempfile
from pathlib import Path


def atomic_write(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.discovery-', delete=False) as pending:
        pending.write(data)
        pending_path = Path(pending.name)
    try:
        os.replace(pending_path, path)
    finally:
        pending_path.unlink(missing_ok=True)


def refresh_discovery(output='data/catalog'):
    output = Path(output)
    manifest_path = output / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('kind') != 'wikihack-static' or manifest.get('version') != 1:
        raise ValueError('Expected a WikiHack static catalogue.')
    root = output / manifest['generation']
    counts = []
    for number in range((manifest['articleCount'] + manifest['articleShardSize'] - 1) // manifest['articleShardSize']):
        for article in json.loads((root / f'articles/{number}.json').read_text()):
            if article['_index'] != len(counts):
                raise ValueError('Invalid article order; existing weights were kept.')
            counts.append(min(255, max(0, article['metrics']['distinctLinkers'])))
    if len(counts) != manifest['articleCount']:
        raise ValueError('Incomplete article archive; existing weights were kept.')
    encoded = json.dumps(counts, separators=(',', ':')).encode('utf-8')
    name = f'discovery-weights-{hashlib.sha256(encoded).hexdigest()[:16]}.json'
    atomic_write(root / name, encoded)
    manifest['discoveryWeights'] = name
    files = list(root.rglob('*.json'))
    manifest.update(dataBytes=sum(file.stat().st_size for file in files), dataFiles=len(files))
    atomic_write(manifest_path, json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    return manifest


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='data/catalog')
    args = parser.parse_args()
    manifest = refresh_discovery(args.output)
    print(f"Prepared popularity weights for {manifest['articleCount']:,} articles.")
