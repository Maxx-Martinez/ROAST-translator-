from __future__ import annotations

import csv
import sys
from pathlib import Path


WIDTH = 900
HEIGHT = 900
PAD = 70


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as csv_file:
        return list(csv.DictReader(csv_file))


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python3 scripts/make_svg_preview.py input.csv output.svg")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    rows = load_rows(input_path)

    x_key = "map_x" if "map_x" in rows[0] else "x"
    y_key = "map_y" if "map_y" in rows[0] else "y"
    xs = [float(row[x_key]) for row in rows]
    ys = [float(row[y_key]) for row in rows]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    def sx(x: float) -> float:
        return PAD + ((x - min_x) / (max_x - min_x)) * (WIDTH - 2 * PAD)

    def sy(y: float) -> float:
        return HEIGHT - PAD - ((y - min_y) / (max_y - min_y)) * (HEIGHT - 2 * PAD)

    pieces = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900">',
        '<rect width="900" height="900" fill="white"/>',
        '<circle cx="450" cy="450" r="380" fill="none" stroke="#777" stroke-width="2"/>',
        '<text x="450" y="35" text-anchor="middle" font-family="Arial" font-size="22" font-weight="700">EasyCap CAC-64 / Soterix Coordinate Preview</text>',
        '<text x="450" y="62" text-anchor="middle" font-family="Arial" font-size="14" fill="#555">Blocked EEG holders are filled; open Soterix holes are dashed.</text>',
    ]

    for row in rows:
        x = sx(float(row[x_key]))
        y = sy(float(row[y_key]))
        label = row["label"]
        status = row["status"].lower()
        if status == "open":
            pieces.append(
                f'<circle cx="{x:.1f}" cy="{y:.1f}" r="22" fill="white" '
                'stroke="#667085" stroke-width="2" stroke-dasharray="5 4"/>'
            )
            fill = "#344054"
            font_size = 10
        else:
            pieces.append(
                f'<path d="M {x - 20:.1f} {y + 20:.1f} L {x - 20:.1f} {y - 7:.1f} '
                f'Q {x - 20:.1f} {y - 22:.1f} {x:.1f} {y - 22:.1f} '
                f'Q {x + 20:.1f} {y - 22:.1f} {x + 20:.1f} {y - 7:.1f} '
                f'L {x + 20:.1f} {y + 20:.1f} Z" fill="#92d29a" '
                'stroke="#3d7f49" stroke-width="2"/>'
            )
            fill = "#111827"
            font_size = 11
        pieces.append(
            f'<text x="{x:.1f}" y="{y + 4:.1f}" text-anchor="middle" '
            f'font-family="Arial" font-size="{font_size}" fill="{fill}">{label}</text>'
        )

    pieces.append("</svg>")
    output_path.write_text("\n".join(pieces) + "\n")


if __name__ == "__main__":
    main()
