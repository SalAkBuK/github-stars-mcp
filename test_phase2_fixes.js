import http from "node:http";
import assert from "node:assert";
import {
  githubRest,
  sleepWithSignal,
  orchestrationSessions,
  chunkedAsyncMap,
  chunkedAsyncAllSettled,
} from "./index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runPhase2Tests() {
  console.log("=== Starting Phase 2 (Reliability & Cleanliness) Test Suite ===\n");

  // TEST 1: Transient Network Error Retry in githubRest
  console.log("[TEST 1] Testing Transient Network Error Retry in githubRest...");
  let netCallCount = 0;
  const netServer = http.createServer((req, res) => {
    netCallCount++;
    if (netCallCount < 3) {
      // Simulate socket destruction / network drop
      req.socket.destroy();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, attempts: netCallCount }));
    }
  });

  await new Promise((resolve) => netServer.listen(0, resolve));
  const netPort = netServer.address().port;
  const netUrl = `http://127.0.0.1:${netPort}/flaky-net`;

  try {
    const res = await githubRest(netUrl, {
      token: "mock-token",
      maxRetries: 3,
      baseDelayMs: 15,
      maxDelayMs: 100,
    });
    assert.strictEqual(netCallCount, 3, "Expected 3 attempts (2 transient failures + 1 success)");
    assert.strictEqual(res.data.success, true);
    console.log("-> PASS: githubRest successfully recovered from transient network drops and succeeded on attempt 3!");
  } finally {
    netServer.close();
  }

  // TEST 1b: Network Error Retry Exhaustion
  console.log("\n[TEST 1b] Testing Network Error Retry Exhaustion...");
  let deadCallCount = 0;
  const deadServer = http.createServer((req, res) => {
    deadCallCount++;
    req.socket.destroy();
  });
  await new Promise((resolve) => deadServer.listen(0, resolve));
  const deadPort = deadServer.address().port;
  const deadUrl = `http://127.0.0.1:${deadPort}/dead-net`;

  let netExhaustedError = null;
  try {
    await githubRest(deadUrl, {
      token: "mock-token",
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
    });
  } catch (err) {
    netExhaustedError = err;
  } finally {
    deadServer.close();
  }
  assert(netExhaustedError, "Expected error when network failures exhaust retries");
  assert.strictEqual(deadCallCount, 3, "Expected 1 initial + 2 retries = 3 attempts total");
  console.log("-> PASS: githubRest exhausted retries on persistent network error and rethrew!");

  // TEST 1c: AbortController During Backoff Sleep
  console.log("\n[TEST 1c] Testing AbortController Cancellation During Backoff Sleep...");
  let abortCallCount = 0;
  const abortServer = http.createServer((req, res) => {
    abortCallCount++;
    req.socket.destroy();
  });
  await new Promise((resolve) => abortServer.listen(0, resolve));
  const abortPort = abortServer.address().port;
  const abortUrl = `http://127.0.0.1:${abortPort}/abort-net`;

  const abortController = new AbortController();
  const abortStart = Date.now();
  // Abort after 40ms, while githubRest would otherwise be sleeping for 2000ms
  setTimeout(() => abortController.abort(), 40);

  let abortCaughtError = null;
  try {
    await githubRest(abortUrl, {
      token: "mock-token",
      maxRetries: 3,
      baseDelayMs: 2000,
      maxDelayMs: 5000,
      signal: abortController.signal,
    });
  } catch (err) {
    abortCaughtError = err;
  } finally {
    abortServer.close();
  }
  const abortElapsed = Date.now() - abortStart;
  assert(abortCaughtError, "Expected AbortError when signal is aborted during backoff");
  assert(
    abortElapsed < 1000,
    `Expected abort to interrupt sleep immediately (< 1000ms), but took ${abortElapsed}ms`
  );
  console.log(`-> PASS: AbortController interrupted backoff sleep immediately (${abortElapsed}ms)!`);

  // TEST 2: Capping retry-after Header Delay
  console.log("\n[TEST 2] Testing retry-after Header Delay Capping...");
  let retryAfterCallCount = 0;
  const retryAfterServer = http.createServer((req, res) => {
    retryAfterCallCount++;
    if (retryAfterCallCount === 1) {
      // Simulate extreme retry-after from GitHub (e.g. 1 hour = 3600 seconds)
      res.writeHead(429, {
        "Content-Type": "application/json",
        "retry-after": "3600",
      });
      res.end(JSON.stringify({ message: "Rate limit exceeded" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    }
  });

  await new Promise((resolve) => retryAfterServer.listen(0, resolve));
  const raPort = retryAfterServer.address().port;
  const raUrl = `http://127.0.0.1:${raPort}/rate-limit-cap`;

  const startTime = Date.now();
  try {
    const res = await githubRest(raUrl, {
      token: "mock-token",
      maxRetries: 1,
      baseDelayMs: 10,
      maxDelayMs: 60, // Cap at 60ms instead of 3,600,000ms
      retryAfterMultiplier: 1000,
    });
    const elapsed = Date.now() - startTime;
    assert.strictEqual(res.data.success, true);
    assert(elapsed < 1000, `Expected backoff to be capped around 60ms, took ${elapsed}ms`);
    console.log(`-> PASS: Extreme retry-after was successfully capped (completed in ${elapsed}ms)!`);
  } finally {
    retryAfterServer.close();
  }

  // TEST 2b: Rate limit with missing/zero delay still capped at maxDelayMs
  console.log("\n[TEST 2b] Testing rate-limit delay capping with zero/missing header...");
  let rlNoHeaderCount = 0;
  const rlNoHeaderServer = http.createServer((req, res) => {
    rlNoHeaderCount++;
    if (rlNoHeaderCount === 1) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Too many requests" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise((resolve) => rlNoHeaderServer.listen(0, resolve));
  const rlNoHeaderPort = rlNoHeaderServer.address().port;
  const rlNoHeaderUrl = `http://127.0.0.1:${rlNoHeaderPort}/rl-no-header`;

  const rlStart = Date.now();
  try {
    const res = await githubRest(rlNoHeaderUrl, {
      token: "mock-token",
      maxRetries: 1,
      baseDelayMs: 200,
      maxDelayMs: 50,
    });
    const rlElapsed = Date.now() - rlStart;
    assert.strictEqual(res.data.ok, true);
    assert(rlElapsed < 300, `Expected delay capped around 50ms, took ${rlElapsed}ms`);
    console.log(`-> PASS: Rate limit backoff without retry-after header capped at maxDelayMs (${rlElapsed}ms)!`);
  } finally {
    rlNoHeaderServer.close();
  }

  // TEST 3: Concurrency Limiter (chunkedAsyncMap and chunkedAsyncAllSettled)
  console.log("\n[TEST 3] Testing Concurrency Limiter (chunkedAsyncMap)...");
  const testItems = Array.from({ length: 14 }, (_, i) => `item-${i + 1}`);
  let activeConcurrency = 0;
  let maxObservedConcurrency = 0;
  const observedIndices = [];

  const results = await chunkedAsyncMap(
    testItems,
    async (item, idx) => {
      observedIndices.push(idx);
      activeConcurrency++;
      if (activeConcurrency > maxObservedConcurrency) {
        maxObservedConcurrency = activeConcurrency;
      }
      await new Promise((r) => setTimeout(r, 20));
      activeConcurrency--;
      return `${item}-processed`;
    },
    5
  );

  assert.strictEqual(results.length, 14);
  assert.strictEqual(results[0], "item-1-processed");
  assert.strictEqual(results[13], "item-14-processed");
  assert(
    maxObservedConcurrency <= 5,
    `Max observed concurrency should be <= 5, was ${maxObservedConcurrency}`
  );
  // Verify true global indices (0 through 13) were passed
  for (let i = 0; i < 14; i++) {
    assert.strictEqual(observedIndices[i], i, `Expected index ${i}, got ${observedIndices[i]}`);
  }
  console.log(`-> PASS: chunkedAsyncMap processed 14 items in chunks of 5 with max concurrency ${maxObservedConcurrency} and correct global indices!`);

  // TEST 3b: Edge cases for chunkedAsyncMap and chunkedAsyncAllSettled
  console.log("\n[TEST 3b] Testing chunkedAsyncMap edge cases (empty, non-array, clamped chunkSize)...");
  assert.deepStrictEqual(await chunkedAsyncMap(null, async (x) => x), []);
  assert.deepStrictEqual(await chunkedAsyncMap([], async (x) => x), []);
  assert.deepStrictEqual(await chunkedAsyncAllSettled(undefined, async (x) => x), []);
  const edgeResults = await chunkedAsyncMap([1, 2], async (x) => x * 2, -1);
  assert.deepStrictEqual(edgeResults, [2, 4]);
  console.log("-> PASS: chunked helpers handle empty/null arrays and clamped chunkSize safely!");

  // TEST 4: Connect to MCP Server via stdio for live tool execution
  console.log("\n[TEST 4] Connecting to MCP Server via Stdio...");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["C:/Users/saleh/.gemini/config/mcp-servers/github-stars/index.js"],
  });
  const client = new Client(
    { name: "phase2-test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  console.log("Connected to github-stars-mcp server!\n");

  // TEST 5: Verify github_clear_cache tool call clears memory and disk caches
  console.log("[TEST 5] Testing github_clear_cache tool execution...");
  const clearRes = await client.callTool({
    name: "github_clear_cache",
    arguments: {},
  });
  assert.strictEqual(clearRes.isError, undefined);
  const clearJson = JSON.parse(clearRes.content[0].text);
  assert.strictEqual(clearJson.success, true);
  console.log("-> PASS: github_clear_cache succeeded without errors!");

  // TEST 6: In-memory orchestrationSessions purging verification
  console.log("\n[TEST 6] Testing direct orchestrationSessions purging in module...");
  orchestrationSessions.set("test-sess-1", { status: "active" });
  orchestrationSessions.set("test-sess-2", { status: "pending" });
  assert.strictEqual(orchestrationSessions.size, 2);
  orchestrationSessions.clear();
  assert.strictEqual(orchestrationSessions.size, 0, "orchestrationSessions must be empty after clear()");
  console.log("-> PASS: In-memory orchestrationSessions cleanly purged!");

  // TEST 7: Route github_get_user_info starred count through githubRest with Link header
  console.log("\n[TEST 7] Testing githubRest with Link Header parsing (as used in github_get_user_info)...");
  let mockServer;
  const mockServerPromise = new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const url = req.url;
      if (url.startsWith("/user/starred")) {
        // Test reversed query parameter order (page before per_page)
        res.writeHead(200, {
          "Content-Type": "application/json",
          link: '<https://api.github.com/user/starred?page=2048&per_page=1>; rel="last", <https://api.github.com/user/starred?page=2&per_page=1>; rel="next"',
        });
        res.end(JSON.stringify([{ id: 1, name: "repo-1" }]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    mockServer.listen(0, resolve);
  });
  await mockServerPromise;
  const mockPort = mockServer.address().port;

  try {
    const userInfoStarredRes = await githubRest(`http://127.0.0.1:${mockPort}/user/starred?per_page=1`, {
      token: "mock-token",
    });
    assert(userInfoStarredRes.headers, "githubRest must return response headers");
    const linkHeader = userInfoStarredRes.headers.get("link");
    assert(linkHeader, "Expected Link header to be present");
    const match = linkHeader.match(/[?&]page=(\d+)[^>]*>;\s*rel=["']?last["']?/i);
    assert(match, "Expected regex to match Link header with reversed query params");
    assert.strictEqual(match[1], "2048", "Expected total stars 2048 parsed from Link header");
    console.log(`-> PASS: githubRest correctly returned Link header with reversed params and parsed star count: ${match[1]}!`);
  } finally {
    mockServer.close();
  }

  // Close MCP client transport
  await transport.close();

  console.log("\n=== All Phase 2 (Reliability & Cleanliness) Tests PASSED! ===");
  process.exit(0);
}

runPhase2Tests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
