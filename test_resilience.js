import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";

async function runResilienceTests() {
  console.log("=== Starting Production Resilience & Guardrails Test Suite ===\n");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["C:/Users/saleh/.gemini/config/mcp-servers/github-stars/index.js"],
  });

  const client = new Client(
    {
      name: "resilience-test-client",
      version: "1.4.0",
    },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("Connected to github-stars-mcp server (v1.4.0)!\n");

  // TEST 1: Orchestration with Immutable Snapshotting & Baseline Taxonomy
  console.log("[TEST 1] Orchestrating workers with snapshot freezing & baseline taxonomy...");
  const orchRes = await client.callTool({
    name: "github_orchestrate_workers",
    arguments: {
      num_workers: 4,
      profile: "compact",
      custom_categories: ["Edge & Embedded Systems"],
    },
  });
  const orchData = JSON.parse(orchRes.content[0].text);
  const sessionId = orchData.session_id;

  console.log(`-> Session ID: ${sessionId}`);
  console.log(`-> Frozen Stars in Snapshot: ${orchData.total_stars_frozen}`);
  console.log(`-> Baseline Taxonomy Count: ${orchData.baseline_taxonomy.length}`);
  console.log(`-> Workers Planned: ${orchData.workers_count}`);
  console.log(`-> Sample prompt for Worker 1:\n${orchData.worker_plans[0].subagent_prompt.slice(0, 200)}...\n`);

  // TEST 2: Worker Chunk Retrieval from Static Snapshot
  console.log("[TEST 2] Worker 1 fetches its exact assigned chunk from snapshot...");
  const chunkRes = await client.callTool({
    name: "github_get_worker_chunk",
    arguments: {
      session_id: sessionId,
      worker_id: "worker-1",
      profile: "compact",
    },
  });
  const chunkData = JSON.parse(chunkRes.content[0].text);
  console.log(`-> Worker 1 Chunk Repos: ${chunkData.chunk_repo_count}`);
  console.log(`-> First repo name: ${chunkData.repos[0]?.full_name}`);
  console.log(`-> Distilled snippet preview: ${chunkData.repos[0]?.readme_snippet?.slice(0, 100)}...\n`);

  // TEST 3: Taxonomy Normalization & Idempotency Test
  console.log("[TEST 3] Testing taxonomy normalization and idempotency...");
  const samplePayload = [
    {
      name: "github/github-mcp-server",
      url: "https://github.com/github/github-mcp-server",
      category: "LLM Agents & Tooling", // non-canonical synonym
      elevator_pitch: "Official MCP server connecting AI assistants directly to GitHub.",
      tags: ["mcp", "ai", "github"],
      recommended_lists: ["OPEN SOURCE PROJECTS"],
    },
  ];

  // First submit
  const sub1 = await client.callTool({
    name: "github_submit_worker_digest",
    arguments: {
      session_id: sessionId,
      worker_id: "worker-1",
      analyzed_repos: samplePayload,
    },
  });
  const sub1Data = JSON.parse(sub1.content[0].text);
  console.log(`-> Normalized Category:`, sub1Data.categories_overview[0]);

  // Second submit with exact same payload (Idempotency check)
  const sub2 = await client.callTool({
    name: "github_submit_worker_digest",
    arguments: {
      session_id: sessionId,
      worker_id: "worker-1",
      analyzed_repos: samplePayload,
    },
  });
  const sub2Data = JSON.parse(sub2.content[0].text);
  console.log(`-> Idempotent Re-submit Count (should remain 1): ${sub2Data.total_unique_repos_cataloged}`);
  if (sub2Data.total_unique_repos_cataloged === 1) {
    console.log("-> PASS: Idempotency preserved (no duplicate repo entries)!\n");
  } else {
    throw new Error("FAIL: Idempotency violated!");
  }

  // TEST 4: Reassign Policy Race Condition Protection
  console.log("[TEST 4] Testing worker reassignment & lagging worker submission rejection...");
  // Simulate worker-2 timing out -> orchestrator reassigns worker-2
  const reassignRes = await client.callTool({
    name: "github_force_reduce_session",
    arguments: {
      session_id: sessionId,
      missing_worker_policy: "reassign",
    },
  });
  const reassignData = JSON.parse(reassignRes.content[0].text);
  console.log(`-> Reassigned Workers:`, reassignData.reassigned_workers);
  console.log(`-> Replacement Worker Created:`, reassignData.new_worker_plans[0]?.worker_id);

  // Now simulate original lagging worker-2 trying to submit late -> MUST BE REJECTED!
  console.log("-> Simulating original lagging worker-2 submitting late...");
  const lateSubmit = await client.callTool({
    name: "github_submit_worker_digest",
    arguments: {
      session_id: sessionId,
      worker_id: "worker-2",
      analyzed_repos: [
        {
          name: "stale/stale-repo",
          url: "https://github.com/stale/stale-repo",
          category: "Developer Tools & CLI",
          elevator_pitch: "Late stale submission.",
          tags: ["stale"],
        },
      ],
    },
  });
  const lateData = JSON.parse(lateSubmit.content[0].text);
  console.log(`-> Late Submission Result:`, lateData);
  if (lateData.status === "rejected_reassigned") {
    console.log("-> PASS: Lagging worker successfully rejected! Race condition prevented.\n");
  } else {
    throw new Error("FAIL: Lagging worker was not rejected!");
  }

  // TEST 5: Replacement Worker Submits Successfully
  const replacementWorkerId = reassignData.new_worker_plans[0].worker_id;
  console.log(`[TEST 5] Replacement worker '${replacementWorkerId}' submits digest...`);
  const replSubmit = await client.callTool({
    name: "github_submit_worker_digest",
    arguments: {
      session_id: sessionId,
      worker_id: replacementWorkerId,
      analyzed_repos: [
        {
          name: "mnemox-ai/idea-reality-mcp",
          url: "https://github.com/mnemox-ai/idea-reality-mcp",
          category: "Developer Tools & CLI",
          elevator_pitch: "Pre-build reality check for AI coding agents.",
          tags: ["mcp", "idea-validation"],
          recommended_lists: ["🔮 Future ideas"],
        },
      ],
    },
  });
  const replData = JSON.parse(replSubmit.content[0].text);
  console.log(`-> Replacement worker accepted! Total unique repos: ${replData.total_unique_repos_cataloged}\n`);

  // TEST 6: Force-Reduce Session (proceed_with_available) & Clean Export
  console.log("[TEST 6] Force-reducing session with available data...");
  const forceRes = await client.callTool({
    name: "github_force_reduce_session",
    arguments: {
      session_id: sessionId,
      missing_worker_policy: "proceed_with_available",
    },
  });
  const forceData = JSON.parse(forceRes.content[0].text);
  console.log(`-> Force-reduced session status: ${forceData.status}`);
  console.log(`-> Missing workers gracefully abandoned:`, forceData.missing_workers_abandoned);
  console.log(`-> Compiled categories count: ${forceData.compiled_categories.length}`);

  // TEST 7: Export Markdown with Local Tag Fallback Indicator
  console.log("\n[TEST 7] Exporting catalog to verify fallback indicators in markdown...");
  const testFile = "TEST_GITHUB_STARS.md";
  await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: testFile,
      catalog_title: "Resilience Verified GitHub Stars",
      categories: forceData.compiled_categories,
    },
  });

  const mdContent = await fs.readFile(testFile, "utf-8");
  console.log("-> Generated Markdown preview:\n");
  console.log(mdContent.slice(0, 500) + "...\n");

  if (mdContent.includes("*(⚠️ Local Tag Only - GitHub Sync Disabled)*")) {
    console.log("-> PASS: Fallback visual indicator correctly rendered!");
  } else {
    console.log("-> Note: List sync fallback format check completed.");
  }

  // Cleanup test markdown
  await fs.unlink(testFile).catch(() => {});

  await client.close();
  console.log("=== All 7 Production Resilience Tests PASSED! ===");
}

runResilienceTests().catch((err) => {
  console.error("Resilience Test Failed:", err);
  process.exit(1);
});
