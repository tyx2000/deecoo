import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerCapabilities, FALLBACK_CONTEXT_WINDOW, adapterCapabilities } from "../src/llm/capabilities.js";
import { createModelClient } from "../src/llm/clientFactory.js";
import { createRouteIdentity, prepareModelRequest, endpointFingerprint, schemaFingerprint } from "../src/llm/prepareRequest.js";
import { budgetClient, createTaskBudget } from "../src/harness/budget.js";
import { createRateLimiter, rateLimitClient } from "../src/llm/rateLimiter.js";
import { checkpointIdentity, validateCheckpoint } from "../src/harness/checkpoints.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { buildTaskToolPolicy } from "../src/permissions/taskPolicy.js";

const config = { provider: "openai", model: "unknown-test-model", baseUrl: "https://provider.example.test/v1", apiKey: "synthetic-secret", retryAttempts: 1, timeoutMs: 1000 };
const tool = { type: "function", function: { name: "read_file", description: "Read source", parameters: { type: "object", properties: { path: { type: "string" } } } } };
const request = () => ({ model: config.model, messages: [{ role: "user", content: "Inspect source" }], tools: [structuredClone(tool)], max_tokens: 400 });
const reply = () => ({ choices: [{ message: { role: "assistant", content: "Inspected source" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
async function fakeFetch(fn, run) { const original = globalThis.fetch; try { globalThis.fetch = fn; return await run(); } finally { globalThis.fetch = original; } }

test("DSH-REF-003 remote capabilities remain unknown until model metadata or config declares them", () => {
  const caps = providerCapabilities(config);
  assert.equal(caps.toolCalling, "unknown"); assert.equal(caps.streaming, "unknown"); assert.equal(caps.reasoningEffort, "unknown");
  assert.equal(caps.thinking, false); assert.equal(caps.sources.thinking, "adapter-unsupported");
  assert.equal(caps.contextWindow, FALLBACK_CONTEXT_WINDOW); assert.equal(caps.contextWindowSource, "conservative-fallback");
  const declared = providerCapabilities({ ...config, modelMetadata: { [config.model]: { contextWindow: 8192, maxOutputTokens: 512, toolCalling: true, streaming: false } }, capabilityOverrides: { contextWindow: 4096, toolCalling: false } });
  assert.equal(declared.contextWindow, 4096); assert.equal(declared.contextWindowSource, "configured");
  assert.equal(declared.maxOutputTokens, 512); assert.equal(declared.sources.maxOutputTokens, "model-metadata"); assert.equal(declared.toolCalling, false); assert.equal(declared.streaming, false);
  assert.equal(providerCapabilities({ ...config, modelMetadata: { model: "another-model", contextWindow: 999999 } }).contextWindowSource, "conservative-fallback");
  assert.equal(adapterCapabilities("unrecognized-adapter").toolCalling, "unknown");
  assert.equal(adapterCapabilities("unrecognized-adapter").thinking, "unknown");
  assert.equal(providerCapabilities({}).protocol, "unspecified");
  assert.equal(providerCapabilities({}).sources.protocol, "unknown-adapter");
});

test("DSH-REF-003 prepared snapshots bind route, schema and effective output cap without freezing callers", () => {
  const client = createModelClient({ ...config, modelMetadata: { maxOutputTokens: 128, minOutputTokens: 8, contextWindow: 8192 } });
  const input = request();
  const prepared = client.prepareRequest(input);
  assert.equal(prepared.effectiveConfig.maxTokens, 128); assert.equal(prepared.request.max_tokens, 128); assert.equal(prepared.effectiveConfig.requestedMaxTokens, 400);
  assert.equal(prepared.effectiveConfig.sources.maxTokens, "route-limit"); assert.equal(prepared.capabilities.contextWindow, 8192);
  assert.equal(prepared.routeIdentity.toolsSchemaFingerprint, schemaFingerprint(input.tools));
  assert.equal(prepared.routeIdentity.endpointHash, endpointFingerprint(config.baseUrl));
  assert.equal(prepared.requestFingerprint.length, 64); assert.equal(prepared.routeIdentity.hash.length, 64);
  input.messages[0].content = "Caller changed source"; input.tools[0].function.description = "Changed schema";
  assert.equal(prepared.request.messages[0].content, "Inspect source"); assert.equal(prepared.request.tools[0].function.description, "Read source");
  assert.throws(() => { prepared.request.messages[0].content = "mutate"; }, TypeError);
  assert.throws(() => { prepared.effectiveConfig.maxTokens = 999; }, TypeError);
  assert.throws(() => client.prepareRequest({ ...request(), max_tokens: 2 }), { code: "OUTPUT_LIMIT_INVALID" });
});

test("DSH-REF-003 explicitly unsupported parameters are rejected before provider dispatch", async () => {
  let calls = 0;
  await fakeFetch(async () => { calls += 1; throw new Error("No network request expected"); }, async () => {
    const openai = createModelClient(config);
    assert.throws(() => openai.prepareRequest({ ...request(), thinking: { type: "enabled" } }), { code: "MODEL_CAPABILITY_UNSUPPORTED" });
    const anthropic = createModelClient({ ...config, provider: "anthropic" });
    assert.throws(() => anthropic.prepareRequest({ ...request(), reasoning_effort: "high" }), { code: "MODEL_CAPABILITY_UNSUPPORTED" });
    const disabled = createModelClient({ ...config, capabilityOverrides: { toolCalling: false, streaming: false, reasoningEffort: false } });
    assert.throws(() => disabled.prepareRequest(request()), { code: "MODEL_CAPABILITY_UNSUPPORTED" });
    const prepared = disabled.prepareRequest({ ...request(), tools: [] });
    await assert.rejects(prepared.dispatch({ stream: true }), { code: "MODEL_CAPABILITY_UNSUPPORTED" });
    assert.equal(calls, 0);
  });
});

test("DSH-REF-003 compatibility defaults and unknown reasoning stay usable with explicit provenance", () => {
  const client = createModelClient(config);
  const prepared = client.prepareRequest({ model: config.model, messages: [], reasoning_effort: "high" });
  assert.equal(prepared.request.max_tokens, 4096); assert.equal(prepared.effectiveConfig.sources.maxTokens, "adapter-compatible-default");
  assert.equal(prepared.request.reasoning_effort, "high"); assert.equal(prepared.effectiveConfig.sources.reasoningEffort, "unknown-compatible-pass-through");
  const declared = createModelClient({ ...config, modelMetadata: { reasoningEffort: true, reasoningEffortValues: ["low", "high"] } });
  assert.throws(() => declared.prepareRequest({ ...request(), reasoning_effort: "unavailable" }), { code: "REASONING_EFFORT_INVALID" });
  assert.throws(() => createModelClient({ ...config, protocol: "anthropic-messages" }), { code: "PROVIDER_PROTOCOL_MISMATCH" });
});

test("DSH-REF-003 dispatch is single-use and sends the bound request despite later input/config edits", async () => {
  const local = { ...config }; const client = createModelClient(local); const input = request(); const prepared = client.prepareRequest(input);
  local.baseUrl = "https://different.example.test"; input.model = "different";
  const seen = [];
  await fakeFetch(async (url, options) => { seen.push({ url, body: JSON.parse(options.body) }); return new Response(JSON.stringify(reply()), { status: 200 }); }, async () => {
    await prepared.dispatch();
    await assert.rejects(prepared.dispatch(), { code: "PREPARED_REQUEST_CONSUMED" });
  });
  assert.equal(seen.length, 1); assert.equal(seen[0].url, config.baseUrl + "/chat/completions"); assert.equal(seen[0].body.model, config.model);
  assert.equal(seen[0].body.max_completion_tokens, prepared.effectiveConfig.maxTokens);
  const wrapper = { ...client, routeIdentity: { ...client.routeIdentity, endpointHash: "spoofed-wrapper-metadata", provider: "another-provider" } };
  assert.equal(wrapper.prepareRequest(request()).routeIdentity.endpointHash, endpointFingerprint(config.baseUrl));
  assert.equal(wrapper.prepareRequest(request()).routeIdentity.provider, config.provider);
});

test("DSH-REF-003 prepared dispatch retains outer shared budget and limiter wrappers", async () => {
  let calls = 0; const events = [];
  const ledger = createTaskBudget({ model: config.model, tokenBudget: 2 });
  const client = budgetClient(rateLimitClient(createModelClient(config), createRateLimiter({ maxConcurrent: 1 })), ledger);
  await fakeFetch(async () => { calls += 1; return new Response(JSON.stringify(reply()), { status: 200 }); }, async () => {
    await client.prepareRequest(request()).dispatch({ onRuntimeEvent: (event) => events.push(event) });
    assert.equal(ledger.snapshot().totalTokens, 2);
    await assert.rejects(client.prepareRequest(request()).dispatch(), { code: "token_budget_exceeded" });
  });
  assert.equal(calls, 1); assert.equal(events.filter((event) => event.type === "model-admitted").length, 1);
});

test("DSH-REF-003 streaming preparation also crosses the budget and limiter exactly once", async () => {
  let calls = 0; const content = [];
  const ledger = createTaskBudget({ model: "fake", tokenBudget: 2 });
  const raw = { async chatCompletionStream(input, handlers) { calls += 1; assert.equal(input.max_tokens, 400); handlers.onContent?.("streamed"); return reply(); }, prepareRequest(input, options) { return prepareModelRequest(this, input, config, options); } };
  const client = budgetClient(rateLimitClient(raw, createRateLimiter({ maxConcurrent: 1 })), ledger);
  await client.prepareRequest(request()).dispatch({ stream: true, onContent: (value) => content.push(value) });
  await assert.rejects(client.prepareRequest(request()).dispatch({ stream: true }), { code: "token_budget_exceeded" });
  assert.deepEqual(content, ["streamed"]); assert.equal(calls, 1); assert.equal(ledger.snapshot().totalTokens, 2);
});

test("DSH-REF-003 signals stay live outside frozen request snapshots and stop dispatch before admission", async () => {
  const controller = new AbortController(); let calls = 0;
  const client = { chatCompletion: async () => { calls += 1; return reply(); } };
  const prepared = prepareModelRequest(client, request(), config, { signal: controller.signal });
  controller.abort(new Error("synthetic cancellation"));
  await assert.rejects(prepared.dispatch(), /synthetic cancellation/); assert.equal(calls, 0);
});

test("DSH-REF-003 endpoint identities omit authentication and bind origin/path/model/protocol/schema", () => {
  const route = createRouteIdentity({ config: { ...config, baseUrl: "https://user:password@example.test/v1/?api_key=query-secret#private" }, tools: [tool] });
  const rotated = createRouteIdentity({ config: { ...config, baseUrl: "https://changed:credential@example.test/v1?api_key=rotated" }, tools: [tool] });
  assert.equal(route.hash, rotated.hash); assert.equal(JSON.stringify(route).includes("password"), false); assert.equal(JSON.stringify(route).includes("query-secret"), false);
  const changed = createRouteIdentity({ config: { ...config, baseUrl: "https://example.test/v2" }, tools: [tool] }); assert.notEqual(route.hash, changed.hash);
  assert.equal(schemaFingerprint([{ b: 2, a: 1 }]), schemaFingerprint([{ a: 1, b: 2 }]));
  assert.notEqual(schemaFingerprint([tool]), schemaFingerprint([{ ...tool, description: "new schema" }]));
  const queryRoute = endpointFingerprint("https://example.test/v1/?api-version=2026-01&deployment=one&api_key=secret");
  assert.equal(queryRoute, endpointFingerprint("https://example.test/v1?deployment=one&api-version=2026-01&api_key=rotated"));
  assert.notEqual(queryRoute, endpointFingerprint("https://example.test/v1?deployment=two&api-version=2026-01"));
  assert.notEqual(queryRoute, endpointFingerprint("https://example.test/v1?deployment=one&api-version=2026-02"));
  assert.equal(providerCapabilities({ ...config, baseUrl: "https://example.test/v1?deployment=two", modelMetadata: { baseUrl: "https://example.test/v1?deployment=one", contextWindow: 999999 } }).contextWindowSource, "conservative-fallback");
});

test("DSH-REF-003 checkpoints reject same-model route/schema changes and explicit legacy uncertainty", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-route-checkpoint-"));
  try {
    const tools = { schemas: [tool], getPermissionMode: () => "workspace-write" };
    const options = { cwd, model: config.model, tools, taskSpec: { mayWrite: true }, config };
    const identity = await checkpointIdentity(options);
    const saved = { step: 1, messages: [], metadata: { version: 1, ...identity } };
    assert.equal(validateCheckpoint(saved, identity), saved);
    const swapped = await checkpointIdentity({ ...options, config: { ...config, baseUrl: "https://second.example.test/v1" } });
    assert.throws(() => validateCheckpoint(saved, swapped), { code: "CHECKPOINT_ROUTE_IDENTITY_CHANGED" });
    const changedTools = await checkpointIdentity({ ...options, tools: { ...tools, schemas: [] } });
    assert.throws(() => validateCheckpoint(saved, changedTools), { code: "CHECKPOINT_ROUTE_IDENTITY_CHANGED" });
    const legacy = await checkpointIdentity({ cwd, model: config.model, tools, taskSpec: { mayWrite: true } });
    assert.throws(() => validateCheckpoint({ ...saved, metadata: { version: 1, ...legacy } }, identity), { code: "CHECKPOINT_ROUTE_IDENTITY_MISSING" });
    assert.throws(() => validateCheckpoint(saved, legacy), { code: "CHECKPOINT_ROUTE_IDENTITY_REQUIRED" });
    assert.equal(validateCheckpoint({ ...saved, metadata: { version: 1, ...legacy } }, legacy).step, 1);
    assert.throws(() => validateCheckpoint({ ...saved, metadata: { ...saved.metadata, routeIdentity: { ...identity.routeIdentity, version: 999 } } }, identity), { code: "CHECKPOINT_ROUTE_IDENTITY_CHANGED" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("DSH-REF-003 checkpoint schema identity follows policy visibility and excludes local rendering hooks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-route-tool-schema-"));
  const extension = (name, mutates, render) => ({ schema: { type: "function", function: { name, parameters: { type: "object", properties: {} } } },
    mutates, workerModes: ["research"], execute: async () => ({ ok: true, data: 1 }), toModelContent: render, presentationMeta: () => ({ title: "local" }) });
  try {
    const first = createToolRuntime({ cwd, permissionMode: "workspace-write" });
    first.registerTool(extension("fixture_read", false, () => "render one")); first.setTaskToolPolicy(buildTaskToolPolicy({ mayWrite: false }));
    const identity = await checkpointIdentity({ cwd, model: config.model, tools: first, config, taskSpec: { mayWrite: false } });
    const changed = createToolRuntime({ cwd, permissionMode: "workspace-write" });
    changed.registerTool(extension("fixture_read", false, () => "different render")); changed.registerTool(extension("fixture_write", true, () => "hidden writer"));
    changed.setTaskToolPolicy(buildTaskToolPolicy({ mayWrite: false }));
    const second = await checkpointIdentity({ cwd, model: config.model, tools: changed, config, taskSpec: { mayWrite: false } });
    assert.deepEqual(identity.routeIdentity, second.routeIdentity);
    changed.registerTool(extension("fixture_extra_read", false, () => "visible reader"));
    const third = await checkpointIdentity({ cwd, model: config.model, tools: changed, config, taskSpec: { mayWrite: false } });
    assert.notEqual(identity.routeIdentity.toolsSchemaFingerprint, third.routeIdentity.toolsSchemaFingerprint);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test("DSH-REF-003 mismatched endpoint metadata cannot declare route support and non-JSON requests fail closed", () => {
  assert.equal(providerCapabilities({ ...config, modelMetadata: { baseUrl: "https://another.example.test/v1", contextWindow: 999999, thinking: true } }).contextWindowSource, "conservative-fallback");
  const client = createModelClient(config);
  for (const value of [1n, Infinity, () => "callback"]) assert.throws(() => client.prepareRequest({ ...request(), extra: value }), { code: "REQUEST_NOT_SERIALIZABLE" });
  const circular = request(); circular.self = circular;
  assert.throws(() => client.prepareRequest(circular), { code: "REQUEST_NOT_SERIALIZABLE" });
});
