import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runTask } from "../src/agent/taskRunner.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const isWorker = (request) => request.messages.some((message) => String(message.content).includes("You are a Deecoo worker agent"));
const response = (name, args, usage = { total_tokens: 1 }) => ({
  choices: [{ message: { role: "assistant", tool_calls: [{ id: name, function: { name, arguments: JSON.stringify(args) } }] } }], usage,
});
const initial = () => response("agent", { mode: "implement", prompt: "inspect synthetic data" });
const write = (usage) => response("write_file", { path: "worker-result.txt", content: "synthetic" }, usage);

async function fixture(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-task-budget-"));
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  try {
    await fn({ cwd, tools });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("SCOR-002 integration: runTask cancellation reaches a real tool runtime worker before write_file", async () => {
  await fixture(async ({ cwd, tools }) => {
    let workerCalls = 0;
    let mainCalls = 0;
    const controller = new AbortController();
    const client = { async chatCompletion(request, { signal } = {}) {
      if (!isWorker(request)) {
        mainCalls += 1;
        return initial();
      }
      workerCalls += 1;
      controller.abort(new Error("synthetic task cancellation"));
      await delay(300, undefined, { signal });
      return write();
    } };
    const result = await runTask({ client, tools, task: "Create worker-result.txt with synthetic data", cwd, signal: controller.signal, config: { model: "test", stream: false, maxSteps: 5 } });
    assert.equal(workerCalls, 1);
    assert.equal(mainCalls, 1);
    assert.equal(result.status, "interrupted");
    assert.equal(result.stoppedReason, "interrupted");
    await assert.rejects(stat(join(cwd, "worker-result.txt")), { code: "ENOENT" });
  });
});

test("SCOR-003 integration: runTask accounts worker usage and prevents the real write tool after exhaustion", async () => {
  await fixture(async ({ cwd, tools }) => {
    let mainCalls = 0;
    const client = { async chatCompletion(request) {
      if (!isWorker(request)) {
        mainCalls += 1;
        return initial();
      }
      return write({ prompt_tokens: 4000, completion_tokens: 1000, total_tokens: 5000 });
    } };
    const result = await runTask({ client, tools, task: "Create worker-result.txt with synthetic data", cwd, config: { model: "test", stream: false, maxSteps: 5, tokenBudget: 100 } });
    assert.equal(result.status, "failed");
    assert.equal(result.stoppedReason, "token_budget_exceeded");
    assert.equal(result.usage.totalTokens, 5001);
    assert.equal(result.agentState.usage.totalTokens, 5001);
    assert.equal(mainCalls, 1);
    await assert.rejects(stat(join(cwd, "worker-result.txt")), { code: "ENOENT" });
  });
});

test("SCOR-003 integration: below the budget, a permitted Worker writes and main totals include its usage", async () => {
  await fixture(async ({ cwd, tools }) => {
    let mainCalls = 0;
    let workerCalls = 0;
    const client = { async chatCompletion(request) {
      if (!isWorker(request)) {
        mainCalls += 1;
        if (mainCalls === 1) return initial();
        return { choices: [{ message: { role: "assistant", content: "Implemented worker-result.txt with synthetic data. Tests not run because this fixture has no test command." } }], usage: { total_tokens: 1 } };
      }
      workerCalls += 1;
      if (workerCalls === 1) return write({ total_tokens: 3 });
      return { choices: [{ message: { role: "assistant", content: "Synthetic file written." } }], usage: { total_tokens: 2 } };
    } };
    const result = await runTask({ client, tools, task: "Create worker-result.txt with synthetic data", cwd, config: { model: "test", stream: false, maxSteps: 5, tokenBudget: 100 } });
    assert.equal(result.status, "completed");
    assert.equal(result.usage.totalTokens, 7);
    assert.equal(await readFile(join(cwd, "worker-result.txt"), "utf8"), "synthetic");
  });
});
