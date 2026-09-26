import assert from "node:assert";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_ENTRY } from "./test_server_path.js";
import {
  normalizeCategory,
  distillReadme,
  generateFallbackReadme,
  invalidateCache,
  getGitHubToken,
  clearCachedGitHubToken,
  getCache,
  setCache,
  memoryCache,
  pendingCacheWrites,
  githubRest,
  mergeCatalogCategories,
  resolveCategoryName,
} from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runRegressionTests() {
  console.log("=== Starting Comprehensive Audit Fixes Regression Test Suite ===\n");

  // TEST 1: Keyword Word-Boundary Matching in normalizeCategory
  console.log("[TEST 1] Testing keyword word-boundary matching in normalizeCategory...");
  
  // False positive checks: words containing "ai" as substring must NOT map to AI
  const containersCat = normalizeCategory("Containers & Docker");
  assert.notStrictEqual(containersCat, "AI & Agent Infrastructure", "Containers should not map to AI");

  const emailCat = normalizeCategory("Email Deliverability");
  assert.notStrictEqual(emailCat, "AI & Agent Infrastructure", "Email should not map to AI");

  const railsCat = normalizeCategory("Ruby on Rails");
  assert.notStrictEqual(railsCat, "AI & Agent Infrastructure", "Rails should not map to AI");

  const domainCat = normalizeCategory("Domain Name Management");
  assert.notStrictEqual(domainCat, "AI & Agent Infrastructure", "Domain should not map to AI");

  // Legitimate AI matches
  assert.strictEqual(normalizeCategory("Gen-AI Tooling"), "AI & Agent Infrastructure");
  assert.strictEqual(normalizeCategory("LLM Agents"), "AI & Agent Infrastructure");
  assert.strictEqual(normalizeCategory("Autonomous Agent Framework"), "AI & Agent Infrastructure");
  assert.strictEqual(normalizeCategory("MCP Server Protocol"), "AI & Agent Infrastructure");

  // Other categories
  assert.strictEqual(normalizeCategory("Cloud Storage"), "Databases & Data Engineering");
  assert.strictEqual(normalizeCategory("Developer CLI Tools"), "Developer Tools & CLI");
  assert.strictEqual(normalizeCategory("Frontend UI Components"), "Frontend & UI Libraries");
  assert.strictEqual(normalizeCategory("Security Vulnerability Scanner"), "Security & Reverse Engineering");

  // Edge cases: null / non-string / empty baseline array
  assert.strictEqual(typeof normalizeCategory(null, []), "string", "Empty baseline must return string");
  assert.strictEqual(typeof normalizeCategory("", []), "string", "Empty baseline must return string");
  assert.strictEqual(typeof normalizeCategory(123, []), "string", "Empty baseline must return string");
  assert.ok(normalizeCategory(null, []).length > 0, "Fallback category must not be empty");

  console.log("-> PASS: Word-boundary keyword matching verified without false positives!\n");

  // TEST 2: Void HTML Tag Handling & Code Block License Guard in distillReadme
  console.log("[TEST 2] Testing void HTML tag handling and code block license guard in distillReadme...");
  
  // 2a. Void HTML tags (<img>, <source>) paired with closing tags
  const voidTagDoc = [
    `<img src="https://example.com/banner.png" alt="banner">`,
    `# Real Project Documentation`,
    `This is real essential documentation that must not be deleted.`,
    `<p align="center">Footer</p>`,
  ].join("\n");
  const distilledVoid = distillReadme(voidTagDoc);
  assert.ok(
    distilledVoid.content.includes("Real Project Documentation"),
    "distillReadme must NOT delete documentation between <img> and </p>"
  );
  assert.ok(
    distilledVoid.content.includes("This is real essential documentation"),
    "distillReadme must preserve body text after void tags"
  );

  // 2b. Code block containing '# License'
  const codeBlockDoc = [
    `# Awesome Library`,
    `Here is an example code snippet:`,
    `\`\`\`python`,
    `# License: MIT License header inside code`,
    `import os`,
    `print("hello world")`,
    `\`\`\``,
    `## Crucial Next Steps`,
    `Do not skip this important documentation step.`,
    ``,
    `## License`,
    `This actual project license is Apache 2.0.`,
  ].join("\n");
  const distilledCode = distillReadme(codeBlockDoc);
  assert.ok(
    distilledCode.content.includes("# License: MIT License header inside code"),
    "Code block comments must be preserved"
  );
  assert.ok(
    distilledCode.content.includes("Crucial Next Steps"),
    "Sections after code blocks containing # License must NOT be truncated"
  );
  assert.ok(
    !distilledCode.content.includes("This actual project license is Apache 2.0"),
    "Real trailing ## License section MUST be stripped"
  );

  // 2c. C++ templates, generics, and HTML examples inside code blocks
  const genericsDoc = [
    `# C++ Project`,
    `\`\`\`cpp`,
    `#include <vector>`,
    `std::vector<int> v;`,
    `bool b = (x < 5 && y > 3);`,
    `<div class="code-tag">keep this html in code block</div>`,
    `\`\`\``,
    `Outer text`,
  ].join("\n");
  const distilledGenerics = distillReadme(genericsDoc);
  assert.ok(distilledGenerics.content.includes("<vector>"), "C++ #include <vector> must not be stripped");
  assert.ok(distilledGenerics.content.includes("std::vector<int>"), "Generics std::vector<int> must not be stripped");
  assert.ok(distilledGenerics.content.includes("x < 5 && y > 3"), "Comparison operators in code block must not be stripped");
  assert.ok(distilledGenerics.content.includes('<div class="code-tag">keep this html in code block</div>'), "HTML inside code block must be preserved");

  // 2d. Unclosed code block at EOF containing '# License'
  const unclosedDoc = `# My Lib\n\`\`\`js\n# License: MIT\nconsole.log("hello");`;
  const distilledUnclosed = distillReadme(unclosedDoc);
  assert.ok(distilledUnclosed.content.includes("console.log"), "Unclosed code block content must not be deleted");

  // 2e. 4-backtick code block enclosing 3 backticks with # License
  const quadDoc = [
    `# Quad`,
    `\`\`\`\`markdown`,
    `\`\`\`js`,
    `# License inside inner`,
    `console.log("hello");`,
    `\`\`\``,
    `\`\`\`\``,
    `## Real Section`,
    `Preserve me!`,
  ].join("\n");
  const distilledQuad = distillReadme(quadDoc);
  assert.ok(distilledQuad.content.includes("## Real Section"), "Sections following 4-backtick block must be preserved");
  assert.ok(distilledQuad.content.includes("Preserve me!"), "Body following 4-backtick block must be preserved");

  // 2f. Inline code with HTML/generics
  const inlineDoc = `# Guide\nUse \`<Provider<T>>\` component to wrap \`<App/>\`.\n## License\nMIT`;
  const distilledInline = distillReadme(inlineDoc);
  assert.ok(distilledInline.content.includes("`<Provider<T>>`"), "Inline code generics must be preserved");
  assert.ok(!distilledInline.content.includes("## License"), "Real license must be stripped");

  // 2g. Layout containers: <div>, <p>, <span>, <details>, <summary> preserve inner text
  const layoutDoc = [
    `<div align="center">`,
    `  <h1>Star Distiller</h1>`,
    `  <p>The <span>ultimate</span> repository parser.</p>`,
    `</div>`,
    `<details><summary>Usage Notes</summary>Run node index.js to start</details>`,
  ].join("\n");
  const distilledLayout = distillReadme(layoutDoc);
  assert.ok(distilledLayout.content.includes("Star Distiller"), "Inner text of <div> must be preserved");
  assert.ok(distilledLayout.content.includes("The ultimate repository parser"), "Inner text of <p> and <span> must be preserved");
  assert.ok(distilledLayout.content.includes("Usage Notes"), "Inner text of <summary> must be preserved");
  assert.ok(distilledLayout.content.includes("Run node index.js to start"), "Inner text of <details> must be preserved");
  assert.ok(!distilledLayout.content.includes("<div") && !distilledLayout.content.includes("</div>"), "<div> tags must be stripped");

  // 2h. Whole-tag media stripping (<svg>, <picture>)
  const mediaDoc = `# Project\n<svg><circle cx="5"/></svg>\n<picture><source srcset="a.jpg"><img src="b.jpg"></picture>\nProject body text.`;
  const distilledMedia = distillReadme(mediaDoc);
  assert.ok(!distilledMedia.content.includes("<circle") && !distilledMedia.content.includes("<svg>"), "<svg> must be stripped whole-tag");
  assert.ok(!distilledMedia.content.includes("a.jpg") && !distilledMedia.content.includes("b.jpg"), "<picture> must be stripped whole-tag");
  assert.ok(distilledMedia.content.includes("Project body text"), "Text following media must be preserved");

  // 2i. Mathematical inequalities outside code blocks
  const mathDoc = `# Bounds\nAssert: 0 < min_val and max_val > 10 in all cases. Also x < y and z > w.`;
  const distilledMath = distillReadme(mathDoc);
  assert.ok(distilledMath.content.includes("0 < min_val and max_val > 10"), "Inequalities must not be stripped as HTML tags");
  assert.ok(distilledMath.content.includes("x < y and z > w"), "General inequalities must not be stripped as HTML tags");

  // 2j. Bounded mid-document boilerplate headings
  const boundedDoc = [
    `# Toolkit`,
    `Core toolkit description.`,
    `## Sponsors`,
    `Thanks to sponsor CorpX.`,
    `## Features`,
    `- Fast distillation`,
    `- Reliable caching`,
    `## License`,
    `MIT License`,
  ].join("\n");
  const distilledBounded = distillReadme(boundedDoc);
  assert.ok(!distilledBounded.content.includes("CorpX"), "Mid-document sponsors section must be stripped");
  assert.ok(distilledBounded.content.includes("## Features"), "Features section after sponsors must be preserved");
  assert.ok(distilledBounded.content.includes("Fast distillation"), "Features body must be preserved");
  assert.ok(!distilledBounded.content.includes("MIT License"), "Trailing license must be stripped");

  console.log("-> PASS: Void HTML tags, layout tag preservation, math inequalities, and bounded headings verified!\n");

  // TEST 3: Distilled Fallback Timing & Ordering
  console.log("[TEST 3] Testing synthesized metadata fallback when README distills to empty/short...");
  const dummyRepo = {
    name: "empty-readme-repo",
    full_name: "test-owner/empty-readme-repo",
    description: "A great repository whose README was just badges and SVGs.",
    language: "TypeScript",
    topics: ["testing", "resilience"],
  };
  const fallback = generateFallbackReadme(dummyRepo);
  assert.ok(fallback.includes("test-owner/empty-readme-repo"));
  assert.ok(fallback.includes("A great repository whose README was just badges and SVGs."));
  assert.ok(fallback.includes("TypeScript"));

  // Verify that an image-only / badge-only README distills to < 50 chars and triggers fallback
  const badgeOnlyReadme = `<p align="center"><img src="https://img.shields.io/badge/build-passing-brightgreen.svg" /></p>`;
  const distilledBadgeOnly = distillReadme(badgeOnlyReadme);
  assert.ok(distilledBadgeOnly.content.trim().length < 50, "Badge-only readme must distill to < 50 chars");
  console.log("-> PASS: generateFallbackReadme produces high-quality metadata fallback!\n");

  // TEST 4: L1/L2 Cache Invalidation Sync & Deferred Write Race Condition Prevention
  console.log("[TEST 4] Testing L1 and L2 cache invalidation sync & race condition prevention...");
  const cacheDir = path.join(__dirname, ".cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const testKey = "user_lists_cache";
  const diskPath = path.join(cacheDir, `${testKey}.json`);

  // Populate L1 and L2
  memoryCache.set(testKey, { data: { dummy: 123 }, expiresAt: Date.now() + 100000 });
  await fs.writeFile(diskPath, JSON.stringify({ data: { dummy: 123 }, expiresAt: Date.now() + 100000 }), "utf-8");

  assert.strictEqual(memoryCache.has(testKey), true, "L1 cache should have entry before invalidation");
  assert.strictEqual(await fs.stat(diskPath).then(() => true).catch(() => false), true, "L2 disk file should exist before invalidation");

  // Invalidate
  await invalidateCache(testKey);

  assert.strictEqual(memoryCache.has(testKey), false, "L1 cache must be deleted after invalidation");
  assert.strictEqual(await fs.stat(diskPath).then(() => true).catch(() => false), false, "L2 disk file must be deleted after invalidation");

  // Race condition probe: setCache followed immediately by invalidateCache before setImmediate fires
  const raceKey = "race_invalidation_test_key";
  const raceDiskPath = path.join(cacheDir, `${raceKey}.json`);
  await setCache(raceKey, { stale: true }, 60000);
  assert.strictEqual(memoryCache.has(raceKey), true, "Memory cache set");
  await invalidateCache(raceKey);
  assert.strictEqual(memoryCache.has(raceKey), false, "Memory cache cleared by invalidation");

  // Wait 60ms for any setImmediate to fire
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(await fs.stat(raceDiskPath).then(() => true).catch(() => false), false, "Deferred write must NOT resurrect cache on disk!");
  const cachedAfterRace = await getCache(raceKey);
  assert.strictEqual(cachedAfterRace, null, "Cache must remain null after invalidation");

  console.log("-> PASS: L1/L2 cache invalidation synchronously clears both memory and disk and prevents deferred write resurrection!\n");

  // TEST 5: Cached GitHub CLI Token (1-hour TTL) & Token Invalidation
  console.log("[TEST 5] Testing cached GitHub CLI token in memory and invalidation...");
  const token = getGitHubToken();
  assert.ok(token && typeof token === "string", "getGitHubToken should return token");
  const token2 = getGitHubToken();
  assert.strictEqual(token, token2, "Subsequent token calls should return cached token without re-execution");

  // Test explicit clearing
  clearCachedGitHubToken();
  const token3 = getGitHubToken();
  assert.strictEqual(token3, token, "getGitHubToken should re-fetch and re-cache token after clearing");
  console.log("-> PASS: GitHub CLI token successfully retrieved, cached, and invalidated!\n");

  // TEST 6: HTTP Request Timeouts (signal with timeoutMs)
  console.log("[TEST 6] Testing HTTP request timeouts in githubRest...");
  let hangServer;
  const hangServerPromise = new Promise((resolve) => {
    hangServer = http.createServer((req, res) => {
      // Deliberately do not answer to trigger timeout
    });
    hangServer.listen(0, resolve);
  });
  await hangServerPromise;
  const hangPort = hangServer.address().port;

  let timedOut = false;
  try {
    await githubRest(`http://127.0.0.1:${hangPort}/hang`, {
      token: "mock-token",
      timeoutMs: 50,
      maxRetries: 0,
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError" || /aborted|timeout/i.test(err.message)) {
      timedOut = true;
    }
  } finally {
    hangServer.close();
  }
  assert.strictEqual(timedOut, true, "githubRest must abort on timeoutMs");
  console.log("-> PASS: Request correctly timed out using AbortSignal.timeout!\n");

  // TEST 7: Property Access Safety in github_export_catalog AND mergeCatalogCategories
  console.log("[TEST 7] Testing property access safety with malformed inputs across export and merge...");
  
  // 7a. Direct mergeCatalogCategories with numeric repo names and malformed properties
  const existingMalformed = [
    {
      name: "AI & Tools",
      repos: [
        {
          name: 12345,
          tags: "ai, tool",
          lists: null,
          summary: "Numeric named tool",
        },
      ],
    },
  ];
  const incomingMalformed = [
    {
      name: 99999, // numeric category name
      repos: [
        {
          name: 12345,
          tags: ["ai", "updated"],
          lists: "Top Stars",
        },
        {
          full_name: 67890, // numeric full_name
          tags: undefined,
          lists: undefined,
        },
      ],
    },
  ];

  // Must NOT throw TypeError: (str || "").trim is not a function
  const mergedDirect = mergeCatalogCategories(existingMalformed, incomingMalformed);
  assert.ok(Array.isArray(mergedDirect), "mergeCatalogCategories must return array");
  assert.ok(mergedDirect.length > 0, "Merged array must have categories");

  // 7b. Full MCP Tool Call test
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
  });
  const client = new Client(
    { name: "test-safety-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  const testCatalogPath = path.resolve(__dirname, "TEST_SAFETY_CATALOG.md");
  await fs.unlink(testCatalogPath).catch(() => {});

  const malformedCategories = [
    {
      name: "AI & Tools",
      repos: [
        {
          name: "agent/tool-one",
          url: "https://github.com/agent/tool-one",
          tags: "ai, autonomous, agent", // string instead of array
          lists: "Top Stars, Daily",     // string instead of array
          summary: "A great tool",
        },
        {
          // Missing name, has full_name instead
          full_name: "agent/tool-two",
          tags: null,
          lists: undefined,
        },
        {
          // Number name
          name: 12345,
          tags: ["valid-tag"],
          lists: ["valid-list"],
        },
      ],
    },
    {
      // Missing name, has category
      category: "Backup & Misc",
      repos: [],
    },
  ];

  // Test in overwrite mode
  const exportRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: testCatalogPath,
      catalog_title: "Safe Catalog",
      categories: malformedCategories,
      mode: "overwrite",
    },
  });
  const exportData = JSON.parse(exportRes.content[0].text);
  assert.strictEqual(exportData.success, true, "Export should succeed in overwrite mode");

  // Test in merge mode (default mode!) on the existing file
  const exportMergeRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: testCatalogPath,
      catalog_title: "Safe Catalog",
      categories: incomingMalformed,
      mode: "merge",
    },
  });
  const exportMergeData = JSON.parse(exportMergeRes.content[0].text);
  assert.strictEqual(exportMergeData.success, true, "Export should succeed in merge mode with numeric names");

  const exportedFileContent = await fs.readFile(testCatalogPath, "utf-8");
  assert.ok(exportedFileContent.includes("### [agent/tool-one]"));
  assert.ok(exportedFileContent.includes("### [agent/tool-two]"));
  assert.ok(exportedFileContent.includes("### [12345]"));
  assert.ok(exportedFileContent.includes("### [67890]"));
  assert.ok(exportedFileContent.includes("`ai`, `autonomous`, `agent`"));
  await fs.unlink(testCatalogPath).catch(() => {});
  console.log("-> PASS: Property access safety in export catalog and merge verified without TypeErrors!\n");

  // TEST 8: Reclassification Deduplication in github_submit_worker_digest
  console.log("[TEST 8] Testing reclassification deduplication across categories and case insensitivity...");
  const orchRes = await client.callTool({
    name: "github_orchestrate_workers",
    arguments: { num_workers: 2, profile: "compact" },
  });
  const orchData = JSON.parse(orchRes.content[0].text);
  const sessionId = orchData.session_id;

  // Submit repo initially under Developer Tools & CLI
  const sub1 = await client.callTool({
    name: "github_submit_worker_digest",
    arguments: {
      session_id: sessionId,
      worker_id: "worker-1",
      analyzed_repos: [
        {
          name: "test-org/dynamic-tool",
          url: "https://github.com/test-org/dynamic-tool",
          category: "Developer Tools & CLI",
          elevator_pitch: "A command-line developer utility.",
          tags: ["cli", "devtools"],
        },
      ],
    },
  });
  const sub1Data = JSON.parse(sub1.content[0].text);
  assert.strictEqual(sub1Data.total_unique_repos_cataloged, 1);
  assert.strictEqual(sub1Data.categories_overview.find((c) => c.category === "Developer Tools & CLI")?.count, 1);

  // Worker 2 (or retry) reclassifies same repo with DIFFERENT CASING and URL trailing slash into AI & Agent Infrastructure
  const sub2 = await client.callTool({
    name: "github_submit_worker_digest",
    arguments: {
      session_id: sessionId,
      worker_id: "worker-2",
      analyzed_repos: [
        {
          name: "TEST-ORG/dynamic-tool",
          url: "https://github.com/test-org/dynamic-tool/",
          category: "AI & Agent Infrastructure",
          elevator_pitch: "Reclassified as an AI infrastructure agent.",
          tags: ["ai", "agent"],
        },
      ],
    },
  });
  const sub2Data = JSON.parse(sub2.content[0].text);
  assert.strictEqual(sub2Data.total_unique_repos_cataloged, 1, "Total unique repos must remain 1 even with different casing");
  assert.strictEqual(
    sub2Data.categories_overview.find((c) => c.category === "Developer Tools & CLI"),
    undefined,
    "Repo must be removed from previous category (leaving it empty and pruned)"
  );
  assert.strictEqual(
    sub2Data.categories_overview.find((c) => c.category === "AI & Agent Infrastructure")?.count,
    1,
    "Repo must now reside solely in new category"
  );
  console.log("-> PASS: Reclassification deduplication and case-insensitivity verified!\n");

  // TEST 9: Sandbox Export file_path (CWE-22 Path Traversal Defense & .md Extension)
  console.log("[TEST 9] Testing sandbox export file_path against CWE-22 traversal and extension enforcement...");

  const traversalRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "../outside_workspace.md",
      categories: [{ name: "Test", repos: [] }],
    },
  });
  assert.strictEqual(traversalRes.isError, true, "Escaping cwd with .. must return isError: true");
  assert.ok(
    traversalRes.content[0].text.includes("Security Error") && traversalRes.content[0].text.includes("CWE-22"),
    "Error text must cite Security Error (CWE-22)"
  );

  const nonMdRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "invalid_output.sh",
      categories: [{ name: "Test", repos: [] }],
    },
  });
  assert.strictEqual(nonMdRes.isError, true, "Non-.md extension must return isError: true");
  assert.ok(
    nonMdRes.content[0].text.includes(".md extension"),
    "Error text must enforce .md extension"
  );
  console.log("-> PASS: CWE-22 path traversal defense and .md extension enforcement verified!\n");

  // TEST 10: API Contract Compatibility & Prototype Collision Defense (CWE-1321)
  console.log("[TEST 10] Testing compiled_categories alias, empty category fallback, and prototype collision defense...");

  // 10a. Unit test resolveCategoryName
  assert.strictEqual(resolveCategoryName({ name: "" }), "Uncategorized");
  assert.strictEqual(resolveCategoryName({ name: "   " }), "Uncategorized");
  assert.strictEqual(resolveCategoryName(null), "Uncategorized");
  assert.strictEqual(resolveCategoryName({ category: "Dev Tools" }), "Dev Tools");

  // 10b. Export via compiled_categories and empty category name
  const compatFile = path.resolve(process.cwd(), "TEST_REGRESSION_COMPAT.md");
  await fs.unlink(compatFile).catch(() => {});

  const exportCompat = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "TEST_REGRESSION_COMPAT.md",
      catalog_title: "Regression API Compat",
      compiled_categories: [
        {
          name: "Developer Tools & CLI",
          repos: [
            {
              name: "constructor",
              url: "https://github.com/tools/constructor",
              summary: "A repo named constructor.",
              archived: false,
            },
          ],
        },
        {
          name: "",
          repos: [
            {
              name: "toString",
              url: "https://github.com/tools/toString",
              summary: "A repo named toString in empty category.",
              archived: false,
            },
          ],
        },
      ],
      mode: "overwrite",
    },
  });
  const exportCompatData = JSON.parse(exportCompat.content[0].text);
  assert.strictEqual(exportCompatData.success, true, "compiled_categories must succeed");
  assert.strictEqual(exportCompatData.categories_count, 2);

  const compatContent = await fs.readFile(compatFile, "utf-8");
  assert.ok(compatContent.includes("## Developer Tools & CLI"));
  assert.ok(compatContent.includes("## Uncategorized"), "Empty category name must fallback to Uncategorized");
  assert.ok(compatContent.includes("### [constructor]"), "Repo named 'constructor' must be exported");
  assert.ok(!compatContent.includes("### [constructor](https://github.com/tools/constructor) [ARCHIVED]"), "'constructor' must not be falsely marked archived");
  assert.ok(compatContent.includes("### [toString]"), "Repo named 'toString' must be exported");
  await fs.unlink(compatFile).catch(() => {});

  console.log("-> PASS: API contract compatibility and prototype collision defense verified!\n");

  await client.close();
  console.log("=== All Audit Fixes Regression Tests PASSED! ===\n");
}

runRegressionTests().catch((err) => {
  console.error("FATAL in regression test suite:", err);
  process.exit(1);
});
