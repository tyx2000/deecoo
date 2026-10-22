import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createToolRuntime } from "../src/tools/runtime.js";
import { createChangeSet, listChangeSets } from "../src/workspace/changes.js";
import { createRuntimeContext } from "../src/harness/runtimeContext.js";
import { createRunEventStream } from "../src/harness/events.js";
import { compactLiveMessages, compactToolResult } from "../src/agent/loop.js";
import { runTask } from "../src/agent/taskRunner.js";
import { createScriptedEvalClient } from "../eval/execution.js";
import { createSessionStore } from "../src/session/store.js";
import { providerCapabilities } from "../src/llm/capabilities.js";
const definition = (execute, options = {}) => ({ schema: { type: "function", function: { name: "fixture_tool", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } }, mutates: false, workerModes: ["research"], execute, ...options });
async function fixture(fn) { const cwd = await mkdtemp(join(tmpdir(), "deecoo-extension-")); try { await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); } }

test("registry extension schema, task permissions and worker metadata share dispatch", async () => fixture(async (cwd) => {
  let calls = 0; const tools = createToolRuntime({ cwd, permissionMode: "read-only", prompter: async () => true });
  tools.registerTool(definition(async () => { calls++; return "source"; }));
  assert.equal(tools.workerSchemas.some((schema) => schema.function.name === "fixture_tool"), true);
  assert.equal((await tools.execute("fixture_tool", { value: 1 })).code, "TOOL_INVALID_ARGUMENTS");
  assert.equal((await tools.createWorkerTools().execute("fixture_tool", { value: "ok" })).content, "source");
  assert.equal(calls, 1);
  assert.throws(() => tools.registerTool(definition(async () => "duplicate")), /already registered/);
  const writing = createToolRuntime({ cwd, permissionMode: "read-only", prompter: async () => true });
  writing.registerTool(definition(async () => { throw new Error("must not run"); }, { mutates: true }));
  assert.equal(writing.schemas.some((schema) => schema.function.name === "fixture_tool"), false);
  assert.equal((await writing.execute("fixture_tool", { value: "ok" })).code, "TOOL_READ_ONLY");
}));

test("extension timeout settles before end and conservatively invalidates verification", async () => fixture(async (cwd) => {
  const events = []; const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  const context = await createRuntimeContext({ cwd, env: { X: "old", DROP: "secret" }, overlay: { X: "new", DROP: undefined } });
  assert.deepEqual(context.env, { X: "new" }); tools.setRuntimeContext(context); tools.setEventSink((event) => events.push(event));
  let settled = false;
  tools.registerTool(definition(async (_args, { signal }) => { try { await delay(1000, undefined, { signal }); } finally { settled = true; } }, { mutates: true, workerModes: ["implement"], timeoutMs: 15 }));
  const result = await tools.execute("fixture_tool", { value: "ok" });
  assert.equal(settled, true); assert.equal(result.ok, false); assert.equal(tools.getWorkspaceRevision(), 1);
  assert.deepEqual(events.map((event) => event.type), ["tool-start", "tool-end"]);
  assert.equal(events[0].invocationId, events[1].invocationId); assert.equal(events[0].runId, context.runId);
}));

test("binary task changes restore bytes, reject drift and list durable manifests", async () => fixture(async (cwd) => {
  const before = Buffer.from([0, 255, 3]); await writeFile(join(cwd, "image.bin"), before);
  const changes = await createChangeSet({ cwd }); await changes.begin();
  await writeFile(join(cwd, "image.bin"), Buffer.from([0, 11])); await changes.capture();
  assert.equal((await changes.decide({ action: "undo" })).ok, true); assert.deepEqual(await readFile(join(cwd, "image.bin")), before);
  assert.equal((await listChangeSets({ cwd }))[0].id, changes.id);
}));

test("run event streams redact and preserve sequence across asynchronous durable writes", async () => {
  const records = []; const stream = createRunEventStream({ runId: "r", taskId: "t", secretRegistry: { redact: (value) => value.replaceAll("secret", "[REDACTED]") }, persist: async (event) => { await delay(2); records.push(event); } });
  stream.emit({ type: "tool-start", content: "secret" }); stream.emit({ type: "tool-end" }); await stream.flush();
  assert.deepEqual(records.map((event) => event.sequence), [1, 2]); assert.equal(records[0].content, "[REDACTED]"); assert.notEqual(records[0].eventId, records[1].eventId);
});

test("small model window fails before provider invocation and preserves task rules", async () => fixture(async (cwd) => {
  let calls = 0;
  const result = await runTask({ cwd, task: "Analyze source. " + "约束".repeat(3000), tools: createToolRuntime({ cwd, prompter: async () => false }), client: { chatCompletion: async () => { calls++; throw new Error("unexpected provider call"); } }, config: { quiet: true, model: "fixture", contextWindow: 2048, outputReserve: 512, taskMode: "analysis" } });
  assert.equal(result.status, "failed"); assert.equal(result.stoppedReason, "CONTEXT_BUDGET_EXCEEDED"); assert.equal(calls, 0);
  assert.equal(providerCapabilities({ provider: "openai", model: "unknown" }).contextWindowSource, "conservative-fallback");
}));

test("extension approval requires an explicit positive decision", async () => fixture(async (cwd) => {
  let ran = false; const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => undefined });
  tools.registerTool(definition(async () => { ran = true; return "bad"; }, { mutates: true, requiresApproval: true }));
  assert.equal((await tools.execute("fixture_tool", { value: "ok" })).code, "TOOL_APPROVAL_DENIED"); assert.equal(ran, false);
}));

test("nearby selected hunks validate against a stable original snapshot", async () => fixture(async (cwd) => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n";
  await writeFile(join(cwd, "a.txt"), before); const changes = await createChangeSet({ cwd }); await changes.begin();
  await writeFile(join(cwd, "a.txt"), before.replace("a\n", "A\n").replace("c\n", "C\n").replace("k\n", "K\n")); await changes.capture();
  const hunks = (await changes.inspect()).files[0].hunks;
  assert.equal((await changes.decide({ action: "accept", path: "a.txt", hunkIds: hunks.slice(0, 2).map((hunk) => hunk.id) })).ok, true);
  assert.equal((await changes.inspect()).files[0].hunks.length, 1);
  assert.equal((await changes.decide({ action: "undo" })).ok, true);
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), before.replace("a\n", "A\n").replace("c\n", "C\n"));
}));

test("compaction reports partial source and never leaves orphan tool calls", () => {
  const raw = { content: "x".repeat(40000), sourceComplete: true, truncated: false };
  const shown = compactToolResult("read_file", raw);
  assert.equal(shown.sourceComplete, false); assert.equal(shown.truncated, true); assert.equal(raw.sourceComplete, true);
  const messages = [{ role: "system", content: "rules" }, { role: "user", content: "task" },
    { role: "assistant", content: "", tool_calls: [{ id: "a" }, { id: "b" }] },
    { role: "tool", tool_call_id: "a", content: "a".repeat(2000) }, { role: "tool", tool_call_id: "b", content: "b".repeat(2000) }, { role: "assistant", content: "done" }];
  compactLiveMessages(messages, { protectedPrefixCount: 3, maxEstimatedTokens: 500 });
  const answers = new Set(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
  for (const message of messages) for (const call of message.tool_calls ?? []) assert.ok(answers.has(call.id));
});

test("ephemeral run removes raw job logs and leaves no durable history", async () => fixture(async (cwd) => {
  const store = await createSessionStore(cwd, { rootDir: join(cwd, "private-home"), privacyMode: "ephemeral" });
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  let calls = 0; let jobId;
  const result = await runTask({ cwd, task: "Run local fixture", tools, sessionStore: store, session: await store.createSession(), config: { model: "test", quiet: true, taskMode: "command", stream: false, maxSteps: 3, sandboxPolicy: { mode: "off" } },
    client: { async chatCompletion(request) { if (++calls === 1) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "shell", function: { name: "run_shell", arguments: JSON.stringify({ command: "echo synthetic-private-output" }) } }] } }] }; jobId = JSON.parse(request.messages.find((message) => message.role === "tool").content).jobId; return { choices: [{ message: { role: "assistant", content: "Command completed." } }] }; } } });
  assert.equal(result.status, "completed"); assert.equal(result.jobCleanup.ok, true); assert.ok(jobId);
  await assert.rejects(tools.getExecutionBackend().getJob(jobId), { code: "ENOENT" });
  await assert.rejects(readFile(join(store.projectDir, "index.json")), { code: "ENOENT" });
}));

test("review results still enforce explicitly requested check targets", async () => fixture(async (cwd) => {
  await writeFile(join(cwd, "value.js"), "export const value = 1;\n");
  const report = { schema_version: 1, review: { target: "value.js", base: "unknown", project_context: "JavaScript", mode: "quick", lanes: ["code"] }, findings: [], open_questions: [], test_gaps: [], residual_risks: [] };
  const result = await runTask({ cwd, task: "Review value.js and run npm test.", tools: createToolRuntime({ cwd }), config: { quiet: true, model: "fixture", stream: false, maxSteps: 10 }, client: createScriptedEvalClient({ main: [{ tool: "read_file", arguments: { path: "value.js" } }, { text: JSON.stringify(report) }] }) });
  assert.equal(result.status, "failed"); assert.equal(result.acceptance.satisfied, false); assert.equal(result.acceptance.checks[0].status, "missing");
}));

test("private interrupted task reuses its original in-memory dirty baseline", async () => fixture(async (cwd) => {
  await writeFile(join(cwd, "value.js"), "export const value = 1;\n");
  const config = { model: "fixture", quiet: true, stream: false, maxSteps: 10, sandboxPolicy: { mode: "off" } };
  const store = await createSessionStore(cwd, { rootDir: join(cwd, "state"), privacyMode: "redacted" });
  const session = await store.createSession({ model: config.model }); const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  const task = "Fix value.js to return 2.";
  const initial = await runTask({ cwd, task, tools, config, sessionStore: store, session, client: createScriptedEvalClient({ main: [{ tool: "read_file", arguments: { path: "value.js" } }, { tool: "edit_file", arguments: { path: "value.js", search: "1", replace: "2" } }, { interrupt: true }] }) });
  assert.equal(initial.status, "interrupted"); assert.equal(initial.changes.files[0].path, "value.js");
  const checkpoint = await store.loadCheckpoint(session.id);
  const resumed = await runTask({ cwd, task, tools, config, sessionStore: store, session, resumeCheckpoint: checkpoint, client: createScriptedEvalClient({ main: [{ tool: "read_file", arguments: { path: "value.js" } }, { text: "Modified value.js to return 2. Tests not run because no test script exists." }] }) });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed.error)); assert.equal(resumed.changes.id, initial.changes.id);
  assert.equal((await tools.getChangeSet().decide({ action: "undo" })).ok, true);
  assert.equal(await readFile(join(cwd, "value.js"), "utf8"), "export const value = 1;\n");
}));
