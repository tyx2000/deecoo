import { classifyShellCommand, normalizeShellCommand } from "../permissions/shellPolicy.js";
import { createExecutionBackend } from "../execution/backend.js";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { assertExistingWorkspacePath, assertSafePath, isExcludedWorkspacePath } from "./pathPolicy.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 20 * 1024;

const ALWAYS_DECISION_HANDLERS = {
  always: async (permissionState, approvedCommandKey) => {
    permissionState.approvedShellCommands?.add(approvedCommandKey);
    await permissionState.onApproveShellCommand?.(approvedCommandKey);
  },
  "always-all": async (permissionState) => {
    permissionState.autoApproveAllShell = true;
    await permissionState.onApproveAllShellCommands?.();
  },
};

export async function runShell(workspace, args, prompter, allowShellWithoutPrompt, permissionState, signal) {
  if (!args.command) return { ok: false, error: "command is required" };
  let executionCwd;
  try { executionCwd = await validateExecutionCwd(workspace, args.cwd); }
  catch (error) { return { ok: false, code: "SHELL_CWD_BLOCKED", error: error.message }; }
  const command = String(args.command);
  const approvedCommandKey = normalizeShellCommand(command);
  const policy = classifyShellCommand(command, { egressAllowlist: permissionState.egressAllowlist });
  if (policy.level === "block") {
    return {
      ok: false,
      error: "Shell command blocked by guardrails: " + policy.reasons.join(", "),
      code: "SHELL_COMMAND_BLOCKED",
      activity: { kind: "command", label: "Blocked command", target: command, detail: policy.reasons.join(", ") },
    };
  }
  const commandIsSafe = policy.level === "allow";
  const hasStandingApproval =
    allowShellWithoutPrompt ||
    permissionState.autoApproveAllShell ||
    permissionState.approvedShellCommands?.has(approvedCommandKey);
  const decision =
    commandIsSafe || hasStandingApproval
      ? "approve"
      : await prompter(shellPrompt(command, policy) + (args.cwd ? `\nWorking directory: ${executionCwd}` : ""), { kind: "shell-command-approval", policy, command, cwd: executionCwd });
  throwIfAborted(signal);
  await ALWAYS_DECISION_HANDLERS[decision]?.(permissionState, approvedCommandKey);
  throwIfAborted(signal);
  const allowed = decision !== "deny" && decision !== false;
  if (!allowed) return { ok: false, error: "User denied shell command." };

  try {
    executionCwd = await validateExecutionCwd(workspace, args.cwd);
    const backend = permissionState.executionBackend ?? createExecutionBackend({ cwd: workspace });
    const environment = permissionState.executionEnv ? { env: permissionState.executionEnv, replaceEnv: true } : {};
    if (args.background === true) {
      const job = await backend.startJob({ command, cwd: executionCwd, timeoutMs: args.timeoutMs, signal, ...environment });
      const ok = ["starting", "running"].includes(job.status) || (job.status === "exited" && job.exitCode === 0 && job.treeCleanup?.confirmed);
      return { ...job, ok: Boolean(ok), shellPolicy: policy, activity: { kind: "command", label: "Started job", target: command, detail: job.jobId } };
    }
    const result = await backend.run({ command, cwd: executionCwd, timeoutMs: Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), signal, ...environment });
    const stdoutResult = truncateOutput(result.stdout);
    const stderrResult = truncateOutput(result.stderr);
    if (result.stdoutTruncated && !stdoutResult.truncated) { stdoutResult.truncated = true; stdoutResult.text += "\n... output truncated to 20KB"; }
    if (result.stderrTruncated && !stderrResult.truncated) { stderrResult.truncated = true; stderrResult.text += "\n... output truncated to 20KB"; }
    return {
      ...result,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      stdoutTruncated: stdoutResult.truncated,
      stderrTruncated: stderrResult.truncated,
      ...(result.ok ? {} : { failureSummary: summarizeFailureOutput({ stdout: stdoutResult.text, stderr: stderrResult.text, error: result.error }) }),
      shellPolicy: policy,
      activity: { kind: "command", label: "Ran command", target: command, detail: policy.level === "warn" ? policy.reasons.join(", ") : "" },
    };
  } catch (error) {
    const stdoutResult = truncateOutput(error.stdout ?? "");
    const stderrResult = truncateOutput(error.stderr ?? "");
    const failureSummary = summarizeFailureOutput({
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      error: error.message,
    });
    return {
      ok: false,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      stdoutTruncated: stdoutResult.truncated,
      stderrTruncated: stderrResult.truncated,
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      failureSummary,
      shellPolicy: policy,
    };
  }
}

async function validateExecutionCwd(workspace, requested = ".") {
  const path = assertSafePath(workspace, requested);
  if (isExcludedWorkspacePath(relative(workspace, path))) throw new Error("Execution cwd is an excluded workspace path");
  const realWorkspace = await realpath(workspace);
  const info = await assertExistingWorkspacePath(workspace, async () => realWorkspace, path === workspace ? realWorkspace : path);
  if (!info.isDirectory()) throw new Error("Execution cwd must be a directory");
  const realTarget = await realpath(path);
  if (isExcludedWorkspacePath(relative(realWorkspace, realTarget))) throw new Error("Execution cwd resolves to an excluded workspace path");
  return realTarget;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error(signal.reason?.message ?? "Task interrupted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function shellPrompt(command, policy) {
  if (policy.level !== "warn") return `Run shell command: ${command}`;
  return [
    "Run risky shell command: " + command,
    "Risk: " + policy.reasons.join(", "),
  ].join("\n");
}

function truncateOutput(value) {
  const text = String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  return {
    text: bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8") + "\n... output truncated to 20KB",
    truncated: true,
  };
}

function summarizeFailureOutput({ stdout, stderr, error }) {
  const lines = [stderr, stdout]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const selected = [];
  if (error) selected.push(error);

  for (const line of lines) {
    if (!isHighSignalFailureLine(line)) continue;
    pushUnique(selected, line);
    if (selected.length >= 40) break;
  }

  if (selected.length < 8) {
    for (const line of lines.slice(-20)) {
      pushUnique(selected, line);
      if (selected.length >= 20) break;
    }
  }

  return truncateOutput(selected.join("\n")).text;
}

function isHighSignalFailureLine(line) {
  return (
    /\b(error|failed|failure|failures|assert|expected|received|actual|exception|traceback|panic|fatal|not ok|✖|×)\b/i.test(line) ||
    /\b[A-Za-z0-9_./-]+\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|cc|cpp|h|hpp):\d+(?::\d+)?\b/.test(line) ||
    /^\s*(at\s+\S+|\d+\)|#\d+)\s+/.test(line)
  );
}

function pushUnique(lines, line) {
  if (!line || lines.includes(line)) return;
  lines.push(line);
}
