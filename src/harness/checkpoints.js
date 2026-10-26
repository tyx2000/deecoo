import { createRouteIdentity } from "../llm/prepareRequest.js";
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
export function createCheckpointWriter({ store, sessionId, identity, task, runId = randomUUID(), strict = false }) {
  const ownership = Promise.resolve().then(() => store.claimTaskOwner?.(sessionId, { runId, taskId: runId }));
  let queue = ownership;
  let lastError, lastSavedStep;
  let writeFailures = 0;
  return {
    runId,
    ready() { return ownership; },
    save(snapshot) {
      const value = structuredClone({ ...snapshot, metadata: { version: 1, runId, task, ...identity } });
      const operation = queue.then(async () => { await store.saveCheckpoint(sessionId, value); lastSavedStep = value.step; });
      queue = operation.catch((error) => { lastError = error; writeFailures++; });
      return strict ? operation : queue;
    },
    diagnostics: () => ({ writeFailures, lastSavedStep, ...(lastError ? { error: lastError.message, code: lastError.code ?? "CHECKPOINT_PERSIST_FAILED" } : {}) }),
    async flush() { try { await queue; return lastError; } finally { await store.releaseTaskOwner?.(sessionId, runId); } },
    async clear() { try { await queue; await store.clearCheckpoint?.(sessionId, { runId }); } finally { await store.releaseTaskOwner?.(sessionId, runId); } },
  };
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
  next.messages.push({ role: "user", content: "Continue the interrupted task from current workspace state. Prior verification is stale; inspect before editing. Do not automatically repeat pending calls." });
  return next;
}
