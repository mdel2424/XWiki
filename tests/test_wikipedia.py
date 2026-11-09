import json
import tempfile
import time
import unittest
from pathlib import Path

from pipeline.wikipedia import cache_db, decode, publish
from pipeline.static_export import export_static
from pipeline.store import connect, ingest, refresh_stats, resolve_threads


class WikipediaRankingTest(unittest.TestCase):
    def test_redirects_zero_scores_and_unavailable_data_are_distinct(self):
        def page(title, score):
            return {'title': title, 'cirrusdoc': [{'source': {'popularity_score': score}}]}
        data = {'query': {'normalized': [{'from': 'the_alias', 'to': 'The alias'}],
                          'redirects': [{'from': 'The alias', 'to': 'Actual'}], 'pages': [
                              page('Actual', 0), {'title': 'Missing', 'missing': True},
                              {'title': 'Unknown'}, page('Known', 0.0000025)]}}
        rows = decode(['the_alias', 'Missing', 'Unknown', 'Known'], data, 1900000000)
        self.assertEqual(rows[0][1:4], ('Actual', 'scored', 0))
        self.assertEqual(rows[1][2:4], ('missing', None))
        self.assertEqual(rows[2][2:4], ('unavailable', None))
        self.assertEqual(rows[3][2:4], ('scored', 0.0000025))
        for score in [True, '0.5', float('nan'), float('inf'), -1]:
            self.assertEqual(decode(['Invalid'], {'query': {'pages': [page('Invalid', score)]}}, 0)[0][2], 'unavailable')
        with self.assertRaisesRegex(RuntimeError, 'lagged'):
            decode([], {'error': {'info': 'lagged'}}, 0)

    def test_publication_is_complete_deterministic_and_preserves_cards_and_manifest_on_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db = connect(str(root / 'source.sqlite'))
            try:
                with db:
                    ingest(db, [{'id': i + 1, 'type': 'story', 'by': str(i), 'url': f'https://{lang}.wikipedia.org/wiki/' + title}
                                for i, (title, lang) in enumerate([('Quiet', 'en'), ('Popular', 'en'), ('Unknown', 'en'), ('Zero', 'en'), ('French', 'fr'), ('Alias', 'en')])])
                    resolve_threads(db)
                    refresh_stats(db)
                catalog = root / 'catalog'
                manifest = export_static(db, catalog, article_size=2)
            finally:
                db.close()
            cache = root / 'popularity.sqlite'
            db = cache_db(cache)
            try:
                with db:
                    db.execute('INSERT INTO project_traffic VALUES (?,?,?,?,?,?)', ('en', 200000000, 30, '2026-10-01', '2026-10-30', 1900000000))
                    db.execute('INSERT INTO project_traffic VALUES (?,?,?,?,?,?)', ('fr', 100, 30, '2026-10-01', '2026-10-30', 1900000000))
                    db.execute('INSERT INTO popularity VALUES (?,?,?,?,?,?)', ('fr', 'French', 'French', 'scored', .000001, 1900000000))
                    db.execute('INSERT INTO popularity VALUES (?,?,?,?,?,?)', ('en', 'Alias', 'Popular', 'scored', .000000003, 1900000000))
                    for title, value, status in [('Quiet', 0.000000002, 'scored'), ('Popular', 0.000000004, 'scored'), ('Unknown', None, 'unavailable'), ('Zero', 0, 'scored')]:
                        db.execute('INSERT INTO popularity VALUES (?,?,?,?,?,?)', ('en', title, title, status, value, 1900000000))
            finally:
                db.close()
            data_root = catalog / manifest['generation']
            cards = {file.name: file.read_bytes() for file in (data_root / 'articles').glob('*.json')}
            metadata = publish(catalog, cache)
            data = json.loads((data_root / metadata['path']).read_text())
            titles = {article['_index']: article['title'] for file in (data_root / 'articles').glob('*.json') for article in json.loads(file.read_text())}
            self.assertEqual([titles[i] for i in data['order']], ['Popular', 'Quiet', 'French', 'Zero', 'Unknown'])
            self.assertEqual(data['coverage']['checked'], 6)
            self.assertEqual(data['coverage']['scored'], 5)
            self.assertEqual(data['coverage']['ranked'], 5)
            self.assertEqual(data['coverage']['redirects'], 1)
            alias = next(i for i, title in titles.items() if title == 'Alias')
            self.assertEqual(data['redirects'][str(alias)], data['order'][0])
            self.assertEqual(data['projectTraffic']['en']['dailyViews'], 200000000)
            self.assertEqual(data['scores'][data['order'][0]], .8)
            self.assertEqual(publish(catalog, cache), metadata)
            updated = json.loads((catalog / 'manifest.json').read_text())
            self.assertEqual(updated['dataBytes'], sum(file.stat().st_size for file in data_root.rglob('*.json')))
            self.assertEqual({file.name: file.read_bytes() for file in (data_root / 'articles').glob('*.json')}, cards)
            db = cache_db(cache)
            with db:
                db.execute('INSERT INTO verified_readership VALUES (?,?,?,?,?)', ('en', 'Popular', 0, 28, int(time.time())))
            db.close()
            reviewed = publish(catalog, cache)
            reviewed_data = json.loads((data_root / reviewed['path']).read_text())
            self.assertEqual(titles[reviewed_data['order'][0]], 'Quiet')
            self.assertEqual(reviewed_data['scores'][data['order'][0]], 0, 'Measured zero overrides estimates from all redirect aliases')
            self.assertIn(data['order'][0], reviewed_data['reviewed'])
            saved = (catalog / 'manifest.json').read_bytes()
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                publish(catalog, root / 'missing.sqlite')
            self.assertEqual((catalog / 'manifest.json').read_bytes(), saved)
            file = data_root / 'articles/0.json'
            invalid = json.loads(file.read_text())
            invalid[0]['_index'] = 999
            file.write_text(json.dumps(invalid))
            with self.assertRaisesRegex(ValueError, 'article order'):
                publish(catalog, cache)
            self.assertEqual((catalog / 'manifest.json').read_bytes(), saved)


if __name__ == '__main__':
    unittest.main()
