import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { executeEvalCase, executeEvalSuite } from "../eval/execution.js";

const execFileAsync = promisify(execFile);
const loadCase = async (id = "add-edit") => JSON.parse(await readFile(new URL(`../eval/tasks/${id}.json`, import.meta.url), "utf8"));

test("E2E runs the task through real edit, file and shell tools across isolated trials", async () => {
  const definition = await loadCase();
  const result = await executeEvalCase(definition, { trials: 2 });
  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.equal(result.summary.successRate, 1);
  assert.equal(result.summary.trials, 2);
  assert.equal(result.summary.totalTokens, 16);
  assert.ok(result.summary.p50Ms > 0);
  assert.ok(result.summary.p95Ms >= result.summary.p50Ms);
  for (const trial of result.trials) {
    assert.deepEqual(trial.changedFiles, ["src/add.js"]);
    assert.equal(trial.checks.find((check) => check.name.startsWith("command:")).evidence.exitCode, 0);
    assert.notEqual(trial.workspaceState.before["src/add.js"].hash, trial.workspaceState.after["src/add.js"].hash);
    assert.equal(trial.workspaceState.before["protected.txt"].hash, trial.workspaceState.after["protected.txt"].hash);
    assert.deepEqual(trial.diagnostics.toolCalls.map((call) => call.tool), ["read_file", "edit_file", "run_shell"]);
  }
  assert.equal(definition.execution.files["src/add.js"].includes("a - b"), true, "authored fixture is never mutated");
});

test("E2E accepts apply_patch, Worker and an equivalent implementation without tool or classification gates", async () => {
  const patch = await loadCase("add-patch");
  const worker = await loadCase("add-worker");
  // Deliberately incompatible trace-lint expectations must remain diagnostics only.
  patch.expected = { requestType: "edit", mustUseTools: ["edit_file"], disallowTools: ["apply_patch"] };
  patch.execution.scripted.main[1].arguments.hunks[0].newLines = ["  return b + a;"];
  const result = await executeEvalSuite([patch, worker]);
  assert.equal(result.summary.passed, 2, JSON.stringify(result.summary.failedRequiredChecks));
  assert.equal(result.results[0].trials[0].diagnostics.requestType, "debug");
  assert.equal(result.results[1].trials[0].diagnostics.toolCalls[0].tool, "agent");
  assert.equal(result.results[1].trials[0].diagnostics.verification.status, "passed");
});

test("E2E rejects success prose when the actual project was never fixed", async () => {
  const definition = await loadCase();
  definition.execution.scripted.main = [{ text: "Fixed it; npm test passed." }];
  const result = await executeEvalCase(definition);
  assert.equal(result.passed, false);
  assert.deepEqual(result.trials[0].changedFiles, []);
  const command = result.trials[0].checks.find((check) => check.name.startsWith("command:"));
  assert.equal(command.passed, false);
  assert.equal(command.evidence.exitCode, 1);
});

test("E2E checks actual failing tests despite a file check and self-reported success", async () => {
  const definition = await loadCase();
  definition.execution.scripted.main[1].arguments.replace = "return a + b + 1;";
  definition.execution.scripted.main.push({ text: "Fixed src/add.js; npm test passed." }, { text: "Fixed src/add.js; npm test passed." });
  const result = await executeEvalCase(definition);
  assert.equal(result.passed, false);
  assert.equal(result.trials[0].checks.find((check) => check.name === "file:src/add.js").passed, true);
  assert.equal(result.trials[0].checks.find((check) => check.name.startsWith("command:")).evidence.exitCode, 1);
  assert.equal(result.trials[0].diagnostics.verification.status, "failed");
  assert.equal(result.summary.costUsd, null, "unknown model price is not recorded as free");
});

test("E2E graders survive visible-test tampering and independently reject forbidden changes", async () => {
  const definition = await loadCase();
  definition.execution.scripted.main = [
    { tool: "write_file", arguments: { path: "test/add.test.js", content: "// no assertions\n" } },
    { tool: "run_shell", arguments: { command: "npm test" } },
    { text: "Fixed it; npm test passed." },
  ];
  const result = await executeEvalCase(definition);
  assert.equal(result.passed, false);
  assert.equal(result.trials[0].checks.find((check) => check.name === "change-scope").passed, false);
  assert.equal(result.trials[0].checks.find((check) => check.name === "unchanged:test/").passed, false);
  assert.equal(result.trials[0].checks.find((check) => check.name.startsWith("command:")).passed, false);
});

test("E2E snapshots include forbidden empty directories and prototype-like filenames", async () => {
  const definition = await loadCase();
  definition.execution.scripted.main.splice(2, 0, { tool: "run_shell", arguments: { command: "mkdir unexpected && printf side-effect > __proto__" } });
  const result = await executeEvalCase(definition);
  assert.equal(result.passed, false);
  assert.deepEqual(result.trials[0].changedFiles, ["__proto__", "src/add.js", "unexpected/"]);
  assert.equal(result.trials[0].checks.find((check) => check.name === "change-scope").passed, false);
});

test("E2E cleans projects and supports an explicitly configured provider adapter", async () => {
  const definition = await loadCase();
  let workspace;
  let task;
  const result = await executeEvalCase(definition, { clientFactory: async (context) => {
    workspace = context.workspace;
    task = context.caseDefinition.task;
    const { createScriptedEvalClient } = await import("../eval/execution.js");
    return createScriptedEvalClient(context.caseDefinition.execution.scripted);
  } });
  assert.equal(result.passed, true);
  assert.equal(task, definition.task);
  await assert.rejects(readFile(join(workspace, "src/add.js")), { code: "ENOENT" });
});

test("E2E CLI emits clean JSON, enforces nonzero failure exit and keeps trace mode distinct", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-eval-cli-"));
  try {
    const definition = await loadCase();
    definition.execution.scripted.main = [{ text: "Fixed; npm test passed." }];
    await writeFile(join(directory, "failure.json"), JSON.stringify(definition));
    const runner = new URL("../eval/runner.js", import.meta.url).pathname;
    const error = await execFileAsync(process.execPath, [runner, "--execute", "--cases-dir", directory, "--no-report", "--json"]).then(() => assert.fail("Expected CI failure"), (error) => error);
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.evaluationKind, "harness-e2e");
    assert.equal(report.summary.failed, 1);
    const trace = await execFileAsync(process.execPath, [runner, "--case", "small-bugfix", "--no-report", "--json"]);
    assert.equal(JSON.parse(trace.stdout).evaluationKind, "trace-grader");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("E2E refuses missing graders, out-of-scope paths and invalid trials", async () => {
  const definition = await loadCase();
  await assert.rejects(executeEvalCase(definition, { trials: 0 }), /trials/);
  definition.execution.files["../outside"] = "no";
  await assert.rejects(executeEvalCase(definition), /Invalid eval workspace path/);
  delete definition.execution.files["../outside"];
  definition.execution.checks.commands = [{ command: "node", args: ["test/add.test.js"] }];
  await assert.rejects(executeEvalCase(definition), /workspace executables or test scripts are mutable/);
  definition.execution.checks = {};
  await assert.rejects(executeEvalCase(definition), /independent file or command checks/);
});

test("E2E independent file checks refuse symlink paths even when their target matches", async () => {
  const definition = await loadCase();
  definition.task = "Summarize the project.";
  definition.execution.allowedChanges = ["alias"];
  definition.execution.checks = { files: [{ path: "alias", equals: "spoof" }] };
  const result = await executeEvalCase(definition, { clientFactory: async ({ workspace }) => {
    await writeFile(join(workspace, "..", "outside"), "spoof");
    await symlink("../outside", join(workspace, "alias"));
    const { createScriptedEvalClient } = await import("../eval/execution.js");
    return createScriptedEvalClient([{ text: "This project implements addition." }]);
  } });
  assert.equal(result.passed, false);
  assert.match(result.trials[0].checks.find((check) => check.name === "file:alias").detail, /refuses symlink/);
  assert.equal(result.trials[0].workspaceState.after.alias.kind, "symlink");
});
