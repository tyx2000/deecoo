import { randomUUID } from "node:crypto";
import { redact } from "../observability/audit.js";
import { createRunProjection, fingerprint } from "./runProjection.js";

export function createRunEventStream({ runId, taskId, onEvent, persist, secretRegistry, resumeState, startSequence, includeSnapshots = true, maxEventBytes = 8 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1024) throw new TypeError("A run event byte limit must be an integer of at least 1024.");
  if (resumeState && (resumeState.version !== 1 || resumeState.runId !== runId || resumeState.taskId !== taskId)) throw failure("RUN_EVENT_SEED_INVALID", "The journal checkpoint does not belong to this run and task.");
  const initial = resumeState?.sequence ?? startSequence ?? 0;
  if (!Number.isSafeInteger(initial) || initial < 0) throw failure("RUN_EVENT_SEED_INVALID", "The journal start sequence is invalid.");
  if (resumeState && (resumeState.projection?.watermark !== initial || startSequence !== undefined && startSequence !== initial)) throw failure("RUN_EVENT_SEED_INVALID", "The journal sequence does not match its saved projection.");
  const projection = createRunProjection({ seed: resumeState?.projection, runId, taskId, startSequence: initial });
  let sequence = initial, queue = Promise.resolve(), lastError = resumeState?.error, observerError = resumeState?.observerError, gap = resumeState?.gap;
  const historyMissing = resumeState?.historyMissing;
  let persistedWatermark = resumeState?.persistedWatermark ?? 0;
  if (persistedWatermark > initial || !Number.isSafeInteger(persistedWatermark) || persistedWatermark < 0) throw failure("RUN_EVENT_SEED_INVALID", "The durable journal watermark is invalid.");
  if (initial && !resumeState) gap ??= { code: "RUN_EVENT_PREFIX_MISSING", sequence: 1 };
  const safeMessage = (error) => redact(String(error?.message ?? error ?? "Unknown journal error"), { secretRegistry, maxTextChars: 1000 });
  const status = () => {
    const value = projection.snapshot();
    const journalComplete = Boolean(persist && !gap && !historyMissing && persistedWatermark === sequence && value.projectionComplete);
    return { events: sequence, error: lastError, watermark: sequence, persistedWatermark, projectionComplete: value.projectionComplete,
      requestSnapshotsComplete: value.requestSnapshotsComplete, journalComplete, rebuildable: journalComplete && value.requestSnapshotsComplete,
      transcriptSource: "contextState", ...(gap ? { gap } : {}), ...(historyMissing ? { historyMissing } : {}), ...(observerError ? { observerError } : {}) };
  };
  return {
    emit(event) {
      let record, durable;
      try {
        record = jsonSnapshot(filterKeys(redact({ ...event, schemaVersion: 1, eventId: randomUUID(), runId, taskId, sequence: sequence + 1, at: Date.now() }, { secretRegistry, maxTextChars: Infinity }), secretRegistry), maxEventBytes);
        if (record.type === "model-attempt-start") {
          if (record.request) record.requestSnapshotHash = fingerprint(record.request);
          if (!includeSnapshots) record.snapshotOmitted = true;
        }
        durable = jsonSnapshot(record, maxEventBytes);
        if (durable.snapshotOmitted) delete durable.request;
        projection.append(durable); sequence++;
        freeze(record); freeze(durable);
      } catch (error) {
        lastError = safeMessage(error); gap ??= { code: error.code ?? "RUN_EVENT_INVALID", sequence: sequence + 1 };
        return Promise.resolve(status());
      }
      queue = queue.then(async () => {
        try { await onEvent?.(record); } catch (error) { observerError = safeMessage(error); lastError = observerError; }
        if (persist) try { await persist(durable); if (!gap && persistedWatermark === durable.sequence - 1) persistedWatermark = durable.sequence; }
        catch (error) { lastError = safeMessage(error); gap ??= { code: error.code ?? "RUN_EVENT_PERSIST_FAILED", sequence: durable.sequence }; }
      });
      return queue;
    },
    async flush() { await queue; return status(); },
    snapshot: status,
    projection: () => projection.snapshot(),
    checkpoint() { return { version: 1, runId, taskId, sequence, persistedWatermark, projection: projection.snapshot(),
      ...(gap ? { gap: structuredClone(gap) } : {}), ...(historyMissing ? { historyMissing: structuredClone(historyMissing) } : {}), ...(lastError ? { error: lastError } : {}), ...(observerError ? { observerError } : {}) }; },
  };
}

function jsonSnapshot(value, maxBytes) {
  try {
    const text = JSON.stringify(value, (_key, item) => { if (["function", "symbol", "bigint"].includes(typeof item) || typeof item === "number" && !Number.isFinite(item)) throw failure("RUN_EVENT_INVALID", "Run event data must be finite JSON."); return item; });
    if (Buffer.byteLength(text) > maxBytes) throw failure("RUN_EVENT_TOO_LARGE", "The diagnostic event exceeds its configured byte limit.");
    return JSON.parse(text);
  } catch (error) { if (error.code?.startsWith("RUN_EVENT_")) throw error; throw failure("RUN_EVENT_INVALID", "Run event data must be finite JSON."); }
}
function freeze(value) { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
function filterKeys(value, secretRegistry) {
  if (Array.isArray(value)) return value.map((item) => filterKeys(item, secretRegistry));
  if (!value || typeof value !== "object") return value;
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const safe = redact(key, { secretRegistry, maxTextChars: Infinity });
    let unique = safe, suffix = 1;
    while (Object.hasOwn(out, unique)) unique = safe + "#" + ++suffix;
    out[unique] = filterKeys(item, secretRegistry);
  }
  return Object.fromEntries(Object.entries(out));
}
function failure(code, message) { return Object.assign(new Error(message), { code }); }
