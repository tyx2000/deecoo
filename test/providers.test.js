import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/env.js";
import { loadSettingsEnv, writeProviderSettings, writeSettingsEnv } from "../src/config/settings.js";
import { createAnthropicClient, fromAnthropicResponse, toAnthropicRequest } from "../src/llm/anthropicClient.js";
import { createModelClient, toOpenAIRequest } from "../src/llm/clientFactory.js";

test("missing provider key gives the exact configuration command", () => {
  assert.throws(
    () => loadConfig({}, {}, { activeProvider: "openai", providers: { openai: { model: "gpt-5.1" } } }),
    /deecoo config -provider openai -key sk-\.\.\./,
  );
});

test("explicit model selects its provider and corresponding environment key", () => {
  const config = loadConfig(
    { OPENAI_API_KEY: "openai-key" },
    { model: "gpt-5.1" },
    {
      activeProvider: "anthropic",
      providers: {
        openai: { apiKey: "stored-openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.1" },
        anthropic: { apiKey: "stored-anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" },
      },
    },
  );

  assert.equal(config.provider, "openai");
  assert.equal(config.apiKey, "openai-key");
  assert.equal(config.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(config.model, "gpt-5.1");
});

test("environment model ownership takes precedence over the stored active provider", () => {
  const config = loadConfig(
    { DEECOO_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "anthropic-key" },
    {},
    { activeProvider: "openai", providers: { openai: { apiKey: "openai-key" } } },
  );

  assert.equal(config.provider, "anthropic");
  assert.equal(config.apiKey, "anthropic-key");
});

test("OpenAI request adapter removes provider-specific fields", () => {
  const request = toOpenAIRequest({ model: "gpt-5.1", max_tokens: 4096, thinking: { type: "enabled" }, reasoning_effort: "high" });

  assert.equal(request.max_tokens, undefined);
  assert.equal(request.max_completion_tokens, 4096);
  assert.equal(request.thinking, undefined);
  assert.equal(request.reasoning_effort, "high");
});

test("provider settings migrate legacy DeepSeek env data without losing permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-provider-settings-"));
  const path = join(directory, "settings.json");
  await writeFile(path, JSON.stringify({
    env: {
      DEEPSEEK_API_KEY: "legacy-deepseek",
      DEECOO_BASE_URL: "https://legacy.deepseek.example",
      DEECOO_MODEL: "deepseek-legacy",
      DEECOO_THEME: "tokyo-night",
    },
    permissions: { shell: { approvedCommands: ["chmod 755 ."], autoApproveAll: false } },
  }), "utf8");

  const before = await loadSettingsEnv({ settingsPath: path });
  assert.equal(before.providers.deepseek.apiKey, "legacy-deepseek");
  assert.equal(before.providers.deepseek.model, "deepseek-legacy");

  await writeProviderSettings({ settingsPath: path, provider: "openai", apiKey: "openai-key" });
  const raw = JSON.parse(await readFile(path, "utf8"));
  const after = await loadSettingsEnv({ settingsPath: path });

  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.activeProvider, "openai");
  assert.equal(raw.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(raw.env.DEECOO_MODEL, undefined);
  assert.equal(raw.providers.deepseek.apiKey, "legacy-deepseek");
  assert.equal(raw.providers.openai.apiKey, "openai-key");
  assert.deepEqual(after.permissions.shell.approvedCommands, ["chmod 755 ."]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("importing one provider key activates that provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-provider-import-"));
  const path = join(directory, "settings.json");

  await writeSettingsEnv({ settingsPath: path, env: { ANTHROPIC_API_KEY: "anthropic-key" } });
  const settings = await loadSettingsEnv({ settingsPath: path });

  assert.equal(settings.activeProvider, "anthropic");
  assert.equal(settings.providers.anthropic.apiKey, "anthropic-key");
});

test("imported recognized model activates its owning provider when several keys are present", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-provider-model-import-"));
  const path = join(directory, "settings.json");

  await writeSettingsEnv({
    settingsPath: path,
    env: {
      DEEPSEEK_API_KEY: "deepseek-key",
      OPENAI_API_KEY: "openai-key",
      DEECOO_MODEL: "gpt-5.1",
    },
  });
  const settings = await loadSettingsEnv({ settingsPath: path });

  assert.equal(settings.activeProvider, "openai");
  assert.equal(settings.providers.openai.model, "gpt-5.1");
});

test("Anthropic adapter translates system, tool calls, and tool results", () => {
  const request = toAnthropicRequest({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    tool_choice: "auto",
    tools: [{
      type: "function",
      function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    }],
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Read package.json" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tool-1", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } }],
      },
      { role: "tool", tool_call_id: "tool-1", content: '{"ok":true,"content":"{}"}' },
    ],
  });

  assert.equal(request.system, "You are a coding agent.");
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.equal(request.tools[0].input_schema.type, "object");
  assert.deepEqual(request.messages[1].content[0], {
    type: "tool_use",
    id: "tool-1",
    name: "read_file",
    input: { path: "package.json" },
  });
  assert.equal(request.messages[2].content[0].type, "tool_result");
  assert.equal(request.messages[2].content[0].tool_use_id, "tool-1");
});

test("Anthropic keeps a mid-conversation system message inline instead of hoisting it", () => {
  const request = toAnthropicRequest({
    model: "claude-sonnet-5",
    messages: [
      { role: "system", content: "BASE PROMPT" },
      { role: "user", content: "do the task" },
      { role: "assistant", content: "working" },
      { role: "system", content: "Run state summary (compaction)" },
      { role: "user", content: "continue" },
    ],
  });

  // Only the leading system message is the system prompt; the compaction summary stays inline.
  assert.equal(request.system, "BASE PROMPT");
  assert.doesNotMatch(request.system, /Run state summary/);
  const inlined = request.messages.some(
    (message) => message.role === "user" && contentText(message).includes("Run state summary"),
  );
  assert.ok(inlined, "compaction summary should appear as an inline user turn");
});

function contentText(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((block) => block.text ?? "").join(" ");
}

test("Anthropic response translates tool use to the internal OpenAI-compatible shape", () => {
  const response = fromAnthropicResponse({
    content: [
      { type: "text", text: "I will inspect it." },
      { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "package.json" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 20, output_tokens: 10 },
  });

  assert.equal(response.choices[0].message.content, "I will inspect it.");
  assert.equal(response.choices[0].message.tool_calls[0].function.name, "read_file");
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"path":"package.json"}');
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(response.usage, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
});

test("Anthropic streaming accumulates text and partial tool JSON", async () => {
  const originalFetch = globalThis.fetch;
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"package.json"}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ];
  const payload = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  try {
    const client = createAnthropicClient({ apiKey: "anthropic-key", baseUrl: "https://api.anthropic.com", timeoutMs: 1000, retryAttempts: 1 });
    let streamed = "";
    const response = await client.chatCompletionStream({ model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content: "read" }] }, {
      onContent(content) {
        streamed += content;
      },
    });

    assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured.init.headers["x-api-key"], "anthropic-key");
    assert.equal(streamed, "Checking");
    assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"path":"package.json"}');
    assert.equal(response.usage.total_tokens, 21);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic streaming tolerates a malformed SSE frame without aborting the stream", async () => {
  const originalFetch = globalThis.fetch;
  // A junk frame and a [DONE] token are interleaved with valid events; neither must throw.
  const payload =
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
    `data: {not valid json\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n` +
    `data: [DONE]\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  globalThis.fetch = async () => new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });

  try {
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.anthropic.com", timeoutMs: 1000, retryAttempts: 1 });
    let streamed = "";
    const response = await client.chatCompletionStream({ model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, {
      onContent(content) {
        streamed += content;
      },
    });
    assert.equal(streamed, "Hello");
    assert.equal(response.choices[0].finish_reason, "stop");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client factory exposes all configured providers", () => {
  for (const provider of ["deepseek", "openai", "anthropic"]) {
    const client = createModelClient({ provider, apiKey: "key", baseUrl: "https://example.com" });
    assert.equal(typeof client.chatCompletion, "function");
    assert.equal(typeof client.chatCompletionStream, "function");
    assert.equal(typeof client.listModels, "function");
  }
});
