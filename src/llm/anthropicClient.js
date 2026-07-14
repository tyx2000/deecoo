export function createAnthropicClient(config) {
  return {
    async chatCompletion(request, options = {}) {
      const response = await requestJson(config, "/v1/messages", {
        method: "POST",
        body: JSON.stringify(toAnthropicRequest(request)),
      }, options);
      return fromAnthropicResponse(response);
    },
    async chatCompletionStream(request, handlers = {}) {
      return requestAnthropicStream(config, { ...toAnthropicRequest(request), stream: true }, handlers);
    },
    async listModels() {
      return requestJson(config, "/v1/models", { method: "GET" });
    },
    async getBalance() {
      throw new Error("Anthropic does not expose a compatible balance endpoint.");
    },
  };
}

export function toAnthropicRequest(request) {
  const system = [];
  const messages = [];
  let seenNonSystem = false;
  for (const message of request.messages ?? []) {
    if (message.role === "system") {
      if (!seenNonSystem) {
        // Leading system messages are the actual system prompt.
        system.push(textContent(message.content));
      } else {
        // A system message that appears mid-conversation (e.g. a compaction summary) is not a
        // top-level directive; keep it inline as a user turn so its position is preserved.
        appendAnthropicMessage(messages, { role: "user", content: textContent(message.content) });
      }
      continue;
    }
    seenNonSystem = true;
    appendAnthropicMessage(messages, convertMessage(message));
  }

  const body = {
    model: request.model,
    max_tokens: request.max_tokens ?? 4096,
    messages,
    thinking: { type: "disabled" },
  };
  if (system.length) body.system = system.join("\n\n");
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters ?? { type: "object", properties: {} },
    }));
    body.tool_choice = anthropicToolChoice(request.tool_choice);
  }
  return body;
}

export function fromAnthropicResponse(response) {
  const message = { role: "assistant", content: "" };
  const toolCalls = [];
  for (const block of response.content ?? []) {
    if (block.type === "text") message.content += block.text ?? "";
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    choices: [{ message, finish_reason: mapStopReason(response.stop_reason) }],
    usage: normalizeUsage(response.usage),
  };
}

function convertMessage(message) {
  if (message.role === "assistant") {
    const content = [];
    const text = textContent(message.content);
    if (text) content.push({ type: "text", text });
    for (const call of message.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function?.name,
        input: parseArguments(call.function?.arguments),
      });
    }
    return { role: "assistant", content };
  }
  if (message.role === "tool") {
    const content = textContent(message.content);
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content,
        ...(toolResultFailed(content) ? { is_error: true } : {}),
      }],
    };
  }
  return { role: "user", content: textContent(message.content) };
}

function appendAnthropicMessage(messages, message) {
  if (!message) return;
  const previous = messages.at(-1);
  if (!previous || previous.role !== message.role) {
    messages.push(message);
    return;
  }
  previous.content = [...contentBlocks(previous.content), ...contentBlocks(message.content)];
}

function contentBlocks(content) {
  if (Array.isArray(content)) return content;
  return content ? [{ type: "text", text: String(content) }] : [];
}

function anthropicToolChoice(choice) {
  if (choice === "required") return { type: "any" };
  if (choice && typeof choice === "object" && choice.function?.name) {
    return { type: "tool", name: choice.function.name };
  }
  return { type: "auto" };
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolResultFailed(content) {
  try {
    return JSON.parse(content)?.ok === false;
  } catch {
    return false;
  }
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

async function requestAnthropicStream(config, request, handlers) {
  const attempts = Math.min(5, Math.max(1, config.retryAttempts ?? 5));
  let lastError;
  let emitted = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(handlers.signal);
    const controller = new AbortController();
    const removeAbortListener = linkAbortSignal(handlers.signal, controller);
    const timeout = setTimeout(() => controller.abort(new Error("Request timed out.")), config.timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(config, { Accept: "text/event-stream" }),
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) throw await apiError(response);
      if (!response.body) throw new Error("Anthropic API returned no stream body.");
      const result = await readAnthropicSse(response.body, {
        ...handlers,
        onContent(content) {
          emitted = true;
          handlers.onContent?.(content);
        },
        onToolUse() {
          emitted = true;
        },
      });
      return result;
    } catch (error) {
      lastError = error;
      if (handlers.signal?.aborted || emitted || attempt >= attempts || !shouldRetry(error)) break;
      await delay(backoffMs(attempt));
    } finally {
      clearTimeout(timeout);
      removeAbortListener();
    }
  }
  throw lastError;
}

async function readAnthropicSse(body, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const message = { role: "assistant", content: "" };
  const blocks = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason;
  let buffer = "";

  const applyEvent = (event) => {
    if (event.type === "error") {
      const error = new Error(`Anthropic stream error: ${event.error?.message ?? "unknown error"}`);
      error.status = event.error?.type === "overloaded_error" ? 529 : undefined;
      throw error;
    }
    if (event.type === "message_start") {
      inputTokens = Number(event.message?.usage?.input_tokens ?? 0);
      outputTokens = Number(event.message?.usage?.output_tokens ?? 0);
    } else if (event.type === "content_block_start") {
      const block = event.content_block ?? {};
      if (block.type === "text" && block.text) {
        message.content += block.text;
        handlers.onContent?.(block.text);
      }
      blocks.set(event.index, {
        ...block,
        text: block.text ?? "",
        arguments: block.type === "tool_use" && Object.keys(block.input ?? {}).length ? JSON.stringify(block.input) : "",
      });
      if (block.type === "tool_use") handlers.onToolUse?.();
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(event.index) ?? { type: event.delta?.type === "text_delta" ? "text" : "tool_use", text: "", arguments: "" };
      if (event.delta?.type === "text_delta") {
        block.text += event.delta.text ?? "";
        message.content += event.delta.text ?? "";
        handlers.onContent?.(event.delta.text ?? "");
      } else if (event.delta?.type === "input_json_delta") {
        block.arguments += event.delta.partial_json ?? "";
      }
      blocks.set(event.index, block);
    } else if (event.type === "message_delta") {
      finishReason = mapStopReason(event.delta?.stop_reason);
      outputTokens = Number(event.usage?.output_tokens ?? outputTokens);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const consumed = consumeSseEvents(buffer);
    buffer = consumed.rest;
    for (const event of consumed.items) applyEvent(event);
  }
  buffer += decoder.decode();
  for (const event of consumeSseEvents(`${buffer}\n\n`).items) applyEvent(event);

  const toolCalls = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([, block]) => block.type === "tool_use")
    .map(([, block]) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: block.arguments || "{}" },
    }));
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    choices: [{ message, finish_reason: finishReason }],
    usage: normalizeUsage({ input_tokens: inputTokens, output_tokens: outputTokens }),
  };
}

function consumeSseEvents(buffer) {
  const items = [];
  let rest = buffer;
  while (true) {
    const match = rest.match(/\r?\n\r?\n/);
    if (match?.index === undefined) break;
    const raw = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      items.push(JSON.parse(data));
    } catch {
      // A malformed or non-JSON SSE frame must not abort the whole stream.
    }
  }
  return { items, rest };
}

async function requestJson(config, path, init, options = {}) {
  const attempts = Math.min(5, Math.max(1, config.retryAttempts ?? 5));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(options.signal);
    const controller = new AbortController();
    const removeAbortListener = linkAbortSignal(options.signal, controller);
    const timeout = setTimeout(() => controller.abort(new Error("Request timed out.")), config.timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}${path}`, {
        ...init,
        headers: { ...anthropicHeaders(config), ...init.headers },
        signal: controller.signal,
      });
      if (!response.ok) throw await apiError(response);
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt >= attempts || !shouldRetry(error)) break;
      await delay(backoffMs(attempt));
    } finally {
      clearTimeout(timeout);
      removeAbortListener();
    }
  }
  throw lastError;
}

function anthropicHeaders(config, additional = {}) {
  return {
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    ...additional,
  };
}

async function apiError(response) {
  const text = await response.text();
  const error = new Error(`Anthropic API error ${response.status}: ${text}`);
  error.status = response.status;
  return error;
}

function normalizeUsage(usage = {}) {
  const promptTokens = Number(usage.input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function mapStopReason(reason) {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "refusal") return "stop";
  return reason;
}

function linkAbortSignal(signal, controller) {
  if (!signal) return () => {};
  const onAbort = () => controller.abort(signal.reason ?? new Error("Task interrupted."));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("Task interrupted.");
  error.name = "AbortError";
  throw error;
}

function shouldRetry(error) {
  if (error.name === "AbortError") return true;
  if (/Request timed out/i.test(error.message ?? "")) return true;
  if (error.status === 429 || error.status === 529 || (error.status >= 500 && error.status <= 599)) return true;
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error.message ?? "");
}

function backoffMs(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 4000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
