import { httpStatusError, retryAttempts, withRetries } from "./retry.js";
import { assertCompleteResponse, assertCompleteToolCalls, incompleteResponse } from "./streamCompletion.js";

export function createDeepSeekClient(config) {
  return createOpenAICompatibleClient(config, { provider: "DeepSeek", supportsBalance: true });
}

export function createOpenAICompatibleClient(config, { provider = "Provider", supportsBalance = false, transformRequest = identity } = {}) {
  return {
    async chatCompletion(request, options = {}) {
      return assertCompleteResponse(await requestJson(config, "/chat/completions", {
        method: "POST",
        body: JSON.stringify(transformRequest(request)),
      }, options));
    },
    async chatCompletionStream(request, handlers = {}) {
      return requestChatCompletionStream(config, transformRequest({
        ...request,
        stream: true,
        stream_options: request.stream_options ?? { include_usage: true },
      }), handlers);
    },
    async listModels() {
      return requestJson(config, "/models", { method: "GET" });
    },
    async getBalance() {
      if (!supportsBalance) throw new Error(`${provider} does not expose a compatible balance endpoint.`);
      return requestJson(config, "/user/balance", { method: "GET" });
    },
  };
}

function identity(value) {
  return value;
}

async function requestChatCompletionStream(config, request, handlers) {
  return withRetries({ attempts: retryAttempts(config), signal: handlers.signal, timeoutMs: config.timeoutMs, onRuntimeEvent: handlers.onRuntimeEvent,
    beforeAttempt: handlers.beforeAttempt, onAttemptError: handlers.onAttemptError }, async ({ signal, progress }) => {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) throw httpStatusError(response, `API error ${response.status}: ${await response.text()}`);
    if (!response.body) {
      throw new Error("API returned no stream body.");
    }

    // Text, reasoning and tool-call deltas all restart the idle timeout and rule out a retry.
    return readChatCompletionSse(response.body, { ...handlers, onDelta: progress.delta });
  });
}

async function readChatCompletionSse(body, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const message = { role: "assistant", content: "", tool_calls: [] };
  let finishReason;
  let sawDone = false;
  let usage;
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = consumeSseEvents(buffer);
    buffer = events.rest;
    for (const event of events.items) {
      if (event === "[DONE]") {
        sawDone = true;
        continue;
      }
      const parsed = JSON.parse(event);
      if (parsed.usage) usage = parsed.usage;
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      applyChatDelta(message, choice.delta ?? {}, handlers);
    }
  }

  buffer += decoder.decode();
  for (const event of consumeSseEvents(`${buffer}\n\n`).items) {
    if (event === "[DONE]") {
      sawDone = true;
      continue;
    }
    const parsed = JSON.parse(event);
    if (parsed.usage) usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    applyChatDelta(message, choice.delta ?? {}, handlers);
  }

  if (!sawDone || !finishReason) {
    throw incompleteResponse("Stream ended before its completion marker and finish reason.", usage);
  }
  assertCompleteToolCalls(message.tool_calls, usage, finishReason);
  if (message.tool_calls.length === 0) delete message.tool_calls;
  return {
    choices: [{ message, finish_reason: finishReason }],
    usage,
  };
}

function consumeSseEvents(buffer) {
  const items = [];
  let rest = buffer;
  while (true) {
    const match = rest.match(/\r?\n\r?\n/);
    if (!match?.index && match?.index !== 0) break;
    const raw = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (data) items.push(data);
  }
  return { items, rest };
}

function applyChatDelta(message, delta, handlers) {
  // Every generated piece counts toward output, including reasoning and tool arguments.
  const generated = (delta.content ?? "") + (delta.reasoning_content ?? "")
    + (delta.tool_calls ?? []).map((call) => call.function?.arguments ?? "").join("");
  // A tool-call header (id and name, empty arguments) is generated output too.
  if (generated || delta.tool_calls?.length) handlers.onDelta?.();
  if (generated) handlers.onProgress?.(generated);
  if (delta.role) message.role = delta.role;
  if (delta.content) {
    message.content += delta.content;
    handlers.onContent?.(delta.content);
  }
  for (const toolCallDelta of delta.tool_calls ?? []) {
    const index = toolCallDelta.index ?? message.tool_calls.length;
    const target = message.tool_calls[index] ?? {
      id: "",
      type: "function",
      function: { name: "", arguments: "" },
    };
    if (toolCallDelta.id) target.id += toolCallDelta.id;
    if (toolCallDelta.type) target.type = toolCallDelta.type;
    if (toolCallDelta.function?.name) target.function.name += toolCallDelta.function.name;
    if (toolCallDelta.function?.arguments) {
      target.function.arguments += toolCallDelta.function.arguments;
    }
    message.tool_calls[index] = target;
  }
}

async function requestJson(config, path, init, options = {}) {
  return withRetries({ attempts: retryAttempts(config), signal: options.signal, timeoutMs: config.timeoutMs, onRuntimeEvent: options.onRuntimeEvent,
    beforeAttempt: options.beforeAttempt, onAttemptError: options.onAttemptError }, async ({ signal }) => {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal,
    });

    const text = await response.text();
    if (!response.ok) throw httpStatusError(response, `API error ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  });
}
