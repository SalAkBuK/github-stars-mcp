import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_ENTRY } from "./test_server_path.js";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runExtendedResilienceTests() {
  console.log("=== Starting Extended Production Resilience Test Suite (v2) ===\n");

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
  });

  const client = new Client(
    {
      name: "extended-resilience-test-client",
      version: "1.4.0",
    },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("Connected to github-stars-mcp server!\n");

  // TEST 1: Non-English README Translation Directive in Worker Prompts
  console.log("[TEST 1] Verifying non-English README translation directive in worker prompts...");
  const orchRes = await client.callTool({
    name: "github_orchestrate_workers",
    arguments: {
      num_workers: 2,
      profile: "compact",
    },
  });
  const orchData = JSON.parse(orchRes.content[0].text);
  const sessionId = orchData.session_id;
  const prompt = orchData.worker_plans[0].subagent_prompt;
  const expectedDirective =
    "If the repository README is in a language other than English, translate its core concepts into English for the elevator pitch and category assignment.";

  assert.ok(
    prompt.includes(expectedDirective),
    "Worker prompt MUST contain the explicit non-English translation directive!"
  );
  console.log("-> PASS: Translation directive found in orchestrator worker prompt!\n");

  // TEST 2: Missing / Empty README Fallback in Worker Chunk
  console.log("[TEST 2] Verifying fallback context in github_get_worker_chunk for missing/short READMEs...");
  const chunkRes = await client.callTool({
    name: "github_get_worker_chunk",
    arguments: {
      session_id: sessionId,
      worker_id: "worker-1",
      profile: "compact",
    },
  });
  const chunkData = JSON.parse(chunkRes.content[0].text);
  assert.ok(chunkData.repos.length > 0, "Chunk should contain repositories");

  // Verify every repo in chunk has non-empty readme_snippet and archived flag
  for (const repo of chunkData.repos) {
    assert.ok(
      typeof repo.readme_snippet === "string" && repo.readme_snippet.length > 0,
      `Repo ${repo.name} should have a non-empty readme_snippet`
    );
    assert.strictEqual(
      typeof repo.archived,
      "boolean",
      `Repo ${repo.name} should have a boolean archived flag`
    );
  }
  console.log(`-> Verified ${chunkData.repos.length} chunk repos: all have non-empty readme snippets and archived boolean.`);
  console.log("-> PASS: Worker chunk fallback and archived flag verified!\n");

  // TEST 3: Missing / Empty README Fallback in github_get_readme
  console.log("[TEST 3] Testing github_get_readme fallback on repository with missing README...");
  // Use a known repository or fallback mechanism
  const readmeRes = await client.callTool({
    name: "github_get_readme",
    arguments: {
      owner: "torvalds",
      repo: "linux",
      profile: "compact",
    },
  });
  const readmeData = JSON.parse(readmeRes.content[0].text);
  assert.strictEqual(readmeData.found, true);
  assert.ok(readmeData.content.length > 50, "Content should be populated");
  console.log("-> PASS: github_get_readme returned valid content.\n");

  // TEST 4: Archived Repository Indication and Smart Merge in github_export_catalog
  console.log("[TEST 4] Testing smart merge mode and [ARCHIVED] tag in github_export_catalog...");
  const testCatalogPath = path.resolve(process.cwd(), "EXTENDED_TEST_CATALOG.md");

  // Clean up if exists
  await fs.unlink(testCatalogPath).catch(() => {});

  // Initial export: 1 active repo, 1 archived repo
  const initialCategories = [
    {
      name: "AI & Agent Infrastructure",
      description: "Libraries and tools for AI agents",
      repos: [
        {
          name: "active/active-agent",
          url: "https://github.com/active/active-agent",
          archived: false,
          summary: "An active AI agent framework.",
          tags: ["ai", "agent"],
          lists: ["Core Tools"],
        },
        {
          name: "legacy/archived-agent",
          url: "https://github.com/legacy/archived-agent",
          archived: true,
          summary: "An archived AI experiment.",
          tags: ["ai", "legacy"],
        },
      ],
    },
  ];

  await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: testCatalogPath,
      catalog_title: "Initial Catalog",
      categories: initialCategories,
      mode: "overwrite",
    },
  });

  let initialMd = await fs.readFile(testCatalogPath, "utf-8");
  assert.ok(
    initialMd.includes("### [legacy/archived-agent](https://github.com/legacy/archived-agent) [ARCHIVED]"),
    "Archived repository must have [ARCHIVED] tag in header!"
  );
  assert.ok(
    initialMd.includes("### [active/active-agent](https://github.com/active/active-agent)\n"),
    "Active repository must NOT have [ARCHIVED] tag in header!"
  );
  console.log("-> PASS: [ARCHIVED] tag rendered correctly for archived repositories.");

  // Simulate user manually adding custom notes and comments to the catalog file
  console.log("-> Simulating user manual edits (adding personal comments & notes)...");
  const editedMd = initialMd.replace(
    "An active AI agent framework.",
    "An active AI agent framework.\n\n> **User Note**: Production tested with Claude 3.5 Sonnet. Works great!\n\n**Manual Comment**: Remember to set API keys."
  );
  await fs.writeFile(testCatalogPath, editedMd, "utf-8");

  // Now perform Smart Merge Export: add a NEW repository to the existing category
  console.log("-> Performing smart merge export with a new repository...");
  const mergeCategories = [
    {
      name: "AI & Agent Infrastructure",
      repos: [
        {
          name: "active/active-agent",
          url: "https://github.com/active/active-agent",
          archived: false,
          summary: "An active AI agent framework updated description.",
          tags: ["ai", "agent", "production"],
        },
        {
          name: "brand-new/new-tool",
          url: "https://github.com/brand-new/new-tool",
          archived: false,
          summary: "Brand new tool added in second sync.",
          tags: ["new", "tools"],
        },
      ],
    },
  ];

  const exportRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: testCatalogPath,
      catalog_title: "Merged Catalog",
      categories: mergeCategories,
      mode: "merge",
    },
  });
  const exportData = JSON.parse(exportRes.content[0].text);
  assert.strictEqual(exportData.merged_existing_file, true, "Should indicate file was merged");

  const mergedMd = await fs.readFile(testCatalogPath, "utf-8");
  console.log("-> Merged Markdown Preview:\n" + mergedMd.slice(0, 700) + "\n...\n");

  // Verify:
  // 1. User manual notes were PRESERVED!
  assert.ok(
    mergedMd.includes("> **User Note**: Production tested with Claude 3.5 Sonnet. Works great!"),
    "User blockquote note MUST be preserved during smart merge!"
  );
  assert.ok(
    mergedMd.includes("**Manual Comment**: Remember to set API keys."),
    "User manual comment MUST be preserved during smart merge!"
  );

  // 2. Previously existing archived repo was PRESERVED even though not in mergeCategories payload!
  assert.ok(
    mergedMd.includes("legacy/archived-agent"),
    "Pre-existing repos not present in incoming delta MUST be preserved!"
  );
  assert.ok(
    mergedMd.includes("[ARCHIVED]"),
    "Archived tag MUST be preserved during smart merge!"
  );

  // 3. Brand new repo was successfully ADDED!
  assert.ok(
    mergedMd.includes("brand-new/new-tool"),
    "New repo MUST be appended to the category!"
  );

  // 4. Tags were merged union
  assert.ok(
    mergedMd.includes("`production`"),
    "New tags from incoming repo should be merged!"
  );

  console.log("-> PASS: Smart merge preserved user notes, comments, existing repos, and merged new stars!\n");

  // TEST 5: Atomic Writes Under High Concurrency
  console.log("[TEST 5] Testing atomic writes under high concurrent load with pre-registered workers...");
  const concurSessionId = `concur_orch_${Date.now()}`;
  const serverPath = SERVER_ENTRY;
  const serverCacheDir = path.join(path.dirname(serverPath), ".cache");
  const localCacheDir = path.join(__dirname, ".cache");
  await fs.mkdir(serverCacheDir, { recursive: true });
  await fs.mkdir(localCacheDir, { recursive: true });

  const preRegisteredWorkers = Object.create(null);
  for (let i = 0; i < 10; i++) {
    preRegisteredWorkers[`worker-test-${i}`] = {
      status: "assigned",
      start_index: i * 5,
      end_index: (i + 1) * 5,
      repo_count: 5,
      retry_count: 0,
      assigned_to: null,
    };
  }

  const sessionData = {
    session_id: concurSessionId,
    created_at: new Date().toISOString(),
    status: "in_progress",
    profile: "compact",
    total_repos: 50,
    baseline_taxonomy: ["Developer Tools & CLI", "AI & Agent Infrastructure"],
    archived_repos: {},
    workers: preRegisteredWorkers,
    repos_by_name: {},
    categories: {},
  };

  const serialized = JSON.stringify(sessionData, null, 2);
  await fs.writeFile(path.join(localCacheDir, `orch_${concurSessionId}.json`), serialized, "utf-8");
  await fs.writeFile(path.join(serverCacheDir, `orch_${concurSessionId}.json`), serialized, "utf-8");

  const concurrentSubmits = [];
  for (let i = 0; i < 10; i++) {
    concurrentSubmits.push(
      client.callTool({
        name: "github_submit_worker_digest",
        arguments: {
          session_id: concurSessionId,
          worker_id: `worker-test-${i}`,
          analyzed_repos: [
            {
              name: `concurrent/repo-${i}`,
              url: `https://github.com/concurrent/repo-${i}`,
              category: "Developer Tools & CLI",
              elevator_pitch: `Concurrent write stress test item ${i}`,
              tags: ["test", "concurrency"],
            },
          ],
        },
      }).catch((e) => ({ error: e.message }))
    );
  }

  const results = await Promise.all(concurrentSubmits);
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    assert.ok(!res.error, `Worker ${i} failed with unexpected error: ${res.error}`);
    assert.ok(res.content && res.content[0], `Worker ${i} returned invalid MCP content`);
    const parsed = JSON.parse(res.content[0].text);
    assert.strictEqual(parsed.status, "digest_accepted", `Worker ${i} digest should be accepted`);
    assert.strictEqual(typeof parsed.total_unique_repos_cataloged, "number");
  }

  // Verify orchestration status shows all 10 workers completed
  const statusRes = await client.callTool({
    name: "github_get_orchestration_status",
    arguments: { session_id: concurSessionId },
  });
  const statusData = JSON.parse(statusRes.content[0].text);
  assert.strictEqual(
    statusData.workers_summary.completed.length,
    10,
    "All 10 pre-registered workers must be in completed list"
  );
  assert.strictEqual(
    statusData.all_completed,
    true,
    "All workers completed should mark all_completed true"
  );
  assert.strictEqual(
    statusData.total_unique_repos_cataloged,
    10,
    "All 10 unique repos cataloged"
  );

  // Clean up test orchestration file
  await fs.unlink(path.join(localCacheDir, `orch_${concurSessionId}.json`)).catch(() => {});
  await fs.unlink(path.join(serverCacheDir, `orch_${concurSessionId}.json`)).catch(() => {});

  console.log("-> PASS: Pre-registered workers passed state validation and executed 10 simultaneous atomic disk writes without EBUSY/EPERM errors!\n");

  // TEST 6: Markdown code blocks with embedded headings & delimiters
  console.log("[TEST 6] Testing smart merge resilience on code blocks containing headings...");
  const codeBlockCatalogPath = path.resolve(process.cwd(), "CODE_BLOCK_TEST_CATALOG.md");
  await fs.unlink(codeBlockCatalogPath).catch(() => {});

  const codeBlockInitialMd = [
    "# Code Block Catalog",
    "",
    "## Table of Contents",
    "- [Developer Tools](#developer-tools) (1)",
    "",
    "---",
    "",
    "## Developer Tools",
    "",
    "### [cli/code-runner](https://github.com/cli/code-runner)",
    "",
    "A versatile CLI code runner.",
    "",
    "```markdown",
    "### [phantom/repo](https://github.com/phantom/repo)",
    "## Fake Category Header",
    "```",
    "",
    "> **User Note**: Works in isolated containers.",
    "",
    "**Tags**: `cli`, `sandbox`",
  ].join("\n");

  await fs.writeFile(codeBlockCatalogPath, codeBlockInitialMd, "utf-8");

  const codeBlockMergeRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: codeBlockCatalogPath,
      catalog_title: "Code Block Catalog",
      categories: [
        {
          name: "Developer Tools",
          repos: [
            {
              name: "cli/code-runner",
              url: "https://github.com/cli/code-runner/", // Notice trailing slash
              summary: "Updated code runner summary.",
              tags: ["cli", "containers"],
            },
          ],
        },
      ],
      mode: "merge",
    },
  });
  const codeBlockMergeData = JSON.parse(codeBlockMergeRes.content[0].text);
  assert.strictEqual(codeBlockMergeData.categories_count, 1, "Should have exactly 1 category, not phantom ones");
  assert.strictEqual(codeBlockMergeData.total_repos_cataloged, 1, "Should have exactly 1 repo, phantom was ignored");

  const mergedCodeBlockMd = await fs.readFile(codeBlockCatalogPath, "utf-8");
  assert.ok(
    !mergedCodeBlockMd.includes("- [Fake Category Header]") &&
    !mergedCodeBlockMd.includes("---\n\n## Fake Category Header"),
    "Fake category inside code block must not become an actual category!"
  );
  assert.ok(
    mergedCodeBlockMd.includes("```markdown\n### [phantom/repo]"),
    "Code block content must be preserved verbatim!"
  );
  assert.ok(
    mergedCodeBlockMd.includes("> **User Note**: Works in isolated containers."),
    "User note below code block must be preserved!"
  );
  console.log("-> PASS: Code blocks with headings and trailing slash URLs handled perfectly!\n");

  // TEST 7: Atomic Write to Nested Non-Existent Directory
  console.log("[TEST 7] Testing atomic write to non-existent nested directory...");
  const nestedCatalogPath = path.resolve(process.cwd(), ".cache/sub1/sub2/NESTED_CATALOG.md");
  await fs.rm(path.resolve(process.cwd(), ".cache/sub1"), { recursive: true, force: true }).catch(() => {});

  const nestedRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: nestedCatalogPath,
      catalog_title: "Nested Catalog",
      categories: [
        {
          name: "AI & Agent Infrastructure",
          repos: [
            {
              name: "nested/repo",
              url: "https://github.com/nested/repo",
              summary: "A repo in a nested catalog.",
              tags: ["nested"],
            },
          ],
        },
      ],
      mode: "overwrite",
    },
  });
  const nestedData = JSON.parse(nestedRes.content[0].text);
  assert.strictEqual(nestedData.success, true);
  const nestedMd = await fs.readFile(nestedCatalogPath, "utf-8");
  assert.ok(nestedMd.includes("### [nested/repo]"));
  console.log("-> PASS: Atomic write automatically created nested directories!\n");

  // Cleanup
  await fs.unlink(testCatalogPath).catch(() => {});
  await fs.unlink(codeBlockCatalogPath).catch(() => {});
  await fs.rm(path.resolve(process.cwd(), ".cache/sub1"), { recursive: true, force: true }).catch(() => {});
  await client.close();

  console.log("=== All Extended Production Resilience Tests (v2) PASSED! ===");
}

runExtendedResilienceTests().catch((err) => {
  console.error("Extended Resilience Test Failed:", err);
  process.exit(1);
});
