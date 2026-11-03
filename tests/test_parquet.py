"""Real DuckDB/Parquet regression tests; run in the pipeline virtualenv after setup."""
import importlib.util
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pipeline.sources import parquet_batches
from pipeline.store import connect, ingest, refresh_stats, resolve_threads
from pipeline.api import route

HAS_DUCKDB = importlib.util.find_spec('duckdb') is not None


@unittest.skipUnless(HAS_DUCKDB, 'Run with .venv/bin/python after npm run data:setup for real Parquet checks')
class ParquetTest(unittest.TestCase):
    def setUp(self):
        import duckdb
        self.duckdb = duckdb
        self.temporary = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temporary.cleanup()

    def fixture(self, times):
        file = Path(self.temporary.name) / 'items.parquet'
        source = self.duckdb.connect()
        try:
            # Numeric HN type, zoned timestamps and optional fields match the HF schema.
            source.execute(f'''CREATE TABLE items AS SELECT
                (row_number() OVER ())::BIGINT AS id, 'fixture-user' AS "by", value AS time,
                NULL::BIGINT AS parent, 1::TINYINT AS type, 'Earth' AS title,
                '' AS text, 'https://en.wikipedia.org/wiki/Earth' AS url
                FROM (VALUES {times}) t(value)''')
            source.execute("COPY items TO '" + str(file).replace("'", "''") + "' (FORMAT PARQUET)")
        finally:
            source.close()
        return str(file)

    def test_zoned_timestamps_decode_to_utc_seconds_before_python_fetch(self):
        file = self.fixture("(TIMESTAMPTZ '2026-01-01 05:30:00+05:30'), (TIMESTAMPTZ '2025-12-31 19:00:00-05:00')")
        batches = list(parquet_batches(file, batch_size=1))
        expected = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp())
        self.assertEqual(len(batches), 2)
        self.assertEqual([batch[0]['time'] for batch in batches], [expected, expected])
        self.assertTrue(all(isinstance(batch[0]['time'], int) for batch in batches))
        self.assertIsNone(batches[0][0]['score'])
        self.assertEqual(list(parquet_batches(file, offset=1))[0][0]['id'], 2)
        db = connect(str(Path(self.temporary.name) / 'archive.sqlite'))
        try:
            with db:
                for batch in batches:
                    ingest(db, batch)
                resolve_threads(db)
                refresh_stats(db, now=expected + 100)
            code, payload = route(db, '/api/articles/en%3AEarth')
            self.assertEqual(code, 200)
            self.assertEqual(payload['metrics']['mentionCount'], 2)
            self.assertEqual(payload['metrics']['distinctLinkers'], 1)
            self.assertEqual(payload['mentions'][0]['createdAt'], expected)
        finally:
            db.close()

    def test_naive_and_integer_timestamps_stay_compatible(self):
        file = self.fixture("(TIMESTAMP '2026-01-01 00:00:00')")
        self.assertEqual(list(parquet_batches(file))[0][0]['time'], 1767225600)
        file = self.fixture('(1767225600::BIGINT)')
        self.assertEqual(list(parquet_batches(file))[0][0]['time'], 1767225600)


if __name__ == '__main__':
    unittest.main()
