import assert from "node:assert";
import {
  classifyFreshness,
  classifyLicense,
  calculateHealthScore,
  auditRepository,
  auditRepositories,
} from "../lib/audit.js";

console.log("=== Starting Test Suite: Repository Health & Staleness Audit Engine ===");

const FIXED_NOW = new Date("2026-09-21T12:00:00Z");

// [TEST 1] Freshness Classification
console.log("\n[TEST 1] Testing freshness and staleness classification...");

// Active: 10 days ago (< 60)
const activeRepo = {
  name: "test/active",
  pushed_at: "2026-09-11T12:00:00Z",
  archived: false,
};
const activeRes = classifyFreshness(activeRepo, FIXED_NOW);
assert.strictEqual(activeRes.freshness, "ACTIVE", "Repo pushed 10 days ago must be ACTIVE");
assert.strictEqual(activeRes.days, 10, "Days count must equal 10");

// Boundary: 59 days ago (< 60)
const activeBoundary = {
  name: "test/active-59",
  days_since_push: 59,
  archived: false,
};
assert.strictEqual(
  classifyFreshness(activeBoundary, FIXED_NOW).freshness,
  "ACTIVE",
  "59 days must be ACTIVE"
);

// Slow: 60 days ago (60 - 180)
const slowBoundary = {
  name: "test/slow-60",
  days_since_push: 60,
  archived: false,
};
assert.strictEqual(
  classifyFreshness(slowBoundary, FIXED_NOW).freshness,
  "SLOW",
  "60 days must be SLOW"
);

// Slow: 120 days ago
const slowRepo = {
  name: "test/slow",
  pushed_at: "2026-05-24T12:00:00Z", // ~120 days
  archived: false,
};
assert.strictEqual(
  classifyFreshness(slowRepo, FIXED_NOW).freshness,
  "SLOW",
  "120 days must be SLOW"
);

// Stale: 200 days ago (180 - 365)
const staleRepo = {
  name: "test/stale",
  pushed_at: "2026-03-05T12:00:00Z", // 200 days
  archived: false,
};
assert.strictEqual(
  classifyFreshness(staleRepo, FIXED_NOW).freshness,
  "STALE",
  "200 days must be STALE"
);

// Dead / Abandoned: 400 days ago (> 365)
const deadRepo = {
  name: "test/dead",
  pushed_at: "2025-08-17T12:00:00Z", // 400 days
  archived: false,
};
assert.strictEqual(
  classifyFreshness(deadRepo, FIXED_NOW).freshness,
  "DEAD_ABANDONED",
  "400 days must be DEAD_ABANDONED"
);

// Archived repo (even with recent push)
const archivedRepo = {
  name: "test/archived",
  pushed_at: "2026-09-20T12:00:00Z",
  archived: true,
};
assert.strictEqual(
  classifyFreshness(archivedRepo, FIXED_NOW).freshness,
  "ARCHIVED",
  "Archived repository must always classify as ARCHIVED"
);

// Edge Case: Missing date or invalid input
assert.strictEqual(
  classifyFreshness({}, FIXED_NOW).freshness,
  "UNKNOWN",
  "Repo without timestamp must be UNKNOWN"
);
assert.strictEqual(
  classifyFreshness(null, FIXED_NOW).freshness,
  "UNKNOWN",
  "Null repo must be UNKNOWN"
);

console.log("-> PASS: Freshness classification verified!");

// [TEST 2] License Classification
console.log("\n[TEST 2] Testing license classification and legal risk evaluation...");

const permissiveTests = [
  "MIT",
  "mit",
  "Apache-2.0",
  "Apache 2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Unlicense",
  "CC0-1.0",
  "0BSD",
  { spdx_id: "MIT" },
  { name: "Apache License 2.0" },
];

for (const lic of permissiveTests) {
  assert.strictEqual(
    classifyLicense(lic),
    "PERMISSIVE",
    `Expected '${JSON.stringify(lic)}' to be PERMISSIVE`
  );
}

const copyleftTests = [
  "GPL-3.0",
  "GPL-2.0",
  "GPLv3",
  "AGPL-3.0",
  "LGPL-2.1",
  "MPL-2.0",
  "EUPL-1.2",
  "SSPL-1.0",
  { spdx_id: "GPL-3.0-only" },
  { name: "GNU General Public License v3.0" },
];

for (const lic of copyleftTests) {
  assert.strictEqual(
    classifyLicense(lic),
    "COPYLEFT",
    `Expected '${JSON.stringify(lic)}' to be COPYLEFT`
  );
}

const unlicensedTests = [
  null,
  undefined,
  "",
  "NOASSERTION",
  "NONE",
  "UNKNOWN",
  "Custom Proprietary",
  { spdx_id: "NOASSERTION" },
];

for (const lic of unlicensedTests) {
  assert.strictEqual(
    classifyLicense(lic),
    "UNLICENSED",
    `Expected '${JSON.stringify(lic)}' to be UNLICENSED`
  );
}

console.log("-> PASS: License risk categorization verified!");

// [TEST 3] Health Score Calculation
console.log("\n[TEST 3] Testing composite normalized health score (0-100)...");

// High health: active (5d), 15000 stars, MIT license, description & tags
const primeRepo = {
  name: "stellar/prime",
  pushed_at: "2026-09-16T12:00:00Z",
  stars: 15000,
  license: "MIT",
  summary: "Production-grade distributed consensus engine for microservices.",
  tags: ["consensus", "distributed", "raft"],
  archived: false,
};
const primeScore = calculateHealthScore(primeRepo, FIXED_NOW);
assert(primeScore >= 90 && primeScore <= 100, `Prime score should be 90-100, got: ${primeScore}`);

// Moderate health: slow (90d), 120 stars, permissive, no tags
const modRepo = {
  name: "moderate/tool",
  days_since_push: 90,
  stars: 120,
  license: "Apache-2.0",
  summary: "A helpful utility tool for parsing config files.",
  tags: [],
  archived: false,
};
const modScore = calculateHealthScore(modRepo, FIXED_NOW);
assert(modScore >= 50 && modScore < 80, `Moderate score should be 50-80, got: ${modScore}`);

// Capped Archived: repo has 50k stars but is archived
const archivedPopular = {
  name: "legend/old-framework",
  pushed_at: "2026-09-15T12:00:00Z",
  stars: 50000,
  license: "MIT",
  summary: "Ancient giant framework now superseded.",
  tags: ["framework"],
  archived: true,
};
const archScore = calculateHealthScore(archivedPopular, FIXED_NOW);
assert(archScore <= 25, `Archived repository health must be capped at 25, got: ${archScore}`);

// Dead Abandoned repo (> 1 year, 0 stars, unlicensed)
const deadAbandonedRepo = {
  name: "ghost/forgotten",
  days_since_push: 500,
  stars: 0,
  license: null,
  archived: false,
};
const deadScore = calculateHealthScore(deadAbandonedRepo, FIXED_NOW);
assert(deadScore < 15, `Abandoned repo score should be < 15, got: ${deadScore}`);

console.log("-> PASS: Health score stability and bounds verified!");

// [TEST 4] Collection Audit & Aggregation
console.log("\n[TEST 4] Testing auditRepositories aggregation and filtering...");

const sampleCollection = [
  primeRepo,
  modRepo,
  archivedPopular,
  deadAbandonedRepo,
  {
    name: "copyleft/tool",
    days_since_push: 40,
    stars: 500,
    license: "GPL-3.0",
    summary: "GNU tool with GPL-3.0 license",
    tags: ["linux"],
    archived: false,
  },
  {
    name: "stale/tool",
    days_since_push: 250,
    stars: 30,
    license: "MIT",
    summary: "Stale library",
    tags: ["stale"],
    archived: false,
  },
];

const fullAudit = auditRepositories(sampleCollection, {
  filter: "all",
  referenceDate: FIXED_NOW,
});

assert.strictEqual(fullAudit.total_audited, 6, "Must audit all 6 repos");
assert.strictEqual(fullAudit.filtered_count, 6, "All 6 repos in result");
assert(fullAudit.average_health_score > 0, "Average health must be positive");
assert.strictEqual(fullAudit.health_distribution.archived, 1, "Should have 1 archived repo");
assert.strictEqual(fullAudit.health_distribution.active, 2, "Should have 2 active repos");
assert.strictEqual(fullAudit.health_distribution.stale, 1, "Should have 1 stale repo");
assert.strictEqual(fullAudit.health_distribution.dead_abandoned, 1, "Should have 1 dead repo");
assert.strictEqual(fullAudit.license_breakdown.copyleft, 1, "Should have 1 copyleft repo");
assert.strictEqual(fullAudit.license_breakdown.unlicensed, 1, "Should have 1 unlicensed repo");

// Filter: stale
const staleAudit = auditRepositories(sampleCollection, {
  filter: "stale",
  referenceDate: FIXED_NOW,
});
assert.strictEqual(staleAudit.filtered_count, 2, "Stale filter must return stale + dead (2 repos)");

// Filter: archived
const archAudit = auditRepositories(sampleCollection, {
  filter: "archived",
  referenceDate: FIXED_NOW,
});
assert.strictEqual(archAudit.filtered_count, 1, "Archived filter must return 1 repo");
assert.strictEqual(archAudit.repositories[0].name, "legend/old-framework");

// Filter: unlicensed
const unlicAudit = auditRepositories(sampleCollection, {
  filter: "unlicensed",
  referenceDate: FIXED_NOW,
});
assert.strictEqual(unlicAudit.filtered_count, 1, "Unlicensed filter must return 1 repo");
assert.strictEqual(unlicAudit.repositories[0].name, "ghost/forgotten");

// Filter: min_health_score
const minHealthAudit = auditRepositories(sampleCollection, {
  filter: "all",
  min_health_score: 50,
  referenceDate: FIXED_NOW,
});
for (const r of minHealthAudit.repositories) {
  assert(r.health_score >= 50, "Every repo must satisfy min_health_score >= 50");
}

// Edge Cases: Empty array, null options
const emptyAudit = auditRepositories([]);
assert.strictEqual(emptyAudit.total_audited, 0);
assert.strictEqual(emptyAudit.filtered_count, 0);
assert.strictEqual(emptyAudit.average_health_score, 0);

console.log("-> PASS: Collection audit aggregation and filtering verified!");
console.log("\n=== All Repository Health Audit Tests PASSED! ===");
