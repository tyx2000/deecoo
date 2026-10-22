// Structured run tracer. The harness already writes an audit after the fact; this gives a
// live, typed event stream and rolling metrics that a CLI, dashboard, or the audit can read
// while a run is in flight. It is a pure sink — no I/O — so it is cheap and testable.

export function createRunTracer({ max = 2000, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(max) || max < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("Trace retention limits must be nonnegative integers.");
  const events = [];
  const sizes = [];
  let retainedBytes = 0;
  const metrics = {
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    reuses: 0,
    workers: 0,
    injectionsFlagged: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    modelRetries: 0,
    rateLimited: 0,
    queueWaitMs: 0,
    firstTokenSamples: 0,
    firstTokenLatencyMs: 0,
  };
  // Metrics are cumulative and always exact; only the retained event ring is bounded, and we
  // count evicted events so the trace is never silently lossy.
  let dropped = 0;
  let startedAt;
  let endedAt;

  const record = (event) => {
    if (!event || typeof event.type !== "string") return;
    const stamped = { at: Date.now(), ...event };
    startedAt ??= stamped.at;
    endedAt = stamped.at;
    applyMetrics(metrics, stamped);
    const bytes = Buffer.byteLength(JSON.stringify(stamped));
    if (!max || bytes > maxBytes) { dropped++; return; }
    events.push(stamped); sizes.push(bytes); retainedBytes += bytes;
    while (events.length > max || retainedBytes > maxBytes) { events.shift(); retainedBytes -= sizes.shift(); dropped++; }
  };

  return {
    record,
    events: () => events.slice(),
    snapshot() {
      return {
        ...metrics,
        events: events.length,
        droppedEvents: dropped,
        retainedBytes,
        elapsedMs: startedAt !== undefined ? Math.max(0, (endedAt ?? startedAt) - startedAt) : 0,
      };
    },
  };
}

function applyMetrics(metrics, event) {
  switch (event.type) {
    case "model-retry":
      metrics.modelRetries += 1;
      if (event.status === 429) metrics.rateLimited += 1;
      break;
    case "model-admitted":
      metrics.queueWaitMs += event.queuedMs ?? 0;
      break;
    case "first-token":
      metrics.firstTokenSamples += 1;
      metrics.firstTokenLatencyMs += event.latencyMs ?? 0;
      break;
    case "step":
      metrics.steps = Math.max(metrics.steps, Number(event.step ?? 0));
      break;
    case "model-call":
      metrics.modelCalls += 1;
      metrics.promptTokens += Number(event.usage?.promptTokens ?? event.usage?.prompt_tokens ?? 0);
      metrics.completionTokens += Number(event.usage?.completionTokens ?? event.usage?.completion_tokens ?? 0);
      metrics.totalTokens += Number(event.usage?.totalTokens ?? event.usage?.total_tokens ?? 0);
      break;
    case "tool-call":
      metrics.toolCalls += 1;
      if (event.ok === false) metrics.toolErrors += 1;
      if (event.reused) metrics.reuses += 1;
      if (event.injectionSuspected) metrics.injectionsFlagged += 1;
      break;
    case "worker":
      metrics.workers += 1;
      break;
    default:
      break;
  }
}
