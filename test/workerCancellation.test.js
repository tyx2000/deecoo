import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSubagentRuntime } from "../src/agent/subagents/runtime.js";

function runtime({ signal, workerTimeoutMs, tools, onRequest } = {}) {
  return createSubagentRuntime({
    signal, cwd: "/synthetic", config: { model: "test", workerTimeoutMs },
    workerTools: tools ?? { schemas: [], async execute() { throw new Error("unexpected tool execution"); } },
    client: { async chatCompletion(request, options = {}) {
      onRequest?.(request, options);
      await delay(60, undefined, { signal: options.signal });
      return { choices: [{ message: { role: "assistant", content: "done" } }] };
    } },
  });
}

test("SCOR-002: a per-dispatch abort reaches the worker model", async () => {
  const controller = new AbortController();
  let receivedSignal;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const workers = runtime({ onRequest: (_request, options) => { receivedSignal = options.signal; started(); } });
  const pending = workers.start({ mode: "implement", prompt: "inspect" }, { signal: controller.signal });
  await ready;
  controller.abort(new Error("task deadline reached"));
  await assert.rejects(pending, /abort|deadline/i);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(workers.snapshot()[0].status, "stopped");
});

test("SCOR-002: parent cancellation is retained when a dispatch also has a signal", async () => {
  const parent = new AbortController();
  const call = new AbortController();
  const workers = runtime({ signal: parent.signal });
  const pending = workers.start({ prompt: "inspect" }, { signal: call.signal });
  parent.abort(new Error("parent stopped"));
  await assert.rejects(pending, /abort|stopped/i);
  assert.equal(workers.snapshot()[0].status, "stopped");
});

test("SCOR-002: a model ignoring cancellation cannot execute a later tool", async () => {
  const controller = new AbortController();
  let writes = 0;
  const workers = createSubagentRuntime({
    cwd: "/synthetic", config: { model: "test" },
    workerTools: { schemas: [], async execute() { writes += 1; return { ok: true }; } },
    client: { async chatCompletion() {
      await delay(20);
      return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "write", function: { name: "write_file", arguments: "{}" } }] } }] };
    } },
  });
  const pending = workers.start({ mode: "implement", prompt: "write" }, { signal: controller.signal });
  controller.abort(new Error("deadline"));
  await assert.rejects(pending, /deadline/);
  assert.equal(writes, 0);
});

test("SCOR-002: own worker timeout still returns WORKER_TIMEOUT", async () => {
  const result = await runtime({ workerTimeoutMs: 5 }).start({ prompt: "inspect" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_TIMEOUT");
});

test("SCOR-002: a worker completing before its deadline remains successful", async () => {
  const result = await runtime({ workerTimeoutMs: 1000 }).start({ prompt: "inspect" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
});
