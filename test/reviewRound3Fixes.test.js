import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeEvalCase } from "../eval/execution.js";
import { runTask } from "../src/agent/taskRunner.js";
import { createExecutionBackend } from "../src/execution/backend.js";
import { detectSandbox } from "../src/execution/sandbox.js";
import { inferTaskIntent } from "../src/harness/taskIntent.js";
import { workspaceFingerprint } from "../src/harness/workspaceFingerprint.js";
import { createSessionStore } from "../src/session/store.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const call = (id, name, args) => ({ choices: [{ message: { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 1 } });
const answer = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 1 } });

async function scratch(t, prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// Session state and job logs live outside the workspace, as they do under ~/.deecoo.
async function taskFixture(t) {
  const root = await scratch(t, "deecoo-r3-task-");
  const cwd = join(root, "workspace");
  await mkdir(join(cwd, "src"), { recursive: true });
  const previousHome = process.env.DEECOO_HOME;
  process.env.DEECOO_HOME = join(root, "home");
  t.after(() => { if (previousHome === undefined) delete process.env.DEECOO_HOME; else process.env.DEECOO_HOME = previousHome; });
  const sessionStore = await createSessionStore(cwd);
  const session = await sessionStore.createSession({ model: "test" });
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => "approve",
    executionBackend: createExecutionBackend({ cwd, stateDir: join(root, "jobs"), sandboxPolicy: { mode: "off" } }) });
  return { cwd, sessionStore, session, tools };
}

function graderCase(marker, sandboxPolicy) {
  return {
    schemaVersion: 2, id: "grader-isolation", title: "Grader isolation", category: "security", task: "Explain src/value.js.",
    execution: {
      permissionMode: "workspace-write",
      files: { "src/value.js": `import { writeFileSync } from "node:fs";\ntry { writeFileSync(${JSON.stringify(marker)}, "escaped"); } catch {}\nexport const value = 1;\n` },
      allowedChanges: [],
      config: { sandboxPolicy },
      scripted: { main: [{ text: "src/value.js exports value = 1." }] },
      checks: { commands: [{ command: "node", args: ["--input-type=module", "-e", "import { value } from './src/value.js'; if (value !== 1) process.exit(1);"], name: "independent-behavior" }] },
    },
  };
}

const sandbox = detectSandbox();
const sandboxSkip = !sandbox.available && process.env.DEECOO_REQUIRE_SANDBOX_TESTS !== "1" ? `OS sandbox unavailable: ${sandbox.reason}` : false;

test("R3-QUALITY-001 independent graders run candidate code inside the task's OS sandbox", { skip: sandboxSkip }, async (t) => {
  const outside = await scratch(t, "deecoo-r3-grader-outside-");
  const marker = join(outside, "grader-escaped");
  const isolated = await executeEvalCase(graderCase(marker, { mode: "required", network: "deny" }), { trials: 1 });
  const check = isolated.trials[0].checks.find((item) => item.name === "command:independent-behavior");
  assert.equal(check.passed, true, check.detail);
  assert.equal(check.evidence.sandbox.enforced, true);
  assert.equal(existsSync(marker), false, "graded candidate code wrote outside its workspace");
  // Control: without a sandbox the same grader really imports the candidate, so the check above is
  // what keeps its write inside.
  await executeEvalCase(graderCase(marker, { mode: "off" }), { trials: 1 });
  assert.equal(await readFile(marker, "utf8"), "escaped");
});

test("R3-CTRL-001 words inside paths, mentions, code, and function names do not grant write access", () => {
  for (const task of ["Review @src/update.js", "审查 @src/fix.js", "Review the create() function in src/a.js", "Review src/add.js",
    "Explain src/delete-user.js", "Review `updateUser` in api.ts", "Review add(a, b) in math.js",
    // Hyphenated names, file names in other scripts, and a change named as the thing to inspect.
    "Review the create-user endpoint", "Explain the add-on loader in plugins.js", "Review the fix-ups in the last commit",
    "审查 src/修复.js", "审查 修复.js", "Review this: the bug fix landed yesterday", "Review the change", "Explain why the build fails",
    "Look at the update in api.js and explain it", "审查这次修改"]) {
    const intent = inferTaskIntent(task);
    assert.equal(intent.mayWrite, false, task);
    assert.equal(intent.requiresCodeChange, false, task);
  }
  for (const task of ["Fix src/update.js and review it", "修复 src/fix.js 的问题", "Update README.md", "Create done.txt and check it.",
    "Fix src/add.js so add(a, b) returns the sum and run npm test.", "Add a test for src/value.js", "Review @src/value.js and fix the bug", "Review @src/a.js. Fix the bug in it.",
    "Do not edit docs/guide.md. Fix src/agent", "Fix the build", "Apply the fix from the review", "I need a fix for the crash in src/a.js",
    "Make the change in src/a.js", "Re-create the index file", "Review the change and fix the bug", "Explain why the build fails and fix it",
    "In the update function, add logging", "审查 src/a.js并修复", "修改app.js", "修改修复v2.js"]) {
    assert.equal(inferTaskIntent(task).mayWrite, true, task);
  }
});

test("R3-CTRL-001 a review of a file named after an action cannot edit it", async (t) => {
  const { cwd, sessionStore, session, tools } = await taskFixture(t);
  await writeFile(join(cwd, "src", "update.js"), "export const version = 1;\n");
  let calls = 0;
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Review @src/update.js", config: { model: "test", quiet: true, stream: false, maxSteps: 6 },
    client: { async chatCompletion() {
      calls += 1;
      if (calls === 1) return call("read", "read_file", { path: "src/update.js" });
      if (calls === 2) return call("edit", "edit_file", { path: "src/update.js", search: "version = 1", replace: "version = 2" });
      return answer("No findings.");
    } } });
  assert.equal(await readFile(join(cwd, "src", "update.js"), "utf8"), "export const version = 1;\n");
  const editStep = result.agentState.steps.find((step) => step.toolCall?.name === "edit_file");
  assert.equal(editStep?.toolResult?.ok, false);
});

const gitInit = (cwd, ignore) => {
  execFileSync("git", ["init", "-q"], { cwd });
  return writeFile(join(cwd, ".gitignore"), ignore);
};

test("R3-CTRL-004 a command that keeps writing to the workspace is progress, not a repeat", async (t) => {
  for (const git of [false, true]) {
    const { cwd, sessionStore, session, tools } = await taskFixture(t);
    if (git) await gitInit(cwd, "coverage/\n");
    let calls = 0;
    const result = await runTask({ cwd, tools, sessionStore, session, task: "Append one x to progress.txt ten times, one command per step.",
      config: { model: "test", quiet: true, stream: false, maxSteps: 40 },
      client: { async chatCompletion() { calls += 1; return calls <= 10 ? call("c" + calls, "run_shell", { command: "printf x >> progress.txt" }) : answer("Appended ten times."); } } });
    assert.notEqual(result.stoppedReason, "no_progress", git ? "git" : "plain");
    assert.equal(await readFile(join(cwd, "progress.txt"), "utf8"), "x".repeat(10), git ? "git" : "plain");
  }
});

test("R3-CTRL-004 rerunning a passing command that only rewrites generated output is still no progress", async (t) => {
  // Plain workspaces skip well-known output directories; Git work trees skip what .gitignore excludes.
  for (const [git, command] of [[false, "mkdir -p coverage && echo $RANDOM$RANDOM > coverage/stamp && echo built"],
    [true, "mkdir -p generated && echo $RANDOM$RANDOM > generated/stamp && echo built"]]) {
    const { cwd, sessionStore, session, tools } = await taskFixture(t);
    if (git) await gitInit(cwd, "generated/\n");
    let calls = 0;
    const result = await runTask({ cwd, tools, sessionStore, session, task: "Build the project.", config: { model: "test", quiet: true, stream: false, maxSteps: 30 },
      client: { async chatCompletion() { calls += 1; return call("b" + calls, "run_shell", { command }); } } });
    assert.equal(result.stoppedReason, "no_progress", git ? "git" : "plain");
    assert.ok(calls <= 5, `${git ? "git" : "plain"} stopped after ${calls} model calls`);
  }
});

test("R3-CTRL-004 the workspace fingerprint sees source writes, ignores tool and output directories, and gives up on huge trees", async (t) => {
  const cwd = await scratch(t, "deecoo-r3-fingerprint-");
  await writeFile(join(cwd, "a.txt"), "a");
  const first = await workspaceFingerprint(cwd);
  assert.equal(await workspaceFingerprint(cwd), first);
  await appendFile(join(cwd, "a.txt"), "b");
  const appended = await workspaceFingerprint(cwd);
  assert.notEqual(appended, first);
  for (const directory of ["node_modules", ".deecoo", "coverage", "dist", "__pycache__"]) {
    await mkdir(join(cwd, directory), { recursive: true });
    await writeFile(join(cwd, directory, "state"), String(Math.random()));
  }
  assert.equal(await workspaceFingerprint(cwd), appended);
  await writeFile(join(cwd, "b.txt"), "b");
  assert.equal(await workspaceFingerprint(cwd, { maxEntries: 1 }), undefined);

  const repository = await scratch(t, "deecoo-r3-fingerprint-git-");
  await writeFile(join(repository, "tracked.txt"), "1");
  await gitInit(repository, "*.log\nbuild/\n");
  const clean = await workspaceFingerprint(repository);
  await mkdir(join(repository, "build"));
  await writeFile(join(repository, "build", "out.js"), "generated");
  await writeFile(join(repository, "run.log"), "log");
  assert.equal(await workspaceFingerprint(repository), clean, "ignored output is not progress");
  await writeFile(join(repository, "notes.md"), "new");
  const untracked = await workspaceFingerprint(repository);
  assert.notEqual(untracked, clean, "an untracked file Git would show is progress");
  await appendFile(join(repository, "tracked.txt"), "2");
  assert.notEqual(await workspaceFingerprint(repository), untracked);
});
