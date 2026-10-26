import { formatActionPrompt } from "../terminal/markdown.js";
import { readPromptLine, selectOption } from "../terminal/select.js";

export function createPrompter(autoApproveShell) {
  return async (question, options = {}) => {
    throwIfAborted(options.signal);
    if (autoApproveShell && options.kind === "shell-command-approval") return true;
    if (options.kind === "step-budget-continue" && process.stdin.isTTY && process.stdout.isTTY) {
      const selected = await selectOption({
        title: question,
        options: [{ label: `Continue ${options.limit} more steps`, value: "approve" }, { label: "Stop here (resume later with /continue)", value: "deny" }],
        filterable: false,
        signal: options.signal,
      });
      throwIfAborted(options.signal);
      return selected?.value ?? "deny";
    }
    if (
      (options.kind === "file-write-approval" || options.kind === "shell-command-approval") &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const alwaysLabel = options.kind === "shell-command-approval" ? "Always Approve This Command" : "Always Approve";
      const promptOptions = [
        { label: "Approve", value: "approve" },
        { label: "Deny", value: "deny" },
        { label: alwaysLabel, value: "always" },
      ];
      if (options.kind === "shell-command-approval") {
        promptOptions.push({ label: "Always Approve All Commands", value: "always-all" });
      }
      const selected = await selectOption({
        title: question,
        options: promptOptions,
        filterable: false,
        signal: options.signal,
      });
      throwIfAborted(options.signal);
      return selected?.value ?? "deny";
    }
    const answer = await readPromptLine(formatActionPrompt(question) + " [y/N] ", [], { signal: options.signal });
    throwIfAborted(options.signal);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error(signal.reason?.message ?? "Task interrupted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}
