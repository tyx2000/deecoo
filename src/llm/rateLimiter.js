// Shared rate limiter for all model requests in a task — the main agent and every dispatched
// worker go through one limiter, so a burst of parallel workers cannot independently hammer
// the provider. Enforces a concurrency cap, a minimum inter-request interval, and a shared
// cooldown that every caller respects after a 429.

export function createRateLimiter({ maxConcurrent = 4, minIntervalMs = 0, cooldownMs = 2000 } = {}) {
  let active = 0;
  let lastStart = 0;
  let cooldownUntil = 0;
  const waiters = [];

  const pump = () => {
    while (active < maxConcurrent && waiters.length) {
      const now = Date.now();
      const earliest = Math.max(cooldownUntil, lastStart + minIntervalMs);
      if (now < earliest) {
        setTimeout(pump, earliest - now);
        return;
      }
      const resolve = waiters.shift();
      active += 1;
      lastStart = Date.now();
      resolve();
    }
  };

  const acquire = () =>
    new Promise((resolve) => {
      waiters.push(resolve);
      pump();
    });

  const release = () => {
    active = Math.max(0, active - 1);
    pump();
  };

  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } catch (error) {
        if (isRateLimit(error)) noteRateLimit();
        throw error;
      } finally {
        release();
      }
    },
    noteRateLimit,
    stats: () => ({ active, queued: waiters.length, cooldownUntil }),
  };

  function noteRateLimit() {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldownMs);
  }
}

// Wrap a model client so its request methods pass through the shared limiter.
export function rateLimitClient(client, limiter) {
  if (!limiter) return client;
  return {
    ...client,
    async chatCompletion(request, options) {
      return limiter.run(() => client.chatCompletion(request, options));
    },
    async chatCompletionStream(request, handlers) {
      return limiter.run(() => client.chatCompletionStream(request, handlers));
    },
  };
}

function isRateLimit(error) {
  return error?.status === 429 || /\b429\b|rate.?limit/i.test(error?.message ?? "");
}
