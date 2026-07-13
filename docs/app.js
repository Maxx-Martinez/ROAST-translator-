const DEFAULT_ORIGINAL = ["CP4", "P2", "P6", "PO8", "O2"];
const DEFAULT_MANUAL = ["POO2", "POO10h", "TPP8h", "CCP6h", "PPO2h"];
const DEFAULT_CURRENTS = [2, -0.5, -0.5, -0.5, -0.5];
const CURRENT_BALANCE_TOLERANCE = 1e-6;

const IMPORTANCE = [
  ["weightedDistance", "Weighted movement"],
  ["maxDistance", "Max movement"],
  ["pairwiseDistance", "Pairwise distance"],
  ["pairwiseAngle", "Pairwise angle"],
  ["polarityCenter", "Polarity centers"],
  ["polarityVector", "Polarity vector"],
  ["regionCoverage", "Region coverage"],
  ["footprintCoverage", "Footprint overlap"],
  ["newArea", "New area"],
];

const DEFAULT_IMPORTANCE = {
  weightedDistance: 9,
  maxDistance: 8,
  pairwiseDistance: 5,
  pairwiseAngle: 2,
  polarityCenter: 8,
  polarityVector: 7,
  regionCoverage: 4,
  footprintCoverage: 2,
  newArea: 3,
};

const GREEN_EEG_LABELS = new Set([
  "Fp1", "Fp2",
  "F7", "F3", "Fz", "F4", "F8",
  "FC5", "FC1", "FC2", "FC6",
  "T7", "C3", "Cz", "C4", "T8",
  "TP9", "CP5", "CP1", "CP2", "CP6", "TP10",
  "P7", "P3", "Pz", "P4", "P8",
  "PO9", "O1", "Oz", "O2", "PO10",
]);

let capRows = [];
let rowByLabel = new Map();
let selectedCandidate = null;
let suggestions = [];
let activeEntryGroup = "original";
let activeSlotIndex = 0;

const svg = document.getElementById("capMap");
const statusMessage = document.getElementById("statusMessage");
const resultsBody = document.querySelector("#resultsTable tbody");
const metricDetails = document.getElementById("metricDetails");
const loadingOverlay = document.getElementById("loadingOverlay");

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index];
    });
    return {
      label: row.label.trim(),
      x: Number(row.x),
      y: Number(row.y),
      z: row.z === undefined || row.z === "" ? 0 : Number(row.z),
      mapX: row.map_x === undefined || row.map_x === "" ? Number(row.x) : Number(row.map_x),
      mapY: row.map_y === undefined || row.map_y === "" ? Number(row.y) : Number(row.map_y),
      status: row.status.trim().toLowerCase(),
    };
  });
}

async function loadCoordinates() {
  const response = await fetch("data/easycap_cac64_soterix_draft.csv?v=20260710-v7-current-aware");
  if (!response.ok) throw new Error("Could not load coordinate CSV.");
  capRows = parseCsv(await response.text());
  rowByLabel = new Map(capRows.map((row) => [row.label, row]));
}

function getPoint(label) {
  const row = rowByLabel.get(label);
  if (!row) throw new Error(`Unknown label: ${label}`);
  return { x: row.x, y: row.y, z: row.z, label: row.label, status: row.status };
}

function calculationGeometry() {
  return document.querySelector('input[name="calculationGeometry"]:checked')?.value || "2d";
}

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceForGeometry(a, b, geometry) {
  if (geometry === "3d") return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  return distance2d(a, b);
}

function geometryScale(geometry) {
  const xs = capRows.map((row) => row.x);
  const ys = capRows.map((row) => row.y);
  const zs = capRows.map((row) => row.z || 0);
  const dx = Math.max(...xs) - Math.min(...xs);
  const dy = Math.max(...ys) - Math.min(...ys);
  const dz = Math.max(...zs) - Math.min(...zs);
  const diagonal = geometry === "3d" ? Math.hypot(dx, dy, dz) : Math.hypot(dx, dy);
  return diagonal / 10;
}

function angle2d(a, b) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

function vector3d(a, b) {
  const x = b.x - a.x;
  const y = b.y - a.y;
  const z = (b.z || 0) - (a.z || 0);
  const length = Math.hypot(x, y, z);
  if (!length) return { x: 0, y: 0, z: 0 };
  return { x: x / length, y: y / length, z: z / length };
}

function angleBetweenVectors(a, b) {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return (Math.acos(dot) * 180) / Math.PI;
}

function angleDiff(a, b) {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

function center(points, geometry) {
  const point = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  if (geometry === "3d") {
    point.z = points.reduce((sum, item) => sum + (item.z || 0), 0) / points.length;
  }
  return point;
}

function pairedDistances(original, candidate, geometry) {
  return original.map((point, index) => distanceForGeometry(point, candidate[index], geometry));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weightedMean(values, weights) {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!totalWeight) return mean(values);
  return values.reduce((sum, value, index) => sum + value * weights[index], 0) / totalWeight;
}

function rms(values) {
  return Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length);
}

function currentBalance(currents) {
  return currents.reduce((sum, current) => sum + current, 0);
}

function validateCurrents(currents) {
  if (currents.length !== 5 || currents.some((current) => !Number.isFinite(current))) {
    throw new Error("Please enter exactly 5 numeric current values.");
  }
  const maxCurrent = Number(document.getElementById("maxCurrent").value);
  if (!Number.isFinite(maxCurrent) || maxCurrent <= 0) {
    throw new Error("Please enter a positive maximum current.");
  }
  const balance = currentBalance(currents);
  if (Math.abs(balance) > CURRENT_BALANCE_TOLERANCE) {
    throw new Error(`Currents must balance to 0 mA. Current sum is ${balance.toFixed(4)} mA.`);
  }
  const overLimit = currents.find((current) => Math.abs(current) > maxCurrent);
  if (overLimit !== undefined) {
    throw new Error(`Current ${overLimit.toFixed(3)} mA exceeds the ${maxCurrent.toFixed(3)} mA limit.`);
  }
  if (!currents.some((current) => current > 0) || !currents.some((current) => current < 0)) {
    throw new Error("Montage must include at least one positive and one negative current.");
  }
}

function currentWeightedCenter(points, currents, sign, geometry) {
  const selected = points
    .map((point, index) => ({ point, current: currents[index] }))
    .filter((item) => (sign > 0 ? item.current > 0 : item.current < 0));
  const total = selected.reduce((sum, item) => sum + Math.abs(item.current), 0);
  const result = {
    x: selected.reduce((sum, item) => sum + item.point.x * Math.abs(item.current), 0) / total,
    y: selected.reduce((sum, item) => sum + item.point.y * Math.abs(item.current), 0) / total,
  };
  if (geometry === "3d") {
    result.z = selected.reduce((sum, item) => sum + (item.point.z || 0) * Math.abs(item.current), 0) / total;
  }
  return result;
}

function vectorBetween(a, b, geometry) {
  const vector = { x: a.x - b.x, y: a.y - b.y };
  if (geometry === "3d") vector.z = (a.z || 0) - (b.z || 0);
  return vector;
}

function vectorLength(vector, geometry) {
  return geometry === "3d" ? Math.hypot(vector.x, vector.y, vector.z || 0) : Math.hypot(vector.x, vector.y);
}

function vectorAngleChange(a, b, geometry) {
  const aLength = vectorLength(a, geometry);
  const bLength = vectorLength(b, geometry);
  if (!aLength || !bLength) return 0;
  const dot = geometry === "3d"
    ? a.x * b.x + a.y * b.y + (a.z || 0) * (b.z || 0)
    : a.x * b.x + a.y * b.y;
  return (Math.acos(Math.max(-1, Math.min(1, dot / (aLength * bLength)))) * 180) / Math.PI;
}

function midpoint(a, b, geometry) {
  const point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (geometry === "3d") point.z = ((a.z || 0) + (b.z || 0)) / 2;
  return point;
}

function polarityMetrics(original, candidate, currents, geometry) {
  const originalPositive = currentWeightedCenter(original, currents, 1, geometry);
  const originalNegative = currentWeightedCenter(original, currents, -1, geometry);
  const candidatePositive = currentWeightedCenter(candidate, currents, 1, geometry);
  const candidateNegative = currentWeightedCenter(candidate, currents, -1, geometry);
  const originalVector = vectorBetween(originalPositive, originalNegative, geometry);
  const candidateVector = vectorBetween(candidatePositive, candidateNegative, geometry);
  return {
    positiveCenterShift: distanceForGeometry(originalPositive, candidatePositive, geometry),
    negativeCenterShift: distanceForGeometry(originalNegative, candidateNegative, geometry),
    centerMeanShift: mean([
      distanceForGeometry(originalPositive, candidatePositive, geometry),
      distanceForGeometry(originalNegative, candidateNegative, geometry),
    ]),
    vectorAngleChange: vectorAngleChange(originalVector, candidateVector, geometry),
    vectorLengthChange: Math.abs(vectorLength(originalVector, geometry) - vectorLength(candidateVector, geometry)),
    vectorMidpointShift: distanceForGeometry(midpoint(originalPositive, originalNegative, geometry), midpoint(candidatePositive, candidateNegative, geometry), geometry),
  };
}

function pairwiseDistanceChange(original, candidate, geometry) {
  const changes = [];
  for (let i = 0; i < original.length; i += 1) {
    for (let j = i + 1; j < original.length; j += 1) {
      changes.push(Math.abs(distanceForGeometry(original[i], original[j], geometry) - distanceForGeometry(candidate[i], candidate[j], geometry)));
    }
  }
  return mean(changes);
}

function pairwiseDistanceMetrics(original, candidate, currents, geometry) {
  const absoluteChanges = [];
  const relativeChanges = [];
  const weights = [];
  for (let i = 0; i < original.length; i += 1) {
    for (let j = i + 1; j < original.length; j += 1) {
      const originalDistance = distanceForGeometry(original[i], original[j], geometry);
      const candidateDistance = distanceForGeometry(candidate[i], candidate[j], geometry);
      const absoluteChange = Math.abs(originalDistance - candidateDistance);
      absoluteChanges.push(absoluteChange);
      relativeChanges.push(originalDistance ? absoluteChange / originalDistance : 0);
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

function pairwiseAngleChange(original, candidate, geometry) {
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

function as2dPoints(points) {
  return points.map((point) => ({ ...point, z: 0 }));
}

function convexHull(points) {
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

function polygonArea(poly) {
  if (poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area / 2;
}

function ensureCcw(poly) {
  return polygonArea(poly) < 0 ? [...poly].reverse() : poly;
}

function lineIntersection(a, b, c, d) {
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

function intersectConvexPolygons(subject, clip) {
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

function regionMetrics(original, candidate) {
  const originalHull = convexHull(as2dPoints(original));
  const candidateHull = convexHull(as2dPoints(candidate));
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

function footprintMetrics(original, candidate, radius) {
  const original2d = as2dPoints(original);
  const candidate2d = as2dPoints(candidate);
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
      const inOriginal = original2d.some((point) => distance2d(point, sample) <= radius);
      const inCandidate = candidate2d.some((point) => distance2d(point, sample) <= radius);
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

function importanceWeights() {
  const values = {};
  let total = 0;
  for (const [key] of IMPORTANCE) {
    const value = Number(document.getElementById(`importance-${key}`).value);
    values[key] = value;
    total += value;
  }
  if (!total) throw new Error("At least one importance slider must be greater than 0.");
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value / total]));
}

function scoreMontage(originalLabels, candidateLabels, weights, radius, currents, options = {}) {
  if (originalLabels.length !== 5 || candidateLabels.length !== 5 || originalLabels.some((label) => !label) || candidateLabels.some((label) => !label)) {
    throw new Error("Please enter exactly 5 electrode labels.");
  }
  validateCurrents(currents);
  originalLabels.forEach(getPoint);
  candidateLabels.forEach(getPoint);
  const geometry = calculationGeometry();
  const maxDisplacement = Number(document.getElementById("maxDisplacement").value);
  if (!Number.isFinite(maxDisplacement) || maxDisplacement <= 0) {
    throw new Error("Please enter a positive maximum displacement.");
  }
  const original = originalLabels.map(getPoint);
  const candidate = candidateLabels.map(getPoint);
  const paired = pairedDistances(original, candidate, geometry);
  const currentWeights = currents.map((current) => Math.abs(current));
  const region = regionMetrics(original, candidate);
  const footprint = footprintMetrics(original, candidate, radius);
  const meanDistance = mean(paired);
  const weightedDistance = weightedMean(paired, currentWeights);
  const rmsDistance = rms(paired);
  const maxDistance = Math.max(...paired);
  if (options.enforceMax !== false && maxDistance > maxDisplacement) {
    throw new Error(`Replacement exceeds the ${maxDisplacement.toFixed(1)} maximum displacement.`);
  }
  const pairMetrics = pairwiseDistanceMetrics(original, candidate, currents, geometry);
  const pairAngle = pairwiseAngleChange(original, candidate, geometry);
  const polarity = polarityMetrics(original, candidate, currents, geometry);
  const scale = geometryScale(geometry);
  const score =
    weights.weightedDistance * Math.min(weightedDistance / scale, 1) +
    weights.maxDistance * Math.min(maxDistance / maxDisplacement, 1) +
    weights.pairwiseDistance * Math.min(pairMetrics.weightedRelative, 1) +
    weights.pairwiseAngle * Math.min(pairAngle / 90, 1) +
    weights.polarityCenter * Math.min(polarity.centerMeanShift / scale, 1) +
    weights.polarityVector * Math.min((polarity.vectorMidpointShift / scale) + (polarity.vectorLengthChange / scale) + (polarity.vectorAngleChange / 90), 1) +
    weights.regionCoverage * ((100 - region.percentOriginalRegionCovered) / 100) +
    weights.footprintCoverage * ((100 - footprint.percentOriginalAreaCovered) / 100) +
    weights.newArea * (footprint.percentCandidateAreaNew / 100);

  return {
    candidateLabels,
    candidateMontage: candidateLabels.join(", "),
    calculationGeometry: geometry.toUpperCase(),
    finalScore: score,
    currents,
    currentBalance: currentBalance(currents),
    meanDistance,
    weightedDistance,
    rmsDistance,
    maxDistance,
    maxDisplacement,
    pairDistance: pairMetrics.meanAbsolute,
    weightedPairwiseRelative: pairMetrics.weightedRelative,
    rmsPairwiseRelative: pairMetrics.rmsRelative,
    maxPairwiseRelative: pairMetrics.maxRelative,
    pairAngle,
    positiveCenterShift: polarity.positiveCenterShift,
    negativeCenterShift: polarity.negativeCenterShift,
    polarityCenterShift: polarity.centerMeanShift,
    polarityVectorAngle: polarity.vectorAngleChange,
    polarityVectorLengthChange: polarity.vectorLengthChange,
    polarityVectorMidpointShift: polarity.vectorMidpointShift,
    percentOriginalRegionCovered: region.percentOriginalRegionCovered,
    percentCandidateRegionNew: region.percentCandidateRegionNew,
    percentOriginalAreaCovered: footprint.percentOriginalAreaCovered,
    percentCandidateAreaNew: footprint.percentCandidateAreaNew,
    originalHull: region.originalHull,
    candidateHull: region.candidateHull,
  };
}

function nearestOpenLabels(targetLabel, poolSize, excludeLabels) {
  const target = getPoint(targetLabel);
  const geometry = calculationGeometry();
  return capRows
    .filter((row) => row.status === "open" && !excludeLabels.has(row.label))
    .map((row) => ({ label: row.label, distance: distanceForGeometry(target, row, geometry) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, poolSize)
    .map((row) => row.label);
}

function cartesianProduct(arrays) {
  return arrays.reduce((acc, values) => acc.flatMap((prefix) => values.map((value) => prefix.concat(value))), [[]]);
}

function suggestReplacements() {
  const originalLabels = readInputs("original");
  const currents = readCurrents();
  const topN = Number(document.getElementById("topN").value);
  const poolSize = Number(document.getElementById("poolSize").value);
  const radius = Number(document.getElementById("electrodeRadius").value);
  const minimumCoverage = Number(document.getElementById("minimumCoverage").value);
  const requireCoverage = document.getElementById("requireCoverage").checked;
  const weights = importanceWeights();
  validateCurrents(currents);

  const fixed = [];
  const blocked = [];
  const kept = [];
  originalLabels.forEach((label, index) => {
    if (getPoint(label).status === "open") {
      fixed[index] = label;
      kept.push(label);
    } else {
      fixed[index] = null;
      blocked.push({ label, index });
    }
  });

  const keptSet = new Set(kept);
  const pools = blocked.map((item) => nearestOpenLabels(item.label, poolSize, keptSet));
  const rows = [];

  for (const replacements of cartesianProduct(pools)) {
    if (new Set(replacements).size !== replacements.length) continue;
    const candidate = fixed.slice();
    replacements.forEach((replacement, index) => {
      candidate[blocked[index].index] = replacement;
    });
    if (new Set(candidate).size !== candidate.length) continue;
    const score = scoreMontage(originalLabels, candidate, weights, radius, currents, { enforceMax: false });
    if (score.maxDistance > score.maxDisplacement) continue;
    if (requireCoverage && score.percentOriginalRegionCovered < minimumCoverage) continue;
    score.replacements = blocked.map((item, index) => `${item.label} (${currents[item.index]} mA)->${replacements[index]}`).join("; ") || "none";
    score.keptOriginals = kept.join(", ") || "none";
    rows.push(score);
  }

  suggestions = rows.sort((a, b) => a.finalScore - b.finalScore).slice(0, topN);
  selectedCandidate = suggestions[0] || null;
  renderResults();
  renderMap(selectedCandidate);
  renderMetricDetails(selectedCandidate);
  statusMessage.textContent = suggestions.length
    ? `${suggestions.length} contenders found.`
    : "No contenders met the current settings. Try lowering minimum region coverage or increasing pool size.";
}

function scoreManual() {
  const originalLabels = readInputs("original");
  const manualLabels = readInputs("manual");
  const currents = readCurrents();
  const weights = importanceWeights();
  const radius = Number(document.getElementById("electrodeRadius").value);
  const score = scoreMontage(originalLabels, manualLabels, weights, radius, currents);
  score.replacements = originalLabels.map((label, index) => (label === manualLabels[index] ? null : `${label} (${currents[index]} mA)->${manualLabels[index]}`)).filter(Boolean).join("; ") || "none";
  score.keptOriginals = originalLabels.filter((label, index) => label === manualLabels[index]).join(", ") || "none";
  selectedCandidate = score;
  renderMap(score);
  renderMetricDetails(score);
  document.getElementById("manualScore").innerHTML = `
    <strong>Manual score:</strong> ${score.finalScore.toFixed(3)}<br>
    Weighted movement: ${score.weightedDistance.toFixed(2)}<br>
    Max movement: ${score.maxDistance.toFixed(2)}
  `;
}

function runWithStatus(action) {
  try {
    action();
  } catch (error) {
    statusMessage.textContent = error.message;
  }
}

function setLoading(isLoading) {
  loadingOverlay.hidden = !isLoading;
  loadingOverlay.setAttribute("aria-hidden", String(!isLoading));
  document.getElementById("runButton").disabled = isLoading;
  document.getElementById("scoreManualButton").disabled = isLoading;
}

async function runLongCalculation(action) {
  setLoading(true);
  statusMessage.textContent = "Calculating...";
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  try {
    action();
  } catch (error) {
    statusMessage.textContent = error.message;
  } finally {
    setLoading(false);
  }
}

function readInputs(prefix) {
  return Array.from(document.querySelectorAll(`[data-input-group="${prefix}"]`)).map((input) => normalizeLabel(input.value));
}

function readCurrents() {
  return Array.from(document.querySelectorAll("[data-current-index]")).map((input) => Number(input.value));
}

function normalizeLabel(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const match = capRows.find((row) => row.label.toLowerCase() === trimmed.toLowerCase());
  return match ? match.label : trimmed;
}

function makeSiteInput(group, value, index) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "site-input";
  input.dataset.inputGroup = group;
  input.dataset.index = String(index);
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = value;
  input.placeholder = "Type site";
  input.addEventListener("focus", () => {
    activeEntryGroup = group;
    activeSlotIndex = index;
    renderActiveEntryMode();
  });
  input.addEventListener("input", () => {
    input.value = input.value.trim();
    renderMap(selectedCandidate);
  });
  return input;
}

function makeCurrentInput(value, index) {
  const label = document.createElement("label");
  label.className = "current-field";
  label.innerHTML = `
    <span>Slot ${index + 1} current</span>
    <input type="number" data-current-index="${index}" min="-10" max="10" step="0.1" value="${value}">
  `;
  label.querySelector("input").addEventListener("input", () => renderMap(selectedCandidate));
  return label;
}

function initControls() {
  const originalInputs = document.getElementById("originalInputs");
  const currentInputs = document.getElementById("currentInputs");
  const manualInputs = document.getElementById("manualInputs");
  DEFAULT_ORIGINAL.forEach((label, index) => originalInputs.appendChild(makeSiteInput("original", label, index)));
  DEFAULT_CURRENTS.forEach((current, index) => currentInputs.appendChild(makeCurrentInput(current, index)));
  DEFAULT_MANUAL.forEach((label, index) => manualInputs.appendChild(makeSiteInput("manual", label, index)));
  document.getElementById("selectOriginalButton").addEventListener("click", () => setActiveEntryGroup("original"));
  document.getElementById("selectManualButton").addEventListener("click", () => setActiveEntryGroup("manual"));
  renderActiveEntryMode();

  const importanceControls = document.getElementById("importanceControls");
  for (const [key, label] of IMPORTANCE) {
    const row = document.createElement("label");
    row.className = "slider-row";
    row.innerHTML = `
      <span class="slider-topline"><span>${label}</span><strong id="value-${key}">${DEFAULT_IMPORTANCE[key]}</strong></span>
      <input id="importance-${key}" type="range" min="0" max="10" value="${DEFAULT_IMPORTANCE[key]}">
    `;
    importanceControls.appendChild(row);
    row.querySelector("input").addEventListener("input", (event) => {
      document.getElementById(`value-${key}`).textContent = event.target.value;
    });
  }
}

function setActiveEntryGroup(group) {
  activeEntryGroup = group;
  activeSlotIndex = firstEmptySlot(group);
  renderActiveEntryMode();
}

function firstEmptySlot(group) {
  const inputs = Array.from(document.querySelectorAll(`[data-input-group="${group}"]`));
  const empty = inputs.findIndex((input) => !input.value.trim());
  return empty >= 0 ? empty : 0;
}

function renderActiveEntryMode() {
  document.getElementById("selectOriginalButton").classList.toggle("active", activeEntryGroup === "original");
  document.getElementById("selectManualButton").classList.toggle("active", activeEntryGroup === "manual");
  document.querySelectorAll(".site-input").forEach((input) => {
    input.classList.toggle("active-slot", input.dataset.inputGroup === activeEntryGroup && Number(input.dataset.index) === activeSlotIndex);
  });
}

function fillFromMap(label) {
  const inputs = Array.from(document.querySelectorAll(`[data-input-group="${activeEntryGroup}"]`));
  const target = inputs[activeSlotIndex] || inputs[0];
  target.value = label;
  activeSlotIndex = (activeSlotIndex + 1) % inputs.length;
  renderActiveEntryMode();
  renderMap(selectedCandidate);
}

function scaleMapper() {
  const xs = capRows.map((row) => row.mapX);
  const ys = capRows.map((row) => row.mapY);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = 900;
  const height = 820;
  const pad = { left: 42, right: 42, top: 48, bottom: 42 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const dataWidth = maxX - minX;
  const dataHeight = maxY - minY;
  const scale = Math.min(plotWidth / dataWidth, plotHeight / dataHeight) * 0.9;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const canvasCenterX = width / 2;
  const canvasCenterY = height / 2 + 14;
  return {
    width,
    height,
    minX,
    maxX,
    minY,
    maxY,
    pad,
    plotWidth,
    plotHeight,
    centerX,
    centerY,
    dataWidth,
    dataHeight,
    x: (value) => canvasCenterX + (value - centerX) * scale,
    y: (value) => canvasCenterY - (value - centerY) * scale,
  };
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function polygonPoints(points, mapper) {
  return points.map((point) => `${mapper.x(point.x)},${mapper.y(point.y)}`).join(" ");
}

function displayPointsForLabels(labels) {
  return labels
    .map((label) => rowByLabel.get(label))
    .filter(Boolean)
    .map((row) => ({ x: row.mapX, y: row.mapY }));
}

function holderPath(cx, cy, radius) {
  const top = cy - radius * 0.85;
  const sideTop = cy - radius * 0.1;
  const bottom = cy + radius * 0.72;
  return [
    `M ${cx - radius * 0.8} ${bottom}`,
    `L ${cx - radius * 0.8} ${sideTop}`,
    `A ${radius * 0.8} ${radius * 0.8} 0 0 1 ${cx + radius * 0.8} ${sideTop}`,
    `L ${cx + radius * 0.8} ${bottom}`,
    "Z",
  ].join(" ");
}

function renderHeadGuide(mapper) {
  const guides = svgEl("g", { class: "cap-guides" });
  const cx = mapper.x(mapper.centerX);
  const cy = mapper.y(mapper.centerY);
  const outerRx = Math.abs(mapper.x(mapper.centerX + mapper.dataWidth * 0.56) - cx);
  const outerRy = Math.abs(mapper.y(mapper.centerY + mapper.dataHeight * 0.54) - cy);
  const ringRadii = [0.88, 0.74, 0.58, 0.42, 0.26];

  guides.appendChild(svgEl("ellipse", {
    cx,
    cy,
    rx: outerRx,
    ry: outerRy,
    class: "head-guide",
  }));
  for (const radius of ringRadii) {
    guides.appendChild(svgEl("ellipse", {
      cx,
      cy,
      rx: outerRx * radius,
      ry: outerRy * radius,
      class: "cap-guide-faint",
    }));
  }
  svg.appendChild(guides);
  svg.appendChild(svgEl("polygon", {
    points: `${cx - 42},${cy - outerRy} ${cx},${cy - outerRy - 64} ${cx + 42},${cy - outerRy}`,
    class: "head-guide",
  }));
}

function renderLegend(mapper) {
  const x = mapper.width - 212;
  const y = 52;
  svg.appendChild(svgEl("rect", { x, y, width: 188, height: 86, rx: 6, fill: "#fff", stroke: "#d6dce5" }));
  svg.appendChild(svgEl("path", { d: holderPath(x + 18, y + 24, 13), fill: "#9bd4a2", stroke: "#3d7f49", "stroke-width": 2 }));
  svg.appendChild(svgEl("path", { d: holderPath(x + 42, y + 24, 13), fill: "#f7e65f", stroke: "#a88c15", "stroke-width": 2 }));
  let text = svgEl("text", { x: x + 44, y: y + 29, class: "legend-label" });
  text.setAttribute("x", x + 66);
  text.textContent = "blocked EEG";
  svg.appendChild(text);
  svg.appendChild(svgEl("circle", { cx: x + 30, cy: y + 62, r: 13, fill: "#fff", stroke: "#667085", "stroke-width": 2, "stroke-dasharray": "6 4" }));
  text = svgEl("text", { x: x + 66, y: y + 67, class: "legend-label" });
  text.textContent = "open Soterix";
  svg.appendChild(text);
}

function renderMetricDetails(candidate) {
  if (!candidate) {
    metricDetails.classList.remove("visible");
    metricDetails.replaceChildren();
    return;
  }
  const metrics = [
    ["Final score", candidate.finalScore.toFixed(3)],
    ["Calculation geometry", candidate.calculationGeometry],
    ["Current balance", `${candidate.currentBalance.toFixed(4)} mA`],
    ["Weighted movement", candidate.weightedDistance.toFixed(3)],
    ["Mean movement", candidate.meanDistance.toFixed(3)],
    ["RMS movement", candidate.rmsDistance.toFixed(3)],
    ["Max movement", `${candidate.maxDistance.toFixed(3)} / ${candidate.maxDisplacement.toFixed(1)}`],
    ["Weighted pairwise error", `${(candidate.weightedPairwiseRelative * 100).toFixed(1)}%`],
    ["RMS pairwise error", `${(candidate.rmsPairwiseRelative * 100).toFixed(1)}%`],
    ["Max pairwise error", `${(candidate.maxPairwiseRelative * 100).toFixed(1)}%`],
    ["Pairwise angle change", `${candidate.pairAngle.toFixed(1)}°`],
    ["Positive center shift", candidate.positiveCenterShift.toFixed(3)],
    ["Negative center shift", candidate.negativeCenterShift.toFixed(3)],
    ["Polarity center shift", candidate.polarityCenterShift.toFixed(3)],
    ["Polarity vector angle", `${candidate.polarityVectorAngle.toFixed(1)}°`],
    ["Polarity vector length", candidate.polarityVectorLengthChange.toFixed(3)],
    ["Polarity midpoint shift", candidate.polarityVectorMidpointShift.toFixed(3)],
    ["Original region covered", `${candidate.percentOriginalRegionCovered.toFixed(1)}%`],
    ["Candidate region new", `${candidate.percentCandidateRegionNew.toFixed(1)}%`],
    ["Footprint overlap", `${candidate.percentOriginalAreaCovered.toFixed(1)}%`],
    ["Candidate footprint new", `${candidate.percentCandidateAreaNew.toFixed(1)}%`],
    ["Kept originals", candidate.keptOriginals || "none"],
    ["Replacements", candidate.replacements || "none"],
  ];
  metricDetails.replaceChildren(...metrics.map(([label, value]) => {
    const card = document.createElement("div");
    card.className = "metric-card";
    card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    return card;
  }));
  metricDetails.classList.add("visible");
}

function renderMap(candidate) {
  const originalLabels = readInputs("original").filter(Boolean);
  const candidateLabels = candidate ? candidate.candidateLabels : [];
  const originalSet = new Set(originalLabels);
  const candidateSet = new Set(candidateLabels);
  const mapper = scaleMapper();
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${mapper.width} ${mapper.height}`);

  renderHeadGuide(mapper);

  if (candidateLabels.length) {
    const originalHull = convexHull(displayPointsForLabels(originalLabels));
    const candidateHull = convexHull(displayPointsForLabels(candidateLabels));
    if (originalHull.length >= 3) {
      svg.appendChild(svgEl("polygon", {
        points: polygonPoints(originalHull, mapper),
        fill: "rgba(32,177,90,0.10)",
        stroke: "#20b15a",
        "stroke-width": 2,
        "stroke-dasharray": "6 4",
      }));
    }
    if (candidateHull.length >= 3) {
      svg.appendChild(svgEl("polygon", {
        points: polygonPoints(candidateHull, mapper),
        fill: "rgba(141,75,232,0.14)",
        stroke: "#8d4be8",
        "stroke-width": 2.2,
      }));
    }
  }

  for (const row of capRows) {
    const cx = mapper.x(row.mapX);
    const cy = mapper.y(row.mapY);
    const inOriginal = originalSet.has(row.label);
    const inCandidate = candidateSet.has(row.label);
    const g = svgEl("g", { class: "cap-site", "data-label": row.label });
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", `Select ${row.label}`);
    g.setAttribute("tabindex", "0");
    const chooseSite = (event) => {
      event.preventDefault();
      fillFromMap(row.label);
    };
    g.addEventListener("pointerdown", chooseSite);
    g.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") chooseSite(event);
    });

    if (inOriginal && inCandidate) {
      g.appendChild(svgEl("path", { d: `M ${cx} ${cy - 20} A 20 20 0 0 0 ${cx} ${cy + 20} L ${cx} ${cy} Z`, fill: "#20b15a", stroke: "#172033", "stroke-width": 1.6 }));
      g.appendChild(svgEl("path", { d: `M ${cx} ${cy - 20} A 20 20 0 0 1 ${cx} ${cy + 20} L ${cx} ${cy} Z`, fill: "#8d4be8", stroke: "#172033", "stroke-width": 1.6 }));
    } else if (inOriginal) {
      g.appendChild(svgEl("path", { d: holderPath(cx, cy, 21), fill: "#20b15a", stroke: "#166534", "stroke-width": 2.4 }));
    } else if (inCandidate) {
      g.appendChild(svgEl("path", { d: holderPath(cx, cy, 21), fill: "#8d4be8", stroke: "#6b21a8", "stroke-width": 2.4 }));
    } else if (row.status === "blocked") {
      const fill = GREEN_EEG_LABELS.has(row.label) ? "#9bd4a2" : "#f7e65f";
      const stroke = GREEN_EEG_LABELS.has(row.label) ? "#3d7f49" : "#a88c15";
      g.appendChild(svgEl("path", { d: holderPath(cx, cy, 18), fill, stroke, "stroke-width": 2.2 }));
    } else {
      g.appendChild(svgEl("circle", { cx, cy, r: 17, fill: "#fff", stroke: "#667085", "stroke-width": 2.2, "stroke-dasharray": "6 4" }));
    }

    const text = svgEl("text", {
      x: cx,
      y: cy,
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      class: inOriginal || inCandidate ? "map-label" : "map-label-muted",
      fill: "#172033",
    });
    text.textContent = row.label;
    g.appendChild(text);
    svg.appendChild(g);
  }

  renderLegend(mapper);

  if (candidate) {
    document.getElementById("selectedSummary").textContent = `${candidate.candidateMontage} | ${candidate.calculationGeometry} calc | max move ${candidate.maxDistance.toFixed(1)} | score ${candidate.finalScore.toFixed(3)}`;
  } else {
    document.getElementById("selectedSummary").textContent = "Click the map to fill montage slots, or run suggestions to view a candidate.";
  }
}

function renderResults() {
  resultsBody.replaceChildren();
  suggestions.forEach((row, index) => {
    const tr = document.createElement("tr");
    if (row === selectedCandidate) tr.classList.add("selected");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${row.finalScore.toFixed(3)}</td>
      <td>${row.maxDistance.toFixed(1)}</td>
      <td>${row.candidateMontage}</td>
      <td>${row.replacements}</td>
    `;
    tr.addEventListener("click", () => {
      selectedCandidate = row;
      renderResults();
      renderMap(row);
      renderMetricDetails(row);
    });
    resultsBody.appendChild(tr);
  });
}

async function main() {
  try {
    await loadCoordinates();
    initControls();
    renderMap(null);
    statusMessage.textContent = "Ready.";
    document.getElementById("runButton").addEventListener("click", () => runLongCalculation(suggestReplacements));
    document.getElementById("scoreManualButton").addEventListener("click", () => runWithStatus(scoreManual));
    document.querySelectorAll('input[name="calculationGeometry"]').forEach((input) => {
      input.addEventListener("change", () => {
        suggestions = [];
        selectedCandidate = null;
        resultsBody.replaceChildren();
        renderMetricDetails(null);
        renderMap(null);
        statusMessage.textContent = `Ready. Using ${calculationGeometry().toUpperCase()} calculations.`;
      });
    });
  } catch (error) {
    statusMessage.textContent = error.message;
  }
}

main();
