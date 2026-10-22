import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createBenchmarkBudget, runProviderBenchmark, validateBenchmarkOptions, classifyBenchmarkFailure } from "../eval/benchmark.js";

const limits = { maxCalls: 20, tokenBudget: 500000, costBudgetUsd: 10, maxTokens: 128, timeoutMs: 30000, trials: 1 };
const providerOptions = { ...limits, allowPaid: true, provider: "openai", model: "benchmark-test", baseUrl: "https://api.example.test/v1", pricePromptPerM: 1, priceCompletionPerM: 2 };

test("NEXT-006 provider execution is explicit and requires every budget and price bound", () => {
  assert.throws(() => validateBenchmarkOptions(limits), /allow-paid/);
  for (const field of ["maxCalls", "tokenBudget", "costBudgetUsd", "maxTokens", "timeoutMs", "pricePromptPerM", "priceCompletionPerM"]) assert.throws(() => validateBenchmarkOptions({ ...providerOptions, [field]: 0 }), /required/);
  assert.throws(() => validateBenchmarkOptions({ ...providerOptions, baseUrl: "http://example.test" }), /HTTPS/);
  assert.equal(validateBenchmarkOptions({ ...limits, offline: true }).offline, true);
});

test("NEXT-006 budget admission serializes calls and refuses unreserved spend before dispatch", async () => {
  const ledger = createBenchmarkBudget({ ...providerOptions, maxCalls: 1 });
  let calls = 0;
  const client = ledger.wrap({ async chatCompletion(request) { calls += 1; assert.equal(request.max_tokens, 128); return { usage: { prompt_tokens: 10, completion_tokens: 5 } }; } });
  const results = await Promise.allSettled([client.chatCompletion({ max_tokens: 999 }), client.chatCompletion({})]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(calls, 1);
  assert.equal(ledger.snapshot().totalTokens, 15);
  const insufficient = createBenchmarkBudget({ ...providerOptions, tokenBudget: 4 });
  await assert.rejects(insufficient.wrap({ chatCompletion() { assert.fail("No request may be sent"); } }).chatCompletion({}), /budget/);
});

test("NEXT-006 missing provider usage stops later requests and reports unknown spend", async () => {
  let calls = 0;
  const ledger = createBenchmarkBudget(providerOptions);
  const client = ledger.wrap({ async chatCompletion() { calls += 1; return {}; } });
  await assert.rejects(client.chatCompletion({}), /usage missing/);
  await assert.rejects(client.chatCompletion({}), /provider_usage_missing/);
  assert.equal(calls, 1);
});

test("NEXT-006 offline benchmark records reproducible attribution without calling a provider", async () => {
  const definition = JSON.parse(await readFile(new URL("../eval/tasks/review-clean.json", import.meta.url), "utf8"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("Offline evaluation must not make a request");
  try {
    const result = await runProviderBenchmark([definition], { ...limits, offline: true, apiKey: "DO_NOT_REPORT_SECRET" });
    assert.equal(result.evaluationKind, "offline-benchmark-contract");
    assert.equal(result.summary.successRate, 1, JSON.stringify(result.results[0].checks));
    assert.equal(result.summary.actualSpendUsd, 0);
    assert.equal(result.summary.humanInterventions, 0);
    assert.equal(result.attribution.datasetVersion.length, 64);
    assert.equal(result.attribution.harnessVersion.length, 64);
    assert.equal(result.attribution.configVersion.length, 64);
    assert.ok(result.attribution.sourceHashes["src/tools/runtime.js"]);
    assert.ok(result.attribution.sourceHashes["src/execution/backend.js"]);
    assert.equal(JSON.stringify(result).includes("DO_NOT_REPORT_SECRET"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("NEXT-006 real mode contract is exercised only with an injected fake provider", async () => {
  const definition = JSON.parse(await readFile(new URL("../eval/tasks/review-clean.json", import.meta.url), "utf8"));
  let calls = 0;
  const { createScriptedEvalClient } = await import("../eval/execution.js");
  const result = await runProviderBenchmark([definition], providerOptions, { clientFactory(context) { calls += 1; return createScriptedEvalClient(context.caseDefinition.execution.scripted); } });
  assert.equal(calls, 1);
  assert.equal(result.evaluationKind, "provider-benchmark");
  assert.equal(result.summary.successfulTrials, 1);
  assert.ok(result.summary.measuredCostUsd > 0);
  assert.equal(result.config.retryAttempts, 1);
  assert.deepEqual(result.config.sandboxPolicy, { mode: "required", network: "deny" }, "EXECREVIEW-001 real provider tools default to required containment");
  assert.equal(result.budget.calls, 2);
});

test("NEXT-006 failure taxonomy separates dependencies, budgets, permissions and outcomes", () => {
  assert.equal(classifyBenchmarkFailure({ diagnostics: { error: "Cannot find module x" } }), "dependency");
  assert.equal(classifyBenchmarkFailure({ diagnostics: { stoppedReason: "token_budget_exceeded" } }), "budget");
  assert.equal(classifyBenchmarkFailure({ diagnostics: { error: "permission denied" } }), "permission");
  assert.equal(classifyBenchmarkFailure({ checks: [{ name: "command:behavior", passed: false }] }), "outcome");
});

test("EXECREVIEW-002 one budget serializes independent client wrappers before admitting calls", async () => {
  const ledger = createBenchmarkBudget({ ...providerOptions, tokenBudget: 5000 });
  let calls = 0;
  const fake = { async chatCompletion() { calls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { usage: { prompt_tokens: 4000, completion_tokens: 100 } }; } };
  const first = ledger.wrap(fake), second = ledger.wrap(fake);
  const results = await Promise.allSettled([first.chatCompletion({}), second.chatCompletion({})]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
  assert.equal(ledger.snapshot().totalTokens, 4100);
});
