export function createVerificationStateMachine() {
  let state = emptyVerificationState();

  return {
    observeTool({ name, args = {}, result = {}, step }) {
      state = advanceVerificationState(state, { name, args, result, step });
      return state;
    },
    snapshot() {
      return structuredClone(state);
    },
  };
}

export function emptyVerificationState() {
  return {
    status: "not-run",
    commands: [],
    transitions: [],
  };
}

export function advanceVerificationState(state, event) {
  const current = state ?? emptyVerificationState();
  if (event.name === "run_shell") return recordCommand(current, event);
  if ((event.name === "edit_file" || event.name === "write_file") && current.status === "failed") {
    return transition(current, "fixed-pending-rerun", {
      type: "file-change-after-failure",
      tool: event.name,
      step: event.step,
      target: event.args?.path ?? "",
    });
  }
  return current;
}

function recordCommand(state, event) {
  const command = String(event.args?.command ?? "");
  const ok = event.result?.ok !== false;
  const attempt = {
    command,
    ok,
    step: event.step,
    stdout: summarize(event.result?.stdout),
    stderr: summarize(event.result?.stderr),
    error: event.result?.error ?? "",
  };
  const commands = [...state.commands, attempt];
  let status;
  if (ok) {
    status = ["failed", "fixed-pending-rerun"].includes(state.status) ? "failed-then-passed" : "passed";
  } else {
    status = "failed";
  }
  return transition({ ...state, commands }, status, {
    type: "command-result",
    command,
    ok,
    step: event.step,
  });
}

function transition(state, status, detail) {
  if (state.status === status) {
    return {
      ...state,
      status,
      transitions: [...state.transitions, detail],
    };
  }
  return {
    ...state,
    status,
    transitions: [
      ...state.transitions,
      {
        ...detail,
        from: state.status,
        to: status,
      },
    ],
  };
}

function summarize(value) {
  const text = String(value ?? "").trim();
  return text.length > 1000 ? text.slice(0, 1000) + "\n... truncated" : text;
}
