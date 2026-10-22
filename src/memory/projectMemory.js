import { createHash } from "node:crypto";
import { readJsonFile, updateJsonFile } from "../storage/atomic.js";
import { canPersist } from "../storage/governance.js";
import { redact } from "../observability/audit.js";
import { dirname, join } from "node:path";
import { dataContextMessage } from "../harness/contentTrust.js";

const MAX_MEMORY_ITEMS = 80;

export async function loadProjectMemory(store) { return loadMemory(store, "project"); }

export async function recordProjectMemory(store, entry) {
  if (!store?.projectDir || !entry) return undefined;
  return mutateMemory(store, "project", (memory) => {
    const now = new Date().toISOString();
    const safe = redact(entry, { secretRegistry: store.secretRegistry });
    if (safe.projectFact) memory.facts.unshift(memoryItem({ at: now, text: safe.projectFact, scope: "project", kind: "fact", entry: safe }));
    if (safe.decision) memory.decisions.unshift(memoryItem({ at: now, text: safe.decision, scope: "project", kind: "decision", entry: safe }));
    if (safe.failure) memory.failures.unshift(memoryItem({ at: now, text: safe.failure, scope: "project", kind: "failure", entry: safe }));
    return limitMemory(memory);
  });
}

export function memoryContextMessage(memory) {
  return projectMemoryContextMessage(memory);
}

export function projectMemoryContextMessage(memory) {
  if (!memory) return undefined;
  const facts = activeMemoryItems(memory.facts);
  const decisions = activeMemoryItems(memory.decisions);
  const failures = activeMemoryItems(memory.failures);
  if (!facts.length && !decisions.length && !failures.length) return undefined;
  return dataContextMessage({
    source: "project-memory",
    scope: "project",
    kind: "stored-memory",
    content: { title: "Project memory (long-term, project-scoped)", facts, decisions, failures },
  });
}

export async function loadLongTermMemory(store) { return loadMemory(store, "global"); }

export async function recordLongTermMemory(store, entry) {
  if (!store || !entry) return undefined;
  return mutateMemory(store, "global", (memory) => {
    const now = new Date().toISOString();
    const safe = redact(entry, { secretRegistry: store.secretRegistry });
    if (safe.preference || safe.userPreference) memory.preferences.unshift(memoryItem({ at: now, text: safe.preference ?? safe.userPreference, scope: "global", kind: "preference", entry: safe }));
    if (safe.fact) memory.facts.unshift(memoryItem({ at: now, text: safe.fact, scope: "global", kind: "fact", entry: safe }));
    if (safe.decision) memory.decisions.unshift(memoryItem({ at: now, text: safe.decision, scope: "global", kind: "decision", entry: safe }));
    return limitMemory(memory);
  });
}

export async function listMemory(store, { scope = "project", includeExpired = false, kind, now = Date.now() } = {}) {
  const scopes = scope === "all" ? ["project", "global"] : [assertScope(scope)];
  const out = [];
  for (const selected of scopes) {
    const memory = await loadMemory(store, selected);
    for (const key of memoryKeys(selected)) {
      for (const item of memory[key]) {
        const expired = Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) <= now;
        if ((!kind || item.kind === kind) && (includeExpired || !expired)) out.push({ ...item, expired });
      }
    }
  }
  return out;
}

export async function editMemory(store, { id, scope = "project", text, expiresAt, confidence } = {}) {
  assertScope(scope);
  if (!id) throw new Error("Memory id is required.");
  if (text !== undefined && !String(text).trim()) throw new Error("Memory text cannot be empty.");
  if (expiresAt !== undefined && expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) throw new Error("expiresAt must be an ISO date or null.");
  let edited;
  await mutateMemory(store, scope, (memory) => {
    for (const key of memoryKeys(scope)) memory[key] = memory[key].map((item) => {
      if (item.id !== id) return item;
      edited = { ...item, ...(text === undefined ? {} : { text: redact(String(text).trim().slice(0, 4000), { secretRegistry: store?.secretRegistry }) }),
        ...(expiresAt === undefined ? {} : { expiresAt: expiresAt ?? undefined }), ...(confidence === undefined ? {} : { confidence }), updatedAt: new Date().toISOString() };
      return edited;
    });
    return memory;
  });
  return edited;
}
export const updateMemory = editMemory;

export async function deleteMemory(store, { id, scope = "project" } = {}) {
  assertScope(scope);
  if (!id) throw new Error("Memory id is required.");
  let deleted = false;
  await mutateMemory(store, scope, (memory) => {
    for (const key of memoryKeys(scope)) memory[key] = memory[key].filter((item) => { if (item.id === id) { deleted = true; return false; } return true; });
    return memory;
  });
  return { id, scope, deleted };
}

export async function pruneMemory(store, { scope = "all", now = Date.now() } = {}) {
  const scopes = scope === "all" ? ["project", "global"] : [assertScope(scope)];
  const removed = [];
  for (const selected of scopes) await mutateMemory(store, selected, (memory) => {
    for (const key of memoryKeys(selected)) memory[key] = memory[key].filter((item) => {
      const expired = Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) <= now;
      if (expired) removed.push({ id: item.id, scope: selected });
      return !expired;
    });
    return memory;
  });
  return { removed };
}

async function loadMemory(store, scope) {
  if (!store || (scope === "project" && !store.projectDir)) return emptyFor(scope);
  if (!canPersist(store)) return structuredClone(store.volatileMemory?.get(scope) ?? emptyFor(scope));
  return readJsonFile(pathFor(store, scope), memoryReadOptions(scope));
}
async function mutateMemory(store, scope, updater) {
  if (!store || (scope === "project" && !store.projectDir)) return undefined;
  if (!canPersist(store)) {
    store.volatileMemory ??= new Map();
    const value = updater(await loadMemory(store, scope)); store.volatileMemory.set(scope, structuredClone(value)); return value;
  }
  return updateJsonFile(pathFor(store, scope), updater, { ...memoryReadOptions(scope), maxBytes: store.storagePolicy?.maxFileBytes ?? 1024 * 1024 });
}
function memoryReadOptions(scope) {
  return { fallback: () => emptyFor(scope), migrate: (parsed) => {
    if (!parsed || typeof parsed !== "object" || (parsed.schemaVersion ?? 1) > 2) return parsed;
    return { schemaVersion: 2, scope, ...Object.fromEntries(memoryKeys(scope).map((key) => [key, normalizeItems(parsed[key], { scope, kind: key === "preferences" ? "preference" : key.slice(0, -1) })])) };
  }, validate: (value) => value?.schemaVersion === 2 && value.scope === scope && memoryKeys(scope).every((key) => Array.isArray(value[key])) };
}
function limitMemory(memory) { for (const key of memoryKeys(memory.scope)) memory[key] = dedupe(memory[key]).slice(0, MAX_MEMORY_ITEMS); return memory; }
function pathFor(store, scope) { return scope === "global" ? longTermMemoryPath(store) : memoryPath(store); }
function emptyFor(scope) { return scope === "global" ? emptyLongTermMemory() : emptyMemory(); }
function memoryKeys(scope) { return scope === "global" ? ["preferences", "facts", "decisions"] : ["facts", "decisions", "failures"]; }
function assertScope(scope) { if (!["global", "project"].includes(scope)) throw new Error("Memory scope must be project, global, or all for list/prune."); return scope; }

export function longTermMemoryContextMessage(memory) {
  if (!memory) return undefined;
  const preferences = activeMemoryItems(memory.preferences);
  const facts = activeMemoryItems(memory.facts);
  const decisions = activeMemoryItems(memory.decisions);
  if (!preferences.length && !facts.length && !decisions.length) return undefined;
  return dataContextMessage({
    source: "long-term-memory",
    scope: "global",
    kind: "stored-memory",
    content: { title: "Global long-term memory (cross-project)", preferences, facts, decisions },
  });
}

export function memoryLayerSummary({ session, projectMemory, longTermMemory }) {
  return {
    sessionMemory: session
      ? {
          scope: "session",
          id: session.id,
          summaryPresent: Boolean(session.summary),
          recentTurns: Array.isArray(session.turns) ? session.turns.length : 0,
          artifacts: Array.isArray(session.artifacts) ? session.artifacts.length : 0,
        }
      : undefined,
    projectMemory: projectMemory
      ? {
          scope: "project",
          facts: projectMemory.facts.length,
          decisions: projectMemory.decisions.length,
          failures: projectMemory.failures.length,
        }
      : undefined,
    longTermMemory: longTermMemory
      ? {
          scope: "global",
          preferences: longTermMemory.preferences.length,
          facts: longTermMemory.facts.length,
          decisions: longTermMemory.decisions.length,
        }
      : undefined,
  };
}

export function summarizeRunForMemory({ task, result }) {
  const updates = [];
  if (result?.verification?.status === "failed") {
    updates.push({ failure: `Task "${task}" left verification failed.` });
  }
  if (result?.verification?.status === "failed-then-passed") {
    updates.push({ decision: `Task "${task}" fixed a failure and verification passed after rerun.` });
  }
  if (result?.reviewReport?.aggregation) {
    updates.push({ projectFact: `Review found ${result.reviewReport.aggregation.findingCount} structured finding(s).` });
  }
  return updates;
}

function emptyMemory() {
  return { schemaVersion: 2, scope: "project", facts: [], decisions: [], failures: [] };
}

function emptyLongTermMemory() {
  return { schemaVersion: 2, scope: "global", preferences: [], facts: [], decisions: [] };
}

function memoryPath(store) {
  return join(store.projectDir, "memory.json");
}

function longTermMemoryPath(store) {
  return join(memoryRoot(store), "long-term-memory.json");
}

function memoryRoot(store) {
  if (store.rootDir) return store.rootDir;
  if (store.memoryRoot) return store.memoryRoot;
  if (store.projectDir) return dirname(dirname(store.projectDir));
  return ".";
}

function normalizeItems(items, defaults) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => normalizeItem(item, defaults)).filter(Boolean);
}

function normalizeItem(item, defaults) {
  if (!item) return undefined;
  if (typeof item === "string") return memoryItem({ text: item, ...defaults });
  return memoryItem({
    id: item.id,
    updatedAt: item.updatedAt,
    at: item.at,
    text: item.text,
    scope: item.scope ?? defaults.scope,
    kind: item.kind ?? defaults.kind,
    source: item.source,
    sourceRunId: item.sourceRunId,
    confidence: item.confidence,
    expiresAt: item.expiresAt,
  });
}

function memoryItem({ id, updatedAt, at, text, scope, kind, entry = {}, source, sourceRunId, confidence, expiresAt }) {
  const value = String(text ?? "").trim().slice(0, 4000);
  if (!value) return undefined;
  return {
    id: id ?? createHash("sha256").update([scope, kind, at ?? "", value].join("\0")).digest("hex").slice(0, 24),
    updatedAt,
    at: at ?? new Date().toISOString(),
    scope,
    kind,
    text: value,
    source: entry.source ?? source ?? "run-summary",
    sourceRunId: entry.sourceRunId ?? sourceRunId,
    confidence: entry.confidence ?? confidence ?? "medium",
    expiresAt: entry.expiresAt ?? expiresAt,
  };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function activeMemoryItems(items) {
  const now = Date.now();
  return (Array.isArray(items) ? items : [])
    .filter((item) => {
      const expiry = Date.parse(item?.expiresAt);
      return !Number.isFinite(expiry) || expiry > now;
    })
    .slice(0, 12);
}
