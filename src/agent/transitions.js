export const TERMINAL_TRANSITIONS = Object.freeze({
  COMPLETED: "completed",
  PSEUDO_TOOL_CALL_TEXT: "pseudo_tool_call_text",
  MAX_STEPS_FINALIZED: "max_steps_finalized",
  MAX_STEPS: "max_steps",
  MODEL_ERROR: "model_error",
});

export const CONTINUE_TRANSITIONS = Object.freeze({
  TOOL_USE: "tool_use",
  TOOL_ERROR: "tool_error",
  FINALIZE_AFTER_MAX_STEPS: "finalize_after_max_steps",
});

export function terminalTransition(reason, extra = {}) {
  return { type: "terminal", reason, ...extra };
}

export function continueTransition(reason, extra = {}) {
  return { type: "continue", reason, ...extra };
}

export function transitionReason(transition) {
  return transition?.reason ?? "unknown";
}

