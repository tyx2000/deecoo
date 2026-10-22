const WRITING_TOOLS = new Set([
  "apply_patch", "apply_patch_set", "apply_json_patch", "edit_file", "write_file", "run_shell", "start_job", "stop_job",
]);
const RESEARCH_TOOLS = new Set(["list_files", "read_file", "search_text", "git_diff", "git_status", "find_symbols", "find_references", "task_diff", "read_output", "search_output"]);

export function buildTaskToolPolicy(taskSpec = {}) {
  const mayWrite = taskSpec.mayWrite === true;
  return {
    name: mayWrite ? "task contract" : "read-only task contract",
    mayWrite,
    explicitReadOnly: taskSpec.explicitReadOnly === true,
    blockedTools: mayWrite ? [] : ["propose_patch", "propose_patch_set", ...WRITING_TOOLS],
    allowedWorkerModes: mayWrite ? ["research", "verify", "implement"] : ["research", "verify"],
  };
}

// Both advertised schemas and execution must use this intersection. A verify worker may run
// commands only when its parent can write: shell commands can have arbitrary side effects.
export function effectiveToolNames({ toolNames = [], permissionMode, taskPolicy, workerMode } = {}) {
  return toolNames.filter((name) => !taskToolPolicyViolation(name, {}, { permissionMode, taskPolicy, workerMode }));
}

export function taskToolPolicyViolation(name, args = {}, { permissionMode, taskPolicy, workerMode } = {}) {
  const readOnly = permissionMode === "read-only" || taskPolicy?.mayWrite === false || taskPolicy?.explicitReadOnly === true;
  if (asSet(taskPolicy?.blockedTools).has(name)) return violation("TASK_TOOL_BLOCKED", `${name} is blocked by the task tool policy.`);
  if (readOnly && WRITING_TOOLS.has(name)) return violation("TOOL_READ_ONLY", "The effective task permissions are read-only; file changes and shell commands are unavailable.");
  if (workerMode === "research" && !RESEARCH_TOOLS.has(name)) return violation("WORKER_TOOL_BLOCKED", `${name} is unavailable to research workers.`);
  if (workerMode === "verify" && WRITING_TOOLS.has(name) && !["run_shell", "start_job", "stop_job"].includes(name)) return violation("WORKER_TOOL_BLOCKED", "Verify workers cannot edit files directly.");
  if (name === "agent" || name === "send_message") {
    const mode = args.mode || args.workerMode;
    if (readOnly && mode === "implement") return violation("TASK_WORKER_MODE_BLOCKED", "Read-only tasks cannot dispatch implementation workers.");
    const allowed = asSet(taskPolicy?.allowedWorkerModes);
    if (mode && allowed.size && !allowed.has(mode)) return violation("TASK_WORKER_MODE_BLOCKED", `${mode} workers are blocked by the task tool policy.`);
  }
  return null;
}

function asSet(values) { return values instanceof Set ? values : new Set(values ?? []); }
function violation(code, error) { return { ok: false, code, error }; }
