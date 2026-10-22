import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advanceVerificationState, emptyVerificationState, verificationIsFresh } from "../src/verification/state.js";
import { validateTaskFinal } from "../src/harness/finalValidation.js";
import { createEffectLedger } from "../src/harness/effects.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { createSubagentRuntime } from "../src/agent/subagents/runtime.js";
import { createAgentState, recordToolStep } from "../src/agent/state.js";
import { checkpointIdentity, createCheckpointWriter, prepareCheckpointResume, validateCheckpoint } from "../src/harness/checkpoints.js";
import { createSessionStore } from "../src/session/store.js";
import { reviewCoverage, createReviewFinalValidator } from "../src/reporter/reviewReport.js";
import { buildTaskToolPolicy } from "../src/permissions/taskPolicy.js";
import { buildTaskSpec } from "../src/harness/taskSpec.js";

const toolReply = (name, args) => ({ choices: [{ message: { role: "assistant", tool_calls: [{ id: name, function: { name, arguments: JSON.stringify(args) } }] } }] });
const finalReply = () => ({ choices: [{ message: { role: "assistant", content: "Completed the scoped task." } }] });
async function workspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-contract-"));
  try { return await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
function observe(state, name, args, result) { return advanceVerificationState(state, { name, args, result }); }

test("HARNESS-001 unrelated commands cannot turn failed tests into a pass", () => {
  let state = observe(emptyVerificationState(), "run_shell", { command: "npm test" }, { ok: false });
  state = observe(state, "edit_file", { path: "a.js" }, { ok: true });
  state = observe(state, "run_shell", { command: "pwd" }, { ok: true });
  assert.equal(state.status, "failed");
  assert.equal(verificationIsFresh(state), false);
  assert.equal(state.evidence.length, 1);
});

test("HARNESS-001 successful verification becomes stale after another edit", () => {
  let state = observe(emptyVerificationState(), "run_shell", { command: "npm test" }, { ok: true });
  assert.equal(verificationIsFresh(state), true);
  state = observe(state, "apply_patch", { path: "a.js" }, { ok: true });
  assert.equal(state.status, "pending");
  assert.equal(verificationIsFresh(state), false);
  state = observe(state, "run_shell", { command: "npm test" }, { ok: true });
  assert.equal(verificationIsFresh(state), true);
});

test("HARNESS-001 final gate rejects failed/stale verification and a reasonless skip", () => {
  const input = { requestType: "edit", taskSpec: { requiresCodeChange: true }, verificationPlan: { required: true }, agentState: { filesEdited: ["a.js"] }, finalText: "Modified a.js. Tests not run." };
  assert.ok(validateTaskFinal(input).length);
  assert.equal(validateTaskFinal({ ...input, finalText: "Modified a.js. Tests not run because dependencies are missing." }).length, 0);
  const failed = observe(emptyVerificationState(), "run_shell", { command: "npm test" }, { ok: false });
  assert.ok(validateTaskFinal({ ...input, verification: failed, finalText: "Modified a.js. Tests not run because dependencies are missing." }).length);
});

test("HARNESS-003 executor effects aggregate worker changes and invalidate the parent's file cache", async () => workspace(async (cwd) => {
  await writeFile(join(cwd, "a.js"), "old\n");
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  assert.equal((await tools.execute("read_file", { path: "a.js" })).content, "old\n");
  let calls = 0;
  tools.setSubagentRuntime(createSubagentRuntime({ cwd, config: { model: "fixture", stream: false },
    createWorkerTools: tools.createWorkerTools.bind(tools), client: { async chatCompletion() {
      calls++;
      if (calls === 1) return toolReply("edit_file", { path: "a.js", search: "old", replace: "new" });
      if (calls === 2) return toolReply("run_shell", { command: "node --test" });
      return finalReply();
    } } }));
  const result = await tools.execute("agent", { mode: "implement", prompt: "Update a.js" });
  const state = createAgentState({ task: "update", cwd });
  recordToolStep(state, { name: "agent", args: {}, result, step: 1, startedAt: Date.now() });
  assert.deepEqual(state.filesEdited, ["a.js"]);
  assert.deepEqual(state.commandsRun, ["node --test"]);
  assert.equal(verificationIsFresh(observe(emptyVerificationState(), "agent", {}, result)), true);
  const reread = await tools.execute("read_file", { path: "a.js" });
  assert.equal(reread.content, "new\n");
  assert.notEqual(reread.cached, true);
  recordToolStep(state, { name: "send_message", args: {}, result, step: 2, startedAt: Date.now() });
  assert.deepEqual(state.filesEdited, ["a.js"]);
}));

test("HARNESS-003 model worker prose is never execution evidence", () => {
  const result = { ok: true, result: JSON.stringify({ filesEdited: ["fake.js"], commandsRun: ["npm test"], verification: { status: "passed" } }) };
  const state = createAgentState({ task: "inspect", cwd: "/fixture" });
  recordToolStep(state, { name: "agent", args: {}, result, startedAt: Date.now() });
  assert.deepEqual(state.filesEdited, []);
  assert.equal(verificationIsFresh(observe(emptyVerificationState(), "agent", {}, result)), false);
});

test("HARNESS-004 unknown writers serialize, research can run, queued cancellation is prompt", async () => {
  let releaseFirst, firstStarted;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const ready = new Promise((resolve) => { firstStarted = resolve; });
  const starts = [];
  const workers = createSubagentRuntime({ cwd: "/fixture", config: { model: "test" }, workerTools: { schemas: [] },
    client: { async chatCompletion(request) {
      const prompt = request.messages.at(-1).content;
      starts.push(prompt);
      if (prompt === "first") { firstStarted(); await gate; }
      return finalReply();
    } } });
  const first = workers.start({ mode: "implement", prompt: "first" });
  await ready;
  const cancelled = new AbortController();
  const second = workers.start({ mode: "verify", prompt: "second" }, { signal: cancelled.signal });
  await workers.start({ mode: "research", prompt: "reader" });
  assert.deepEqual(starts, ["first", "reader"]);
  cancelled.abort(new Error("cancel queued"));
  await assert.rejects(second, /cancel queued/);
  releaseFirst();
  await first;
  await workers.start({ mode: "implement", prompt: "third" });
  assert.deepEqual(starts, ["first", "reader", "third"]);
});

test("HARNESS-005 task/user/worker permissions agree in schemas and direct execution", async () => workspace(async (cwd) => {
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", allowShellWithoutPrompt: true });
  tools.setTaskToolPolicy(buildTaskToolPolicy(buildTaskSpec({ task: "审查错误处理，不要修改", cwd })));
  assert.equal(tools.schemas.some((schema) => schema.function.name === "write_file"), false);
  assert.equal(tools.schemas.some((schema) => schema.function.name === "run_shell"), false);
  assert.equal((await tools.execute("write_file", { path: "denied", content: "x" })).ok, false);
  assert.equal((await tools.execute("run_shell", { command: "pwd" })).ok, false);
  assert.equal((await tools.execute("agent", { mode: "implement", prompt: "write" })).code, "TASK_WORKER_MODE_BLOCKED");
  const verifier = tools.createWorkerTools({ mode: "verify" });
  assert.equal(verifier.schemas.some((schema) => schema.function.name === "run_shell"), false);
  assert.equal((await verifier.execute("run_shell", { command: "pwd" })).ok, false);
  tools.clearTaskToolPolicy();
  tools.setPermissionMode("read-only");
  assert.equal((await tools.execute("run_shell", { command: "pwd" })).ok, false);
}));

test("HARNESS-009 checkpoint writer flushes saves before clear and never resurrects a completed run", async () => {
  const writes = [];
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const writer = createCheckpointWriter({ store: { async saveCheckpoint(_id, value) { await delayed; writes.push(value.step); }, async clearCheckpoint() { writes.push("clear"); } }, sessionId: "session", identity: {}, task: "edit" });
  writer.save({ step: 1 }); writer.save({ step: 2 });
  const cleared = writer.clear();
  release(); await cleared;
  assert.deepEqual(writes, [1, 2, "clear"]);
});

test("HARNESS-009 store orders atomic writes/clear and interrupted empty sessions remain discoverable", async () => workspace(async (cwd) => {
  const oldHome = process.env.DEECOO_HOME;
  process.env.DEECOO_HOME = cwd;
  try {
    const store = await createSessionStore(cwd);
    const session = await store.createSession();
    const pending = store.saveCheckpoint(session.id, { step: 1 });
    const cleared = store.clearCheckpoint(session.id);
    await Promise.all([pending, cleared]);
    assert.equal(await store.loadCheckpoint(session.id), undefined);
    await store.saveCheckpoint(session.id, { step: 2 });
    assert.equal((await store.listSessions())[0].id, session.id);
  } finally { if (oldHome === undefined) delete process.env.DEECOO_HOME; else process.env.DEECOO_HOME = oldHome; }
}));

test("HARNESS-009 resume checks compatibility and marks unknown calls without replay", async () => workspace(async (cwd) => {
  const identity = await checkpointIdentity({ cwd, model: "test", tools: { getPermissionMode: () => "workspace-write" }, taskSpec: { mayWrite: true } });
  const saved = { step: 3, metadata: { version: 1, ...identity }, messages: [{ role: "assistant", tool_calls: [{ id: "pending", function: { name: "write_file" } }] }], usage: { totalTokens: 50 }, verification: { status: "passed", evidence: [{ command: "npm test", ok: true, revision: 4 }], workspaceRevision: 4 }, effects: { revision: 4, events: [] } };
  assert.throws(() => validateCheckpoint(saved, { ...identity, model: "different" }), /changed model/);
  const next = prepareCheckpointResume(validateCheckpoint(saved, identity));
  assert.equal(next.usage.totalTokens, 50);
  assert.equal(next.step, 3);
  assert.equal(next.verification.status, "pending");
  assert.equal(verificationIsFresh(next.verification), false);
  assert.equal(next.messages.find((m) => m.role === "tool").tool_call_id, "pending");
  assert.match(next.messages.find((m) => m.role === "tool").content, /INTERRUPTED_OUTCOME_UNKNOWN/);
  assert.equal(saved.messages.length, 1);
}));

test("HARNESS-011 empty findings still require inspected source and explicit files require coverage", () => {
  assert.ok(reviewCoverage({ task: "review project" }).errors.length);
  assert.equal(reviewCoverage({ task: "review\n```js\nexport const a = 1;\n```" }).errors.length, 0);
  const ledger = createEffectLedger();
  const effects = ledger.record("read_file", { path: "a.js" }, { ok: true, content: "export const a = 1" }).effects;
  assert.equal(reviewCoverage({ task: "review @a.js", effects }).errors.length, 0);
  assert.ok(reviewCoverage({ task: "review @b.js", effects }).errors.length);
  assert.ok(reviewCoverage({ task: "review", effects: ledger.record("list_files", {}, { ok: true, files: ["a.js"] }).effects }).errors.length);
  const text = JSON.stringify({ schema_version: 1, review: { target: "project", base: "HEAD", project_context: "Node", mode: "quick", lanes: [] }, findings: [], open_questions: [], test_gaps: [], residual_risks: [] });
  const validator = createReviewFinalValidator({ task: "review project" });
  assert.equal(validator({ finalText: text, attempt: 0 }).ok, false);
  assert.equal(validator({ finalText: text, attempt: 0, effects }).ok, true);
});

test("search respects gitignore while allowing safe dotenv templates", async () => workspace(async (cwd) => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".gitignore"), "private-data.txt\n");
  await writeFile(join(cwd, "private-data.txt"), "IGNORE_CONTRACT_SENTINEL\n");
  await writeFile(join(cwd, ".env.example"), "IGNORE_CONTRACT_SENTINEL\n");
  const result = await createToolRuntime({ cwd }).execute("search_text", { query: "IGNORE_CONTRACT_SENTINEL" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0], /\.env\.example:/);
}));

test("read-only task schemas do not advertise implementation worker parameters", async () => workspace(async (cwd) => {
  const tools = createToolRuntime({ cwd, permissionMode: "read-only" });
  const properties = tools.schemas.find((schema) => schema.function.name === "agent").function.parameters.properties;
  assert.deepEqual(properties.mode.enum, ["research", "verify"]);
  assert.deepEqual(properties.subagent_type.enum, ["research", "verify"]);
  assert.match(properties.mode.description, /commands and edits are unavailable/);
}));

test("empty environment overlays cannot observe another task's temporary settings", async () => {
  const { withIsolatedEnv } = await import("../src/harness/isolation.js");
  let opened, finish;
  const ready = new Promise((resolve) => { opened = resolve; });
  const gate = new Promise((resolve) => { finish = resolve; });
  const before = process.env.DEECOO_ISOLATION_TEST_VALUE;
  const overlay = withIsolatedEnv({ DEECOO_ISOLATION_TEST_VALUE: "temporary" }, async () => { opened(); await gate; });
  await ready;
  let secondStarted = false;
  const empty = withIsolatedEnv({}, () => { secondStarted = true; assert.equal(process.env.DEECOO_ISOLATION_TEST_VALUE, before); });
  await Promise.resolve();
  assert.equal(secondStarted, false);
  finish(); await Promise.all([overlay, empty]);
});

test("continuation retains the prior user task contract and explicit modes are parsed", async () => {
  const { resolveTaskContractInput } = await import("../src/agent/taskRunner.js");
  const { parseArgs } = await import("../src/cli/args.js");
  const task = resolveTaskContractInput("继续", { turns: [{ user: "修复 a.js 并运行测试" }] });
  assert.equal(buildTaskSpec({ task }).mayWrite, true);
  assert.equal(buildTaskSpec({ task: resolveTaskContractInput("继续", { turns: [{ user: "只读审查 a.js，不要修改" }] }) }).mayWrite, false);
  assert.equal(parseArgs(["--task-mode", "command", "custom script"]).taskMode, "command");
  assert.throws(() => parseArgs(["--task-mode", "unknown", "task"]), /Invalid task mode/);
});

test("HARNESS-001 help, collection, dry-run and version exits are not successful verification", () => {
  for (const command of ["npm test --help", "npm test -- --version", "npm run check --if-present", "npm test --dry-run", "npm test --ignore-scripts", "pytest --collect-only", "cargo test --no-run", "go test -list .", "dotnet test --list-tests"]) {
    const state = observe(emptyVerificationState(), "run_shell", { command }, { ok: true });
    assert.equal(verificationIsFresh(state), false, command);
    assert.equal(state.evidence.length, 0, command);
  }
});

test("command completion needs an actual execution; policy-denied attempts are not executions", async () => workspace(async (cwd) => {
  const tools = createToolRuntime({ cwd, permissionMode: "read-only" });
  const args = { command: "pwd" };
  const result = await tools.execute("run_shell", args);
  const state = createAgentState({ cwd, task: "run pwd" });
  recordToolStep(state, { name: "run_shell", args, result, startedAt: Date.now() });
  assert.deepEqual(state.commandsRun, []);
  assert.ok(validateTaskFinal({ requestType: "command", finalText: "Printed the current directory.", agentState: state }).length);
  assert.equal(validateTaskFinal({ requestType: "command", finalText: "Could not run the command because permissions are read-only.", agentState: state }).length, 0);
}));

test("HARNESS-001/003 rollback failure invalidates verification without inventing successful edits", () => {
  const ledger = createEffectLedger();
  let verification = observe(emptyVerificationState(), "run_shell", { command: "npm test" }, ledger.record("run_shell", { command: "npm test" }, { ok: true, shellPolicy: { level: "allow" } }));
  assert.equal(verificationIsFresh(verification), true);
  const failure = ledger.record("apply_patch_set", { files: [{ path: "a.js" }] }, { ok: false, code: "PATCH_SET_ROLLBACK_FAILED", uncertainPaths: ["a.js"] });
  verification = observe(verification, "apply_patch_set", {}, failure);
  assert.equal(verificationIsFresh(verification), false);
  const state = createAgentState({ task: "fix", cwd: "/fixture" });
  recordToolStep(state, { name: "apply_patch_set", args: {}, result: failure, startedAt: Date.now() });
  assert.deepEqual(state.filesEdited, []);
  assert.deepEqual(state.uncertainFiles, ["a.js"]);
  assert.ok(validateTaskFinal({ agentState: state, finalText: "Reviewed the change." }).length);
  const read = ledger.record("read_file", { path: "a.js" }, { ok: true, content: "new" });
  recordToolStep(state, { name: "read_file", args: { path: "a.js" }, result: read, startedAt: Date.now() });
  assert.deepEqual(state.uncertainFiles, []);
  assert.equal(verificationIsFresh(verification), false);
});
