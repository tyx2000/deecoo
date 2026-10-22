// Tool-side record/replay. The model replay client makes the LLM deterministic; this makes
// the tool results deterministic too, so a whole run (model + filesystem + shell) can be
// captured to a fixture and replayed with no side effects for golden-transcript regression.

import { createHash } from "node:crypto";
import { createReplayEntries } from "../harness/replayEntries.js";

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
  const entries = createReplayEntries(fixture, "key");

  const replayExecute = async (name, args) => {
    const key = toolCallKey(name, args);
    const match = entries.take(key, { fallback: !strict });
    if (match) return match.result;
    // Strict replay is keyed only — an unmatched call is a miss, never a wrong queued result.
    if (strict) return { ok: false, error: "No tool replay fixture for " + name, code: "REPLAY_MISS" };
    return { ok: true };
  };

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
      return { schemas, execute: replayExecute };
    },
    execute: replayExecute,
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
