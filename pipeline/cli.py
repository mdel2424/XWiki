import argparse
import json
import sys
import time
from pathlib import Path

from .metadata import enrich
from .sources import fetch_ids, sync_snapshot, tail
from .static_export import export_static
from .store import connect, feed, get_meta, ingest, missing_ranges, refresh_stats, resolve_threads, set_meta, status


def main():
    parser = argparse.ArgumentParser(description='WikiHack HN archive pipeline')
    parser.add_argument('--db', default='.data/wikihack.sqlite')
    commands = parser.add_subparsers(dest='command', required=True)
    sync = commands.add_parser('sync', help='Import the revision-pinned HF archive, resuming completed batches')
    sync.add_argument('--max-shards', type=int)
    sync.add_argument('--metadata', type=int, default=200)
    live = commands.add_parser('tail', help='Import new HN IDs, updates, retries and an overlap window')
    live.add_argument('--bootstrap', type=int)
    live.add_argument('--max-items', type=int, default=5000)
    watch = commands.add_parser('watch', help='Poll official HN every five minutes after an archive import')
    watch.add_argument('--interval', type=int, default=300)
    commands.add_parser('status')
    commands.add_parser('audit', help='Measure missing ID intervals across imported nodes')
    gaps = commands.add_parser('fill-gaps', help='Verify/fill audited missing IDs through official HN')
    gaps.add_argument('--max-items', type=int, default=5000)
    metadata = commands.add_parser('enrich')
    metadata.add_argument('--limit', type=int, default=1000)
    local = commands.add_parser('import-jsonl', help='Import HN-format records from a local JSONL export')
    local.add_argument('file')
    export = commands.add_parser('export', help='Export the complete static catalogue, search and original HN context')
    export.add_argument('--output', default='data/catalog')
    export.add_argument('--limit', type=int, default=None)
    args = parser.parse_args()
    if any(getattr(args, name, 1) is not None and getattr(args, name, 1) <= 0 for name in ('max_shards', 'metadata', 'max_items', 'limit', 'interval', 'bootstrap')):
        parser.error('Counts and intervals must be positive.')
    db = connect(args.db)
    try:
        if args.command == 'status':
            print(json.dumps(status(db), indent=2))
            return
        if args.command == 'sync':
            sync_snapshot(db, max_shards=args.max_shards)
            with db:
                resolve_threads(db)
                refresh_stats(db)
                missing_ranges(db)
            if args.metadata:
                enrich(db, args.metadata)
        elif args.command == 'import-jsonl':
            with open(args.file, encoding='utf-8') as source:
                batch = []
                for line in source:
                    if not line.strip():
                        continue
                    batch.append(json.loads(line))
                    if len(batch) == 4096:
                        with db:
                            ingest(db, batch)
                        batch = []
                with db:
                    ingest(db, batch)
                    set_meta(db, 'local_import', {'file': str(Path(args.file).name), 'at': int(time.time())})
        elif args.command == 'tail':
            tail(db, args.max_items, args.bootstrap)
        elif args.command == 'watch':
            while True:
                try:
                    tail(db)
                    with db:
                        resolve_threads(db)
                        refresh_stats(db)
                    enrich(db, 50)
                    with db:
                        refresh_stats(db)
                    print(json.dumps(status(db)), flush=True)
                except Exception as error:
                    print(f'Poll failed, checkpoints retained: {error}', file=sys.stderr, flush=True)
                time.sleep(args.interval)
        elif args.command == 'enrich':
            enrich(db, args.limit)
        elif args.command == 'audit':
            with db:
                gaps = missing_ranges(db)
            print(json.dumps({'gapRanges': len(gaps), 'missingIds': sum(b - a + 1 for a, b in gaps), 'firstRanges': gaps[:100]}, indent=2))
            return
        elif args.command == 'fill-gaps':
            ranges = get_meta(db, 'gaps')
            if ranges is None:
                raise RuntimeError('Run audit first to identify actual absent IDs.')
            import itertools
            cursor = get_meta(db, 'gap_fill_cursor', 0)
            eligible = [interval for interval in ranges if interval[1] > cursor]
            if not eligible:
                cursor = 0
                eligible = ranges
            ids = itertools.islice((item_id for start, end in eligible for item_id in range(max(start, cursor + 1), end + 1)), args.max_items)
            batch = []
            last_checked = cursor
            for item_id in ids:
                batch.append(item_id)
                last_checked = item_id
                if len(batch) == 100:
                    fetch_ids(db, batch)
                    with db:
                        set_meta(db, 'gap_fill_cursor', last_checked)
                    batch = []
            fetch_ids(db, batch)
            with db:
                set_meta(db, 'gap_fill_cursor', last_checked)
                missing_ranges(db)
        elif args.command == 'export':
            manifest = export_static(db, output=args.output, limit=args.limit, topic_cache='.data/topic-predictions.sqlite')
            print(json.dumps({'output': args.output, **{key: manifest[key] for key in ('articleCount', 'mentionCount', 'dataBytes', 'dataFiles', 'generation')}}, indent=2))
            return
        with db:
            resolve_threads(db)
            refresh_stats(db)
        print(json.dumps(status(db), indent=2))
    finally:
        db.close()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Stopped. Committed batches will resume on the next run.', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print(f'Pipeline failed: {error}. Committed batches are retained.', file=sys.stderr)
        sys.exit(1)
