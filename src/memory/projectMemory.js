import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_MEMORY_ITEMS = 80;

export async function loadProjectMemory(store) {
  if (!store?.projectDir) return emptyMemory();
  try {
    const parsed = JSON.parse(await readFile(memoryPath(store), "utf8"));
    return {
      schemaVersion: 1,
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      failures: Array.isArray(parsed.failures) ? parsed.failures : [],
    };
  } catch {
    return emptyMemory();
  }
}

export async function recordProjectMemory(store, entry) {
  if (!store?.projectDir || !entry) return undefined;
  const memory = await loadProjectMemory(store);
  const now = new Date().toISOString();
  if (entry.projectFact) memory.facts.unshift({ at: now, text: entry.projectFact });
  if (entry.decision) memory.decisions.unshift({ at: now, text: entry.decision });
  if (entry.failure) memory.failures.unshift({ at: now, text: entry.failure });
  memory.facts = dedupe(memory.facts).slice(0, MAX_MEMORY_ITEMS);
  memory.decisions = dedupe(memory.decisions).slice(0, MAX_MEMORY_ITEMS);
  memory.failures = dedupe(memory.failures).slice(0, MAX_MEMORY_ITEMS);
  await mkdir(store.projectDir, { recursive: true });
  await writeFile(memoryPath(store), JSON.stringify(memory, null, 2) + "\n", "utf8");
  return memory;
}

export function memoryContextMessage(memory) {
  if (!memory || (!memory.facts.length && !memory.decisions.length && !memory.failures.length)) return undefined;
  return {
    role: "system",
    content: [
      "Long-term project memory:",
      section("Facts", memory.facts),
      section("Decisions", memory.decisions),
      section("Prior failures", memory.failures),
    ].join("\n"),
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
  return { schemaVersion: 1, facts: [], decisions: [], failures: [] };
}

function memoryPath(store) {
  return join(store.projectDir, "memory.json");
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
