import assert from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "cli.js");

console.log("=== Starting Test Suite: Standalone Terminal CLI ===");

// [TEST 1] CLI Help & Version
console.log("\n[TEST 1] Testing 'github-stars --help'...");
const helpRes = await execFileAsync("node", [CLI_PATH, "--help"]);
assert.strictEqual(helpRes.stderr, "", "Help should not output to stderr");
assert(helpRes.stdout.includes("github-stars"), "Help output must include 'github-stars'");
assert(helpRes.stdout.includes("search"), "Help must list 'search' command");
assert(helpRes.stdout.includes("audit"), "Help must list 'audit' command");
assert(helpRes.stdout.includes("recommend"), "Help must list 'recommend' command");
console.log("-> PASS: CLI help manual verified!");

// [TEST 2] CLI Search (Formatted Terminal Output)
console.log("\n[TEST 2] Testing 'github-stars search' with formatted output...");
const searchRes = await execFileAsync("node", [
  CLI_PATH,
  "search",
  "fast decision engine",
]);
assert(searchRes.stdout.includes("NandhaKishorM/laya"), "Output must contain NandhaKishorM/laya");
assert(searchRes.stdout.includes("Score:"), "Output must include score badge");
assert(searchRes.stdout.includes("Category:"), "Output must include category");
console.log("-> PASS: Terminal formatted search verified!");

// [TEST 3] CLI Search (JSON Output)
console.log("\n[TEST 3] Testing 'github-stars search --json'...");
const searchJsonRes = await execFileAsync("node", [
  CLI_PATH,
  "search",
  "screen tracker",
  "--json",
]);
const searchJson = JSON.parse(searchJsonRes.stdout);
assert.strictEqual(searchJson.query, "screen tracker");
assert(Array.isArray(searchJson.results));
assert(searchJson.results.length > 0);
assert.strictEqual(searchJson.results[0].name, "codetesla51/screentime");
console.log("-> PASS: CLI JSON search output verified!");

// [TEST 4] CLI Audit
console.log("\n[TEST 4] Testing 'github-stars audit'...");
const auditRes = await execFileAsync("node", [CLI_PATH, "audit"]);
assert(auditRes.stdout.includes("Total Audited:"), "Audit output must include Total Audited");
assert(auditRes.stdout.includes("Average Health:"), "Audit output must include Average Health");
assert(auditRes.stdout.includes("Freshness Distribution:"), "Must include Freshness Distribution");
assert(auditRes.stdout.includes("Licensing Breakdown:"), "Must include Licensing Breakdown");
console.log("-> PASS: Terminal formatted audit dashboard verified!");

// [TEST 5] CLI Audit (JSON Output with Filter)
console.log("\n[TEST 5] Testing 'github-stars audit --filter unlicensed --json'...");
const auditJsonRes = await execFileAsync("node", [
  CLI_PATH,
  "audit",
  "--filter",
  "unlicensed",
  "--json",
]);
const auditJson = JSON.parse(auditJsonRes.stdout);
assert.strictEqual(auditJson.filter_applied, "unlicensed");
assert(Array.isArray(auditJson.repositories));
console.log("-> PASS: Audit JSON output with filtering verified!");

// [TEST 6] CLI Recommend (Stack Recommendation)
console.log("\n[TEST 6] Testing 'github-stars recommend --language Go --json'...");
const recRes = await execFileAsync("node", [
  CLI_PATH,
  "recommend",
  "screen time tracker",
  "--language",
  "Go",
  "--json",
]);
const recJson = JSON.parse(recRes.stdout);
assert.strictEqual(recJson.language, "Go");
assert(Array.isArray(recJson.recommendations));
assert(recJson.recommendations.length > 0);
assert.strictEqual(recJson.recommendations[0].name, "codetesla51/screentime");
assert(recJson.recommendations[0].install_command.includes("go install"));

// Test formatted output count does not display 'undefined'
const recFmtRes = await execFileAsync("node", [
  CLI_PATH,
  "recommend",
  "screen tracker",
]);
assert(!recFmtRes.stdout.includes("undefined"), "Formatted output must not display 'undefined'");
assert(/Evaluated \d+ starred repos/.test(recFmtRes.stdout), "Must display numeric evaluated count");

// Test language inference for Rust
const recRustRes = await execFileAsync("node", [
  CLI_PATH,
  "recommend",
  "headless browser",
  "--language",
  "rust",
  "--json",
]);
const recRustJson = JSON.parse(recRustRes.stdout);
assert.strictEqual(recRustJson.recommendations[0]?.language, "Rust", "Inferred language for Rust repo must be 'Rust'");
assert(recRustJson.recommendations[0]?.install_command.includes("cargo add"), "Must generate cargo add install command");

console.log("-> PASS: CLI stack recommendation verified!");

// [TEST 7] CLI Catalog Command (Generation & Merge)
console.log("\n[TEST 7] Testing 'github-stars catalog'...");
const catRes = await execFileAsync("node", [CLI_PATH, "catalog"]);
assert(catRes.stdout.includes("Catalog Management"), "Catalog command must output management header");
assert(catRes.stdout.includes("Catalog file verified"), "Catalog file must be verified");

// Test real export to custom file
const tempCatalogPath = path.resolve(__dirname, "temp_catalog_test.md");
try {
  const catExportRes = await execFileAsync("node", [
    CLI_PATH,
    "catalog",
    "--file",
    tempCatalogPath,
    "--mode",
    "overwrite",
  ]);
  assert(catExportRes.stdout.includes("Categories:"), "Must log categories count");
  const tempContent = await fs.readFile(tempCatalogPath, "utf-8");
  assert(tempContent.includes("# Curated GitHub Starred Repositories"), "Exported catalog must include title");
  assert(tempContent.includes("## Table of Contents"), "Exported catalog must include TOC");
  assert(tempContent.includes("### ["), "Exported catalog must include repository entries");

  // Test merge mode
  const catMergeRes = await execFileAsync("node", [
    CLI_PATH,
    "catalog",
    "--file",
    tempCatalogPath,
    "--mode",
    "merge",
  ]);
  assert(catMergeRes.stdout.includes("Merged"), "Merge mode must report merged status");
} finally {
  await fs.unlink(tempCatalogPath).catch(() => {});
}
console.log("-> PASS: Catalog command generation and merge verified!");

// [TEST 8] Unknown Command Handling
console.log("\n[TEST 8] Testing error handling on unknown command...");
try {
  await execFileAsync("node", [CLI_PATH, "unknown-command-xyz"]);
  assert.fail("Should have exited with non-zero code");
} catch (err) {
  assert.strictEqual(err.code, 1, "Exit code must be 1 on unknown command");
  assert(err.stderr.includes("Unknown command"), "Stderr must state Unknown command");
}
console.log("-> PASS: Unknown command cleanly handled!");

console.log("\n=== All CLI Tests PASSED! ===");
