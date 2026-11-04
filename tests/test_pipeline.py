import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote

from pipeline.api import route
from pipeline.metadata import enrich
from pipeline.sources import fetch_ids, sync_snapshot, tail
from pipeline.store import (connect, ingest, resolve_threads, refresh_stats, merge_metadata,
                            get_meta, set_meta, missing_ranges, wiki_url, timestamp)

NOW = int(time.time())


def story(item_id=1, title='A thread without a Wikipedia link', **extra):
    return {'id': item_id, 'type': 'story', 'by': 'alice', 'time': NOW - 100, 'title': title, **extra}


def comment(item_id=3, parent=2, author='bob', title='Earth', **extra):
    return {'id': item_id, 'type': 2, 'by': author, 'parent': parent, 'time': NOW - 50,
            'text': f'<p>Read <a href="https://en.wikipedia.org/wiki/{title}">{title}</a>', **extra}


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = connect(str(Path(self.tmp.name) / 'test.sqlite'))

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def rebuild(self):
        with self.db:
            resolve_threads(self.db)
            refresh_stats(self.db, NOW)

    def test_nested_comments_resolve_through_non_wikipedia_parents(self):
        ingest(self.db, [comment(), {'id': 2, 'type': 2, 'parent': 1, 'text': 'No link'}, story()])
        self.rebuild()
        code, data = route(self.db, '/api/articles/en%3AEarth')
        self.assertEqual(code, 200)
        self.assertEqual(data['mentions'][0]['storyId'], '1')
        self.assertEqual(data['mentions'][0]['storyTitle'], 'A thread without a Wikipedia link')

    def test_repeated_items_and_repeated_linkers_do_not_inflate_counts(self):
        rows = [story(url='https://en.wikipedia.org/wiki/Earth'), comment(parent=1, author='alice'), comment(4, parent=1)]
        ingest(self.db, rows + rows)
        self.rebuild()
        data = route(self.db, '/api/articles/en%3AEarth')[1]
        self.assertEqual(data['metrics']['mentionCount'], 3)
        self.assertEqual(data['metrics']['distinctLinkers'], 2)

    def test_updates_and_deletions_replace_old_mentions(self):
        ingest(self.db, [story(), comment(parent=1)])
        ingest(self.db, [comment(parent=1, title='Moon')])
        self.rebuild()
        self.assertEqual(route(self.db, '/api/feed')[1]['articles'][0]['title'], 'Moon')
        ingest(self.db, [{'id': 3, 'deleted': True}])
        self.rebuild()
        self.assertEqual(route(self.db, '/api/feed')[1]['articles'], [])
        self.assertEqual(self.db.execute('SELECT root FROM nodes WHERE id=3').fetchone()[0], 1)

    def test_redirects_merge_mentions_and_remain_canonical_after_future_ingestion(self):
        ingest(self.db, [story(url='https://en.m.wikipedia.org/wiki/Bikeshedding'), comment(parent=1, title='Parkinson%27s_law_of_triviality')])
        canonical = wiki_url("https://en.wikipedia.org/wiki/Parkinson%27s_law_of_triviality")
        merge_metadata(self.db, 'en:Bikeshedding', {**canonical, 'extract': 'A law about trivial discussions', 'categories': ['Decision-making']})
        ingest(self.db, [comment(4, parent=1, title='Bikeshedding', author='carol')])
        self.rebuild()
        articles = route(self.db, '/api/feed?mode=top')[1]['articles']
        self.assertEqual(len(articles), 1)
        self.assertEqual(articles[0]['metrics']['mentionCount'], 3)
        self.assertEqual(articles[0]['metrics']['distinctLinkers'], 3)

    def test_rising_filters_old_data_and_search_uses_full_archive_fts(self):
        ingest(self.db, [story(url='https://en.wikipedia.org/wiki/Earth', time=NOW - 2 * 365 * 86400), comment(parent=1, title='Moon')])
        self.rebuild()
        self.assertEqual([a['title'] for a in route(self.db, '/api/feed?mode=rising')[1]['articles']], ['Moon'])
        self.assertEqual([a['title'] for a in route(self.db, '/api/feed?q=ear')[1]['articles']], ['Earth'])
        self.assertEqual(route(self.db, '/api/feed?q=%22%29%3BDROP%20TABLE%20nodes')[0], 200)
        self.assertEqual(route(self.db, '/api/feed?limit=-1')[0], 400)

    def test_context_is_paginated_without_losing_global_counts(self):
        ingest(self.db, [story(), *[comment(i, parent=1, author=f'user{i}') for i in range(2, 63)]])
        self.rebuild()
        first = route(self.db, '/api/articles/en%3AEarth')[1]
        second = route(self.db, f'/api/articles/en%3AEarth?cursor={first["nextCursor"]}')[1]
        self.assertEqual(len(first['mentions']), 50)
        self.assertEqual(len(second['mentions']), 11)
        self.assertEqual(first['metrics']['mentionCount'], 61)
        self.assertIsNone(second['nextCursor'])

    def test_snapshot_resume_commits_batches_and_pins_revision(self):
        files = [{'path': 'data/2026/2026-01.parquet', 'oid': 'file1'}, {'path': 'today/2026/02/01/00/00.parquet', 'oid': 'file2'}]
        def request(url):
            return {'sha': 'pinned-sha', 'lastModified': '2026-02-01'} if '/tree/' not in url else files
        fail = [True]
        offsets = []
        def batches(url, offset=0):
            self.assertIn('/resolve/pinned-sha/', url)
            if 'data/' in url:
                if offset == 0:
                    yield [story()]
            else:
                offsets.append(offset)
                if offset == 0:
                    yield [comment(2, parent=1)]
                if fail[0]:
                    fail[0] = False
                    raise RuntimeError('Interrupted download')
                yield [comment(3, parent=2, author='carol')]
        with self.assertRaisesRegex(RuntimeError, 'Interrupted'):
            sync_snapshot(self.db, request=request, page_request=lambda _: (files, None), batches=batches, log=lambda _: None)
        self.assertFalse(get_meta(self.db, 'snapshot')['completed'])
        completed = sync_snapshot(self.db, request=request, page_request=lambda _: (files, None), batches=batches, log=lambda _: None)
        self.assertTrue(completed['completed'])
        self.assertEqual(offsets, [0, 1])
        self.rebuild()
        self.assertEqual(route(self.db, '/api/articles/en%3AEarth')[1]['metrics']['mentionCount'], 2)

    def test_null_and_failed_official_records_stay_in_durable_retry_queue(self):
        def request(url):
            item_id = int(url.split('/')[-1].split('.')[0])
            if item_id == 2:
                return None
            if item_id == 3:
                raise RuntimeError('Network error')
            return story(item_id)
        failed = fetch_ids(self.db, [1, 2, 3], request=request)
        self.assertEqual(failed, [3])
        self.assertEqual({r['id'] for r in self.db.execute('SELECT * FROM retry_ids')}, {2, 3})
        fetch_ids(self.db, [2, 3], request=lambda url: story(int(url.split('/')[-1].split('.')[0])))
        self.assertEqual(self.db.execute('SELECT count(*) FROM retry_ids').fetchone()[0], 0)

    def test_tail_requires_completed_snapshot_or_explicit_partial_bootstrap(self):
        with self.assertRaisesRegex(RuntimeError, 'complete HF manifest'):
            tail(self.db, request=lambda url: 10)
        def request(url):
            if url.endswith('/maxitem.json'):
                return 5
            if url.endswith('/updates.json'):
                return {'items': [1]}
            item_id = int(url.split('/')[-1].split('.')[0])
            return story(item_id)
        value = tail(self.db, bootstrap=2, max_items=10, request=request, log=lambda _: None)
        self.assertEqual(value['cursor'], 5)
        self.assertEqual(self.db.execute('SELECT count(*) FROM nodes').fetchone()[0], 5)

    def test_gap_audit_finds_internal_holes_instead_of_assuming_max_id_coverage(self):
        ingest(self.db, [story(1), story(4), story(5), story(9)])
        self.assertEqual(missing_ranges(self.db), [[2, 3], [6, 8]])

    def test_metadata_collects_topics_and_resolves_redirects(self):
        ingest(self.db, [story(url='https://en.wikipedia.org/wiki/Bikeshedding')])
        self.rebuild()
        def request(url):
            self.assertIn('categories', unquote(url))
            self.assertIn('pilicense=any', url)
            return {'query': {'redirects': [{'from': 'Bikeshedding', 'to': "Parkinson's law of triviality"}], 'pages': [{
                'title': "Parkinson's law of triviality", 'extract': 'A law about trivial discussions',
                'categories': [{'title': 'Category:Decision-making'}], 'links': [{'title': 'Groupthink'}],
                'terms': {'description': ['An organizational observation']}}]}}
        with patch('pipeline.metadata.time.sleep'):
            enrich(self.db, request=request, log=lambda _: None)
        self.rebuild()
        value = route(self.db, '/api/feed')[1]['articles'][0]
        self.assertEqual(value['categories'], ['Decision-making'])
        self.assertEqual(value['related'], ['Groupthink'])
        self.assertTrue(value['metadataLoaded'])

    def test_api_validates_modes_and_preserves_unicode_article_ids(self):
        ingest(self.db, [story(url='https://fr.wikipedia.org/wiki/Th%C3%A9orie_des_jeux')])
        self.rebuild()
        self.assertEqual(route(self.db, '/api/articles/fr%3ATh%C3%A9orie%20des%20jeux')[0], 200)
        self.assertEqual(route(self.db, '/api/feed?mode=sql')[0], 400)
        self.assertEqual(route(self.db, '/api/articles/not-found')[0], 404)
        from datetime import datetime, timezone
        self.assertEqual(timestamp(datetime(2026, 1, 1)), int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()))

    def test_metadata_preserves_titles_with_encoded_fragment_characters(self):
        ingest(self.db, [story(url='https://en.wikipedia.org/wiki/C%23')])
        self.rebuild()
        with patch('pipeline.metadata.time.sleep'):
            enrich(self.db, request=lambda _: {'query': {'pages': [{'title': 'C#', 'extract': 'A programming language'}]}}, log=lambda _: None)
        self.rebuild()
        self.assertEqual(route(self.db, '/api/feed')[1]['articles'][0]['id'], 'en:C#')
        self.assertIsNotNone(wiki_url('https://en.wikipedia.org/wiki/100%25'))

    def test_for_you_draws_discovery_candidates_beyond_the_popular_page(self):
        ingest(self.db, [story(i, title=f'Article {i}', url=f'https://en.wikipedia.org/wiki/Article_{i}', time=NOW - 10) for i in range(1, 151)])
        self.rebuild()
        top = {a['id'] for a in route(self.db, '/api/feed?mode=top&limit=40')[1]['articles']}
        personal = route(self.db, '/api/feed?mode=for-you&limit=5&mix=42')[1]
        self.assertTrue(any(a['id'] not in top for a in personal['articles']))
        self.assertEqual(len({a['id'] for a in personal['articles']}), len(personal['articles']))
        self.assertEqual(personal, route(self.db, '/api/feed?mode=for-you&limit=5&mix=42')[1])
        another = route(self.db, '/api/feed?mode=for-you&limit=5&mix=9999')[1]
        self.assertNotEqual({a['id'] for a in personal['articles']}, {a['id'] for a in another['articles']})


if __name__ == '__main__':
    unittest.main()
