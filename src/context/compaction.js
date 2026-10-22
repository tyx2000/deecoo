import { createHash, randomUUID } from "node:crypto";
import { measureContextMessages } from "./builder.js";

export const COMPACTION_POLICY_VERSION = "deterministic-state-v1";

// Message identities live beside the provider surface, never inside its wire
// messages. Source records are append-only; replacements are explicitly derived.
export function createContextState(messages, { saved, legacy = false } = {}) {
  if (!saved && legacy && messages?.some((message) => message?.role === "system" && String(message.content ?? "").startsWith("Run state summary (local context compaction):"))) {
    throw failure("CONTEXT_LEGACY_SUMMARY_UNVERIFIABLE", "This legacy checkpoint contains an unverifiable system-level compaction summary. Start a new task to establish traceable context; existing workspace files and the checkpoint are preserved.");
  }
  const state = saved ? clone(saved) : { version: 1, contextId: "ctx_" + randomUUID(), nextMessageSeq: 1,
    sourceCompleteness: legacy ? "legacy-prefix-unavailable" : "complete", liveMessageIds: [], transcript: [], compactions: [] };
  validateState(state);
  syncContextState(state, messages);
  return state;
}

export function syncContextState(state, messages) {
  if (!Array.isArray(messages)) throw failure("CONTEXT_STATE_INVALID", "A context surface must be an array.");
  const records = new Map(state.transcript.map((entry) => [entry.id, entry]));
  if (state.liveMessageIds.length > messages.length) throw changed();
  for (let index = 0; index < state.liveMessageIds.length; index++) {
    if (contextFingerprint(records.get(state.liveMessageIds[index])?.message) !== contextFingerprint(messages[index])) throw changed();
  }
  for (let index = state.liveMessageIds.length; index < messages.length; index++) {
    const id = state.contextId + ":m" + state.nextMessageSeq++;
    state.transcript.push({ id, kind: "source", message: clone(messages[index]) });
    state.liveMessageIds.push(id);
  }
  return state;
}

export function snapshotContextState(state, messages) {
  if (messages) syncContextState(state, messages);
  return clone(state);
}

export function planContextCompaction({ messages, contextState, start, end, replacement, protectedPrefixCount = 1,
  policyVersion = COMPACTION_POLICY_VERSION } = {}) {
  assertCapturedSurface(contextState, messages);
  if (policyVersion !== COMPACTION_POLICY_VERSION || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(protectedPrefixCount) || protectedPrefixCount < 1
    || start < protectedPrefixCount || start >= end || end > messages.length) throw failure("COMPACTION_RANGE_INVALID", "Invalid or protected compaction span.");
  if (!replacement || replacement.role !== "user" || typeof replacement.content !== "string") throw failure("COMPACTION_INVALID", "A deterministic compaction replacement must remain a user data message.");
  assertBalancedSpan(messages, start, end);
  const sourceMessageIds = contextState.liveMessageIds.slice(start, end);
  const source = messages.slice(start, end);
  const next = [...messages.slice(0, start), clone(replacement), ...messages.slice(end)];
  const beforeEstimate = measureContextMessages(source), afterEstimate = measureContextMessages([replacement]);
  if (afterEstimate >= beforeEstimate) throw failure("COMPACTION_NO_PROGRESS", "A compaction replacement must be strictly smaller than its complete source span.");
  return clone({ version: 1, compactionId: "cmp_" + randomUUID(), policyVersion, start, end, protectedPrefixCount,
    sourceMessageIds, sourceHash: sourceFingerprint(sourceMessageIds, source), surfaceHash: surfaceFingerprint(contextState.liveMessageIds, messages),
    beforeEstimate, afterEstimate, beforeTotalEstimate: measureContextMessages(messages), afterTotalEstimate: measureContextMessages(next),
    replacement: clone(replacement), replacementMessageId: contextState.contextId + ":m" + contextState.nextMessageSeq });
}

export function applyContextCompaction(contextState, messages, proposal) {
  // Recheck every condition before changing either projection. A stale async
  // proposal cannot silently replace newer observations or a different tail.
  assertCapturedSurface(contextState, messages);
  if (!proposal || proposal.version !== 1 || proposal.policyVersion !== COMPACTION_POLICY_VERSION
    || contextState.compactions.some((entry) => entry.compactionId === proposal.compactionId)) throw failure("COMPACTION_INVALID", "Unknown or already committed compaction proposal.");
  if (proposal.surfaceHash !== surfaceFingerprint(contextState.liveMessageIds, messages)) throw changed();
  const checked = planContextCompaction({ messages, contextState, start: proposal.start, end: proposal.end,
    replacement: proposal.replacement, protectedPrefixCount: proposal.protectedPrefixCount, policyVersion: proposal.policyVersion });
  for (const key of ["sourceHash", "beforeEstimate", "afterEstimate", "beforeTotalEstimate", "afterTotalEstimate", "replacementMessageId"]) {
    if (checked[key] !== proposal[key]) throw failure("COMPACTION_INVALID", "Compaction proof does not match its selected source.");
  }
  if (contextFingerprint(checked.sourceMessageIds) !== contextFingerprint(proposal.sourceMessageIds)) throw changed();
  const record = clone(proposal);
  const replacement = clone(record.replacement);
  const ids = [...contextState.liveMessageIds.slice(0, record.start), record.replacementMessageId, ...contextState.liveMessageIds.slice(record.end)];
  const next = [...messages.slice(0, record.start), replacement, ...messages.slice(record.end)];
  messages.splice(0, messages.length, ...next);
  contextState.liveMessageIds = ids;
  contextState.nextMessageSeq++;
  contextState.transcript.push({ id: record.replacementMessageId, kind: "replacement", compactionId: record.compactionId, message: clone(replacement) });
  contextState.compactions.push(record);
  return record;
}

export function contextFingerprint(value) {
  const stable = (item) => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().filter((key) => item[key] !== undefined).map((key) => [key, stable(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value ?? null))).digest("hex");
}

export function isBalancedContextBoundary(messages, at) {
  if (at < 0 || at > messages.length || messages[at]?.role === "tool") return false;
  for (let index = 0; index < at; index++) {
    if (!messages[index]?.tool_calls?.length) continue;
    const pending = new Set(messages[index].tool_calls.map((call) => call.id));
    let end = index + 1;
    while (end < messages.length && messages[end]?.role === "tool") { pending.delete(messages[end].tool_call_id); end++; }
    if (at > index && at < end || at >= end && pending.size && end === at) return false;
  }
  return true;
}

function assertBalancedSpan(messages, start, end) {
  if (!isBalancedContextBoundary(messages, start) || !isBalancedContextBoundary(messages, end)) throw failure("COMPACTION_UNBALANCED_TOOLS", "Compaction cannot split an assistant tool-call/result group.");
  for (let index = start; index < end; index++) {
    for (const call of messages[index]?.tool_calls ?? []) {
      if (!messages.slice(index + 1, end).some((message) => message.role === "tool" && message.tool_call_id === call.id)) throw failure("COMPACTION_UNBALANCED_TOOLS", "An unanswered tool call cannot be discarded by compaction.");
    }
  }
}

function validateState(state) {
  if (state?.version !== 1 || !/^ctx_[A-Za-z0-9-]+$/.test(state.contextId ?? "") || !Number.isSafeInteger(state.nextMessageSeq) || state.nextMessageSeq < 1
    || !Array.isArray(state.liveMessageIds) || !Array.isArray(state.transcript) || !Array.isArray(state.compactions)
    || !["complete", "legacy-prefix-unavailable", "filtered"].includes(state.sourceCompleteness)) throw failure("CONTEXT_STATE_INVALID", "Unsupported saved context state.");
  if (state.protectedPrefixCount !== undefined && (!Number.isSafeInteger(state.protectedPrefixCount) || state.protectedPrefixCount < 1 || state.protectedPrefixCount > state.liveMessageIds.length)
    || state.privacyFiltered !== undefined && typeof state.privacyFiltered !== "boolean"
    || state.sourceCompleteness === "filtered" && state.privacyFiltered !== true) throw failure("CONTEXT_STATE_INVALID", "Invalid saved context policy or filtering marker.");
  const records = new Map();
  let lastSequence = 0;
  for (const record of state.transcript) {
    if (!record || typeof record.id !== "string" || records.has(record.id) || !["source", "replacement"].includes(record.kind) || !record.message || typeof record.message !== "object") throw failure("CONTEXT_STATE_INVALID", "Invalid or duplicate transcript message.");
    const sequence = Number(record.id.slice(state.contextId.length + 2));
    if (!record.id.startsWith(state.contextId + ":m") || !Number.isSafeInteger(sequence) || sequence <= lastSequence) throw failure("CONTEXT_STATE_INVALID", "Transcript identities are not in append order.");
    lastSequence = sequence;
    records.set(record.id, record);
  }
  if (state.nextMessageSeq <= lastSequence) throw failure("CONTEXT_STATE_INVALID", "The next message identity would overwrite history.");
  if (new Set(state.liveMessageIds).size !== state.liveMessageIds.length || state.liveMessageIds.some((id) => !records.has(id))) throw failure("CONTEXT_STATE_INVALID", "Saved live message identities are incomplete.");
  const transactions = new Set();
  for (const transaction of state.compactions) {
    const source = transaction.sourceMessageIds?.map((id) => records.get(id)?.message);
    const replacement = records.get(transaction.replacementMessageId);
    if (transaction.version !== 1 || transaction.policyVersion !== COMPACTION_POLICY_VERSION || typeof transaction.compactionId !== "string" || transactions.has(transaction.compactionId)
      || !Array.isArray(source) || !source.length || new Set(transaction.sourceMessageIds).size !== source.length || source.some((message) => !message)
      || replacement?.kind !== "replacement" || replacement.compactionId !== transaction.compactionId || contextFingerprint(replacement.message) !== contextFingerprint(transaction.replacement)) throw failure("CONTEXT_STATE_INVALID", "Saved compaction source or replacement is inconsistent.");
    transactions.add(transaction.compactionId);
    if (state.sourceCompleteness !== "filtered" && !state.privacyFiltered && transaction.sourceHash !== sourceFingerprint(transaction.sourceMessageIds, source)) throw failure("CONTEXT_SOURCE_CHANGED", "Saved compaction source does not match its proof.");
    if (state.sourceCompleteness !== "filtered" && !state.privacyFiltered && (transaction.beforeEstimate !== measureContextMessages(source) || transaction.afterEstimate !== measureContextMessages([transaction.replacement]) || transaction.afterEstimate >= transaction.beforeEstimate)) throw failure("CONTEXT_STATE_INVALID", "Saved compaction progress does not match its source.");
  }
  for (const record of state.transcript) if (record.kind === "replacement" && !state.compactions.some((entry) => entry.compactionId === record.compactionId && entry.replacementMessageId === record.id)) throw failure("CONTEXT_STATE_INVALID", "A derived transcript message has no matching compaction proof.");
}
function sourceFingerprint(ids, messages) { return contextFingerprint(ids.map((id, index) => ({ id, message: messages[index] }))); }
function surfaceFingerprint(ids, messages) { return sourceFingerprint(ids, messages); }
function assertCapturedSurface(state, messages) {
  if (!Array.isArray(messages) || state.liveMessageIds.length !== messages.length) throw changed();
  const records = new Map(state.transcript.map((entry) => [entry.id, entry.message]));
  if (state.liveMessageIds.some((id, index) => contextFingerprint(records.get(id)) !== contextFingerprint(messages[index]))) throw changed();
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function changed() { return failure("CONTEXT_SOURCE_CHANGED", "The context source changed after it was captured; an old summary cannot replace it."); }
function failure(code, message) { return Object.assign(new Error(message), { code }); }
