import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeepSeekClient } from "../src/llm/deepseekClient.js";
import { createAnthropicClient } from "../src/llm/anthropicClient.js";
import { runAgent } from "../src/agent/loop.js";

const config = { apiKey: "synthetic", baseUrl: "https://synthetic.invalid", timeoutMs: 1000, retryAttempts: 2 };
const request = { model: "test", messages: [{ role: "user", content: "test" }], max_tokens: 100 };
const openAiEvent = (value) => "data: " + JSON.stringify(value) + "\n\n";
const anthropicEvent = (value) => "event: " + value.type + "\ndata: " + JSON.stringify(value) + "\n\n";
const openAiText = openAiEvent({ choices: [{ delta: { content: "Partial answer" } }] });
const anthropicText = anthropicEvent({ type: "message_start", message: { usage: { input_tokens: 5 } } }) +
  anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "Partial answer" } });
const openAiEnd = openAiEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
const anthropicEnd = anthropicEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
  anthropicEvent({ type: "message_stop" });

async function withPayload(payload, callback) {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    return await callback(() => calls);
  } finally {
    globalThis.fetch = previous;
  }
}

for (const [provider, createClient, partial, end] of [
  ["DeepSeek", createDeepSeekClient, openAiText, openAiEnd],
  ["Anthropic", createAnthropicClient, anthropicText, anthropicEnd],
]) {
  test("SCOR-006 " + provider + " rejects early EOF without retrying already streamed output", async () => {
    await withPayload(partial, async (calls) => {
      const content = [];
      await assert.rejects(createClient(config).chatCompletionStream(request, {
        onContent: (delta) => content.push(delta),
      }), { code: "INCOMPLETE_RESPONSE" });
      assert.equal(content.join(""), "Partial answer");
      assert.equal(calls(), 1);
    });
  });

  test("SCOR-006 " + provider + " rejects an empty stream", async () => {
    await withPayload("", async (calls) => {
      await assert.rejects(createClient(config).chatCompletionStream(request), { code: "INCOMPLETE_RESPONSE" });
      assert.equal(calls(), 1);
    });
  });

  test("SCOR-006 " + provider + " keeps complete text streams working", async () => {
    await withPayload(partial + end, async () => {
      const result = await createClient(config).chatCompletionStream(request);
      assert.equal(result.choices[0].message.content, "Partial answer");
      assert.equal(result.choices[0].finish_reason, "stop");
    });
  });

  test("SCOR-006 " + provider + " does not mark an incomplete stream completed in the agent", async () => {
    await withPayload(partial, async () => {
      let executed = 0;
      await assert.rejects(runAgent({
        client: createClient(config),
        tools: { schemas: [], async execute() { executed += 1; return { ok: true }; } },
        task: "explain code", cwd: "/synthetic", model: "test", stream: true, maxSteps: 1,
      }), { code: "INCOMPLETE_RESPONSE" });
      assert.equal(executed, 0);
    });
  });
}

test("SCOR-006 DeepSeek requires a terminal finish reason as well as DONE", async () => {
  await withPayload(openAiText + "data: [DONE]\n\n", async () => {
    await assert.rejects(createDeepSeekClient(config).chatCompletionStream(request), { code: "INCOMPLETE_RESPONSE" });
  });
});

test("SCOR-006 DeepSeek rejects a stream missing its DONE marker", async () => {
  const payload = openAiText + openAiEvent({ choices: [{ delta: {}, finish_reason: "stop" }] });
  await withPayload(payload, async () => {
    await assert.rejects(createDeepSeekClient(config).chatCompletionStream(request), { code: "INCOMPLETE_RESPONSE" });
  });
});

test("SCOR-006 DeepSeek accepts complete tool JSON and rejects unfinished tool JSON", async () => {
  const prefix = openAiEvent({ choices: [{ delta: { tool_calls: [{
    index: 0, id: "tool-1", type: "function", function: { name: "read_file", arguments: '{"path":' },
  }] } }] });
  const suffix = openAiEvent({ choices: [{ delta: { tool_calls: [{
    index: 0, function: { arguments: '"package.json"}' },
  }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
  await withPayload(prefix + suffix, async () => {
    const result = await createDeepSeekClient(config).chatCompletionStream(request);
    assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: "package.json" });
  });
  const incompleteEnd = openAiEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
  await withPayload(prefix + incompleteEnd, async () => {
    await assert.rejects(createDeepSeekClient(config).chatCompletionStream(request), { code: "INCOMPLETE_RESPONSE" });
  });
});

test("SCOR-006 partial tool streams cannot reach tool execution after EOF", async () => {
  const openAiTool = openAiEvent({ choices: [{ delta: { tool_calls: [{
    index: 0, id: "tool-1", type: "function", function: { name: "read_file", arguments: '{"path":' },
  }] } }] });
  const anthropicTool = anthropicEvent({ type: "content_block_start", index: 0, content_block: {
    type: "tool_use", id: "tool-1", name: "read_file", input: {},
  } }) + anthropicEvent({ type: "content_block_delta", index: 0, delta: {
    type: "input_json_delta", partial_json: '{"path":',
  } });
  for (const [createClient, payload] of [[createDeepSeekClient, openAiTool], [createAnthropicClient, anthropicTool]]) {
    await withPayload(payload, async (calls) => {
      let executed = 0;
      await assert.rejects(runAgent({
        client: createClient(config),
        tools: { schemas: [], async execute() { executed += 1; return { ok: true }; } },
        task: "read code", cwd: "/synthetic", model: "test", stream: true, maxSteps: 1,
      }), { code: "INCOMPLETE_RESPONSE" });
      assert.equal(executed, 0);
      assert.equal(calls(), 1);
    });
  }
});

test("SCOR-006 Anthropic requires message_stop after its stop reason", async () => {
  const payload = anthropicText + anthropicEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  await withPayload(payload, async () => {
    await assert.rejects(createAnthropicClient(config).chatCompletionStream(request), { code: "INCOMPLETE_RESPONSE" });
  });
});

test("SCOR-006 Anthropic validates accumulated tool JSON before returning calls", async () => {
  const prefix = anthropicEvent({ type: "message_start", message: { usage: { input_tokens: 5 } } }) +
    anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "read_file", input: {} } }) +
    anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } });
  const end = anthropicEvent({ type: "content_block_stop", index: 0 }) +
    anthropicEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }) +
    anthropicEvent({ type: "message_stop" });
  await withPayload(prefix + end, async (calls) => {
    await assert.rejects(createAnthropicClient(config).chatCompletionStream(request), { code: "INCOMPLETE_RESPONSE" });
    assert.equal(calls(), 1);
  });
  const completed = prefix + anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"package.json"}' } }) + end;
  await withPayload(completed, async () => {
    const result = await createAnthropicClient(config).chatCompletionStream(request);
    assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: "package.json" });
  });
});

test("SCOR-006 incomplete response errors preserve reported usage for task accounting", async () => {
  const openAiUsage = openAiEvent({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
  await withPayload(openAiText + openAiUsage, async () => {
    await assert.rejects(createDeepSeekClient(config).chatCompletionStream(request), (error) => {
      assert.equal(error.code, "INCOMPLETE_RESPONSE");
      assert.equal(error.usage.total_tokens, 8);
      return true;
    });
  });
  await withPayload(anthropicText, async () => {
    await assert.rejects(createAnthropicClient(config).chatCompletionStream(request), (error) => {
      assert.equal(error.code, "INCOMPLETE_RESPONSE");
      assert.equal(error.usage.prompt_tokens, 5);
      return true;
    });
  });
});

test("OUTPUT-001 a tool call cut off by the output limit names the setting to raise", async () => {
  const toolStart = openAiEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"review.md\",\"content\":\"# Rev" } }] } }] });
  const ended = (reason) => toolStart + openAiEvent({ choices: [{ delta: {}, finish_reason: reason }] }) + "data: [DONE]\n\n";
  await withPayload(ended("length"), async () => {
    await assert.rejects(createDeepSeekClient(config).chatCompletionStream(request, {}),
      (error) => error.code === "INCOMPLETE_RESPONSE" && /output-token limit/.test(error.message) && /DEECOO_MAX_TOKENS/.test(error.message));
  });
  await withPayload(ended("tool_calls"), async () => {
    await assert.rejects(createDeepSeekClient(config).chatCompletionStream(request, {}), { message: "Stream ended with incomplete tool arguments." });
  });
});
