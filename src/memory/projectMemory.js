import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_MEMORY_ITEMS = 80;

export async function loadProjectMemory(store) {
  if (!store?.projectDir) return emptyMemory();
  try {
    const parsed = JSON.parse(await readFile(memoryPath(store), "utf8"));
    return {
      schemaVersion: 1,
      scope: "project",
      facts: normalizeItems(parsed.facts, { scope: "project", kind: "fact" }),
      decisions: normalizeItems(parsed.decisions, { scope: "project", kind: "decision" }),
      failures: normalizeItems(parsed.failures, { scope: "project", kind: "failure" }),
    };
  } catch {
    return emptyMemory();
  }
}

export async function recordProjectMemory(store, entry) {
  if (!store?.projectDir || !entry) return undefined;
  const memory = await loadProjectMemory(store);
  const now = new Date().toISOString();
  if (entry.projectFact) memory.facts.unshift(memoryItem({ at: now, text: entry.projectFact, scope: "project", kind: "fact", entry }));
  if (entry.decision) memory.decisions.unshift(memoryItem({ at: now, text: entry.decision, scope: "project", kind: "decision", entry }));
  if (entry.failure) memory.failures.unshift(memoryItem({ at: now, text: entry.failure, scope: "project", kind: "failure", entry }));
  memory.facts = dedupe(memory.facts).slice(0, MAX_MEMORY_ITEMS);
  memory.decisions = dedupe(memory.decisions).slice(0, MAX_MEMORY_ITEMS);
  memory.failures = dedupe(memory.failures).slice(0, MAX_MEMORY_ITEMS);
  await mkdir(store.projectDir, { recursive: true });
  await writeFile(memoryPath(store), JSON.stringify(memory, null, 2) + "\n", "utf8");
  return memory;
}

export function memoryContextMessage(memory) {
  return projectMemoryContextMessage(memory);
}

export function projectMemoryContextMessage(memory) {
  if (!memory || (!memory.facts.length && !memory.decisions.length && !memory.failures.length)) return undefined;
  return {
    role: "system",
    content: [
      "Project memory (long-term, project-scoped):",
      section("Facts", memory.facts),
      section("Decisions", memory.decisions),
      section("Prior failures", memory.failures),
    ].join("\n"),
  };
}

export async function loadLongTermMemory(store) {
  if (!store) return emptyLongTermMemory();
  try {
    const parsed = JSON.parse(await readFile(longTermMemoryPath(store), "utf8"));
    return {
      schemaVersion: 1,
      scope: "global",
      preferences: normalizeItems(parsed.preferences, { scope: "global", kind: "preference" }),
      facts: normalizeItems(parsed.facts, { scope: "global", kind: "fact" }),
      decisions: normalizeItems(parsed.decisions, { scope: "global", kind: "decision" }),
    };
  } catch {
    return emptyLongTermMemory();
  }
}

export async function recordLongTermMemory(store, entry) {
  if (!store || !entry) return undefined;
  const memory = await loadLongTermMemory(store);
  const now = new Date().toISOString();
  if (entry.preference || entry.userPreference) {
    memory.preferences.unshift(memoryItem({ at: now, text: entry.preference ?? entry.userPreference, scope: "global", kind: "preference", entry }));
  }
  if (entry.fact) memory.facts.unshift(memoryItem({ at: now, text: entry.fact, scope: "global", kind: "fact", entry }));
  if (entry.decision) memory.decisions.unshift(memoryItem({ at: now, text: entry.decision, scope: "global", kind: "decision", entry }));
  memory.preferences = dedupe(memory.preferences).slice(0, MAX_MEMORY_ITEMS);
  memory.facts = dedupe(memory.facts).slice(0, MAX_MEMORY_ITEMS);
  memory.decisions = dedupe(memory.decisions).slice(0, MAX_MEMORY_ITEMS);
  await mkdir(dirname(longTermMemoryPath(store)), { recursive: true });
  await writeFile(longTermMemoryPath(store), JSON.stringify(memory, null, 2) + "\n", "utf8");
  return memory;
}

export function longTermMemoryContextMessage(memory) {
  if (!memory || (!memory.preferences.length && !memory.facts.length && !memory.decisions.length)) return undefined;
  return {
    role: "system",
    content: [
      "Global long-term memory (cross-project):",
      section("User preferences", memory.preferences),
      section("Facts", memory.facts),
      section("Decisions", memory.decisions),
    ].join("\n"),
  };
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
  return { schemaVersion: 1, scope: "project", facts: [], decisions: [], failures: [] };
}

function emptyLongTermMemory() {
  return { schemaVersion: 1, scope: "global", preferences: [], facts: [], decisions: [] };
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

function memoryItem({ at, text, scope, kind, entry = {}, source, sourceRunId, confidence, expiresAt }) {
  const value = String(text ?? "").trim();
  if (!value) return undefined;
  return {
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

function section(title, items) {
  if (!items.length) return title + ": none";
  return title + ":\n" + items.slice(0, 12).map((item) => "- " + item.text).join("\n");
}
