import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/agent/taskRunner.js";
import { createExecutionBackend } from "../src/execution/backend.js";
import { inferTaskIntent } from "../src/harness/taskIntent.js";
import { createSessionStore } from "../src/session/store.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const call = (id, name, args) => ({ choices: [{ message: { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 1 } });
const answer = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 1 } });

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deecoo-control-residual-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await mkdir(join(cwd, "src"), { recursive: true });
  const sessionStore = await createSessionStore(cwd, { rootDir: join(root, "sessions") });
  const session = await sessionStore.createSession({ model: "test" });
  let approvals = 0;
  const backend = createExecutionBackend({ cwd, stateDir: join(root, "jobs"), sandboxPolicy: { mode: "off" } });
  t.after(() => backend.dispose({ stopRunning: true, removeState: true }));
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => { approvals += 1; return "approve"; }, executionBackend: backend });
  return { cwd, sessionStore, session, tools, approvals: () => approvals };
}

test("CTRL-001 quoted and coordinated review subjects grant no write capability", () => {
  for (const task of ['Review the "update" function in @src/api.js', "Review the 'delete' endpoint in api.js",
    "Review the `update` function in @src/api.js", "Review the update and delete endpoints in @src/api.js",
    "Review update and delete endpoints in api.js", 'Explain the "create" method', "Inspect the current update and delete handlers",
    'Review the "修复" function', "审查“删除”接口", "Do not apply any changes; review the patch",
    "Explain how to apply this patch"]) {
    assert.equal(inferTaskIntent(task).mayWrite, false, task);
    assert.equal(inferTaskIntent(task).requiresCodeChange, false, task);
  }
  for (const task of ['Update the "fix" function', 'Review the "update" function and fix its bug',
    "Review the update and delete endpoints, then add a test", "Create an update function", "Update functions in api.js",
    'Please "fix" the crash', 'Fix the code to print "update"', "Review the fix and fix it", "修复“删除”接口"]) {
    assert.equal(inferTaskIntent(task).mayWrite, true, task);
  }
});

test("CTRL-001 a quoted review subject cannot edit before the final review gate", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "src/api.js"), "export function update() { return 1; }\n");
  let calls = 0;
  const result = await runTask({ ...f, task: 'Review the "update" function in @src/api.js',
    config: { model: "test", stream: false, quiet: true, maxSteps: 5 }, client: { async chatCompletion() {
      calls += 1;
      if (calls === 1) return call("read", "read_file", { path: "src/api.js" });
      if (calls === 2) return call("edit", "edit_file", { path: "src/api.js", search: "return 1;", replace: "return 2;" });
      return answer("No findings.");
    } } });
  assert.equal(result.agentState.steps.find((step) => step.toolCall?.name === "edit_file")?.toolResult?.code, "TASK_TOOL_BLOCKED");
  assert.equal(await readFile(join(f.cwd, "src/api.js"), "utf8"), "export function update() { return 1; }\n");
  assert.equal(f.approvals(), 0);
});

test("CTRL-004 explicit output targets count as progress in plain and ignored Git directories", async (t) => {
  for (const git of [false, true]) {
    const f = await fixture(t);
    if (git) {
      execFileSync("git", ["init", "-q"], { cwd: f.cwd });
      await writeFile(join(f.cwd, ".gitignore"), "dist/\n");
    }
    let calls = 0;
    const result = await runTask({ ...f, task: "Append one x to dist/progress.txt ten times, one command per step.",
      config: { model: "test", stream: false, quiet: true, maxSteps: 25 }, client: { async chatCompletion() {
        calls += 1;
        return calls <= 10 ? call("append-" + calls, "run_shell", { command: "mkdir -p dist && printf x >> dist/progress.txt" }) : answer("Appended ten times.");
      } } });
    assert.notEqual(result.stoppedReason, "no_progress", git ? "git" : "plain");
    assert.equal(await readFile(join(f.cwd, "dist/progress.txt"), "utf8"), "xxxxxxxxxx");
  }
});
