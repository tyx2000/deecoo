// One retry policy for every provider adapter: which failures are transient, how long to wait
// (a server's Retry-After wins over exponential backoff), and how many attempts were made.
import { setTimeout as delay } from "node:timers/promises";

const MAX_RETRY_AFTER_MS = 30_000;

export function retryAttempts(config) {
  return Math.min(5, Math.max(1, config.retryAttempts ?? 5));
}

// Runs one request attempt at a time with its own timeout and abort link. An attempt that has
// already streamed output to the caller (progress.emitted) is never repeated.
export async function withRetries({ attempts, signal, timeoutMs, onRuntimeEvent, beforeAttempt, onAttemptError }, attemptRequest) {
  let lastError;
  let attempt = 1;
  for (; attempt <= attempts; attempt += 1) {
    throwIfAborted(signal);
    // A request admitted before another caller's 429 must also respect the shared cooldown
    // before sending its next attempt. Waiting is outside the individual request timeout.
    await beforeAttempt?.({ signal, attempt });
    throwIfAborted(signal);
    const controller = new AbortController();
    const removeAbortListener = linkAbortSignal(signal, controller);
    const timeout = setTimeout(() => controller.abort(new Error("Request timed out.")), timeoutMs);
    const progress = { emitted: false };
    let delayMs;
    try {
      return await attemptRequest({ signal: controller.signal, attempt, progress });
    } catch (error) {
      lastError = error;
      onAttemptError?.(error, { attempt });
      if (signal?.aborted || progress.emitted || attempt >= attempts || !isTransientError(error)) break;
      delayMs = retryDelayMs(error, attempt);
    } finally {
      clearTimeout(timeout);
      removeAbortListener();
    }
    onRuntimeEvent?.({ type: "model-retry", attempt, delayMs, status: lastError.status });
    await delay(delayMs, undefined, { signal });
  }
  if (lastError && typeof lastError === "object" && lastError.attempts === undefined) lastError.attempts = Math.min(attempt, attempts);
  throw lastError;
}

export function httpStatusError(response, message) {
  const error = new Error(message);
  error.status = response.status;
  const retryAfter = retryAfterMs(response.headers);
  if (retryAfter !== undefined) error.retryAfterMs = retryAfter;
  return error;
}

export function retryAfterMs(headers) {
  const value = headers?.get?.("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

export function retryDelayMs(error, attempt) {
  return error?.retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), 4000);
}

export function isTransientError(error) {
  if (error.code === "INCOMPLETE_RESPONSE") return false;
  if (error.name === "AbortError") return true;
  if (/Request timed out/i.test(error.message ?? "")) return true;
  if (error.status === 429 || (error.status >= 500 && error.status <= 599)) return true;
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error.message ?? "");
}

function linkAbortSignal(signal, controller) {
  if (!signal) return () => {};
  const onAbort = () => controller.abort(signal.reason ?? new Error("Task interrupted."));
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("Task interrupted.");
  error.name = "AbortError";
  throw error;
}

