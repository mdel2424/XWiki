import unittest
from pipeline.wiki_audit import sustained_views


class SustainedReadershipTest(unittest.TestCase):
    def test_isolated_spikes_do_not_dominate_and_zero_is_not_unknown(self):
        values = {str(i): 100 for i in range(28)}
        values['27'] = 1000000
        self.assertEqual(sustained_views(values), (100, 28))
        self.assertEqual(sustained_views({str(i): 0 for i in range(14)}), (0, 14))
        self.assertEqual(sustained_views({'missing': None, 'invalid': True}), (None, 0))
        self.assertEqual(sustained_views({str(i): 10 for i in range(13)}), (None, 13))
