from __future__ import annotations

import math
import itertools
import warnings
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

import pandas as pd


DEFAULT_WEIGHTS = {
    "angle": 0.20,
    "distance": 0.30,
    "coverage_loss": 0.30,
    "new_area": 0.15,
    "symmetry": 0.05,
}

DEFAULT_REPLACEMENT_WEIGHTS = {
    "distance": 0.20,
    "pairwise_distance": 0.16,
    "pairwise_angle": 0.10,
    "region_coverage_loss": 0.36,
    "footprint_coverage_loss": 0.06,
    "new_area": 0.07,
    "center_shift": 0.05,
}

DEFAULT_IMPORTANCE = {
    "distance": 6,
    "pairwise_distance": 5,
    "pairwise_angle": 4,
    "region_coverage_loss": 10,
    "footprint_coverage_loss": 2,
    "new_area": 2,
    "center_shift": 2,
}


@dataclass(frozen=True)
class AreaMetrics:
    original_area: float
    candidate_area: float
    overlap_area: float
    percent_original_area_covered: float
    new_area: float
    percent_candidate_area_new: float


@dataclass(frozen=True)
class RegionMetrics:
    original_region_area: float
    candidate_region_area: float
    region_overlap_area: float
    percent_original_region_covered: float
    new_region_area: float
    percent_candidate_region_new: float


def load_coords(csv_path: str | Path) -> pd.DataFrame:
    """Load cap coordinates from a CSV with label, x, y, and status columns."""
    coords = pd.read_csv(csv_path)
    required = {"label", "x", "y", "status"}
    missing = required - set(coords.columns)
    if missing:
        raise ValueError(f"Missing required coordinate columns: {sorted(missing)}")

    coords = coords.copy()
    coords["label"] = coords["label"].astype(str).str.strip()
    coords["status"] = coords["status"].astype(str).str.lower().str.strip()
    return coords


def get_xy(coords: pd.DataFrame, label: str) -> tuple[float, float]:
    """Return the x/y coordinate for a named cap location."""
    matches = coords.loc[coords["label"] == label]
    if matches.empty:
        raise ValueError(f"Label not found in coordinate table: {label}")
    if len(matches) > 1:
        raise ValueError(f"Duplicate label in coordinate table: {label}")

    row = matches.iloc[0]
    return (float(row["x"]), float(row["y"]))


def labels_to_points(
    coords: pd.DataFrame,
    labels: Sequence[str],
) -> list[tuple[float, float]]:
    return [get_xy(coords, label) for label in labels]


def validate_equal_lengths(
    original_labels: Sequence[str],
    candidate_labels: Sequence[str],
) -> None:
    if len(original_labels) != len(candidate_labels):
        raise ValueError(
            "Original and candidate montages must have the same number of electrodes"
        )


def validate_two_electrode_montage(points: Sequence[tuple[float, float]]) -> None:
    if len(points) != 2:
        raise ValueError("This metric currently supports only two-electrode montages")


def validate_candidate_status(
    coords: pd.DataFrame,
    candidate_labels: Sequence[str],
    strict_open: bool = False,
) -> None:
    for label in candidate_labels:
        matches = coords.loc[coords["label"] == label]
        if matches.empty:
            raise ValueError(f"Label not found in coordinate table: {label}")

        status = str(matches.iloc[0]["status"]).lower().strip()
        if status != "open":
            message = (
                f"Candidate site {label!r} has status {status!r}; "
                "candidate stimulation sites should usually be 'open'."
            )
            if strict_open:
                raise ValueError(message)
            warnings.warn(message, UserWarning, stacklevel=2)


def angle_of_vector(
    p1: tuple[float, float],
    p2: tuple[float, float],
) -> float:
    """Return vector angle in degrees from p1 to p2."""
    return math.degrees(math.atan2(p2[1] - p1[1], p2[0] - p1[0]))


def angle_difference_deg(angle1: float, angle2: float) -> float:
    """Smallest absolute undirected angle difference, from 0 to 180 degrees."""
    diff = abs(angle1 - angle2) % 360
    return min(diff, 360 - diff)


def montage_angle_change(
    original_points: Sequence[tuple[float, float]],
    candidate_points: Sequence[tuple[float, float]],
) -> float:
    validate_two_electrode_montage(original_points)
    validate_two_electrode_montage(candidate_points)
    original_angle = angle_of_vector(original_points[0], original_points[1])
    candidate_angle = angle_of_vector(candidate_points[0], candidate_points[1])
    return angle_difference_deg(original_angle, candidate_angle)


def point_distance(
    p1: tuple[float, float],
    p2: tuple[float, float],
) -> float:
    return math.hypot(p1[0] - p2[0], p1[1] - p2[1])


def paired_distances_from_original(
    original_points: Sequence[tuple[float, float]],
    candidate_points: Sequence[tuple[float, float]],
) -> list[float]:
    if len(original_points) != len(candidate_points):
        raise ValueError("Original and candidate point lists must have the same length")
    return [
        point_distance(original, candidate)
        for original, candidate in zip(original_points, candidate_points)
    ]


def mean_distance_from_original(
    original_points: Sequence[tuple[float, float]],
    candidate_points: Sequence[tuple[float, float]],
) -> float:
    distances = paired_distances_from_original(original_points, candidate_points)
    return sum(distances) / len(distances)


def max_distance_from_original(
    original_points: Sequence[tuple[float, float]],
    candidate_points: Sequence[tuple[float, float]],
) -> float:
    return max(paired_distances_from_original(original_points, candidate_points))


def _require_shapely():
    try:
        from shapely.geometry import MultiPoint, Point
        from shapely.ops import unary_union
    except ImportError as exc:
        raise ImportError(
            "Shapely is required for electrode area metrics. In Colab, run: "
            "!pip install shapely"
        ) from exc
    return MultiPoint, Point, unary_union


def electrode_area(
    points: Iterable[tuple[float, float]],
    electrode_radius: float,
):
    """Return the Shapely union of circular electrode footprints."""
    _, Point, unary_union = _require_shapely()
    circles = [Point(x, y).buffer(electrode_radius) for x, y in points]
    if not circles:
        raise ValueError("Cannot compute area for an empty montage")
    return unary_union(circles)


def area_overlap_metrics(
    original_points: Sequence[tuple[float, float]],
    candidate_points: Sequence[tuple[float, float]],
    electrode_radius: float = 0.45,
) -> AreaMetrics:
    original_shape = electrode_area(original_points, electrode_radius)
    candidate_shape = electrode_area(candidate_points, electrode_radius)
    overlap_area = original_shape.intersection(candidate_shape).area
    original_area = original_shape.area
    candidate_area = candidate_shape.area
    new_area = candidate_area - overlap_area

    return AreaMetrics(
        original_area=original_area,
        candidate_area=candidate_area,
        overlap_area=overlap_area,
        percent_original_area_covered=(overlap_area / original_area) * 100,
        new_area=new_area,
        percent_candidate_area_new=(new_area / candidate_area) * 100,
    )


def montage_region(
    points: Sequence[tuple[float, float]],
    region_buffer: float = 0.0,
):
    """Return the convex-hull region spanned by montage points.

    If the hull is degenerate, a tiny buffer is applied so area-based metrics
    remain defined.
    """
    MultiPoint, _, _ = _require_shapely()
    if len(points) < 3:
        raise ValueError("Montage region coverage requires at least 3 points")

    region = MultiPoint(points).convex_hull
    if region_buffer:
        region = region.buffer(region_buffer)
    if region.area == 0:
        region = region.buffer(1e-6)
    return region


def region_overlap_metrics(
    original_points: Sequence[tuple[float, float]],
    candidate_points: Sequence[tuple[float, float]],
    region_buffer: float = 0.0,
) -> RegionMetrics:
    original_region = montage_region(original_points, region_buffer=region_buffer)
    candidate_region = montage_region(candidate_points, region_buffer=region_buffer)
    overlap_area = original_region.intersection(candidate_region).area
    original_area = original_region.area
    candidate_area = candidate_region.area
    new_area = candidate_area - overlap_area

    return RegionMetrics(
        original_region_area=original_area,
        candidate_region_area=candidate_area,
        region_overlap_area=overlap_area,
        percent_original_region_covered=(overlap_area / original_area) * 100,
        new_region_area=new_area,
        percent_candidate_region_new=(new_area / candidate_area) * 100,
    )


def montage_center(points: Sequence[tuple[float, float]]) -> tuple[float, float]:
    if not points:
        raise ValueError("Cannot compute montage center for an empty montage")
    return (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )


def center_shift(
    original_points: Sequence[tuple[float, float]],
    candidate_points: Sequence[tuple[float, float]],
) -> float:
    return point_distance(montage_center(original_points), montage_center(candidate_points))


def mean_pairwise_distance_change(
    original_points: Sequence[tuple[float, float]],
    candidate_points: Sequence[tuple[float, float]],
) -> float:
    if len(original_points) != len(candidate_points):
        raise ValueError("Original and candidate point lists must have the same length")
    if len(original_points) < 2:
        return 0

    changes = []
    for i in range(len(original_points)):
        for j in range(i + 1, len(original_points)):
            original_distance = point_distance(original_points[i], original_points[j])
            candidate_distance = point_distance(candidate_points[i], candidate_points[j])
            changes.append(abs(original_distance - candidate_distance))
    return sum(changes) / len(changes)


def mean_pairwise_angle_change_deg(
    original_points: Sequence[tuple[float, float]],
    candidate_points: Sequence[tuple[float, float]],
) -> float:
    if len(original_points) != len(candidate_points):
        raise ValueError("Original and candidate point lists must have the same length")
    if len(original_points) < 2:
        return 0

    changes = []
    for i in range(len(original_points)):
        for j in range(i + 1, len(original_points)):
            original_angle = angle_of_vector(original_points[i], original_points[j])
            candidate_angle = angle_of_vector(candidate_points[i], candidate_points[j])
            changes.append(angle_difference_deg(original_angle, candidate_angle))
    return sum(changes) / len(changes)


def status_for_label(coords: pd.DataFrame, label: str) -> str:
    matches = coords.loc[coords["label"] == label]
    if matches.empty:
        raise ValueError(f"Label not found in coordinate table: {label}")
    return str(matches.iloc[0]["status"]).lower().strip()


def nearest_open_labels(
    coords: pd.DataFrame,
    target_label: str,
    pool_size: int = 10,
    exclude_labels: set[str] | None = None,
    max_replacement_distance: float | None = None,
) -> list[str]:
    exclude_labels = set(exclude_labels or [])
    target_xy = get_xy(coords, target_label)
    open_df = coords.loc[coords["status"] == "open"].copy()
    open_df = open_df.loc[~open_df["label"].isin(exclude_labels)]
    open_df["distance_to_original"] = open_df.apply(
        lambda row: point_distance(target_xy, (float(row["x"]), float(row["y"]))),
        axis=1,
    )
    if max_replacement_distance is not None:
        open_df = open_df.loc[
            open_df["distance_to_original"] <= max_replacement_distance
        ]
    open_df = open_df.sort_values("distance_to_original")
    return open_df.head(pool_size)["label"].tolist()


def replacement_normalized_score(
    mean_distance: float,
    pairwise_distance_change: float,
    pairwise_angle_change_deg: float,
    percent_original_region_covered: float,
    percent_original_footprint_covered: float,
    percent_candidate_area_new: float,
    center_shift_value: float,
    weights: dict[str, float] | None = None,
) -> float:
    weights = DEFAULT_REPLACEMENT_WEIGHTS if weights is None else weights
    distance_penalty = min(mean_distance / 2.0, 1)
    pairwise_distance_penalty = min(pairwise_distance_change / 2.0, 1)
    pairwise_angle_penalty = min(pairwise_angle_change_deg / 90.0, 1)
    region_coverage_loss_penalty = (100 - percent_original_region_covered) / 100
    footprint_coverage_loss_penalty = (100 - percent_original_footprint_covered) / 100
    new_area_penalty = percent_candidate_area_new / 100
    center_shift_penalty = min(center_shift_value / 2.0, 1)

    return (
        weights["distance"] * distance_penalty
        + weights["pairwise_distance"] * pairwise_distance_penalty
        + weights["pairwise_angle"] * pairwise_angle_penalty
        + weights["region_coverage_loss"] * region_coverage_loss_penalty
        + weights["footprint_coverage_loss"] * footprint_coverage_loss_penalty
        + weights["new_area"] * new_area_penalty
        + weights["center_shift"] * center_shift_penalty
    )


def importance_to_weights(
    importance: dict[str, float] | None = None,
) -> dict[str, float]:
    """Convert 0-10 importance ratings into normalized scoring weights."""
    merged = DEFAULT_IMPORTANCE.copy()
    if importance is not None:
        unknown = set(importance) - set(merged)
        if unknown:
            raise ValueError(f"Unknown importance keys: {sorted(unknown)}")
        merged.update(importance)

    for key, value in merged.items():
        if value < 0 or value > 10:
            raise ValueError(f"Importance for {key!r} must be between 0 and 10")

    total = sum(merged.values())
    if total == 0:
        raise ValueError("At least one importance value must be greater than 0")

    return {key: value / total for key, value in merged.items()}


def replacement_status_table(
    coords: pd.DataFrame,
    original_labels: Sequence[str],
) -> pd.DataFrame:
    rows = []
    for label in original_labels:
        rows.append(
            {
                "label": label,
                "status": status_for_label(coords, label),
                "action": "keep" if status_for_label(coords, label) == "open" else "replace",
            }
        )
    return pd.DataFrame(rows)


def run_replacement_workflow(
    coords: pd.DataFrame,
    original_labels: Sequence[str],
    top_n: int = 10,
    nearby_pool_size: int = 10,
    electrode_radius: float = 0.45,
    region_buffer: float = 0.0,
    max_replacement_distance: float | None = None,
    require_minimum_coverage: bool = True,
    minimum_original_region_covered: float = 85,
    importance: dict[str, float] | None = None,
) -> dict[str, object]:
    """One-call wrapper for the automatic replacement workflow.

    Importance values are 0-10 ratings. Higher means the metric matters more.
    The ratings are normalized into the weights used by the scorer.
    """
    weights = importance_to_weights(importance)
    min_coverage = (
        minimum_original_region_covered if require_minimum_coverage else None
    )
    status_table = replacement_status_table(coords, original_labels)
    suggestions = suggest_replacement_montages(
        coords=coords,
        original_labels=original_labels,
        top_n=top_n,
        nearby_pool_size=nearby_pool_size,
        electrode_radius=electrode_radius,
        region_buffer=region_buffer,
        max_replacement_distance=max_replacement_distance,
        min_original_region_covered=min_coverage,
        weights=weights,
    )

    return {
        "settings": {
            "top_n": top_n,
            "nearby_pool_size": nearby_pool_size,
            "electrode_radius": electrode_radius,
            "region_buffer": region_buffer,
            "max_replacement_distance": max_replacement_distance,
            "require_minimum_coverage": require_minimum_coverage,
            "minimum_original_region_covered": minimum_original_region_covered,
            "importance": DEFAULT_IMPORTANCE.copy() if importance is None else importance,
            "weights": weights,
        },
        "status_table": status_table,
        "suggestions": suggestions,
    }


def score_replacement_montage(
    coords: pd.DataFrame,
    original_labels: Sequence[str],
    candidate_labels: Sequence[str],
    electrode_radius: float = 0.45,
    region_buffer: float = 0.0,
    weights: dict[str, float] | None = None,
) -> dict[str, object]:
    validate_equal_lengths(original_labels, candidate_labels)
    original_points = labels_to_points(coords, original_labels)
    candidate_points = labels_to_points(coords, candidate_labels)

    mean_distance = mean_distance_from_original(original_points, candidate_points)
    max_distance = max_distance_from_original(original_points, candidate_points)
    pairwise_distance_change = mean_pairwise_distance_change(
        original_points, candidate_points
    )
    pairwise_angle_change = mean_pairwise_angle_change_deg(
        original_points, candidate_points
    )
    area_metrics = area_overlap_metrics(
        original_points,
        candidate_points,
        electrode_radius=electrode_radius,
    )
    region_metrics = region_overlap_metrics(
        original_points,
        candidate_points,
        region_buffer=region_buffer,
    )
    center_shift_value = center_shift(original_points, candidate_points)
    final_score = replacement_normalized_score(
        mean_distance=mean_distance,
        pairwise_distance_change=pairwise_distance_change,
        pairwise_angle_change_deg=pairwise_angle_change,
        percent_original_region_covered=region_metrics.percent_original_region_covered,
        percent_original_footprint_covered=area_metrics.percent_original_area_covered,
        percent_candidate_area_new=area_metrics.percent_candidate_area_new,
        center_shift_value=center_shift_value,
        weights=weights,
    )

    return {
        "candidate_montage": ", ".join(candidate_labels),
        "mean_distance_from_original": mean_distance,
        "max_distance_from_original": max_distance,
        "pairwise_distance_change": pairwise_distance_change,
        "pairwise_angle_change_deg": pairwise_angle_change,
        "percent_original_region_covered": region_metrics.percent_original_region_covered,
        "percent_candidate_region_new": region_metrics.percent_candidate_region_new,
        "new_region_area": region_metrics.new_region_area,
        "percent_original_area_covered": area_metrics.percent_original_area_covered,
        "percent_candidate_area_new": area_metrics.percent_candidate_area_new,
        "new_area": area_metrics.new_area,
        "center_shift": center_shift_value,
        "final_score": final_score,
    }


def suggest_replacement_montages(
    coords: pd.DataFrame,
    original_labels: Sequence[str],
    top_n: int = 10,
    nearby_pool_size: int = 10,
    electrode_radius: float = 0.45,
    region_buffer: float = 0.0,
    max_replacement_distance: float | None = None,
    min_original_region_covered: float | None = None,
    weights: dict[str, float] | None = None,
) -> pd.DataFrame:
    if len(original_labels) == 0:
        raise ValueError("original_labels cannot be empty")

    # Validate all original labels before generating candidates.
    for label in original_labels:
        get_xy(coords, label)

    kept_indices = []
    blocked_indices = []
    kept_originals = []
    fixed_candidate: list[str | None] = []

    for index, label in enumerate(original_labels):
        if status_for_label(coords, label) == "open":
            kept_indices.append(index)
            kept_originals.append(label)
            fixed_candidate.append(label)
        else:
            blocked_indices.append(index)
            fixed_candidate.append(None)

    if not blocked_indices:
        row = score_replacement_montage(
            coords,
            original_labels,
            original_labels,
            electrode_radius=electrode_radius,
            region_buffer=region_buffer,
            weights=weights,
        )
        row.update(
            {
                "replacements": "none",
                "kept_originals": ", ".join(kept_originals),
                "blocked_originals": "none",
            }
        )
        results = pd.DataFrame([row])
        results.insert(0, "rank", [1])
        return results

    kept_label_set = set(kept_originals)
    replacement_pools = []
    for blocked_index in blocked_indices:
        original_label = original_labels[blocked_index]
        pool = nearest_open_labels(
            coords,
            target_label=original_label,
            pool_size=nearby_pool_size,
            exclude_labels=kept_label_set,
            max_replacement_distance=max_replacement_distance,
        )
        if not pool:
            raise ValueError(f"No open replacement candidates found for {original_label}")
        replacement_pools.append(pool)

    rows = []
    for replacements in itertools.product(*replacement_pools):
        if len(set(replacements)) != len(replacements):
            continue
        if kept_label_set.intersection(replacements):
            continue

        candidate = fixed_candidate.copy()
        for blocked_index, replacement in zip(blocked_indices, replacements):
            candidate[blocked_index] = replacement

        candidate_labels = [label for label in candidate if label is not None]
        if len(set(candidate_labels)) != len(candidate_labels):
            continue

        row = score_replacement_montage(
            coords,
            original_labels,
            candidate_labels,
            electrode_radius=electrode_radius,
            region_buffer=region_buffer,
            weights=weights,
        )
        if (
            min_original_region_covered is not None
            and row["percent_original_region_covered"] < min_original_region_covered
        ):
            continue
        row.update(
            {
                "replacements": "; ".join(
                    f"{original_labels[index]}->{replacement}"
                    for index, replacement in zip(blocked_indices, replacements)
                ),
                "kept_originals": ", ".join(kept_originals) if kept_originals else "none",
                "blocked_originals": ", ".join(original_labels[index] for index in blocked_indices),
            }
        )
        rows.append(row)

    if not rows:
        if min_original_region_covered is not None:
            raise ValueError(
                "No valid replacement montages were generated that cover at least "
                f"{min_original_region_covered}% of the original montage region"
            )
        raise ValueError("No valid replacement montages were generated")

    results = pd.DataFrame(rows).sort_values("final_score").reset_index(drop=True)
    results.insert(0, "rank", range(1, len(results) + 1))
    return results.head(top_n)


def symmetry_error(
    candidate_points: Sequence[tuple[float, float]],
    symmetry_axis_x: float = 0,
) -> float:
    validate_two_electrode_montage(candidate_points)
    x1 = candidate_points[0][0] - symmetry_axis_x
    x2 = candidate_points[1][0] - symmetry_axis_x
    return abs(x1 + x2)


def normalized_score(
    angle_change_deg: float,
    mean_distance: float,
    percent_original_area_covered: float,
    percent_candidate_area_new: float,
    symmetry: float,
    weights: dict[str, float] | None = None,
    use_symmetry: bool = True,
) -> float:
    weights = DEFAULT_WEIGHTS if weights is None else weights
    angle_penalty = min(angle_change_deg / 90, 1)
    distance_penalty = min(mean_distance / 2.0, 1)
    coverage_loss_penalty = (100 - percent_original_area_covered) / 100
    new_area_penalty = percent_candidate_area_new / 100
    symmetry_penalty = min(symmetry / 2.0, 1) if use_symmetry else 0

    return (
        weights["angle"] * angle_penalty
        + weights["distance"] * distance_penalty
        + weights["coverage_loss"] * coverage_loss_penalty
        + weights["new_area"] * new_area_penalty
        + weights["symmetry"] * symmetry_penalty
    )


def score_candidate_montage(
    coords: pd.DataFrame,
    original_labels: Sequence[str],
    candidate_labels: Sequence[str],
    electrode_radius: float = 0.45,
    use_symmetry: bool = True,
    symmetry_axis_x: float = 0,
    weights: dict[str, float] | None = None,
    strict_open: bool = False,
) -> dict[str, object]:
    validate_equal_lengths(original_labels, candidate_labels)
    validate_candidate_status(coords, candidate_labels, strict_open=strict_open)

    original_points = labels_to_points(coords, original_labels)
    candidate_points = labels_to_points(coords, candidate_labels)

    angle_change = montage_angle_change(original_points, candidate_points)
    mean_distance = mean_distance_from_original(original_points, candidate_points)
    max_distance = max_distance_from_original(original_points, candidate_points)
    area_metrics = area_overlap_metrics(
        original_points,
        candidate_points,
        electrode_radius=electrode_radius,
    )
    candidate_symmetry_error = (
        symmetry_error(candidate_points, symmetry_axis_x=symmetry_axis_x)
        if use_symmetry
        else 0
    )
    final_score = normalized_score(
        angle_change_deg=angle_change,
        mean_distance=mean_distance,
        percent_original_area_covered=area_metrics.percent_original_area_covered,
        percent_candidate_area_new=area_metrics.percent_candidate_area_new,
        symmetry=candidate_symmetry_error,
        weights=weights,
        use_symmetry=use_symmetry,
    )

    return {
        "original_montage": ", ".join(original_labels),
        "candidate_montage": ", ".join(candidate_labels),
        "angle_change_deg": angle_change,
        "mean_distance_from_original": mean_distance,
        "max_distance_from_original": max_distance,
        "percent_original_area_covered": area_metrics.percent_original_area_covered,
        "percent_candidate_area_new": area_metrics.percent_candidate_area_new,
        "new_area": area_metrics.new_area,
        "symmetry_error": candidate_symmetry_error,
        "final_score": final_score,
    }


def score_candidate_montages(
    coords: pd.DataFrame,
    original_labels: Sequence[str],
    candidate_montages: Sequence[Sequence[str]],
    electrode_radius: float = 0.45,
    use_symmetry: bool = True,
    symmetry_axis_x: float = 0,
    weights: dict[str, float] | None = None,
    strict_open: bool = False,
) -> pd.DataFrame:
    rows = [
        score_candidate_montage(
            coords=coords,
            original_labels=original_labels,
            candidate_labels=candidate_labels,
            electrode_radius=electrode_radius,
            use_symmetry=use_symmetry,
            symmetry_axis_x=symmetry_axis_x,
            weights=weights,
            strict_open=strict_open,
        )
        for candidate_labels in candidate_montages
    ]

    results = pd.DataFrame(rows).sort_values("final_score").reset_index(drop=True)
    results.insert(0, "rank", range(1, len(results) + 1))
    return results


if __name__ == "__main__":
    # Example usage. Keep this as a local demonstration; it does not save files.
    coords = load_coords("easycap_cac64_soterix_finetuned_final.csv")

    original_labels = ["F3", "F4"]

    candidate_montages = [
        ["FFC3h", "FFC4h"],
        ["FCC3h", "FCC4h"],
        ["AFF5h", "AFF6h"],
        ["CCP3h", "CCP4h"],
    ]

    scores_df = score_candidate_montages(
        coords=coords,
        original_labels=original_labels,
        candidate_montages=candidate_montages,
        electrode_radius=0.45,
        use_symmetry=True,
    )

    print(scores_df)
