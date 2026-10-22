import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { runTask } from "../src/agent/taskRunner.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { createSessionStore } from "../src/session/store.js";
import { foldRun } from "../src/harness/runProjection.js";
import { listRunOutputs, readRunOutput } from "../src/reporter/outputs.js";
import { createRunTracer } from "../src/harness/tracer.js";

const config = { model: "fixture", stream: false, quiet: true, taskMode: "analysis" };
const answer = (tokens = 1) => ({ choices: [{ message: { role: "assistant", content: "Analysis complete after inspecting the provided evidence." } }], usage: { total_tokens: tokens } });
const call = (name, args = {}, tokens = 1) => ({ choices: [{ message: { role: "assistant", tool_calls: [{ id: randomUUID(), function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: tokens } });
const tool = (name, execute, extra = {}) => ({ schema: { type: "function", function: { name, parameters: { type: "object", properties: {}, additionalProperties: false } } }, mutates: false, execute, ...extra });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(fn, privacyMode = "ephemeral", durableToolEvents = false) {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-dsh-lifetime-"));
  try {
    const store = await createSessionStore(cwd, { rootDir: join(cwd, "state"), privacyMode, durableToolEvents });
    const session = await store.createSession({ model: "fixture" });
    const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
    await fn({ cwd, sessionStore: store, session, tools });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("DSH-REF-005 task plugins wait for async disposal and never leak into the next task", async () => fixture(async ({ cwd, tools, sessionStore, session }) => {
  const closing = deferred(), release = deferred(); const emitter = new EventEmitter();
  let calls = 0, listenerCalls = 0, closed = false, returned = false;
  const running = runTask({ cwd, tools, sessionStore, session, task: "Analyze scoped data", config: { ...config,
    setupPlugins(scope) {
      scope.registerTool(tool("task_metrics", async () => ({ ok: true, data: { answer: 42 } })));
      scope.listen(emitter, "tick", () => { listenerCalls++; });
      scope.own(async () => { closing.resolve(); await release.promise; closed = true; }, { label: "connection" });
    } }, client: { async chatCompletion(request) {
      if (++calls === 1) return call("task_metrics");
      assert.equal(JSON.parse(request.messages.find((message) => message.role === "tool").content).data.answer, 42);
      return answer();
    } } }).then((result) => { returned = true; return result; });
  await closing.promise;
  assert.equal(returned, false); assert.equal(closed, false);
  assert.equal(tools.schemas.some((schema) => schema.function.name === "task_metrics"), false);
  emitter.emit("tick"); assert.equal(listenerCalls, 0);
  release.resolve(); const result = await running;
  assert.equal(result.status, "completed"); assert.equal(closed, true); assert.equal(result.pluginCleanup.ok, true);
  const next = await runTask({ cwd, tools, task: "Analyze the next task", config, client: { async chatCompletion(request) {
    assert.equal(request.tools.some((schema) => schema.function.name === "task_metrics"), false); return answer();
  } } });
  assert.equal(next.status, "completed"); assert.equal(result.contextState.transcript.some((entry) => entry.message.role === "tool"), true);
}));

test("DSH-REF-005 setup failure releases registered resources and filters its diagnostic", async () => fixture(async ({ cwd, tools }) => {
  const secret = "PLUGIN_CREDENTIAL_20261022"; let cleaned = 0, modelCalls = 0;
  const result = await runTask({ cwd, tools, task: "Analyze", config: { ...config, env: { PLUGIN_SECRET: secret }, setupPlugins(scope) {
    scope.registerTool(tool("setup_reader", async () => ({ ok: true })));
    scope.own(async () => { cleaned++; }); throw new Error("Setup failed: " + secret);
  } }, client: { async chatCompletion() { modelCalls++; return answer(); } } });
  assert.equal(result.status, "failed"); assert.equal(cleaned, 1); assert.equal(modelCalls, 0);
  assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(result.pluginCleanup.ok, true);
  assert.equal(tools.schemas.some((schema) => schema.function.name === "setup_reader"), false);
}));

test("DSH-REF-005 cleanup failure is failed in both returned and persisted results", async () => fixture(async ({ cwd, tools, sessionStore, session }) => {
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Analyze project", config: { ...config, setupPlugins(scope) {
    scope.own(async () => { throw new Error("Connection could not close"); }, { label: "connection" });
  } }, client: { async chatCompletion() { return answer(); } } });
  assert.equal(result.status, "failed"); assert.equal(result.workflow.status, "failed"); assert.equal(result.stoppedReason, "PLUGIN_DISPOSE_INCOMPLETE");
  assert.equal(result.pluginCleanup.ok, false); assert.equal(result.acceptance.completionType, "partial");
  const outputs = await listRunOutputs(sessionStore, session);
  const saved = await readRunOutput(sessionStore, session, outputs.find((entry) => entry.fileName.endsWith("run-result.json")).fileName);
  assert.equal(saved.status, "failed"); assert.equal(saved.pluginCleanup.ok, false); assert.ok(await sessionStore.loadCheckpoint(session.id));
}, "standard"));

test("DSH-REF-005 unregister during a settled mutation retains captured effect metadata", async () => fixture(async ({ cwd, tools }) => {
  const scope = tools.createPluginScope(); const started = deferred();
  scope.registerTool(tool("scoped_writer", async (_args, { signal }) => {
    started.resolve(); await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await writeFile(join(cwd, "settled.txt"), "settled"); return { ok: true, data: "committed" };
  }, { mutates: true, toModelContent: () => ({ ok: true, data: "hide cancellation" }) }));
  const pending = tools.execute("scoped_writer"); await started.promise;
  const disposal = scope.dispose(); const result = await pending; assert.equal((await disposal).ok, true);
  assert.equal(result.code, "ABORT_ERR"); assert.equal(result.executionState, "executed"); assert.equal(result.workspaceRevision, 1);
  assert.equal(result.effects.events[0].type, "workspace-uncertain"); assert.equal(await readFile(join(cwd, "settled.txt"), "utf8"), "settled");
  assert.equal((await tools.projectResult("scoped_writer", result)).code, "ABORT_ERR");
}));

test("DSH-REF-005 async approval cannot authorize a replacement registration", async () => fixture(async ({ cwd }) => {
  let oldHandle, replacement, executions = 0;
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => {
    await oldHandle.dispose(); replacement.registerTool(tool("replaceable", async () => { executions++; return { ok: true }; }, { mutates: true })); return true;
  } });
  oldHandle = tools.createPluginScope().registerTool(tool("replaceable", async () => { executions++; return { ok: true }; }, { requiresApproval: true }));
  replacement = tools.createPluginScope();
  const result = await tools.execute("replaceable");
  assert.equal(result.code, "TOOL_REGISTRATION_CHANGED"); assert.equal(result.executionState, "not-started"); assert.equal(executions, 0); assert.equal(result.workspaceRevision, 0);
  tools.setPermissionMode("read-only"); assert.equal((await tools.execute("replaceable")).code, "TOOL_READ_ONLY"); assert.equal(executions, 0);
  await replacement.dispose();
}));

test("DSH-REF-004 durable resume advances past a crash tail without replaying effects or losing usage", async () => fixture(async ({ cwd, tools, sessionStore, session }) => {
  const task = "Analyze project structure";
  const stopped = await runTask({ cwd, tools, sessionStore, session, task, config: { ...config, tokenBudget: 10 }, client: { async chatCompletion() { return answer(10); } } });
  assert.equal(stopped.stoppedReason, "token_budget_exceeded");
  const checkpoint = await sessionStore.loadCheckpoint(session.id); const before = await sessionStore.readToolEvents(session.id);
  assert.equal(checkpoint.runJournal.sequence, before.at(-1).sequence);
  const runId = checkpoint.metadata.runId, taskId = checkpoint.metadata.taskId;
  const tail = { schemaVersion: 1, runId, taskId, eventId: randomUUID(), sequence: checkpoint.runJournal.sequence + 1, type: "tool-start", tool: "crash_observation", invocationId: "unknown-call" };
  await sessionStore.appendToolEvent(session.id, tail);
  await sessionStore.appendToolEvent(session.id, { ...tail, eventId: randomUUID(), sequence: tail.sequence + 1, type: "usage-snapshot", usage: { totalTokens: 25 } });
  const completed = await runTask({ cwd, tools, sessionStore, session, task, resumeCheckpoint: checkpoint, config: { ...config, tokenBudget: 100 }, client: { async chatCompletion() { return answer(); } } });
  assert.equal(completed.status, "completed", JSON.stringify(completed.error)); assert.equal(completed.usage.totalTokens, 26);
  const records = (await sessionStore.readToolEvents(session.id)).filter((event) => event.runId === runId);
  assert.deepEqual(records.map((event) => event.sequence), Array.from({ length: records.length }, (_, index) => index + 1));
  const rebuilt = foldRun(records, { runId, taskId }); assert.deepEqual(rebuilt, completed.runJournal.projection);
  assert.equal(rebuilt.usage.totalTokens, 26); assert.ok(rebuilt.pendingTools["unknown-call"]); assert.equal(completed.events.rebuildable, true);
}, "standard", true));

test("DSH-REF-004 redacted checkpoint resumes filtered source and omits persisted request bodies", async () => fixture(async ({ cwd, tools, sessionStore, session }) => {
  const secret = "NEW_PRIVATE_VALUE_20261022";
  const settings = { ...config, env: { CUSTOM_API_KEY: secret }, tokenBudget: 10 };
  await runTask({ cwd, tools, sessionStore, session, task: "Analyze value " + secret, config: settings, client: { async chatCompletion() { return answer(10); } } });
  const checkpoint = await sessionStore.loadCheckpoint(session.id); assert.equal(JSON.stringify(checkpoint).includes(secret), false);
  assert.equal(checkpoint.contextState.privacyFiltered, true); assert.equal(checkpoint.contextState.sourceCompleteness, "filtered");
  const result = await runTask({ cwd, tools, sessionStore, session, task: checkpoint.metadata.task, resumeCheckpoint: checkpoint,
    config: { ...settings, tokenBudget: 100 }, client: { async chatCompletion() { return answer(); } } });
  assert.equal(result.status, "completed", JSON.stringify(result.error)); assert.equal(result.events.requestSnapshotsComplete, false); assert.equal(result.events.rebuildable, false);
  const records = await sessionStore.readToolEvents(session.id);
  assert.ok(records.some((event) => event.type === "model-attempt-start"));
  for (const event of records.filter((event) => event.type === "model-attempt-start")) { assert.equal(event.request, undefined); assert.equal(event.snapshotOmitted, true); }
  for (const output of (await listRunOutputs(sessionStore, session)).filter((item) => item.fileName.endsWith("run-result.json"))) {
    const saved = await readRunOutput(sessionStore, session, output.fileName);
    for (const event of saved.modelDiagnostics.events.filter((event) => event.type === "model-attempt-start")) assert.equal(event.request, undefined);
  }
}, "redacted", true));

test("DSH-REF-004 checkpoint write failure stops before the next provider call and retains source diagnostics", async () => fixture(async ({ cwd, tools, sessionStore, session }) => {
  await writeFile(join(cwd, "input.txt"), "fixture evidence");
  sessionStore.saveCheckpoint = async () => { throw Object.assign(new Error("Checkpoint disk unavailable"), { code: "EIO" }); };
  let calls = 0;
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Analyze input.txt", config, client: { async chatCompletion() { calls++; return call("read_file", { path: "input.txt" }); } } });
  assert.equal(result.status, "failed"); assert.equal(calls, 1); assert.ok(result.checkpoint.writeFailures >= 1); assert.equal(result.checkpointFailure.code, "EIO");
  assert.ok(result.contextState.transcript.some((entry) => entry.message.role === "tool")); assert.equal(await sessionStore.loadCheckpoint(session.id), undefined);
}));

test("DSH-REF-004 trace bytes are bounded while accounting stays exact", () => {
  const tracer = createRunTracer({ max: 10, maxBytes: 300 });
  tracer.record({ type: "model-call", usage: { total_tokens: 7 }, content: "x".repeat(1000) });
  tracer.record({ type: "model-call", usage: { total_tokens: 3 } });
  assert.equal(tracer.snapshot().totalTokens, 10); assert.equal(tracer.snapshot().modelCalls, 2);
  assert.equal(tracer.snapshot().droppedEvents, 1); assert.ok(tracer.snapshot().retainedBytes <= 300);
});

test("DSH-REF-004 worker source contexts survive parent completion and share secret filtering", async () => fixture(async ({ cwd, tools }) => {
  const secret = "WORKER_PRIVATE_VALUE_20261022"; await writeFile(join(cwd, "input.txt"), secret);
  let main = 0, worker = 0;
  const result = await runTask({ cwd, tools, task: "Analyze input.txt through a research worker", config: { ...config, env: { CUSTOM_API_KEY: secret } }, client: { async chatCompletion(request) {
    const isWorker = request.messages.some((message) => String(message.content).includes("You are a Deecoo worker agent"));
    if (!isWorker) return ++main === 1 ? call("agent", { prompt: "Inspect input.txt", mode: "research" }) : answer();
    if (++worker === 1) return call("read_file", { path: "input.txt" });
    assert.equal(request.messages.find((message) => message.role === "tool").content.includes(secret), false); return answer();
  } } });
  assert.equal(result.status, "completed", JSON.stringify(result.error)); assert.equal(result.workerContexts.length, 1);
  assert.ok(result.workerContexts[0].contextState.transcript.some((entry) => entry.message.role === "tool"));
  assert.equal(JSON.stringify(result.workerContexts).includes(secret), false);
}));

test("DSH-REF-004 ephemeral durable-event preference never claims a disk journal", async () => fixture(async ({ cwd, tools, sessionStore, session }) => {
  const task = "Analyze privacy state";
  const stopped = await runTask({ cwd, tools, sessionStore, session, task, config: { ...config, tokenBudget: 10 }, client: { async chatCompletion() { return answer(10); } } });
  assert.equal(stopped.events.journalComplete, false); assert.equal(stopped.events.rebuildable, false); assert.equal(stopped.events.persistedWatermark, 0);
  assert.deepEqual(await sessionStore.readToolEvents(session.id), []);
  const checkpoint = await sessionStore.loadCheckpoint(session.id);
  const result = await runTask({ cwd, tools, sessionStore, session, task, resumeCheckpoint: checkpoint, config: { ...config, tokenBudget: 100 }, client: { async chatCompletion() { return answer(); } } });
  assert.equal(result.status, "completed"); assert.equal(result.events.journalComplete, false); assert.equal(result.events.rebuildable, false);
  assert.equal(result.events.historyMissing, undefined); assert.equal(result.events.persistedWatermark, 0);
}, "ephemeral", true));

test("DSH-REF-005 setup cleanup failure persists diagnostics and never leaks a secret error code", async () => fixture(async ({ cwd, tools, sessionStore, session }) => {
  const secret = "PLUGIN_CREDENTIAL_CODE_20261022";
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Analyze", config: { ...config, env: { PLUGIN_SECRET: secret }, setupPlugins(scope) {
    scope.own(() => { throw Object.assign(new Error("Dispose " + secret), { code: secret }); });
    throw Object.assign(new Error("Setup " + secret), { code: secret });
  } }, client: { async chatCompletion() { assert.fail("Setup did not complete"); } } });
  assert.equal(result.status, "failed"); assert.equal(result.stoppedReason, "PLUGIN_DISPOSE_INCOMPLETE"); assert.equal(result.failurePhase, "plugin-setup");
  assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(result.error.code, "request_failed");
  const outputs = await listRunOutputs(sessionStore, session); assert.ok(outputs.length);
  const saved = await readRunOutput(sessionStore, session, outputs.find((entry) => entry.fileName.endsWith("run-result.json")).fileName);
  assert.equal(saved.pluginCleanup.ok, false); assert.equal(saved.stoppedReason, "PLUGIN_DISPOSE_INCOMPLETE"); assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal(await sessionStore.loadCheckpoint(session.id), undefined, "setup failure never invents model history or a checkpoint");
}, "standard"));
