import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inferRepoLanguage,
  inferInstallCommand,
  recommendStack,
} from "../lib/recommender.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.resolve(__dirname, "..", "GITHUB_STARS.md");

console.log("=== Starting Test Suite: AI Agent Tech-Stack Recommender ===");

// [TEST 1] inferRepoLanguage - Resolution, Aliases, and Word Boundaries
console.log("\n[TEST 1] Testing inferRepoLanguage...");

// 1a. Explicit language field
assert.strictEqual(
  inferRepoLanguage({ language: "Rust" }),
  "Rust",
  "Explicit language field must take precedence"
);

// 1b. Aliases with requestedLang
assert.strictEqual(
  inferRepoLanguage({ tags: ["rs", "cli"] }, "rust"),
  "Rust",
  "Requested alias 'rust' with tag 'rs' must infer 'Rust'"
);
assert.strictEqual(
  inferRepoLanguage({ tags: ["golang"] }, "go"),
  "Go",
  "Requested alias 'go' with tag 'golang' must infer 'Go'"
);
assert.strictEqual(
  inferRepoLanguage({ tags: ["py"] }, "python"),
  "Python",
  "Requested alias 'python' with tag 'py' must infer 'Python'"
);

// 1c. Boundary-safe keyword extraction from pitch/summary
const repoAtStart = { summary: "Python client library for MCP protocol." };
assert.strictEqual(
  inferRepoLanguage(repoAtStart, "python"),
  "Python",
  "Keyword at the very start of pitch must be recognized"
);

const repoAtEnd = { summary: "Modern high-speed terminal interface built in Rust." };
assert.strictEqual(
  inferRepoLanguage(repoAtEnd, "rust"),
  "Rust",
  "Keyword at the end followed by punctuation must be recognized"
);

const repoWithPunctuation = { summary: "Fast backend server (Go), designed for microservices." };
assert.strictEqual(
  inferRepoLanguage(repoWithPunctuation, "go"),
  "Go",
  "Keyword in parentheses must be recognized"
);

// 1d. Negative false-positive guards
const repoFalseGo = { summary: "Advanced algorithm for pathfinding with cargo containers." };
assert.strictEqual(
  inferRepoLanguage(repoFalseGo, "go"),
  null,
  "'algorithm' or 'cargo' must not falsely match language 'go'"
);

const repoFalseC = { summary: "Clean code architecture and cloud computing." };
assert.strictEqual(
  inferRepoLanguage(repoFalseC, "c"),
  null,
  "'clean' or 'cloud' must not falsely match single-letter language 'c'"
);

console.log("-> PASS: inferRepoLanguage aliases and boundary safety verified!");

// [TEST 2] inferInstallCommand - Package Managers and Namespace Preservation
console.log("\n[TEST 2] Testing inferInstallCommand...");

// 2a. Go: Must preserve owner namespace for go install
const goRepoFull = {
  name: "screentime",
  full_name: "codetesla51/screentime",
  language: "Go",
};
assert.strictEqual(
  inferInstallCommand(goRepoFull),
  "go install github.com/codetesla51/screentime@latest",
  "Go install command must include owner/repo namespace"
);

const goRepoUrlOnly = {
  name: "screentime",
  url: "https://github.com/codetesla51/screentime",
  language: "Go",
};
assert.strictEqual(
  inferInstallCommand(goRepoUrlOnly),
  "go install github.com/codetesla51/screentime@latest",
  "Go install command must extract owner from url when full_name is omitted"
);

// 2b. Python: pip install
const pyRepo = {
  name: "laya-mlx",
  full_name: "mizorewww/laya-mlx",
  language: "Python",
};
assert.strictEqual(
  inferInstallCommand(pyRepo),
  "pip install laya-mlx",
  "Python install command must be pip install <name>"
);

// 2c. Rust: cargo add
const rustRepo = {
  name: "obscura",
  full_name: "h4ckf0r0day/obscura",
  language: "Rust",
};
assert.strictEqual(
  inferInstallCommand(rustRepo),
  "cargo add obscura",
  "Rust install command must be cargo add <name>"
);

// 2d. TypeScript / MCP Server: npx -y vs npm install
const mcpRepo = {
  name: "github-mcp-server",
  full_name: "github/github-mcp-server",
  language: "TypeScript",
  tags: ["mcp", "agent"],
  summary: "Official GitHub MCP server for agents",
};
assert.strictEqual(
  inferInstallCommand(mcpRepo),
  "npx -y github-mcp-server",
  "MCP server must use npx -y command"
);

const tsLibrary = {
  name: "pdfcn",
  full_name: "shadcn-labs/pdfcn",
  language: "TypeScript",
  tags: ["pdf", "components"],
};
assert.strictEqual(
  inferInstallCommand(tsLibrary),
  "npm install pdfcn",
  "Standard TS library must use npm install"
);

// 2e. Git clone fallback: no duplicate .git
const fallbackRepo = {
  name: "awesome-list",
  url: "https://github.com/user/awesome-list.git",
  language: null,
};
assert.strictEqual(
  inferInstallCommand(fallbackRepo),
  "git clone https://github.com/user/awesome-list.git",
  "Fallback git clone must not append duplicate .git"
);

console.log("-> PASS: inferInstallCommand package managers and namespacing verified!");

// [TEST 3] recommendStack - End-to-End Recommendations
console.log("\n[TEST 3] Testing recommendStack execution and filtering...");

// 3a. Parameter validation
await assert.rejects(
  async () => recommendStack({ task_description: "" }),
  /task_description is required/,
  "Must throw error on empty task_description"
);

// 3b. Real Catalog Recommendation
const recResult = await recommendStack({
  task_description: "screen time tracking daemon in background",
  language: "Go",
  catalogPath: CATALOG_PATH,
});

assert.strictEqual(recResult.language, "Go");
assert(recResult.recommendations.length > 0, "Must return at least 1 recommendation");
assert.strictEqual(
  recResult.recommendations[0].name,
  "codetesla51/screentime",
  `Top recommendation must be codetesla51/screentime, got: ${recResult.recommendations[0]?.name}`
);
assert.strictEqual(recResult.recommendations[0].language, "Go");
assert(
  recResult.recommendations[0].install_command.includes("go install github.com/codetesla51/screentime"),
  "Must generate valid go install command"
);
assert(recResult.total_evaluated > 0, "total_evaluated must be positive");
assert.strictEqual(recResult.total_evaluated, recResult.total_considered);

// 3c. Filter out archived / dead projects
const mockArchived = {
  name: "old/abandoned-tool",
  summary: "abandoned daemon for screen time tracking",
  tags: ["screentime", "daemon"],
  archived: true,
};
const mockActive = {
  name: "fresh/active-tool",
  summary: "active daemon for screen time tracking",
  tags: ["screentime", "daemon"],
  days_since_push: 5,
  archived: false,
};

const filterRes = await recommendStack({
  task_description: "screen time tracking daemon",
  repos: [mockArchived, mockActive],
});
assert.strictEqual(filterRes.recommendations.length, 1);
assert.strictEqual(filterRes.recommendations[0].name, "fresh/active-tool");

console.log("-> PASS: recommendStack execution, filtering, and contract verified!");
console.log("\n=== All Tech-Stack Recommender Tests PASSED! ===");
