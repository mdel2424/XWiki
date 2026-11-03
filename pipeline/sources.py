import concurrent.futures
import json
import os
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .store import get_meta, ingest, set_meta

DATASET = 'open-index/hacker-news'
FIREBASE = 'https://hacker-news.firebaseio.com/v0'
USER_AGENT = 'WikiHack/0.2 (personal Wikipedia discovery; public HN API)'


def request_page(url, attempts=4):
    for attempt in range(attempts):
        try:
            with urlopen(Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'}), timeout=30) as response:
                data = json.load(response)
                match = re.search(r'<([^>]+)>;\s*rel="?next"?', response.headers.get('Link', ''))
                return data, match[1] if match else None
        except (HTTPError, URLError, TimeoutError, ValueError):
            if attempt == attempts - 1:
                raise
            time.sleep(min(2 ** attempt, 8))


def request_json(url):
    return request_page(url)[0]


def discover_snapshot(request=request_json, page_request=request_page):
    info = request(f'https://huggingface.co/api/datasets/{DATASET}')
    revision = info['sha']
    files, next_url = [], f'https://huggingface.co/api/datasets/{DATASET}/tree/{revision}?recursive=true&limit=1000'
    # The tree API uses Link pagination. Fetching metadata is separate from reading Parquet.
    while next_url:
        entries, next_url = page_request(next_url)
        files.extend(entry for entry in entries if entry.get('path', '').endswith('.parquet'))
        if next_url and not next_url.startswith(f'https://huggingface.co/api/datasets/{DATASET}/'):
            raise ValueError('Unexpected archive pagination origin.')
    files = [entry for entry in files if entry['path'].startswith(('data/', 'today/'))]
    if not files:
        raise RuntimeError('No archive shards found; refusing to mark an empty manifest complete.')
    return {'source': DATASET, 'revision': revision, 'repositoryUpdatedAt': info.get('lastModified'),
            'files': sorted(files, key=lambda f: f['path'])}


def parquet_batches(url, offset=0, batch_size=4096):
    try:
        import duckdb
    except ImportError as error:
        raise RuntimeError('DuckDB is required for Parquet. Run npm run data:setup first.') from error
    connection = duckdb.connect()
    try:
        connection.execute('SET threads=2')
        connection.execute("SET memory_limit='512MB'")
        if url.startswith(('https://', 'http://')):
            extension_dir = os.path.abspath('.data/duckdb-extensions')
            os.makedirs(extension_dir, exist_ok=True)
            connection.execute("SET extension_directory='" + extension_dir.replace("'", "''") + "'")
            connection.execute('INSTALL httpfs')
            connection.execute('LOAD httpfs')
            connection.execute('SET http_timeout=60')
        fields = ['id', 'by', 'time', 'parent', 'type', 'title', 'text', 'url', 'score', 'deleted', 'dead']
        schema = {row[0]: row[1] for row in connection.execute('DESCRIBE SELECT * FROM read_parquet(?)', [url]).fetchall()}
        if not {'id', 'type', 'parent', 'text', 'url', 'by', 'time'}.issubset(schema):
            raise RuntimeError(f'Unexpected archive schema: {sorted(schema)}')
        projection = []
        for name in fields:
            if name not in schema:
                projection.append(f'NULL AS "{name}"')
            elif name == 'time' and schema[name].upper().startswith(('TIMESTAMP', 'DATE')):
                # HF uses TIMESTAMPTZ. Fetching that as a Python datetime implicitly
                # requires pytz; normalize in SQL instead, independent of host timezone.
                projection.append('CAST(trunc(epoch("time")) AS BIGINT) AS "time"')
            else:
                projection.append(f'"{name}"')
        projection = ','.join(projection)
        # Range requests project just these columns; no pandas or full in-memory archive.
        cursor = connection.execute(f'SELECT {projection} FROM read_parquet(?) OFFSET ?', [url, offset])
        while True:
            batch = cursor.fetchmany(batch_size)
            if not batch:
                return
            yield [dict(zip(fields, row)) for row in batch]
    finally:
        connection.close()


def sync_snapshot(db, max_shards=None, request=request_json, page_request=request_page, batches=parquet_batches, log=print):
    manifest = discover_snapshot(request, page_request)
    revision = manifest['revision']
    snapshot = {key: value for key, value in manifest.items() if key != 'files'}
    snapshot.update({'expectedShards': len(manifest['files']), 'completed': False, 'startedAt': int(time.time())})
    with db:
        set_meta(db, 'snapshot', snapshot)
    imported = 0
    for file in manifest['files']:
        path = file['path']
        oid = file.get('lfs', {}).get('oid') or file.get('oid') or revision
        old = db.execute('SELECT * FROM shards WHERE path=?', (path,)).fetchone()
        if old and old['oid'] == oid and old['complete']:
            with db:
                db.execute('UPDATE shards SET revision=? WHERE path=?', (revision, path))
            continue
        if max_shards is not None and imported >= max_shards:
            break
        offset = old['rows'] if old and old['oid'] == oid else 0
        with db:
            if not old or old['oid'] != oid:
                db.execute('INSERT OR REPLACE INTO shards(path,oid,revision) VALUES (?,?,?)', (path, oid, revision))
            else:
                db.execute('UPDATE shards SET revision=? WHERE path=?', (revision, path))
        url = f'https://huggingface.co/datasets/{DATASET}/resolve/{revision}/{quote(path, safe="/")}'
        log(f'Importing {path}, resume row {offset:,} (revision {revision[:12]})')
        for rows in batches(url, offset=offset):
            with db:
                observed = ingest(db, rows)
                offset += len(rows)
                db.execute('''UPDATE shards SET rows=?,max_id=max(max_id,?),
                    min_id=CASE WHEN min_id IS NULL THEN ? ELSE min(min_id,?) END,
                    max_time=max(max_time,?) WHERE path=?''',
                    (offset, observed['max_id'], observed['min_id'], observed['min_id'], observed['max_time'], path))
        with db:
            db.execute('UPDATE shards SET complete=1 WHERE path=?', (path,))
        imported += 1
    imported_files = {row['path']: row for row in db.execute('SELECT path,oid,complete FROM shards')}
    complete = all(file['path'] in imported_files and imported_files[file['path']]['complete'] and
                   imported_files[file['path']]['oid'] == (file.get('lfs', {}).get('oid') or file.get('oid') or revision)
                   for file in manifest['files'])
    snapshot.update({'completed': complete, 'finishedAt': int(time.time()),
                     'note': 'Manifest import status, not a claim that all historical HN IDs are present.'})
    with db:
        set_meta(db, 'snapshot', snapshot)
    return snapshot


def fetch_ids(db, ids, request=request_json, workers=6):
    def fetch(item_id):
        return item_id, request(f'{FIREBASE}/item/{item_id}.json')
    failed = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch, int(item_id)): int(item_id) for item_id in ids}
        for future in concurrent.futures.as_completed(futures):
            item_id = futures[future]
            try:
                _, row = future.result()
                with db:
                    if row is not None:
                        if int(row.get('id', -1)) != item_id:
                            raise ValueError('HN item response ID does not match request.')
                        ingest(db, [row])
                    else:
                        # Successful null responses remain known, retriable gaps rather than invented items.
                        db.execute('''INSERT INTO retry_ids(id,reason) VALUES (?,?) ON CONFLICT(id)
                            DO UPDATE SET reason=excluded.reason,attempts=attempts+1''', (item_id, 'null API item'))
                        continue
                    db.execute('DELETE FROM retry_ids WHERE id=?', (item_id,))
            except Exception as error:
                failed.append(item_id)
                with db:
                    db.execute('''INSERT INTO retry_ids(id,reason) VALUES (?,?) ON CONFLICT(id)
                        DO UPDATE SET reason=excluded.reason,attempts=attempts+1''', (item_id, str(error)[:300]))
    return failed


def tail(db, max_items=5000, bootstrap=None, request=request_json, workers=6, log=print):
    maximum = int(request(f'{FIREBASE}/maxitem.json'))
    previous = get_meta(db, 'tail', {})
    cursor = previous.get('cursor')
    if cursor is None:
        snapshot = get_meta(db, 'snapshot', {})
        if snapshot.get('completed'):
            cursor = db.execute('SELECT coalesce(max(id),0) FROM nodes').fetchone()[0]
        elif bootstrap is not None:
            cursor = max(0, maximum - bootstrap)
        else:
            raise RuntimeError('Import a complete HF manifest before tailing, or explicitly use --bootstrap N for a partial recent collection.')
    target = min(maximum, cursor + max_items)
    for start in range(cursor + 1, target + 1, 100):
        end = min(start + 99, target)
        failed = fetch_ids(db, range(start, end + 1), request, workers)
        # Every failed ID is durably queued; cursor is a traversal cursor, NOT complete coverage.
        cursor = end
        with db:
            set_meta(db, 'tail', {'cursor': cursor, 'remoteMaxId': maximum, 'checkedAt': int(time.time()),
                                 'note': 'Retry IDs and null items must be checked separately.'})
        log(f'HN new IDs: {cursor:,}/{maximum:,}; {len(failed)} failed in batch')
    updates = request(f'{FIREBASE}/updates.json') or {}
    retries = [r[0] for r in db.execute('SELECT id FROM retry_ids ORDER BY attempts,id LIMIT 500')]
    overlap = range(max(1, cursor - 199), cursor + 1)
    fetch_ids(db, set(updates.get('items', [])) | set(retries) | set(overlap), request, workers)
    with db:
        set_meta(db, 'tail', {'cursor': cursor, 'remoteMaxId': maximum, 'checkedAt': int(time.time()),
                             'note': 'Updates are not a durable change log; periodically reconcile archive shards.'})
    return get_meta(db, 'tail')
