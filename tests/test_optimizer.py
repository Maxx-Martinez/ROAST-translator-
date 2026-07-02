import math

import unittest

from src.eeg_electrode_translator.optimizer import (
    BLOCKED,
    OPEN,
    CapLocation,
    angle_delta,
    find_candidate_montages,
)


class OptimizerTests(unittest.TestCase):
    def test_angle_delta_wraps_across_zero(self):
        self.assertTrue(math.isclose(angle_delta(0.1, (2 * math.pi) - 0.1), 0.2))

    def test_keeps_all_open_montage_unchanged(self):
        locations = {
            f"A{i}": CapLocation(f"A{i}", float(i), 0.0, OPEN)
            for i in range(5)
        }

        candidates = find_candidate_montages(["A0", "A1", "A2", "A3", "A4"], locations)

        self.assertEqual(candidates[0].labels, ("A0", "A1", "A2", "A3", "A4"))
        self.assertEqual(candidates[0].score, 0)
        self.assertEqual(candidates[0].replacements, ())

    def test_replaces_only_blocked_sites_with_open_sites(self):
        locations = {
            "F3": CapLocation("F3", -2.0, 3.0, BLOCKED),
            "F4": CapLocation("F4", 2.0, 3.0, OPEN),
            "Cz": CapLocation("Cz", 0.0, 0.0, OPEN),
            "CP1": CapLocation("CP1", -0.8, -1.2, OPEN),
            "P2": CapLocation("P2", 0.8, -2.5, OPEN),
            "FCC3h": CapLocation("FCC3h", -2.1, 2.9, OPEN),
            "FarAway": CapLocation("FarAway", 99.0, 99.0, OPEN),
        }

        candidates = find_candidate_montages(["F3", "F4", "Cz", "CP1", "P2"], locations)

        self.assertEqual(candidates[0].labels, ("FCC3h", "F4", "Cz", "CP1", "P2"))
        self.assertEqual(candidates[0].replacements, (("F3", "FCC3h"),))

    def test_replacement_pool_keeps_search_responsive(self):
        locations = {
            "F3": CapLocation("F3", -2.0, 3.0, BLOCKED),
            "F4": CapLocation("F4", 2.0, 3.0, BLOCKED),
            "Cz": CapLocation("Cz", 0.0, 0.0, OPEN),
            "CP1": CapLocation("CP1", -0.8, -1.2, OPEN),
            "P2": CapLocation("P2", 0.8, -2.5, OPEN),
            "near_left": CapLocation("near_left", -2.1, 2.9, OPEN),
            "near_right": CapLocation("near_right", 2.1, 2.9, OPEN),
            "far_left": CapLocation("far_left", -99.0, 99.0, OPEN),
            "far_right": CapLocation("far_right", 99.0, 99.0, OPEN),
        }

        candidates = find_candidate_montages(
            ["F3", "F4", "Cz", "CP1", "P2"],
            locations,
            replacement_pool_size=2,
        )

        self.assertEqual(candidates[0].labels[:2], ("near_left", "near_right"))

    def test_unknown_labels_are_rejected(self):
        locations = {
            f"A{i}": CapLocation(f"A{i}", float(i), 0.0, OPEN)
            for i in range(5)
        }

        with self.assertRaisesRegex(ValueError, "Unknown cap label"):
            find_candidate_montages(["A0", "A1", "A2", "A3", "missing"], locations)

    def test_requires_five_montage_labels(self):
        with self.assertRaisesRegex(ValueError, "exactly 5"):
            find_candidate_montages(["A0"], {})


if __name__ == "__main__":
    unittest.main()
