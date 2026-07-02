from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from pathlib import Path

from .optimizer import CapLocation, distance, load_cap_locations


@dataclass(frozen=True)
class Target:
    name: str
    x: float
    y: float

    @property
    def xy(self) -> tuple[float, float]:
        return (self.x, self.y)


@dataclass(frozen=True)
class SingleSiteRank:
    rank: int
    label: str
    x: float
    y: float
    distance_to_target: float


@dataclass(frozen=True)
class PairMontageRank:
    rank: int
    anode: str
    cathode: str
    anode_distance_to_target: float
    inter_electrode_distance: float
    score: float
    notes: str


def target_from_label(label: str, locations: dict[str, CapLocation]) -> Target:
    if label not in locations:
        raise ValueError(f"Unknown target label: {label}")
    location = locations[label]
    return Target(name=label, x=location.x, y=location.y)


def open_locations(locations: dict[str, CapLocation]) -> list[CapLocation]:
    return [location for location in locations.values() if location.status == "open"]


def rank_single_sites(
    locations: dict[str, CapLocation],
    target: Target,
    top: int | None = None,
) -> list[SingleSiteRank]:
    rows = sorted(
        (
            SingleSiteRank(
                rank=0,
                label=location.label,
                x=location.x,
                y=location.y,
                distance_to_target=distance(location.xy, target.xy),
            )
            for location in open_locations(locations)
        ),
        key=lambda row: row.distance_to_target,
    )

    ranked = [
        SingleSiteRank(
            rank=index,
            label=row.label,
            x=row.x,
            y=row.y,
            distance_to_target=row.distance_to_target,
        )
        for index, row in enumerate(rows, start=1)
    ]
    return ranked if top is None else ranked[:top]


def rank_pair_montages(
    locations: dict[str, CapLocation],
    target: Target,
    top: int = 20,
    candidate_anodes: int = 12,
    ideal_separation: float = 3.0,
    min_separation: float = 1.0,
    max_separation: float = 7.0,
) -> list[PairMontageRank]:
    singles = rank_single_sites(locations, target, top=candidate_anodes)
    open_by_label = {location.label: location for location in open_locations(locations)}

    pair_rows: list[PairMontageRank] = []
    for single in singles:
        anode = open_by_label[single.label]
        for cathode in open_by_label.values():
            if cathode.label == anode.label:
                continue

            separation = distance(anode.xy, cathode.xy)
            if separation < min_separation or separation > max_separation:
                continue

            separation_penalty = abs(separation - ideal_separation)
            score = (5.0 * single.distance_to_target) + separation_penalty
            notes = (
                f"anode near target; separation {separation:.2f} "
                f"vs ideal {ideal_separation:.2f}"
            )
            pair_rows.append(
                PairMontageRank(
                    rank=0,
                    anode=anode.label,
                    cathode=cathode.label,
                    anode_distance_to_target=single.distance_to_target,
                    inter_electrode_distance=separation,
                    score=score,
                    notes=notes,
                )
            )

    pair_rows.sort(key=lambda row: row.score)
    return [
        PairMontageRank(
            rank=index,
            anode=row.anode,
            cathode=row.cathode,
            anode_distance_to_target=row.anode_distance_to_target,
            inter_electrode_distance=row.inter_electrode_distance,
            score=row.score,
            notes=row.notes,
        )
        for index, row in enumerate(pair_rows[:top], start=1)
    ]


def dataclass_rows(rows: list[object]) -> list[dict[str, object]]:
    return [row.__dict__ for row in rows]


def write_csv(path: str | Path, rows: list[object]) -> None:
    if not rows:
        raise ValueError("No rows to write")

    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    dict_rows = dataclass_rows(rows)
    with output_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=list(dict_rows[0].keys()))
        writer.writeheader()
        writer.writerows(dict_rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Rank open stimulation sites and simple anode/cathode pairs."
    )
    parser.add_argument("--cap", required=True, help="Path to cap coordinate CSV")
    target_group = parser.add_mutually_exclusive_group(required=True)
    target_group.add_argument(
        "--target-label",
        help="Use an existing cap label as the target coordinate",
    )
    target_group.add_argument(
        "--target-xy",
        nargs=2,
        type=float,
        metavar=("X", "Y"),
        help="Use a manual 2D target coordinate",
    )
    parser.add_argument("--target-name", default="target", help="Name for manual target")
    parser.add_argument("--top", type=int, default=20, help="Rows to print")
    parser.add_argument("--ideal-separation", type=float, default=3.0)
    parser.add_argument("--min-separation", type=float, default=1.0)
    parser.add_argument("--max-separation", type=float, default=7.0)
    parser.add_argument("--single-output", help="Optional CSV path for single-site ranks")
    parser.add_argument("--pair-output", help="Optional CSV path for pair ranks")
    parser.add_argument("--json", action="store_true", help="Print JSON")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    locations = load_cap_locations(args.cap)

    if args.target_label:
        target = target_from_label(args.target_label, locations)
    else:
        target = Target(args.target_name, args.target_xy[0], args.target_xy[1])

    singles = rank_single_sites(locations, target, top=args.top)
    pairs = rank_pair_montages(
        locations,
        target,
        top=args.top,
        ideal_separation=args.ideal_separation,
        min_separation=args.min_separation,
        max_separation=args.max_separation,
    )

    if args.single_output:
        write_csv(args.single_output, singles)
    if args.pair_output:
        write_csv(args.pair_output, pairs)

    if args.json:
        print(
            json.dumps(
                {
                    "target": target.__dict__,
                    "single_sites": dataclass_rows(singles),
                    "pair_montages": dataclass_rows(pairs),
                },
                indent=2,
            )
        )
        return

    print(f"Target: {target.name} ({target.x:.2f}, {target.y:.2f})")
    print("\nTop open sites:")
    for row in singles:
        print(f"{row.rank:>2}. {row.label:<8} distance={row.distance_to_target:.3f}")

    print("\nTop pair montages:")
    for row in pairs:
        print(
            f"{row.rank:>2}. anode={row.anode:<8} cathode={row.cathode:<8} "
            f"target_distance={row.anode_distance_to_target:.3f} "
            f"separation={row.inter_electrode_distance:.3f} score={row.score:.3f}"
        )


if __name__ == "__main__":
    main()
