import json
import tempfile
import unittest
from pathlib import Path

from pipeline.topic_predictions import decode_batch, open_cache, parse_predictions
from pipeline.topics import definitions, prediction_topics, publish, topic_payload
from pipeline.static_export import export_static
from pipeline.store import connect, ingest, merge_metadata, refresh_stats, resolve_threads, wiki_url


class PredictionTest(unittest.TestCase):
    def test_only_article_predictions_are_read_and_new_model_takes_precedence(self):
        tags = ['classification.prediction.drafttopic/STEM.Mathematics|999',
                'classification.ores.articletopic/STEM.Computing|950',
                'classification.prediction.articletopic/History_and_Society.History|904',
                'classification.prediction.articletopic/History_and_Society.History|700',
                'classification.prediction.articletopic/Invalid|nope',
                'classification.prediction.articletopic/Invalid|1001']
        self.assertEqual(parse_predictions([{'source': {'weighted_tags': tags}}]),
                         {'History_and_Society.History': 0.904})
        self.assertEqual(parse_predictions([{'source': {'weighted_tags': tags[:2]}}]), {'STEM.Computing': 0.95})
        self.assertEqual(parse_predictions(None), {})

    def test_normalization_redirects_missing_pages_and_unscored_pages(self):
        data = {'query': {'normalized': [{'from': 'norman_conquest', 'to': 'Norman conquest'}],
                         'redirects': [{'from': 'Norman conquest', 'to': 'Norman Conquest'}],
                         'pages': [{'title': 'Norman Conquest', 'cirrusdoc': [{'source': {'weighted_tags': [
                             'classification.prediction.articletopic/History_and_Society.History|771']}}]},
                                   {'title': 'Missing', 'missing': True}, {'title': 'Unscored'}]}}
        result = decode_batch(['norman_conquest', 'Missing', 'Unscored'], data)
        self.assertEqual(result[0], ('norman_conquest', 'Norman Conquest', 'predicted', {'History_and_Society.History': 0.771}))
        self.assertEqual([row[2] for row in result], ['predicted', 'missing', 'unscored'])
        with self.assertRaisesRegex(RuntimeError, 'lagged'):
            decode_batch([], {'error': {'info': 'lagged'}})

    def test_groups_are_multilabel_and_require_a_valid_probability(self):
        self.assertEqual(len(definitions()), 21)
        for topic in definitions():
            model = topic['models'][0] + ('Example' if topic['models'][0].endswith('.') else '')
            self.assertIn(topic['id'], prediction_topics({model: 0.5}))
            self.assertNotIn(topic['id'], prediction_topics({model: 0.499}))
        self.assertEqual(prediction_topics({'History and Society.History': 0.8, 'STEM.Physics': 0.9}), ['history', 'science'])
        for score in [True, '0.9', float('nan'), float('inf'), -1, 1.01]:
            self.assertEqual(prediction_topics({'STEM.Physics': score}), [])


class TopicPublicationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        db = connect(str(self.root / 'source.sqlite'))
        try:
            with db:
                for i, title in enumerate(['Feudalism', 'History of mathematics', 'Unscored']):
                    url = 'https://en.wikipedia.org/wiki/' + title.replace(' ', '_')
                    ingest(db, [{'id': i + 1, 'type': 'story', 'by': str(i), 'url': url}])
                    article = wiki_url(url)
                    if i == 1:
                        merge_metadata(db, article['id'], {**article, 'topicPredictions': {'STEM.Mathematics': 0.9}})
                resolve_threads(db)
                refresh_stats(db)
            self.catalog = self.root / 'catalog'
            self.manifest = export_static(db, self.catalog, article_size=1)
        finally:
            db.close()
        self.data = self.catalog / self.manifest['generation']
        self.cache = self.root / 'predictions.sqlite'
        db = open_cache(self.cache)
        with db:
            db.executemany('INSERT INTO predictions VALUES (?,?,?,?,?,?)', [
                ('en', 'Feudalism', 'Feudalism', 'predicted', json.dumps({'History_and_Society.History': 0.904}), 1900000000),
                ('en', 'Unscored', 'Unscored', 'unscored', '{}', 1900000000)])
        db.close()

    def tearDown(self):
        self.temporary.cleanup()

    def test_export_and_cached_publish_have_exact_memberships_counts_and_provenance(self):
        initial = self.manifest['topicIndex']
        self.assertEqual(initial['counts']['math'], 1)
        self.assertEqual(initial['coverage']['notChecked'], 2)
        cards = {file.name: file.read_bytes() for file in (self.data / 'articles').glob('*.json')}
        metadata = publish(self.catalog, self.cache)
        updated = json.loads((self.catalog / 'manifest.json').read_text())
        payload = json.loads((self.data / metadata['path']).read_text())
        articles = [json.loads(value)[0] for value in cards.values()]
        ordinal = {article['title']: article['_index'] for article in articles}
        self.assertEqual(payload['topics']['history'], [ordinal['Feudalism']])
        self.assertEqual(payload['topics']['math'], [ordinal['History of mathematics']])
        self.assertEqual(metadata['coverage']['checked'], 3)
        self.assertEqual(metadata['coverage']['predicted'], 2)
        self.assertEqual(metadata['coverage']['classified'], 2)
        self.assertEqual(metadata['coverage']['unscored'], 1)
        self.assertEqual(payload['source']['kind'], 'wikimedia-articletopic')
        self.assertEqual(updated['generation'], self.manifest['generation'])
        self.assertEqual(updated['dataBytes'], sum(file.stat().st_size for file in self.data.rglob('*.json')))
        self.assertEqual({file.name: file.read_bytes() for file in (self.data / 'articles').glob('*.json')}, cards)
        self.assertEqual(publish(self.catalog, self.cache), metadata, 'Republishing the same predictions is stable')
        saved = (self.catalog / 'manifest.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'lower coverage'):
            publish(self.catalog, self.root / 'nonexistent.sqlite')
        self.assertEqual((self.catalog / 'manifest.json').read_bytes(), saved)

    def test_incomplete_or_corrupt_cards_cannot_replace_the_manifest(self):
        saved = (self.catalog / 'manifest.json').read_bytes()
        card = self.data / 'articles/0.json'
        value = json.loads(card.read_text())
        value[0]['_index'] = 99
        card.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'article order'):
            publish(self.catalog, self.cache)
        self.assertEqual((self.catalog / 'manifest.json').read_bytes(), saved)
        card.unlink()
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            topic_payload(self.data, self.manifest, self.cache)


if __name__ == '__main__':
    unittest.main()
