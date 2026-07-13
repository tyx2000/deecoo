import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeTaskCoordination } from "../src/agent/coordination.js";
import { compactLiveMessages, compactToolResult, serializeRunState } from "../src/agent/loop.js";
import { runAgent } from "../src/agent/loop.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { aggregateWorkerResults, createSubagentRuntime } from "../src/agent/subagents/runtime.js";
import { buildAgentStateSummary, createAgentState, recordModelStep, recordToolStep } from "../src/agent/state.js";
import { buildContextMessages, contextItem } from "../src/context/builder.js";
import { buildProjectIndex } from "../src/context/projectIndex.js";
import { buildReviewScopeMessages, resolveReviewScope } from "../src/context/reviewScope.js";
import { buildWorkspaceSnapshot, buildWorkspaceSnapshotMessages, ensureProjectDescription } from "../src/context/workspaceSnapshot.js";
import { createTaskFinalValidator, validateTaskFinal } from "../src/harness/finalValidation.js";
import { buildTaskSpec } from "../src/harness/taskSpec.js";
import { advanceWorkflowState, createWorkflowState } from "../src/harness/workflow.js";
import {
  loadLongTermMemory,
  loadProjectMemory,
  longTermMemoryContextMessage,
  memoryLayerSummary,
  projectMemoryContextMessage,
  recordLongTermMemory,
  recordProjectMemory,
} from "../src/memory/projectMemory.js";
import { redact, saveRunAudit } from "../src/observability/audit.js";
import { classifyShellCommand } from "../src/permissions/shellPolicy.js";
import { saveRunOutputs, structuredRunResult } from "../src/reporter/outputs.js";
import { aggregateReviewReport, createReviewFinalValidator, formatReviewReportMarkdown, validateReviewReportText } from "../src/reporter/reviewReport.js";
import { scorArtifactMetadata, scorReviewToolPolicy } from "../src/skills/scor.js";
import { advanceVerificationState, emptyVerificationState } from "../src/verification/state.js";
import { buildVerificationPlan } from "../src/verification/planner.js";
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

test("propose_patch previews a diff without writing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-propose-patch-"));
  await writeFile(join(workspace, "target.txt"), "one\ntwo\nthree\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("propose_patch should not prompt");
    },
    permissionMode: "read-only",
  });

  const result = await runtime.execute("propose_patch", {
    path: "target.txt",
    search: "two",
    replace: "TWO",
  });
  const content = await readFile(join(workspace, "target.txt"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.match(result.patch, /--- a\/target\.txt/);
  assert.match(result.patch, /-two/);
  assert.match(result.patch, /\+TWO/);
  assert.equal(content, "one\ntwo\nthree\n");
});

test("propose_patch requires unique search text", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-propose-patch-"));
  await writeFile(join(workspace, "target.txt"), "same\nsame\n", "utf8");
  const runtime = createToolRuntime({ cwd: workspace, prompter: async () => "approve" });

  const result = await runtime.execute("propose_patch", {
    path: "target.txt",
    search: "same",
    replace: "next",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /matched 2/);
});

test("apply_patch applies validated structured hunks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-"));
  await writeFile(join(workspace, "target.txt"), "one\ntwo\nthree\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("workspace-write mode should not prompt");
    },
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("apply_patch", {
    path: "target.txt",
    hunks: [
      {
        oldStart: 2,
        oldLines: ["two"],
        newLines: ["TWO", "two and a half"],
      },
    ],
  });
  const content = await readFile(join(workspace, "target.txt"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.hunksApplied, 1);
  assert.equal(content, "one\nTWO\ntwo and a half\nthree\n");
});

test("apply_patch rejects stale hunk context before writing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-"));
  await writeFile(join(workspace, "target.txt"), "one\ntwo\nthree\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("stale patch should fail before approval");
    },
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("apply_patch", {
    path: "target.txt",
    hunks: [
      {
        oldStart: 2,
        oldLines: ["stale"],
        newLines: ["next"],
      },
    ],
  });
  const content = await readFile(join(workspace, "target.txt"), "utf8");

  assert.equal(result.ok, false);
  assert.equal(result.code, "PATCH_CONTEXT_MISMATCH");
  assert.equal(content, "one\ntwo\nthree\n");
});

test("apply_patch relocates uniquely matching hunk context", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-"));
  await writeFile(join(workspace, "target.txt"), "shifted\none\ntwo\nthree\n", "utf8");
  const runtime = createToolRuntime({ cwd: workspace, prompter: async () => "approve", permissionMode: "workspace-write" });

  const result = await runtime.execute("apply_patch", {
    path: "target.txt",
    hunks: [{ oldStart: 2, oldLines: ["two", "three"], newLines: ["TWO", "THREE"] }],
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(join(workspace, "target.txt"), "utf8"), "shifted\none\nTWO\nTHREE\n");
});

test("apply_patch rejects ambiguous relocated context", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-"));
  await writeFile(join(workspace, "target.txt"), "same\nother\nsame\n", "utf8");
  const runtime = createToolRuntime({ cwd: workspace, prompter: async () => "approve", permissionMode: "workspace-write" });

  const result = await runtime.execute("apply_patch", {
    path: "target.txt",
    hunks: [{ oldStart: 2, oldLines: ["same"], newLines: ["next"] }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PATCH_CONTEXT_MISMATCH");
  assert.match(result.error, /not unique/);
  assert.equal(await readFile(join(workspace, "target.txt"), "utf8"), "same\nother\nsame\n");
});

test("apply_patch supports insertion hunks and blocks read-only writes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-"));
  await writeFile(join(workspace, "target.txt"), "one\ntwo\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("read-only mode should not prompt");
    },
    permissionMode: "read-only",
  });

  const result = await runtime.execute("apply_patch", {
    path: "target.txt",
    hunks: [
      {
        oldStart: 2,
        oldLines: [],
        newLines: ["inserted"],
      },
    ],
  });
  const content = await readFile(join(workspace, "target.txt"), "utf8");

  assert.equal(result.ok, false);
  assert.match(result.error, /read-only/i);
  assert.equal(content, "one\ntwo\n");
});

test("apply_patch preserves existing CRLF line endings", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-"));
  await writeFile(join(workspace, "target.txt"), "one\r\ntwo\r\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("apply_patch", {
    path: "target.txt",
    hunks: [
      {
        oldStart: 2,
        oldLines: ["two"],
        newLines: ["TWO"],
      },
    ],
  });
  const content = await readFile(join(workspace, "target.txt"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(content, "one\r\nTWO\r\n");
});

test("apply_patch revalidates hunk context after approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-"));
  const target = join(workspace, "target.txt");
  await writeFile(target, "one\ntwo\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      await writeFile(target, "one\nchanged\n", "utf8");
      return "approve";
    },
    permissionMode: "ask-every-edit",
  });

  const result = await runtime.execute("apply_patch", {
    path: "target.txt",
    hunks: [{ oldStart: 2, oldLines: ["two"], newLines: ["TWO"] }],
  });
  const content = await readFile(target, "utf8");

  assert.equal(result.ok, false);
  assert.equal(result.code, "PATCH_CONTEXT_MISMATCH");
  assert.match(result.error, /file changed before write/);
  assert.equal(content, "one\nchanged\n");
});

test("propose_patch_set previews multiple files without writing or prompting", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-propose-patch-set-"));
  await writeFile(join(workspace, "a.txt"), "one\ntwo\n", "utf8");
  await writeFile(join(workspace, "b.txt"), "alpha\nbeta\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("propose_patch_set should not prompt");
    },
    permissionMode: "read-only",
  });

  const result = await runtime.execute("propose_patch_set", {
    files: [
      { path: "a.txt", hunks: [{ oldStart: 2, oldLines: ["two"], newLines: ["TWO"] }] },
      { path: "b.txt", hunks: [{ oldStart: 1, oldLines: ["alpha"], newLines: ["ALPHA"] }] },
    ],
  });
  const a = await readFile(join(workspace, "a.txt"), "utf8");
  const b = await readFile(join(workspace, "b.txt"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.filesChanged, 2);
  assert.deepEqual(result.paths, ["a.txt", "b.txt"]);
  assert.match(result.files[0].patch, /-two/);
  assert.match(result.files[0].patch, /\+TWO/);
  assert.equal(a, "one\ntwo\n");
  assert.equal(b, "alpha\nbeta\n");
});

test("propose_patch_set rejects stale context without writing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-propose-patch-set-"));
  await writeFile(join(workspace, "a.txt"), "one\ntwo\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("stale patch set preview should fail before approval");
    },
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("propose_patch_set", {
    files: [{ path: "a.txt", hunks: [{ oldStart: 2, oldLines: ["stale"], newLines: ["TWO"] }] }],
  });
  const content = await readFile(join(workspace, "a.txt"), "utf8");

  assert.equal(result.ok, false);
  assert.equal(result.code, "PATCH_CONTEXT_MISMATCH");
  assert.equal(content, "one\ntwo\n");
});

test("propose_patch_set previews create and move operations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-propose-patch-set-"));
  await writeFile(join(workspace, "old.txt"), "move me\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("propose_patch_set should not prompt");
    },
    permissionMode: "read-only",
  });

  const result = await runtime.execute("propose_patch_set", {
    files: [
      { action: "create", path: "new/file.txt", content: "created\n" },
      { action: "move", from: "old.txt", path: "renamed.txt" },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.filesChanged, 2);
  assert.equal(result.files[0].action, "create");
  assert.match(result.files[0].patch, /\+created/);
  assert.deepEqual(
    result.files[1],
    {
      action: "move",
      path: "renamed.txt",
      from: "old.txt",
      patch: "rename from old.txt\nrename to renamed.txt",
      additions: 0,
      deletions: 0,
    },
  );
  assert.equal(await readFile(join(workspace, "old.txt"), "utf8"), "move me\n");
  await assert.rejects(readFile(join(workspace, "new/file.txt"), "utf8"), /ENOENT/);
});

test("apply_patch_set applies multiple files after validating all hunks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-set-"));
  await writeFile(join(workspace, "a.txt"), "one\ntwo\n", "utf8");
  await writeFile(join(workspace, "b.txt"), "alpha\nbeta\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("workspace-write mode should not prompt");
    },
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("apply_patch_set", {
    files: [
      { path: "a.txt", hunks: [{ oldStart: 2, oldLines: ["two"], newLines: ["TWO"] }] },
      { path: "b.txt", hunks: [{ oldStart: 1, oldLines: ["alpha"], newLines: ["ALPHA"] }] },
    ],
  });
  const a = await readFile(join(workspace, "a.txt"), "utf8");
  const b = await readFile(join(workspace, "b.txt"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.filesChanged, 2);
  assert.deepEqual(result.paths, ["a.txt", "b.txt"]);
  assert.equal(a, "one\nTWO\n");
  assert.equal(b, "ALPHA\nbeta\n");
});

test("apply_patch_set rejects stale context without writing any file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-set-"));
  await writeFile(join(workspace, "a.txt"), "one\ntwo\n", "utf8");
  await writeFile(join(workspace, "b.txt"), "alpha\nbeta\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("stale patch set should fail before approval");
    },
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("apply_patch_set", {
    files: [
      { path: "a.txt", hunks: [{ oldStart: 2, oldLines: ["two"], newLines: ["TWO"] }] },
      { path: "b.txt", hunks: [{ oldStart: 1, oldLines: ["stale"], newLines: ["ALPHA"] }] },
    ],
  });
  const a = await readFile(join(workspace, "a.txt"), "utf8");
  const b = await readFile(join(workspace, "b.txt"), "utf8");

  assert.equal(result.ok, false);
  assert.equal(result.code, "PATCH_CONTEXT_MISMATCH");
  assert.match(result.error, /b\.txt/);
  assert.equal(a, "one\ntwo\n");
  assert.equal(b, "alpha\nbeta\n");
});

test("apply_patch_set rolls back earlier writes when a later write fails", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-set-"));
  const aPath = join(workspace, "a.txt");
  const bPath = join(workspace, "b.txt");
  await writeFile(aPath, "one\ntwo\n", "utf8");
  await writeFile(bPath, "alpha\nbeta\n", "utf8");
  await chmod(bPath, 0o444);
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("workspace-write mode should not prompt");
    },
    permissionMode: "workspace-write",
  });

  try {
    const result = await runtime.execute("apply_patch_set", {
      files: [
        { path: "a.txt", hunks: [{ oldStart: 2, oldLines: ["two"], newLines: ["TWO"] }] },
        { path: "b.txt", hunks: [{ oldStart: 1, oldLines: ["alpha"], newLines: ["ALPHA"] }] },
      ],
    });
    const a = await readFile(aPath, "utf8");
    const b = await readFile(bPath, "utf8");

    assert.equal(result.ok, false);
    assert.equal(result.code, "PATCH_SET_WRITE_FAILED");
    assert.equal(result.rolledBack, true);
    assert.deepEqual(result.filesRolledBack, ["a.txt"]);
    assert.equal(a, "one\ntwo\n");
    assert.equal(b, "alpha\nbeta\n");
  } finally {
    await chmod(bPath, 0o644).catch(() => {});
  }
});

test("apply_patch_set rejects duplicate paths", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-set-"));
  await writeFile(join(workspace, "a.txt"), "one\n", "utf8");
  const runtime = createToolRuntime({ cwd: workspace, prompter: async () => "approve" });

  const result = await runtime.execute("apply_patch_set", {
    files: [
      { path: "a.txt", hunks: [{ oldStart: 1, oldLines: ["one"], newLines: ["ONE"] }] },
      { path: "./a.txt", hunks: [{ oldStart: 1, oldLines: ["one"], newLines: ["ONE"] }] },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /duplicate patch path/);
});

test("apply_patch_set creates and moves files structurally", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-set-"));
  await writeFile(join(workspace, "old.txt"), "move me\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("workspace-write mode should not prompt");
    },
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("apply_patch_set", {
    files: [
      { action: "create", path: "new/file.txt", content: "created\n" },
      { action: "move", from: "old.txt", path: "renamed.txt" },
    ],
  });
  const created = await readFile(join(workspace, "new/file.txt"), "utf8");
  const moved = await readFile(join(workspace, "renamed.txt"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.filesChanged, 2);
  assert.equal(created, "created\n");
  assert.equal(moved, "move me\n");
  await assert.rejects(readFile(join(workspace, "old.txt"), "utf8"), /ENOENT/);
});

test("apply_patch_set rejects create overwrite and move target overwrite", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-set-"));
  await writeFile(join(workspace, "exists.txt"), "exists\n", "utf8");
  await writeFile(join(workspace, "source.txt"), "source\n", "utf8");
  await writeFile(join(workspace, "target.txt"), "target\n", "utf8");
  const runtime = createToolRuntime({ cwd: workspace, prompter: async () => "approve" });

  const createResult = await runtime.execute("apply_patch_set", {
    files: [{ action: "create", path: "exists.txt", content: "new\n" }],
  });
  const moveResult = await runtime.execute("apply_patch_set", {
    files: [{ action: "move", from: "source.txt", path: "target.txt" }],
  });

  assert.equal(createResult.ok, false);
  assert.match(createResult.error, /already exists/);
  assert.equal(moveResult.ok, false);
  assert.match(moveResult.error, /already exists/);
  assert.equal(await readFile(join(workspace, "exists.txt"), "utf8"), "exists\n");
  assert.equal(await readFile(join(workspace, "source.txt"), "utf8"), "source\n");
  assert.equal(await readFile(join(workspace, "target.txt"), "utf8"), "target\n");
});

test("apply_patch_set revalidates create targets after approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-set-"));
  const target = join(workspace, "created.txt");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      await writeFile(target, "appeared\n", "utf8");
      return "approve";
    },
    permissionMode: "ask-every-edit",
  });

  const result = await runtime.execute("apply_patch_set", {
    files: [{ action: "create", path: "created.txt", content: "created\n" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PATCH_SET_CHANGED_BEFORE_WRITE");
  assert.match(result.error, /already exists/);
  assert.equal(await readFile(target, "utf8"), "appeared\n");
});

test("apply_patch_set revalidates move targets after approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-set-"));
  const source = join(workspace, "source.txt");
  const target = join(workspace, "target.txt");
  await writeFile(source, "source\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      await writeFile(target, "appeared\n", "utf8");
      return "approve";
    },
    permissionMode: "ask-every-edit",
  });

  const result = await runtime.execute("apply_patch_set", {
    files: [{ action: "move", from: "source.txt", path: "target.txt" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PATCH_SET_CHANGED_BEFORE_WRITE");
  assert.match(result.error, /already exists/);
  assert.equal(await readFile(source, "utf8"), "source\n");
  assert.equal(await readFile(target, "utf8"), "appeared\n");
});

test("apply_patch_set rolls back created and moved files after a later write failure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-apply-patch-set-"));
  const blockedPath = join(workspace, "blocked.txt");
  await writeFile(join(workspace, "source.txt"), "source\n", "utf8");
  await writeFile(blockedPath, "blocked\n", "utf8");
  await chmod(blockedPath, 0o444);
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("workspace-write mode should not prompt");
    },
    permissionMode: "workspace-write",
  });

  try {
    const result = await runtime.execute("apply_patch_set", {
      files: [
        { action: "create", path: "created.txt", content: "created\n" },
        { action: "move", from: "source.txt", path: "moved.txt" },
        { path: "blocked.txt", hunks: [{ oldStart: 1, oldLines: ["blocked"], newLines: ["BLOCKED"] }] },
      ],
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "PATCH_SET_WRITE_FAILED");
    assert.equal(await readFile(join(workspace, "source.txt"), "utf8"), "source\n");
    await assert.rejects(readFile(join(workspace, "created.txt"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(workspace, "moved.txt"), "utf8"), /ENOENT/);
    assert.equal(await readFile(blockedPath, "utf8"), "blocked\n");
  } finally {
    await chmod(blockedPath, 0o644).catch(() => {});
  }
});

test("apply_json_patch applies JSON AST operations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-json-patch-"));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" }, keywords: ["cli"], private: true }, null, 2) + "\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("workspace-write mode should not prompt");
    },
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("apply_json_patch", {
    path: "package.json",
    operations: [
      { op: "set", pointer: "/scripts/check", value: "node --check index.js" },
      { op: "append", pointer: "/keywords", value: "agent" },
      { op: "delete", pointer: "/private" },
    ],
  });
  const parsed = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(result.operationsApplied, 3);
  assert.equal(parsed.scripts.check, "node --check index.js");
  assert.deepEqual(parsed.keywords, ["cli", "agent"]);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "private"), false);
});

test("apply_json_patch rejects invalid AST operations before writing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-json-patch-"));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "demo" }, null, 2) + "\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("invalid JSON patch should fail before approval");
    },
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("apply_json_patch", {
    path: "package.json",
    operations: [{ op: "append", pointer: "/name", value: "bad" }],
  });
  const content = await readFile(join(workspace, "package.json"), "utf8");

  assert.equal(result.ok, false);
  assert.match(result.error, /append target must be an array/);
  assert.equal(content, JSON.stringify({ name: "demo" }, null, 2) + "\n");
});

test("apply_json_patch rejects array set beyond append position", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-json-patch-"));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ keywords: ["cli"] }, null, 2) + "\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("invalid JSON patch should fail before approval");
    },
    permissionMode: "workspace-write",
  });

  const result = await runtime.execute("apply_json_patch", {
    path: "package.json",
    operations: [{ op: "set", pointer: "/keywords/2", value: "agent" }],
  });
  const content = await readFile(join(workspace, "package.json"), "utf8");

  assert.equal(result.ok, false);
  assert.match(result.error, /beyond append position/);
  assert.equal(content, JSON.stringify({ keywords: ["cli"] }, null, 2) + "\n");
});

test("apply_json_patch revalidates JSON operations after approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-json-patch-"));
  const target = join(workspace, "package.json");
  await writeFile(target, JSON.stringify({ keywords: [] }, null, 2) + "\n", "utf8");
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      await writeFile(target, JSON.stringify({ keywords: "bad" }, null, 2) + "\n", "utf8");
      return "approve";
    },
    permissionMode: "ask-every-edit",
  });

  const result = await runtime.execute("apply_json_patch", {
    path: "package.json",
    operations: [{ op: "append", pointer: "/keywords", value: "agent" }],
  });
  const content = await readFile(target, "utf8");

  assert.equal(result.ok, false);
  assert.equal(result.code, "FILE_CHANGED_BEFORE_WRITE");
  assert.match(result.error, /file changed before write/);
  assert.equal(content, JSON.stringify({ keywords: "bad" }, null, 2) + "\n");
});

test("coordination assigns explicit worker modes for complex edit tasks", () => {
  const coordination = analyzeTaskCoordination(
    "Inspect the repo, implement the fix, run tests, and explain residual risk in detail.",
  );

  assert.equal(coordination.complex, true);
  assert.equal(coordination.splitTriggers.some((trigger) => trigger.name === "Independent verification"), true);
  assert.equal(coordination.parallel[0]?.role, "planner");
  assert.equal(coordination.parallel[0]?.mode, "research");
  assert.equal(coordination.serial[0]?.role, "coder");
  assert.equal(coordination.serial[0]?.mode, "implement");
  assert.equal(coordination.verification?.role, "tester");
  assert.equal(coordination.verification?.mode, "verify");
});

test("coordination assigns security and reviewer role presets for risk separation", () => {
  const coordination = analyzeTaskCoordination(
    "修改 shell 权限策略，并审查安全风险、secret 泄漏和 path traversal，最后运行测试验证。",
  );

  assert.equal(coordination.complex, true);
  assert.equal(coordination.splitTriggers.some((trigger) => trigger.name === "Safety separation"), true);
  assert.equal(coordination.agents.some((agent) => agent.role === "security" && agent.mode === "research"), true);
  assert.equal(coordination.agents.some((agent) => agent.role === "coder" && agent.mode === "implement"), true);
  assert.equal(coordination.agents.some((agent) => agent.role === "tester" && agent.mode === "verify"), true);
});

test("coordination does not treat ambiguous continuation as edit without code context", () => {
  assert.equal(analyzeTaskCoordination("继续分析当前 harness 设计").requestType, "analysis");
  assert.equal(analyzeTaskCoordination("继续完善输出策略是否合理").requestType, "analysis");
  assert.equal(analyzeTaskCoordination("继续完善代码实现并运行测试").requestType, "edit");
});

test("simple prompts omit complex coordination protocol", () => {
  const prompt = buildSystemPrompt("/tmp/workspace", "general", [], { complex: false });

  assert.equal(prompt.includes("Complex-task coordination:"), false);
});

test("complex prompt includes role presets and split triggers", () => {
  const coordination = analyzeTaskCoordination(
    "修改 shell 权限策略，并审查安全风险、secret 泄漏和 path traversal，最后运行测试验证。",
  );
  const prompt = buildSystemPrompt("/tmp/workspace", "edit", [], coordination);

  assert.match(prompt, /Split triggers/);
  assert.match(prompt, /role=security/);
  assert.match(prompt, /role=coder/);
  assert.match(prompt, /role=tester/);
});

test("base prompt states CLI operating procedure", () => {
  const prompt = buildSystemPrompt("/tmp/workspace", "edit", [], { complex: false });

  assert.match(prompt, /Core operating procedure/);
  assert.match(prompt, /You cannot access files directly/);
  assert.match(prompt, /Before editing, inspect the relevant current files/);
  assert.match(prompt, /use propose_patch first/);
  assert.match(prompt, /Use apply_patch for structured multi-line edits/);
  assert.match(prompt, /Use propose_patch_set to preview coherent multi-file changes/);
  assert.match(prompt, /Use apply_json_patch for JSON AST edits/);
  assert.match(prompt, /Never access files outside the workspace/);
  assert.match(prompt, /When done, summarize/);
  assert.match(prompt, /files changed/);
  assert.match(prompt, /tests or checks run/);
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

test("S-COR task policy blocks writes and implement workers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scor-policy-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    permissionMode: "workspace-write",
  });

  runtime.setTaskToolPolicy(scorReviewToolPolicy());

  const proposeResult = await runtime.execute("propose_patch", {
    path: "blocked.txt",
    search: "old",
    replace: "new",
  });
  const proposeSetResult = await runtime.execute("propose_patch_set", {
    files: [{ path: "blocked.txt", hunks: [{ oldStart: 1, oldLines: [], newLines: ["no"] }] }],
  });
  const patchResult = await runtime.execute("apply_patch", {
    path: "blocked.txt",
    hunks: [{ oldStart: 1, oldLines: [], newLines: ["no"] }],
  });
  const patchSetResult = await runtime.execute("apply_patch_set", {
    files: [{ path: "blocked.txt", hunks: [{ oldStart: 1, oldLines: [], newLines: ["no"] }] }],
  });
  const jsonPatchResult = await runtime.execute("apply_json_patch", {
    path: "blocked.json",
    operations: [{ op: "set", pointer: "/x", value: true }],
  });
  const writeResult = await runtime.execute("write_file", { path: "blocked.txt", content: "no" });
  assert.equal(proposeResult.ok, false);
  assert.equal(proposeResult.code, "TASK_TOOL_BLOCKED");
  assert.equal(proposeSetResult.ok, false);
  assert.equal(proposeSetResult.code, "TASK_TOOL_BLOCKED");
  assert.equal(patchResult.ok, false);
  assert.equal(patchResult.code, "TASK_TOOL_BLOCKED");
  assert.equal(patchSetResult.ok, false);
  assert.equal(patchSetResult.code, "TASK_TOOL_BLOCKED");
  assert.equal(jsonPatchResult.ok, false);
  assert.equal(jsonPatchResult.code, "TASK_TOOL_BLOCKED");
  assert.equal(writeResult.ok, false);
  assert.equal(writeResult.code, "TASK_TOOL_BLOCKED");

  const workerResult = await runtime.execute("agent", {
    description: "implement",
    mode: "implement",
    prompt: "Edit a file.",
  });
  assert.equal(workerResult.ok, false);
  assert.equal(workerResult.code, "TASK_WORKER_MODE_BLOCKED");
});

test("S-COR review scope prefers explicit file mentions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scor-scope-"));
  const scope = await resolveReviewScope({
    cwd: workspace,
    task: "Use s-cor to review @src/tools/runtime.js and @test/runtime.test.js",
  });

  assert.equal(scope.mode, "explicit");
  assert.deepEqual(scope.files, ["src/tools/runtime.js", "test/runtime.test.js"]);
});

test("S-COR review scope context is only added for active review tasks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scor-scope-"));
  const messages = await buildReviewScopeMessages({
    cwd: workspace,
    task: "review @src/tools/runtime.js",
    activeSkills: [{ name: "s-cor" }],
    requestType: "review",
  });
  const skipped = await buildReviewScopeMessages({
    cwd: workspace,
    task: "review @src/tools/runtime.js",
    activeSkills: [],
    requestType: "review",
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /S-COR deterministic review scope/);
  assert.equal(skipped.length, 0);
});

test("S-COR artifact metadata summarizes structured findings", () => {
  const metadata = scorArtifactMetadata(`
    SCOR-001 P1 CONFIRMED
    SCOR-002 P2 PLAUSIBLE
    SCOR-002 P2 PLAUSIBLE
  `);

  assert.equal(metadata.hasStructuredFindings, true);
  assert.equal(metadata.findingCount, 2);
  assert.deepEqual(metadata.findingIds, ["SCOR-001", "SCOR-002"]);
  assert.deepEqual(metadata.severities, ["P1", "P2"]);
  assert.equal(metadata.confidence.confirmed, 1);
  assert.equal(metadata.confidence.plausible, 2);
});

test("review prompt includes structured review schema instructions", () => {
  const prompt = buildSystemPrompt("/tmp/workspace", "review", [], { complex: false });

  assert.match(prompt, /Structured review schema/);
  assert.match(prompt, /schema_version/);
  assert.match(prompt, /post_cor_candidate/);
});

test("review report schema validates strong finding invariants", () => {
  const report = [
    "Findings:",
    "```json",
    JSON.stringify({
      schema_version: 1,
      review: {
        target: "current diff",
        base: "HEAD",
        project_context: "Node CLI",
        mode: "deep",
        lanes: ["code"],
      },
      findings: [
        {
          id: "SCOR-001",
          severity: "P1",
          status: "open",
          confidence: "high",
          confidence_score: 90,
          lane: "code",
          scope: "current-diff",
          file: "src/a.js:1",
          finding: "Bug",
          impact: "Breaks user flow.",
          evidence: "src/a.js:1 calls missing value.",
          reliable_solution: "Guard the missing value.",
          solution_fit: "suited=yes; executable=yes; cost=low; verification=unit test",
          verification_status: "proven-by-code",
          post_cor_candidate: true,
        },
      ],
      open_questions: [],
      test_gaps: [],
      residual_risks: [],
    }),
    "```",
  ].join("\n");

  const validation = validateReviewReportText(report);

  assert.equal(validation.ok, true);
  assert.equal(validation.report.findings[0].id, "SCOR-001");
});

test("review report schema rejects low-confidence main findings", () => {
  const report = [
    "```json",
    JSON.stringify({
      schema_version: 1,
      review: {
        target: "current diff",
        base: "HEAD",
        project_context: "Node CLI",
        mode: "deep",
        lanes: ["code"],
      },
      findings: [
        {
          id: "SCOR-001",
          severity: "P2",
          status: "open",
          confidence: "low",
          confidence_score: 60,
          lane: "code",
          scope: "current-diff",
          file: "src/a.js:1",
          finding: "Maybe bug",
          impact: "Unclear.",
          evidence: "Weak.",
          reliable_solution: "Investigate.",
          solution_fit: "conditional",
          verification_status: "not-run",
          post_cor_candidate: false,
        },
      ],
      open_questions: [],
      test_gaps: [],
      residual_risks: [],
    }),
    "```",
  ].join("\n");

  const validation = validateReviewReportText(report);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /below 80/);
});

test("agent repairs invalid review output before returning", async () => {
  const validReport = [
    "No findings.",
    "```json",
    JSON.stringify({
      schema_version: 1,
      review: {
        target: "current project",
        base: "unknown",
        project_context: "Node CLI",
        mode: "quick",
        lanes: ["code"],
      },
      findings: [],
      open_questions: [],
      test_gaps: [],
      residual_risks: [],
    }),
    "```",
  ].join("\n");
  const replies = ["No issues found.", validReport];
  const client = {
    async chatCompletion() {
      return {
        choices: [{ message: { role: "assistant", content: replies.shift() } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const tools = {
    schemas: [],
    async execute() {
      return { ok: false, error: "unexpected tool call" };
    },
  };

  const result = await runAgent({
    client,
    tools,
    task: "review this project",
    cwd: "/tmp/workspace",
    model: "test",
    stream: false,
    finalValidator: createReviewFinalValidator({ maxRepairAttempts: 2 }),
  });

  assert.equal(result.steps, 2);
  assert.equal(result.reviewValidation.ok, true);
  assert.equal(result.reviewReport.findings.length, 0);
});

test("task final validation rejects weak edit completion without recorded edits", () => {
  const errors = validateTaskFinal({
    finalText: "Done.",
    requestType: "edit",
    taskSpec: { goal: "Implement chunk upload support.", requestType: "edit" },
    agentState: { filesEdited: [], commandsRun: [] },
    trace: [],
  });

  assert.equal(errors.some((error) => /weak completion/.test(error)), true);
  assert.equal(errors.some((error) => /no successful file edit/.test(error)), true);
});

test("task final validation allows continuation analysis without recorded edits", () => {
  const errors = validateTaskFinal({
    finalText: "已完成当前 harness 状态分析，核心缺口是恢复状态和验证闭环。",
    requestType: "edit",
    taskSpec: { goal: "继续分析当前 harness 设计", requestType: "edit" },
    agentState: { filesEdited: [], commandsRun: [] },
    trace: [],
  });

  assert.equal(errors.some((error) => /no successful file edit/.test(error)), false);
});

test("agent repairs weak edit final before exiting", async () => {
  const replies = [
    { role: "assistant", content: "Done." },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          function: {
            name: "edit_file",
            arguments: JSON.stringify({ path: "src/a.js", search: "old", replace: "new" }),
          },
        },
      ],
    },
    { role: "assistant", content: "Modified src/a.js. Verification not run because this isolated test has no project scripts." },
  ];
  const client = {
    async chatCompletion() {
      return {
        choices: [{ message: replies.shift() }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const tools = {
    schemas: [
      {
        type: "function",
        function: {
          name: "edit_file",
          parameters: { type: "object", properties: {}, additionalProperties: true },
        },
      },
    ],
    async execute(name, args) {
      return {
        ok: true,
        path: args.path,
        activity: { kind: "edit", label: "Edited file", target: args.path, additions: 1, deletions: 1 },
      };
    },
  };
  const taskSpec = { goal: "Implement chunk upload support.", requestType: "edit" };

  const result = await runAgent({
    client,
    tools,
    task: taskSpec.goal,
    cwd: "/tmp/workspace",
    model: "test",
    stream: false,
    finalValidator: createTaskFinalValidator({ taskSpec, verificationPlan: { required: true } }),
  });

  assert.match(result.finalText, /Modified src\/a\.js/);
  assert.equal(result.stoppedReason, undefined);
  assert.equal(result.transitions.some((transition) => transition.reason === "final_validation_repair"), true);
  assert.deepEqual(result.agentState.filesEdited, ["src/a.js"]);
});

test("agent reports malformed tool JSON without executing empty arguments", async () => {
  const replies = [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-1", function: { name: "write_file", arguments: '{"path":"index.html","content":"truncated' } }],
    },
    { role: "assistant", content: "The incomplete write was rejected; no file was changed." },
  ];
  let executions = 0;
  let observedResult;
  const client = {
    async chatCompletion() {
      return {
        choices: [{ message: replies.shift() }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const tools = {
    schemas: [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }],
    setWorkingSetProvider() {},
    async execute() {
      executions += 1;
      return { ok: true };
    },
  };

  const result = await runAgent({
    client,
    tools,
    task: "create index.html",
    cwd: "/tmp/workspace",
    model: "test",
    stream: false,
    onToolEnd: ({ result: toolResult }) => {
      observedResult = toolResult;
    },
  });

  assert.equal(executions, 0);
  assert.equal(observedResult.code, "INVALID_TOOL_ARGUMENTS");
  assert.match(observedResult.error, /incomplete or invalid JSON/);
  assert.equal(result.trace[0].code, "INVALID_TOOL_ARGUMENTS");
});

test("verification state records failure, fix, and rerun pass", () => {
  let state = emptyVerificationState();
  state = advanceVerificationState(state, {
    name: "run_shell",
    args: { command: "npm test" },
    result: { ok: false, stderr: "fail" },
    step: 1,
  });
  state = advanceVerificationState(state, {
    name: "edit_file",
    args: { path: "src/a.js" },
    result: { ok: true },
    step: 2,
  });
  state = advanceVerificationState(state, {
    name: "run_shell",
    args: { command: "npm test" },
    result: { ok: true, stdout: "pass" },
    step: 3,
  });

  assert.equal(state.status, "failed-then-passed");
  assert.equal(state.commands.length, 2);
  assert.deepEqual(state.transitions.map((transition) => transition.to).filter(Boolean), [
    "failed",
    "fixed-pending-rerun",
    "failed-then-passed",
  ]);
});

test("workflow state records planning, tool execution, and completion", () => {
  let workflow = createWorkflowState({ requestType: "edit" });
  workflow = advanceWorkflowState(workflow, { type: "planned" });
  workflow = advanceWorkflowState(workflow, { type: "tool-start", tool: "read_file", step: 1 });
  workflow = advanceWorkflowState(workflow, { type: "tool-start", tool: "propose_patch_set", step: 2 });
  workflow = advanceWorkflowState(workflow, { type: "tool-start", tool: "edit_file", step: 3 });
  workflow = advanceWorkflowState(workflow, { type: "completed", step: 4 });

  assert.equal(workflow.status, "completed");
  assert.deepEqual(workflow.transitions.map((transition) => transition.to).filter(Boolean), [
    "initialized",
    "planned",
    "researching",
    "planning",
    "implementing",
    "completed",
  ]);
});

test("agent state records model responses, tool calls, files, commands, and observations", () => {
  const state = createAgentState({ task: "fix tests", cwd: "/tmp/project" });
  recordModelStep(state, {
    step: 1,
    startedAt: 1000,
    endedAt: 1030,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    message: {
      role: "assistant",
      content: "I will inspect the failure.",
      tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{\"path\":\"src/a.js\"}" } }],
    },
  });
  recordToolStep(state, {
    step: 1,
    name: "read_file",
    args: { path: "src/a.js" },
    result: { ok: true, content: "const a = 1;" },
    startedAt: 1030,
    endedAt: 1045,
  });
  recordToolStep(state, {
    step: 2,
    name: "run_shell",
    args: { command: "npm test" },
    result: { ok: false, failureSummary: "AssertionError: expected redirect" },
    startedAt: 2000,
    endedAt: 2050,
  });
  recordToolStep(state, {
    step: 3,
    name: "edit_file",
    args: { path: "src/a.js" },
    result: { ok: true, activity: { target: "src/a.js", additions: 1, deletions: 1 } },
    startedAt: 3000,
    endedAt: 3020,
  });

  assert.deepEqual(state.filesRead, ["src/a.js"]);
  assert.deepEqual(state.filesEdited, ["src/a.js"]);
  assert.deepEqual(state.commandsRun, ["npm test"]);
  assert.equal(state.steps.length, 4);
  assert.equal(state.usage.totalTokens, 15);
  assert.match(buildAgentStateSummary(state), /AssertionError/);
});

test("live context compaction keeps protected context and stores state summary", () => {
  const state = createAgentState({ task: "fix tests", cwd: "/tmp/project" });
  recordToolStep(state, {
    step: 1,
    name: "run_shell",
    args: { command: "npm test" },
    result: { ok: false, failureSummary: "AssertionError: expected redirect" },
    startedAt: 1000,
    endedAt: 1010,
  });
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "system", content: "project rules" },
    { role: "user", content: "fix tests" },
    { role: "assistant", content: "a".repeat(200) },
    { role: "assistant", content: "b".repeat(200) },
  ];

  const compacted = compactLiveMessages(messages, {
    protectedPrefixCount: 3,
    agentState: state,
    step: 2,
    maxChars: 100,
  });

  assert.equal(compacted, true);
  assert.deepEqual(messages.slice(0, 3).map((message) => message.content), ["system prompt", "project rules", "fix tests"]);
  assert.match(messages[3].content, /Run state summary/);
  assert.match(messages[3].content, /npm test failed/);
  assert.equal(state.contextCompactions.length, 1);
});

test("shell guardrails classify destructive commands as blocked", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-shell-policy-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => "approve",
    allowShellWithoutPrompt: true,
  });

  assert.equal(classifyShellCommand("rm -rf /").level, "block");
  assert.equal(classifyShellCommand("rm -r -f /").level, "block");
  assert.equal(classifyShellCommand("rm --recursive --force /tmp/x").level, "block");
  assert.equal(classifyShellCommand("rm file.txt").level, "warn");
  const result = await runtime.execute("run_shell", { command: "rm -rf /" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "SHELL_COMMAND_BLOCKED");

  const approvedRuntime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("blocked shell command should not prompt");
    },
    approvedShellCommands: ["rm -rf /"],
  });
  const approvedResult = await approvedRuntime.execute("run_shell", { command: "rm -rf /" });

  assert.equal(approvedResult.ok, false);
  assert.equal(approvedResult.code, "SHELL_COMMAND_BLOCKED");
});

test("shell guardrails block interactive commands", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-shell-policy-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("interactive shell command should not prompt");
    },
  });

  assert.equal(classifyShellCommand("vim src/index.js").level, "block");
  assert.equal(classifyShellCommand("python").level, "block");
  assert.equal(classifyShellCommand("python -c \"print(1)\"").level, "warn");
  assert.equal(classifyShellCommand("node --test").level, "allow");
  const result = await runtime.execute("run_shell", { command: "node" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "SHELL_COMMAND_BLOCKED");
});

test("shell guardrails warn on previously-invisible risky patterns", () => {
  assert.equal(classifyShellCommand("node -e \"require('child_process').execSync('id')\"").level, "warn");
  assert.equal(classifyShellCommand("echo hi > out.txt").level, "warn");
  assert.equal(classifyShellCommand("echo hi >> out.txt").level, "warn");
  assert.equal(classifyShellCommand("node server.js &").level, "warn");
  assert.equal(classifyShellCommand("npm i left-pad").level, "warn");
  assert.equal(classifyShellCommand("pnpm add left-pad").level, "warn");

  assert.equal(classifyShellCommand("echo hi 2>&1").level, "allow");
  assert.equal(classifyShellCommand("echo hi 2>/dev/null").level, "allow");
});

test("run_shell defaults to short timeout and truncates output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-shell-output-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("approved command should not prompt");
    },
    allowShellWithoutPrompt: true,
  });

  const timeoutResult = await runtime.execute("run_shell", { command: "node -e \"setTimeout(() => {}, 80)\"" });
  const outputResult = await runtime.execute("run_shell", { command: "node -e \"console.log('x'.repeat(25000))\"" });

  assert.equal(timeoutResult.ok, true);
  assert.equal(outputResult.ok, true);
  assert.equal(outputResult.stdoutTruncated, true);
  assert.match(outputResult.stdout, /output truncated to 20KB/);
  assert.equal(Buffer.byteLength(outputResult.stdout, "utf8") < 21 * 1024, true);
});

test("run_shell summarizes high-signal failure output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-shell-output-"));
  const runtime = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      throw new Error("approved command should not prompt");
    },
    allowShellWithoutPrompt: true,
  });

  const result = await runtime.execute("run_shell", {
    command: "node -e \"console.log('noise '.repeat(1000)); console.error('AssertionError: expected 1 received 2'); console.error('src/math.js:12:5'); process.exit(1)\"",
  });
  const compact = compactToolResult("run_shell", result);

  assert.equal(result.ok, false);
  assert.match(result.failureSummary, /AssertionError/);
  assert.match(result.failureSummary, /src\/math\.js:12:5/);
  assert.match(compact.failureSummary, /AssertionError/);
});

test("project index summarizes manifests, scripts, source, and tests", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-project-index-"));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }), "utf8");
  await writeFile(join(workspace, "package-lock.json"), "{}", "utf8");
  await writeFile(join(workspace, "src.js"), "console.log('x')", "utf8");
  await writeFile(join(workspace, "foo.test.js"), "test('x', () => {})", "utf8");

  const index = await buildProjectIndex(workspace);

  assert.equal(index.projectName, "demo");
  assert.equal(index.packageManager, "npm");
  assert.equal(index.scripts.test, "node --test");
  assert.equal(index.testFiles.includes("foo.test.js"), true);
});

test("workspace snapshot includes bounded high-signal project context", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-workspace-snapshot-"));
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --test" }, dependencies: { leftpad: "1.0.0" } }),
    "utf8",
  );
  await writeFile(join(workspace, "README.md"), "# Demo\n\nRun tests with npm test.", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "Prefer focused changes.", "utf8");
  await writeFile(join(workspace, ".deecoo.md"), "# Project Instructions\n\n- Run npm test before final answer.", "utf8");
  await writeFile(join(workspace, "index.js"), "console.log('x')", "utf8");

  const snapshot = await buildWorkspaceSnapshot(workspace);
  const messages = await buildWorkspaceSnapshotMessages(workspace);

  assert.equal(snapshot.cwd, workspace);
  assert.equal(snapshot.package.name, "demo");
  assert.equal(snapshot.package.scripts.test, "node --test");
  assert.equal(snapshot.package.dependencies.includes("leftpad"), true);
  assert.match(snapshot.readme.content, /Run tests/);
  assert.equal(snapshot.projectInstructions.primary.path, ".deecoo.md");
  assert.equal(snapshot.projectInstructions.additional[0].path, "AGENTS.md");
  assert.equal(snapshot.tree.lines.includes("index.js"), true);
  assert.match(messages[0].content, /Workspace snapshot/);
  assert.match(messages[0].content, /primary project instructions \(.deecoo.md\)/);
  assert.match(messages[0].content, /git:/);
});

test("workspace snapshot falls back to README when no instruction file exists", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-workspace-instructions-"));
  await writeFile(join(workspace, "README.md"), "# Demo\n\nUse small patches.", "utf8");

  const snapshot = await buildWorkspaceSnapshot(workspace);

  assert.equal(snapshot.projectInstructions.primary.path, "README.md");
  assert.equal(snapshot.projectInstructions.primary.fallback, true);
  assert.match(snapshot.projectInstructions.primary.content, /Use small patches/);
});

test("project description refreshes generated section without removing manual notes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-project-description-"));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "demo", scripts: { check: "node --check index.js" } }), "utf8");
  await writeFile(join(workspace, "README.md"), "# Demo", "utf8");

  const first = await ensureProjectDescription(workspace);
  await writeFile(first.path, "Manual note.\n\n" + first.content, "utf8");
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }), "utf8");
  await ensureProjectDescription(workspace);

  const content = await readFile(first.path, "utf8");
  assert.match(content, /Manual note/);
  assert.match(content, /test: `node --test`/);
  assert.doesNotMatch(content, /check: `node --check index.js`/);
});

test("review aggregation removes duplicates and sorts by severity", () => {
  const baseFinding = {
    id: "SCOR-002",
    severity: "P2",
    status: "open",
    confidence: "high",
    confidence_score: 90,
    lane: "code",
    scope: "current-diff",
    file: "src/a.js:1",
    finding: "Duplicate bug",
    impact: "Breaks behavior.",
    evidence: "same path",
    reliable_solution: "Fix it.",
    solution_fit: "suited=yes",
    verification_status: "proven-by-code",
    post_cor_candidate: true,
  };
  const report = aggregateReviewReport({
    schema_version: 1,
    review: { target: "diff", base: "HEAD", project_context: "Node", mode: "deep", lanes: ["code"] },
    findings: [
      baseFinding,
      { ...baseFinding, id: "SCOR-003" },
      { ...baseFinding, id: "SCOR-001", severity: "P1", finding: "More severe bug", evidence: "other path" },
    ],
    open_questions: [],
    test_gaps: [],
    residual_risks: [],
  });

  assert.equal(report.findings.length, 2);
  assert.equal(report.aggregation.duplicateCount, 1);
  assert.equal(report.findings[0].severity, "P1");
});

test("review reports render as human-readable markdown for CLI display", () => {
  const markdown = formatReviewReportMarkdown({
    schema_version: 1,
    review: { target: "full project", base: "HEAD", project_context: "js", mode: "security-focused", lanes: ["security"] },
    findings: [
      {
        id: "SCOR-001",
        severity: "P1",
        status: "open",
        confidence: "high",
        confidence_score: 90,
        lane: "security",
        scope: "pre-existing",
        file: "src/config/settings.js:46",
        finding: "API key stored without restrictive permissions",
        impact: "Local users can read plaintext credentials.",
        evidence: "writeFile creates a secret file without mode 0600.",
        reliable_solution: "Write the settings file with restrictive permissions and chmod existing files.",
        solution_fit: "suited=yes; executable=yes; cost=low; verification=focused test",
        verification_status: "proven-by-code",
        post_cor_candidate: true,
      },
    ],
    open_questions: [],
    test_gaps: ["Add a permission-mode regression test."],
    residual_risks: [],
    aggregation: { severityCounts: { P0: 0, P1: 1, P2: 0, P3: 0 } },
  });

  assert.match(markdown, /## Review Summary/);
  assert.match(markdown, /### P1 SCOR-001: API key stored without restrictive permissions/);
  assert.match(markdown, /- file: src\/config\/settings\.js:46/);
  assert.doesNotMatch(markdown, /```json/);
});

test("audit log redacts secrets before writing", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "deecoo-audit-"));
  const store = { projectDir };
  const session = { id: "12345678-1234-1234-1234-123456789abc" };
  const audit = await saveRunAudit(store, session, {
    task: "test",
    message: "Authorization: Bearer secret-token",
    env: { DEEPSEEK_API_KEY: "sk-secretsecretsecret" },
  });

  const files = await readdir(join(projectDir, "audit", session.id));
  const content = await readFile(join(projectDir, "audit", session.id, files[0]), "utf8");

  assert.equal(Boolean(audit.path), true);
  assert.match(content, /\[REDACTED\]/);
  assert.doesNotMatch(content, /secret-token|sk-secret/);
});

test("task spec and verification planner produce executable contracts", () => {
  const coordination = analyzeTaskCoordination("fix the bug and run tests");
  const taskSpec = buildTaskSpec({
    task: "fix the bug and run tests",
    cwd: "/tmp/project",
    coordination,
    activeSkills: [{ name: "post-cor" }],
  });
  const plan = buildVerificationPlan({
    taskSpec,
    projectIndex: { packageManager: "pnpm", scripts: { check: "node --check index.js", test: "node --test", build: "vite build" } },
  });

  assert.equal(taskSpec.requestType, "debug");
  assert.equal(taskSpec.constraints.activeSkills.includes("post-cor"), true);
  assert.equal(plan.required, true);
  assert.deepEqual(plan.commands.map((command) => command.kind), ["check", "unit-test", "build"]);
  assert.deepEqual(plan.commands.map((command) => command.command), ["pnpm run check", "pnpm test", "pnpm run build"]);
});

test("context builder keeps higher priority messages within budget", () => {
  const messages = buildContextMessages([
    contextItem({ role: "system", content: "low".repeat(100) }, 1),
    contextItem({ role: "system", content: "important" }, 100),
    contextItem({ role: "system", content: "medium" }, 50),
  ], { budget: 30 });

  assert.deepEqual(messages.map((message) => message.content), ["important", "medium"]);
});

test("project memory records and reloads facts, decisions, and failures", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "deecoo-memory-"));
  const store = { projectDir };

  await recordProjectMemory(store, { projectFact: "Uses npm scripts.", sourceRunId: "run-1", confidence: "high" });
  await recordProjectMemory(store, { decision: "Prefer focused verification." });
  await recordProjectMemory(store, { failure: "Prior test failed." });
  const memory = await loadProjectMemory(store);

  assert.equal(memory.scope, "project");
  assert.equal(memory.facts[0].text, "Uses npm scripts.");
  assert.equal(memory.facts[0].scope, "project");
  assert.equal(memory.facts[0].kind, "fact");
  assert.equal(memory.facts[0].sourceRunId, "run-1");
  assert.equal(memory.facts[0].confidence, "high");
  assert.equal(memory.decisions[0].text, "Prefer focused verification.");
  assert.equal(memory.failures[0].text, "Prior test failed.");
  assert.match(projectMemoryContextMessage(memory).content, /Project memory \(long-term, project-scoped\)/);
});

test("long-term memory is global and separate from project memory", async () => {
  const memoryRoot = await mkdtemp(join(tmpdir(), "deecoo-long-term-memory-"));
  const projectDir = await mkdtemp(join(tmpdir(), "deecoo-project-memory-"));
  const store = { memoryRoot, projectDir };

  await recordProjectMemory(store, { projectFact: "This repo uses npm." });
  await recordLongTermMemory(store, { preference: "Prefer concise Chinese summaries.", source: "user" });
  await recordLongTermMemory(store, { fact: "User works across multiple repositories.", confidence: "low" });

  const projectMemory = await loadProjectMemory(store);
  const longTermMemory = await loadLongTermMemory(store);
  const layers = memoryLayerSummary({
    session: { id: "session-1", summary: "prior turn", turns: [{ user: "hi" }], artifacts: [] },
    projectMemory,
    longTermMemory,
  });

  assert.equal(projectMemory.facts[0].scope, "project");
  assert.equal(longTermMemory.scope, "global");
  assert.equal(longTermMemory.preferences[0].kind, "preference");
  assert.equal(longTermMemory.preferences[0].scope, "global");
  assert.match(longTermMemoryContextMessage(longTermMemory).content, /Global long-term memory/);
  assert.equal(layers.sessionMemory.recentTurns, 1);
  assert.equal(layers.projectMemory.facts, 1);
  assert.equal(layers.longTermMemory.preferences, 1);
});

test("output adapters persist summary and structured outputs", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "deecoo-outputs-"));
  const store = { projectDir };
  const session = { id: "12345678-1234-1234-1234-123456789abc" };
  const outputs = await saveRunOutputs(store, session, {
    task: "review",
    result: {
      finalText: "Done",
      requestType: "edit",
      usage: { totalTokens: 42 },
      workflow: { status: "completed", phase: "done" },
      verification: { status: "passed", commands: [] },
      agentState: {
        schemaVersion: 1,
        task: "review",
        cwd: projectDir,
        filesRead: ["src/a.js"],
        filesEdited: ["src/a.js"],
        commandsRun: ["npm test"],
        observations: [{ summary: "tests passed" }],
        steps: [{ step: 1, type: "tool" }],
        contextCompactions: [],
        usage: { totalTokens: 42 },
      },
      reviewReport: { schema_version: 1, findings: [] },
    },
  });

  assert.equal(outputs.length, 4);
  assert.equal(outputs.some((output) => output.fileName.endsWith("review-report.json")), true);
  assert.equal(outputs.some((output) => output.fileName.endsWith("summary.md")), true);
  assert.equal(outputs.some((output) => output.fileName.endsWith("run-result.json")), true);
});

test("structured run result exposes stable machine-readable fields", () => {
  const result = structuredRunResult({
    task: "fix tests",
    result: {
      finalText: "Done",
      requestType: "debug",
      usage: { totalTokens: 10 },
      workflow: { status: "completed" },
      verification: { status: "passed" },
      agentState: {
        schemaVersion: 1,
        task: "fix tests",
        cwd: "/tmp/project",
        filesRead: ["src/a.js"],
        filesEdited: ["src/a.js"],
        commandsRun: ["npm test"],
        observations: Array.from({ length: 50 }, (_value, index) => ({ summary: `observation ${index}` })),
        steps: Array.from({ length: 50 }, (_value, index) => ({ step: index + 1, type: "tool" })),
        contextCompactions: [{ step: 10 }],
      },
    },
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.requestType, "debug");
  assert.equal(result.agentState.filesEdited[0], "src/a.js");
  assert.equal(result.agentState.observations.length, 40);
  assert.equal(result.agentState.recentSteps.length, 40);
});

test("tool runtime exposes capability metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-tool-capabilities-"));
  const runtime = createToolRuntime({ cwd: workspace, prompter: async () => "approve" });
  const capabilities = runtime.capabilities();

  assert.equal(capabilities.some((tool) => tool.name === "edit_file" && tool.requiresApproval), true);
  assert.equal(capabilities.some((tool) => tool.name === "propose_patch" && !tool.mutates), true);
  assert.equal(capabilities.some((tool) => tool.name === "propose_patch_set" && !tool.mutates), true);
  assert.equal(capabilities.some((tool) => tool.name === "apply_patch" && tool.requiresApproval), true);
  assert.equal(capabilities.some((tool) => tool.name === "apply_patch_set" && tool.requiresApproval), true);
  assert.equal(capabilities.some((tool) => tool.name === "apply_json_patch" && tool.requiresApproval), true);
  assert.equal(capabilities.some((tool) => tool.name === "agent" && tool.category === "orchestration"), true);
});

test("subagent scheduler enforces a per-task worker limit", async () => {
  const client = {
    async chatCompletion() {
      return { choices: [{ message: { role: "assistant", content: "done" } }] };
    },
  };
  const tools = {
    schemas: [],
    async execute() {
      return { ok: false, error: "unexpected" };
    },
  };
  const runtime = createSubagentRuntime({
    client,
    workerTools: tools,
    cwd: "/tmp/project",
    config: { model: "test" },
  });

  for (let i = 0; i < 8; i += 1) {
    const result = await runtime.start({ description: "worker " + i, prompt: "do work" });
    assert.equal(result.ok, true);
  }
  const blocked = await runtime.start({ description: "worker 9", prompt: "do work" });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "WORKER_LIMIT_REACHED");
  assert.equal(runtime.snapshot().length, 8);
});

test("subagent runtime records role presets separately from tool mode", async () => {
  const client = {
    async chatCompletion(request) {
      const system = request.messages.find((message) => message.role === "system" && /Worker role/.test(message.content));
      assert.match(system.content, /Worker role: security/);
      assert.match(system.content, /Worker mode: research/);
      assert.match(system.content, /Security role:/);
      return { choices: [{ message: { role: "assistant", content: "security checked" } }] };
    },
  };
  const tools = {
    schemas: [],
    async execute() {
      return { ok: false, error: "unexpected" };
    },
  };
  const runtime = createSubagentRuntime({
    client,
    workerTools: tools,
    cwd: "/tmp/project",
    config: { model: "test" },
  });

  const result = await runtime.start({
    description: "Security Agent",
    role: "security",
    mode: "research",
    prompt: "Check auth risks.",
  });

  assert.equal(result.ok, true);
  assert.equal(result.role, "security");
  assert.equal(result.mode, "research");
  assert.equal(runtime.snapshot()[0].role, "security");
});

test("subagent workers receive the coordinating agent's shared working set", async () => {
  let seenSharedContext;
  const client = {
    async chatCompletion(request) {
      seenSharedContext = request.messages.find((message) => /already inspected by the coordinating agent/i.test(message.content ?? ""));
      return { choices: [{ message: { role: "assistant", content: "done" } }] };
    },
  };
  const tools = {
    schemas: [],
    async execute() {
      return { ok: false, error: "unexpected" };
    },
  };
  const runtime = createSubagentRuntime({
    client,
    workerTools: tools,
    cwd: "/tmp/project",
    config: { model: "test" },
    parentWorkingSet: () => "### file: src/a.js\nexport const answer = 42;",
  });

  await runtime.start({ description: "worker", prompt: "use the pinned context" });

  assert.ok(seenSharedContext, "worker should receive a shared working-set message");
  assert.match(seenSharedContext.content, /src\/a\.js/);
  assert.match(seenSharedContext.content, /export const answer = 42/);
});

test("independent subagent dispatches in one turn run concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const tools = {
    schemas: [{ function: { name: "agent" } }],
    setWorkingSetProvider() {},
    async execute(name) {
      if (name !== "agent") return { ok: false, error: "unexpected tool: " + name };
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { ok: true, result: "worker done" };
    },
  };
  let modelCalls = 0;
  const client = {
    async chatCompletion() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  { id: "w1", function: { name: "agent", arguments: JSON.stringify({ prompt: "lane one" }) } },
                  { id: "w2", function: { name: "agent", arguments: JSON.stringify({ prompt: "lane two" }) } },
                  { id: "w3", function: { name: "agent", arguments: JSON.stringify({ prompt: "lane three" }) } },
                ],
              },
            },
          ],
        };
      }
      return { choices: [{ message: { role: "assistant", content: "synthesized" } }] };
    },
  };

  const result = await runAgent({
    client,
    tools,
    task: "dispatch three independent research lanes in parallel",
    cwd: "/tmp/project",
    model: "test",
    stream: false,
  });

  assert.equal(result.finalText, "synthesized");
  assert.ok(maxActive >= 2, `expected concurrent dispatch, saw max ${maxActive} active`);
  // Each concurrent dispatch records on the shared controller under the mutex; a race would
  // drop updates, so all three must be counted.
  assert.equal(result.process.totalTools, 3);
});

test("runAgent stops at the step budget instead of looping forever, and emits checkpoints", async () => {
  const tools = {
    schemas: [{ function: { name: "noop" } }],
    setWorkingSetProvider() {},
    async execute() {
      return { ok: true, result: "ok" };
    },
  };
  const client = {
    async chatCompletion() {
      return {
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [{ id: "c" + Math.random().toString(36).slice(2), function: { name: "noop", arguments: "{}" } }],
            },
          },
        ],
      };
    },
  };
  const checkpoints = [];
  const result = await runAgent({
    client,
    tools,
    task: "loop without converging",
    cwd: "/tmp/project",
    model: "test",
    stream: false,
    maxSteps: 3,
    onCheckpoint: (snapshot) => checkpoints.push(snapshot),
  });

  assert.match(result.stoppedReason, /step_budget/);
  assert.equal(result.budget.limit, 3);
  assert.ok(checkpoints.length >= 1);
  assert.equal(checkpoints[0].version, 1);
  assert.ok(Number.isFinite(checkpoints[0].step));
});

test("runAgent stops at the token budget", async () => {
  const tools = {
    schemas: [{ function: { name: "noop" } }],
    setWorkingSetProvider() {},
    async execute() {
      return { ok: true };
    },
  };
  const client = {
    async chatCompletion() {
      return {
        choices: [{ message: { role: "assistant", tool_calls: [{ id: "c" + Math.random(), function: { name: "noop", arguments: "{}" } }] } }],
        usage: { total_tokens: 500 },
      };
    },
  };
  const result = await runAgent({ client, tools, task: "spend tokens", cwd: "/tmp/project", model: "test", stream: false, tokenBudget: 800 });

  assert.match(result.stoppedReason, /token_budget/);
  assert.ok(result.usage.totalTokens >= 800);
});

test("runAgent stops at the cost budget", async () => {
  const tools = {
    schemas: [{ function: { name: "noop" } }],
    setWorkingSetProvider() {},
    async execute() {
      return { ok: true };
    },
  };
  const client = {
    async chatCompletion() {
      return {
        choices: [{ message: { role: "assistant", tool_calls: [{ id: "c" + Math.random(), function: { name: "noop", arguments: "{}" } }] } }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 2_000_000, total_tokens: 4_000_000 },
      };
    },
  };
  const result = await runAgent({
    client,
    tools,
    task: "spend money",
    cwd: "/tmp/project",
    model: "deepseek-v4-pro",
    stream: false,
    costBudgetUsd: 0.5,
  });

  assert.match(result.stoppedReason, /cost_budget/);
  assert.ok(result.budget.observed >= 0.5);
});

test("runAgent can resume from a serialized message history and finish", async () => {
  const tools = { schemas: [], setWorkingSetProvider() {}, async execute() { return { ok: true }; } };
  const client = {
    async chatCompletion() {
      return { choices: [{ message: { role: "assistant", content: "resumed and completed" } }] };
    },
  };
  const priorMessages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "original task" },
    { role: "assistant", content: "partial progress" },
    { role: "user", content: "continue" },
  ];
  const resumedAgentState = createAgentState({ task: "original task", cwd: "/tmp/project" });
  resumedAgentState.filesEdited.push("src/a.js");
  resumedAgentState.commandsRun.push("npm test");
  const result = await runAgent({
    client,
    tools,
    task: "original task",
    cwd: "/tmp/project",
    model: "test",
    stream: false,
    resume: {
      messages: priorMessages,
      step: 5,
      usage: { totalTokens: 900, promptTokens: 700, completionTokens: 200 },
      trace: [{ step: 4, tool: "edit_file", target: "src/a.js", ok: true }],
      transitions: [{ type: "tool_use", step: 4, tool: "edit_file" }],
      agentState: resumedAgentState,
      verification: {
        status: "passed",
        commands: [{ command: "npm test", ok: true, step: 4 }],
        transitions: [{ type: "command-result", command: "npm test", ok: true, step: 4 }],
      },
      workflow: { status: "executing", phase: "verifying", transitions: [{ type: "tool-start", step: 4 }] },
    },
  });

  assert.equal(result.finalText, "resumed and completed");
  assert.ok(result.steps >= 6);
  assert.ok(result.usage.totalTokens >= 900);
  assert.deepEqual(result.trace, [{ step: 4, tool: "edit_file", target: "src/a.js", ok: true }]);
  assert.equal(result.agentState.filesEdited.includes("src/a.js"), true);
  assert.equal(result.verification.status, "passed");
  assert.equal(result.workflow.status, "completed");
});

test("serializeRunState produces a versioned, JSON-serializable snapshot", () => {
  const snapshot = serializeRunState({
    step: 3,
    messages: [{ role: "user", content: "task" }],
    usage: { totalTokens: 120 },
    workflow: { status: "executing", phase: "researching", transitions: [] },
    process: { duplicateRate: 0 },
    requestType: "edit",
    trace: [{ tool: "read_file", target: "src/a.js", ok: true }],
    transitions: [{ type: "tool_use", step: 2 }],
    agentState: { filesRead: ["src/a.js"], filesEdited: ["src/a.js"] },
    verification: { status: "passed", commands: [{ command: "npm test", ok: true }], transitions: [] },
  });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.step, 3);
  assert.equal(snapshot.status, "executing");
  assert.equal(JSON.parse(JSON.stringify(snapshot)).usage.totalTokens, 120);
  assert.equal(snapshot.messages[0].content, "task");
  assert.equal(snapshot.trace[0].tool, "read_file");
  assert.equal(snapshot.agentState.filesEdited[0], "src/a.js");
  assert.equal(snapshot.verification.status, "passed");
  assert.equal(snapshot.workflow.phase, "researching");
});

test("worker results are parsed into a structured contract and aggregated", async () => {
  const client = {
    async chatCompletion() {
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content:
                "Checked auth paths.\n```json\n" +
                JSON.stringify({
                  summary: "auth reviewed",
                  status: "done",
                  findings: [{ file: "src/auth.js", line: 10, severity: "high", summary: "missing authz check" }],
                  residualRisks: ["token rotation not covered"],
                }) +
                "\n```",
            },
          },
        ],
      };
    },
  };
  const tools = { schemas: [], async execute() { return { ok: false, error: "unexpected" }; } };
  const runtime = createSubagentRuntime({ client, workerTools: tools, cwd: "/tmp/project", config: { model: "test" } });

  const started = await runtime.start({ description: "Security Agent", role: "security", mode: "research", prompt: "check auth" });
  assert.equal(started.structured.status, "done");
  assert.equal(started.structured.findings[0].file, "src/auth.js");

  const aggregate = runtime.aggregate();
  assert.equal(aggregate.findings.length, 1);
  assert.equal(aggregate.findings[0].severity, "high");
  assert.deepEqual(aggregate.residualRisks, ["token rotation not covered"]);
  assert.equal(aggregate.byStatus.done, 1);
});

test("aggregateWorkerResults dedupes findings and ranks by severity", () => {
  const aggregate = aggregateWorkerResults([
    {
      role: "a",
      status: "completed",
      structured: { status: "done", findings: [{ file: "x", summary: "dup", severity: "low" }, { file: "y", summary: "critical", severity: "high" }], residualRisks: ["r1"] },
    },
    {
      role: "b",
      status: "completed",
      structured: { status: "done", findings: [{ file: "x", summary: "dup", severity: "low" }], residualRisks: ["r1", "r2"] },
    },
  ]);

  assert.equal(aggregate.findings.length, 2);
  assert.equal(aggregate.findings[0].summary, "critical");
  assert.deepEqual(aggregate.residualRisks.sort(), ["r1", "r2"]);
  assert.equal(aggregate.byStatus.done, 2);
});

test("a worker that exceeds its time budget is stopped with WORKER_TIMEOUT", async () => {
  const client = {
    chatCompletion(_request, options = {}) {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
  };
  const tools = { schemas: [], async execute() { return { ok: false }; } };
  const runtime = createSubagentRuntime({ client, workerTools: tools, cwd: "/tmp/project", config: { model: "test", workerTimeoutMs: 30 } });

  const result = await runtime.start({ description: "slow worker", prompt: "hang forever" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_TIMEOUT");
  assert.equal(result.status, "stopped");
});
