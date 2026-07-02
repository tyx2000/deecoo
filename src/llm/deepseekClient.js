export function createDeepSeekClient(config) {
  return {
    async chatCompletion(request, options = {}) {
      return requestJson(config, "/chat/completions", {
        method: "POST",
        body: JSON.stringify(request),
      }, options);
    },
    async chatCompletionStream(request, handlers = {}) {
      return requestChatCompletionStream(config, {
        ...request,
        stream: true,
        stream_options: request.stream_options ?? { include_usage: true },
      }, handlers);
    },
    async listModels() {
      return requestJson(config, "/models", { method: "GET" });
    },
    async getBalance() {
      return requestJson(config, "/user/balance", { method: "GET" });
    },
  };
}

async function requestChatCompletionStream(config, request, handlers) {
  const attempts = Math.min(5, Math.max(1, config.retryAttempts ?? 5));
  let lastError;
  let emittedContent = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(handlers.signal);
    const controller = new AbortController();
    const removeAbortListener = linkAbortSignal(handlers.signal, controller);
    const timeout = setTimeout(() => controller.abort(new Error("Request timed out.")), config.timeoutMs);

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`API error ${response.status}: ${text}`);
        error.status = response.status;
        throw error;
      }

      if (!response.body) {
        throw new Error("API returned no stream body.");
      }

      const result = await readChatCompletionSse(response.body, {
        ...handlers,
        onContent(content) {
          emittedContent = true;
          handlers.onContent?.(content);
        },
      });
      return result;
    } catch (error) {
      lastError = error;
      if (isExternalAbort(handlers.signal) || emittedContent || attempt >= attempts || !shouldRetry(error)) break;
      await delay(backoffMs(attempt));
    } finally {
      clearTimeout(timeout);
      removeAbortListener();
    }
  }

  throw lastError;
}

async function readChatCompletionSse(body, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const message = { role: "assistant", content: "", tool_calls: [] };
  let finishReason;
  let usage;
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = consumeSseEvents(buffer);
    buffer = events.rest;
    for (const event of events.items) {
      if (event === "[DONE]") continue;
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
    if (event === "[DONE]") continue;
    const parsed = JSON.parse(event);
    if (parsed.usage) usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    applyChatDelta(message, choice.delta ?? {}, handlers);
  }

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
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`API error ${response.status}: ${text}`);
        error.status = response.status;
        throw error;
      }

      return text ? JSON.parse(text) : {};
    } catch (error) {
      lastError = error;
      if (isExternalAbort(options.signal) || attempt >= attempts || !shouldRetry(error)) break;
      await delay(backoffMs(attempt));
    } finally {
      clearTimeout(timeout);
      removeAbortListener();
    }
  }

  throw lastError;
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

function isExternalAbort(signal) {
  return Boolean(signal?.aborted);
}

function shouldRetry(error) {
  if (error.name === "AbortError") return true;
  if (/Request timed out/i.test(error.message ?? "")) return true;
  if (error.status === 429 || (error.status >= 500 && error.status <= 599)) return true;
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error.message ?? "");
}

function backoffMs(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 4000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
