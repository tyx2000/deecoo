import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExecutionBackend } from "../src/execution/backend.js";
import { detectSandbox, executionCommand, executionEnv, nodeRuntimeRoot, normalizeSandboxPolicy, seatbeltProfile } from "../src/execution/sandbox.js";
import { classifyShellCommand } from "../src/permissions/shellPolicy.js";
import { createToolRuntime } from "../src/tools/runtime.js";

async function scratch(t, prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const levels = (commands) => Object.fromEntries(commands.map((command) => [command, classifyShellCommand(command).level]));
const seatbelt = detectSandbox();
// The strict host gate (npm run test:sandbox) sets DEECOO_REQUIRE_SANDBOX_TESTS so a missing
// backend fails instead of skipping.
const seatbeltSkip = process.platform !== "darwin" || ((!seatbelt.available || seatbelt.kind !== "seatbelt") && process.env.DEECOO_REQUIRE_SANDBOX_TESTS !== "1");

test("R2-P0-1 the sandbox policy keeps the repository's config, hooks, and .git entry read-only", async (t) => {
  const cwd = await scratch(t, "deecoo-r2-git-policy-");
  const policy = normalizeSandboxPolicy({ mode: "required" }, cwd, join(cwd, "..", "state"), join(cwd, "..", "temp"));
  for (const entry of ["config", "config.lock", "config.worktree", "hooks", "info", "modules"]) assert.ok(policy.denyWriteRoots.includes(join(cwd, ".git", entry)), entry);
  assert.deepEqual(policy.denyWriteLiterals, [join(cwd, ".git")]);
  assert.match(seatbeltProfile(policy), new RegExp(`\\(deny file-write\\* \\(literal "${join(cwd, ".git").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\)\\)`));
  assert.ok(policy.writeRoots.includes(cwd), "the rest of the workspace stays writable");
});

test("R2-P0-1 a sandboxed job cannot plant git config or hooks, but ordinary git work still succeeds", { skip: seatbeltSkip }, async (t) => {
  const cwd = await scratch(t, "deecoo-r2-git-sandbox-");
  const temp = await scratch(t, "deecoo-r2-git-sandbox-tmp-");
  const state = await scratch(t, "deecoo-r2-git-sandbox-state-");
  git(cwd, "init", "-q", ".");
  git(cwd, "commit", "-q", "--allow-empty", "-m", "init");
  const configBefore = await readFile(join(cwd, ".git", "config"), "utf8");
  const policy = normalizeSandboxPolicy({ mode: "required" }, cwd, state, temp);
  const run = (command) => {
    const launch = executionCommand({ command, cwd, policy, sandbox: seatbelt });
    assert.equal(launch.sandbox.enforced, true);
    return spawnSync(launch.executable, launch.args, { cwd, encoding: "utf8", env: executionEnv(process.env, temp) });
  };
  assert.notEqual(run("git config core.fsmonitor ./planted.sh").status, 0);
  assert.notEqual(run("echo planted > .git/hooks/post-checkout").status, 0);
  assert.notEqual(run("mv .git .git-moved").status, 0, "renaming .git away would expose its config");
  assert.equal(await readFile(join(cwd, ".git", "config"), "utf8"), configBefore);
  assert.equal(existsSync(join(cwd, ".git", "hooks", "post-checkout")), false);
  const work = run("echo change > file.txt && git add file.txt && git -c user.name=t -c user.email=t@example.invalid commit -qm change && git checkout -q -b feature && git status --short");
  assert.equal(work.status, 0, work.stderr);
  assert.match(git(cwd, "log", "--oneline", "-1"), /change/);
});

test("R2-P1-1 only read-only git runs without approval; global options cannot hide the subcommand", () => {
  assert.deepEqual(levels(["git status", "git --version", "git diff HEAD~1", "git log --oneline -5", "git show HEAD", "git branch -a", "git tag", "git stash list",
    "git config user.name", "git config --get core.editor", "git grep foo", "git -c user.name=t status", "git -C sub status"]), Object.fromEntries(
    ["git status", "git --version", "git diff HEAD~1", "git log --oneline -5", "git show HEAD", "git branch -a", "git tag", "git stash list",
      "git config user.name", "git config --get core.editor", "git grep foo", "git -c user.name=t status", "git -C sub status"].map((command) => [command, "allow"])));
  for (const command of ["git config core.fsmonitor ./x.sh", "git config set core.hooksPath x", "git -c core.fsmonitor=./x status", "git -c alias.st='!id' st",
    "git --git-dir=/elsewhere status", "git checkout -- .", "git checkout main", "git restore .", "git stash", "git st", "git grep -O foo",
    "git submodule foreach id", "git difftool -x id", "git log --ext-diff", "GIT_EXTERNAL_DIFF=./x git diff", "export GIT_PAGER=./x; git log", "git branch feature"]) {
    assert.equal(classifyShellCommand(command).level, "warn", command);
  }
  for (const command of ["git -c x=y reset --hard", "git -C a clean -fd"]) assert.equal(classifyShellCommand(command).level, "block", command);
});

test("R2-P1-1 run_shell git asks first when the repository configures programs, and never runs its fsmonitor", async (t) => {
  const root = await scratch(t, "deecoo-r2-git-runtime-");
  const clean = join(root, "clean");
  const filtered = join(root, "filtered");
  for (const directory of [clean, filtered]) { await mkdir(join(directory, "sub"), { recursive: true }); git(directory, "init", "-q", "."); }
  await writeFile(join(clean, "fsmonitor.sh"), "#!/bin/sh\necho ran > fsmonitor-ran\n");
  await chmod(join(clean, "fsmonitor.sh"), 0o755);
  git(clean, "config", "core.fsmonitor", join(clean, "fsmonitor.sh"));
  git(filtered, "config", "filter.planted.clean", "cat");
  const runtime = (cwd) => {
    const prompts = [];
    const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async (question) => { prompts.push(question); return "approve"; },
      executionBackend: createExecutionBackend({ cwd, stateDir: join(root, "state-" + prompts.length + Math.random()), sandboxPolicy: { mode: "off" } }) });
    return { tools, prompts };
  };
  const plain = runtime(clean);
  const status = await plain.tools.execute("run_shell", { command: "git status --short" });
  assert.equal(status.ok, true, status.error);
  assert.equal(plain.prompts.length, 0);
  assert.equal(existsSync(join(clean, "fsmonitor-ran")), false, "job environment disables the repository fsmonitor even without a sandbox");
  for (const [command, cwd] of [["git status --short", undefined], ["git -C .. diff", "sub"], ["bash -c 'git log -1'", undefined]]) {
    const configured = runtime(filtered);
    const result = await configured.tools.execute("run_shell", { command, cwd });
    assert.equal(configured.prompts.length, 1, command);
    assert.match(configured.prompts[0], /filter\.planted\.clean/);
    assert.equal(result.shellPolicy.level, "warn");
  }
  assert.deepEqual(Object.fromEntries(Object.entries(executionEnv({ PATH: "/bin", GIT_CONFIG_COUNT: "5" }, "/t")).filter(([key]) => key.startsWith("GIT_"))),
    { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false", GIT_PAGER: "cat" });
});

test("R2-P1-2 tools that launch another program need approval; their plain uses do not", () => {
  for (const command of ["node --check --require ./pre.cjs p.js", "node --check --import=./x.mjs a.js", "awk 'BEGIN{system(\"id\")}'", "awk -f prog.awk f", "awk '{print | \"sh\"}' f",
    "find . -name x -exec node p.js \\;", "sed -n '1e id' f", "sed 's/a/b/e' f", "sed -f script.sed f", "tar --to-command=sh -xf a.tar", "tar -I ./x -xf a",
    "zip -TT ./x a.zip f", "docker run alpine", "parallel echo ::: a", "crontab cron.txt", "open -a Calculator"]) {
    assert.equal(classifyShellCommand(command).level, "warn", command);
  }
  for (const command of ["node --check a.js", "awk '{print $1}' f", "find . -name '*.js'", "find . -name x -exec grep foo {} \\;", "sed -n '1p' f", "sed -i 's/a/b/g' f", "tar -xzf a.tgz", "docker ps"]) {
    assert.equal(classifyShellCommand(command).level, "allow", command);
  }
  assert.equal(classifyShellCommand("find . -exec rm -rf {} +").level, "block");
  assert.equal(classifyShellCommand("busybox sh -c 'rm -rf x'").level, "block");
});

test("R2-P1-3 edit_file and propose_patch write replacement text literally", async (t) => {
  const cwd = await scratch(t, "deecoo-r2-edit-");
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  for (const replacement of ["echo $$PPID", "IFS=$'\\n'", "$& and $` and $'", "price: $1.00 $2"]) {
    await writeFile(join(cwd, "file.sh"), "before\nTARGET\nafter\n");
    await tools.execute("read_file", { path: "file.sh" });
    const proposal = await tools.execute("propose_patch", { path: "file.sh", search: "TARGET", replace: replacement });
    assert.equal(proposal.ok, true, proposal.error);
    assert.match(proposal.patch, new RegExp("\\+" + replacement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const edit = await tools.execute("edit_file", { path: "file.sh", search: "TARGET", replace: replacement });
    assert.equal(edit.ok, true, edit.error);
    assert.equal(await readFile(join(cwd, "file.sh"), "utf8"), `before\n${replacement}\nafter\n`, replacement);
  }
});

test("R2-CI the sandbox reads a standard Node install whatever its directories are called", async (t) => {
  const root = await scratch(t, "deecoo-r2-runtime-");
  // GitHub's toolcache: <version>/<arch>/bin/node beside lib/node_modules (where npm lives).
  const toolcache = join(root, "node", "22.23.3", "arm64");
  await mkdir(join(toolcache, "bin"), { recursive: true });
  await mkdir(join(toolcache, "lib", "node_modules", "npm"), { recursive: true });
  assert.equal(nodeRuntimeRoot(join(toolcache, "bin", "node")), toolcache);
  // nvm-style version directories keep working without inspecting the disk.
  assert.equal(nodeRuntimeRoot(join(root, "versions", "node", "v24.1.0", "bin", "node")), join(root, "versions", "node", "v24.1.0"));
  // An unrecognised layout exposes only the executable's directory.
  assert.equal(nodeRuntimeRoot(join(root, "tools", "bin", "node")), join(root, "tools", "bin"));
  // Node directly in /bin or ~/bin never widens reads to / or the home directory.
  assert.equal(nodeRuntimeRoot("/bin/node"), "/bin");
  assert.equal(nodeRuntimeRoot(join(homedir(), "bin", "node")), join(homedir(), "bin"));
  const policy = normalizeSandboxPolicy({ mode: "required" }, root, join(root, ".state"), join(root, ".tmp"));
  assert.ok(policy.readRoots.includes(await realpath(nodeRuntimeRoot(process.execPath))), "the running Node installation is readable");
});

