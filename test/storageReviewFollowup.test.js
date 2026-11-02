import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionStore, recordTurn } from "../src/session/store.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { runTask } from "../src/agent/taskRunner.js";
import { evaluateTaskAcceptance } from "../src/harness/acceptance.js";
import { reviewCoverage } from "../src/reporter/reviewReport.js";
import { buildTaskSpec } from "../src/harness/taskSpec.js";

async function temporary(t, prefix) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
const labels = (turns) => turns.map((turn) => turn.user.split(" ")[0]);
const turn = (index) => ({ user: "u" + index + " " + "x".repeat(300), assistant: "a" + index + " " + "y".repeat(500) });

test("R2-P2-12 stale saves cannot resurrect trimmed history or displace newer turns", async (t) => {
  const rootDir = await temporary(t, "deecoo-history-merge-");
  const store = await createSessionStore("/synthetic-history-merge", { rootDir, maxFileBytes: 25000, autoPrune: false });
  const session = await store.createSession({ model: "fixture" });
  await recordTurn(store, session, { user: "Never change deployment credentials.", assistant: "Noted" });
  for (let index = 0; index < 8; index++) await recordTurn(store, session, turn(index));
  const stale = structuredClone(session);
  for (let index = 8; index < 35; index++) await recordTurn(store, session, turn(index));
  const before = await store.loadSession(session.id);
  assert.ok(before.historyTrimmedThrough > 0);
  await recordTurn(store, stale, { user: "LATEST-B", assistant: "b" });
  const after = await store.loadSession(session.id);
  assert.ok(!after.history.some((item) => /^u[0-7] /.test(item.user)), "discarded turns stay discarded");
  for (const label of ["u30", "u31", "u32", "u33", "u34", "LATEST-B"]) assert.ok(labels(after.history).includes(label), label);
  assert.deepEqual(labels(after.turns), ["u30", "u31", "u32", "u33", "u34", "LATEST-B"]);
  assert.match(after.summary, /Never change deployment credentials/);
  assert.ok(after.historyTrimmedThrough >= before.historyTrimmedThrough);
  const sequences = after.history.map((item) => item.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.equal(new Set(sequences).size, sequences.length);
  // A second save of the same stale object does not allocate new identities or duplicate turns.
  await store.save(stale);
  assert.deepEqual(labels((await store.loadSession(session.id)).history), labels(after.history));
});

test("R2-P2-12 migration preserves duplicate legacy turns and serializes interleaved new turns", async (t) => {
  const rootDir = await temporary(t, "deecoo-history-legacy-");
  const store = await createSessionStore("/synthetic-history-legacy", { rootDir, autoPrune: false });
  const identical = { user: "same", assistant: "same", at: "2000-01-01T00:00:00.000Z" };
  const id = "12345678";
  await writeFile(join(store.projectDir, id + ".json"), JSON.stringify({ id, cwd: "/synthetic-history-legacy", turns: [identical, identical], history: [identical, identical] }));
  const first = await store.loadSession(id), second = await store.loadSession(id);
  assert.equal(new Set(first.history.map((item) => item.id)).size, 2);
  assert.deepEqual(first.history, second.history);
  await recordTurn(store, first, { user: "A", assistant: "a" });
  await recordTurn(store, second, { user: "B", assistant: "b" });
  const loaded = await store.loadSession(id);
  assert.deepEqual(labels(loaded.history), ["same", "same", "A", "B"]);
  assert.deepEqual(loaded.history.map((item) => item.sequence), [1, 2, 3, 4]);
  assert.deepEqual(loaded.turns.map((item) => item.id), loaded.history.map((item) => item.id));
});

const answer = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 1 } });
const read = () => ({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "read-a", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.js" }) } }] } }], usage: { total_tokens: 1 } });
const report = JSON.stringify({ schema_version: 1, review: { target: "a.js", base: "HEAD", project_context: "fixture", mode: "review", lanes: [] }, findings: [], open_questions: [], test_gaps: [], residual_risks: [] });
const plus = "export const add = (a,b) => a + b;\n", minus = "export const add = (a,b) => a - b;\n";

for (const kind of ["review", "assertion"]) {
  test("CTRL-002 " + kind + " resume rejects old source, and only a fresh matching read can pass", async (t) => {
    const cwd = await temporary(t, "deecoo-source-resume-");
    const store = await createSessionStore(cwd, { rootDir: join(cwd, "state") });
    const session = await store.createSession({ model: "fixture" });
    await writeFile(join(cwd, "a.js"), plus);
    const task = kind === "review" ? "Full review @a.js" : "Fix a.js if needed";
    const config = { model: "fixture", quiet: true, stream: false, maxSteps: 1, requiredChecks: [],
      ...(kind === "assertion" ? { taskAcceptance: { requirements: [{ kind: "file-content", path: "a.js", contains: "a + b" }] } } : {}) };
    const tools = () => createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
    const first = await runTask({ cwd, tools: tools(), sessionStore: store, session, task, config, client: { async chatCompletion() { return read(); } } });
    assert.equal(first.stoppedReason, "step_budget_exceeded");
    const checkpoint = await store.loadCheckpoint(session.id);
    await writeFile(join(cwd, "a.js"), minus);
    const resume = async (reread) => {
      let calls = 0;
      return runTask({ cwd, tools: tools(), sessionStore: store, session, task, config: { ...config, maxSteps: 4 }, resumeCheckpoint: checkpoint,
        client: { async chatCompletion() { return reread && ++calls === 1 ? read() : answer(kind === "review" ? report : "No change needed."); } } });
    };
    const stale = await resume(false);
    assert.notEqual(stale.status, "completed");
    assert.equal(stale.effects.events.filter((event) => event.type === "file-read").length, 1);
    if (kind === "review") assert.ok(reviewCoverage({ task, effects: stale.effects }).missingFiles.includes("a.js"));
    else assert.equal(stale.acceptance?.requirements[0].status, "missing");
    if (kind === "assertion") {
      const wrong = await resume(true);
      assert.notEqual(wrong.status, "completed", "a fresh but non-matching read does not pass");
      await writeFile(join(cwd, "a.js"), plus);
    }
    const fresh = await resume(true);
    assert.equal(fresh.status, "completed", JSON.stringify({ stoppedReason: fresh.stoppedReason, acceptance: fresh.acceptance }));
    assert.equal(await readFile(join(cwd, "a.js"), "utf8"), kind === "review" ? minus : plus);
  });
}

test("CTRL-002 compact historical read copies cannot overwrite authoritative current source", () => {
  const taskSpec = buildTaskSpec({ task: "Fix a.js if needed", acceptance: { requirements: [{ kind: "file-content", path: "a.js", equals: plus }] } });
  const effects = { revision: 1, events: [{ id: "resume", type: "workspace-resumed", revision: 1 },
    { id: "fresh", type: "file-read", path: "a.js", revision: 1, chars: minus.length, content: minus }] };
  const agentState = { steps: [{ toolCall: { name: "read_file", args: { path: "a.js" } }, toolResult: { ok: true, content: plus } }] };
  assert.equal(evaluateTaskAcceptance({ taskSpec, effects, agentState }).satisfied, false);
});

test("CTRL-002 resume also invalidates old diff coverage, while a new diff remains usable", () => {
  const task = "Review the diff in @a.js";
  const events = [{ type: "diff-read", paths: ["a.js"], revision: 0 }, { type: "workspace-resumed", revision: 1 }];
  assert.deepEqual(reviewCoverage({ task, effects: { events } }).missingFiles, ["a.js"]);
  events.push({ type: "diff-read", paths: ["a.js"], revision: 1 });
  assert.deepEqual(reviewCoverage({ task, effects: { events } }).errors, []);
});

test("CTRL-003 inline calls/declarations qualify as source while log subjects still do not", () => {
  for (const [language, body] of [["python", "print(1 / 0)"], ["ruby", "puts(1 / 0)"], ["python", "return f(x)"], ["ruby", "def f(x)\n  x + 1\nend"]]) {
    const coverage = reviewCoverage({ task: "Review this:\n```" + language + "\n" + body + "\n```" });
    assert.equal(coverage.inlineSource, true, body);
    assert.deepEqual(coverage.errors, []);
  }
  for (const task of ["Review these logs:\n```python\nprint(1 / 0)\n```", "Review this:\n```python\nBuild failed\n```", "Review the output:\n```text\nError: build failed\n```", "Review this:\n```\n\n```"])
    assert.equal(reviewCoverage({ task }).inlineSource, false, task);
});
