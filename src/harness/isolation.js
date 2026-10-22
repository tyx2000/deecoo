// Concurrent-task isolation. Config is applied by mutating the global process.env, so two
// tasks in one process would clobber each other's environment and cwd. This provides a
// serialized, self-restoring overlay so a task can run with its own env/cwd without leaking
// into globals or racing a sibling task.

// Empty overlays may share the ambient environment, while any overlay/cwd
// mutation waits for all such readers and excludes new readers until restored.
const globalIsolationGate = createEnvironmentGate();

export function createTaskContext({ env = {}, cwd } = {}) {
  return { env: { ...env }, cwd, id: Symbol("task-context") };
}

// Run `fn` with the given env overlay applied to process.env and restored afterward. Serialized
// through a shared reader/writer gate. Empty overlays remain concurrent with
// each other, but cannot observe another task's temporary environment.
export async function withIsolatedEnv(overlay = {}, fn) {
  overlay ??= {};
  return globalIsolationGate.run(async () => {
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
  }, { exclusive: Object.keys(overlay).length > 0 });
}

// Run `fn` in a specific working directory, restoring the previous cwd afterward. Serialized so
// two tasks cannot interleave chdir calls.
export async function withIsolatedCwd(cwd, fn) {
  if (!cwd) return fn();
  return globalIsolationGate.run(async () => {
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      return await fn();
    } finally {
      process.chdir(previous);
    }
  }, { exclusive: true });
}

function createEnvironmentGate() {
  let readers = 0;
  let writer = false;
  const queue = [];
  const drain = () => {
    if (writer || !queue.length) return;
    if (queue[0].exclusive && readers) return;
    do {
      const next = queue.shift();
      if (next.exclusive) writer = true; else readers += 1;
      next.resolve(() => { if (next.exclusive) writer = false; else readers -= 1; drain(); });
    } while (!writer && queue.length && !queue[0].exclusive);
  };
  return { async run(fn, { exclusive = false } = {}) {
    const release = await new Promise((resolve) => { queue.push({ exclusive, resolve }); drain(); });
    try { return await fn(); } finally { release(); }
  } };
}
