export const MONTAGE_SIZE = 5;
export const CURRENT_BALANCE_TOLERANCE = 1e-6;

export const DEFAULT_IMPORTANCE = Object.freeze({
  weightedDistance: 9,
  maxDistance: 8,
  pairwiseDistance: 5,
  pairwiseAngle: 2,
  polarityCenter: 8,
  polarityVector: 7,
  regionCoverage: 4,
  footprintCoverage: 2,
  newArea: 3,
});

export const METRIC_LABELS = Object.freeze({
  weightedDistance: "Weighted movement",
  maxDistance: "Max movement",
  pairwiseDistance: "Pairwise distance",
  pairwiseAngle: "Pairwise orientation",
  polarityCenter: "Polarity centers",
  polarityVector: "Polarity vector",
  regionCoverage: "Region coverage",
  footprintCoverage: "Schematic footprint overlap",
  newArea: "New montage-region area",
});

export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function isFiniteNumber(value) {
  return Number.isFinite(value);
}

export function isValid3dRow(row) {
  return isFiniteNumber(row.x) && isFiniteNumber(row.y) && isFiniteNumber(row.z);
}

export function euclideanDistance(a, b, geometry) {
  if (geometry === "3d") return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function scoringPoint(row, geometry) {
  if (geometry === "2d") return { x: row.mapX, y: row.mapY, z: 0, label: row.label, status: row.status };
  return { x: row.x, y: row.y, z: row.z, label: row.label, status: row.status };
}

export function mapPoint(row) {
  return { x: row.mapX, y: row.mapY, z: 0, label: row.label, status: row.status };
}

export function geometryScale(rows, geometry) {
  const points = rows.map((row) => scoringPoint(row, geometry)).filter((point) => isFiniteNumber(point.x) && isFiniteNumber(point.y) && (geometry !== "3d" || isFiniteNumber(point.z)));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const zs = geometry === "3d" ? points.map((point) => point.z || 0) : [0];
  const dx = Math.max(...xs) - Math.min(...xs);
  const dy = Math.max(...ys) - Math.min(...ys);
  const dz = geometry === "3d" ? Math.max(...zs) - Math.min(...zs) : 0;
  return Math.hypot(dx, dy, dz);
}

export function movementReference(rows, geometry) {
  return geometryScale(rows, geometry) * 0.1;
}

export function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function weightedMean(values, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return mean(values);
  return values.reduce((sum, value, index) => sum + value * weights[index], 0) / total;
}

export function rms(values) {
  return Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length);
}

export function currentBalance(currents) {
  return currents.reduce((sum, current) => sum + current, 0);
}

export function validateCurrents(currents, maxCurrent) {
  const failures = [];
  if (currents.length !== MONTAGE_SIZE || currents.some((current) => !isFiniteNumber(current))) failures.push("finite currents");
  if (!isFiniteNumber(maxCurrent) || maxCurrent <= 0) failures.push("positive maximum current");
  const balance = currentBalance(currents);
  if (Math.abs(balance) > CURRENT_BALANCE_TOLERANCE) failures.push("current balance");
  if (currents.some((current) => Math.abs(current) > maxCurrent)) failures.push("maximum current");
  if (!currents.some((current) => current > 0) || !currents.some((current) => current < 0)) failures.push("positive and negative currents");
  return { ok: failures.length === 0, failures, balance };
}

export function angle2d(a, b) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

export function angleDiff(a, b) {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

export function vector3d(a, b) {
  const x = b.x - a.x;
  const y = b.y - a.y;
  const z = (b.z || 0) - (a.z || 0);
  const length = Math.hypot(x, y, z);
  if (!length) return { x: 0, y: 0, z: 0 };
  return { x: x / length, y: y / length, z: z / length };
}

export function angleBetweenVectors(a, b) {
  const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
  return (Math.acos(dot) * 180) / Math.PI;
}

export function pairedDistances(original, candidate, geometry) {
  return original.map((point, index) => euclideanDistance(point, candidate[index], geometry));
}

export function movementMetrics(original, candidate, currents, geometry) {
  const distances = pairedDistances(original, candidate, geometry);
  const currentWeights = currents.map((current) => Math.abs(current));
  return {
    distances,
    meanDistance: mean(distances),
    weightedDistance: weightedMean(distances, currentWeights),
    rmsDistance: rms(distances),
    maxDistance: Math.max(...distances),
  };
}

export function pairwiseDistanceMetrics(original, candidate, currents, geometry) {
  const absoluteChanges = [];
  const relativeChanges = [];
  const weights = [];
  for (let i = 0; i < original.length; i += 1) {
    for (let j = i + 1; j < original.length; j += 1) {
      const originalDistance = euclideanDistance(original[i], original[j], geometry);
      const candidateDistance = euclideanDistance(candidate[i], candidate[j], geometry);
      const absolute = Math.abs(originalDistance - candidateDistance);
      absoluteChanges.push(absolute);
      relativeChanges.push(originalDistance ? absolute / originalDistance : 0);
      weights.push(Math.abs(currents[i] * currents[j]) || 1);
    }
  }
  return {
    meanAbsolute: mean(absoluteChanges),
    weightedRelative: weightedMean(relativeChanges, weights),
    rmsRelative: rms(relativeChanges),
    maxRelative: Math.max(...relativeChanges),
  };
}

export function pairwiseAngleChange(original, candidate, geometry) {
  const changes = [];
  for (let i = 0; i < original.length; i += 1) {
    for (let j = i + 1; j < original.length; j += 1) {
      if (geometry === "3d") {
        changes.push(angleBetweenVectors(vector3d(original[i], original[j]), vector3d(candidate[i], candidate[j])));
      } else {
        changes.push(angleDiff(angle2d(original[i], original[j]), angle2d(candidate[i], candidate[j])));
      }
    }
  }
  return mean(changes);
}

export function currentWeightedCenter(points, currents, sign, geometry) {
  const selected = points
    .map((point, index) => ({ point, current: currents[index] }))
    .filter((item) => (sign > 0 ? item.current > 0 : item.current < 0));
  const total = selected.reduce((sum, item) => sum + Math.abs(item.current), 0);
  const result = {
    x: selected.reduce((sum, item) => sum + item.point.x * Math.abs(item.current), 0) / total,
    y: selected.reduce((sum, item) => sum + item.point.y * Math.abs(item.current), 0) / total,
  };
  if (geometry === "3d") result.z = selected.reduce((sum, item) => sum + (item.point.z || 0) * Math.abs(item.current), 0) / total;
  return result;
}

export function vectorBetween(a, b, geometry) {
  const vector = { x: a.x - b.x, y: a.y - b.y };
  if (geometry === "3d") vector.z = (a.z || 0) - (b.z || 0);
  return vector;
}

export function vectorLength(vector, geometry) {
  return geometry === "3d" ? Math.hypot(vector.x, vector.y, vector.z || 0) : Math.hypot(vector.x, vector.y);
}

export function vectorAngleChange(a, b, geometry) {
  const aLength = vectorLength(a, geometry);
  const bLength = vectorLength(b, geometry);
  if (!aLength || !bLength) return 0;
  const dot = geometry === "3d"
    ? a.x * b.x + a.y * b.y + (a.z || 0) * (b.z || 0)
    : a.x * b.x + a.y * b.y;
  return (Math.acos(clamp(dot / (aLength * bLength), -1, 1)) * 180) / Math.PI;
}

export function midpoint(a, b, geometry) {
  const point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (geometry === "3d") point.z = ((a.z || 0) + (b.z || 0)) / 2;
  return point;
}

export function polarityMetrics(original, candidate, currents, geometry) {
  const originalPositive = currentWeightedCenter(original, currents, 1, geometry);
  const originalNegative = currentWeightedCenter(original, currents, -1, geometry);
  const candidatePositive = currentWeightedCenter(candidate, currents, 1, geometry);
  const candidateNegative = currentWeightedCenter(candidate, currents, -1, geometry);
  const originalVector = vectorBetween(originalPositive, originalNegative, geometry);
  const candidateVector = vectorBetween(candidatePositive, candidateNegative, geometry);
  const positiveCenterShift = euclideanDistance(originalPositive, candidatePositive, geometry);
  const negativeCenterShift = euclideanDistance(originalNegative, candidateNegative, geometry);
  return {
    originalPositive,
    originalNegative,
    candidatePositive,
    candidateNegative,
    positiveCenterShift,
    negativeCenterShift,
    centerMeanShift: mean([positiveCenterShift, negativeCenterShift]),
    vectorAngleChange: vectorAngleChange(originalVector, candidateVector, geometry),
    vectorLengthChange: Math.abs(vectorLength(originalVector, geometry) - vectorLength(candidateVector, geometry)),
    vectorMidpointShift: euclideanDistance(midpoint(originalPositive, originalNegative, geometry), midpoint(candidatePositive, candidateNegative, geometry), geometry),
  };
}

export function convexHull(points) {
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (sorted.length <= 1) return sorted;
  const cross = (origin, a, b) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function polygonArea(poly) {
  if (poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area / 2;
}

export function ensureCcw(poly) {
  return polygonArea(poly) < 0 ? [...poly].reverse() : poly;
}

export function lineIntersection(a, b, c, d) {
  const x1 = a.x;
  const y1 = a.y;
  const x2 = b.x;
  const y2 = b.y;
  const x3 = c.x;
  const y3 = c.y;
  const x4 = d.x;
  const y4 = d.y;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return b;
  return {
    x: ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / den,
    y: ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / den,
  };
}

export function intersectConvexPolygons(subject, clip) {
  let output = ensureCcw(subject);
  const clipPoly = ensureCcw(clip);
  const inside = (point, a, b) => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) >= -1e-9;
  for (let i = 0; i < clipPoly.length; i += 1) {
    const a = clipPoly[i];
    const b = clipPoly[(i + 1) % clipPoly.length];
    const input = output;
    output = [];
    if (!input.length) break;
    let previous = input[input.length - 1];
    for (const current of input) {
      if (inside(current, a, b)) {
        if (!inside(previous, a, b)) output.push(lineIntersection(previous, current, a, b));
        output.push(current);
      } else if (inside(previous, a, b)) {
        output.push(lineIntersection(previous, current, a, b));
      }
      previous = current;
    }
  }
  return output;
}

export function regionMetrics(originalRows, candidateRows) {
  const originalHull = convexHull(originalRows.map(mapPoint));
  const candidateHull = convexHull(candidateRows.map(mapPoint));
  const overlap = intersectConvexPolygons(originalHull, candidateHull);
  const originalArea = Math.abs(polygonArea(originalHull));
  const candidateArea = Math.abs(polygonArea(candidateHull));
  const overlapArea = Math.abs(polygonArea(overlap));
  const newRegionArea = Math.max(candidateArea - overlapArea, 0);
  return {
    percentOriginalRegionCovered: originalArea ? (overlapArea / originalArea) * 100 : 0,
    percentCandidateRegionNew: candidateArea ? (newRegionArea / candidateArea) * 100 : 0,
    originalHull,
    candidateHull,
  };
}

export function footprintMetrics(originalRows, candidateRows, radius) {
  const original2d = originalRows.map(mapPoint);
  const candidate2d = candidateRows.map(mapPoint);
  const minX = Math.min(...original2d.concat(candidate2d).map((p) => p.x)) - radius;
  const maxX = Math.max(...original2d.concat(candidate2d).map((p) => p.x)) + radius;
  const minY = Math.min(...original2d.concat(candidate2d).map((p) => p.y)) - radius;
  const maxY = Math.max(...original2d.concat(candidate2d).map((p) => p.y)) + radius;
  const steps = 42;
  const dx = (maxX - minX) / steps;
  const dy = (maxY - minY) / steps;
  let originalCount = 0;
  let candidateCount = 0;
  let overlapCount = 0;
  for (let ix = 0; ix < steps; ix += 1) {
    for (let iy = 0; iy < steps; iy += 1) {
      const sample = { x: minX + (ix + 0.5) * dx, y: minY + (iy + 0.5) * dy };
      const inOriginal = original2d.some((point) => euclideanDistance(point, sample, "2d") <= radius);
      const inCandidate = candidate2d.some((point) => euclideanDistance(point, sample, "2d") <= radius);
      if (inOriginal) originalCount += 1;
      if (inCandidate) candidateCount += 1;
      if (inOriginal && inCandidate) overlapCount += 1;
    }
  }
  return {
    percentOriginalAreaCovered: originalCount ? (overlapCount / originalCount) * 100 : 0,
    percentCandidateAreaNew: candidateCount ? ((candidateCount - overlapCount) / candidateCount) * 100 : 0,
  };
}

export function normalizedWeights(importance) {
  const entries = Object.entries(importance);
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  if (!total) throw new Error("At least one importance slider must be greater than 0.");
  return Object.fromEntries(entries.map(([key, value]) => [key, Number(value) / total]));
}

function contribution(key, label, rawValue, normalizedPenalty, importance, weights) {
  const rawImportance = Number(importance[key] || 0);
  const normalizedWeight = Number(weights[key] || 0);
  const weightedContribution = normalizedWeight * normalizedPenalty;
  return { key, label, rawValue, normalizedPenalty, rawImportance, normalizedWeight, weightedContribution };
}

export function scoreMontage(input) {
  const {
    capRows,
    originalLabels,
    candidateLabels,
    currents,
    geometry = "3d",
    importance = DEFAULT_IMPORTANCE,
    footprintRadius = 0.35,
  } = input;
  const byLabel = new Map(capRows.map((row) => [row.label, row]));
  const originalRows = originalLabels.map((label) => byLabel.get(label));
  const candidateRows = candidateLabels.map((label) => byLabel.get(label));
  if (originalRows.some((row) => !row) || candidateRows.some((row) => !row)) throw new Error("Unknown electrode label.");
  const original = originalRows.map((row) => scoringPoint(row, geometry));
  const candidate = candidateRows.map((row) => scoringPoint(row, geometry));
  const reference = movementReference(capRows, geometry);
  const movement = movementMetrics(original, candidate, currents, geometry);
  const pairDistance = pairwiseDistanceMetrics(original, candidate, currents, geometry);
  const pairAngle = pairwiseAngleChange(original, candidate, geometry);
  const polarity = polarityMetrics(original, candidate, currents, geometry);
  const region = regionMetrics(originalRows, candidateRows);
  const footprint = footprintMetrics(originalRows, candidateRows, footprintRadius);
  const weights = normalizedWeights(importance);
  const polarityVectorComponents = {
    midpointPenalty: clamp(polarity.vectorMidpointShift / reference),
    lengthPenalty: clamp(polarity.vectorLengthChange / reference),
    anglePenalty: clamp(polarity.vectorAngleChange / 90),
  };
  const polarityVectorPenalty = mean(Object.values(polarityVectorComponents));
  const contributions = [
    contribution("weightedDistance", METRIC_LABELS.weightedDistance, movement.weightedDistance, clamp(movement.weightedDistance / reference), importance, weights),
    contribution("maxDistance", METRIC_LABELS.maxDistance, movement.maxDistance, clamp(movement.maxDistance / reference), importance, weights),
    contribution("pairwiseDistance", METRIC_LABELS.pairwiseDistance, pairDistance.weightedRelative, clamp(pairDistance.weightedRelative), importance, weights),
    contribution("pairwiseAngle", METRIC_LABELS.pairwiseAngle, pairAngle, clamp(pairAngle / 90), importance, weights),
    contribution("polarityCenter", METRIC_LABELS.polarityCenter, polarity.centerMeanShift, clamp(polarity.centerMeanShift / reference), importance, weights),
    contribution("polarityVector", METRIC_LABELS.polarityVector, polarity.vectorAngleChange, polarityVectorPenalty, importance, weights),
    contribution("regionCoverage", METRIC_LABELS.regionCoverage, region.percentOriginalRegionCovered, clamp((100 - region.percentOriginalRegionCovered) / 100), importance, weights),
    contribution("footprintCoverage", METRIC_LABELS.footprintCoverage, footprint.percentOriginalAreaCovered, clamp((100 - footprint.percentOriginalAreaCovered) / 100), importance, weights),
    contribution("newArea", METRIC_LABELS.newArea, region.percentCandidateRegionNew, clamp(region.percentCandidateRegionNew / 100), importance, weights),
  ];
  const finalScore = contributions.reduce((sum, item) => sum + item.weightedContribution, 0);
  return {
    candidateLabels,
    candidateMontage: candidateLabels.join(", "),
    calculationGeometry: geometry === "3d" ? "3D Cartesian" : "2D cap map",
    geometry,
    finalScore,
    movementReference: reference,
    currentBalance: currentBalance(currents),
    meanDistance: movement.meanDistance,
    weightedDistance: movement.weightedDistance,
    rmsDistance: movement.rmsDistance,
    maxDistance: movement.maxDistance,
    pairDistance: pairDistance.meanAbsolute,
    weightedPairwiseRelative: pairDistance.weightedRelative,
    rmsPairwiseRelative: pairDistance.rmsRelative,
    maxPairwiseRelative: pairDistance.maxRelative,
    pairAngle,
    positiveCenterShift: polarity.positiveCenterShift,
    negativeCenterShift: polarity.negativeCenterShift,
    polarityCenterShift: polarity.centerMeanShift,
    polarityVectorAngle: polarity.vectorAngleChange,
    polarityVectorLengthChange: polarity.vectorLengthChange,
    polarityVectorMidpointShift: polarity.vectorMidpointShift,
    polarityVectorComponents,
    percentOriginalRegionCovered: region.percentOriginalRegionCovered,
    percentCandidateRegionNew: region.percentCandidateRegionNew,
    percentOriginalAreaCovered: footprint.percentOriginalAreaCovered,
    percentCandidateAreaNew: footprint.percentCandidateAreaNew,
    originalHull: region.originalHull,
    candidateHull: region.candidateHull,
    contributions,
  };
}

export function validateManualCandidate(input) {
  const { capRows, originalLabels, candidateLabels, currents, maxCurrent, constraints, geometry = "3d" } = input;
  const byLabel = new Map(capRows.map((row) => [row.label, row]));
  const checklist = [];
  const add = (key, label, pass, blocking = false) => checklist.push({ key, label, pass, blocking });
  const known = candidateLabels.length === MONTAGE_SIZE && candidateLabels.every((label) => byLabel.has(label));
  add("known", "Known coordinate labels", known, true);
  const unique = new Set(candidateLabels).size === candidateLabels.length;
  add("unique", "Five unique sites", unique, true);
  let openRule = known;
  if (known) {
    openRule = candidateLabels.every((label, index) => {
      const site = byLabel.get(label);
      const original = byLabel.get(originalLabels[index]);
      return site.status === "open" || (label === originalLabels[index] && original?.status === "open");
    });
  }
  add("open", "Open-site rule", openRule, true);
  const currentResult = validateCurrents(currents, maxCurrent);
  add("balance", "Current balance", Math.abs(currentResult.balance) <= CURRENT_BALANCE_TOLERANCE, false);
  add("maxCurrent", "Maximum current", !currents.some((current) => Math.abs(current) > maxCurrent), false);
  const canScore = known && unique && openRule && currentResult.ok;
  if (!canScore) return { canScore, eligible: false, checklist };
  const score = scoreMontage(input);
  const maxMovePass = score.maxDistance <= constraints.maxDisplacement;
  const regionPass = !constraints.requireCoverage || score.percentOriginalRegionCovered >= constraints.minimumCoverage;
  const polarityPass = score.polarityVectorAngle <= constraints.maxPolarityAngle;
  const footprintPass = score.percentCandidateAreaNew <= constraints.maxNewFootprint;
  add("maxDisplacement", "Maximum displacement", maxMovePass, false);
  add("coverage", "Minimum region coverage", regionPass, false);
  add("polarityAngle", "Maximum polarity-vector angle", polarityPass, false);
  add("newFootprint", "Maximum new-footprint constraint", footprintPass, false);
  const eligible = checklist.every((item) => item.pass);
  return { canScore, eligible, checklist, score };
}

export function nearestOpenLabels(targetLabel, capRows, geometry, poolSize, excludeLabels) {
  const byLabel = new Map(capRows.map((row) => [row.label, row]));
  const targetRow = byLabel.get(targetLabel);
  const target = scoringPoint(targetRow, geometry);
  return capRows
    .filter((row) => row.status === "open" && !excludeLabels.has(row.label) && (geometry !== "3d" || isValid3dRow(row)))
    .map((row) => ({ label: row.label, distance: euclideanDistance(target, scoringPoint(row, geometry), geometry) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, poolSize)
    .map((row) => row.label);
}

export function constraintsPass(score, constraints) {
  if (score.maxDistance > constraints.maxDisplacement) return { pass: false, reason: "maximum displacement" };
  if (constraints.requireCoverage && score.percentOriginalRegionCovered < constraints.minimumCoverage) return { pass: false, reason: "minimum region coverage" };
  if (score.polarityVectorAngle > constraints.maxPolarityAngle) return { pass: false, reason: "polarity-vector angle" };
  if (score.percentCandidateAreaNew > constraints.maxNewFootprint) return { pass: false, reason: "maximum new schematic footprint" };
  return { pass: true, reason: "eligible" };
}

export function searchReplacements(input, onProgress = () => {}) {
  const { capRows, originalLabels, currents, geometry, poolSize, topN, constraints } = input;
  const byLabel = new Map(capRows.map((row) => [row.label, row]));
  const fixed = [];
  const blocked = [];
  const kept = [];
  const counts = { considered: 0, pruned: 0, scored: 0, eligible: 0, duplicate: 0, maxDisplacement: 0, coverage: 0, polarityAngle: 0, footprint: 0 };
  originalLabels.forEach((label, index) => {
    if (byLabel.get(label)?.status === "open") {
      fixed[index] = label;
      kept.push(label);
    } else {
      fixed[index] = null;
      blocked.push({ label, index });
    }
  });
  const keptSet = new Set(kept);
  const pools = blocked.map((item) => nearestOpenLabels(item.label, capRows, geometry, poolSize, keptSet));
  const total = pools.reduce((product, pool) => product * pool.length, 1) || 1;
  const best = [];
  const insertBest = (score) => {
    best.push(score);
    best.sort((a, b) => a.finalScore - b.finalScore);
    if (best.length > topN) best.pop();
  };
  const visit = (depth, candidate, used) => {
    if (depth === pools.length) {
      counts.considered += 1;
      const score = scoreMontage({ ...input, candidateLabels: candidate });
      score.maxDisplacement = constraints.maxDisplacement;
      counts.scored += 1;
      const constraint = constraintsPass(score, constraints);
      if (!constraint.pass) {
        counts.pruned += 1;
        if (constraint.reason === "maximum displacement") counts.maxDisplacement += 1;
        if (constraint.reason === "minimum region coverage") counts.coverage += 1;
        if (constraint.reason === "polarity-vector angle") counts.polarityAngle += 1;
        if (constraint.reason === "maximum new schematic footprint") counts.footprint += 1;
        return;
      }
      score.replacements = blocked.map((item) => `${item.label} (${currents[item.index]} mA)->${candidate[item.index]}`).join("; ") || "none";
      score.replacementRows = originalLabels.map((label, index) => ({ original: label, candidate: candidate[index], current: currents[index] }));
      score.keptOriginals = kept.join(", ") || "none";
      counts.eligible += 1;
      insertBest(score);
      if (counts.considered % 200 === 0) onProgress({ ...counts, total, progress: counts.considered / total });
      return;
    }
    const item = blocked[depth];
    for (const replacement of pools[depth]) {
      if (used.has(replacement)) {
        counts.pruned += 1;
        counts.duplicate += 1;
        continue;
      }
      const original = scoringPoint(byLabel.get(item.label), geometry);
      const candidatePoint = scoringPoint(byLabel.get(replacement), geometry);
      if (euclideanDistance(original, candidatePoint, geometry) > constraints.maxDisplacement) {
        counts.pruned += 1;
        counts.maxDisplacement += 1;
        continue;
      }
      candidate[item.index] = replacement;
      used.add(replacement);
      visit(depth + 1, candidate, used);
      used.delete(replacement);
      candidate[item.index] = null;
    }
  };
  visit(0, fixed.slice(), new Set(kept));
  const canonical = best.sort((a, b) => a.finalScore - b.finalScore).map((score, index) => ({ ...score, scoreRank: index + 1 }));
  return { suggestions: canonical, counts: { ...counts, total, progress: 1 } };
}
