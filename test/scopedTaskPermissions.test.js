import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inferTaskIntent } from "../src/harness/taskIntent.js";
import { buildTaskSpec } from "../src/harness/taskSpec.js";
import { buildTaskToolPolicy, taskToolPolicyViolation } from "../src/permissions/taskPolicy.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { runTask } from "../src/agent/taskRunner.js";
import { createSessionStore } from "../src/session/store.js";

test("N-1 scoped negative instructions preserve positive edit permission and global read-only stays global", () => {
  for (const task of ["不要修改任何测试文件，只修复 src/agent 的 bug", "Do not modify any test files; fix src/agent", "不要修改生成文件，修复 src 中的错误", "Fix src/agent but never edit docs/guide.md", "Do not edit docs/guide.md. Fix src/agent", "Do not modify tests and fix src/agent"]) {
    const intent = inferTaskIntent(task);
    assert.equal(intent.mayWrite, true, task);
    assert.equal(intent.explicitReadOnly, false, task);
    assert.ok(intent.writeRestrictions.length, task);
    assert.equal(taskToolPolicyViolation("write_file", { path: "src/agent/loop.js" }, { taskPolicy: buildTaskToolPolicy(intent) }), null, task);
  }
  const english = buildTaskToolPolicy(inferTaskIntent("Fix src/agent but never edit docs/guide.md"));
  assert.equal(taskToolPolicyViolation("write_file", { path: "docs/guide.md" }, { taskPolicy: english }).code, "TASK_WRITE_PATH_BLOCKED");
  const absolute = inferTaskIntent("Fix src/main.js; do not edit /workspace/docs/guide.md");
  assert.deepEqual(absolute.writeRestrictions, [{ kind: "path", path: "/workspace/docs/guide.md" }]);
  assert.equal(taskToolPolicyViolation("write_file", { path: "docs/guide.md" }, { workspace: "/workspace", taskPolicy: buildTaskToolPolicy(absolute) }).code, "TASK_WRITE_PATH_BLOCKED");
  const spaces = inferTaskIntent('Fix src/main.js; do not edit "docs/my guide.md"');
  assert.deepEqual(spaces.writeRestrictions, [{ kind: "path", path: "docs/my guide.md" }]);
  const tests = buildTaskToolPolicy(inferTaskIntent("不要修改任何测试文件，只修复 src 的 bug"));
  for (const path of ["test.js", "test-utils.js", "test_fixture.py", "spec.js", "src/main_test.go", "src/main_spec.rb", "src/MainTest.java", "src/widget.test.js", "src/WidgetTests.cs", "test_helpers/fixtures.js"]) {
    assert.equal(taskToolPolicyViolation("write_file", { path }, { taskPolicy: tests }).code, "TASK_WRITE_PATH_BLOCKED", path);
  }
  for (const path of ["src/contest.js", "src/specification.js", "src/latest.js"]) assert.equal(taskToolPolicyViolation("write_file", { path }, { taskPolicy: tests }), null, path);
  const permissionTask = inferTaskIntent("Fix src/value.js to return 2; do not change permissions.");
  assert.equal(permissionTask.requiresCodeChange, true);
  assert.equal(permissionTask.mayWrite, true);
  for (const task of ["审查代码，不要修改任何文件", "Fix src but do not modify any files", "Read-only review of src", "不要修改任何代码"]) {
    const intent = inferTaskIntent(task);
    assert.equal(intent.mayWrite, false, task);
    assert.equal(intent.explicitReadOnly, true, task);
  }
});

test("N-1 real runtime guards files, both move endpoints, proposals and implementation worker tools", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scoped-policy-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (const folder of ["src", "tests", "generated", "docs"]) await mkdir(join(workspace, folder));
  for (const path of ["src/main.js", "tests/main.js", "generated/result.js", "docs/guide.md"]) await writeFile(join(workspace, path), "before\n");
  await symlink(join(workspace, "tests"), join(workspace, "alias"));
  const tools = createToolRuntime({ cwd: workspace, permissionMode: "workspace-write", prompter: async () => "approve" });
  const task = "不要修改任何测试文件，不要修改生成文件，不要修改 docs/guide.md，只修复 src/agent 的 bug";
  tools.setTaskToolPolicy(buildTaskToolPolicy(buildTaskSpec({ task, cwd: workspace })));
  assert.equal((await tools.execute("write_file", { path: "src/main.js", content: "fixed\n" })).ok, true);
  const forbidden = ["tests/main.js", "test.js", "src/test-helper.js", "src/main.test.js", "src/main_test.go", "generated/result.js", "src/model.generated.js", "docs/guide.md", "alias/main.js", "src/../tests/new.js"];
  for (const path of forbidden) {
    const result = await tools.execute("write_file", { path, content: "forbidden\n" });
    assert.equal(result.ok, false, path);
    assert.equal(result.code, "TASK_WRITE_PATH_BLOCKED", path);
  }
  for (const tool of ["edit_file", "apply_patch", "apply_json_patch", "propose_patch"]) {
    const result = await tools.execute(tool, { path: "tests/main.js", search: "before", replace: "after", hunks: [{ oldStart: 1, oldLines: ["before"], newLines: ["after"] }], operations: [] });
    assert.equal(result.code, "TASK_WRITE_PATH_BLOCKED", tool);
  }
  for (const tool of ["apply_patch_set", "propose_patch_set"]) {
    for (const files of [[{ action: "move", from: "tests/main.js", path: "src/moved.js" }], [{ action: "move", from: "src/main.js", path: "tests/moved.js" }]]) {
      assert.equal((await tools.execute(tool, { files })).code, "TASK_WRITE_PATH_BLOCKED", tool);
    }
  }
  const worker = tools.createWorkerTools({ mode: "implement" });
  assert.equal((await worker.execute("write_file", { path: "tests/main.js", content: "forbidden" })).code, "TASK_WRITE_PATH_BLOCKED");
  assert.equal((await worker.execute("write_file", { path: "src/worker.js", content: "allowed" })).ok, true);
  for (const path of ["tests/main.js", "generated/result.js", "docs/guide.md"]) assert.equal(await readFile(join(workspace, path), "utf8"), "before\n");
});

test("N-1 arbitrary shell and unknown mutating extensions fail closed without scoped enforcement", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scoped-shell-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let dispatched = 0;
  const executionBackend = { capabilities: () => ({ scopedWriteRestrictions: false }), run: async () => { dispatched++; return { ok: true }; }, startJob: async () => { dispatched++; return { ok: true }; } };
  const tools = createToolRuntime({ cwd: workspace, executionBackend, permissionMode: "workspace-write", prompter: async () => "approve" });
  tools.setTaskToolPolicy(buildTaskToolPolicy(inferTaskIntent("不要修改任何测试文件，只修复 src/agent 的 bug")));
  for (const tool of ["run_shell", "start_job"]) assert.equal((await tools.execute(tool, { command: 'node -e "require(\'fs\').writeFileSync(\'tests/escape.js\',\'bad\')"' })).code, "TASK_SCOPED_SHELL_UNAVAILABLE");
  tools.registerTool({ mutates: true, schema: { type: "function", function: { name: "custom_write", parameters: { type: "object", properties: {} } } }, execute: async () => { dispatched++; return { ok: true }; } });
  assert.equal((await tools.execute("custom_write", {})).code, "TASK_SCOPED_TOOL_BLOCKED");
  assert.equal(dispatched, 0);
});

test("N-1 approval cannot replace an allowed parent with an alias into a protected test directory", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-scoped-approval-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "src")); await mkdir(join(workspace, "tests"));
  await writeFile(join(workspace, "src/main.js"), "before\n");
  await writeFile(join(workspace, "tests/main.js"), "protected\n");
  const tools = createToolRuntime({ cwd: workspace, permissionMode: "ask-once", prompter: async () => {
    await rename(join(workspace, "src"), join(workspace, "src-old"));
    await symlink(join(workspace, "tests"), join(workspace, "src"));
    return "approve";
  } });
  tools.setTaskToolPolicy(buildTaskToolPolicy(inferTaskIntent("不要修改任何测试文件，只修复 src 的 bug")));
  const result = await tools.execute("write_file", { path: "src/main.js", content: "forbidden\n" });
  assert.equal(result.code, "TASK_WRITE_PATH_BLOCKED");
  assert.equal(await readFile(join(workspace, "tests/main.js"), "utf8"), "protected\n");
});

test("N-1 a denied required edit cannot become a completed analysis because permissions must stay unchanged", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-scoped-required-edit-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src/value.js"), "export const value = 1;\n");
  const tools = createToolRuntime({ cwd, permissionMode: "read-only" });
  const sessionStore = await createSessionStore(cwd, { rootDir: join(cwd, "home"), privacyMode: "ephemeral" });
  const session = await sessionStore.createSession({ model: "synthetic" });
  let calls = 0;
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Fix src/value.js to return 2; do not change permissions.",
    config: { model: "synthetic", quiet: true, stream: false, maxSteps: 7 },
    client: { async chatCompletion() {
      calls++;
      const name = calls === 1 ? "read_file" : "edit_file";
      const args = calls === 1 ? { path: "src/value.js" } : { path: "src/value.js", search: "1", replace: "2" };
      const message = calls <= 2 ? { role: "assistant", tool_calls: [{ id: "call-" + calls, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
        : { role: "assistant", content: "Could not modify src/value.js because permission mode is read-only." };
      return { choices: [{ message }], usage: { total_tokens: 1 } };
    } } });
  assert.equal(result.status, "failed");
  assert.equal(result.stoppedReason, "task_contract_invalid");
  assert.equal(await readFile(join(cwd, "src/value.js"), "utf8"), "export const value = 1;\n");
});
