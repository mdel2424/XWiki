import json
import tempfile
import unittest
from pathlib import Path
from pipeline.article_pages import is_main_page
from pipeline.store import wiki_url
from pipeline.wikipedia import cache_db, publish


class MainPageTest(unittest.TestCase):
    def test_multilingual_ingestion_excludes_navigation_without_excluding_articles_about_wikipedia(self):
        for lang, title in [('en', 'Main Page'), ('en', 'main_page'), ('ja', 'メインページ'), ('ru', 'Заглавная страница')]:
            self.assertTrue(is_main_page(lang, title))
            self.assertIsNone(wiki_url(f'https://{lang}.wikipedia.org/wiki/{title}'))
        for title in ['Wikipedia', 'Japanese Wikipedia', 'Main Page (film)']:
            self.assertFalse(is_main_page('en', title))
            self.assertIsNotNone(wiki_url(f'https://en.wikipedia.org/wiki/{title}'))

    def test_existing_main_pages_and_canonical_redirects_are_removed_from_published_ranks(self):
        with tempfile.TemporaryDirectory() as temporary:
            catalog = Path(temporary)
            generation = 'v-mainpages'
            root = catalog / generation
            (root / 'articles').mkdir(parents=True)
            entries = [('en', 'Main Page'), ('ja', 'メインページ'), ('ru', 'Заглавная страница'),
                       ('en', 'Landing'), ('en', 'Wikipedia'), ('en', 'Main Page (film)')]
            cards = [{'id': f'{lang}:{title}', 'lang': lang, 'title': title, '_index': i} for i, (lang, title) in enumerate(entries)]
            (root / 'articles/0.json').write_text(json.dumps(cards))
            (catalog / 'manifest.json').write_text(json.dumps({'kind': 'wikihack-static', 'version': 1, 'generation': generation, 'articleCount': len(cards), 'generatedAt': 1}))
            cache = catalog / 'cache.sqlite'
            db = cache_db(cache)
            with db:
                for lang in ['en', 'ja', 'ru']:
                    db.execute('INSERT INTO project_traffic VALUES (?,?,?,?,?,?)', (lang, 100, 30, None, None, 1))
                for i, (lang, title) in enumerate(entries):
                    canonical = 'Main Page' if title == 'Landing' else title
                    db.execute('INSERT INTO popularity VALUES (?,?,?,?,?,?)', (lang, title, canonical, 'scored', 1 if i < 4 else .01, 1))
            db.close()
            metadata = publish(catalog, cache)
            data = json.loads((root / metadata['path']).read_text())
            self.assertEqual(data['order'], [4, 5])
            self.assertEqual(data['excluded'], [0, 1, 2, 3])
            self.assertEqual(data['redirects'], {})
            self.assertEqual(metadata['coverage']['excluded'], 4)
            self.assertEqual(metadata['excludedIds'], [card['id'] for card in cards[:4]])
            self.assertEqual(len(data['order']) + len(data['redirects']) + len(data['excluded']), len(cards))
