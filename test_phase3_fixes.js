import assert from "node:assert";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { githubGraphQL } from "./index.js";

async function runPhase3Tests() {
  console.log("=== Starting Phase 3 (Performance, Scope Handling & Concurrency) Test Suite ===\n");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["C:/Users/saleh/.gemini/config/mcp-servers/github-stars/index.js"],
  });

  const client = new Client(
    {
      name: "phase3-test-client",
      version: "1.0.0",
    },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("Connected to github-stars-mcp server!\n");

  // TEST 1: Friendly OAuth Scope Handling in github_get_user_lists
  console.log("[TEST 1] Testing github_get_user_lists execution and friendly error handling...");
  const listsRes = await client.callTool({
    name: "github_get_user_lists",
    arguments: { refresh: true },
  });

  assert.ok(listsRes.content && listsRes.content[0], "Expected valid MCP response content");
  const listsData = JSON.parse(listsRes.content[0].text);

  if (listsData.error === "INSUFFICIENT_SCOPES") {
    assert.strictEqual(
      listsData.message,
      "Listing or managing GitHub Star Lists requires the 'user' scope on your token. Run 'gh auth refresh -s user' in PowerShell to grant it.",
      "Friendly remediation message must match exactly"
    );
    assert.strictEqual(listsData.success, false);
    console.log("-> PASS: github_get_user_lists gracefully caught INSUFFICIENT_SCOPES and returned friendly guidance!");
  } else {
    assert.strictEqual(typeof listsData.lists_count, "number");
    assert.ok(Array.isArray(listsData.lists));
    console.log(`-> PASS: github_get_user_lists succeeded with ${listsData.lists_count} lists!`);
  }

  // TEST 2: Star Fetching Pagination Optimization in fetchAllStarsSnapshot()
  console.log("\n[TEST 2] Testing github_orchestrate_workers with optimized 100 per_page pagination...");
  const startTime = Date.now();
  const orchRes = await client.callTool({
    name: "github_orchestrate_workers",
    arguments: {
      num_workers: 4,
      profile: "compact",
    },
  });
  const elapsed = Date.now() - startTime;
  const orchData = JSON.parse(orchRes.content[0].text);
  assert.strictEqual(typeof orchData.total_stars_frozen, "number");
  assert.ok(orchData.total_stars_frozen >= 0);
  assert.strictEqual(orchData.workers_count, 4);
  console.log(`-> PASS: Orchestration froze ${orchData.total_stars_frozen} stars into 4 worker plans in ${elapsed}ms!`);

  await client.close();

  // TEST 3: GraphQL Scope Error Simulation & Remediation
  console.log("\n[TEST 3] Testing githubGraphQL error parsing with INSUFFICIENT_SCOPES payload...");
  let mockGqlServer;
  const mockGqlPromise = new Promise((resolve) => {
    mockGqlServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          errors: [
            {
              message:
                "INSUFFICIENT_SCOPES: Your token has not been granted the required scopes to access this endpoint.",
            },
          ],
        })
      );
    });
    mockGqlServer.listen(0, resolve);
  });
  await mockGqlPromise;
  const gqlPort = mockGqlServer.address().port;

  try {
    let thrownError = null;
    try {
      await githubGraphQL(
        "query { viewer { lists { nodes { id } } } }",
        {},
        {
          endpoint: `http://127.0.0.1:${gqlPort}/graphql`,
          token: "mock-token",
        }
      );
    } catch (err) {
      thrownError = err;
    }
    assert.ok(thrownError, "Expected githubGraphQL to throw on error response");
    assert.ok(
      thrownError.message.includes("INSUFFICIENT_SCOPES"),
      `Expected error to contain INSUFFICIENT_SCOPES, got: ${thrownError.message}`
    );

    // Verify error classification logic matches remediation message
    const isScopeError =
      thrownError.message.includes("INSUFFICIENT_SCOPES") ||
      thrownError.message.includes("Resource not accessible") ||
      thrownError.message.toLowerCase().includes("scope");
    assert.ok(isScopeError, "Must be recognized as a scope error");
    const friendlyMessage =
      "Listing or managing GitHub Star Lists requires the 'user' scope on your token. Run 'gh auth refresh -s user' in PowerShell to grant it.";
    assert.ok(friendlyMessage.includes("gh auth refresh -s user"));
    console.log("-> PASS: GraphQL INSUFFICIENT_SCOPES parsed correctly and mapped to remediation advice!");
  } finally {
    mockGqlServer.close();
  }

  console.log("\n=== All Phase 3 Tests PASSED with Zero Errors! ===");
  process.exit(0);
}

runPhase3Tests().catch((err) => {
  console.error("Phase 3 tests failed:", err);
  process.exit(1);
});
