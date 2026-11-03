import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from pipeline.ranking import refresh_rising
from pipeline.static_export import export_static
from pipeline.store import connect, ingest, six_months_ago


class RankingTest(unittest.TestCase):
    def test_six_month_ranking_matches_export_and_preserves_all_time_top(self):
        now = int(datetime(2026, 10, 31, 12, tzinfo=timezone.utc).timestamp())
        since = six_months_ago(now)
        self.assertEqual(datetime.fromtimestamp(since, timezone.utc).isoformat(), '2026-04-30T12:00:00+00:00')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db = connect(str(root / 'test.sqlite'))
            try:
                records = [{'id': i + 1, 'type': 'story', 'by': str(i), 'time': since - 1,
                            'url': 'https://en.wikipedia.org/wiki/Earth'} for i in range(10)]
                records += [
                    {'id': 20, 'type': 'story', 'by': 'alice', 'time': since, 'url': 'https://en.wikipedia.org/wiki/Moon'},
                    {'id': 21, 'type': 'story', 'by': 'alice', 'time': now, 'url': 'https://en.wikipedia.org/wiki/Moon'},
                    {'id': 22, 'type': 'story', 'by': 'bob', 'time': now, 'url': 'https://en.wikipedia.org/wiki/Moon'},
                    {'id': 23, 'type': 'story', 'by': 'future', 'time': now + 86400, 'url': 'https://en.wikipedia.org/wiki/Mars'},
                ]
                with db:
                    ingest(db, records)
                with patch('pipeline.static_export.time.time', return_value=now):
                    original = export_static(db, root / 'catalog', article_size=1, context_size=2, rank_size=1)
                catalogue = root / 'catalog'
                generation = catalogue / original['generation']
                first = (generation / 'articles/0.json').read_bytes()
                top = json.loads(first)[0]
                self.assertEqual(top['title'], 'Earth')
                self.assertEqual(top['metrics']['distinctLinkers'], 10)
                self.assertEqual(top['metrics']['recentLinkers'], 0)
                self.assertEqual(original['risingWindowMonths'], 6)
                self.assertEqual(original['risingCount'], 1)
                moon = json.loads((generation / 'articles/1.json').read_text())[0]
                self.assertEqual(moon['metrics']['recentLinkers'], 2)
                self.assertEqual(moon['metrics']['recentMentionCount'], 3)
                updated = refresh_rising(catalogue, now=now)
                self.assertEqual(updated['risingCount'], 1)
                self.assertEqual(updated['risingSince'], since)
                self.assertEqual(json.loads((generation / updated['risingPath'] / '0.json').read_text()), [moon['_index']])
                self.assertEqual((generation / 'articles/0.json').read_bytes(), first)
                self.assertEqual(updated['generation'], original['generation'])
                self.assertTrue((generation / 'rising/0.json').exists(), 'Old clients can finish reading their original rank files')
                self.assertEqual(updated['dataBytes'], sum(p.stat().st_size for p in generation.rglob('*.json')))
                saved = (catalogue / 'manifest.json').read_bytes()
                bad = json.loads(first)
                bad[0]['context']['start'] = 999
                (generation / 'articles/0.json').write_text(json.dumps(bad))
                with self.assertRaisesRegex(ValueError, 'context offsets'):
                    refresh_rising(catalogue, now=now)
                self.assertEqual((catalogue / 'manifest.json').read_bytes(), saved)
                self.assertEqual(list(catalogue.glob('.rising-build-*')), [])
            finally:
                db.close()


if __name__ == '__main__':
    unittest.main()
