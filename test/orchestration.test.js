import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeTaskCoordination } from "../src/agent/coordination.js";
import { compactToolResult } from "../src/agent/loop.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { createToolRuntime } from "../src/tools/runtime.js";

test("research worker tools are read-only", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-worker-tools-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    permissionMode: "workspace-write",
  });
  const workerTools = runtime.createWorkerTools({ mode: "research" });

  assert.deepEqual(
    workerTools.schemas.map((schema) => schema.function.name),
    ["list_files", "read_file", "search_text", "git_status", "git_diff"],
  );

  const result = await workerTools.execute("write_file", { path: "blocked.txt", content: "no" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_TOOL_BLOCKED");
});

test("verify workers can run shell but cannot edit files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-worker-tools-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    allowShellWithoutPrompt: true,
    permissionMode: "workspace-write",
  });
  const workerTools = runtime.createWorkerTools({ mode: "verify" });

  assert.equal(workerTools.schemas.some((schema) => schema.function.name === "run_shell"), true);
  assert.equal(workerTools.schemas.some((schema) => schema.function.name === "write_file"), false);

  const result = await workerTools.execute("write_file", { path: "blocked.txt", content: "no" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_TOOL_BLOCKED");
});

test("implement workers can edit files within their delegated scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-worker-tools-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    permissionMode: "workspace-write",
  });
  const workerTools = runtime.createWorkerTools({ mode: "implement" });

  await writeFile(join(workspace, "target.txt"), "old", "utf8");
  const result = await workerTools.execute("edit_file", {
    path: "target.txt",
    search: "old",
    replace: "new",
  });

  assert.equal(result.ok, true);
});

test("coordination assigns explicit worker modes for complex edit tasks", () => {
  const coordination = analyzeTaskCoordination(
    "Inspect the repo, implement the fix, run tests, and explain residual risk in detail.",
  );

  assert.equal(coordination.complex, true);
  assert.equal(coordination.parallel[0]?.mode, "research");
  assert.equal(coordination.serial[0]?.mode, "implement");
  assert.equal(coordination.verification?.mode, "verify");
});

test("simple prompts omit complex coordination protocol", () => {
  const prompt = buildSystemPrompt("/tmp/workspace", "general", [], { complex: false });

  assert.equal(prompt.includes("Complex-task coordination:"), false);
});

test("tool observations are compacted before returning to the model", () => {
  const result = compactToolResult("run_shell", {
    ok: true,
    stdout: "x".repeat(13000),
    stderr: "",
    activity: { kind: "command", label: "Ran command", target: "big" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.activity.target, "big");
  assert.equal(result.stdout.length < 12200, true);
  assert.match(result.stdout, /truncated 1000 additional characters/);
});
