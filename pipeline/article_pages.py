"""Identify Wikimedia navigation main pages using Wikidata's Q5296 sitelinks."""
import json
import re
import unicodedata
from pathlib import Path

MAIN_PAGES = json.loads((Path(__file__).resolve().parent.parent / 'src/wiki-main-pages.json').read_text())['pages']


def is_main_page(lang, title):
    def normalize(value):
        return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', value or '').replace('_', ' ')).strip().lower()
    return bool(title and lang in MAIN_PAGES and normalize(title) == normalize(MAIN_PAGES[lang]))
