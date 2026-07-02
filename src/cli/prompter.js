import { formatActionPrompt } from "../terminal/markdown.js";
import { readPromptLine, selectOption } from "../terminal/select.js";

export function createPrompter(autoYes) {
  return async (question, options = {}) => {
    if (autoYes) return true;
    if (
      (options.kind === "file-write-approval" || options.kind === "shell-command-approval") &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const selected = await selectOption({
        title: question,
        options: [
          { label: "Approve", value: "approve" },
          { label: "Deny", value: "deny" },
          { label: "Always Approve", value: "always" },
        ],
        filterable: false,
      });
      return selected?.value ?? "deny";
    }
    const answer = await readPromptLine(formatActionPrompt(question) + " [y/N] ", []);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  };
}

