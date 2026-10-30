import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeepSeekClient } from "../src/llm/deepseekClient.js";
import { createAnthropicClient } from "../src/llm/anthropicClient.js";
import { withRetries } from "../src/llm/retry.js";

// R2-P1-6: DEECOO_TIMEOUT_MS is an idle timeout. Every streamed delta restarts it, and an attempt
// that already handed output to the caller is never retried. Only synthetic fetch streams are used.
// The assessment's repro (a tool stream sending every 10 ms against a 55 ms timeout was fetched
// twice and still timed out) is the tool-argument case below, with margins widened to a 250 ms
// idle timeout to stay stable on CI.
const IDLE_MS = 250;
const GAP_MS = 10;
const config = { apiKey: "synthetic", baseUrl: "https://synthetic.invalid", timeoutMs: IDLE_MS, retryAttempts: 3 };
const request = { model: "test", messages: [{ role: "user", content: "test" }], max_tokens: 100 };
const options = { timeout: 15_000 };

const openAiEvent = (value) => "data: " + JSON.stringify(value) + "\n\n";
const openAiDelta = (delta) => openAiEvent({ choices: [{ delta }] });
const openAiEnd = (reason) => openAiEvent({ choices: [{ delta: {}, finish_reason: reason }] }) + "data: [DONE]\n\n";
const anthropicEvent = (value) => "event: " + value.type + "\ndata: " + JSON.stringify(value) + "\n\n";
const anthropicStart = anthropicEvent({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } });
const anthropicEnd = (reason) => anthropicEvent({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 60 } })
  + anthropicEvent({ type: "message_stop" });

// 60 frames at 10 ms take at least 600 ms, well past the 250 ms idle timeout.
const PIECES = Array.from({ length: 60 }, (_, index) => "p" + index);
const PATH_ARGS = ["{\"path\":\"a.txt\",\"content\":\"", ...PIECES, "\"}"];
const WRITTEN = PIECES.join("");

const streams = {
  "OpenAI-compatible text": {
    createClient: createDeepSeekClient,
    frames: [openAiDelta({ role: "assistant", content: "" }), ...PIECES.map((content) => openAiDelta({ content })), openAiEnd("stop")],
    check: (result) => assert.equal(result.choices[0].message.content, WRITTEN),
  },
  "OpenAI-compatible tool arguments": {
    createClient: createDeepSeekClient,
    frames: [
      openAiDelta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: "" } }] }),
      ...PATH_ARGS.map((part) => openAiDelta({ tool_calls: [{ index: 0, function: { arguments: part } }] })),
      openAiEnd("tool_calls"),
    ],
    check: (result) => assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: "a.txt", content: WRITTEN }),
  },
  "OpenAI-compatible reasoning": {
    createClient: createDeepSeekClient,
    frames: [...PIECES.map((reasoning_content) => openAiDelta({ reasoning_content, content: null })), openAiDelta({ content: "done" }), openAiEnd("stop")],
    check: (result) => assert.equal(result.choices[0].message.content, "done"),
  },
  "Anthropic tool": {
    createClient: createAnthropicClient,
    frames: [
      anthropicStart,
      anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "write_file", input: {} } }),
      ...PATH_ARGS.map((partial_json) => anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } })),
      anthropicEvent({ type: "content_block_stop", index: 0 }),
      anthropicEnd("tool_use"),
    ],
    check: (result) => assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: "a.txt", content: WRITTEN }),
  },
  "Anthropic text": {
    createClient: createAnthropicClient,
    frames: [
      anthropicStart,
      anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ...PIECES.map((text) => anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
      anthropicEvent({ type: "content_block_stop", index: 0 }),
      anthropicEnd("end_turn"),
    ],
    check: (result) => assert.equal(result.choices[0].message.content, WRITTEN),
  },
};

// Replaces fetch for one test. respond(signal) returns the Response (or a pending promise).
async function withFetch(respond, callback) {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    return respond(init.signal);
  };
  try {
    return await callback(() => calls);
  } finally {
    globalThis.fetch = previous;
  }
}

// Sends one frame every GAP_MS, like a provider that is still generating. With `stallAfter` it
// goes silent after that many frames, or fails with `failWith`. An abort errors the body with
// the abort reason, as undici does for a real fetch.
function sse(signal, frames, { stallAfter, failWith } = {}) {
  const encoder = new TextEncoder();
  let timer;
  const body = new ReadableStream({
    start(controller) {
      let index = 0;
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        controller.error(signal.reason);
      }, { once: true });
      const next = () => {
        if (index === stallAfter) {
          if (failWith) controller.error(failWith);
          return;
        }
        if (index === frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(frames[index]));
        index += 1;
        timer = setTimeout(next, GAP_MS);
      };
      timer = setTimeout(next, GAP_MS);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

for (const [name, { createClient, frames, check }] of Object.entries(streams)) {
  test("R2-P1-6 " + name + " stream outlasting the idle timeout completes in one request", options, async () => {
    await withFetch((signal) => sse(signal, frames), async (calls) => {
      const started = Date.now();
      const result = await createClient(config).chatCompletionStream(request);
      assert.ok(Date.now() - started >= 2 * IDLE_MS, "the stream must outlast the idle timeout to prove anything");
      check(result);
      assert.equal(calls(), 1);
    });
  });
}

for (const [provider, createClient] of [["OpenAI-compatible", createDeepSeekClient], ["Anthropic", createAnthropicClient]]) {
  test("R2-P1-6 " + provider + " still times out and retries a request that never sends its first byte", options, async () => {
    const pending = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    await withFetch(pending, async (calls) => {
      await assert.rejects(createClient({ ...config, retryAttempts: 2 }).chatCompletionStream(request), /Request timed out/);
      assert.equal(calls(), 2);
    });
  });

  test("R2-P1-6 " + provider + " still times out a response whose body never sends a byte", options, async () => {
    await withFetch((signal) => sse(signal, [], { stallAfter: 0 }), async (calls) => {
      await assert.rejects(createClient({ ...config, retryAttempts: 2 }).chatCompletionStream(request), /Request timed out/);
      assert.equal(calls(), 2);
    });
  });
}

for (const [name, stallAfter] of [["OpenAI-compatible tool arguments", 5], ["OpenAI-compatible reasoning", 5], ["Anthropic tool", 4]]) {
  test("R2-P1-6 " + name + " stream that stalls mid-way times out once, without a retry", options, async () => {
    const { createClient, frames } = streams[name];
    await withFetch((signal) => sse(signal, frames, { stallAfter }), async (calls) => {
      const progress = [];
      const started = Date.now();
      await assert.rejects(createClient(config).chatCompletionStream(request, { onProgress: (text) => progress.push(text) }), /Request timed out/);
      assert.ok(Date.now() - started >= IDLE_MS);
      assert.ok(progress.length > 0);
      assert.equal(calls(), 1);
    });
  });
}

test("R2-P1-6 a stall before any generated delta is still retried", options, async () => {
  const { frames } = streams["OpenAI-compatible text"];
  // Only the role-only opening frame arrives: nothing has reached the caller yet.
  await withFetch((signal) => sse(signal, frames, { stallAfter: 1 }), async (calls) => {
    await assert.rejects(createDeepSeekClient({ ...config, retryAttempts: 2 }).chatCompletionStream(request), /Request timed out/);
    assert.equal(calls(), 2);
  });
});

for (const [name, stallAfter] of [
  ["OpenAI-compatible text", 3],
  ["OpenAI-compatible tool arguments", 1],
  ["OpenAI-compatible tool arguments", 4],
  ["OpenAI-compatible reasoning", 3],
  ["Anthropic tool", 2],
  ["Anthropic tool", 4],
  ["Anthropic text", 4],
]) {
  test("R2-P1-6 " + name + " stream is not retried after " + stallAfter + " frames once output was emitted", options, async () => {
    const { createClient, frames } = streams[name];
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    await withFetch((signal) => sse(signal, frames, { stallAfter, failWith: reset }), async (calls) => {
      const events = [];
      await assert.rejects(createClient(config).chatCompletionStream(request, { onRuntimeEvent: (event) => events.push(event) }), /ECONNRESET/);
      assert.equal(calls(), 1);
      assert.equal(events.filter((event) => event.type === "model-retry").length, 0);
    });
  });
}

for (const [name, { createClient, frames }] of Object.entries(streams)) {
  test("R2-P1-6 " + name + " stream stops promptly when the user cancels", options, async () => {
    const controller = new AbortController();
    const cancel = Object.assign(new Error("Task interrupted."), { name: "AbortError" });
    await withFetch((signal) => sse(signal, frames), async (calls) => {
      const started = Date.now();
      let deltas = 0;
      const onProgress = () => {
        deltas += 1;
        if (deltas === 3) controller.abort(cancel);
      };
      await assert.rejects(createClient(config).chatCompletionStream(request, { signal: controller.signal, onProgress }), (error) => error === cancel);
      assert.ok(Date.now() - started < IDLE_MS, "cancellation must not wait for the idle timeout");
      assert.equal(calls(), 1);
    });
  });
}

test("R2-P1-6 cancelling while waiting for the first byte stops at once without a retry", options, async () => {
  const controller = new AbortController();
  const pending = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  await withFetch(pending, async (calls) => {
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(createDeepSeekClient(config).chatCompletionStream(request, { signal: controller.signal }));
    assert.ok(Date.now() - started < IDLE_MS);
    assert.equal(calls(), 1);
  });
});

test("R2-P1-6 withRetries treats timeoutMs as idle time that each delta restarts", options, async () => {
  let attempts = 0;
  const result = await withRetries({ attempts: 3, timeoutMs: IDLE_MS }, async ({ signal, progress }) => {
    attempts += 1;
    for (let index = 0; index < 60; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal.aborted) throw signal.reason;
      progress.delta();
    }
    return "complete";
  });
  assert.equal(result, "complete");
  assert.equal(attempts, 1);

  const silent = await withRetries({ attempts: 1, timeoutMs: IDLE_MS }, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })).catch((error) => error);
  assert.match(silent.message, /Request timed out: no response or model output for 250 ms/);
});
