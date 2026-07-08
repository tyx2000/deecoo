export function createWorkflowState({ requestType = "general" } = {}) {
  return {
    status: "initialized",
    requestType,
    phase: "start",
    transitions: [
      {
        from: undefined,
        to: "initialized",
        phase: "start",
        at: new Date().toISOString(),
      },
    ],
  };
}

export function advanceWorkflowState(state, event) {
  const current = state ?? createWorkflowState();
  if (event.type === "planned") return transition(current, "planned", "planning", event);
  if (event.type === "model-start") return transition(current, "executing", "model", event);
  if (event.type === "tool-start") return transition(current, toolPhase(event.tool), toolPhase(event.tool), event);
  if (event.type === "final-validation-repair") return transition(current, "repairing", "review-schema-repair", event);
  if (event.type === "completed") return transition(current, "completed", "done", event);
  if (event.type === "failed") return transition(current, "failed", "error", event);
  return current;
}

function toolPhase(tool) {
  if (tool === "run_shell") return "verifying";
  if (tool === "propose_patch" || tool === "propose_patch_set") return "planning";
  if (tool === "apply_patch" || tool === "apply_patch_set" || tool === "apply_json_patch" || tool === "edit_file" || tool === "write_file") return "implementing";
  if (tool === "agent" || tool === "send_message" || tool === "task_stop") return "orchestrating";
  return "researching";
}

function transition(state, status, phase, event) {
  const next = {
    ...state,
    status,
    phase,
  };
  next.transitions = [
    ...state.transitions,
    {
      from: state.status,
      to: status,
      phase,
      type: event.type,
      tool: event.tool,
      step: event.step,
      at: new Date().toISOString(),
    },
  ];
  return next;
}
