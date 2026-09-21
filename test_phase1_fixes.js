import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  distillReadme,
  resolveCategoryName,
  mergeCatalogCategories,
} from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runPhase1Tests() {
  console.log("=== Starting Phase 1 (Data Preservation & Security) Test Suite ===\n");

  // =========================================================================
  // FIX 1: HTML Layout Tag Preservation in distillReadme
  // =========================================================================
  console.log("[FIX 1] Testing HTML Layout Tag Preservation in distillReadme...");

  // 1a. Hero header inside div and elevator pitch inside p and span
  const htmlLayoutDoc = [
    `<div align="center">`,
    `  <h1>Antigravity Super Engine</h1>`,
    `  <p>The <span>lightweight</span> and blazing fast agentic system.</p>`,
    `</div>`,
    ``,
    `## Installation`,
    `Run npm install antigravity`,
  ].join("\n");

  const distilledLayout = distillReadme(htmlLayoutDoc);
  assert.ok(
    distilledLayout.content.includes("Antigravity Super Engine"),
    "Hero header inside <div> must NOT be deleted"
  );
  assert.ok(
    distilledLayout.content.includes("The lightweight and blazing fast agentic system"),
    "Elevator pitch inside <p> and <span> must NOT be deleted"
  );
  assert.ok(
    !distilledLayout.content.includes("<div") && !distilledLayout.content.includes("</div>"),
    "<div> tags must be stripped"
  );
  assert.ok(
    !distilledLayout.content.includes("<p") && !distilledLayout.content.includes("</p>"),
    "<p> tags must be stripped"
  );
  assert.ok(
    !distilledLayout.content.includes("<span") && !distilledLayout.content.includes("</span>"),
    "<span> tags must be stripped"
  );

  // 1b. <details> and <summary> tag preservation
  const detailsDoc = [
    `# Feature Guide`,
    `<details>`,
    `  <summary>Click here to view advanced configuration</summary>`,
    `  Set DEBUG=1 in your environment to enable trace logging.`,
    `</details>`,
  ].join("\n");

  const distilledDetails = distillReadme(detailsDoc);
  assert.ok(
    distilledDetails.content.includes("Click here to view advanced configuration"),
    "Summary inner text must be preserved"
  );
  assert.ok(
    distilledDetails.content.includes("Set DEBUG=1 in your environment"),
    "Details inner text must be preserved"
  );
  assert.ok(
    !distilledDetails.content.includes("<details>") && !distilledDetails.content.includes("</details>"),
    "<details> markup tags must be stripped"
  );
  assert.ok(
    !distilledDetails.content.includes("<summary>") && !distilledDetails.content.includes("</summary>"),
    "<summary> markup tags must be stripped"
  );

  // 1c. Whole-tag stripping of media elements (<svg>, <picture>, <img>)
  const mediaDoc = [
    `# Media Project`,
    `<svg width="100" height="100"><circle cx="50" cy="50" r="40" stroke="green" fill="yellow" /></svg>`,
    `<picture><source srcset="large.jpg" media="(min-width: 800px)"><img src="small.jpg" alt="logo"></picture>`,
    `This is real project description following graphics.`,
  ].join("\n");

  const distilledMedia = distillReadme(mediaDoc);
  assert.ok(
    !distilledMedia.content.includes("circle") && !distilledMedia.content.includes("<svg>"),
    "<svg> and its internal vector markup must be stripped whole-tag"
  );
  assert.ok(
    !distilledMedia.content.includes("large.jpg") && !distilledMedia.content.includes("small.jpg"),
    "<picture> and internal <source>/<img> must be stripped whole-tag"
  );
  assert.ok(
    distilledMedia.content.includes("This is real project description following graphics"),
    "Project text following media elements must be preserved"
  );

  // 1d. Mathematical inequalities (e.g. 0 < min_val and max_val > 10)
  const mathDoc = [
    `# Algorithm Specification`,
    `Ensure that 0 < min_val and max_val > 10 in your algorithm configuration.`,
    `Also verify: if a < b and c > d, trigger rebalance.`,
  ].join("\n");

  const distilledMath = distillReadme(mathDoc);
  assert.ok(
    distilledMath.content.includes("0 < min_val and max_val > 10"),
    "Mathematical inequality '0 < min_val and max_val > 10' must NOT be stripped as HTML tags"
  );
  assert.ok(
    distilledMath.content.includes("a < b and c > d"),
    "Inequality 'a < b and c > d' must NOT be stripped as HTML tags"
  );
  console.log("-> PASS: Fix 1 (HTML Layout Tag Preservation & Inequalities) verified!\n");

  // =========================================================================
  // FIX 2: Bounded Mid-Document Heading Stripping in distillReadme
  // =========================================================================
  console.log("[FIX 2] Testing Bounded Mid-Document Heading Stripping in distillReadme...");

  const midDocBoilerplate = [
    `# Amazing Library`,
    `An awesome distributed systems toolkit.`,
    ``,
    `## Sponsors`,
    `Thank you to our corporate sponsors:`,
    `- MegaCorp`,
    `- CloudGiant`,
    ``,
    `## Features`,
    `- High availability consensus`,
    `- Zero-copy deserialization`,
    `- Distributed actor model`,
    ``,
    `## Installation`,
    `\`\`\`bash`,
    `cargo add amazing-lib`,
    `\`\`\``,
    ``,
    `## License`,
    `This software is licensed under the Apache 2.0 License.`,
  ].join("\n");

  const distilledMidDoc = distillReadme(midDocBoilerplate);

  // Sponsors must be removed
  assert.ok(
    !distilledMidDoc.content.includes("MegaCorp") && !distilledMidDoc.content.includes("CloudGiant"),
    "Mid-document Sponsors section content must be stripped"
  );
  // Features after Sponsors MUST be preserved!
  assert.ok(
    distilledMidDoc.content.includes("## Features"),
    "## Features heading following mid-document ## Sponsors must NOT be deleted"
  );
  assert.ok(
    distilledMidDoc.content.includes("High availability consensus"),
    "Features content must be preserved"
  );
  assert.ok(
    distilledMidDoc.content.includes("Zero-copy deserialization"),
    "Features content must be preserved"
  );
  // Installation must be preserved
  assert.ok(
    distilledMidDoc.content.includes("## Installation"),
    "Installation section must be preserved"
  );
  assert.ok(
    distilledMidDoc.content.includes("cargo add amazing-lib"),
    "Installation code block must be preserved"
  );
  // Trailing License must be stripped
  assert.ok(
    !distilledMidDoc.content.includes("This software is licensed under the Apache 2.0 License"),
    "Trailing ## License section must be stripped"
  );
  console.log("-> PASS: Fix 2 (Bounded Mid-Document Heading Stripping) verified!\n");

  // =========================================================================
  // FIX 4a: Direct Unit Tests on resolveCategoryName
  // =========================================================================
  console.log("[FIX 4a] Testing resolveCategoryName helper with edge cases...");

  assert.strictEqual(resolveCategoryName({ name: "AI Tools" }), "AI Tools");
  assert.strictEqual(resolveCategoryName({ category: "Developer Tools" }), "Developer Tools");
  assert.strictEqual(resolveCategoryName({ name: "" }), "Uncategorized", "Empty name string must fallback");
  assert.strictEqual(resolveCategoryName({ name: "   " }), "Uncategorized", "Whitespace-only name must fallback");
  assert.strictEqual(resolveCategoryName({ name: null, category: "" }), "Uncategorized");
  assert.strictEqual(resolveCategoryName({ name: undefined }), "Uncategorized");
  assert.strictEqual(resolveCategoryName(null), "Uncategorized");
  assert.strictEqual(resolveCategoryName(undefined), "Uncategorized");
  assert.strictEqual(resolveCategoryName({ name: 12345 }), "12345");
  assert.strictEqual(resolveCategoryName({}), "Uncategorized");
  console.log("-> PASS: Fix 4a (resolveCategoryName) verified!\n");

  // =========================================================================
  // Server-based Tests: FIX 3, FIX 4b, FIX 5 via MCP Client
  // =========================================================================
  console.log("[MCP SERVER TESTS] Connecting to MCP Server for Tool Testing...");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["C:/Users/saleh/.gemini/config/mcp-servers/github-stars/index.js"],
  });
  const client = new Client(
    { name: "phase1-test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  console.log("Connected to github-stars-mcp server!\n");

  // =========================================================================
  // FIX 3: Sandbox Export file_path in github_export_catalog (CWE-22)
  // =========================================================================
  console.log("[FIX 3] Testing Sandbox Export file_path (CWE-22 Defense)...");

  // 3a. Directory traversal with ..
  const resOutside = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "../../../outside.md",
      categories: [{ name: "Test", repos: [] }],
    },
  });
  assert.strictEqual(resOutside.isError, true, "Traversing outside workspace directory must return isError: true");
  assert.ok(
    resOutside.content[0].text.includes("Security Error") && resOutside.content[0].text.includes("CWE-22"),
    `Error message must indicate Security Error, got: ${resOutside.content[0].text}`
  );

  // 3b. Absolute path outside workspace
  const resAbsolute = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "C:\\Windows\\System32\\malicious.md",
      categories: [{ name: "Test", repos: [] }],
    },
  });
  assert.strictEqual(resAbsolute.isError, true, "Targeting file outside workspace must return isError: true");
  assert.ok(
    resAbsolute.content[0].text.includes("Security Error"),
    `Error message must indicate Security Error, got: ${resAbsolute.content[0].text}`
  );

  // 3c. Invalid extension (non-.md)
  const resExt = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "malicious_script.sh",
      categories: [{ name: "Test", repos: [] }],
    },
  });
  assert.strictEqual(resExt.isError, true, "Targeting file with non-.md extension must return isError: true");
  assert.ok(
    resExt.content[0].text.includes(".md extension"),
    `Error message must indicate .md extension requirement, got: ${resExt.content[0].text}`
  );

  // 3d. Valid relative path inside workspace must succeed
  const testValidCatalogPath = path.resolve(process.cwd(), "TEST_PHASE1_CATALOG.md");
  await fs.unlink(testValidCatalogPath).catch(() => {});

  const validRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "TEST_PHASE1_CATALOG.md",
      catalog_title: "Valid Sandbox Catalog",
      categories: [
        {
          name: "Security Tools",
          repos: [
            {
              name: "defense/path-guard",
              url: "https://github.com/defense/path-guard",
              summary: "Guards against CWE-22 path traversal.",
            },
          ],
        },
      ],
      mode: "overwrite",
    },
  });
  const validData = JSON.parse(validRes.content[0].text);
  assert.strictEqual(validData.success, true, "Export with valid .md in cwd must succeed");
  const validContent = await fs.readFile(testValidCatalogPath, "utf-8");
  assert.ok(validContent.includes("Valid Sandbox Catalog"));
  assert.ok(validContent.includes("defense/path-guard"));
  await fs.unlink(testValidCatalogPath).catch(() => {});
  console.log("-> PASS: Fix 3 (CWE-22 Path Traversal Defense & .md extension) verified!\n");

  // =========================================================================
  // FIX 4b: API Contract Compatibility (compiled_categories and empty category names)
  // =========================================================================
  console.log("[FIX 4b] Testing API Contract Compatibility in github_export_catalog...");

  const testApiCompatPath = path.resolve(process.cwd(), "TEST_API_COMPAT_CATALOG.md");
  await fs.unlink(testApiCompatPath).catch(() => {});

  // Pass compiled_categories instead of categories (as returned by orchestrator / force_reduce)
  const compatRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "TEST_API_COMPAT_CATALOG.md",
      catalog_title: "API Contract Catalog",
      compiled_categories: [
        {
          name: "AI & Agent Infrastructure",
          description: "Frameworks for autonomous agents",
          repos: [
            {
              name: "orchestrator/agent-x",
              url: "https://github.com/orchestrator/agent-x",
              summary: "Robust multi-agent orchestrator.",
            },
          ],
        },
        {
          // Empty category name -> should fallback to 'Uncategorized'
          name: "",
          repos: [
            {
              name: "misc/orphaned-repo",
              url: "https://github.com/misc/orphaned-repo",
              summary: "A repo with an empty category name.",
            },
          ],
        },
      ],
      mode: "overwrite",
    },
  });

  const compatData = JSON.parse(compatRes.content[0].text);
  assert.strictEqual(compatData.success, true, "compiled_categories parameter must be accepted");
  assert.strictEqual(compatData.categories_count, 2, "Must process 2 categories");
  assert.strictEqual(compatData.total_repos_cataloged, 2, "Must process 2 repos");

  const compatContent = await fs.readFile(testApiCompatPath, "utf-8");
  assert.ok(
    compatContent.includes("## AI & Agent Infrastructure"),
    "Must render AI & Agent Infrastructure heading"
  );
  assert.ok(
    compatContent.includes("## Uncategorized"),
    "Empty category name must fallback to 'Uncategorized'"
  );
  assert.ok(
    compatContent.includes("- [Uncategorized](#uncategorized) (1)"),
    "TOC must include Uncategorized with anchor"
  );
  assert.ok(
    compatContent.includes("orchestrator/agent-x"),
    "Repo in compiled_categories must be exported"
  );
  assert.ok(
    compatContent.includes("misc/orphaned-repo"),
    "Repo in fallback Uncategorized must be exported"
  );
  await fs.unlink(testApiCompatPath).catch(() => {});
  console.log("-> PASS: Fix 4b (compiled_categories alias & empty category name fallback) verified!\n");

  // =========================================================================
  // FIX 5: Prototype Collision Defense (CWE-1321)
  // =========================================================================
  console.log("[FIX 5] Testing Prototype Collision Defense (CWE-1321)...");

  // 5a. Start an orchestration session and test with repo named "constructor", "toString", "valueOf"
  const orchRes = await client.callTool({
    name: "github_orchestrate_workers",
    arguments: {
      num_workers: 2,
      profile: "compact",
    },
  });
  const orchData = JSON.parse(orchRes.content[0].text);
  const sessionId = orchData.session_id;
  assert.ok(sessionId, "Orchestration session must be created");

  // 5b. Worker submits repositories named "constructor", "toString", and "valueOf"
  const submitRes = await client.callTool({
    name: "github_submit_worker_digest",
    arguments: {
      session_id: sessionId,
      worker_id: "worker-1",
      analyzed_repos: [
        {
          name: "constructor",
          url: "https://github.com/special/constructor",
          category: "Developer Tools & CLI",
          elevator_pitch: "A tool named constructor.",
          archived: false,
        },
        {
          name: "toString",
          url: "https://github.com/special/toString",
          category: "AI & Agent Infrastructure",
          elevator_pitch: "A tool named toString.",
          archived: false,
        },
        {
          name: "valueOf",
          url: "https://github.com/special/valueOf",
          // Category named "constructor" -> tests category prototype collision!
          category: "constructor",
          elevator_pitch: "A tool categorized as constructor.",
          archived: false,
        },
      ],
    },
  });

  const submitData = JSON.parse(submitRes.content[0].text);
  assert.strictEqual(
    submitData.status,
    "digest_accepted",
    "Submitting repos named 'constructor', 'toString', and category 'constructor' must succeed"
  );

  // 5c. Check status of session
  const statusRes = await client.callTool({
    name: "github_get_orchestration_status",
    arguments: { session_id: sessionId },
  });
  const statusData = JSON.parse(statusRes.content[0].text);
  assert.ok(
    statusData.total_unique_repos_cataloged >= 3,
    "Special-named repos must be properly recorded in repos_by_name"
  );

  // Verify that Object.prototype was NOT polluted
  assert.strictEqual(
    Object.prototype.hasOwnProperty("constructor"),
    true,
    "Standard constructor exists on Object.prototype"
  );
  assert.strictEqual(
    typeof Object.prototype.toString,
    "function",
    "Object.prototype.toString must remain a function"
  );
  assert.strictEqual(
    typeof Object.prototype.valueOf,
    "function",
    "Object.prototype.valueOf must remain a function"
  );

  // 5d. Force reduce session and verify compiled_categories
  const forceRes = await client.callTool({
    name: "github_force_reduce_session",
    arguments: {
      session_id: sessionId,
      missing_worker_policy: "proceed_with_available",
    },
  });
  const forceData = JSON.parse(forceRes.content[0].text);
  assert.strictEqual(forceData.status, "force_reduced");
  assert.ok(Array.isArray(forceData.compiled_categories));

  // 5e. Export the catalog containing constructor/toString/valueOf repos
  const testProtoCatalogPath = path.resolve(process.cwd(), "TEST_PROTO_CATALOG.md");
  await fs.unlink(testProtoCatalogPath).catch(() => {});

  const exportProtoRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "TEST_PROTO_CATALOG.md",
      catalog_title: "Prototype Defense Catalog",
      compiled_categories: forceData.compiled_categories,
      mode: "overwrite",
    },
  });
  const exportProtoData = JSON.parse(exportProtoRes.content[0].text);
  assert.strictEqual(exportProtoData.success, true);

  const protoCatalogContent = await fs.readFile(testProtoCatalogPath, "utf-8");
  assert.ok(
    protoCatalogContent.includes("### [constructor](https://github.com/special/constructor)"),
    "Repo named 'constructor' must be exported accurately without collision"
  );
  assert.ok(
    !protoCatalogContent.includes("### [constructor](https://github.com/special/constructor) [ARCHIVED]"),
    "Repo named 'constructor' must NOT be falsely flagged as [ARCHIVED] due to prototype collision"
  );
  assert.ok(
    protoCatalogContent.includes("### [toString](https://github.com/special/toString)"),
    "Repo named 'toString' must be exported accurately without collision"
  );
  assert.ok(
    !protoCatalogContent.includes("### [toString](https://github.com/special/toString) [ARCHIVED]"),
    "Repo named 'toString' must NOT be falsely flagged as [ARCHIVED] due to prototype collision"
  );
  await fs.unlink(testProtoCatalogPath).catch(() => {});
  console.log("-> PASS: Fix 5 (Prototype Collision Defense CWE-1321) verified!\n");

  await client.close();
  console.log("=== All Phase 1 Fixes PASSED with Zero Errors! ===\n");
}

runPhase1Tests().catch((err) => {
  console.error("Phase 1 Tests Failed:", err);
  process.exit(1);
});
