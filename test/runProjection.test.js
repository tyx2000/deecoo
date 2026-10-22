import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRunEventStream } from "../src/harness/events.js";
import { createRunProjection, foldRun, reconcileRunJournal } from "../src/harness/runProjection.js";
import { createSecretRegistry } from "../src/config/secrets.js";
import { projectModelRequest } from "../src/llm/requestSnapshot.js";
import { redact } from "../src/observability/audit.js";

const event = (sequence, type, body = {}) => ({ schemaVersion: 1, runId: "r", taskId: "t", sequence, eventId: "e" + sequence, type, at: sequence, ...body });
const start = (sequence, id = "a") => event(sequence, "model-attempt-start", { attemptId: id, requestHash: "hash", request: { model: "fixture", messages: [{ role: "user", content: "source" }], tools: [] } });

test("DSH-REF-004 pure fold matches live stream without duplicating attempt or aggregate usage", async () => {
  const records = [], stream = createRunEventStream({ runId: "r", taskId: "t", persist: (record) => records.push(record) });
  await stream.emit({ type: "run-start" });
  await stream.emit({ ...start(2), eventId: undefined, sequence: undefined, attemptId: "a" });
  await stream.emit({ type: "model-attempt-end", attemptId: "a", outcome: "completed", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  await stream.emit({ type: "model-call", attemptId: "a", usage: { total_tokens: 5 } });
  await stream.emit({ type: "run-end", status: "completed", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } });
  assert.deepEqual(foldRun(records), stream.projection());
  assert.equal(stream.projection().attemptUsage.totalTokens, 5);
  assert.equal(stream.projection().usage.totalTokens, 10);
  assert.equal(stream.projection().usageSource, "aggregate-snapshot");
  assert.equal((await stream.flush()).rebuildable, true);
  assert.equal(Object.hasOwn(stream.projection(), "messages"), false);
});

test("event IDs deduplicate exact records before accounting but reject conflicts and sequence holes", () => {
  const a = start(1), b = event(2, "model-attempt-end", { attemptId: "a", outcome: "completed", usage: { totalTokens: 9 } });
  assert.deepEqual(foldRun([a, a, b, b]), foldRun([a, b]));
  const seed = foldRun([a]);
  assert.equal(foldRun([a, b], { seed }).usage.totalTokens, 9);
  assert.throws(() => foldRun([a, { ...a, sequence: 2 }]), { code: "RUN_EVENT_ID_COLLISION" });
  assert.throws(() => foldRun([a, { ...b, sequence: 3 }]), { code: "RUN_EVENT_SEQUENCE_GAP" });
  assert.throws(() => foldRun([a, { ...a, requestHash: "changed" }]), { code: "RUN_EVENT_ID_COLLISION" });
  assert.throws(() => foldRun([a, { ...b, runId: "other" }]), { code: "RUN_EVENT_IDENTITY_CHANGED" });
});

test("failed/interrupted attempts never produce successful transcript records and invalid ends do not mutate projection", () => {
  const reducer = createRunProjection({ runId: "r", taskId: "t" });
  reducer.append(start(1)); const before = reducer.snapshot();
  assert.throws(() => reducer.append(event(2, "model-attempt-end", { attemptId: "a", outcome: "completed", usage: { total_tokens: -1 } })), { code: "RUN_EVENT_USAGE_INVALID" });
  assert.deepEqual(reducer.snapshot(), before);
  assert.throws(() => reducer.append(event(2, "model-attempt-end", { attemptId: "a", outcome: "failed", errorCode: { toString: null } })), { code: "RUN_EVENT_INVALID" });
  assert.deepEqual(reducer.snapshot(), before);
  reducer.append(event(2, "model-attempt-end", { attemptId: "a", outcome: "failed", errorCode: "PROVIDER_FAILED", usage: { totalTokens: 2 } }));
  const failed = reducer.snapshot();
  assert.equal(failed.counters.completedAttempts, 0); assert.equal(failed.counters.failedAttempts, 1);
  assert.equal(failed.attempts.a.outcome, "failed"); assert.equal(Object.hasOwn(failed, "transcript"), false);
  assert.throws(() => reducer.append(event(3, "model-attempt-end", { attemptId: "a", outcome: "completed" })), { code: "RUN_ATTEMPT_STATE_INVALID" });
  const interrupted = foldRun([start(1), event(2, "model-attempt-end", { attemptId: "a", outcome: "interrupted", reportedUsage: { totalTokens: 999 }, usageKnown: false })]);
  assert.equal(interrupted.counters.interruptedAttempts, 1); assert.equal(interrupted.usageComplete, false);
  assert.equal(interrupted.usage.totalTokens, 0, "uncertain error reportedUsage is diagnostic only");
  const aggregate = createRunProjection(); aggregate.append(event(1, "usage-snapshot", { usage: { totalTokens: 10 } }));
  const checkpoint = aggregate.snapshot();
  assert.throws(() => aggregate.append(event(2, "usage-snapshot", { usage: { totalTokens: 9 } })), { code: "RUN_EVENT_USAGE_REGRESSION" });
  assert.deepEqual(aggregate.snapshot(), checkpoint);
});

test("compaction provenance is diagnostic and pending tools are never replay instructions", () => {
  const projection = foldRun([event(1, "tool-start", { invocationId: "write", tool: "write_file" }),
    event(2, "context-compacted", { transaction: { compactionId: "c1", sourceMessageIds: ["m1", "m2"], sourceHash: "source", policyVersion: 1,
      beforeEstimate: 100, afterEstimate: 20, replacementMessageId: "summary", replacement: { role: "user", content: "summary text" } } })]);
  assert.equal(projection.pendingTools.write.tool, "write_file");
  assert.equal(projection.lastCompaction.sourceMessageCount, 2);
  assert.equal(JSON.stringify(projection).includes("summary text"), false);
  assert.throws(() => foldRun([event(1, "context-compacted", { transaction: { compactionId: "c", sourceMessageIds: [], sourceHash: "x", beforeEstimate: 1, afterEstimate: 2 } })]), { code: "RUN_COMPACTION_INVALID" });
});

test("resume seed and crash-tail reconciliation preserve sequence without replaying a settled or pending tool", async () => {
  const records = [], first = createRunEventStream({ runId: "r", taskId: "t", persist: (record) => records.push(record) });
  await first.emit({ type: "run-start" }); await first.emit({ type: "tool-start", invocationId: "write", tool: "write_file" });
  const checkpoint = first.checkpoint();
  await first.emit({ type: "tool-end", invocationId: "write", ok: true });
  const reconciled = reconcileRunJournal(checkpoint, records, { runId: "r", taskId: "t" });
  assert.equal(reconciled.sequence, 3); assert.equal(reconciled.persistedWatermark, 3);
  assert.deepEqual(reconciled.projection.pendingTools, {});
  const next = createRunEventStream({ runId: "r", taskId: "t", resumeState: reconciled, persist: (record) => records.push(record) });
  await next.emit({ type: "usage-snapshot", usage: { totalTokens: 7 } });
  assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3, 4]);
  assert.deepEqual(next.projection(), foldRun(records));
  assert.equal((await next.flush()).journalComplete, true);
  const stamp = { ...records[0], at: "store timestamp", sessionId: "session" };
  assert.deepEqual(foldRun([stamp], { seed: first.projection() }), first.projection());
  assert.throws(() => reconcileRunJournal(checkpoint, [records[0], records[1], { ...records[2], sequence: 4 }], { runId: "r", taskId: "t" }), { code: "RUN_EVENT_SEQUENCE_GAP" });
});

test("missing durable history cannot become a complete journal merely because a checkpoint remembers the watermark", async () => {
  const records = [], first = createRunEventStream({ runId: "r", taskId: "t", persist: (record) => records.push(record) });
  await first.emit({ type: "run-start" }); await first.emit({ type: "usage-snapshot", usage: { totalTokens: 4 } });
  const missing = reconcileRunJournal(first.checkpoint(), records.slice(1), { runId: "r", taskId: "t" });
  assert.equal(missing.historyMissing.firstMissingSequence, 1); assert.equal(missing.persistedWatermark, 0);
  const resumed = createRunEventStream({ runId: "r", taskId: "t", resumeState: missing, persist: () => {} });
  await resumed.emit({ type: "run-start" });
  assert.equal(resumed.projection().usage.totalTokens, 4);
  assert.equal((await resumed.flush()).rebuildable, false);
  const empty = reconcileRunJournal(first.checkpoint(), [], { runId: "r", taskId: "t" }); assert.ok(empty.historyMissing);
});

test("asynchronous observers cannot mutate persistence and their failures do not stop ordered durable writes", async () => {
  const stored = [], callback = [];
  const stream = createRunEventStream({ runId: "r", taskId: "t", onEvent: async (record) => { await delay(2); callback.push(record.sequence); assert.throws(() => { record.type = "forged"; }, TypeError); throw new Error("observer unavailable"); }, persist: async (record) => stored.push(record.sequence) });
  stream.emit({ type: "run-start" }); stream.emit({ type: "run-end", status: "completed", usage: {} });
  const final = await stream.flush();
  assert.deepEqual(callback, [1, 2]); assert.deepEqual(stored, [1, 2]); assert.match(final.observerError, /observer unavailable/);
  assert.equal(final.journalComplete, true);
});

test("persistence failure exposes a permanent gap and does not advance contiguous durable watermark", async () => {
  const stored = [], stream = createRunEventStream({ runId: "r", taskId: "t", persist: (record) => { if (record.sequence === 2) throw Object.assign(new Error("disk unavailable"), { code: "EIO" }); stored.push(record); } });
  await stream.emit({ type: "run-start" }); await stream.emit({ type: "step", step: 1 }); await stream.emit({ type: "step", step: 2 });
  const status = await stream.flush();
  assert.equal(status.events, 3); assert.equal(status.persistedWatermark, 1); assert.equal(status.gap.sequence, 2);
  assert.equal(status.rebuildable, false); assert.match(status.error, /disk unavailable/);
  assert.throws(() => foldRun(stored), { code: "RUN_EVENT_SEQUENCE_GAP" });
});

test("request snapshots remove authentication and pattern secrets; private persistence omits request bodies explicitly", async () => {
  const secret = "private-credential-value", registry = createSecretRegistry({ CUSTOM_API_KEY: secret });
  const stored = [], observed = [], stream = createRunEventStream({ runId: "r", taskId: "t", secretRegistry: registry,
    includeSnapshots: false, onEvent: (record) => observed.push(record), persist: (record) => stored.push(record) });
  await stream.emit({ type: "model-attempt-start", attemptId: "private", requestHash: "safe-hash", apiKey: secret, data: { [secret]: "key name is filtered" },
    request: { model: "fixture", headers: { Authorization: "Bearer " + secret }, apiKey: secret,
      messages: [{ role: "user", content: secret + " sk-" + "A".repeat(24) }], tools: [] } });
  assert.equal(JSON.stringify(stored).includes(secret), false); assert.equal(JSON.stringify(observed).includes(secret), false);
  assert.equal(JSON.stringify(observed).includes("sk-" + "A".repeat(24)), false);
  assert.equal(Object.hasOwn(stored[0], "request"), false); assert.equal(stored[0].snapshotOmitted, true);
  assert.ok(observed[0].request); assert.equal(Object.hasOwn(observed[0].request, "headers"), false);
  assert.equal((await stream.flush()).requestSnapshotsComplete, false); assert.equal(stream.snapshot().rebuildable, false);
  assert.deepEqual(stream.projection(), foldRun(stored)); assert.deepEqual(stream.projection(), foldRun(observed));
  assert.equal(JSON.stringify(stream.checkpoint()).includes("messages"), false);
});

test("request-aware filtering preserves token-named schemas and numeric thinking controls", async () => {
  const secret = "sensitive-token-value", secretRegistry = createSecretRegistry({ API_KEY: secret });
  const request = { model: "fixture", messages: [{ role: "user", content: secret }], max_tokens: 128, thinking: { type: "enabled", budget_tokens: 64 },
    tools: [{ type: "function", function: { name: "fixture", parameters: { type: "object", properties: {
      token_budget: { type: "integer", minimum: 1, description: "ordinary budget" }, password: { type: "string", description: secret },
    } } } }], headers: { Authorization: secret }, apiKey: secret };
  const filtered = projectModelRequest(request, { filterText: (text) => redact(text, { secretRegistry, maxTextChars: Infinity }) });
  assert.deepEqual(filtered.tools[0].function.parameters.properties.token_budget, request.tools[0].function.parameters.properties.token_budget);
  assert.equal(filtered.tools[0].function.parameters.properties.password.type, "string");
  assert.equal(filtered.thinking.budget_tokens, 64); assert.equal(Object.hasOwn(filtered, "headers"), false);
  assert.equal(JSON.stringify(filtered).includes(secret), false);
  const stored = [], stream = createRunEventStream({ runId: "r", taskId: "t", secretRegistry, persist: (record) => stored.push(record) });
  await stream.emit({ type: "model-attempt-start", attemptId: "schema", request, effectiveConfig: { thinking: { budget_tokens: 64 } } });
  assert.deepEqual(stored[0].request, filtered);
  assert.equal(stored[0].effectiveConfig.thinking.budget_tokens, 64);
});

test("invalid/oversized event and legacy sequence prefix are explicit diagnostic gaps", async () => {
  const stream = createRunEventStream({ runId: "r", taskId: "t", maxEventBytes: 1024 });
  await stream.emit({ type: "step", content: "x".repeat(2000) });
  assert.equal(stream.snapshot().events, 0); assert.equal(stream.snapshot().gap.code, "RUN_EVENT_TOO_LARGE");
  const legacy = createRunEventStream({ runId: "r", taskId: "t", startSequence: 10, persist: () => {} });
  await legacy.emit({ type: "step", step: 3 });
  assert.equal(legacy.snapshot().watermark, 11); assert.equal(legacy.snapshot().projectionComplete, false); assert.equal(legacy.snapshot().rebuildable, false);
  assert.throws(() => createRunEventStream({ runId: "other", taskId: "t", resumeState: legacy.checkpoint() }), { code: "RUN_EVENT_SEED_INVALID" });
  assert.throws(() => createRunEventStream({ runId: "r", taskId: "t", resumeState: { ...legacy.checkpoint(), sequence: 0 } }), { code: "RUN_EVENT_SEED_INVALID" });
  assert.throws(() => foldRun([event(1, "step", { step: Infinity })]), { code: "RUN_EVENT_INVALID" });
});
