import * as Core from "./scoring-core.js";

const DEFAULT_ORIGINAL = ["CP4", "P2", "P6", "PO8", "O2"];
const DEFAULT_MANUAL = ["POO2", "POO10h", "TPP8h", "CCP6h", "PPO2h"];
const DEFAULT_CURRENTS = [2, -0.5, -0.5, -0.5, -0.5];
const CURRENT_BALANCE_TOLERANCE = 1e-6;
const COORDINATE_SOURCE = "data/easycap_cac64_soterix_draft.csv";
const COORDINATE_UNITS = "Not documented";
const EQUAL_WEIGHT = 5;

const IMPORTANCE = [
  ["placement", "Electrode placement", [
    ["weightedDistance", "Weighted movement", "Penalizes movement of high-current electrodes more strongly."],
    ["maxDistance", "Max movement", "Penalizes the single farthest electrode replacement."],
  ]],
  ["geometry", "Montage geometry", [
    ["pairwiseDistance", "Pairwise distance", "Measures stretching or compression of the montage."],
    ["pairwiseAngle", "Pairwise orientation", "Measures changes in the 3D direction between matching electrode pairs."],
  ]],
  ["current", "Current-flow geometry", [
    ["polarityCenter", "Polarity centers", "Measures movement of the positive and negative current-weighted centers."],
    ["polarityVector", "Polarity vector", "Measures changes in the direction and separation between polarity centers."],
  ]],
  ["coverage", "Spatial coverage", [
    ["regionCoverage", "Region coverage", "Measures how much of the original montage region is retained."],
    ["footprintCoverage", "Schematic footprint overlap", "Measures overlap between schematic circular footprints on the cap map."],
    ["newArea", "New montage-region area", "Penalizes candidate montage-region area that falls outside the original montage region."],
  ]],
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
let canonicalSuggestions = [];
let displayedSuggestions = [];
let activeEntryGroup = "original";
let activeSlotIndex = 0;
let capValidation = { ok: true, warnings: [], invalid3dLabels: new Set() };
let coordinateMetadata = null;
let sortKey = "finalScore";
let sortDirection = 1;
let activeWorker = null;

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
    const x = Number(row.x);
    const y = Number(row.y);
    const zRaw = row.z;
    const z = zRaw === undefined || zRaw === "" ? NaN : Number(zRaw);
    const mapX = row.map_x === undefined || row.map_x === "" ? x : Number(row.map_x);
    const mapY = row.map_y === undefined || row.map_y === "" ? y : Number(row.map_y);
    return {
      label: row.label.trim(),
      x,
      y,
      z,
      mapX,
      mapY,
      status: row.status.trim().toLowerCase(),
      raw: row,
    };
  });
}

async function loadCoordinates() {
  const response = await fetch(`${COORDINATE_SOURCE}?v=20260713-v8-3d-workflow`);
  if (!response.ok) throw new Error("Could not load coordinate CSV.");
  capRows = parseCsv(await response.text());
  rowByLabel = new Map(capRows.map((row) => [row.label, row]));
  capValidation = validateCoordinateDataset(capRows);
  try {
    const metadataResponse = await fetch("data/coordinate_metadata.json?v=20260713-v9-scoring-core");
    coordinateMetadata = metadataResponse.ok ? await metadataResponse.json() : null;
  } catch {
    coordinateMetadata = null;
  }
}

function getPoint(label) {
  const row = rowByLabel.get(label);
  if (!row) throw new Error(`Unknown label: ${label}`);
  return { x: row.x, y: row.y, z: row.z, mapX: row.mapX, mapY: row.mapY, label: row.label, status: row.status, valid3d: isValid3dRow(row) };
}

function getScoringPoint(label, geometry) {
  const row = getPoint(label);
  if (geometry === "2d") {
    return { x: row.mapX, y: row.mapY, z: 0, label: row.label, status: row.status, valid3d: row.valid3d };
  }
  return row;
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function isValid3dRow(row) {
  return isFiniteNumber(row.x) && isFiniteNumber(row.y) && isFiniteNumber(row.z);
}

function formatLabelList(labels) {
  if (!labels.length) return "";
  return labels.slice(0, 12).join(", ") + (labels.length > 12 ? `, and ${labels.length - 12} more` : "");
}

function validateCoordinateDataset(rows) {
  const warnings = [];
  const invalid3dLabels = new Set();
  const seenLabels = new Map();
  const coordinateTriplets = new Map();
  const missing3d = [];
  const invalidMap = [];
  const selectableMissing = [];
  const selectableStatuses = new Set(["open", "blocked"]);

  rows.forEach((row) => {
    if (!row.label) warnings.push("One coordinate row is missing an electrode label.");
    if (seenLabels.has(row.label)) warnings.push(`Duplicate electrode label: ${row.label}`);
    seenLabels.set(row.label, true);

    if (!isValid3dRow(row)) {
      invalid3dLabels.add(row.label);
      missing3d.push(row.label);
    }
    if (!isFiniteNumber(row.mapX) || !isFiniteNumber(row.mapY)) invalidMap.push(row.label);
    if (selectableStatuses.has(row.status) && !isValid3dRow(row)) selectableMissing.push(row.label);
    if (isValid3dRow(row)) {
      const key = [row.x, row.y, row.z].map((value) => value.toFixed(4)).join(",");
      const duplicate = coordinateTriplets.get(key);
      if (duplicate) warnings.push(`Duplicate 3D coordinate triplet: ${duplicate} and ${row.label}`);
      coordinateTriplets.set(key, row.label);
    }
  });

  if (missing3d.length) warnings.push(`${missing3d.length} electrode sites are missing valid x, y, or z values: ${formatLabelList(missing3d)}.`);
  if (invalidMap.length) warnings.push(`${invalidMap.length} electrode sites are missing valid 2D cap-map coordinates: ${formatLabelList(invalidMap)}.`);
  if (selectableMissing.length) warnings.push(`${selectableMissing.length} open or blocked sites cannot be scored in 3D: ${formatLabelList(selectableMissing)}.`);

  const validRows = rows.filter(isValid3dRow);
  if (validRows.length && validRows.length !== rows.length) warnings.push("Coordinate dimensionality is inconsistent: some rows have valid x/y/z values and some do not.");
  if (validRows.length >= 8) {
    const cx = mean(validRows.map((row) => row.x));
    const cy = mean(validRows.map((row) => row.y));
    const cz = mean(validRows.map((row) => row.z));
    const distances = validRows.map((row) => Math.hypot(row.x - cx, row.y - cy, row.z - cz)).sort((a, b) => a - b);
    const median = distances[Math.floor(distances.length / 2)];
    const q1 = distances[Math.floor(distances.length / 4)];
    const q3 = distances[Math.floor((distances.length * 3) / 4)];
    const threshold = median + Math.max((q3 - q1) * 4, median * 1.5);
    const outliers = validRows.filter((row) => Math.hypot(row.x - cx, row.y - cy, row.z - cz) > threshold).map((row) => row.label);
    if (outliers.length) warnings.push(`Potential 3D coordinate outliers: ${formatLabelList(outliers)}.`);
  }

  const leftRightPairs = rows
    .filter((row) => /\d$/.test(row.label) && isValid3dRow(row))
    .map((left) => {
      const rightLabel = left.label.replace(/1$/, "2").replace(/3$/, "4").replace(/5$/, "6").replace(/7$/, "8").replace(/9$/, "10");
      return [left, rowByLabel.get(rightLabel)];
    })
    .filter(([left, right]) => right && left.label !== right.label && isValid3dRow(right));
  const suspiciousPairs = leftRightPairs.filter(([left, right]) => Math.sign(left.x) === Math.sign(right.x)).map(([left, right]) => `${left.label}/${right.label}`);
  if (suspiciousPairs.length) warnings.push(`Possible left/right coordinate sign issue in paired labels: ${formatLabelList(suspiciousPairs)}.`);

  return { ok: warnings.length === 0, warnings, invalid3dLabels };
}

function ensureLabelsScorable(labels, geometry) {
  if (geometry !== "3d") return;
  const invalid = labels.filter((label) => capValidation.invalid3dLabels.has(label));
  if (invalid.length) {
    throw new Error(`These sites cannot be used in 3D calculations: ${invalid.join(", ")}.`);
  }
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
  for (const [, , metrics] of IMPORTANCE) {
    for (const [key] of metrics) {
      const value = Number(document.getElementById(`importance-${key}`).value);
      values[key] = value;
    }
  }
  Core.normalizedWeights(values);
  return values;
}

function scoreMontage(originalLabels, candidateLabels, weights, radius, currents, options = {}) {
  if (originalLabels.length !== 5 || candidateLabels.length !== 5 || originalLabels.some((label) => !label) || candidateLabels.some((label) => !label)) {
    throw new Error("Please enter exactly 5 electrode labels.");
  }
  validateCurrents(currents);
  const geometry = calculationGeometry();
  originalLabels.forEach(getPoint);
  candidateLabels.forEach(getPoint);
  ensureLabelsScorable(originalLabels.concat(candidateLabels), geometry);
  const maxDisplacement = Number(document.getElementById("maxDisplacement").value);
  if (!Number.isFinite(maxDisplacement) || maxDisplacement <= 0) {
    throw new Error("Please enter a positive maximum displacement.");
  }
  const score = Core.scoreMontage({
    capRows,
    originalLabels,
    candidateLabels,
    currents,
    geometry,
    importance: weights,
    footprintRadius: radius,
  });
  score.maxDisplacement = maxDisplacement;
  if (options.enforceMax !== false && score.maxDistance > maxDisplacement) {
    throw new Error(`Replacement exceeds the ${maxDisplacement.toFixed(1)} maximum displacement.`);
  }
  return score;
}

function searchPayload() {
  const originalLabels = readInputs("original");
  const currents = readCurrents();
  const topN = Number(document.getElementById("topN").value);
  const poolSize = Number(document.getElementById("poolSize").value);
  const radius = Number(document.getElementById("electrodeRadius").value);
  const minimumCoverage = Number(document.getElementById("minimumCoverage").value);
  const maxPolarityAngle = Number(document.getElementById("maxPolarityAngle").value);
  const maxNewFootprint = Number(document.getElementById("maxNewFootprint").value);
  const requireCoverage = document.getElementById("requireCoverage").checked;
  const weights = importanceWeights();
  validateCurrents(currents);
  return {
    capRows,
    originalLabels,
    currents,
    geometry: calculationGeometry(),
    poolSize,
    topN,
    importance: weights,
    footprintRadius: radius,
    constraints: {
      maxDisplacement: Number(document.getElementById("maxDisplacement").value),
      requireCoverage,
      minimumCoverage,
      maxPolarityAngle,
      maxNewFootprint,
    },
  };
}

async function suggestReplacements() {
  const payload = searchPayload();
  const result = await runWorkerSearch(payload);
  canonicalSuggestions = result.suggestions;
  displayedSuggestions = sortDisplayedSuggestions(canonicalSuggestions);
  selectedCandidate = canonicalSuggestions[0] || null;
  renderResults();
  renderMap(selectedCandidate);
  renderMetricDetails(selectedCandidate);
  statusMessage.textContent = canonicalSuggestions.length
    ? `${canonicalSuggestions.length} contenders found. ${result.counts.scored} scored, ${result.counts.pruned} pruned.`
    : `No contenders met the current settings. Rejections: ${result.counts.duplicate} duplicate, ${result.counts.maxDisplacement} max movement, ${result.counts.coverage} coverage, ${result.counts.polarityAngle} polarity angle, ${result.counts.footprint} footprint.`;
}

function runWorkerSearch(payload) {
  return new Promise((resolve, reject) => {
    activeWorker = new Worker("./search-worker.js?v=20260713-v9-scoring-core", { type: "module" });
    activeWorker.onmessage = (event) => {
      const { type, progress, result, message } = event.data;
      if (type === "progress") updateSearchProgress(progress);
      if (type === "complete") {
        activeWorker.terminate();
        activeWorker = null;
        resolve(result);
      }
      if (type === "error") {
        activeWorker.terminate();
        activeWorker = null;
        reject(new Error(message));
      }
    };
    activeWorker.onerror = (event) => {
      activeWorker?.terminate();
      activeWorker = null;
      reject(new Error(event.message || "Search worker failed."));
    };
    activeWorker.postMessage({ type: "search", payload });
  });
}

function scoreManual() {
  const originalLabels = readInputs("original");
  const manualLabels = readInputs("manual");
  const currents = readCurrents();
  const weights = importanceWeights();
  const radius = Number(document.getElementById("electrodeRadius").value);
  const validation = Core.validateManualCandidate({
    capRows,
    originalLabels,
    candidateLabels: manualLabels,
    currents,
    geometry: calculationGeometry(),
    importance: weights,
    footprintRadius: radius,
    maxCurrent: Number(document.getElementById("maxCurrent").value),
    constraints: {
      maxDisplacement: Number(document.getElementById("maxDisplacement").value),
      requireCoverage: document.getElementById("requireCoverage").checked,
      minimumCoverage: Number(document.getElementById("minimumCoverage").value),
      maxPolarityAngle: Number(document.getElementById("maxPolarityAngle").value),
      maxNewFootprint: Number(document.getElementById("maxNewFootprint").value),
    },
  });
  if (!validation.canScore) {
    selectedCandidate = null;
    renderMetricDetails(null);
    document.getElementById("manualScore").innerHTML = renderChecklist(validation.checklist, "Manual candidate was not scored.");
    statusMessage.textContent = "Manual montage failed hard validation.";
    return;
  }
  const score = validation.score;
  score.maxDisplacement = Number(document.getElementById("maxDisplacement").value);
  score.eligible = validation.eligible;
  score.constraintChecklist = validation.checklist;
  score.replacements = originalLabels.map((label, index) => (label === manualLabels[index] ? null : `${label} (${currents[index]} mA)->${manualLabels[index]}`)).filter(Boolean).join("; ") || "none";
  score.replacementRows = originalLabels.map((label, index) => ({ original: label, candidate: manualLabels[index], current: currents[index] }));
  score.keptOriginals = originalLabels.filter((label, index) => label === manualLabels[index]).join(", ") || "none";
  selectedCandidate = score;
  renderMap(score);
  renderMetricDetails(score);
  document.getElementById("manualScore").innerHTML = `
    <strong>Manual score:</strong> ${score.finalScore.toFixed(3)}<br>
    ${score.eligible ? "Eligible under current search constraints." : "Not eligible under current search constraints."}<br>
    Weighted movement: ${score.weightedDistance.toFixed(2)}<br>
    Max movement: ${score.maxDistance.toFixed(2)}
    ${renderChecklist(validation.checklist)}
  `;
}

function renderChecklist(checklist, intro = "") {
  return `
    <div class="constraint-checklist">
      ${intro ? `<p>${intro}</p>` : ""}
      ${checklist.map((item) => `<div><span class="check-badge ${item.pass ? "pass" : "fail"}">${item.pass ? "Pass" : "Fail"}</span>${item.label}</div>`).join("")}
    </div>
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
  if (isLoading) updateSearchProgress({ progress: 0, scored: 0, eligible: 0, pruned: 0 });
}

function compareSuggestions(a, b) {
  const direction = sortDirection;
  if (sortKey === "percentOriginalRegionCovered") {
    return (b[sortKey] - a[sortKey]) * direction;
  }
  return (a[sortKey] - b[sortKey]) * direction;
}

function sortDisplayedSuggestions(rows) {
  return [...rows].sort(compareSuggestions);
}

async function runLongCalculation(action) {
  setLoading(true);
  statusMessage.textContent = "Calculating...";
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  try {
    await action();
  } catch (error) {
    statusMessage.textContent = error.message;
  } finally {
    setLoading(false);
  }
}

function updateSearchProgress(progress) {
  const bar = document.getElementById("progressBar");
  const text = document.getElementById("progressText");
  if (bar) bar.style.width = `${Math.round((progress.progress || 0) * 100)}%`;
  if (text) {
    text.textContent = `${Math.round((progress.progress || 0) * 100)}% · ${progress.scored || 0} scored · ${progress.eligible || 0} eligible · ${progress.pruned || 0} pruned`;
  }
}

function cancelSearch() {
  if (!activeWorker) return;
  activeWorker.terminate();
  activeWorker = null;
  setLoading(false);
  statusMessage.textContent = "Search cancelled.";
}

function readInputs(prefix) {
  return Array.from(document.querySelectorAll(`[data-input-group="${prefix}"]`)).map((input) => normalizeLabel(input.value));
}

function readCurrents() {
  return Array.from(document.querySelectorAll("[data-current-index]")).map((input) => Number(input.value));
}

function currentPolarity(current) {
  if (current > 0) return "positive";
  if (current < 0) return "negative";
  return "zero";
}

function updateCurrentBalanceStatus() {
  const status = document.getElementById("currentBalanceStatus");
  if (!status) return;
  const currents = readCurrents();
  const balance = currents.length ? currentBalance(currents) : 0;
  const isBalanced = Math.abs(balance) <= CURRENT_BALANCE_TOLERANCE;
  status.textContent = isBalanced
    ? `Balanced: ${balance.toFixed(3)} mA`
    : `Invalid montage: total current must equal 0 mA (${balance.toFixed(3)} mA)`;
  status.classList.toggle("invalid", !isBalanced);
}

function updateSearchSummary() {
  const summary = document.getElementById("searchSummary");
  if (!summary) return;
  const geometryLabel = calculationGeometry() === "3d" ? "3D Cartesian" : "2D cap map";
  const maxMove = document.getElementById("maxDisplacement")?.value || "";
  const coverage = document.getElementById("minimumCoverage")?.value || "";
  const results = document.getElementById("topN")?.value || "";
  summary.textContent = `${geometryLabel} · max move ${maxMove} · minimum coverage ${coverage}% · ${results} results`;
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
    if (group === "original") renderManualRows();
    renderMap(selectedCandidate);
    updateSearchSummary();
  });
  return input;
}

function makeOriginalMontageRow(index, siteValue, currentValue) {
  const row = document.createElement("div");
  row.className = "montage-row";
  const siteInput = makeSiteInput("original", siteValue ?? DEFAULT_ORIGINAL[index] ?? "", index);
  const current = currentValue ?? DEFAULT_CURRENTS[index] ?? 0;
  row.innerHTML = `
    <label>
      <span>Electrode site</span>
    </label>
    <label>
      <span>Assigned current (mA)</span>
      <input type="number" data-current-index="${index}" min="-10" max="10" step="0.1" value="${current}">
    </label>
    <div class="polarity-pill ${currentPolarity(current)}">${currentPolarity(current)}</div>
  `;
  row.querySelector("label").appendChild(siteInput);
  const currentInput = row.querySelector("[data-current-index]");
  const polarity = row.querySelector(".polarity-pill");
  currentInput.addEventListener("input", () => {
    polarity.textContent = currentPolarity(Number(currentInput.value));
    polarity.className = `polarity-pill ${currentPolarity(Number(currentInput.value))}`;
    updateCurrentBalanceStatus();
    renderManualRows();
    renderMap(selectedCandidate);
  });
  return row;
}

function renderOriginalMontageRows() {
  const rows = document.getElementById("originalMontageRows");
  const existingLabels = rows ? readInputs("original") : [];
  const existingCurrents = rows ? readCurrents() : [];
  rows.replaceChildren();
  for (let index = 0; index < DEFAULT_ORIGINAL.length; index += 1) {
    rows.appendChild(makeOriginalMontageRow(index, existingLabels[index], existingCurrents[index]));
  }
  updateCurrentBalanceStatus();
  renderActiveEntryMode();
}

function statusBadge(label) {
  const row = rowByLabel.get(label);
  if (!label) return `<span class="status-badge muted">empty</span>`;
  if (!row) return `<span class="status-badge fail">unknown</span>`;
  return `<span class="status-badge ${row.status === "open" ? "pass" : "fail"}">${row.status}</span>`;
}

function makeManualRow(index, value) {
  const originalLabels = readInputs("original");
  const currents = readCurrents();
  const original = originalLabels[index] || DEFAULT_ORIGINAL[index];
  const current = currents[index] ?? DEFAULT_CURRENTS[index];
  const row = document.createElement("div");
  row.className = "manual-row";
  const input = makeSiteInput("manual", value ?? DEFAULT_MANUAL[index] ?? "", index);
  row.innerHTML = `
    <div>
      <strong>Replacement for ${original || `slot ${index + 1}`} (${current >= 0 ? "+" : ""}${Number(current).toFixed(1)} mA)</strong>
      <span>Original status ${statusBadge(original)}</span>
    </div>
    <label>
      <span>Manual replacement</span>
    </label>
    <div class="replacement-status">Replacement ${statusBadge(input.value)}</div>
  `;
  row.querySelector("label").appendChild(input);
  input.addEventListener("input", () => {
    row.querySelector(".replacement-status").innerHTML = `Replacement ${statusBadge(normalizeLabel(input.value))}`;
  });
  return row;
}

function renderManualRows() {
  const rows = document.getElementById("manualRows");
  if (!rows) return;
  const existing = readInputs("manual");
  rows.replaceChildren();
  for (let index = 0; index < DEFAULT_ORIGINAL.length; index += 1) {
    rows.appendChild(makeManualRow(index, existing[index]));
  }
}

function initControls() {
  renderOriginalMontageRows();
  renderManualRows();
  document.getElementById("selectOriginalButton").addEventListener("click", () => setActiveEntryGroup("original"));
  document.getElementById("selectManualButton").addEventListener("click", () => setActiveEntryGroup("manual"));
  renderActiveEntryMode();

  const importanceControls = document.getElementById("importanceControls");
  for (const [, groupLabel, metrics] of IMPORTANCE) {
    const group = document.createElement("section");
    group.className = "metric-group";
    group.innerHTML = `<h3>${groupLabel}</h3>`;
    for (const [key, label, description] of metrics) {
      const row = document.createElement("label");
      row.className = "slider-row";
      row.innerHTML = `
        <span class="slider-topline"><span>${label}</span><strong id="value-${key}">${DEFAULT_IMPORTANCE[key]}</strong></span>
        <small>${description}</small>
        <input id="importance-${key}" type="range" min="0" max="10" value="${DEFAULT_IMPORTANCE[key]}">
      `;
      group.appendChild(row);
      row.querySelector("input").addEventListener("input", (event) => {
        document.getElementById(`value-${key}`).textContent = event.target.value;
      });
    }
    importanceControls.appendChild(group);
  }
  document.getElementById("resetWeightsButton").addEventListener("click", () => setImportanceValues(DEFAULT_IMPORTANCE));
  document.getElementById("equalWeightsButton").addEventListener("click", () => {
    const values = {};
    for (const [, , metrics] of IMPORTANCE) {
      metrics.forEach(([key]) => {
        values[key] = EQUAL_WEIGHT;
      });
    }
    setImportanceValues(values);
  });
  document.querySelectorAll("#poolSize,#topN,#maxDisplacement,#minimumCoverage,#requireCoverage").forEach((input) => {
    input.addEventListener("input", updateSearchSummary);
    input.addEventListener("change", updateSearchSummary);
  });
  document.querySelectorAll(".sort-button").forEach((button) => {
    button.addEventListener("click", () => {
      const nextKey = button.dataset.sort;
      sortDirection = sortKey === nextKey ? sortDirection * -1 : 1;
      sortKey = nextKey;
      displayedSuggestions = sortDisplayedSuggestions(canonicalSuggestions);
      renderResults();
    });
  });
  document.getElementById("coordinateSource").textContent = COORDINATE_SOURCE;
  document.getElementById("coordinateUnits").textContent = COORDINATE_UNITS;
  renderCoordinateValidation();
  updateSearchSummary();
}

function setImportanceValues(values) {
  for (const [key, value] of Object.entries(values)) {
    const input = document.getElementById(`importance-${key}`);
    const output = document.getElementById(`value-${key}`);
    if (!input || !output) continue;
    input.value = value;
    output.textContent = value;
  }
}

function renderCoordinateValidation() {
  const panel = document.getElementById("coordinateValidation");
  if (!panel) return;
  const metadata = coordinateMetadata || {
    source_file: COORDINATE_SOURCE,
    units: "Unverified",
    origin: "Unverified",
    axis_orientation: "Unverified",
    verified: false,
    notes: "Coordinate metadata is not yet verified. Distances are reported in coordinate units and should not be interpreted as millimeters.",
  };
  document.getElementById("coordinateSource").textContent = metadata.source_file || COORDINATE_SOURCE;
  document.getElementById("coordinateUnits").textContent = metadata.units || "Unverified";
  const numericClass = capValidation.ok ? "ok" : "warning";
  panel.className = "validation-panel";
  panel.innerHTML = `
    <section class="validation-subpanel ${numericClass}">
      <strong>Numeric coordinate check</strong>
      ${capValidation.ok
        ? "<span>Passed: all selectable sites contain finite x/y/z values.</span>"
        : `<ul>${capValidation.warnings.map((warning) => `<li>${warning}</li>`).join("")}</ul>`}
    </section>
    <section class="validation-subpanel ${metadata.verified ? "ok" : "warning"}">
      <strong>Coordinate metadata</strong>
      <dl>
        <div><dt>Source</dt><dd>${metadata.source_file || COORDINATE_SOURCE}</dd></div>
        <div><dt>Units</dt><dd>${metadata.units || "Unverified"}</dd></div>
        <div><dt>Origin</dt><dd>${metadata.origin || "Unverified"}</dd></div>
        <div><dt>Orientation</dt><dd>${metadata.axis_orientation || "Unverified"}</dd></div>
        <div><dt>Verified</dt><dd>${metadata.verified ? "Yes" : "No"}</dd></div>
      </dl>
      <span>${metadata.notes || "Coordinate metadata is not yet verified. Distances are reported in coordinate units and should not be interpreted as millimeters."}</span>
    </section>
  `;
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
  if (activeEntryGroup === "original") renderManualRows();
  if (activeEntryGroup === "manual") renderManualRows();
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
  svg.appendChild(svgEl("rect", { x, y, width: 188, height: 172, rx: 6, fill: "#fff", stroke: "#d6dce5" }));
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
  svg.appendChild(svgEl("circle", { cx: x + 30, cy: y + 94, r: 10, fill: "#20b15a", stroke: "#166534", "stroke-width": 2 }));
  text = svgEl("text", { x: x + 66, y: y + 99, class: "legend-label" });
  text.textContent = "original montage";
  svg.appendChild(text);
  svg.appendChild(svgEl("circle", { cx: x + 30, cy: y + 122, r: 10, fill: "#8d4be8", stroke: "#6b21a8", "stroke-width": 2 }));
  text = svgEl("text", { x: x + 66, y: y + 127, class: "legend-label" });
  text.textContent = "candidate montage";
  svg.appendChild(text);
  svg.appendChild(svgEl("path", { d: `M ${x + 18} ${y + 149} L ${x + 44} ${y + 149}`, stroke: "#475467", "stroke-width": 2, "stroke-dasharray": "4 4", "marker-end": "url(#arrowHead)" }));
  text = svgEl("text", { x: x + 66, y: y + 154, class: "legend-label" });
  text.textContent = "replacement path";
  svg.appendChild(text);
}

function renderArrowDefs() {
  const defs = svgEl("defs");
  const marker = svgEl("marker", { id: "arrowHead", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto", markerUnits: "strokeWidth" });
  marker.appendChild(svgEl("path", { d: "M 0 0 L 8 4 L 0 8 z", fill: "#475467" }));
  defs.appendChild(marker);
  svg.appendChild(defs);
}

function renderCorrespondenceArrows(candidate, mapper) {
  if (!candidate?.replacementRows) return;
  const group = svgEl("g", { class: "correspondence-arrows" });
  for (const row of candidate.replacementRows) {
    if (row.original === row.candidate) continue;
    const original = rowByLabel.get(row.original);
    const replacement = rowByLabel.get(row.candidate);
    if (!original || !replacement) continue;
    group.appendChild(svgEl("line", {
      x1: mapper.x(original.mapX),
      y1: mapper.y(original.mapY),
      x2: mapper.x(replacement.mapX),
      y2: mapper.y(replacement.mapY),
      class: "replacement-arrow",
      "marker-end": "url(#arrowHead)",
    }));
  }
  svg.appendChild(group);
}

function renderMetricDetails(candidate) {
  if (!candidate) {
    metricDetails.classList.remove("visible");
    metricDetails.replaceChildren();
    return;
  }
  const unitLabel = coordinateMetadata?.verified && coordinateMetadata?.units && coordinateMetadata.units !== "Unverified"
    ? coordinateMetadata.units
    : "coordinate units";
  const groups = [
    ["Summary", [
      ["Final score", candidate.finalScore.toFixed(3)],
      ["Calculation geometry", candidate.calculationGeometry],
      ["Current balance", `${candidate.currentBalance.toFixed(4)} mA`],
      ["Eligibility status", candidate.eligible === false ? "Not eligible" : "Eligible or auto-selected"],
      ["Canonical rank", candidate.scoreRank || "Manual"],
    ]],
    ["Electrode placement", [
      ["Weighted movement", `${candidate.weightedDistance.toFixed(3)} ${unitLabel}`],
      ["Mean movement", `${candidate.meanDistance.toFixed(3)} ${unitLabel}`],
      ["RMS movement", `${candidate.rmsDistance.toFixed(3)} ${unitLabel}`],
      ["Max movement", `${candidate.maxDistance.toFixed(3)} / ${candidate.maxDisplacement.toFixed(1)} ${unitLabel}`],
    ]],
    ["Montage geometry", [
      ["Weighted pairwise error", `${(candidate.weightedPairwiseRelative * 100).toFixed(1)}%`],
      ["RMS pairwise error", `${(candidate.rmsPairwiseRelative * 100).toFixed(1)}%`],
      ["Max pairwise error", `${(candidate.maxPairwiseRelative * 100).toFixed(1)}%`],
      ["Pairwise angle change", `${candidate.pairAngle.toFixed(1)}°`],
    ]],
    ["Current-flow geometry", [
      ["Positive-center shift", `${candidate.positiveCenterShift.toFixed(3)} ${unitLabel}`],
      ["Negative-center shift", `${candidate.negativeCenterShift.toFixed(3)} ${unitLabel}`],
      ["Mean polarity-center shift", `${candidate.polarityCenterShift.toFixed(3)} ${unitLabel}`],
      ["Polarity-vector angle change", `${candidate.polarityVectorAngle.toFixed(1)}°`],
      ["Polarity-vector length change", `${candidate.polarityVectorLengthChange.toFixed(3)} ${unitLabel}`],
      ["Polarity-vector midpoint shift", `${candidate.polarityVectorMidpointShift.toFixed(3)} ${unitLabel}`],
    ]],
    ["Spatial coverage", [
      ["Original region covered", `${candidate.percentOriginalRegionCovered.toFixed(1)}%`],
      ["Candidate region new", `${candidate.percentCandidateRegionNew.toFixed(1)}%`],
      ["Schematic footprint overlap", `${candidate.percentOriginalAreaCovered.toFixed(1)}%`],
      ["Candidate schematic footprint new", `${candidate.percentCandidateAreaNew.toFixed(1)}%`],
    ]],
    ["Replacements", [
      ["Kept originals", candidate.keptOriginals || "none"],
      ["Replacement rows", (candidate.replacementRows || []).map((row) => `${row.original} (${row.current} mA) -> ${row.candidate}`).join("<br>") || candidate.replacements || "none"],
    ]],
  ];
  const sections = groups.map(([title, metrics]) => {
    const section = document.createElement("section");
    section.className = "metric-section";
    section.innerHTML = `<h3>${title}</h3>`;
    for (const [label, value] of metrics) {
      const card = document.createElement("div");
      card.className = "metric-card";
      card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
      section.appendChild(card);
    }
    return section;
  });
  sections.push(renderContributionBreakdown(candidate));
  metricDetails.replaceChildren(...sections);
  metricDetails.classList.add("visible");
}

function renderContributionBreakdown(candidate) {
  const section = document.createElement("section");
  section.className = "metric-section contribution-section";
  const rows = [...candidate.contributions].sort((a, b) => b.weightedContribution - a.weightedContribution);
  const sum = rows.reduce((total, row) => total + row.weightedContribution, 0);
  section.innerHTML = `
    <h3>Why this candidate received this score</h3>
    <div class="contribution-wrap">
      <table>
        <thead>
          <tr><th>Metric</th><th>Raw result</th><th>Normalized penalty</th><th>Importance</th><th>Normalized weight</th><th>Score contribution</th></tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${row.label}</td>
              <td>${Number(row.rawValue).toFixed(3)}</td>
              <td>${row.normalizedPenalty.toFixed(3)}</td>
              <td>${row.rawImportance}</td>
              <td>${row.normalizedWeight.toFixed(3)}</td>
              <td>${row.weightedContribution.toFixed(3)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p>Contributions sum to final score: ${sum.toFixed(3)}</p>
  `;
  return section;
}

function renderMap(candidate) {
  const originalLabels = readInputs("original").filter(Boolean);
  const candidateLabels = candidate ? candidate.candidateLabels : [];
  const originalSet = new Set(originalLabels);
  const candidateSet = new Set(candidateLabels);
  const mapper = scaleMapper();
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${mapper.width} ${mapper.height}`);

  renderArrowDefs();
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
  renderCorrespondenceArrows(candidate, mapper);

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
    const currentRow = candidate?.replacementRows?.find((item) => item.original === row.label || item.candidate === row.label);
    if (currentRow && (inOriginal || inCandidate)) {
      const currentText = svgEl("text", {
        x: cx,
        y: cy + 27,
        "text-anchor": "middle",
        class: "current-map-label",
        fill: "#172033",
      });
      currentText.textContent = `${currentRow.current > 0 ? "+" : ""}${Number(currentRow.current).toFixed(1)} mA`;
      g.appendChild(currentText);
    }
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
  displayedSuggestions.forEach((row) => {
    const tr = document.createElement("tr");
    if (row === selectedCandidate) tr.classList.add("selected");
    tr.innerHTML = `
      <td>${row.scoreRank}</td>
      <td>${row.finalScore.toFixed(3)}</td>
      <td>${row.maxDistance.toFixed(1)}</td>
      <td>${row.weightedDistance.toFixed(1)}</td>
      <td>${row.percentOriginalRegionCovered.toFixed(1)}%</td>
      <td>${row.polarityVectorAngle.toFixed(1)}°</td>
      <td>${row.candidateMontage}</td>
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
    document.getElementById("cancelSearchButton").addEventListener("click", cancelSearch);
    document.querySelectorAll('input[name="calculationGeometry"]').forEach((input) => {
      input.addEventListener("change", () => {
        canonicalSuggestions = [];
        displayedSuggestions = [];
        selectedCandidate = null;
        resultsBody.replaceChildren();
        renderMetricDetails(null);
        renderMap(null);
        updateSearchSummary();
        document.getElementById("coordinateModel").textContent = calculationGeometry() === "3d" ? "3D Cartesian" : "2D cap map";
        statusMessage.textContent = `Ready. Using ${calculationGeometry() === "3d" ? "3D Cartesian" : "2D cap map"} calculations.`;
      });
    });
  } catch (error) {
    statusMessage.textContent = error.message;
  }
}

main();
