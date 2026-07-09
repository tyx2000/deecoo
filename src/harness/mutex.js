// Minimal async mutex for guarding shared harness state (e.g. a process controller or
// settings file) when work runs concurrently. Acquisition is FIFO; run() wraps a critical
// section so callers cannot forget to release.

export function createMutex() {
  let tail = Promise.resolve();

  const acquire = () => {
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = tail.then(() => next);
    return previous.then(() => release);
  };

  return {
    acquire,
    async run(fn) {
      const release = await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
