import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/agent/taskRunner.js";
import { createExecutionBackend } from "../src/execution/backend.js";
import { createAnthropicClient } from "../src/llm/anthropicClient.js";
import { createDeepSeekClient } from "../src/llm/deepseekClient.js";
import { createSessionStore } from "../src/session/store.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const call = (id, name, args) => ({ choices: [{ message: { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] } }], usage: { total_tokens: 1 } });
const answer = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 1 } });

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "deecoo-steps-")));
  const previousHome = process.env.DEECOO_HOME;
  process.env.DEECOO_HOME = join(cwd, ".home");
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DEECOO_HOME; else process.env.DEECOO_HOME = previousHome;
    await rm(cwd, { recursive: true, force: true });
  });
  const sessionStore = await createSessionStore(cwd);
  const session = await sessionStore.createSession({ model: "test" });
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => "approve",
    executionBackend: createExecutionBackend({ cwd, stateDir: join(cwd, ".jobs"), sandboxPolicy: { mode: "off" } }) });
  return { cwd, sessionStore, session, tools };
}

// A client that reads a new file on every call, so only the step budget can stop it.
function readingClient(onCall = () => {}) {
  let calls = 0;
  return { get calls() { return calls; }, async chatCompletion() { calls += 1; onCall(calls); return call("read-" + calls, "read_file", { path: "f.js", startLine: calls, endLine: calls }); } };
}

test("STEPS-001 the step budget counts from the resume point, so /continue gets a full budget", async (t) => {
  const { cwd, sessionStore, session, tools } = await fixture(t);
  await writeFile(join(cwd, "f.js"), Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") + "\n");
  const config = { model: "test", quiet: true, stream: false, maxSteps: 3 };
  const reading = readingClient();
  const stopped = await runTask({ cwd, tools, sessionStore, session, task: "Read f.js.", config, client: reading });
  assert.equal(stopped.stoppedReason, "step_budget_exceeded");
  assert.equal(reading.calls, 3);
  assert.match(stopped.finalText, /Use \/continue to run another 3 steps/);
  const checkpoint = await sessionStore.loadCheckpoint(session.id);
  const resumed = readingClient();
  const continued = await runTask({ cwd, tools, sessionStore, session, task: "Read f.js.", config, client: resumed, resumeCheckpoint: checkpoint });
  assert.equal(resumed.calls, 3, "the continued run had its own 3-step budget");
  assert.equal(continued.stoppedReason, "step_budget_exceeded");
  assert.equal(continued.budget.observed, 3);
});

test("STEPS-002 an interactive run asks at the limit and continues while approved; without a confirm hook it stops", async (t) => {
  const { cwd, sessionStore, session, tools } = await fixture(t);
  await writeFile(join(cwd, "f.js"), Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") + "\n");
  const asked = [];
  const reading = readingClient();
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Read f.js.", client: reading,
    config: { model: "test", quiet: true, stream: false, maxSteps: 2, confirmStepBudget: async ({ stepsThisRun, limit }) => { asked.push([stepsThisRun, limit]); return asked.length === 1; } } });
  assert.deepEqual(asked, [[2, 2], [4, 2]]);
  assert.equal(reading.calls, 4);
  assert.equal(result.stoppedReason, "step_budget_exceeded");
  const scripted = readingClient();
  const hardStop = await runTask({ cwd, tools, sessionStore, session, task: "Read f.js.", client: scripted, config: { model: "test", quiet: true, stream: false, maxSteps: 2 } });
  assert.equal(scripted.calls, 2);
  assert.equal(hardStop.stoppedReason, "step_budget_exceeded");
});

test("STEPS-003 rerunning the same failing command, alone or with an unchanged re-read, stops as no_progress", async (t) => {
  const { cwd, sessionStore, session, tools } = await fixture(t);
  await writeFile(join(cwd, "a.txt"), "unchanged\n");
  for (const pattern of [["run_shell"], ["run_shell", "read_file"]]) {
    let calls = 0;
    const result = await runTask({ cwd, tools, sessionStore, session, task: "Make the check pass.", config: { model: "test", quiet: true, stream: false, maxSteps: 40 },
      client: { async chatCompletion() {
        const name = pattern[calls % pattern.length]; calls += 1;
        return name === "run_shell" ? call("c" + calls, "run_shell", { command: "test -f missing.txt" }) : call("c" + calls, "read_file", { path: "a.txt" });
      } } });
    assert.equal(result.stoppedReason, "no_progress", pattern.join("+"));
    assert.ok(calls <= 4 + 2 * pattern.length, `${pattern.join("+")} stopped after ${calls} model calls`);
  }
});

test("STEPS-004 tool calls with unusable arguments count as no progress", async (t) => {
  const { cwd, sessionStore, session, tools } = await fixture(t);
  let calls = 0;
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Write the report.", config: { model: "test", quiet: true, stream: false, maxSteps: 40 },
    client: { async chatCompletion() { calls += 1; return call("w" + calls, "write_file", '{"path":"report.md","content":"cut off'); } } });
  assert.equal(result.stoppedReason, "no_progress");
  assert.ok(calls <= 5, `stopped after ${calls} model calls`);
});

test("STEPS-005 a failing check rerun after each file change is progress, not a repeat", async (t) => {
  const { cwd, sessionStore, session, tools } = await fixture(t);
  const script = [
    ["run_shell", { command: "test -f done.txt" }], ["write_file", { path: "attempt1.txt", content: "1\n" }],
    ["run_shell", { command: "test -f done.txt" }], ["write_file", { path: "attempt2.txt", content: "2\n" }],
    ["run_shell", { command: "test -f done.txt" }], ["write_file", { path: "attempt3.txt", content: "3\n" }],
    ["run_shell", { command: "test -f done.txt" }], ["write_file", { path: "done.txt", content: "done\n" }],
    ["run_shell", { command: "test -f done.txt" }],
  ];
  let calls = 0;
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Create done.txt and check it.", config: { model: "test", quiet: true, stream: false, maxSteps: 40 },
    client: { async chatCompletion() { const next = script[calls]; calls += 1; return next ? call("s" + calls, ...next) : answer("done.txt exists and the check passes."); } } });
  assert.notEqual(result.stoppedReason, "no_progress");
  // Every scripted step ran; later calls are final-answer validation repairs, not tool repeats.
  assert.ok(calls > script.length, `ran ${calls} model calls for ${script.length} scripted steps`);
});

test("STEPS-006 non-streaming responses cut off inside a tool call fail clearly instead of reaching the tools", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const reply = (body) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); };
  const config = { baseUrl: "https://provider.invalid", apiKey: "synthetic", timeoutMs: 1000, retryAttempts: 1 };
  const deepseek = createDeepSeekClient(config);
  reply({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "w", type: "function", function: { name: "write_file", arguments: '{"path":"a","content":"abc' } }] }, finish_reason: "length" }], usage: { completion_tokens: 4096 } });
  await assert.rejects(deepseek.chatCompletion({ model: "m", messages: [] }), (error) => error.code === "INCOMPLETE_RESPONSE" && /DEECOO_MAX_TOKENS/.test(error.message) && error.usage?.completion_tokens === 4096);
  reply({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "r", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] }, finish_reason: "tool_calls" }] });
  assert.equal((await deepseek.chatCompletion({ model: "m", messages: [] })).choices[0].message.tool_calls[0].id, "r");
  const anthropic = createAnthropicClient(config);
  reply({ content: [{ type: "tool_use", id: "t", name: "write_file", input: { path: "a" } }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 4096 } });
  await assert.rejects(anthropic.chatCompletion({ model: "m", messages: [{ role: "user", content: "x" }] }), { code: "INCOMPLETE_RESPONSE" });
  reply({ content: [{ type: "tool_use", id: "t", name: "read_file", input: { path: "a" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 5 } });
  assert.equal((await anthropic.chatCompletion({ model: "m", messages: [{ role: "user", content: "x" }] })).choices[0].message.tool_calls[0].id, "t");
});
