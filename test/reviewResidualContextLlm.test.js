import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { compactLiveMessages } from "../src/agent/loop.js";
import { createAgentState, recordToolStep } from "../src/agent/state.js";
import { runTask } from "../src/agent/taskRunner.js";
import { createTaskBudget } from "../src/harness/budget.js";
import { estimateCostUsd, isModelPriceKnown, resolveModelPrice } from "../src/harness/cost.js";
import { createModelClient } from "../src/llm/clientFactory.js";
import { createRateLimiter, rateLimitClient } from "../src/llm/rateLimiter.js";
import { withRetries } from "../src/llm/retry.js";
import { createToolOutputStore } from "../src/storage/toolOutputs.js";
import { compactToolResult } from "../src/tools/projection.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const config = { provider: "deepseek", model: "synthetic-model", apiKey: "synthetic-fixture", baseUrl: "https://no-network.invalid", retryAttempts: 2, timeoutMs: 1000 };
const request = (id) => ({ model: config.model, messages: [{ role: "user", content: id }], max_tokens: 128 });
async function scratch(t) { const cwd = await mkdtemp(join(tmpdir(), "deecoo-review-residual-")); t.after(() => rm(cwd, { recursive: true, force: true })); return cwd; }
async function fakeFetch(t, fn) { const original = globalThis.fetch; globalThis.fetch = fn; t.after(() => { globalThis.fetch = original; }); }
function successfulResponse(provider, stream) {
  if (provider === "anthropic") {
    if (!stream) return new Response(JSON.stringify({ id: "fixture", type: "message", role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","role":"assistant","content":[],"usage":{"input_tokens":1}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  }
  const value = { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  if (!stream) return new Response(JSON.stringify(value));
  return new Response('data: {"choices":[{"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
}

function compactionFixture() {
  const messages = [{ role: "system", content: "system" }, { role: "user", content: "task" }];
  const state = createAgentState({ task: "task", cwd: "/synthetic" });
  let step = 0;
  const add = (name, args, result) => {
    const id = "call" + ++step;
    recordToolStep(state, { step, name, args, result, startedAt: 0, endedAt: 0 });
    messages.push({ role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: id, content: JSON.stringify(result) });
  };
  add("run_shell", { command: "npm test" }, { ok: false, stderr: "REQUIRED_FAILURE_DIAGNOSTIC: expected 2, received 1 " + "e".repeat(600) });
  for (let i = 0; i < 12; i++) add("read_file", { path: "a" + i + ".js" }, { ok: true, content: "x".repeat(4000) });
  return { messages, state, add };
}

for (const maxChars of [2500, 1000]) test(`C-2 failure command and diagnostic survive compaction at ${maxChars} chars and repeated compaction`, () => {
  const { messages, state, add } = compactionFixture();
  for (let round = 0; round < 2; round++) {
    assert.equal(compactLiveMessages(messages, { protectedPrefixCount: 2, maxChars, agentState: state }), true);
    const summaries = messages.filter((m) => m.role === "user" && m.content.includes('source="context-compaction"'));
    assert.equal(summaries.length, 1);
    assert.match(summaries[0].content, /npm test failed: REQUIRED_FAILURE_DIAGNOSTIC: expected 2, received 1/);
    if (maxChars === 2500) assert.match(summaries[0].content, /Task summary:/, "exercise the full candidate");
    else assert.doesNotMatch(summaries[0].content, /Task summary:/, "exercise the compact candidate");
    assert.ok(summaries[0].content.length < maxChars);
    for (let i = 0; i < 12; i++) add("read_file", { path: "again" + i + ".js" }, { ok: true, content: "x".repeat(4000) });
  }
});

for (const provider of ["deepseek", "anthropic"]) for (const stream of [false, true]) test(`DS-CHECK-RETRY-001 ${provider} ${stream ? "stream" : "JSON"} 429 cools new callers even when internal retry succeeds`, async (t) => {
  const limiter = createRateLimiter({ maxConcurrent: 2 });
  const client = rateLimitClient(createModelClient({ ...config, provider }), limiter);
  const notified = deferred(); const starts = [];
  let retryCooldown;
  await fakeFetch(t, async (_url, options) => {
    const body = JSON.parse(options.body), id = body.messages[0].content;
    starts.push({ id, time: Date.now() });
    if (starts.length === 1) return new Response("limited", { status: 429, headers: { "retry-after": "0.08" } });
    return successfulResponse(provider, stream);
  });
  const call = (id, options) => stream ? client.chatCompletionStream(request(id), options) : client.chatCompletion(request(id), options);
  const first = call("first", { onRuntimeEvent(event) { if (event.type === "model-retry") { retryCooldown = limiter.stats().cooldownUntil; notified.resolve(); } } });
  await notified.promise;
  await Promise.all([first, call("second")]);
  assert.ok(retryCooldown > starts[0].time, "the internally handled 429 must update shared cooldown immediately");
  assert.equal(starts.length, 3);
  for (const start of starts.slice(1)) assert.ok(start.time >= retryCooldown, `${start.id} dispatched before cooldown expired`);
});

test("DS-CHECK-RETRY-001 an already admitted retry respects a later caller's longer cooldown", async (t) => {
  const limiter = createRateLimiter({ maxConcurrent: 2 });
  const client = rateLimitClient(createModelClient(config), limiter);
  const bStarted = deferred(); const counts = new Map(); const starts = [];
  let extendedUntil = 0;
  await fakeFetch(t, async (_url, options) => {
    const id = JSON.parse(options.body).messages[0].content;
    const count = (counts.get(id) ?? 0) + 1; counts.set(id, count);
    starts.push({ id, count, time: Date.now() });
    if (count > 1) return successfulResponse("deepseek", false);
    if (id === "a") { await bStarted.promise; return new Response("limited a", { status: 429, headers: { "retry-after": "0.04" } }); }
    bStarted.resolve(); await delay(10);
    return new Response("limited b", { status: 429, headers: { "retry-after": "0.12" } });
  });
  await Promise.all([client.chatCompletion(request("a")), client.chatCompletion(request("b"), { onRuntimeEvent(event) { if (event.type === "model-retry") extendedUntil = limiter.stats().cooldownUntil; } })]);
  assert.ok(extendedUntil > 0);
  for (const start of starts.filter((s) => s.count === 2)) assert.ok(start.time >= extendedUntil, `${start.id} retried before the extended cooldown`);
});

test("DS-CHECK-RETRY-001 exhausted 429 attempts each notify the limiter and leave a shared cooldown", async () => {
  const errors = [], limiter = createRateLimiter({ maxConcurrent: 2 });
  let attempts = 0;
  const error = await limiter.run(() => withRetries({ attempts: 2, timeoutMs: 500, onAttemptError(error) { errors.push(error); limiter.noteRateLimit(error.retryAfterMs); } }, async () => {
    attempts++; throw Object.assign(new Error("limited"), { status: 429, retryAfterMs: 15 });
  })).catch((caught) => caught);
  assert.equal(attempts, 2); assert.equal(error.attempts, 2);
  assert.equal(errors.length, 2, "notify on the final failed attempt too");
  assert.ok(limiter.stats().cooldownUntil > Date.now());
});

test("DS-CHECK-RETRY-001 cancellation interrupts both retry sleep and queued shared cooldown", async () => {
  const retryAbort = new AbortController(), retried = deferred(); let attempts = 0;
  const pending = withRetries({ attempts: 2, timeoutMs: 2000, signal: retryAbort.signal, onRuntimeEvent() { retried.resolve(); } }, async () => {
    attempts++; throw Object.assign(new Error("limited"), { status: 429, retryAfterMs: 300 });
  }).catch((error) => error);
  await retried.promise; retryAbort.abort(new Error("stop retry"));
  const retriedPromptly = await Promise.race([pending.then(() => true), delay(70, false)]);
  await pending;
  assert.equal(retriedPromptly, true); assert.equal(attempts, 1);
  const limiter = createRateLimiter(); limiter.noteRateLimit(300);
  const queueAbort = new AbortController(); let dispatched = false;
  const queued = limiter.run(() => { dispatched = true; }, { signal: queueAbort.signal }).catch((error) => error);
  queueAbort.abort(new Error("stop queued"));
  const canceledPromptly = await Promise.race([queued.then(() => true), delay(70, false)]);
  await queued;
  assert.equal(canceledPromptly, true); assert.equal(dispatched, false); assert.equal(limiter.stats().queued, 0);
});

test("DS-CHECK-COST-001 unknown pricing requires both explicit sides and known prices retain the other side", () => {
  for (const overrides of [{ pricePromptPerM: 1 }, { priceCompletionPerM: 1 }]) assert.equal(isModelPriceKnown("unknown", overrides), false);
  assert.equal(isModelPriceKnown("unknown", { pricePromptPerM: 0, priceCompletionPerM: 0 }), true);
  assert.equal(isModelPriceKnown("unknown", { pricePromptPerM: 1, priceCompletionPerM: 2 }), true);
  assert.deepEqual(resolveModelPrice("deepseek-v4-pro", { pricePromptPerM: 1 }), { prompt: 1, completion: 0.42 });
  assert.deepEqual(resolveModelPrice("deepseek-v4-pro", { priceCompletionPerM: 0 }), { prompt: 0.28, completion: 0 });
  assert.equal(estimateCostUsd({ completionTokens: 1_000_000 }, "deepseek-v4-pro", { pricePromptPerM: 1 }), 0.42);
  const ledger = createTaskBudget({ model: "deepseek-v4-pro", costBudgetUsd: 0.01, priceOverrides: { pricePromptPerM: 1 } });
  ledger.record({ completionTokens: 1_000_000 }); assert.equal(ledger.stopped().reason, "cost_budget_exceeded");
});

test("DS-CHECK-COST-001 task dispatch refuses either missing unknown-price side before calling a model", async (t) => {
  const cwd = await scratch(t); let calls = 0;
  for (const overrides of [{ pricePromptPerM: 1 }, { priceCompletionPerM: 1 }]) {
    const tools = createToolRuntime({ cwd, permissionMode: "workspace-write" });
    const result = await runTask({ cwd, tools, task: "Analyze this project.", config: { model: "unknown", quiet: true, stream: false, privacyMode: "ephemeral", costBudgetUsd: 0.01, ...overrides },
      client: { async chatCompletion() { calls++; return { choices: [{ message: { role: "assistant", content: "done" } }] }; } } });
    assert.equal(result.status, "failed"); assert.equal(result.error.code, "COST_BUDGET_UNPRICED");
  }
  assert.equal(calls, 0);
});

test("N-2 compatibility array cuts always mark incomplete while truncate:false keeps every element", () => {
  const matches = Array.from({ length: 85 }, (_, i) => "match" + i);
  for (const extra of [{ sourceComplete: true }, {}]) {
    const input = { ok: true, ...extra, matches };
    const compact = compactToolResult("search_text", input);
    assert.equal(compact.matches.length, 80); assert.equal(compact.truncated, true); assert.equal(compact.sourceComplete, false);
    assert.deepEqual(compact.omittedItems, { matches: 5 });
    const full = compactToolResult("search_text", input, { truncate: false });
    assert.equal(full.matches.length, 85); assert.equal(full.sourceComplete, extra.sourceComplete); assert.equal(full.truncated, undefined);
    assert.equal(input.matches.length, 85); assert.equal(input.sourceComplete, extra.sourceComplete);
  }
});

test("N-2 runtime retains uncut searches and byte-spilled read output remains retrievable", async (t) => {
  const cwd = await scratch(t), owner = { sessionId: "fixture-session", runId: "fixture-run" };
  const outputStore = await createToolOutputStore({ owner, privacyMode: "ephemeral" }); t.after(() => outputStore.dispose());
  const runtime = createToolRuntime({ cwd, permissionMode: "workspace-write" }); runtime.setOutputStore(outputStore, { owner });
  await writeFile(join(cwd, "search.js"), Array.from({ length: 85 }, (_, i) => "needle_" + i).join("\n"));
  const raw = await runtime.execute("search_text", { query: "needle_", maxResults: 100 });
  const projected = await runtime.projectResult("search_text", raw);
  assert.equal(raw.matches.length, 85); assert.equal(projected.matches.length, 85);
  await writeFile(join(cwd, "large.js"), "x".repeat(60000));
  const large = await runtime.execute("read_file", { path: "large.js", maxBytes: 100000 });
  const bounded = await runtime.projectResult("read_file", large);
  assert.equal(bounded.sourceComplete, false); assert.equal(bounded.truncated, true); assert.ok(bounded.outputRef);
  const page = await runtime.execute("read_output", { outputRef: bounded.outputRef, offset: 0, maxBytes: 1024 });
  assert.equal(page.ok, true); assert.match(page.text, /"content":"x+/);
});
