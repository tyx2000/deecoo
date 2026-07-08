import { exec } from "node:child_process";
import { promisify } from "node:util";
import { classifyShellCommand, normalizeShellCommand } from "../permissions/shellPolicy.js";

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 20 * 1024;

export async function runShell(workspace, args, prompter, allowShellWithoutPrompt, permissionState, signal) {
  if (!args.command) return { ok: false, error: "command is required" };
  const command = String(args.command);
  const approvedCommandKey = normalizeShellCommand(command);
  const policy = classifyShellCommand(command);
  if (policy.level === "block") {
    return {
      ok: false,
      error: "Shell command blocked by guardrails: " + policy.reasons.join(", "),
      code: "SHELL_COMMAND_BLOCKED",
      activity: { kind: "command", label: "Blocked command", target: command, detail: policy.reasons.join(", ") },
    };
  }
  const approvedCommand = permissionState.approvedShellCommands?.has(approvedCommandKey);
  const decision =
    allowShellWithoutPrompt || approvedCommand
      ? "approve"
      : await prompter(shellPrompt(command, policy), { kind: "shell-command-approval", policy, command });
  if (decision === "always") {
    permissionState.approvedShellCommands?.add(approvedCommandKey);
    await permissionState.onApproveShellCommand?.(approvedCommandKey);
  }
  const allowed = decision === true || decision === "approve" || decision === "always";
  if (!allowed) return { ok: false, error: "User denied shell command." };

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workspace,
      timeout: Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    const stdoutResult = truncateOutput(stdout);
    const stderrResult = truncateOutput(stderr);
    return {
      ok: true,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      stdoutTruncated: stdoutResult.truncated,
      stderrTruncated: stderrResult.truncated,
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
      failureSummary,
      shellPolicy: policy,
    };
  }
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
