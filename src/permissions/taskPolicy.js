import { relative, resolve } from "node:path";

const WRITING_TOOLS = new Set([
  "apply_patch", "apply_patch_set", "apply_json_patch", "edit_file", "write_file", "run_shell", "start_job", "stop_job",
]);
const RESEARCH_TOOLS = new Set(["list_files", "read_file", "search_text", "git_diff", "git_status", "find_symbols", "find_references", "task_diff", "read_output", "search_output"]);
const FILE_TARGET_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "apply_json_patch", "propose_patch", "apply_patch_set", "propose_patch_set"]);
export const TEST_PATH_SEGMENTS = ["test", "tests", "spec", "specs", "__tests__", "__mocks__"];
export const GENERATED_PATH_SEGMENTS = ["dist", "build", "coverage", ".next", "generated", "__generated__"];
// Regex fragments match a complete path component. OS sandbox builders consume
// the same fragments, including files that may be created after launch.
const TEST_NAME = "(?:[tT][eE][sS][tT][sS]?|[sS][pP][eE][cC][sS]?)";
export const TEST_FILE_NAME_PATTERN = `(?:${TEST_NAME}[._-][^/]*|[^/]*[._-]${TEST_NAME}(?:[._-][^/]*)?|[^/]*(?:Test|Tests|Spec|Specs)\\.[^/]+)`;
const testFileName = new RegExp(`^${TEST_FILE_NAME_PATTERN}$`);

export function buildTaskToolPolicy(taskSpec = {}) {
  const mayWrite = taskSpec.mayWrite === true;
  return {
    name: mayWrite ? "task contract" : "read-only task contract",
    mayWrite,
    explicitReadOnly: taskSpec.explicitReadOnly === true,
    writeRestrictions: structuredClone(taskSpec.writeRestrictions ?? []),
    blockedTools: mayWrite ? [] : ["propose_patch", "propose_patch_set", ...WRITING_TOOLS],
    allowedWorkerModes: mayWrite ? ["research", "verify", "implement"] : ["research", "verify"],
  };
}

// Both advertised schemas and execution must use this intersection. A verify worker may run
// commands only when its parent can write: shell commands can have arbitrary side effects.
export function effectiveToolNames({ toolNames = [], permissionMode, taskPolicy, workerMode, workspace, scopedWriteRestrictions } = {}) {
  return toolNames.filter((name) => !taskToolPolicyViolation(name, {}, { permissionMode, taskPolicy, workerMode, workspace, scopedWriteRestrictions }));
}

export function taskToolPolicyViolation(name, args = {}, { permissionMode, taskPolicy, workerMode, workspace, scopedWriteRestrictions = false } = {}) {
  const readOnly = permissionMode === "read-only" || taskPolicy?.mayWrite === false || taskPolicy?.explicitReadOnly === true;
  if (asSet(taskPolicy?.blockedTools).has(name)) return violation("TASK_TOOL_BLOCKED", `${name} is blocked by the task tool policy.`);
  if (readOnly && WRITING_TOOLS.has(name)) return violation("TOOL_READ_ONLY", "The effective task permissions are read-only; file changes and shell commands are unavailable.");
  if (taskPolicy?.writeRestrictions?.length) {
    if (["run_shell", "start_job"].includes(name) && !scopedWriteRestrictions) return violation("TASK_SCOPED_SHELL_UNAVAILABLE", "This task prohibits writes to selected paths. Shell execution requires an OS backend that enforces those restrictions; the current backend cannot provide that guarantee.");
    for (const path of taskWriteTargets(name, args)) {
      const blocked = taskWritePathViolation(path, taskPolicy, { workspace });
      if (blocked) return blocked;
    }
  }
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

export function taskWriteTargets(name, args = {}) {
  if (!FILE_TARGET_TOOLS.has(name)) return [];
  if (name.endsWith("_set")) return (Array.isArray(args.files) ? args.files : []).flatMap((file) => [file?.path, file?.from]).filter((path) => typeof path === "string");
  return typeof args.path === "string" ? [args.path] : [];
}

export function taskWritePathViolation(path, taskPolicy, { workspace = "/" } = {}) {
  const normalized = relative(resolve(workspace), resolve(workspace, String(path).replaceAll("\\", "/"))).replaceAll("\\", "/");
  const parts = normalized.toLowerCase().split("/");
  for (const rule of taskPolicy?.writeRestrictions ?? []) {
    let blocked = rule.kind === "tests" && (parts.some((part) => TEST_PATH_SEGMENTS.includes(part)) || normalized.split("/").some((part) => testFileName.test(part)));
    blocked ||= rule.kind === "generated" && (parts.some((part) => GENERATED_PATH_SEGMENTS.includes(part)) || /\.generated\.[^/]+$/i.test(normalized));
    if (rule.kind === "path" && typeof rule.path === "string") {
      const denied = relative(resolve(workspace), resolve(workspace, rule.path.replaceAll("\\", "/"))).replaceAll("\\", "/");
      // An explicit path protects itself and all descendants, including moves.
      const insensitive = ["darwin", "win32"].includes(process.platform);
      const targetPath = insensitive ? normalized.toLowerCase() : normalized;
      const deniedPath = insensitive ? denied.toLowerCase() : denied;
      blocked ||= targetPath === deniedPath || targetPath.startsWith(deniedPath + "/") || deniedPath === "";
    }
    if (blocked) return violation("TASK_WRITE_PATH_BLOCKED", `The task prohibits modifying ${normalized || "."} (${rule.kind === "path" ? rule.path : rule.kind}).`);
  }
  return null;
}

function asSet(values) { return values instanceof Set ? values : new Set(values ?? []); }
function violation(code, error) { return { ok: false, code, error }; }
