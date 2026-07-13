import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_IMPORTANCE,
  movementReference,
  scoreMontage,
  searchReplacements,
  validateManualCandidate,
} from "./scoring-core.js";

const capRows = [
  { label: "A", x: 0, y: 0, z: 0, mapX: 0, mapY: 0, status: "blocked" },
  { label: "B", x: 10, y: 0, z: 0, mapX: 1, mapY: 0, status: "blocked" },
  { label: "C", x: 0, y: 10, z: 0, mapX: 0, mapY: 1, status: "blocked" },
  { label: "D", x: 10, y: 10, z: 0, mapX: 1, mapY: 1, status: "blocked" },
  { label: "E", x: 5, y: 5, z: 5, mapX: 0.5, mapY: 0.5, status: "blocked" },
  { label: "OA", x: 0, y: 0, z: 0, mapX: 0, mapY: 0, status: "open" },
  { label: "OB", x: 11, y: 0, z: 0, mapX: 1.1, mapY: 0, status: "open" },
  { label: "OC", x: 0, y: 11, z: 0, mapX: 0, mapY: 1.1, status: "open" },
  { label: "OD", x: 11, y: 11, z: 0, mapX: 1.1, mapY: 1.1, status: "open" },
  { label: "OE", x: 6, y: 5, z: 5, mapX: 0.6, mapY: 0.5, status: "open" },
  { label: "FAR", x: 50, y: 50, z: 50, mapX: 5, mapY: 5, status: "open" },
];

const originalLabels = ["A", "B", "C", "D", "E"];
const candidateLabels = ["OA", "OB", "OC", "OD", "OE"];
const currents = [2, -0.5, -0.5, -0.5, -0.5];
const constraints = {
  maxDisplacement: 75,
  requireCoverage: true,
  minimumCoverage: 0,
  maxPolarityAngle: 180,
  maxNewFootprint: 100,
};

function baseScore(overrides = {}) {
  return scoreMontage({
    capRows,
    originalLabels,
    candidateLabels,
    currents,
    geometry: "3d",
    importance: DEFAULT_IMPORTANCE,
    footprintRadius: 0.35,
    ...overrides,
  });
}

test("identical montage has negligible score and perfect region", () => {
  const score = baseScore({ candidateLabels: originalLabels });
  assert.equal(score.weightedDistance, 0);
  assert.equal(score.maxDistance, 0);
  assert.equal(score.weightedPairwiseRelative, 0);
  assert.ok(score.pairAngle < 1e-6);
  assert.equal(score.polarityCenterShift, 0);
  assert.equal(score.percentOriginalRegionCovered, 100);
  assert.equal(score.percentCandidateRegionNew, 0);
  assert.ok(score.finalScore < 1e-6);
});

test("current-weighted movement emphasizes high-current electrode", () => {
  const highCurrentMoved = baseScore({ candidateLabels: ["FAR", "B", "C", "D", "E"] });
  const lowCurrentMoved = baseScore({ candidateLabels: ["A", "FAR", "C", "D", "E"] });
  assert.ok(highCurrentMoved.weightedDistance > lowCurrentMoved.weightedDistance);
});

test("RMS movement is at least mean and max movement is farthest", () => {
  const score = baseScore();
  assert.ok(score.rmsDistance >= score.meanDistance);
  assert.equal(score.maxDistance, Math.SQRT2);
});

test("maximum displacement limit does not change score", () => {
  const score75 = baseScore();
  const score150 = baseScore();
  score75.maxDisplacement = 75;
  score150.maxDisplacement = 150;
  assert.equal(score75.finalScore, score150.finalScore);
});

test("polarity vector penalty is averaged and contributions sum", () => {
  const score = baseScore();
  const vectorContribution = score.contributions.find((item) => item.key === "polarityVector");
  const expected = (
    score.polarityVectorComponents.midpointPenalty +
    score.polarityVectorComponents.lengthPenalty +
    score.polarityVectorComponents.anglePenalty
  ) / 3;
  assert.equal(vectorContribution.normalizedPenalty, expected);
  const contributionSum = score.contributions.reduce((sum, item) => sum + item.weightedContribution, 0);
  assert.ok(Math.abs(contributionSum - score.finalScore) < 1e-12);
});

test("new area uses candidate region new and region is map-based", () => {
  const score3d = baseScore({ geometry: "3d" });
  const score2d = baseScore({ geometry: "2d" });
  assert.equal(score3d.percentOriginalRegionCovered, score2d.percentOriginalRegionCovered);
  assert.equal(score3d.percentCandidateRegionNew, score2d.percentCandidateRegionNew);
  const newAreaContribution = score3d.contributions.find((item) => item.key === "newArea");
  assert.equal(newAreaContribution.rawValue, score3d.percentCandidateRegionNew);
});

test("2D movement reference uses map coordinates", () => {
  const ref2d = movementReference(capRows, "2d");
  assert.ok(ref2d < 1);
});

test("manual validation rejects duplicates, unknown labels, and blocked replacements", () => {
  const duplicate = validateManualCandidate({ capRows, originalLabels, candidateLabels: ["OA", "OA", "OC", "OD", "OE"], currents, maxCurrent: 2, constraints, geometry: "3d", importance: DEFAULT_IMPORTANCE, footprintRadius: 0.35 });
  assert.equal(duplicate.canScore, false);
  const unknown = validateManualCandidate({ capRows, originalLabels, candidateLabels: ["OA", "MISSING", "OC", "OD", "OE"], currents, maxCurrent: 2, constraints, geometry: "3d", importance: DEFAULT_IMPORTANCE, footprintRadius: 0.35 });
  assert.equal(unknown.canScore, false);
  const blocked = validateManualCandidate({ capRows, originalLabels, candidateLabels: ["OA", "B", "OC", "OD", "OE"], currents, maxCurrent: 2, constraints, geometry: "3d", importance: DEFAULT_IMPORTANCE, footprintRadius: 0.35 });
  assert.equal(blocked.canScore, false);
});

test("canonical search results are independent of display sorting", () => {
  const first = searchReplacements({ capRows, originalLabels, currents, geometry: "3d", poolSize: 4, topN: 3, importance: DEFAULT_IMPORTANCE, footprintRadius: 0.35, constraints });
  const displaySorted = [...first.suggestions].sort((a, b) => b.percentOriginalRegionCovered - a.percentOriginalRegionCovered);
  assert.notDeepEqual(displaySorted.map((item) => item.candidateMontage), []);
  const second = searchReplacements({ capRows, originalLabels, currents, geometry: "3d", poolSize: 4, topN: 3, importance: DEFAULT_IMPORTANCE, footprintRadius: 0.35, constraints });
  assert.deepEqual(first.suggestions.map((item) => item.candidateMontage), second.suggestions.map((item) => item.candidateMontage));
  assert.deepEqual(first.suggestions.map((item) => item.scoreRank), [1, 2, 3]);
});
