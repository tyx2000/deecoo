import { exec } from "node:child_process";
import { promisify } from "node:util";
import { classifyShellCommand, normalizeShellCommand } from "../permissions/shellPolicy.js";

const execAsync = promisify(exec);

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
      timeout: Number(args.timeoutMs ?? 120000),
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    return {
      ok: true,
      stdout,
      stderr,
      shellPolicy: policy,
      activity: { kind: "command", label: "Ran command", target: command, detail: policy.level === "warn" ? policy.reasons.join(", ") : "" },
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error: error.message,
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
