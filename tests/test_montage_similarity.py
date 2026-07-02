import math
import unittest
import warnings

try:
    import pandas as pd
except ImportError:
    pd = None

if pd is not None:
    from src.eeg_electrode_translator import montage_similarity as ms


def shapely_available():
    try:
        import shapely  # noqa: F401
    except ImportError:
        return False
    return True


@unittest.skipIf(pd is None, "pandas is not installed locally")
class MontageSimilarityTests(unittest.TestCase):
    def setUp(self):
        self.coords = pd.DataFrame(
            [
                {"label": "F3", "x": -2.0, "y": 3.0, "status": "blocked"},
                {"label": "F4", "x": 2.0, "y": 3.0, "status": "blocked"},
                {"label": "FFC3h", "x": -2.1, "y": 2.5, "status": "open"},
                {"label": "FFC4h", "x": 2.1, "y": 2.5, "status": "open"},
                {"label": "FCC3h", "x": -2.0, "y": 1.5, "status": "open"},
                {"label": "FCC4h", "x": 2.0, "y": 1.5, "status": "open"},
            ]
        )

    def test_get_xy_rejects_missing_label(self):
        with self.assertRaisesRegex(ValueError, "Label not found"):
            ms.get_xy(self.coords, "missing")

    def test_angle_difference_uses_smallest_difference(self):
        self.assertEqual(ms.angle_difference_deg(10, 350), 20)
        self.assertEqual(ms.angle_difference_deg(0, 180), 180)

    def test_montage_angle_change_for_parallel_pairs(self):
        original = [(-2.0, 3.0), (2.0, 3.0)]
        candidate = [(-2.1, 2.5), (2.1, 2.5)]

        self.assertTrue(math.isclose(ms.montage_angle_change(original, candidate), 0))

    def test_distance_metrics_compare_corresponding_electrodes(self):
        original = [(-2.0, 3.0), (2.0, 3.0)]
        candidate = [(-2.0, 2.0), (2.0, 1.0)]

        self.assertEqual(ms.mean_distance_from_original(original, candidate), 1.5)
        self.assertEqual(ms.max_distance_from_original(original, candidate), 2.0)

    def test_symmetry_can_be_disabled_in_normalized_score(self):
        score = ms.normalized_score(
            angle_change_deg=0,
            mean_distance=0,
            percent_original_area_covered=100,
            percent_candidate_area_new=0,
            symmetry=99,
            use_symmetry=False,
        )

        self.assertEqual(score, 0)

    def test_non_open_candidate_warns_by_default(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            ms.validate_candidate_status(self.coords, ["F3"], strict_open=False)

        self.assertEqual(len(caught), 1)
        self.assertIn("should usually be 'open'", str(caught[0].message))

    def test_non_open_candidate_can_be_strict_error(self):
        with self.assertRaisesRegex(ValueError, "should usually be 'open'"):
            ms.validate_candidate_status(self.coords, ["F3"], strict_open=True)

    @unittest.skipUnless(shapely_available(), "Shapely is not installed locally")
    def test_score_candidate_montages_returns_ranked_dataframe(self):
        scores = ms.score_candidate_montages(
            coords=self.coords,
            original_labels=["F3", "F4"],
            candidate_montages=[
                ["FFC3h", "FFC4h"],
                ["FCC3h", "FCC4h"],
            ],
        )

        self.assertEqual(list(scores["rank"]), [1, 2])
        self.assertLessEqual(scores.iloc[0]["final_score"], scores.iloc[1]["final_score"])
        self.assertIn("percent_original_area_covered", scores.columns)


if __name__ == "__main__":
    unittest.main()
