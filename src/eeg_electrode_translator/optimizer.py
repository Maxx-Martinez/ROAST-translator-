from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


OPEN = "open"
BLOCKED = "blocked"


@dataclass(frozen=True)
class CapLocation:
    label: str
    x: float
    y: float
    status: str

    @property
    def xy(self) -> tuple[float, float]:
        return (self.x, self.y)


@dataclass(frozen=True)
class CandidateMontage:
    labels: tuple[str, ...]
    score: float
    replacements: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class ScoreWeights:
    local_distance: float = 5.0
    pairwise_distance: float = 3.0
    pairwise_angle: float = 3.0
    center_shift: float = 2.0


def load_cap_locations(path: str | Path) -> dict[str, CapLocation]:
    locations: dict[str, CapLocation] = {}
    with Path(path).open(newline="") as csv_file:
        reader = csv.DictReader(csv_file)
        required = {"label", "x", "y", "status"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"Missing required CSV columns: {sorted(missing)}")

        for row_number, row in enumerate(reader, start=2):
            label = row["label"].strip()
            status = row["status"].strip().lower()
            if not label:
                raise ValueError(f"Row {row_number} has an empty label")
            if label in locations:
                raise ValueError(f"Duplicate cap label: {label}")
            if status not in {OPEN, BLOCKED}:
                raise ValueError(
                    f"Row {row_number} has unsupported status {status!r}; "
                    f"use {OPEN!r} or {BLOCKED!r}"
                )
            locations[label] = CapLocation(
                label=label,
                x=float(row["x"]),
                y=float(row["y"]),
                status=status,
            )

    return locations


def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def angle(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.atan2(b[1] - a[1], b[0] - a[0])


def angle_delta(a: float, b: float) -> float:
    delta = abs(a - b) % (2 * math.pi)
    return min(delta, 2 * math.pi - delta)


def center(points: Iterable[tuple[float, float]]) -> tuple[float, float]:
    points = tuple(points)
    if not points:
        raise ValueError("Cannot calculate a center for zero points")
    return (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )


def montage_score(
    original_labels: tuple[str, ...],
    candidate_labels: tuple[str, ...],
    locations: dict[str, CapLocation],
    weights: ScoreWeights = ScoreWeights(),
) -> float:
    original_xy = tuple(locations[label].xy for label in original_labels)
    candidate_xy = tuple(locations[label].xy for label in candidate_labels)

    score = 0.0

    for original, candidate in zip(original_xy, candidate_xy):
        score += weights.local_distance * distance(original, candidate)

    for i in range(len(original_xy)):
        for j in range(i + 1, len(original_xy)):
            original_distance = distance(original_xy[i], original_xy[j])
            candidate_distance = distance(candidate_xy[i], candidate_xy[j])
            score += weights.pairwise_distance * abs(
                original_distance - candidate_distance
            )

            original_angle = angle(original_xy[i], original_xy[j])
            candidate_angle = angle(candidate_xy[i], candidate_xy[j])
            score += weights.pairwise_angle * angle_delta(
                original_angle, candidate_angle
            )

    score += weights.center_shift * distance(center(original_xy), center(candidate_xy))
    return score


def find_candidate_montages(
    roast_labels: Iterable[str],
    locations: dict[str, CapLocation],
    top: int = 5,
    weights: ScoreWeights = ScoreWeights(),
    replacement_pool_size: int | None = 12,
) -> list[CandidateMontage]:
    roast_labels = tuple(roast_labels)
    if len(roast_labels) != 5:
        raise ValueError("Expected exactly 5 ROAST montage labels")

    unknown = [label for label in roast_labels if label not in locations]
    if unknown:
        raise ValueError(f"Unknown cap label(s): {', '.join(unknown)}")

    fixed: list[str | None] = []
    blocked_indices: list[int] = []
    fixed_open_labels: set[str] = set()

    for index, label in enumerate(roast_labels):
        if locations[label].status == BLOCKED:
            blocked_indices.append(index)
            fixed.append(None)
        else:
            fixed.append(label)
            fixed_open_labels.add(label)

    if not blocked_indices:
        return [
            CandidateMontage(
                labels=roast_labels,
                score=0.0,
                replacements=(),
            )
        ]

    open_labels = tuple(
        label
        for label, location in locations.items()
        if location.status == OPEN and label not in fixed_open_labels
    )
    if len(open_labels) < len(blocked_indices):
        raise ValueError(
            "Not enough open cap locations to replace blocked montage positions"
        )

    if replacement_pool_size is not None:
        blocked_xy = tuple(locations[roast_labels[index]].xy for index in blocked_indices)
        open_labels = tuple(
            sorted(
                open_labels,
                key=lambda label: min(
                    distance(locations[label].xy, original_xy)
                    for original_xy in blocked_xy
                ),
            )[: max(replacement_pool_size, len(blocked_indices))]
        )

    candidates: list[CandidateMontage] = []

    for replacements in itertools.permutations(open_labels, len(blocked_indices)):
        candidate = fixed.copy()
        for index, replacement in zip(blocked_indices, replacements):
            candidate[index] = replacement

        candidate_labels = tuple(label for label in candidate if label is not None)
        if len(set(candidate_labels)) != len(candidate_labels):
            continue

        score = montage_score(roast_labels, candidate_labels, locations, weights)
        changed = tuple(
            (roast_labels[index], replacement)
            for index, replacement in zip(blocked_indices, replacements)
        )
        candidates.append(
            CandidateMontage(
                labels=candidate_labels,
                score=score,
                replacements=changed,
            )
        )

    candidates.sort(key=lambda candidate: candidate.score)
    return candidates[:top]


def format_candidate(candidate: CandidateMontage) -> dict[str, object]:
    return {
        "montage": list(candidate.labels),
        "score": round(candidate.score, 4),
        "replacements": [
            {"from": original, "to": replacement}
            for original, replacement in candidate.replacements
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replace blocked ROAST montage labels with open cap positions."
    )
    parser.add_argument("--cap", required=True, help="Path to cap coordinate CSV")
    parser.add_argument(
        "--montage",
        nargs=5,
        required=True,
        metavar="LABEL",
        help="Five ROAST-selected stimulation labels",
    )
    parser.add_argument("--top", type=int, default=5, help="Number of candidates")
    parser.add_argument(
        "--pool-size",
        type=int,
        default=12,
        help="Limit replacement search to the nearest open positions; use 0 for exhaustive",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON instead of text",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    locations = load_cap_locations(args.cap)
    pool_size = None if args.pool_size == 0 else args.pool_size
    candidates = find_candidate_montages(
        args.montage,
        locations,
        top=args.top,
        replacement_pool_size=pool_size,
    )

    if args.json:
        print(json.dumps([format_candidate(candidate) for candidate in candidates], indent=2))
        return

    for rank, candidate in enumerate(candidates, start=1):
        print(f"{rank}. score={candidate.score:.4f}")
        print(f"   montage: {', '.join(candidate.labels)}")
        if candidate.replacements:
            replacements = ", ".join(
                f"{original}->{replacement}"
                for original, replacement in candidate.replacements
            )
            print(f"   replacements: {replacements}")
        else:
            print("   replacements: none")


if __name__ == "__main__":
    main()
