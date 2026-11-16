import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/agent/taskRunner.js";
import { createExecutionBackend } from "../src/execution/backend.js";
import { evaluateTaskAcceptance } from "../src/harness/acceptance.js";
import { createProcessController, evaluateToolCall, recordToolObservation } from "../src/harness/processController.js";
import { inferTaskIntent } from "../src/harness/taskIntent.js";
import { buildTaskSpec } from "../src/harness/taskSpec.js";
import { createSessionStore } from "../src/session/store.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { buildVerificationPlan } from "../src/verification/planner.js";
import { advanceVerificationState, emptyVerificationState } from "../src/verification/state.js";

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

test("read-only questions and reviews mentioning test commands or software subjects stay read-only and satisfiable", () => {
  for (const task of [
    "Why did npm test fail?",
    "Review the npm run check script in package.json",
    "Review update logic in src/app.js",
    "Review the create and delete logic in src/app.js",
    "分析一下为什么会创建失败",
    "为什么这段代码会修改全局状态？",
    "审查一下这个新增的校验逻辑",
  ]) {
    const spec = buildTaskSpec({ task, cwd: "/tmp/repo" });
    const plan = buildVerificationPlan({ taskSpec: spec });
    const acceptance = evaluateTaskAcceptance({ taskSpec: spec, verificationPlan: plan, verification: emptyVerificationState(), agentState: {}, effects: { events: [] } });
    assert.equal(spec.mayWrite, false, task);
    assert.equal(spec.requiresCodeChange, false, task);
    assert.deepEqual(spec.requiredChecks, [], task);
    assert.equal(plan.required, false, task);
    assert.equal(acceptance.satisfied, true, task);
  }
  for (const task of [
    "分析一下为什么会创建失败，并修复它",
    "分析为什么加载失败然后修改 app.js 的加载逻辑",
    "Review the parser and fix logic for empty records in parser.js",
  ]) {
    const compound = buildTaskSpec({ task, cwd: "/tmp/repo" });
    assert.equal(compound.mayWrite, true, task);
    assert.equal(compound.requiresCodeChange, true, task);
  }
  const multilineCheck = buildTaskSpec({ task: "Run npm run typecheck\nOutput the result.", cwd: "/tmp/repo" });
  assert.deepEqual(multilineCheck.requiredChecks.map((check) => check.target), ["npm run typecheck"]);
});

test("processController run_shell deduplication distinguishes cwd while short-circuiting same-cwd repeats", () => {
  const controller = createProcessController();
  recordToolObservation(controller, { name: "run_shell", args: { command: "npm test", cwd: "pkg-a" }, result: { ok: true, stdout: "pkg-a ok" }, step: 1 });
  const otherCwd = evaluateToolCall(controller, { name: "run_shell", args: { command: "npm test", cwd: "pkg-b" }, step: 2 });
  assert.equal(otherCwd.action, "allow");
  const sameCwd = evaluateToolCall(controller, { name: "run_shell", args: { command: "npm test", cwd: "pkg-a" }, step: 2 });
  assert.equal(sameCwd.action, "short_circuit");
});

test("background job_status binds verification freshness to start_job launch revision and does not clobber newer passing checks", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "src/api.js"), "export const v = 1;\n");
  await writeFile(join(f.cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  const taskSpec = buildTaskSpec({ task: "Update src/api.js and run npm test", cwd: f.cwd });
  const plan = buildVerificationPlan({ taskSpec });
  let vState = emptyVerificationState();
  const started = await f.tools.execute("start_job", { command: "npm test" });
  vState = advanceVerificationState(vState, { name: "start_job", args: { command: "npm test" }, result: started, step: 1 }, { plan });
  const edited = await f.tools.execute("edit_file", { path: "src/api.js", search: "1", replace: "2" });
  vState = advanceVerificationState(vState, { name: "edit_file", args: {}, result: edited, step: 2 }, { plan });
  let polled;
  for (let i = 0; i < 40; i += 1) {
    polled = await f.tools.execute("job_status", { jobId: started.jobId });
    if (polled.status === "exited") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const staleState = advanceVerificationState(vState, { name: "job_status", args: { jobId: started.jobId }, result: polled, step: 3 }, { plan });
  assert.equal(evaluateTaskAcceptance({ taskSpec, verificationPlan: plan, verification: staleState, agentState: { filesEdited: ["src/api.js"] }, effects: { events: [] } }).checks[0].status, "stale");

  // If a foreground rerun already validated the post-edit revision, polling the older background job later must not downgrade it back to stale.
  const rerun = await f.tools.execute("run_shell", { command: "npm test" });
  let freshState = advanceVerificationState(vState, { name: "run_shell", args: { command: "npm test" }, result: rerun, step: 3 }, { plan });
  freshState = advanceVerificationState(freshState, { name: "job_status", args: { jobId: started.jobId }, result: polled, step: 4 }, { plan });
  assert.equal(evaluateTaskAcceptance({ taskSpec, verificationPlan: plan, verification: freshState, agentState: { filesEdited: ["src/api.js"] }, effects: { events: [] } }).checks[0].status, "passed");
});
