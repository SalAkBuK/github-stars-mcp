import http from "node:http";
import assert from "node:assert";
import { githubRest } from "./index.js";

// Test suite for the REAL githubRest function exported by index.js
async function runTests() {
  console.log("=== Testing Real githubRest Function with Exponential Backoff & Retry ===");

  // TEST 1: Retrying on HTTP 429 then HTTP 403 then 200 OK
  let callCount1 = 0;
  const server1 = http.createServer((req, res) => {
    callCount1++;
    if (callCount1 === 1) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "retry-after": "0.1",
      });
      res.end(JSON.stringify({ message: "Too many requests" }));
    } else if (callCount1 === 2) {
      res.writeHead(403, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }));
    } else {
      res.writeHead(200, {
        "Content-Type": "application/json",
        etag: "W/\"test-etag\"",
      });
      res.end(JSON.stringify({ success: true, attempts: callCount1 }));
    }
  });

  await new Promise((resolve) => server1.listen(0, resolve));
  const port1 = server1.address().port;
  const targetUrl1 = `http://127.0.0.1:${port1}/test`;

  console.log(`[TEST 1] Calling real githubRest on mock server (port ${port1})...`);
  const result1 = await githubRest(targetUrl1, {
    token: "mock-token",
    baseDelayMs: 20,
    retryAfterMultiplier: 100,
  });

  assert.strictEqual(callCount1, 3, "Expected 3 attempts before success");
  assert.strictEqual(result1.data.success, true);
  assert.strictEqual(result1.etag, "W/\"test-etag\"");
  console.log("-> PASS: Real githubRest backed off on HTTP 429 & HTTP 403 and succeeded on attempt 3!\n");
  server1.close();

  // TEST 2: Exhausting MAX_RETRIES (should throw error after 3 retries = 4 attempts total)
  let callCount2 = 0;
  const server2 = http.createServer((req, res) => {
    callCount2++;
    res.writeHead(429, {
      "Content-Type": "application/json",
      "retry-after": "0.05",
    });
    res.end(JSON.stringify({ message: "Continuous rate limit" }));
  });

  await new Promise((resolve) => server2.listen(0, resolve));
  const port2 = server2.address().port;
  const targetUrl2 = `http://127.0.0.1:${port2}/rate-limit`;

  console.log(`[TEST 2] Testing retry exhaustion on continuous HTTP 429...`);
  let caughtError = null;
  try {
    await githubRest(targetUrl2, {
      token: "mock-token",
      maxRetries: 3,
      baseDelayMs: 15,
      retryAfterMultiplier: 50,
    });
  } catch (err) {
    caughtError = err;
  }

  assert(caughtError, "Expected githubRest to throw after exhausting retries");
  assert(caughtError.message.includes("429"), "Expected error message to contain HTTP 429");
  assert.strictEqual(callCount2, 4, "Expected initial attempt + 3 retries = 4 total attempts");
  console.log("-> PASS: Real githubRest correctly exhausted 3 retries and threw error!\n");
  server2.close();

  // TEST 3: Handling HTTP 204 No Content
  const server3 = http.createServer((req, res) => {
    res.writeHead(204);
    res.end();
  });

  await new Promise((resolve) => server3.listen(0, resolve));
  const port3 = server3.address().port;
  const targetUrl3 = `http://127.0.0.1:${port3}/no-content`;

  console.log(`[TEST 3] Testing HTTP 204 No Content handling...`);
  const result3 = await githubRest(targetUrl3, { token: "mock-token" });
  assert.strictEqual(result3.data, null);
  console.log("-> PASS: Real githubRest safely handles HTTP 204 without JSON parse errors!\n");
  server3.close();

  console.log("=== All githubRest Backoff & Retry Tests PASSED! ===");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
