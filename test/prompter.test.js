import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPrompter } from "../src/cli/prompter.js";
import { addApprovedShellCommand, loadSettingsEnv, setAutoApproveAllShellCommands } from "../src/config/settings.js";
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

test("explicit file approval mode allows scripted workspace writes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scripted-write-"));
  const tools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("file write should not prompt in workspace-write mode");
    },
    allowShellWithoutPrompt: true,
    permissionMode: "workspace-write",
  });

  const result = await tools.execute("write_file", {
    path: "test-scripted-write-output.txt",
    content: "scripted write",
  });

  assert.equal(result.ok, true);
});

test("safe shell commands classified as allow-level never prompt", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-shell-allow-workspace-"));
  let prompts = 0;

  const tools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      prompts += 1;
      return "deny";
    },
  });

  const result = await tools.execute("run_shell", { command: "node -e \"console.log('safe')\"" });

  assert.equal(prompts, 0);
  assert.equal(result.ok, true);
});

test("always shell approval persists the exact command in settings", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-shell-approval-workspace-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "deecoo-shell-approval-settings-"));
  const command = "chmod 755 .";
  let prompts = 0;

  const tools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      prompts += 1;
      return prompts === 1 ? "always" : "deny";
    },
    onApproveShellCommand: (approvedCommand) => addApprovedShellCommand({ settingsPath: settingsDir, command: approvedCommand }),
  });

  const first = await tools.execute("run_shell", { command });
  const second = await tools.execute("run_shell", { command });
  const settings = await loadSettingsEnv({ settingsPath: settingsDir });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(prompts, 1);
  assert.deepEqual(settings.permissions.shell.approvedCommands, [command]);

  const reloadedTools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("approved settings command should not prompt");
    },
    approvedShellCommands: settings.permissions.shell.approvedCommands,
  });
  const reloaded = await reloadedTools.execute("run_shell", { command });

  assert.equal(reloaded.ok, true);
});

test("always-all shell approval bypasses future prompts for different warn-level commands and persists", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-shell-approve-all-workspace-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "deecoo-shell-approve-all-settings-"));
  let prompts = 0;

  const tools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      prompts += 1;
      return "always-all";
    },
    onApproveAllShellCommands: () => setAutoApproveAllShellCommands({ settingsPath: settingsDir }),
  });

  const first = await tools.execute("run_shell", { command: "chmod 755 ." });
  const second = await tools.execute("run_shell", { command: "chmod 700 ." });
  const settings = await loadSettingsEnv({ settingsPath: settingsDir });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(prompts, 1);
  assert.equal(settings.permissions.shell.autoApproveAll, true);

  const reloadedTools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("approve-all setting should suppress prompts on reload");
    },
    autoApproveAllShell: settings.permissions.shell.autoApproveAll,
  });
  const reloaded = await reloadedTools.execute("run_shell", { command: "chmod 640 ." });

  assert.equal(reloaded.ok, true);
});

test("always-all does not bypass hard-blocked commands", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-shell-block-workspace-"));

  const tools = createToolRuntime({
    cwd: workspace,
    prompter: async () => "always-all",
  });

  const result = await tools.execute("run_shell", { command: "sudo rm -rf /" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "SHELL_COMMAND_BLOCKED");
});
