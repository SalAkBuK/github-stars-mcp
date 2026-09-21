import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  tokenize,
  stemWord,
  BM25SearchEngine,
  searchRepositories,
  loadCatalogRepos,
  FIELD_WEIGHTS,
} from "../lib/search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.resolve(__dirname, "..", "GITHUB_STARS.md");

console.log("=== Starting Test Suite: Local Hybrid Concept Search Engine ===");

// [TEST 1] Tokenizer and Stemmer
console.log("\n[TEST 1] Testing tokenizer and stemming logic...");

const tokens1 = tokenize("Fast decision-engine and screen_time tracker");
assert(tokens1.includes("fast"), "Must include 'fast'");
assert(tokens1.includes("decision-engine"), "Must include compound 'decision-engine'");
assert(tokens1.includes("decision"), "Must include 'decision'");
assert(tokens1.includes("engine"), "Must include 'engine'");
assert(tokens1.includes("screen"), "Must include 'screen'");
assert(tokens1.includes("time"), "Must include 'time'");
assert(tokens1.includes("track"), "Must include stemmed 'track'");

assert.strictEqual(stemWord("tracking"), "track");
assert.strictEqual(stemWord("tracker"), "track");
assert.strictEqual(stemWord("engines"), "engin");
assert.strictEqual(stemWord("decisions"), "decision");
assert.strictEqual(stemWord("simulations"), "simulat");

const unicodeTokens = tokenize("C++ and C# developer in café using 智能决策");
assert(unicodeTokens.includes("c++"), "Must include tech token 'c++'");
assert(unicodeTokens.includes("c#"), "Must include tech token 'c#'");
assert(unicodeTokens.includes("café"), "Must include accented 'café'");
assert(unicodeTokens.includes("cafe"), "Must include accent-normalized 'cafe'");
assert(unicodeTokens.includes("智能决策"), "Must include CJK token '智能决策'");

// Edge cases for tokenizer
assert.deepStrictEqual(tokenize(""), []);
assert.deepStrictEqual(tokenize(null), []);
assert.deepStrictEqual(tokenize(undefined), []);
assert.deepStrictEqual(tokenize("   "), []);
assert.deepStrictEqual(tokenize("!!! ???"), []);

console.log("-> PASS: Tokenizer, Unicode, tech tokens, and stemming verified!");

// [TEST 2] Field Weights
console.log("\n[TEST 2] Verifying multi-field weights configuration...");
assert.strictEqual(FIELD_WEIGHTS.name, 1.5, "name weight must be 1.5x");
assert.strictEqual(FIELD_WEIGHTS.tags, 2.0, "tags weight must be 2.0x");
assert.strictEqual(FIELD_WEIGHTS.category, 1.2, "category weight must be 1.2x");
assert.strictEqual(FIELD_WEIGHTS.elevator_pitch, 1.8, "elevator_pitch weight must be 1.8x");
assert.strictEqual(FIELD_WEIGHTS.distilled_readme, 1.0, "distilled_readme weight must be 1.0x");
console.log("-> PASS: Field weights configuration verified!");

// [TEST 3] Concept & Problem-to-Solution Matching over Real Catalog
console.log("\n[TEST 3] Testing concept and problem-to-solution discovery on GITHUB_STARS.md...");

const repos = await loadCatalogRepos(CATALOG_PATH);
assert(repos.length >= 70, `Catalog should have >= 70 repos, found ${repos.length}`);

// Benchmark 1: "fast decision engine" -> NandhaKishorM/laya
const res1 = await searchRepositories("fast decision engine", { repos });
assert(res1.length > 0, "Must return results for 'fast decision engine'");
assert.strictEqual(
  res1[0].name,
  "NandhaKishorM/laya",
  `Top match for 'fast decision engine' must be NandhaKishorM/laya, got: ${res1[0]?.name}`
);
assert(res1[0].score >= 20, `Score should be >= 20, got: ${res1[0]?.score}`);

// Benchmark 2: "screen tracker" -> codetesla51/screentime
const res2 = await searchRepositories("screen tracker", { repos });
assert(res2.length > 0, "Must return results for 'screen tracker'");
assert.strictEqual(
  res2[0].name,
  "codetesla51/screentime",
  `Top match for 'screen tracker' must be codetesla51/screentime, got: ${res2[0]?.name}`
);

// Benchmark 3: "systems design simulation" -> codetesla51/nine-fives
const res3 = await searchRepositories("systems design simulation", { repos });
assert(res3.length > 0, "Must return results for 'systems design simulation'");
assert.strictEqual(
  res3[0].name,
  "codetesla51/nine-fives",
  `Top match for 'systems design simulation' must be codetesla51/nine-fives, got: ${res3[0]?.name}`
);

console.log("-> PASS: Benchmark concept queries ranked at #1 precision!");

// [TEST 4] Category Filtering and Score Threshold
console.log("\n[TEST 4] Testing category filtering and min_score threshold...");

// Search within "Developer Tools & CLI"
const catResults = await searchRepositories("screen", {
  repos,
  category: "Developer Tools & CLI",
});
assert(catResults.length > 0, "Must return results within category");
for (const r of catResults) {
  assert(
    r.category.toLowerCase().includes("developer tools"),
    `Category must match 'Developer Tools', got: ${r.category}`
  );
}

// Search with high min_score threshold
const highMinScore = await searchRepositories("fast decision engine", {
  repos,
  min_score: 30,
});
for (const r of highMinScore) {
  assert(r.score >= 30, `Score must be >= 30, got: ${r.score}`);
}

console.log("-> PASS: Category and score threshold filtering verified!");

// [TEST 5] Sub-5ms Latency Verification
console.log("\n[TEST 5] Verifying sub-5ms search execution time...");

const engine = new BM25SearchEngine(repos);
const iterations = 50;
const t0 = performance.now();
for (let i = 0; i < iterations; i++) {
  engine.search("fast decision engine", { limit: 10 });
}
const elapsed = performance.now() - t0;
const avgMs = elapsed / iterations;

console.log(`-> Benchmark: 50 searches in ${elapsed.toFixed(2)}ms (Average: ${avgMs.toFixed(3)}ms/query)`);
assert(avgMs < 5.0, `Average search latency must be < 5ms, got: ${avgMs.toFixed(3)}ms`);
console.log("-> PASS: Sub-5ms search speed verified!");

// [TEST 6] Edge cases: empty/garbage queries and malformed repos
console.log("\n[TEST 6] Testing edge cases (empty inputs, unknown terms, malformed docs)...");

assert.deepStrictEqual(await searchRepositories("", { repos }), []);
assert.deepStrictEqual(await searchRepositories("   ", { repos }), []);
assert.deepStrictEqual(await searchRepositories("xyznonexistentterm987654321", { repos }), []);

const malformedDocEngine = new BM25SearchEngine([
  null,
  undefined,
  {},
  { name: null, tags: null, summary: null },
  { name: "valid/repo", tags: ["valid"], summary: "A fully valid repo" },
]);

const edgeRes = malformedDocEngine.search("valid");
assert.strictEqual(edgeRes.length, 1);
assert.strictEqual(edgeRes[0].name, "valid/repo");

// Test min_score: 0 does not return completely unmatched documents
const zeroMatchRes = malformedDocEngine.search("unmatchedterm", { min_score: 0 });
assert.strictEqual(zeroMatchRes.length, 0, "min_score: 0 must not return docs with 0 matching terms");

// Test numeric string limit & min_score
const strOptionRes = malformedDocEngine.search("valid", { limit: "1", min_score: "0.05" });
assert.strictEqual(strOptionRes.length, 1);

console.log("-> PASS: Edge cases and malformed input handling verified!");
console.log("\n=== All Concept Search Tests PASSED! ===");
