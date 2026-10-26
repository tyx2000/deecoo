import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { discoverModelMetadata } from "../src/llm/modelDiscovery.js";
import { providerCapabilities } from "../src/llm/capabilities.js";
import { buildBudgetedContext } from "../src/context/builder.js";

const listing = { object: "list", data: [
  { id: "deepseek-flash", object: "model", owned_by: "deepseek", context_window: 1048576, max_output_tokens: 393216 },
  { id: "deepseek-legacy", object: "model", owned_by: "deepseek" },
] };

// These tests need a loopback HTTP server. A network-denied sandbox refuses the bind; skip with
// that reason there instead of loosening the sandbox. Every other environment, CI included, runs them.
const loopbackDenied = await new Promise((resolve) => {
  const probe = createServer();
  probe.once("error", (error) => resolve(error.code === "EPERM" ? "loopback networking is denied by the current sandbox" : false));
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(false)));
});

async function modelsServer(handler, fn) {
  const requests = [];
  const server = createServer((request, response) => { requests.push({ url: request.url, auth: request.headers.authorization }); handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`, requests); } finally { await new Promise((resolve) => server.close(resolve)); }
}
const json = (body, status = 200) => (_request, response) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };

test("CONTEXT-CLI-002 a DeepSeek route reports its own context window and output limit", { skip: loopbackDenied }, async () => modelsServer(json(listing), async (baseUrl, requests) => {
  const config = { provider: "deepseek", model: "deepseek-flash", baseUrl, apiKey: "sk-test" };
  const metadata = await discoverModelMetadata(config);
  assert.deepEqual(metadata, { model: "deepseek-flash", provider: "deepseek", baseUrl, contextWindow: 1048576, maxOutputTokens: 393216 });
  assert.deepEqual(requests, [{ url: "/models", auth: "Bearer sk-test" }]);
  const capabilities = providerCapabilities({ ...config, modelMetadata: metadata });
  assert.equal(capabilities.contextWindow, 1048576);
  assert.equal(capabilities.contextWindowSource, "model-metadata");
  assert.equal(capabilities.maxOutputTokens, 393216);
  assert.equal(providerCapabilities({ ...config, model: "deepseek-v4-pro", modelMetadata: metadata }).contextWindowSource, "conservative-fallback",
    "metadata discovered for one model never applies to another");
}));

test("CONTEXT-CLI-002 unknown models, failing endpoints and other providers keep the conservative fallback", { skip: loopbackDenied }, async () => {
  await modelsServer(json(listing), async (baseUrl) => {
    assert.equal(await discoverModelMetadata({ provider: "deepseek", model: "deepseek-legacy", baseUrl, apiKey: "sk-test" }), undefined);
    assert.equal(await discoverModelMetadata({ provider: "deepseek", model: "not-listed", baseUrl, apiKey: "sk-test" }), undefined);
  });
  await modelsServer(json({ error: "unavailable" }, 503), async (baseUrl, requests) => {
    assert.equal(await discoverModelMetadata({ provider: "deepseek", model: "deepseek-flash", baseUrl, apiKey: "sk-test", retryAttempts: 5 }), undefined);
    assert.equal(requests.length, 1, "discovery never retries");
  });
  await modelsServer(json(listing), async (baseUrl, requests) => {
    assert.equal(await discoverModelMetadata({ provider: "openai", model: "deepseek-flash", baseUrl, apiKey: "sk-test" }), undefined);
    assert.equal(await discoverModelMetadata({ provider: "deepseek", model: "deepseek-flash", baseUrl, apiKey: "sk-test", contextWindow: 65536 }), undefined);
    assert.equal(requests.length, 0, "an explicit window or an unsupported provider makes no request");
  });
});

test("CONTEXT-CLI-002 an over-budget request on an assumed window says how to set the real one", () => {
  const reservedMessages = [{ role: "system", content: "x".repeat(40000) }];
  assert.throws(() => buildBudgetedContext([], { contextWindow: 32768, contextWindowSource: "conservative-fallback", reservedMessages }),
    /unknown, so 32768 tokens was assumed; set DEECOO_CONTEXT_WINDOW or pass --context-window/);
  assert.throws(() => buildBudgetedContext([], { contextWindow: 32768, contextWindowSource: "configured", reservedMessages }),
    (error) => error.code === "CONTEXT_BUDGET_EXCEEDED" && !/DEECOO_CONTEXT_WINDOW/.test(error.message));
});
