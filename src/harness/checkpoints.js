import { createRouteIdentity } from "../llm/prepareRequest.js";
import { sourceEvidenceRevision } from "./acceptance.js";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export async function checkpointIdentity({ cwd, model, tools, taskSpec, config, client }) {
  const identity = { workspace: await realpath(resolve(cwd)), model,
    permissionMode: tools.getPermissionMode?.() ?? "unspecified",
    mayWrite: taskSpec?.mayWrite !== false };
  if (config !== undefined || client !== undefined) {
    identity.identityVersion = 2;
    identity.routeIdentity = createRouteIdentity({ config: config ?? {}, client, model, tools: tools.schemas ?? [] });
  }
  return identity;
}

// One writer per task; callers may enqueue without awaiting, but completion/clear
// always waits for the queue. Store writes are atomic and ordered as well.
// Exhausted storage capacity is not a write failure: the last checkpoint stays the resumable
// one, the downgrade is recorded, and the run continues without claiming newer state was saved.
export function createCheckpointWriter({ store, sessionId, identity, task, runId = randomUUID(), strict = false, onDowngrade }) {
  const ownership = Promise.resolve().then(() => store.claimTaskOwner?.(sessionId, { runId, taskId: runId }));
  let queue = ownership;
  let lastError, lastSavedStep, latestStep, downgrade;
  let writeFailures = 0, downgrades = 0;
  return {
    runId,
    ready() { return ownership; },
    save(snapshot) {
      const value = structuredClone({ ...checkpointProjection(snapshot), metadata: { version: 1, runId, task, ...identity } });
      const operation = queue.then(async () => {
        latestStep = value.step;
        try { await store.saveCheckpoint(sessionId, value); }
        catch (error) {
          if (error?.code !== "STORAGE_CAPACITY") throw error;
          downgrades++;
          downgrade = { code: error.code, failedStep: value.step, lastSavedStep, at: new Date().toISOString() };
          try { await store.recordCheckpointDowngrade?.(sessionId, { runId, failedStep: value.step, code: error.code }); }
          catch (markerError) { downgrade.markerError = markerError.message; }
          onDowngrade?.(structuredClone(downgrade));
          return;
        }
        lastSavedStep = value.step;
        downgrade = undefined;
      });
      queue = operation.catch((error) => { lastError = error; writeFailures++; });
      return strict ? operation : queue;
    },
    diagnostics: () => ({ writeFailures, lastSavedStep, latestStep, persistence: downgrade ? "degraded" : "durable",
      ...(downgrades ? { downgrades } : {}), ...(downgrade ? { downgrade: structuredClone(downgrade) } : {}),
      ...(lastError ? { error: lastError.message, code: lastError.code ?? "CHECKPOINT_PERSIST_FAILED" } : {}) }),
    async flush() { try { await queue; return lastError; } finally { await store.releaseTaskOwner?.(sessionId, runId); } },
    async clear() { try { await queue; await store.clearCheckpoint?.(sessionId, { runId }); } finally { await store.releaseTaskOwner?.(sessionId, runId); } },
  };
}

// Resume rebuilds the process controller, and a file read taken before the latest workspace
// mutation can never again be source evidence, so neither copy is persisted.
export function checkpointProjection(snapshot) {
  const { processController: _discardedOnResume, ...value } = snapshot ?? {};
  if (Array.isArray(value.effects?.events)) {
    const settled = sourceEvidenceRevision(value.effects.events, value.verification);
    value.effects = { ...value.effects, events: value.effects.events.map((event) => event?.type === "file-read" && typeof event.content === "string" && event.revision < settled
      ? Object.assign(Object.fromEntries(Object.entries(event).filter(([key]) => key !== "content")), { contentOmitted: "superseded" }) : event) };
  }
  return value;
}

export function validateCheckpoint(checkpoint, identity) {
  if (!checkpoint?.metadata || checkpoint.metadata.version !== 1) throw new Error("Checkpoint has no compatible resume metadata.");
  for (const field of ["workspace", "model", "permissionMode", "mayWrite"]) {
    if (checkpoint.metadata[field] !== identity[field]) throw new Error("Checkpoint cannot resume with changed " + field + ".");
  }
  if (identity.identityVersion === 2) {
    if (checkpoint.metadata.identityVersion !== 2 || !checkpoint.metadata.routeIdentity) throw Object.assign(new Error("Checkpoint lacks a route-bound identity; start a new task instead of resuming unverifiable legacy routing."), { code: "CHECKPOINT_ROUTE_IDENTITY_MISSING" });
    for (const field of ["version", "provider", "protocol", "model", "endpointHash", "toolsSchemaFingerprint", "hash"]) {
      if (checkpoint.metadata.routeIdentity[field] !== identity.routeIdentity[field]) throw Object.assign(new Error("Checkpoint cannot resume with changed route " + field + "."), { code: "CHECKPOINT_ROUTE_IDENTITY_CHANGED" });
    }
  } else if (checkpoint.metadata.identityVersion === 2) {
    throw Object.assign(new Error("A route-bound checkpoint requires route-aware validation."), { code: "CHECKPOINT_ROUTE_IDENTITY_REQUIRED" });
  }
  if (!Array.isArray(checkpoint.messages) || !Number.isInteger(checkpoint.step)) throw new Error("Checkpoint state is incomplete.");
  return checkpoint;
}

export function prepareCheckpointResume(checkpoint) {
  const next = structuredClone(checkpoint);
  // Never replay a pending side effect after a crash. The model must inspect
  // current files and explicitly issue a new call if more work is needed.
  const answered = new Set(next.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const message of [...next.messages]) {
    for (const call of message.tool_calls ?? []) {
      if (!answered.has(call.id)) next.messages.push({ role: "tool", tool_call_id: call.id,
        content: JSON.stringify({ ok: false, code: "INTERRUPTED_OUTCOME_UNKNOWN", error: "This call may have completed before interruption. Inspect the workspace before deciding the next action; it will not be replayed automatically." }) });
    }
  }
  // Files can change outside this process while stopped. Preserve history, but
  // invalidate reusable observations and prior verification on every resume.
  next.processController = undefined;
  const revision = (next.effects?.revision ?? next.verification?.workspaceRevision ?? 0) + 1;
  next.effects = { ...(next.effects ?? { version: 1, events: [] }), revision };
  if (next.verification) next.verification = { ...next.verification, workspaceRevision: revision,
    status: next.verification.evidence?.length ? "pending" : "not-run" };
  // The interrupted phase (often "verifying") and any acceptance verdict describe a workspace
  // that may no longer exist; a resumed run starts over from inspection.
  if (next.workflow) next.workflow = { ...next.workflow, status: "executing", phase: "resumed",
    transitions: [...(next.workflow.transitions ?? []), { from: next.workflow.status, to: "executing", phase: "resumed", type: "resumed", at: new Date().toISOString() }] };
  delete next.acceptance;
  const unsaved = next.persistence?.status === "degraded"
    ? " Storage capacity ran out after this checkpoint, so later progress was not saved; the workspace may contain changes from those steps." : "";
  next.messages.push({ role: "user", content: "Continue the interrupted task from current workspace state. Prior verification is stale; inspect before editing. Do not automatically repeat pending calls." + unsaved });
  return next;
}
