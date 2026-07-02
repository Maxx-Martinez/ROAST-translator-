import unittest

from src.eeg_electrode_translator.optimizer import BLOCKED, OPEN, CapLocation
from src.eeg_electrode_translator.targeting import (
    Target,
    rank_pair_montages,
    rank_single_sites,
    target_from_label,
)


class TargetingTests(unittest.TestCase):
    def setUp(self):
        self.locations = {
            "F3": CapLocation("F3", -2.0, 3.0, BLOCKED),
            "near": CapLocation("near", -2.1, 2.9, OPEN),
            "middle": CapLocation("middle", -1.0, 1.0, OPEN),
            "far": CapLocation("far", 3.0, -3.0, OPEN),
        }

    def test_target_can_be_resolved_from_blocked_label(self):
        target = target_from_label("F3", self.locations)

        self.assertEqual(target.name, "F3")
        self.assertEqual(target.xy, (-2.0, 3.0))

    def test_single_site_ranking_uses_open_sites_only(self):
        ranks = rank_single_sites(self.locations, Target("target", -2.0, 3.0))

        self.assertEqual(ranks[0].label, "near")
        self.assertNotIn("F3", [rank.label for rank in ranks])

    def test_pair_ranking_returns_anode_cathode_options(self):
        pairs = rank_pair_montages(
            self.locations,
            Target("target", -2.0, 3.0),
            top=2,
            candidate_anodes=2,
            ideal_separation=2.0,
            min_separation=0.5,
            max_separation=8.0,
        )

        self.assertEqual(pairs[0].rank, 1)
        self.assertNotEqual(pairs[0].anode, pairs[0].cathode)
        self.assertGreater(pairs[0].inter_electrode_distance, 0)


if __name__ == "__main__":
    unittest.main()
