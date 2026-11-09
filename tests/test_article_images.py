import unittest
from pipeline.article_images import first_article_image, fetch_article_image


class ArticleImageTest(unittest.TestCase):
    def test_first_substantial_image_uses_reading_order_and_skips_notice_icons(self):
        html = '''<div class="mw-parser-output"><table class="ambox"><tr><td>
        <img src="//thumb.wikimedia.org/wikipedia/commons/a/aa/Notice.png" width="200" height="200">
        </td></tr></table><img src="//thumb.wikimedia.org/wikipedia/commons/a/aa/Tiny.png" width="20" height="20">
        <figure><img src="//thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Z_diagram.svg/320px-Z_diagram.svg.png" width="320" height="220"></figure>
        <figure><img src="//thumb.wikimedia.org/wikipedia/commons/a/ab/A_diagram.png" width="320" height="220"></figure></div>'''
        self.assertEqual(first_article_image(html)['file'], 'Z_diagram.svg')
        self.assertIsNone(first_article_image('<div class="navbox"><img src="//upload.wikimedia.org/wikipedia/commons/a/ab/Nav.png" width="300" height="300"></div>'))
        self.assertIsNone(first_article_image('<img src="https://evil.example/tracker.png" width="300" height="300">'))

    def test_imageinfo_resolution_and_missing_images_are_nonfatal(self):
        def request(url):
            if 'action=parse' in url:
                return {'parse': {'text': '<img src="//thumb.wikimedia.org/wikipedia/commons/a/ab/Diagram.png" width="320" height="220">'}}
            self.assertIn('iiurlwidth=960', url)
            return {'query': {'pages': [{'imageinfo': [{'thumburl': 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Diagram.png'}]}]}}
        self.assertEqual(fetch_article_image('en', 'Topic', request), 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Diagram.png')
        self.assertEqual(fetch_article_image('en', 'Empty', lambda url: {'parse': {'text': '<p>No images.</p>'}}), '')
