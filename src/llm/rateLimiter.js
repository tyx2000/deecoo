// Shared rate limiter for all model requests in a task — the main agent and every dispatched
// worker go through one limiter, so a burst of parallel workers cannot independently hammer
// the provider. Enforces a concurrency cap, a minimum inter-request interval, and a shared
// cooldown that every caller respects after a 429.
import { setTimeout as delay } from "node:timers/promises";

export function createRateLimiter({ maxConcurrent = 4, minIntervalMs = 0, cooldownMs = 2000 } = {}) {
  let active = 0;
  let lastStart = 0;
  let cooldownUntil = 0;
  let pumpTimer;
  const waiters = [];

  const pump = () => {
    clearTimeout(pumpTimer);
    pumpTimer = undefined;
    while (active < maxConcurrent && waiters.length) {
      const now = Date.now();
      const earliest = Math.max(cooldownUntil, lastStart + minIntervalMs);
      if (now < earliest) {
        pumpTimer = setTimeout(pump, earliest - now);
        return;
      }
      const waiter = waiters.shift();
      waiter.cleanup();
      active += 1;
      lastStart = Date.now();
      waiter.resolve();
    }
  };

  const acquire = (signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError(signal)); return; }
      const onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index < 0) return;
        waiters.splice(index, 1);
        waiter.cleanup();
        reject(abortError(signal));
        pump();
      };
      const waiter = { resolve, cleanup: () => signal?.removeEventListener("abort", onAbort) };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(waiter);
      pump();
    });

  const release = () => {
    active = Math.max(0, active - 1);
    pump();
  };

  return {
    async run(fn, { onAdmitted, signal } = {}) {
      const queuedAt = Date.now();
      await acquire(signal);
      try {
        await waitForCooldown({ signal });
        onAdmitted?.({ queuedMs: Date.now() - queuedAt });
        return await fn();
      } catch (error) {
        if (isRateLimit(error)) noteRateLimit(error.retryAfterMs);
        throw error;
      } finally {
        release();
      }
    },
    noteRateLimit,
    waitForCooldown,
    stats: () => ({ active, queued: waiters.length, cooldownUntil }),
  };

  // A provider's Retry-After, when present, sets the shared cooldown for every caller.
  function noteRateLimit(retryAfterMs) {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + (Number.isFinite(retryAfterMs) ? retryAfterMs : cooldownMs));
  }

  async function waitForCooldown({ signal } = {}) {
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const remaining = cooldownUntil - Date.now();
      if (remaining <= 0) return;
      await delay(remaining, undefined, { signal });
      // Another in-flight attempt can extend the cooldown while we were asleep.
    }
  }
}

// Wrap a model client so its request methods pass through the shared limiter.
export function rateLimitClient(client, limiter) {
  if (!limiter) return client;
  const wrapped = {
    ...client,
    async chatCompletion(request, options = {}) {
      return limiter.run(() => client.chatCompletion(request, attemptOptions(options)), { signal: options.signal,
        onAdmitted: (event) => options.onRuntimeEvent?.({ type: "model-admitted", ...event }) });
    },
  };
  if (typeof client.chatCompletionStream === "function") wrapped.chatCompletionStream = (request, handlers = {}) =>
    limiter.run(() => client.chatCompletionStream(request, attemptOptions(handlers)), { signal: handlers.signal,
      onAdmitted: (event) => handlers.onRuntimeEvent?.({ type: "model-admitted", ...event }) });
  return wrapped;

  function attemptOptions(options) {
    return { ...options,
      async beforeAttempt(attempt) {
        await options.beforeAttempt?.(attempt);
        await limiter.waitForCooldown({ signal: attempt.signal });
      },
      onAttemptError(error, attempt) {
        if (isRateLimit(error)) limiter.noteRateLimit(error.retryAfterMs);
        options.onAttemptError?.(error, attempt);
      } };
  }
}

function isRateLimit(error) {
  return error?.status === 429 || /\b429\b|rate.?limit/i.test(error?.message ?? "");
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error("Task interrupted."), { name: "AbortError" });
}
