# EEG Electrode Translator

This project is a geometry-based electrode-placement optimizer for an EEG and
stimulation cap layout. It represents an EasyCap / actiCAP-style 64-channel EEG
cap with Soterix-compatible open stimulation locations, visualizes the layout,
and ranks stimulation placement options using physical 2D or 3D coordinates.

The interactive cap map is a display schematic. The recommended calculation
mode is 3D Cartesian: it uses straight-line Euclidean distances between physical
x/y/z electrode coordinates. This is a geometric screening tool, not a claim to
reproduce ROAST or true scalp-surface geodesic distance. The 2D cap-map mode is
kept mainly for visualization, debugging, and comparison with the schematic map.
The tool keeps any ROAST locations that are already usable, replaces only
blocked locations, and lets each original site carry a current value that its
replacement inherits. Replacement sets must keep currents balanced to 0 mA and
stay within the configured maximum current and maximum displacement limits.

It ranks replacements by how well they preserve:

- current-weighted closeness to each original ROAST site
- maximum single-electrode displacement
- current-weighted pairwise distances between stimulation electrodes
- pairwise angles between stimulation electrodes
- positive and negative current centers
- the polarity/current-flow vector
- schematic region and footprint overlap
- unique, non-blocked stimulation sites

It is intended as a decision-support tool. After choosing a candidate montage,
rerun ROAST and review the electric field before using the montage.

## Files

- `data/cap_locations_template.csv` - starter coordinate table format
- `data/easycap_cac64_soterix_draft.csv` - cap coordinate map using the workbook's Realistic Head Model x/y coordinates
- `notebooks/01_coordinates_visualization_and_single_ranking.ipynb` - first Colab notebook milestone
- `notebooks/02_current_workbook_with_target_ranking.ipynb` - your current workbook plus target and montage ranking cells
- `notebooks/03_montage_similarity_scoring_colab.ipynb` - self-contained Colab notebook for original-vs-candidate montage scoring
- `notebooks/04_auto_replacement_montages_colab.ipynb` - self-contained Colab notebook that suggests replacements for blocked original placements
- `notebooks/07_auto_replacement_montages_colab.ipynb` - version 7 based on `Mark_5.ipynb`, with strict 85% montage-region coverage filtering and the 0-10 importance wrapper
- `src/eeg_electrode_translator/optimizer.py` - montage replacement optimizer
- `src/eeg_electrode_translator/targeting.py` - target-based single-site and pair-montage ranking
- `src/eeg_electrode_translator/montage_similarity.py` - original-vs-candidate montage geometry scoring
- `tests/test_optimizer.py` - tests for the scoring and replacement behavior
- `tests/test_targeting.py` - tests for target-based ranking
- `tests/test_montage_similarity.py` - tests for montage similarity metrics

## Coordinate CSV Format

Create a CSV with one row per cap site:

```csv
label,x,y,z,map_x,map_y,status
F3,-50.2438,53.1112,42.1920,-1.6,2.8,blocked
F4,51.8362,54.3048,40.8140,1.6,2.8,blocked
FCC3h,-51.0509,7.1772,74.3770,-1.3,1.0,open
FCC4h,51.8851,7.7978,73.5070,1.3,1.0,open
```

`status` can be:

- `open` - valid stimulation location
- `blocked` - occupied by EEG or otherwise unavailable

The physical `x`, `y`, and optional `z` coordinates should be internally
consistent. In the website, 3D Cartesian mode uses physical `x/y/z` for scoring.
The 2D cap-map mode uses `map_x` and `map_y` for schematic comparison. Optional
`map_x` and `map_y` columns are also used to make the interactive cap map mirror
the EasyCap PDF layout more closely. Coordinate units are not currently
documented in the CSV, so verify the template, units, origin, and orientation
before interpreting distances scientifically.

## Usage

Rank open Soterix sites and simple anode/cathode pairs near a target:

```bash
python3 -m src.eeg_electrode_translator.targeting \
  --cap data/easycap_cac64_soterix_draft.csv \
  --target-label F3 \
  --top 10 \
  --single-output outputs/ranked_single_electrodes.csv \
  --pair-output outputs/ranked_montages.csv
```

Use a manual target coordinate instead:

```bash
python3 -m src.eeg_electrode_translator.targeting \
  --cap data/easycap_cac64_soterix_draft.csv \
  --target-xy -1.6 2.8 \
  --target-name left_frontal_target
```

Replace blocked ROAST montage labels with nearby open positions:

```bash
python3 -m src.eeg_electrode_translator.optimizer \
  --cap data/cap_locations_template.csv \
  --montage F3 F4 Cz CP1 P2 \
  --top 5
```

The output lists the best candidate replacement montages and shows which original
labels were changed.

Score candidate montages against an original montage:

```python
from src.eeg_electrode_translator.montage_similarity import (
    load_coords,
    score_candidate_montages,
)

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
```

The montage similarity scorer uses Shapely for circular footprint overlap
metrics. In Colab, install it with `!pip install shapely` if it is not already
available.

For automatic replacement montages, the strict 85% rule now uses
`percent_original_region_covered`: the overlap between the original montage's
convex-hull region and the candidate montage's convex-hull region. The older
circular electrode footprint overlap metric is still reported as
`percent_original_area_covered`, but it has much lower default importance.

## Recommended Colab Workflow

Start in Colab with:

1. Upload `data/easycap_cac64_soterix_draft.csv`.
2. Upload/open `notebooks/01_coordinates_visualization_and_single_ranking.ipynb`.
3. Run the notebook to produce:
   - `electrode_layout_2D.png`
   - `electrode_layout_3D.png`
   - `targets.csv`
   - `ranked_single_electrodes.csv`
4. Review the plotted coordinate map against the source workbook/cap layout.
5. Add pair and montage ranking only after the coordinate map looks right.
