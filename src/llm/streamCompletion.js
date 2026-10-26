// A transport EOF is not proof that the model finished its message. Keep a single
// error contract for both streaming protocols and preserve any reported usage.
export function incompleteResponse(message, usage) {
  const error = new Error(message);
  error.code = "INCOMPLETE_RESPONSE";
  if (usage) error.usage = usage;
  return error;
}

export function assertCompleteToolCalls(toolCalls = [], usage, finishReason) {
  for (const call of toolCalls) {
    let args;
    try {
      args = JSON.parse(call?.function?.arguments ?? "");
    } catch {
      // "length" means the output-token cap cut the call off, not a broken stream.
      throw incompleteResponse(finishReason === "length"
        ? "The model reached its output-token limit while writing a tool call. Raise DEECOO_MAX_TOKENS to allow longer tool calls."
        : "Stream ended with incomplete tool arguments.", usage);
    }
    if (!call?.id || !call.function?.name || !args || typeof args !== "object" || Array.isArray(args)) {
      throw incompleteResponse("Stream ended with an incomplete tool call.", usage);
    }
  }
}

// A non-streaming response can be cut off by the output-token cap just like a stream. An
// OpenAI-compatible tool call then arrives with truncated JSON; an Anthropic tool_use block is
// re-serialized from a parsed object, so it always parses and only the stop reason reveals the cut.
// Reject both before any tool runs, as the streaming paths do.
export function assertCompleteResponse(response, { lengthTruncatesToolCalls = false } = {}) {
  const choice = response?.choices?.[0];
  const toolCalls = choice?.message?.tool_calls ?? [];
  if (!toolCalls.length) return response;
  if (lengthTruncatesToolCalls && choice.finish_reason === "length") {
    throw incompleteResponse("The model reached its output-token limit while writing a tool call. Raise DEECOO_MAX_TOKENS to allow longer tool calls.", response.usage);
  }
  assertCompleteToolCalls(toolCalls, response.usage, choice.finish_reason);
  return response;
}
