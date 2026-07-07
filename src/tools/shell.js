import { exec } from "node:child_process";
import { promisify } from "node:util";
import { classifyShellCommand } from "../permissions/shellPolicy.js";

const execAsync = promisify(exec);

export async function runShell(workspace, args, prompter, allowShellWithoutPrompt, permissionState, signal) {
  if (!args.command) return { ok: false, error: "command is required" };
  const policy = classifyShellCommand(args.command);
  if (policy.level === "block") {
    return {
      ok: false,
      error: "Shell command blocked by guardrails: " + policy.reasons.join(", "),
      code: "SHELL_COMMAND_BLOCKED",
      activity: { kind: "command", label: "Blocked command", target: args.command, detail: policy.reasons.join(", ") },
    };
  }
  const decision =
    allowShellWithoutPrompt || permissionState.shellApprovedAlways
      ? "approve"
      : await prompter(shellPrompt(args.command, policy), { kind: "shell-command-approval", policy });
  if (decision === "always") {
    permissionState.shellApprovedAlways = true;
  }
  const allowed = decision === true || decision === "approve" || decision === "always";
  if (!allowed) return { ok: false, error: "User denied shell command." };

  try {
    const { stdout, stderr } = await execAsync(args.command, {
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
      activity: { kind: "command", label: "Ran command", target: args.command, detail: policy.level === "warn" ? policy.reasons.join(", ") : "" },
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
