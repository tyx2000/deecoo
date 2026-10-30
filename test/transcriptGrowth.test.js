import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.js";
import { runTask } from "../src/agent/taskRunner.js";
import { contextFingerprint, createContextState } from "../src/context/compaction.js";
import { evaluateTaskAcceptance } from "../src/harness/acceptance.js";
import { checkpointProjection, createCheckpointWriter, prepareCheckpointResume } from "../src/harness/checkpoints.js";
import { createSessionStore } from "../src/session/store.js";
import { writeJsonFile } from "../src/storage/atomic.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const answer = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 1 } });
const call = (id, name, args) => ({ choices: [{ message: { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 1 } });
const config = { model: "test", quiet: true, stream: false, contextWindow: 32000, maxTokens: 512, requiredChecks: ["node check.js"] };
const task = "Summarize the notes directory and run node check.js";
const checkpointFile = (store, session) => join(store.projectDir, session.id + ".checkpoint.json");
const segmentDir = (store, session) => join(store.projectDir, "transcripts", session.id);
const segments = async (store, session) => (await readdir(segmentDir(store, session)).catch(() => [])).filter((name) => name.endsWith(".jsonl"));

async function workspace(t, { notes = 16, line = "" } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-transcript-growth-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "notes"));
  for (let index = 1; index <= notes; index++) {
    await writeFile(join(cwd, "notes", "n" + index + ".txt"), Array.from({ length: 180 }, (_, row) => `note ${index} row ${row} ${line}` + "x".repeat(80)).join("\n") + "\n");
  }
  await writeFile(join(cwd, "check.js"), "console.log('notes ok');\n");
  return cwd;
}

// Reads every note (each read grows the transcript and forces compaction), runs the
// required check, then stops on its step budget so a resumable checkpoint remains.
async function interruptedRun({ cwd, store, session, notes = 16, text = task, extra = {} }) {
  let calls = 0;
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  const result = await runTask({ cwd, tools, sessionStore: store, session, task: text, config: { ...config, maxSteps: notes + 1, ...extra },
    client: { async chatCompletion() { calls++; return calls <= notes ? call("r" + calls, "read_file", { path: "notes/n" + calls + ".txt" }) : call("check", "run_shell", { command: "node check.js" }); } } });
  return { result, tools };
}

async function resumedRun({ cwd, store, session, checkpoint, extra = {} }) {
  let calls = 0;
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  return runTask({ cwd, tools, sessionStore: store, session, task: checkpoint.metadata.task, resumeCheckpoint: checkpoint, config: { ...config, maxSteps: 5, ...extra },
    client: { async chatCompletion() { calls++; return calls === 1 ? call("recheck", "run_shell", { command: "node check.js" }) : answer("The notes are summarized and node check.js passes."); } } });
}

function assertSourceProofs(contextState) {
  const records = new Map(contextState.transcript.map((record) => [record.id, record.message]));
  assert.ok(contextState.compactions.length > 0);
  for (const compaction of contextState.compactions) {
    const source = compaction.sourceMessageIds.map((id) => ({ id, message: records.get(id) }));
    assert.ok(source.every((item) => item.message), "every compacted source message is restored");
    assert.equal(contextFingerprint(source), compaction.sourceHash);
  }
}

test("R2-P1-5 a long task with many compactions keeps checkpointing within the per-file storage cap", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-transcript-long-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cap = 512 * 1024, steps = 40;
  const store = await createSessionStore(cwd, { rootDir: join(cwd, "state"), maxFileBytes: cap });
  const session = await store.createSession({ model: "fixture" });
  const writer = createCheckpointWriter({ store, sessionId: session.id, task: "Analyze reports", strict: true,
    identity: { workspace: cwd, model: "fixture", permissionMode: "read-only", mayWrite: false } });
  await writer.ready();
  const saved = [];
  let calls = 0, last;
  const result = await runAgent({ task: "Analyze reports", cwd, model: "fixture", contextWindow: 24000, maxTokens: 512, stream: false, maxSteps: steps + 5,
    tools: { schemas: [], async execute(_name, args) { return { ok: true, content: String(args.index) + "x".repeat(30000) }; } },
    client: { async chatCompletion() { return ++calls <= steps ? call("c" + calls, "fixture_report", { index: calls }) : answer("Analysis complete."); } },
    onCheckpoint: async (snapshot) => {
      await writer.save(snapshot);
      const stored = JSON.parse(await readFile(checkpointFile(store, session), "utf8"));
      saved.push({ step: stored.step, bytes: (await lstat(checkpointFile(store, session))).size });
      last = snapshot;
    } });
  await writer.flush();
  assert.equal(result.workflow.status, "completed");
  assert.ok(result.contextState.compactions.length >= 13);
  assert.ok(Buffer.byteLength(JSON.stringify(result.contextState.transcript)) > 2 * cap, "the raw transcript outgrows a single file");
  assert.deepEqual(saved.map((entry) => entry.step), Array.from({ length: steps }, (_, index) => index + 1), "every step is durably saved");
  assert.ok(saved.every((entry) => entry.bytes <= cap));
  assert.deepEqual(writer.diagnostics(), { writeFailures: 0, lastSavedStep: steps, latestStep: steps, persistence: "durable" });
  const names = await segments(store, session);
  assert.ok(names.length > 1);
  for (const name of names) assert.ok((await lstat(join(segmentDir(store, session), name))).size <= cap);
  const stored = JSON.parse(await readFile(checkpointFile(store, session), "utf8"));
  assert.equal(stored.processController, undefined, "resume discards the working set, so it is not persisted");
  assert.ok(stored.contextState.archive.records > 0 && stored.contextState.transcript.length < last.contextState.transcript.length);
  // The stored context is the unsealed tail (below one 64 KiB segment), its proofs and the
  // segment references: bounded by the seal target, not by the 1.2 MB history.
  assert.ok(Buffer.byteLength(JSON.stringify(stored.contextState)) < cap / 4, "the checkpoint follows the live projection, not the history");
  const loaded = await store.loadCheckpoint(session.id);
  assert.deepEqual(loaded.contextState.transcript, last.contextState.transcript);
  assert.deepEqual(loaded.contextState.compactions, last.contextState.compactions);
  assert.equal(loaded.contextState.sourceCompleteness, "complete");
  assertSourceProofs(loaded.contextState);
  assert.doesNotThrow(() => createContextState(loaded.messages, { saved: loaded.contextState }));
});

test("R2-P1-5 resume after compaction restores source proofs and keeps acceptance evidence valid", async (t) => {
  const cwd = await workspace(t);
  const store = await createSessionStore(cwd, { rootDir: join(cwd, "state"), maxFileBytes: 512 * 1024 });
  const session = await store.createSession({ model: config.model });
  const { result: first } = await interruptedRun({ cwd, store, session });
  assert.equal(first.stoppedReason, "step_budget_exceeded");
  assert.ok(first.contextState.compactions.length > 0);
  const stored = JSON.parse(await readFile(checkpointFile(store, session), "utf8"));
  assert.ok(stored.contextState.archive.segments.length > 0, "the transcript prefix is sealed into segments");
  assert.ok(stored.contextState.transcript.length < first.contextState.transcript.length);
  const storedReads = stored.effects.events.filter((event) => event.type === "file-read");
  assert.ok(storedReads.length >= 16 && storedReads.every((event) => event.content === undefined && /^[0-9a-f]{64}$/.test(event.contentDigest)), "read contents are stored once by digest");

  const checkpoint = await store.loadCheckpoint(session.id);
  assert.deepEqual(checkpoint.contextState.transcript, first.contextState.transcript);
  assertSourceProofs(checkpoint.contextState);
  const evidence = checkpoint.verification.evidence.find((item) => item.command === "node check.js");
  assert.equal(evidence?.ok, true);
  const reads = checkpoint.effects.events.filter((event) => event.type === "file-read");
  assert.deepEqual(reads.map((event) => event.content), first.effects.events.filter((event) => event.type === "file-read").map((event) => event.content), "fresh source evidence keeps its content");

  const resumed = await resumedRun({ cwd, store, session, checkpoint });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed.error ?? resumed.acceptance?.errors));
  assert.equal(resumed.acceptance.satisfied, true);
  assert.equal(resumed.acceptance.checks[0].status, "passed");
  assert.ok(resumed.verification.evidence.some((item) => item.id === evidence.id), "earlier evidence survives the resume");
  assert.equal(resumed.contextState.contextId, checkpoint.contextState.contextId);
  assert.equal(resumed.contextState.sourceCompleteness, "complete");
  assert.deepEqual(resumed.contextState.transcript.slice(0, checkpoint.contextState.transcript.length), checkpoint.contextState.transcript);
  assert.equal(await store.loadCheckpoint(session.id), undefined, "completion clears the checkpoint");
});

test("R2-P1-5 exhausted capacity keeps the last resumable checkpoint and records the downgrade", async (t) => {
  const cwd = await workspace(t, { notes: 8 });
  const store = await createSessionStore(cwd, { rootDir: join(cwd, "state"), maxFileBytes: 512 * 1024 });
  const session = await store.createSession({ model: config.model });
  const events = [];
  // Every file write after step 4's checkpoint finds the storage cap exhausted.
  const savedStep = 4;
  const { result } = await interruptedRun({ cwd, store, session, notes: 8, extra: { onEvent: (event) => {
    events.push(event);
    if (event.type === "model-attempt-start" && event.step === savedStep + 1) store.storagePolicy.maxFileBytes = 1024;
  } } });
  assert.equal(result.stoppedReason, "step_budget_exceeded", "capacity does not abort the task");
  assert.equal(result.checkpoint.persistence, "degraded");
  assert.equal(result.checkpoint.writeFailures, 0);
  assert.equal(result.checkpoint.lastSavedStep, savedStep, JSON.stringify(result.checkpoint));
  assert.equal(result.checkpoint.latestStep, result.steps);
  assert.deepEqual(result.checkpoint.downgrade, { ...result.checkpoint.downgrade, code: "STORAGE_CAPACITY", failedStep: result.steps, lastSavedStep: savedStep });
  assert.ok(events.some((event) => event.type === "checkpoint-degraded" && event.lastSavedStep === savedStep));
  assert.equal(result.persistenceFailure?.code, "STORAGE_CAPACITY", "the run record that did not fit is reported, not claimed");

  const stored = JSON.parse(await readFile(checkpointFile(store, session), "utf8"));
  assert.equal(stored.step, savedStep, "the file on disk is the last checkpoint that fit, never a claimed newer one");
  const checkpoint = await store.loadCheckpoint(session.id);
  assert.equal(checkpoint.step, savedStep);
  assert.deepEqual(checkpoint.persistence, { ...checkpoint.persistence, status: "degraded", code: "STORAGE_CAPACITY", checkpointStep: savedStep, failedStep: result.steps });
  assert.match(prepareCheckpointResume(checkpoint).messages.at(-1).content, /later progress was not saved/);

  // The kept checkpoint stays resumable once capacity is available again.
  const larger = await createSessionStore(cwd, { rootDir: join(cwd, "state"), maxFileBytes: 8 * 1024 * 1024 });
  const resumed = await resumedRun({ cwd, store: larger, session, checkpoint });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed.error ?? resumed.acceptance?.errors));
  assert.equal(resumed.contextState.contextId, checkpoint.contextState.contextId);
  assert.equal(await larger.loadCheckpoint(session.id), undefined);
  await assert.rejects(lstat(join(larger.projectDir, session.id + ".checkpoint-downgrade.json")), { code: "ENOENT" });
});

test("R2-P1-5 a 0.1.9 checkpoint with an inline transcript loads, resumes and migrates to segments", async (t) => {
  const cwd = await workspace(t);
  const store = await createSessionStore(cwd, { rootDir: join(cwd, "state"), maxFileBytes: 512 * 1024 });
  const session = await store.createSession({ model: config.model });
  const { result: first } = await interruptedRun({ cwd, store, session });
  // Rewrite the checkpoint exactly as 0.1.9 stored it: the whole transcript inline, the working
  // set included, and no segment references.
  const current = await store.loadCheckpoint(session.id);
  const { archive: _archive, ...contextState } = current.contextState;
  const legacy = { ...current, contextState, processController: { version: 1, workingSet: { files: [], searches: [], lists: [], git: {} } } };
  await writeJsonFile(checkpointFile(store, session), legacy);
  await rm(segmentDir(store, session), { recursive: true, force: true });

  const loaded = await store.loadCheckpoint(session.id);
  assert.deepEqual(loaded, JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(loaded.contextState.transcript, first.contextState.transcript);
  assertSourceProofs(loaded.contextState);

  // Continue for one more interrupted step so the next checkpoint is written in the new format.
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  const continued = await runTask({ cwd, tools, sessionStore: store, session, task: loaded.metadata.task, resumeCheckpoint: loaded, config: { ...config, maxSteps: 1 },
    client: { async chatCompletion() { return call("again", "read_file", { path: "notes/n1.txt" }); } } });
  assert.equal(continued.stoppedReason, "step_budget_exceeded");
  const migrated = JSON.parse(await readFile(checkpointFile(store, session), "utf8"));
  assert.ok(migrated.contextState.archive.segments.length > 0);
  assert.equal(migrated.processController, undefined);
  const reloaded = await store.loadCheckpoint(session.id);
  assert.deepEqual(reloaded.contextState.transcript.slice(0, legacy.contextState.transcript.length), legacy.contextState.transcript);
  assert.equal(reloaded.contextState.contextId, legacy.contextState.contextId);
  assertSourceProofs(reloaded.contextState);
});

test("R2-P1-5 a missing segment resumes from the live projection with the prefix marked unavailable", async (t) => {
  const cwd = await workspace(t);
  const store = await createSessionStore(cwd, { rootDir: join(cwd, "state"), maxFileBytes: 512 * 1024 });
  const session = await store.createSession({ model: config.model });
  await interruptedRun({ cwd, store, session });
  const [first] = await segments(store, session);
  await unlink(join(segmentDir(store, session), first));
  const checkpoint = await store.loadCheckpoint(session.id);
  assert.equal(checkpoint.contextState, undefined, "a partly missing history is never half-verified");
  assert.deepEqual(checkpoint.contextArchive, { ...checkpoint.contextArchive, status: "unavailable", reason: "missing-segment" });
  const resumed = await resumedRun({ cwd, store, session, checkpoint });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed.error ?? resumed.acceptance?.errors));
  assert.equal(resumed.contextState.sourceCompleteness, "legacy-prefix-unavailable");
});

test("R2-P1-5 segments are filtered like checkpoints, and ephemeral runs write no transcript storage", async (t) => {
  const secret = "PRIVATE_NOTE_VALUE_20261030";
  const files = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true }))
    .map((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []))).flat();
  for (const privacyMode of ["standard", "redacted"]) {
    const cwd = await workspace(t);
    const store = await createSessionStore(cwd, { rootDir: join(cwd, "state"), maxFileBytes: 512 * 1024, privacyMode });
    const session = await store.createSession({ model: config.model });
    // The task text reaches the transcript unfiltered in memory; storage must filter it.
    const { result } = await interruptedRun({ cwd, store, session, text: task + " for value " + secret, extra: { env: { ...process.env, NOTES_API_KEY: secret } } });
    assert.ok(JSON.stringify(result.contextState.transcript).includes(secret));
    assert.ok((await segments(store, session)).length > 0, privacyMode);
    // Segments, checkpoints and run records are this storage path's files.
    const stored = [checkpointFile(store, session), ...(await Promise.all(["transcripts", "audit", "outputs"].map((kind) => files(join(store.projectDir, kind)).catch(() => [])))).flat()];
    assert.ok(stored.some((path) => path.endsWith(".jsonl")));
    for (const path of stored) assert.equal((await readFile(path, "utf8")).includes(secret), false, privacyMode + " " + path);
    const checkpoint = await store.loadCheckpoint(session.id);
    assert.equal(checkpoint.contextState.privacyFiltered, true);
    assert.equal(checkpoint.contextState.sourceCompleteness, "filtered");
    assert.doesNotThrow(() => createContextState(checkpoint.messages, { saved: checkpoint.contextState }));
    if (privacyMode === "redacted") {
      // Redacted audits omit request bodies, so this one fits the cap and shows the record shape.
      const [name] = (await readdir(join(store.projectDir, "audit", session.id))).filter((entry) => entry.endsWith(".json"));
      const audit = JSON.parse(await readFile(join(store.projectDir, "audit", session.id, name), "utf8"));
      assert.ok(audit.contextState.archive.segments.length > 0, "a run audit references the segments instead of copying the transcript");
      assert.ok(audit.contextState.transcript.length < result.contextState.transcript.length);
    }
  }

  const ephemeralCwd = await workspace(t, { notes: 4 });
  const ephemeral = await createSessionStore(ephemeralCwd, { rootDir: join(ephemeralCwd, "state"), privacyMode: "ephemeral" });
  const ephemeralSession = await ephemeral.createSession({ model: config.model });
  await interruptedRun({ cwd: ephemeralCwd, store: ephemeral, session: ephemeralSession, notes: 4 });
  assert.ok((await ephemeral.loadCheckpoint(ephemeralSession.id))?.contextState, "the checkpoint stays in memory");
  await assert.rejects(lstat(join(ephemeralCwd, "state")), { code: "ENOENT" });
});

test("R2-P1-5 checkpoints drop observation copies that resume or acceptance can never use", () => {
  const read = (id, revision, path = "a.js") => ({ id, type: "file-read", path, chars: 5, truncated: false, contentHash: id, content: "v" + revision, revision });
  const snapshot = { step: 4, processController: { workingSet: { files: [["a.js", { content: "pinned" }]] } },
    verification: { evidence: [{ id: "check", command: "npm test", ok: true }], workspaceRevision: 3 },
    effects: { version: 1, revision: 3, events: [read("old", 0), { id: "edit", type: "file-change", paths: ["a.js"], revision: 1 }, read("fresh", 1),
      { id: "check", type: "command", command: "npm test", ok: true, revision: 2 }, read("after-check", 2, "b.js")] } };
  const projected = checkpointProjection(snapshot);
  assert.equal(projected.processController, undefined);
  assert.equal(snapshot.processController.workingSet.files.length, 1, "the live snapshot is not changed");
  assert.deepEqual(projected.effects.events.map((event) => [event.id, event.content, event.contentOmitted]),
    [["old", undefined, "superseded"], ["edit", undefined, undefined], ["fresh", "v1", undefined], ["check", undefined, undefined], ["after-check", "v2", undefined]]);
  const taskSpec = { acceptance: { allowedCompletionTypes: ["no-change", "modified"], targetPaths: [], requirements: [
    { kind: "file-content", path: "a.js", equals: "v1" }, { kind: "file-content", path: "b.js", contains: "v2" }] } };
  assert.deepEqual(evaluateTaskAcceptance({ taskSpec, verification: projected.verification, effects: projected.effects }),
    evaluateTaskAcceptance({ taskSpec, verification: snapshot.verification, effects: snapshot.effects }));
});
