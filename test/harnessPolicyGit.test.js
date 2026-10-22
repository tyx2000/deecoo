import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { buildWorkspaceSnapshot } from "../src/context/workspaceSnapshot.js";
import { resolveReviewScope } from "../src/context/reviewScope.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const run = promisify(execFile);

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-git-policy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await run("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, "normal.txt"), "old\n");
  await writeFile(join(cwd, ".env.staging"), "SYNTHETIC_SECRET=OLD\n");
  await run("git", ["add", "normal.txt", ".env.staging"], { cwd });
  await writeFile(join(cwd, "normal.txt"), "new\n");
  await writeFile(join(cwd, ".env.staging"), "SYNTHETIC_SECRET=NEW_SENTINEL\n");
  return cwd;
}

test("Git diffs omit sensitive files in staged and worktree changes and reject explicit sensitive paths", async (t) => {
  const cwd = await repository(t);
  const tools = createToolRuntime({ cwd, permissionMode: "read-only", prompter: async () => "deny" });
  for (const staged of [false, true]) {
    const result = await tools.execute("git_diff", { staged });
    assert.equal(result.ok, true, result.error);
    assert.match(result.diff, /normal\.txt/);
    assert.doesNotMatch(result.diff, /SYNTHETIC_SECRET|NEW_SENTINEL|\.env\.staging/);
  }
  assert.equal((await tools.execute("git_diff", { path: ".env.staging" })).ok, false);
  const index = await readFile(join(cwd, ".git", "index"));
  assert.equal((await tools.execute("git_status", {})).ok, true);
  assert.deepEqual(await readFile(join(cwd, ".git", "index")), index);
});

test("read-only Git calls disable external diff, textconv, fsmonitor, and content filters", async (t) => {
  const cwd = await repository(t);
  const marker = join(cwd, "SYNTHETIC_HELPER_EXECUTED");
  const script = join(cwd, "helper.cjs");
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  const helper = `${process.execPath} ${script}`;
  for (const [key, value] of [["diff.external", helper], ["diff.probe.textconv", helper], ["core.fsmonitor", helper], ["filter.probe.clean", helper], ["filter.probe.smudge", helper], ["filter.probe.process", helper], ["filter.probe.required", "true"]]) {
    await run("git", ["config", key, value], { cwd });
  }
  await writeFile(join(cwd, ".gitattributes"), "normal.txt diff=probe filter=probe\n");
  const tools = createToolRuntime({ cwd, permissionMode: "read-only", prompter: async () => "deny" });
  const diff = await tools.execute("git_diff", {});
  assert.equal(diff.ok, true, diff.error);
  assert.match(diff.diff, /\+new/);
  assert.equal((await tools.execute("git_status", {})).ok, true);
  await buildWorkspaceSnapshot(cwd);
  await resolveReviewScope({ cwd, task: "审查当前改动" });
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("Git diff treats unusual tracked path names as literal pathspecs", async (t) => {
  const cwd = await repository(t);
  const path = ":(glob)*.txt";
  await writeFile(join(cwd, path), "before\n");
  await run("git", ["--literal-pathspecs", "add", "--", path], { cwd });
  await writeFile(join(cwd, path), "after\n");
  const tools = createToolRuntime({ cwd, permissionMode: "read-only" });
  const result = await tools.execute("git_diff", { path });
  assert.equal(result.ok, true, result.error);
  assert.match(result.diff, /\+after/);
  assert.doesNotMatch(result.diff, /\+new/);
});

test("Git diff in a nested workspace reports only files under that workspace", async (t) => {
  const repositoryRoot = await repository(t);
  const cwd = join(repositoryRoot, "nested");
  await mkdir(cwd);
  await writeFile(join(cwd, "nested.txt"), "before\n");
  await run("git", ["add", "nested/nested.txt"], { cwd: repositoryRoot });
  await writeFile(join(cwd, "nested.txt"), "NESTED_WORKSPACE_CHANGE\n");
  const tools = createToolRuntime({ cwd, permissionMode: "read-only" });
  const result = await tools.execute("git_diff", {});
  assert.equal(result.ok, true, result.error);
  assert.match(result.diff, /NESTED_WORKSPACE_CHANGE/);
  assert.doesNotMatch(result.diff, /normal\.txt|SYNTHETIC_SECRET/);
});
