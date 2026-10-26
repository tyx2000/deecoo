import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeTaskCoordination } from "../src/agent/coordination.js";
import { addApprovedShellCommand, loadSettingsEnv, resolveShellPermissions, setAutoApproveAllShellCommands } from "../src/config/settings.js";
import { inferTaskIntent } from "../src/harness/taskIntent.js";
import { buildTaskSpec, taskSpecMessage } from "../src/harness/taskSpec.js";
import { classifyShellCommand, normalizeShellCommand } from "../src/permissions/shellPolicy.js";
import { buildTaskToolPolicy, effectiveToolNames, taskToolPolicyViolation } from "../src/permissions/taskPolicy.js";
import { isSensitivePath } from "../src/tools/pathPolicy.js";
import { createToolRuntime } from "../src/tools/runtime.js";

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-harness-policy-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test("negative review instructions produce a read-only contract even when they mention errors and modification", () => {
  for (const task of ["审查错误处理，不要修改", "审查修复建议，不要修改任何文件", "Review error handling; do not modify files", "Analyze the bug without changing files", "Review code without modifying files", "Review code, do not create files", "审查代码，不要创建文件"]) {
    const coordination = analyzeTaskCoordination(task);
    const spec = buildTaskSpec({ task, cwd: "/workspace", coordination });
    assert.equal(spec.mayWrite, false, task);
    assert.equal(spec.explicitReadOnly, true, task);
    assert.equal(spec.requiresCodeChange, false, task);
    assert.equal(coordination.phases.some((phase) => phase.name === "Implementation"), false, task);
  }
  assert.equal(inferTaskIntent("审查错误处理，不要修改").requestType, "review");
  assert.equal(inferTaskIntent("继续完善输出策略是否合理").mayWrite, false);
  assert.equal(inferTaskIntent("修复错误并进行审查").requiresCodeChange, true);
  assert.equal(inferTaskIntent("不要修改生成文件，修复 src 中的错误").mayWrite, true);
  assert.equal(inferTaskIntent("运行 npm run build").requiresCodeChange, false);
  assert.equal(inferTaskIntent("运行 npm run build").mayWrite, true);
  assert.equal(inferTaskIntent("Create worker-result.txt with synthetic data").mayWrite, true);
  assert.equal(inferTaskIntent("创建 worker-result.txt 并自检").requiresCodeChange, true);
  assert.equal(inferTaskIntent("Modify worker-result.txt with synthetic data").requiresCodeChange, true);
  assert.equal(buildTaskSpec({ task: "custom script", mode: "command" }).mayWrite, true);
  assert.equal(buildTaskSpec({ task: "fix the bug", mode: "read-only" }).mayWrite, false);
});

// The task spec is rendered as pretty JSON in the run conversation, so its key order is the
// format users and the model read. It regressed to leading with the nested acceptance block,
// burying goal/cwd/requestType, so pin the original goal-first shape here.
test("task spec message keeps the original goal-first JSON layout", () => {
  const task = "修复登录重定向问题并运行相关测试";
  const message = taskSpecMessage(buildTaskSpec({ task, cwd: "/workspace", coordination: analyzeTaskCoordination(task) }));
  assert.equal(message.role, "system");
  const header = "Structured task spec:";
  assert.ok(message.content.startsWith(`${header}\n{`), "spec JSON must follow the header");
  const footer = "\nUse this as the execution contract.";
  assert.ok(message.content.includes(footer), "the execution-contract reminder must stay after the JSON");
  const spec = JSON.parse(message.content.slice(header.length + 1, message.content.lastIndexOf(footer)));
  const keys = Object.keys(spec);
  assert.deepEqual(keys.slice(0, 4), ["schemaVersion", "goal", "cwd", "requestType"]);
  assert.deepEqual(keys.slice(keys.indexOf("complexity")), [
    "complexity", "constraints", "phases", "riskDomains", "successCriteria", "acceptance", "requiredChecks"
  ]);
  assert.equal(spec.goal, task);
  assert.equal(spec.acceptance.schemaVersion, 1);
  assert.deepEqual(spec.requiredChecks, spec.acceptance.requiredChecks);
});

test("effective policy intersects user, task, and worker capabilities", () => {
  const names = ["read_file", "write_file", "run_shell", "agent"];
  const taskPolicy = buildTaskToolPolicy({ mayWrite: false });
  assert.deepEqual(effectiveToolNames({ toolNames: names, permissionMode: "workspace-write", taskPolicy }), ["read_file", "agent"]);
  assert.equal(taskToolPolicyViolation("run_shell", { command: "node --version" }, { taskPolicy, workerMode: "verify" }).ok, false);
  assert.equal(taskToolPolicyViolation("run_shell", {}, { taskPolicy: buildTaskToolPolicy({ mayWrite: true }), permissionMode: "read-only", workerMode: "verify" }).ok, false);
  assert.equal(taskToolPolicyViolation("agent", { mode: "implement" }, { taskPolicy }).ok, false);
  assert.equal(taskToolPolicyViolation("run_shell", {}, { taskPolicy: buildTaskToolPolicy({ mayWrite: true }), permissionMode: "workspace-write", workerMode: "verify" }), null);
});

test("shell approval grants are workspace scoped, canonical, and preserve quoted whitespace", async (t) => {
  const workspace = await fixture(t);
  const other = join(workspace, "other");
  const actual = join(workspace, "actual");
  const alias = join(workspace, "alias");
  await mkdir(actual);
  await mkdir(other);
  await symlink(actual, alias);
  const settingsPath = join(workspace, "settings.json");
  const command = '  printf "a  b"  ';
  await addApprovedShellCommand({ settingsPath, workspace: alias, command });
  const settings = await loadSettingsEnv({ settingsPath, workspace: actual });
  assert.deepEqual(settings.permissions.shell.approvedCommands, ['printf "a  b"']);
  assert.equal(settings.permissions.shell.approvedCommands.includes('printf "a b"'), false);
  assert.equal(normalizeShellCommand(' printf "a  b" '), 'printf "a  b"');
  assert.deepEqual((await resolveShellPermissions(settings.permissions, { workspace: other })).shell.approvedCommands, []);
  await setAutoApproveAllShellCommands({ settingsPath, workspace: actual });
  assert.equal((await loadSettingsEnv({ settingsPath, workspace: other })).permissions.shell.autoApproveAll, false);
  await addApprovedShellCommand({ settingsPath, workspace: actual, command: "node --version", scope: "global" });
  assert.deepEqual((await loadSettingsEnv({ settingsPath, workspace: other })).permissions.shell.approvedCommands, ["node --version"]);
  const raw = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(raw.permissions.shell.approvals.every((entry) => entry.version === 2), true);
});

test("legacy unscoped approvals stay inert through load and subsequent approval writes", async (t) => {
  const workspace = await fixture(t);
  const settingsPath = join(workspace, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ permissions: { shell: { approvedCommands: ["chmod 755 ."], autoApproveAll: true } } }));
  let shell = (await loadSettingsEnv({ settingsPath, workspace })).permissions.shell;
  assert.deepEqual(shell.approvedCommands, []);
  assert.equal(shell.autoApproveAll, false);
  assert.equal(shell.legacyPending, true);
  await addApprovedShellCommand({ settingsPath, workspace, command: "npm install" });
  shell = (await loadSettingsEnv({ settingsPath, workspace })).permissions.shell;
  assert.deepEqual(shell.approvedCommands, ["npm install"]);
  assert.equal(shell.autoApproveAll, false);
  assert.deepEqual(shell.legacy.approvedCommands, ["chmod 755 ."]);
  assert.equal(shell.legacy.autoApproveAll, true);
});

test("sensitive policy recognizes nested credential variants and allows dotenv samples", () => {
  for (const path of [".env.staging", "packages/app/.env.test.local", "nested/.aws/credentials", "nested/.ssh/config", "nested/.gnupg/key", "nested/.npmrc", "nested/.docker/config.json", "nested/.kube/config", "nested/.deecoo/settings.json", "nested\\.AWS\\credentials"]) {
    assert.equal(isSensitivePath(path), true, path);
    assert.equal(classifyShellCommand(`cat '${path}'`).level, "block", path);
  }
  for (const path of [".env.example", "nested/.env.staging.sample", ".env.template", "src/environment.js"]) {
    assert.equal(isSensitivePath(path), false, path);
    assert.equal(classifyShellCommand(`cat '${path}'`).level, "allow", path);
  }
  assert.equal(isSensitivePath(".aws/.env.example"), true);
  assert.equal(classifyShellCommand("sudo cat .env.example").level, "block");
});

test("list, read, search, and write enforce one sensitive path policy", async (t) => {
  const workspace = await fixture(t);
  for (const path of [".env.staging", "nested/.ssh/config", "nested/.aws/credentials", "nested/.npmrc", "nested/.docker/config.json", "nested/.kube/config", "nested/.deecoo/settings.json", ".env.example", "nested/.env.production.sample", "src/normal.js"]) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), "POLICY_BOUNDARY_MARKER\n");
  }
  const tools = createToolRuntime({ cwd: workspace, permissionMode: "workspace-write", prompter: async () => "approve" });
  const listing = await tools.execute("list_files", { maxDepth: 5 });
  assert.equal(listing.ok, true);
  assert.equal(listing.files.some(isSensitivePath), false);
  assert.equal(listing.files.includes(".env.example"), true);
  for (const path of [".env.staging", "nested/.aws/credentials", "nested/.ssh/config", "nested/.npmrc"]) {
    assert.equal((await tools.execute("read_file", { path })).ok, false, path);
    assert.equal((await tools.execute("write_file", { path, content: "changed" })).ok, false, path);
  }
  assert.equal((await tools.execute("read_file", { path: ".env.example" })).ok, true);
  const search = await tools.execute("search_text", { query: "POLICY_BOUNDARY_MARKER", maxResults: 50 });
  assert.equal(search.ok, true, search.error);
  assert.equal(search.matches.length, 3);
  assert.equal(search.matches.some((line) => isSensitivePath(line.split(":")[0])), false);
  assert.equal(search.matches.some((line) => line.includes("src/normal.js:")), true);
});
