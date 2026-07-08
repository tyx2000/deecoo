import { formatActionPrompt } from "../terminal/markdown.js";
import { readPromptLine, selectOption } from "../terminal/select.js";

export function createPrompter(autoApproveShell) {
  return async (question, options = {}) => {
    if (autoApproveShell && options.kind === "shell-command-approval") return true;
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
      });
      return selected?.value ?? "deny";
    }
    const answer = await readPromptLine(formatActionPrompt(question) + " [y/N] ", []);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  };
}
