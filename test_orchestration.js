import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_ENTRY } from "./test_server_path.js";
import assert from "node:assert";

async function runOrchestrationTest() {
  console.log("Starting Multi-Agent Orchestration test...");
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
  });

  const client = new Client(
    {
      name: "orchestration-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  console.log("Connected to github-stars-mcp server!\n");

  // Test 1: github_orchestrate_workers
  console.log("1. Calling github_orchestrate_workers (4 workers)...");
  const orchRes = await client.callTool({
    name: "github_orchestrate_workers",
    arguments: {
      num_workers: 4,
      per_page: 10,
      profile: "compact",
    },
  });
  const orchData = JSON.parse(orchRes.content[0].text);
  console.log("Session ID:", orchData.session_id);
  console.log("Total Stars Frozen:", orchData.total_stars_frozen);
  console.log("Workers Count:", orchData.workers_count);
  console.log("Generated Worker Plans count:", orchData.worker_plans.length);
  console.log("Sample Worker Plan 1:", orchData.worker_plans[0]);

  assert.strictEqual(typeof orchData.total_stars_frozen, "number", "total_stars_frozen should be a number");
  assert.ok(orchData.total_stars_frozen >= 0, "total_stars_frozen should be >= 0");
  assert.strictEqual(typeof orchData.session_id, "string", "session_id should be a string");
  assert.ok(Array.isArray(orchData.worker_plans), "worker_plans should be an array");

  const sessionId = orchData.session_id;

  // Test 2: worker-1 submits its digest
  console.log("\n2. Simulating Worker 1 submitting its digest...");
  const submitRes1 = await client.callTool({
    name: "github_submit_worker_digest",
    arguments: {
      session_id: sessionId,
      worker_id: "worker-1",
      analyzed_repos: [
        {
          name: "github/github-mcp-server",
          url: "https://github.com/github/github-mcp-server",
          node_id: "R_kgDOODGMVA",
          category: "AI & Agent Tooling",
          elevator_pitch: "Official MCP server connecting AI assistants directly to GitHub's platform.",
          tags: ["mcp", "ai-agents", "developer-tools"],
          recommended_lists: ["OPEN SOURCE PROJECTS"],
        },
        {
          name: "mnemox-ai/idea-reality-mcp",
          url: "https://github.com/mnemox-ai/idea-reality-mcp",
          node_id: "R_kgDORXoKLQ",
          category: "Market Research & Idea Validation",
          elevator_pitch: "Pre-build reality check for AI coding agents scanning GitHub, HN, and npm.",
          tags: ["market-research", "mcp", "ai-agents"],
          recommended_lists: ["🔮 Future ideas"],
        },
      ],
    },
  });
  const submitData1 = JSON.parse(submitRes1.content[0].text);
  console.log("Worker 1 submission result:", {
    status: submitData1.status,
    total_unique_repos_cataloged: submitData1.total_unique_repos_cataloged,
    all_workers_completed: submitData1.all_workers_completed,
    categories: submitData1.categories_overview,
  });

  assert.strictEqual(submitData1.status, "digest_accepted", "Status should be digest_accepted");
  assert.strictEqual(typeof submitData1.total_unique_repos_cataloged, "number", "total_unique_repos_cataloged should be a number");
  assert.strictEqual(submitData1.total_unique_repos_cataloged, 2, "total_unique_repos_cataloged should be 2");
  assert.strictEqual(submitData1.all_workers_completed, false, "all_workers_completed should be false");

  // Test 3: Check orchestration status
  console.log("\n3. Inspecting orchestration status via github_get_orchestration_status...");
  const statusRes = await client.callTool({
    name: "github_get_orchestration_status",
    arguments: { session_id: sessionId },
  });
  const statusData = JSON.parse(statusRes.content[0].text);
  console.log("Status check:", {
    total_unique_repos_cataloged: statusData.total_unique_repos_cataloged,
    completed: statusData.workers_summary.completed,
    in_progress: statusData.workers_summary.in_progress,
    assigned: statusData.workers_summary.assigned,
    all_done: statusData.all_completed,
    compiled_categories_count: statusData.compiled_categories.length,
  });

  assert.strictEqual(typeof statusData.total_unique_repos_cataloged, "number", "total_unique_repos_cataloged should be a number");
  assert.strictEqual(statusData.total_unique_repos_cataloged, 2, "total_unique_repos_cataloged should be 2");
  assert.ok(Array.isArray(statusData.workers_summary.completed), "workers_summary.completed should be an array");
  assert.ok(statusData.workers_summary.completed.includes("worker-1"), "workers_summary.completed should contain worker-1");
  assert.ok(Array.isArray(statusData.workers_summary.in_progress), "workers_summary.in_progress should be an array");
  assert.ok(Array.isArray(statusData.workers_summary.assigned), "workers_summary.assigned should be an array");

  await client.close();
  console.log("\nOrchestration test passed successfully!");
}

runOrchestrationTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
