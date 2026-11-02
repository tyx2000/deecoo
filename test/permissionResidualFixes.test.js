import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runShell } from "../src/tools/shell.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { classifyShellCommand } from "../src/permissions/shellPolicy.js";
import { parseShellApprovalKey, shellApprovalKey } from "../src/permissions/shellApprovals.js";
import { addApprovedShellCommand, applySettingsEnv, loadSettingsEnv } from "../src/config/settings.js";
import { loadConfig } from "../src/config/env.js";
import { formatIgnoredDotEnvKeys, loadDotEnvIfPresent } from "../src/cli/dotenv.js";
import { parseArgs } from "../src/cli/args.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-permission-residual-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const backendFor = (executions) => ({ run: async (args) => {
  executions.push(args);
  return { ok: true, exitCode: 0, stdout: "", stderr: "" };
} });

test("R2-P2-2 remembered commands bind canonical cwd, survive reload and ignore command-only grants", async (t) => {
  const workspace = await fixture(t);
  const child = join(workspace, "child");
  await mkdir(child);
  await symlink(child, join(workspace, "alias"));
  const settingsPath = join(workspace, "settings.json");
  const executions = [];
  let prompts = 0;
  const tools = createToolRuntime({ cwd: workspace, executionBackend: backendFor(executions),
    approvedShellCommands: ["npm test"], // old command-only settings never implicitly grant a cwd
    prompter: async () => { prompts += 1; return "always"; },
    onApproveShellCommand: (command) => addApprovedShellCommand({ settingsPath, workspace, command }),
  });
  for (const cwd of [".", ".", "child", "child/."]) assert.equal((await tools.execute("run_shell", { cwd, command: "npm test" })).ok, true);
  assert.equal(prompts, 2, "root and child each need one approval; path aliases reuse the child's grant");
  assert.equal((await tools.execute("run_shell", { cwd: "alias", command: "npm test" })).code, "SHELL_CWD_BLOCKED", "nested symlink cwd remains forbidden by the existing path policy");
  assert.equal(new Set(executions.map((call) => call.cwd)).size, 2);
  const settings = await loadSettingsEnv({ settingsPath, workspace });
  const grants = settings.permissions.shell.approvedCommands;
  assert.deepEqual(grants.map(parseShellApprovalKey), [
    { cwd: await realpath(workspace), command: "npm test" },
    { cwd: await realpath(child), command: "npm test" },
  ]);
  const reloaded = createToolRuntime({ cwd: workspace, executionBackend: backendFor(executions), approvedShellCommands: grants,
    prompter: async () => assert.fail("a remembered cwd/command must survive reload") });
  assert.equal((await reloaded.execute("run_shell", { cwd: "child", command: "npm test" })).ok, true);
});

test("R2-P2-2 old workspace-scoped settings remain visible as pending but never effective", async (t) => {
  const workspace = await fixture(t);
  const settingsPath = join(workspace, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ permissions: { shell: { policyVersion: 2, approvals: [
    { version: 2, scope: "workspace", workspace: await realpath(workspace), command: "npm test" },
  ] } } }));
  const before = await loadSettingsEnv({ settingsPath, workspace });
  assert.deepEqual(before.permissions.shell.approvedCommands, []);
  assert.equal(before.permissions.shell.legacyPending, true);
  await addApprovedShellCommand({ settingsPath, workspace, command: "npm test" });
  const after = await loadSettingsEnv({ settingsPath, workspace });
  assert.deepEqual(after.permissions.shell.approvedCommands, [shellApprovalKey(await realpath(workspace), "npm test")]);
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).permissions.shell.approvals.length, 2);
});

test("R2-P2-2 changing a workspace alias during approval cannot dispatch under the old approval", async (t) => {
  const directory = await fixture(t);
  await mkdir(join(directory, "first"));
  await mkdir(join(directory, "second"));
  const alias = join(directory, "alias");
  await symlink(join(directory, "first"), alias);
  const executions = [];
  const result = await runShell(alias, { command: "npm test" }, async () => {
    await unlink(alias); await symlink(join(directory, "second"), alias);
    return "always";
  }, false, { executionBackend: backendFor(executions), approvedShellCommands: new Set() });
  assert.equal(result.code, "SHELL_CWD_CHANGED");
  assert.equal(executions.length, 0);
});

test("R2-P2-3 untrusted project provider, model and credentials cannot replace settings", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, ".env"), [
    "DEECOO_PROVIDER=openai", "DEECOO_MODEL=gpt-synthetic", "OPENAI_API_KEY=repository-synthetic",
    "DEEPSEEK_API_KEY=repository-deepseek", "DEECOO_BASE_URL=https://project.invalid",
    "DEECOO_TRUST_PROJECT_ENV=1", "DEECOO_THEME=tokyo-night",
  ].join("\n"));
  const env = {};
  const result = await loadDotEnvIfPresent(directory, { env });
  const config = loadConfig(env, {}, { activeProvider: "deepseek", providers: { deepseek: { apiKey: "user-synthetic" } } });
  assert.equal(config.provider, "deepseek");
  assert.equal(config.apiKey, "user-synthetic");
  assert.equal(config.configSources.apiKey, "settings.json");
  assert.equal(env.DEECOO_MODEL, undefined);
  assert.equal(env.DEECOO_TRUST_PROJECT_ENV, undefined);
  assert.equal(env.DEECOO_THEME, "tokyo-night");
  assert.equal(result.untrusted.length, 4);
  assert.match(formatIgnoredDotEnvKeys(result), /--trust-project-env/);
  assert.doesNotMatch(formatIgnoredDotEnvKeys(result), /repository-synthetic/);
});

test("R2-P2-3 explicitly trusted project values work with provenance while process values and security settings win", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, ".env"), [
    "DEECOO_PROVIDER=openai", "DEECOO_MODEL=gpt-synthetic", "OPENAI_API_KEY=repository-synthetic",
    "DEECOO_BASE_URL=https://project.invalid", "DEECOO_SANDBOX=off",
  ].join("\n"));
  const env = {};
  const result = await loadDotEnvIfPresent(directory, { trusted: true, env });
  const config = loadConfig(env, {}, { activeProvider: "deepseek", providers: { deepseek: { apiKey: "user-synthetic" } } });
  assert.equal(config.provider, "openai");
  assert.equal(config.apiKey, "repository-synthetic");
  assert.match(config.configSources.apiKey, /project \.env/);
  assert.match(config.configSources.provider, /project \.env/);
  assert.equal(env.DEECOO_BASE_URL, undefined);
  assert.equal(env.DEECOO_SANDBOX, undefined);
  assert.match(formatIgnoredDotEnvKeys(result), /Using trusted project/);
  assert.doesNotMatch(formatIgnoredDotEnvKeys(result), /repository-synthetic/);
  const processEnv = { DEECOO_PROVIDER: "deepseek", DEECOO_MODEL: "deepseek-chat", OPENAI_API_KEY: "process-synthetic" };
  await loadDotEnvIfPresent(directory, { trusted: true, env: processEnv });
  assert.equal(processEnv.DEECOO_PROVIDER, "deepseek");
  assert.equal(processEnv.OPENAI_API_KEY, "process-synthetic");
  assert.equal(parseArgs(["--trust-project-env", "task"]).trustProjectEnv, true);
});

test("R2-P2-1 dynamic command names and find mutations require approval while literal reads stay allowed", () => {
  // Classification only; no filesystem mutation commands are executed.
  for (const command of ["r{m,} -rf build", "$'\\x72m' -rf build", "env r{m,} -rf build", "find . -delete", "find . -fprint results.txt", "gfind . -fprintf results.txt '%p'"]) {
    assert.notEqual(classifyShellCommand(command).level, "allow", command);
  }
  for (const command of ["find . -name '*.js' -print", "find . -type f -ls", "echo '{left,right}'", "printf '%s' hello", "git status --short"]) {
    assert.equal(classifyShellCommand(command).level, "allow", command);
  }
});

test("R2-P2-3 settings environment provenance tracks assignments without relabeling process values", () => {
  const env = { DEEPSEEK_API_KEY: "process-synthetic" };
  applySettingsEnv({ DEECOO_MODEL: "deepseek-chat", DEEPSEEK_API_KEY: "settings-synthetic" }, { targetEnv: env });
  let config = loadConfig(env);
  assert.equal(config.configSources.provider, "settings.json");
  assert.equal(config.configSources.apiKey, "process environment");
  assert.equal(config.apiKey, "process-synthetic");
  applySettingsEnv({ DEEPSEEK_API_KEY: "settings-synthetic" }, { targetEnv: env, overrideKeys: ["DEEPSEEK_API_KEY"] });
  config = loadConfig(env);
  assert.equal(config.configSources.apiKey, "settings.json");
  assert.equal(config.apiKey, "settings-synthetic");
});
