# Scoring Specification

This app is a geometry-based screening tool. It does not model ROAST electric fields, tissue conductivity, scalp-surface geodesic distance, or clinical equivalence.

## Coordinate Spaces

- **3D Cartesian** uses `x`, `y`, and `z` coordinates and straight-line Euclidean chord distance.
- **2D cap map** uses `map_x` and `map_y`.
- **Region coverage** always uses `map_x` and `map_y`.
- **Schematic footprint overlap** always uses `map_x` and `map_y`.
- Coordinate units are unverified unless `coordinate_metadata.json` says otherwise.

## Hard Constraints

Hard constraints determine whether a candidate is eligible:

- exactly five electrodes;
- all labels known;
- replacement labels unique;
- replacement sites must be open Soterix sites unless an already-open original is retained unchanged;
- total current must equal `0 mA` within tolerance;
- no electrode current may exceed the configured maximum magnitude;
- maximum individual displacement;
- optional minimum schematic region coverage;
- optional maximum polarity-vector angle change;
- optional maximum new schematic-footprint percentage.

## Normalization

`movementReference = 10%` of the active coordinate-space diagonal.

- 3D diagonal uses `x/y/z`.
- 2D diagonal uses `map_x/map_y`.

`movementReference` normalizes weighted movement, max movement, polarity-center shift, polarity-vector midpoint shift, and polarity-vector length change. The user-selected maximum displacement is only a hard eligibility constraint.

## Score Terms

Lower final score is better.

For each metric:

`weightedContribution = normalizedWeight * normalizedPenalty`

`finalScore = sum(weightedContribution)`

The nine metric penalties are:

- Weighted movement: `weightedDistance / movementReference`
- Max movement: `maxDistance / movementReference`
- Pairwise distance: current-weighted relative pairwise distance change
- Pairwise orientation: `pairwiseAngleChange / 90`
- Polarity centers: mean positive/negative center shift divided by `movementReference`
- Polarity vector: average of midpoint, length, and angle penalties
- Region coverage: `(100 - percentOriginalRegionCovered) / 100`
- Schematic footprint overlap: `(100 - percentOriginalAreaCovered) / 100`
- New montage-region area: `percentCandidateRegionNew / 100`

All normalized penalties are clamped from `0` to `1`.

## Polarity Vector

The polarity-vector penalty is:

`(midpointPenalty + lengthPenalty + anglePenalty) / 3`

where:

- `midpointPenalty = vectorMidpointShift / movementReference`
- `lengthPenalty = vectorLengthChange / movementReference`
- `anglePenalty = vectorAngleChange / 90`

## Search

Automatic search uses recursive depth-first candidate generation and does not materialize the full Cartesian product. The browser runs search in a Web Worker and reports progress, pruning counts, scored counts, and eligible counts.
