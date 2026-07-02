const DEFAULT_ORIGINAL = ["CP4", "P2", "P6", "PO8", "O2"];
const DEFAULT_MANUAL = ["POO2", "POO10h", "TPP8h", "CCP6h", "PPO2h"];

const IMPORTANCE = [
  ["distance", "Distance"],
  ["pairwiseDistance", "Pairwise distance"],
  ["pairwiseAngle", "Pairwise angle"],
  ["regionCoverage", "Region coverage"],
  ["footprintCoverage", "Footprint overlap"],
  ["newArea", "New area"],
  ["centerShift", "Center shift"],
];

const DEFAULT_IMPORTANCE = {
  distance: 6,
  pairwiseDistance: 5,
  pairwiseAngle: 4,
  regionCoverage: 10,
  footprintCoverage: 2,
  newArea: 2,
  centerShift: 2,
};

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
      status: row.status.trim().toLowerCase(),
    };
  });
}

async function loadCoordinates() {
  const response = await fetch("data/easycap_cac64_soterix_draft.csv");
  if (!response.ok) throw new Error("Could not load coordinate CSV.");
  capRows = parseCsv(await response.text());
  rowByLabel = new Map(capRows.map((row) => [row.label, row]));
}

function getPoint(label) {
  const row = rowByLabel.get(label);
  if (!row) throw new Error(`Unknown label: ${label}`);
  return { x: row.x, y: row.y, label: row.label, status: row.status };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angle(a, b) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

function angleDiff(a, b) {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

function center(points) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function pairedDistances(original, candidate) {
  return original.map((point, index) => distance(point, candidate[index]));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pairwiseDistanceChange(original, candidate) {
  const changes = [];
  for (let i = 0; i < original.length; i += 1) {
    for (let j = i + 1; j < original.length; j += 1) {
      changes.push(Math.abs(distance(original[i], original[j]) - distance(candidate[i], candidate[j])));
    }
  }
  return mean(changes);
}

function pairwiseAngleChange(original, candidate) {
  const changes = [];
  for (let i = 0; i < original.length; i += 1) {
    for (let j = i + 1; j < original.length; j += 1) {
      changes.push(angleDiff(angle(original[i], original[j]), angle(candidate[i], candidate[j])));
    }
  }
  return mean(changes);
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
  const originalHull = convexHull(original);
  const candidateHull = convexHull(candidate);
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
  const minX = Math.min(...original.concat(candidate).map((p) => p.x)) - radius;
  const maxX = Math.max(...original.concat(candidate).map((p) => p.x)) + radius;
  const minY = Math.min(...original.concat(candidate).map((p) => p.y)) - radius;
  const maxY = Math.max(...original.concat(candidate).map((p) => p.y)) + radius;
  const steps = 42;
  const dx = (maxX - minX) / steps;
  const dy = (maxY - minY) / steps;
  let originalCount = 0;
  let candidateCount = 0;
  let overlapCount = 0;

  for (let ix = 0; ix < steps; ix += 1) {
    for (let iy = 0; iy < steps; iy += 1) {
      const sample = { x: minX + (ix + 0.5) * dx, y: minY + (iy + 0.5) * dy };
      const inOriginal = original.some((point) => distance(point, sample) <= radius);
      const inCandidate = candidate.some((point) => distance(point, sample) <= radius);
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

function scoreMontage(originalLabels, candidateLabels, weights, radius) {
  if (originalLabels.length !== 5 || candidateLabels.length !== 5 || originalLabels.some((label) => !label) || candidateLabels.some((label) => !label)) {
    throw new Error("Please enter exactly 5 electrode labels.");
  }
  originalLabels.forEach(getPoint);
  candidateLabels.forEach(getPoint);
  const original = originalLabels.map(getPoint);
  const candidate = candidateLabels.map(getPoint);
  const paired = pairedDistances(original, candidate);
  const region = regionMetrics(original, candidate);
  const footprint = footprintMetrics(original, candidate, radius);
  const shift = distance(center(original), center(candidate));
  const meanDistance = mean(paired);
  const pairDistance = pairwiseDistanceChange(original, candidate);
  const pairAngle = pairwiseAngleChange(original, candidate);
  const score =
    weights.distance * Math.min(meanDistance / 2, 1) +
    weights.pairwiseDistance * Math.min(pairDistance / 2, 1) +
    weights.pairwiseAngle * Math.min(pairAngle / 90, 1) +
    weights.regionCoverage * ((100 - region.percentOriginalRegionCovered) / 100) +
    weights.footprintCoverage * ((100 - footprint.percentOriginalAreaCovered) / 100) +
    weights.newArea * (footprint.percentCandidateAreaNew / 100) +
    weights.centerShift * Math.min(shift / 2, 1);

  return {
    candidateLabels,
    candidateMontage: candidateLabels.join(", "),
    finalScore: score,
    meanDistance,
    pairDistance,
    pairAngle,
    centerShift: shift,
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
  return capRows
    .filter((row) => row.status === "open" && !excludeLabels.has(row.label))
    .map((row) => ({ label: row.label, distance: distance(target, row) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, poolSize)
    .map((row) => row.label);
}

function cartesianProduct(arrays) {
  return arrays.reduce((acc, values) => acc.flatMap((prefix) => values.map((value) => prefix.concat(value))), [[]]);
}

function suggestReplacements() {
  const originalLabels = readInputs("original");
  const topN = Number(document.getElementById("topN").value);
  const poolSize = Number(document.getElementById("poolSize").value);
  const radius = Number(document.getElementById("electrodeRadius").value);
  const minimumCoverage = Number(document.getElementById("minimumCoverage").value);
  const requireCoverage = document.getElementById("requireCoverage").checked;
  const weights = importanceWeights();

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
    const score = scoreMontage(originalLabels, candidate, weights, radius);
    if (requireCoverage && score.percentOriginalRegionCovered < minimumCoverage) continue;
    score.replacements = blocked.map((item, index) => `${item.label}->${replacements[index]}`).join("; ") || "none";
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
  const weights = importanceWeights();
  const radius = Number(document.getElementById("electrodeRadius").value);
  const score = scoreMontage(originalLabels, manualLabels, weights, radius);
  score.replacements = originalLabels.map((label, index) => (label === manualLabels[index] ? null : `${label}->${manualLabels[index]}`)).filter(Boolean).join("; ") || "none";
  score.keptOriginals = originalLabels.filter((label, index) => label === manualLabels[index]).join(", ") || "none";
  selectedCandidate = score;
  renderMap(score);
  renderMetricDetails(score);
  document.getElementById("manualScore").innerHTML = `
    <strong>Manual score:</strong> ${score.finalScore.toFixed(3)}<br>
    Region coverage: ${score.percentOriginalRegionCovered.toFixed(1)}%<br>
    Footprint overlap: ${score.percentOriginalAreaCovered.toFixed(1)}%
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

function initControls() {
  const originalInputs = document.getElementById("originalInputs");
  const manualInputs = document.getElementById("manualInputs");
  DEFAULT_ORIGINAL.forEach((label, index) => originalInputs.appendChild(makeSiteInput("original", label, index)));
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
  const xs = capRows.map((row) => row.x);
  const ys = capRows.map((row) => row.y);
  const minX = Math.floor(Math.min(...xs)) - 1;
  const maxX = Math.ceil(Math.max(...xs)) + 1;
  const minY = Math.floor(Math.min(...ys)) - 1;
  const maxY = Math.ceil(Math.max(...ys)) + 1;
  const width = 860;
  const height = 760;
  const pad = { left: 58, right: 22, top: 42, bottom: 58 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
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
    x: (value) => pad.left + ((value - minX) / (maxX - minX)) * plotWidth,
    y: (value) => pad.top + ((maxY - value) / (maxY - minY)) * plotHeight,
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

function renderGrid(mapper) {
  const { minX, maxX, minY, maxY, pad, plotWidth, plotHeight } = mapper;
  svg.appendChild(svgEl("rect", {
    x: pad.left,
    y: pad.top,
    width: plotWidth,
    height: plotHeight,
    fill: "#ffffff",
    stroke: "#2f3540",
    "stroke-width": 1.5,
  }));

  for (let x = minX; x <= maxX; x += 1) {
    const sx = mapper.x(x);
    svg.appendChild(svgEl("line", { x1: sx, y1: pad.top, x2: sx, y2: pad.top + plotHeight, class: "grid-line" }));
    if (x % 2 === 0) {
      const label = svgEl("text", { x: sx, y: pad.top + plotHeight + 28, "text-anchor": "middle", class: "axis-label" });
      label.textContent = x;
      svg.appendChild(label);
    }
  }
  for (let y = minY; y <= maxY; y += 1) {
    const sy = mapper.y(y);
    svg.appendChild(svgEl("line", { x1: pad.left, y1: sy, x2: pad.left + plotWidth, y2: sy, class: "grid-line" }));
    if (y % 2 === 0) {
      const label = svgEl("text", { x: pad.left - 18, y: sy + 4, "text-anchor": "middle", class: "axis-label" });
      label.textContent = y;
      svg.appendChild(label);
    }
  }

  const xLabel = svgEl("text", { x: pad.left + plotWidth / 2, y: mapper.height - 12, "text-anchor": "middle", class: "axis-title" });
  xLabel.textContent = "x";
  svg.appendChild(xLabel);
  const yLabel = svgEl("text", { x: 18, y: pad.top + plotHeight / 2, "text-anchor": "middle", class: "axis-title", transform: `rotate(-90 18 ${pad.top + plotHeight / 2})` });
  yLabel.textContent = "y";
  svg.appendChild(yLabel);

  const title = svgEl("text", { x: pad.left + plotWidth / 2, y: 24, "text-anchor": "middle", class: "plot-title" });
  title.textContent = "2D electrode layout";
  svg.appendChild(title);
}

function renderHeadGuide(mapper) {
  svg.appendChild(svgEl("ellipse", {
    cx: mapper.x(0),
    cy: mapper.y(0.2),
    rx: Math.abs(mapper.x(4.6) - mapper.x(0)),
    ry: Math.abs(mapper.y(4.55) - mapper.y(0.2)),
    class: "head-guide",
  }));
  svg.appendChild(svgEl("polygon", {
    points: `${mapper.x(-0.34)},${mapper.y(4.6)} ${mapper.x(0)},${mapper.y(5.28)} ${mapper.x(0.34)},${mapper.y(4.6)}`,
    class: "head-guide",
  }));
}

function renderLegend(mapper) {
  const x = mapper.width - 190;
  const y = 52;
  svg.appendChild(svgEl("rect", { x, y, width: 165, height: 72, rx: 6, fill: "#fff", stroke: "#d6dce5" }));
  svg.appendChild(svgEl("circle", { cx: x + 22, cy: y + 24, r: 13, fill: "#9bd4a2", stroke: "#3d7f49", "stroke-width": 2 }));
  let text = svgEl("text", { x: x + 44, y: y + 29, class: "legend-label" });
  text.textContent = "blocked EEG";
  svg.appendChild(text);
  svg.appendChild(svgEl("circle", { cx: x + 22, cy: y + 52, r: 13, fill: "#fff", stroke: "#667085", "stroke-width": 2, "stroke-dasharray": "6 4" }));
  text = svgEl("text", { x: x + 44, y: y + 57, class: "legend-label" });
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
    ["Original region covered", `${candidate.percentOriginalRegionCovered.toFixed(1)}%`],
    ["Candidate region new", `${candidate.percentCandidateRegionNew.toFixed(1)}%`],
    ["Footprint overlap", `${candidate.percentOriginalAreaCovered.toFixed(1)}%`],
    ["Candidate footprint new", `${candidate.percentCandidateAreaNew.toFixed(1)}%`],
    ["Mean movement", candidate.meanDistance.toFixed(3)],
    ["Pairwise distance change", candidate.pairDistance.toFixed(3)],
    ["Pairwise angle change", `${candidate.pairAngle.toFixed(1)}°`],
    ["Center shift", candidate.centerShift.toFixed(3)],
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

  renderGrid(mapper);
  renderHeadGuide(mapper);

  if (candidate?.originalHull?.length) {
    svg.appendChild(svgEl("polygon", {
      points: polygonPoints(candidate.originalHull, mapper),
      fill: "rgba(32,177,90,0.10)",
      stroke: "#20b15a",
      "stroke-width": 2,
      "stroke-dasharray": "6 4",
    }));
    svg.appendChild(svgEl("polygon", {
      points: polygonPoints(candidate.candidateHull, mapper),
      fill: "rgba(141,75,232,0.14)",
      stroke: "#8d4be8",
      "stroke-width": 2.2,
    }));
  }

  for (const row of capRows) {
    const cx = mapper.x(row.x);
    const cy = mapper.y(row.y);
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
      g.appendChild(svgEl("path", { d: `M ${cx} ${cy - 16} A 16 16 0 0 0 ${cx} ${cy + 16} L ${cx} ${cy} Z`, fill: "#20b15a", stroke: "#172033", "stroke-width": 1.4 }));
      g.appendChild(svgEl("path", { d: `M ${cx} ${cy - 16} A 16 16 0 0 1 ${cx} ${cy + 16} L ${cx} ${cy} Z`, fill: "#8d4be8", stroke: "#172033", "stroke-width": 1.4 }));
    } else if (inOriginal) {
      g.appendChild(svgEl("circle", { cx, cy, r: 16, fill: "#20b15a", stroke: "#166534", "stroke-width": 2 }));
    } else if (inCandidate) {
      g.appendChild(svgEl("circle", { cx, cy, r: 16, fill: "#8d4be8", stroke: "#6b21a8", "stroke-width": 2 }));
    } else if (row.status === "blocked") {
      g.appendChild(svgEl("circle", { cx, cy, r: 14, fill: "#9bd4a2", stroke: "#3d7f49", "stroke-width": 2 }));
    } else {
      g.appendChild(svgEl("circle", { cx, cy, r: 14, fill: "#fff", stroke: "#667085", "stroke-width": 2, "stroke-dasharray": "6 4" }));
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
    document.getElementById("selectedSummary").textContent = `${candidate.candidateMontage} | region ${candidate.percentOriginalRegionCovered.toFixed(1)}% | score ${candidate.finalScore.toFixed(3)}`;
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
      <td>${row.percentOriginalRegionCovered.toFixed(1)}%</td>
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
  } catch (error) {
    statusMessage.textContent = error.message;
  }
}

main();
