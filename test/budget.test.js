import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.js";
import { createSubagentRuntime } from "../src/agent/subagents/runtime.js";
import { budgetClient, createTaskBudget } from "../src/harness/budget.js";

const answer = (content, usage) => ({ choices: [{ message: { role: "assistant", content } }], usage });
const toolCall = (name, args, usage) => ({
  choices: [{ message: { role: "assistant", tool_calls: [{ id: name + Math.random(), function: { name, arguments: JSON.stringify(args) } }] } }], usage,
});
const isWorker = (request) => request.messages.some((message) => String(message.content).includes("You are a Deecoo worker agent"));
const config = { model: "test", maxSteps: 5 };

function delegatedTools(client, extraConfig = {}) {
  const runtime = createSubagentRuntime({ client, config: { ...config, ...extraConfig }, cwd: "/synthetic", workerTools: { schemas: [] } });
  return {
    runtime,
    schemas: [],
    execute(name, args, options) {
      return name === "agent" ? runtime.start(args, options) : runtime.send(args, options);
    },
  };
}

test("SCOR-003: worker token usage stops the whole task without another main request", async () => {
  let mainCalls = 0;
  let workerCalls = 0;
  const budget = createTaskBudget({ model: "test", tokenBudget: 100 });
  const client = budgetClient({ async chatCompletion(request) {
    if (isWorker(request)) {
      workerCalls += 1;
      return answer("worker done", { prompt_tokens: 4000, completion_tokens: 1000, total_tokens: 5000 });
    }
    mainCalls += 1;
    return toolCall("agent", { mode: "research", prompt: "inspect" }, { prompt_tokens: 1, total_tokens: 1 });
  } }, budget);
  const tools = delegatedTools(client);
  const result = await runAgent({ client, tools, task: "analyze", cwd: "/synthetic", model: "test", stream: false });
  assert.equal(result.stoppedReason, "token_budget_exceeded");
  assert.equal(result.workflow.status, "failed");
  assert.equal(result.usage.totalTokens, 5001);
  assert.equal(result.agentState.usage.totalTokens, 5001);
  assert.equal(tools.runtime.snapshot()[0].usage.totalTokens, 5000);
  assert.equal(mainCalls, 1);
  assert.equal(workerCalls, 1);
});

test("SCOR-003: worker usage participates in the shared cost budget", async () => {
  const budget = createTaskBudget({ model: "test", costBudgetUsd: 0.001, priceOverrides: { pricePromptPerM: 1, priceCompletionPerM: 1 } });
  const client = budgetClient({ async chatCompletion(request) {
    return isWorker(request)
      ? answer("worker", { prompt_tokens: 4000, completion_tokens: 1000, total_tokens: 5000 })
      : toolCall("agent", { mode: "research", prompt: "inspect" }, { total_tokens: 1 });
  } }, budget);
  const result = await runAgent({ client, tools: delegatedTools(client), task: "analyze", cwd: "/synthetic", model: "test", stream: false });
  assert.equal(result.stoppedReason, "cost_budget_exceeded");
  assert.equal(result.budget.observed, 0.005);
  assert.equal(result.usage.totalTokens, 5001);
});

test("SCOR-003: parallel workers settle after shared exhaustion and only one provider response overshoots", async () => {
  let workerCalls = 0;
  const budget = createTaskBudget({ tokenBudget: 100 });
  const client = budgetClient({ async chatCompletion(request) {
    if (isWorker(request)) {
      workerCalls += 1;
      await delay(10);
      return answer("worker", { total_tokens: 5000 });
    }
    return {
      choices: [{ message: { role: "assistant", tool_calls: ["first", "second"].map((id) => ({
        id, function: { name: "agent", arguments: JSON.stringify({ prompt: "inspect " + id, mode: "research" }) },
      })) } }], usage: { total_tokens: 1 },
    };
  } }, budget);
  const tools = delegatedTools(client);
  const result = await runAgent({ client, tools, task: "analyze", cwd: "/synthetic", model: "test", stream: false });
  assert.equal(result.stoppedReason, "token_budget_exceeded");
  assert.equal(result.usage.totalTokens, 5001);
  assert.equal(workerCalls, 1);
  assert.deepEqual(tools.runtime.snapshot().map((entry) => entry.status), ["stopped", "stopped"]);
});

test("SCOR-003: continuation and checkpoints aggregate each worker call exactly once", async () => {
  let mainCalls = 0;
  let workerId;
  const budget = createTaskBudget({ model: "test" });
  const client = budgetClient({ async chatCompletion(request) {
    if (isWorker(request)) return answer("worker done", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
    mainCalls += 1;
    if (mainCalls === 1) return toolCall("agent", { mode: "research", prompt: "inspect" }, { total_tokens: 1 });
    if (mainCalls === 2) return toolCall("send_message", { to: workerId, message: "continue" }, { total_tokens: 1 });
    return answer("all done", { total_tokens: 1 });
  } }, budget);
  const tools = delegatedTools(client);
  const execute = tools.execute;
  tools.execute = async (...args) => {
    const result = await execute(...args);
    workerId = result.task_id;
    return result;
  };
  const checkpoints = [];
  const result = await runAgent({ client, tools, task: "analyze", cwd: "/synthetic", model: "test", stream: false, onCheckpoint: (value) => checkpoints.push(value) });
  assert.equal(result.workflow.status, "completed");
  assert.equal(result.usage.totalTokens, 11);
  assert.equal(tools.runtime.snapshot()[0].usage.totalTokens, 8);
  assert.deepEqual(checkpoints.map((entry) => entry.usage.totalTokens), [5, 10]);
});

test("SCOR-003: enabled budgets serialize requests; an exhausted queue starts no further calls", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const budget = createTaskBudget({ model: "test", tokenBudget: 5 });
  const client = budgetClient({ async chatCompletion() {
    calls += 1;
    maxActive = Math.max(maxActive, ++active);
    await delay(10);
    active -= 1;
    return answer("done", { total_tokens: 5 });
  } }, budget);
  const settled = await Promise.allSettled([client.chatCompletion({}), client.chatCompletion({})]);
  assert.equal(maxActive, 1);
  assert.equal(calls, 1);
  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled[1].status, "rejected");
  assert.equal(settled[1].reason.code, "token_budget_exceeded");
});

test("SCOR-003: without a budget requests retain parallelism", async () => {
  let active = 0;
  let maxActive = 0;
  const client = budgetClient({ async chatCompletion() {
    maxActive = Math.max(maxActive, ++active);
    await delay(10);
    active -= 1;
    return answer("done", { total_tokens: 2 });
  } }, createTaskBudget());
  await Promise.all([client.chatCompletion({}), client.chatCompletion({})]);
  assert.equal(maxActive, 2);
  assert.equal(client.taskBudget.snapshot().totalTokens, 4);
});

test("SCOR-003: partial failed request usage is recorded once", async () => {
  const budget = createTaskBudget();
  const error = Object.assign(new Error("incomplete response"), { code: "INCOMPLETE_RESPONSE", usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  const client = budgetClient({ async chatCompletion() { throw error; } }, budget);
  const tools = delegatedTools(client);
  await assert.rejects(tools.runtime.start({ prompt: "inspect" }), /incomplete/);
  assert.equal(budget.snapshot().totalTokens, 3);
  assert.equal(tools.runtime.snapshot()[0].usage.totalTokens, 3);
});

test("SCOR-003: standalone runAgent still counts worker results without a shared wrapper", async () => {
  let calls = 0;
  const client = { async chatCompletion() {
    calls += 1;
    return toolCall("agent", { prompt: "inspect" }, { total_tokens: 1 });
  } };
  const result = await runAgent({ client, tools: { schemas: [], async execute() { return { ok: true, usage: { totalTokens: 5000 } }; } }, task: "analyze", cwd: "/synthetic", model: "test", stream: false, tokenBudget: 100 });
  assert.equal(result.stoppedReason, "token_budget_exceeded");
  assert.equal(result.usage.totalTokens, 5001);
  assert.equal(calls, 1);
});

test("SCOR-003: a fresh shared ledger restores checkpoint usage once", async () => {
  const budget = createTaskBudget({ tokenBudget: 100 });
  const client = budgetClient({ async chatCompletion() { return answer("analysis complete", { total_tokens: 1 }); } }, budget);
  const resume = { step: 1, usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 } };
  const result = await runAgent({ client, tools: { schemas: [] }, task: "analyze", cwd: "/synthetic", model: "test", stream: false, resume });
  assert.equal(result.usage.totalTokens, 11);
  assert.equal(result.agentState.usage.totalTokens, 11);
});
