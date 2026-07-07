export const TERMINAL_TRANSITIONS = Object.freeze({
  COMPLETED: "completed",
  PSEUDO_TOOL_CALL_TEXT: "pseudo_tool_call_text",
  REVIEW_SCHEMA_INVALID: "review_schema_invalid",
});

export const CONTINUE_TRANSITIONS = Object.freeze({
  TOOL_USE: "tool_use",
  TOOL_ERROR: "tool_error",
  FINAL_VALIDATION_REPAIR: "final_validation_repair",
});

export function terminalTransition(reason, extra = {}) {
  return { type: "terminal", reason, ...extra };
}

export function continueTransition(reason, extra = {}) {
  return { type: "continue", reason, ...extra };
}

