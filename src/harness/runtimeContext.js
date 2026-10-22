import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

// Explicit per-run state. Provider credentials remain in this object and the
// provider adapter; execution backends receive their own sanitized environment.
export async function createRuntimeContext({ cwd, env = process.env, overlay = {}, runId = randomUUID(), taskId = randomUUID(), ...options }) {
  const effectiveEnv = { ...env };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete effectiveEnv[key]; else effectiveEnv[key] = String(value);
  }
  return { ...options, runId, taskId, cwd: await realpath(resolve(cwd)), env: effectiveEnv, createdAt: Date.now() };
}
