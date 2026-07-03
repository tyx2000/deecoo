import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrompter } from "../src/cli/prompter.js";
import { createToolRuntime } from "../src/tools/runtime.js";

test("--yes prompter auto-approves shell commands only", async () => {
  const prompt = createPrompter(true);

  assert.equal(await prompt("run?", { kind: "shell-command-approval" }), true);
});

test("auto-approved shell mode does not bypass read-only file permissions", async () => {
  const tools = createToolRuntime({
    cwd: process.cwd(),
    prompter: createPrompter(true),
    allowShellWithoutPrompt: true,
    permissionMode: "read-only",
  });

  const result = await tools.execute("write_file", {
    path: "test-read-only-output.txt",
    content: "should not be written",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /read-only/i);
});

test("auto-approved shell mode still prompts for ask-every-edit file writes", async () => {
  let prompted = false;
  const tools = createToolRuntime({
    cwd: process.cwd(),
    prompter: async (_question, options) => {
      if (options.kind === "file-write-approval") prompted = true;
      return "deny";
    },
    allowShellWithoutPrompt: true,
    permissionMode: "ask-every-edit",
  });

  const result = await tools.execute("write_file", {
    path: "test-denied-output.txt",
    content: "should not be written",
  });

  assert.equal(prompted, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /denied/i);
});
