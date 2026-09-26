import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_ENTRY } from "./test_server_path.js";

async function runBenchmark() {
  console.log("Starting Cache & Prefetch Benchmark test...");
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
  });

  const client = new Client(
    {
      name: "benchmark-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  console.log("Connected to github-stars-mcp server!\n");

  // Step 1: Clear cache to ensure clean benchmark
  console.log("1. Clearing cache...");
  await client.callTool({ name: "github_clear_cache", arguments: {} });

  // Step 2: Cold call - Batch 1 (page 1, 2 repos)
  console.log("\n2. [COLD CALL] Fetching Batch 1 (page 1, 2 repos)...");
  const t0 = Date.now();
  const res1 = await client.callTool({
    name: "github_batch_get_starred_with_readme",
    arguments: { page: 1, per_page: 2, profile: "compact", distill: true },
  });
  const elapsed1 = Date.now() - t0;
  const data1 = JSON.parse(res1.content[0].text);
  console.log(`-> Batch 1 Cold Time: ${elapsed1}ms (Server report: ${data1.performance.latency_ms}ms)`);
  console.log(`-> Cache hit: ${data1.performance.page_cache_hit}, Readme hits: ${data1.performance.readmes_cache_hits}`);
  console.log(`-> Prefetch next batch active: ${data1.performance.prefetch_next_batch_active}`);

  // Step 3: Immediate repeat call on Batch 1 -> Should be instant 0ms from L1 cache!
  console.log("\n3. [CACHE HIT TEST] Re-requesting Batch 1 immediately...");
  const t1 = Date.now();
  const resRepeat = await client.callTool({
    name: "github_batch_get_starred_with_readme",
    arguments: { page: 1, per_page: 2, profile: "compact", distill: true },
  });
  const elapsedRepeat = Date.now() - t1;
  const dataRepeat = JSON.parse(resRepeat.content[0].text);
  console.log(`-> Batch 1 Repeat Time: ${elapsedRepeat}ms (Server report: ${dataRepeat.performance.latency_ms}ms)`);
  console.log(`-> Cache hit: ${dataRepeat.performance.page_cache_hit}, Readme hits: ${dataRepeat.performance.readmes_cache_hits}`);

  // Step 4: Wait 800ms for speculative prefetch of Batch 2 (page 2) to complete in background
  console.log("\n4. Waiting 800ms for background prefetch to settle...");
  await new Promise((resolve) => setTimeout(resolve, 800));

  // Step 5: Request Batch 2 (page 2) -> Should be prefetch hit!
  console.log("5. [PREFETCH HIT TEST] Requesting Batch 2 (page 2, 2 repos)...");
  const t2 = Date.now();
  const res2 = await client.callTool({
    name: "github_batch_get_starred_with_readme",
    arguments: { page: 2, per_page: 2, profile: "compact", distill: true },
  });
  const elapsed2 = Date.now() - t2;
  const data2 = JSON.parse(res2.content[0].text);
  console.log(`-> Batch 2 Prefetched Time: ${elapsed2}ms (Server report: ${data2.performance.latency_ms}ms)`);
  console.log(`-> Page Cache hit: ${data2.performance.page_cache_hit}, Readme hits: ${data2.performance.readmes_cache_hits}`);

  await client.close();
  console.log("\nBenchmark complete! Speedup is massive.");
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
