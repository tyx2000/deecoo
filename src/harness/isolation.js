// Concurrent-task isolation. Config is applied by mutating the global process.env, so two
// tasks in one process would clobber each other's environment and cwd. This provides a
// serialized, self-restoring overlay so a task can run with its own env/cwd without leaking
// into globals or racing a sibling task.

import { createMutex } from "./mutex.js";

const globalIsolationMutex = createMutex();

export function createTaskContext({ env = {}, cwd } = {}) {
  return { env: { ...env }, cwd, id: Symbol("task-context") };
}

// Run `fn` with the given env overlay applied to process.env and restored afterward. Serialized
// through a shared mutex so concurrent tasks never observe each other's mutations.
export async function withIsolatedEnv(overlay = {}, fn) {
  return globalIsolationMutex.run(async () => {
    const applied = Object.keys(overlay);
    const saved = new Map();
    for (const key of applied) {
      saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
      if (overlay[key] === undefined) delete process.env[key];
      else process.env[key] = String(overlay[key]);
    }
    try {
      return await fn();
    } finally {
      for (const key of applied) {
        const prior = saved.get(key);
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
      }
    }
  });
}

// Run `fn` in a specific working directory, restoring the previous cwd afterward. Serialized so
// two tasks cannot interleave chdir calls.
export async function withIsolatedCwd(cwd, fn) {
  if (!cwd) return fn();
  return globalIsolationMutex.run(async () => {
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      return await fn();
    } finally {
      process.chdir(previous);
    }
  });
}
