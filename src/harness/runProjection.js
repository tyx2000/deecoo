import { createHash } from "node:crypto";

const MAX_EVENTS = 100000;
const MAX_ATTEMPTS = 10000;
const END_STATES = new Set(["completed", "failed", "interrupted"]);
const COUNTERS = ["modelAttempts", "completedAttempts", "failedAttempts", "interruptedAttempts", "modelRetries", "rateLimited", "toolCalls", "toolErrors", "compactions"];
const emptyUsage = () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

// This is a compact diagnostic projection, not a second transcript.
// contextState owns source messages and the committed live projection; journal
// records own any retained request bodies. Seeds contain identities/counters.
export function createRunProjection({ seed, runId, taskId, startSequence = 0 } = {}) {
  seed = seed?.projection ?? seed;
  const state = seed ? snapshot(seed) : {
    version: 1, runId, taskId, watermark: startSequence, eventCount: 0,
    eventIndex: {}, attempts: {}, pendingTools: {}, status: "not-started",
    usage: emptyUsage(), usageSource: "attempts", usageWatermark: 0, usageComplete: true, attemptUsage: emptyUsage(),
    counters: Object.fromEntries(COUNTERS.map((key) => [key, 0])),
    projectionComplete: startSequence === 0, requestSnapshotsComplete: true,
    transcriptSource: "contextState",
    ...(startSequence ? { gap: { code: "RUN_EVENT_PREFIX_MISSING", expected: 1, actual: startSequence + 1 } } : {}),
  };
  validateSeed(state);
  for (const [key, value] of Object.entries({ runId, taskId })) {
    if (value !== undefined && state[key] !== undefined && state[key] !== value) throw failure("RUN_EVENT_IDENTITY_CHANGED", "Run projection " + key + " changed.");
    if (value !== undefined) state[key] = value;
  }
  if (seed && startSequence && startSequence !== state.watermark) throw failure("RUN_EVENT_WATERMARK_MISMATCH", "Resume sequence does not match its projection watermark.");
  return {
    append(event) {
      const record = snapshot(event);
      validateEvent(record);
      for (const key of ["runId", "taskId"]) if (record[key] !== undefined && state[key] !== undefined && record[key] !== state[key]) throw failure("RUN_EVENT_IDENTITY_CHANGED", "Event " + key + " does not match this run.");
      const hash = eventFingerprint(record);
      const prior = state.eventIndex[record.eventId];
      if (Object.hasOwn(state.eventIndex, record.eventId)) {
        if (prior.sequence !== record.sequence || prior.hash !== hash) throw failure("RUN_EVENT_ID_COLLISION", "An event identity was reused for different data or sequence.");
        return false;
      }
      if (record.sequence !== state.watermark + 1) throw failure("RUN_EVENT_SEQUENCE_GAP", "Run events must form a contiguous sequence.", { expected: state.watermark + 1, actual: record.sequence });
      if (state.eventCount >= MAX_EVENTS) throw failure("RUN_EVENT_LIMIT", "The run projection event identity limit was reached.");
      // Each semantic case validates before mutation, so rejection never advances
      // the watermark or partly charges the accounting projection.
      apply(state, record);
      state.runId ??= record.runId;
      state.taskId ??= record.taskId;
      Object.defineProperty(state.eventIndex, record.eventId, { value: { sequence: record.sequence, hash }, enumerable: true, configurable: true, writable: true });
      state.watermark = record.sequence;
      state.eventCount++;
      return true;
    },
    snapshot: () => snapshot(state),
  };
}

export function foldRun(events, options = {}) {
  if (!Array.isArray(events)) throw failure("RUN_EVENT_INVALID", "A run journal must be an array of events.");
  const projection = createRunProjection(options);
  for (const event of events) projection.append(event);
  return projection.snapshot();
}

// Diagnostics after a checkpoint may already be durable. Advance the event
// watermark through that tail without treating tool outcomes as replay work.
export function reconcileRunJournal(resumeState, records, { runId, taskId } = {}) {
  const seed = resumeState?.projection;
  const projection = foldRun(records, { seed, runId, taskId });
  if (resumeState && (resumeState.version !== 1 || resumeState.sequence !== seed?.watermark || resumeState.runId !== runId || resumeState.taskId !== taskId)) throw failure("RUN_EVENT_SEED_INVALID", "The journal checkpoint is incompatible with this run.");
  const physical = new Set(records.map((record) => record.sequence));
  let persistedWatermark = 0;
  while (physical.has(persistedWatermark + 1)) persistedWatermark++;
  const historyMissing = persistedWatermark !== projection.watermark
    ? { firstMissingSequence: persistedWatermark + 1, observedRecords: physical.size, expectedRecords: projection.watermark } : undefined;
  const prior = resumeState ?? {};
  const { historyMissing: _oldMissing, ...retained } = prior;
  return { ...retained, version: 1, runId, taskId, sequence: projection.watermark, projection, persistedWatermark,
    ...(historyMissing ? { historyMissing } : {}) };
}

export function eventFingerprint(event) {
  // Persistence adapters may stamp transport time/session metadata. Private
  // ephemeral bodies marked omitted are not part of persisted event identity.
  const { at: _at, sessionId: _session, ...body } = event;
  if (body.snapshotOmitted) delete body.request;
  return fingerprint(body);
}
export function fingerprint(value) {
  const canonical = (input) => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function apply(state, event) {
  switch (event.type) {
    case "run-start": state.status = "running"; break;
    case "run-end":
    case "usage-snapshot": {
      if (event.type === "run-end" && event.status !== undefined && typeof event.status !== "string") throw failure("RUN_EVENT_INVALID", "A run status must be text.");
      if (event.usage !== undefined) {
        const usage = normalizeUsage(event.usage);
        if (state.usageSource === "aggregate-snapshot" && ["promptTokens", "completionTokens", "totalTokens"].some((key) => usage[key] < state.usage[key])) throw failure("RUN_EVENT_USAGE_REGRESSION", "Cumulative usage snapshots cannot reduce already recorded usage.");
        state.usage = usage; state.usageSource = "aggregate-snapshot"; state.usageWatermark = event.sequence;
      }
      if (event.type === "run-end") state.status = String(event.status ?? "unknown");
      break;
    }
    case "model-attempt-start": {
      const id = identity(event.attemptId, "attemptId");
      if (Object.hasOwn(state.attempts, id)) throw failure("RUN_ATTEMPT_COLLISION", "A model attempt can start only once.");
      if (Object.keys(state.attempts).length >= MAX_ATTEMPTS) throw failure("RUN_ATTEMPT_LIMIT", "The run projection attempt limit was reached.");
      const requestHash = event.requestHash === undefined ? undefined : identity(event.requestHash, "requestHash", 256);
      const item = { attemptId: id, step: event.step, outcome: "started", startSequence: event.sequence,
        ...(requestHash ? { requestHash } : {}),
        ...(event.requestSnapshotHash ? { requestSnapshotHash: event.requestSnapshotHash } : {}),
        ...(event.routeIdentity?.hash ? { routeHash: event.routeIdentity.hash } : {}),
        snapshotAvailable: Boolean(event.request && !event.snapshotOmitted) };
      Object.defineProperty(state.attempts, id, { value: item, enumerable: true, configurable: true, writable: true });
      state.counters.modelAttempts++;
      if (!item.snapshotAvailable) state.requestSnapshotsComplete = false;
      state.lastAttemptId = id;
      break;
    }
    case "model-attempt-end": {
      const id = identity(event.attemptId, "attemptId"), attempt = state.attempts[id];
      if (!Object.hasOwn(state.attempts, id) || attempt.outcome !== "started" || !END_STATES.has(event.outcome)) throw failure("RUN_ATTEMPT_STATE_INVALID", "A model attempt must end exactly once after its start.");
      const errorCode = event.errorCode === undefined ? undefined : identity(event.errorCode, "errorCode");
      const measured = event.usage !== undefined && event.usageKnown !== false;
      const usage = normalizeUsage(measured ? event.usage : undefined), total = addUsage(state.attemptUsage, usage);
      attempt.outcome = event.outcome; attempt.endSequence = event.sequence; attempt.usage = usage;
      attempt.usageKnown = measured;
      if (!attempt.usageKnown) state.usageComplete = false;
      if (errorCode !== undefined) attempt.errorCode = errorCode;
      state.counters[event.outcome === "completed" ? "completedAttempts" : event.outcome === "failed" ? "failedAttempts" : "interruptedAttempts"]++;
      state.attemptUsage = total;
      if (state.usageSource === "attempts") { state.usage = { ...total }; state.usageWatermark = event.sequence; }
      break;
    }
    case "model-retry": state.counters.modelRetries++; if (event.status === 429) state.counters.rateLimited++; break;
    case "tool-start":
      if (event.invocationId !== undefined) {
        const id = identity(event.invocationId, "invocationId");
        if (Object.hasOwn(state.pendingTools, id)) throw failure("RUN_TOOL_STATE_INVALID", "A tool invocation is already pending.");
        Object.defineProperty(state.pendingTools, id, { value: { tool: String(event.tool ?? "unknown"), startSequence: event.sequence }, enumerable: true, configurable: true, writable: true });
      }
      break;
    case "tool-end": {
      const id = event.invocationId === undefined ? undefined : identity(event.invocationId, "invocationId");
      state.counters.toolCalls++; if (event.ok === false) state.counters.toolErrors++;
      if (id !== undefined) delete state.pendingTools[id];
      break;
    }
    case "context-compacted": {
      const tx = event.transaction;
      if (!tx || typeof tx !== "object" || !Array.isArray(tx.sourceMessageIds) || !tx.sourceMessageIds.length
        || tx.sourceMessageIds.some((id) => typeof id !== "string" || !id || id.length > 200) || typeof tx.sourceHash !== "string"
        || !Number.isFinite(tx.beforeEstimate) || !Number.isFinite(tx.afterEstimate) || tx.afterEstimate < 0 || tx.afterEstimate >= tx.beforeEstimate) throw failure("RUN_COMPACTION_INVALID", "A committed compaction requires source provenance and a smaller projection.");
      const item = { compactionId: identity(tx.compactionId, "compactionId"), sourceHash: tx.sourceHash, policyVersion: tx.policyVersion,
        beforeEstimate: tx.beforeEstimate, afterEstimate: tx.afterEstimate, sourceMessageCount: tx.sourceMessageIds.length, replacementMessageId: tx.replacementMessageId };
      state.lastCompaction = item; state.counters.compactions++; break;
    }
    // Legacy model-call is tracer diagnostics: never add its usage again.
    default: break;
  }
}

function validateSeed(state) {
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.watermark) || state.watermark < 0
    || !Number.isSafeInteger(state.eventCount) || state.eventCount < 0 || state.eventCount > MAX_EVENTS
    || !state.eventIndex || typeof state.eventIndex !== "object" || Array.isArray(state.eventIndex)
    || !state.attempts || typeof state.attempts !== "object" || Array.isArray(state.attempts)
    || !state.pendingTools || typeof state.pendingTools !== "object" || Array.isArray(state.pendingTools)
    || !state.counters || typeof state.counters !== "object" || Array.isArray(state.counters)
    || Object.keys(state.eventIndex).length !== state.eventCount || Object.keys(state.attempts).length > MAX_ATTEMPTS
    || typeof state.projectionComplete !== "boolean" || typeof state.requestSnapshotsComplete !== "boolean" || typeof state.usageComplete !== "boolean"
    || !Number.isSafeInteger(state.usageWatermark) || state.usageWatermark < 0 || state.usageWatermark > state.watermark) throw failure("RUN_EVENT_SEED_INVALID", "The run projection seed is incompatible or incomplete.");
  const positions = new Set();
  for (const entry of Object.values(state.eventIndex)) {
    if (!entry || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence > state.watermark || typeof entry.hash !== "string" || positions.has(entry.sequence)) throw failure("RUN_EVENT_SEED_INVALID", "The run projection identity index is invalid.");
    positions.add(entry.sequence);
  }
  if (state.projectionComplete && state.eventCount !== state.watermark) throw failure("RUN_EVENT_SEED_INVALID", "A complete projection requires every event identity.");
  for (const key of COUNTERS) if (!Number.isSafeInteger(state.counters[key]) || state.counters[key] < 0) throw failure("RUN_EVENT_SEED_INVALID", "Run counters must be finite nonnegative integers.");
  normalizeUsage(state.usage); normalizeUsage(state.attemptUsage);
}
function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event) || event.schemaVersion !== 1 || typeof event.type !== "string" || !event.type
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw failure("RUN_EVENT_INVALID", "A run event requires a versioned contiguous envelope.");
  identity(event.eventId, "eventId");
}
function identity(value, label, max = 200) { if (typeof value !== "string" || !value || value.length > max) throw failure("RUN_EVENT_INVALID", label + " must be a bounded nonempty string."); return value; }
function normalizeUsage(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("RUN_EVENT_USAGE_INVALID", "Usage must be an object of finite nonnegative numbers.");
  const valid = (number) => { if (number === undefined) return 0; if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw failure("RUN_EVENT_USAGE_INVALID", "Usage must contain finite nonnegative numbers."); return number; };
  const promptTokens = valid(value?.promptTokens ?? value?.prompt_tokens), completionTokens = valid(value?.completionTokens ?? value?.completion_tokens);
  return { promptTokens, completionTokens, totalTokens: valid(value?.totalTokens ?? value?.total_tokens ?? promptTokens + completionTokens) };
}
function addUsage(left, right) { const result = Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + right[key]])); normalizeUsage(result); return result; }
function snapshot(value) {
  try { return JSON.parse(JSON.stringify(value, (_key, item) => { if (["function", "symbol", "bigint"].includes(typeof item) || typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-JSON data"); return item; })); }
  catch { throw failure("RUN_EVENT_INVALID", "Run projection data must be finite JSON."); }
}
function failure(code, message, details) { return Object.assign(new Error(message), { code, ...details }); }
