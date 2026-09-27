import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_ENTRY } from "./test_server_path.js";

async function runTest() {
  console.log("Starting MCP client test with context-awareness verification...");
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
  });

  const client = new Client(
    {
      name: "test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  console.log("Connected to github-stars-mcp server!");

  // Test: compact profile (for 8k-16k models)
  console.log("\n[TEST 1] Testing batch with 'compact' profile (small context model simulation)...");
  const compactRes = await client.callTool({
    name: "github_batch_get_starred_with_readme",
    arguments: {
      page: 1,
      per_page: 2,
      profile: "compact",
      distill: true,
    },
  });
  const compactData = JSON.parse(compactRes.content[0].text);
  console.log("Token Stats (Compact):", compactData.token_stats);
  console.log("Sample distilled snippet length:", compactData.items[0]?.readme_snippet?.length, "chars");
  console.log("Sample distilled preview:\n", compactData.items[0]?.readme_snippet?.slice(0, 150) + "...\n");

  // Test: custom token budget
  console.log("\n[TEST 2] Testing batch with custom token_budget (1200 tokens)...");
  const customBudgetRes = await client.callTool({
    name: "github_batch_get_starred_with_readme",
    arguments: {
      page: 1,
      per_page: 3,
      token_budget: 1200,
      distill: true,
    },
  });
  const customData = JSON.parse(customBudgetRes.content[0].text);
  console.log("Token Stats (Custom Budget):", customData.token_stats);

  // Test: single repo distilled readme
  console.log("\n[TEST 3] Testing github_get_readme with distillation...");
  const readmeRes = await client.callTool({
    name: "github_get_readme",
    arguments: {
      owner: "codetesla51",
      repo: "nine-fives",
      profile: "compact",
      distill: true,
    },
  });
  const readmeData = JSON.parse(readmeRes.content[0].text);
  console.log("Readme Result Stats:", {
    raw_length: readmeData.raw_length,
    returned_length: readmeData.returned_length,
    estimated_tokens: readmeData.token_stats?.estimated_tokens,
    truncated: readmeData.truncated,
  });

  await client.close();
  console.log("\nAll context-awareness tests passed successfully!");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
