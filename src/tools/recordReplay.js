// Tool-side record/replay. The model replay client makes the LLM deterministic; this makes
// the tool results deterministic too, so a whole run (model + filesystem + shell) can be
// captured to a fixture and replayed with no side effects for golden-transcript regression.

import { createHash } from "node:crypto";

export function toolCallKey(name, args) {
  return name + "::" + createHash("sha256").update(stableStringify(args ?? {})).digest("hex").slice(0, 16);
}

// Wrap a tools runtime so every execute() request/result is appended to a fixture.
export function createRecordingTools(tools, fixture = []) {
  return {
    ...tools,
    async execute(name, args, options) {
      const result = await tools.execute(name, args, options);
      fixture.push({ key: toolCallKey(name, args), name, result: safeClone(result) });
      return result;
    },
    fixture,
  };
}

// Replay tool results from a fixture with no real execution. Falls back to queue order when a
// key is not found (strict throws instead).
export function createReplayTools(fixture = [], { schemas = [], strict = true } = {}) {
  const byKey = new Map();
  const queue = [...fixture];
  for (const entry of fixture) {
    if (entry?.key && !byKey.has(entry.key)) byKey.set(entry.key, entry.result);
  }

  return {
    schemas,
    workerSchemas: schemas,
    setWorkingSetProvider() {},
    getWorkingSetSummary() {
      return undefined;
    },
    setSubagentRuntime() {},
    resetTaskPermissions() {},
    createWorkerTools() {
      return { schemas, async execute(name, args, options) {
        return this.__replay(name, args, options);
      } };
    },
    async execute(name, args) {
      const key = toolCallKey(name, args);
      if (byKey.has(key)) return byKey.get(key);
      // Strict replay is keyed only — an unmatched call is a miss, never a wrong queued result.
      if (strict) return { ok: false, error: "No tool replay fixture for " + name, code: "REPLAY_MISS" };
      if (queue.length) return queue.shift().result;
      return { ok: true };
    },
  };
}

function safeClone(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value ?? null));
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
}
