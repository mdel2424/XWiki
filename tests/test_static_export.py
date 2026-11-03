import json
import tempfile
import unittest
from pathlib import Path

from pipeline.static_export import export_static
from pipeline.store import connect, ingest, merge_metadata, refresh_stats, resolve_threads, wiki_url


class StaticExportTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.db = connect(str(self.root / 'test.sqlite'))
        with self.db:
            ingest(self.db, [
                {'id': 1, 'type': 'story', 'title': 'A discussion without a wiki link'},
                {'id': 2, 'type': 'comment', 'parent': 1, 'by': 'a', 'time': 1700000000, 'text': '<a href="https://en.wikipedia.org/wiki/Earth">Earth</a>'},
                {'id': 3, 'type': 'comment', 'parent': 2, 'by': 'b', 'time': 1700000001, 'text': '<a href="https://en.wikipedia.org/wiki/Earth">Earth again</a>'},
                {'id': 4, 'type': 'story', 'by': 'c', 'title': 'Moon discussion', 'url': 'https://en.wikipedia.org/wiki/Moon'},
            ])
            resolve_threads(self.db)
            refresh_stats(self.db)
        self.output = self.root / 'catalog'

    def tearDown(self):
        self.db.close()
        self.temporary.cleanup()

    def test_full_export_has_precise_context_ranges_and_global_counts(self):
        manifest = export_static(self.db, self.output, article_size=1, context_size=1, rank_size=1)
        data = self.output / manifest['generation']
        first = json.loads((data / 'articles/0.json').read_text())[0]
        second = json.loads((data / 'articles/1.json').read_text())[0]
        self.assertEqual(manifest['articleCount'], 2)
        self.assertEqual(manifest['mentionCount'], 3)
        self.assertEqual(first['id'], 'en:Earth')
        self.assertEqual(first['context'], {'start': 0, 'count': 2})
        self.assertEqual(second['context'], {'start': 2, 'count': 1})
        self.assertEqual(first['metrics']['distinctLinkers'], 2)
        self.assertEqual(json.loads((data / 'context/0.json').read_text())[0]['storyId'], '1')
        self.assertEqual(json.loads((data / 'context/0.json').read_text())[0]['text'], 'Earth again')
        self.assertEqual(manifest['dataBytes'], sum(p.stat().st_size for p in data.rglob('*.json')))
        self.assertFalse(manifest['coverage']['exportLimited'])

    def test_budget_failure_preserves_previous_complete_export(self):
        first = export_static(self.db, self.output)
        with self.assertRaisesRegex(ValueError, 'budget'):
            export_static(self.db, self.output, max_bytes=1)
        self.assertEqual(json.loads((self.output / 'manifest.json').read_text())['generation'], first['generation'])
        self.assertTrue((self.output / first['generation']).is_dir())

    def test_refuses_to_overwrite_unrelated_files_or_export_an_empty_catalogue(self):
        self.output.mkdir()
        (self.output / 'keep.txt').write_text('user file')
        with self.assertRaisesRegex(ValueError, 'not a generated'):
            export_static(self.db, self.output)
        self.assertEqual((self.output / 'keep.txt').read_text(), 'user file')
        other = connect(str(self.root / 'empty.sqlite'))
        try:
            with self.assertRaisesRegex(ValueError, 'No HN-linked'):
                export_static(other, self.root / 'empty-export')
        finally:
            other.close()

    def test_limited_export_and_redirect_lookup_are_explicit(self):
        earth = wiki_url('https://en.wikipedia.org/wiki/Earth')
        with self.db:
            self.db.execute('INSERT INTO aliases VALUES (?,?)', ('en:Terra', earth['id']))
        manifest = export_static(self.db, self.output, limit=1)
        self.assertTrue(manifest['coverage']['exportLimited'])
        self.assertEqual(manifest['articleCount'], 1)
        lookups = {}
        for file in (self.output / manifest['generation'] / 'ids').glob('*.json'):
            lookups.update(json.loads(file.read_text()))
        self.assertEqual(lookups['en:Terra'], lookups['en:Earth'])


if __name__ == '__main__':
    unittest.main()
