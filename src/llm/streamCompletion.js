// A transport EOF is not proof that the model finished its message. Keep a single
// error contract for both streaming protocols and preserve any reported usage.
export function incompleteResponse(message, usage) {
  const error = new Error(message);
  error.code = "INCOMPLETE_RESPONSE";
  if (usage) error.usage = usage;
  return error;
}

export function assertCompleteToolCalls(toolCalls = [], usage) {
  for (const call of toolCalls) {
    let args;
    try {
      args = JSON.parse(call?.function?.arguments ?? "");
    } catch {
      throw incompleteResponse("Stream ended with incomplete tool arguments.", usage);
    }
    if (!call?.id || !call.function?.name || !args || typeof args !== "object" || Array.isArray(args)) {
      throw incompleteResponse("Stream ended with an incomplete tool call.", usage);
    }
  }
}
