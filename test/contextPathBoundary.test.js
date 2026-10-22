import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildProjectIndex } from "../src/context/projectIndex.js";
import { buildWorkspaceSnapshot, buildWorkspaceSnapshotMessages, ensureProjectDescription } from "../src/context/workspaceSnapshot.js";

async function fixture(fn) {
  const parent = await mkdtemp(join(tmpdir(), "deecoo-context-boundary-"));
  const cwd = join(parent, "workspace");
  const outside = join(parent, "outside");
  await Promise.all([mkdir(cwd), mkdir(outside)]);
  try { await fn({ cwd, outside }); }
  finally { await rm(parent, { recursive: true, force: true }); }
}

test("context collection excludes linked package, rules, README, and project notes outside its workspace", async () => fixture(async ({ cwd, outside }) => {
  const secret = "SYNTHETIC_SECRET_MUST_STAY_OUTSIDE_CONTEXT";
  await writeFile(join(outside, "package.json"), JSON.stringify({ name: secret, scripts: { test: secret } }));
  await writeFile(join(outside, "instructions.txt"), secret);
  await writeFile(join(outside, "PROJECT.md"), secret);
  await symlink(join(outside, "package.json"), join(cwd, "package.json"));
  await symlink(join(outside, "instructions.txt"), join(cwd, "AGENTS.md"));
  await symlink(join(outside, "instructions.txt"), join(cwd, "README.md"));
  await symlink(outside, join(cwd, ".deecoo"), "dir");
  const index = await buildProjectIndex(cwd);
  const snapshot = await buildWorkspaceSnapshot(cwd);
  const messages = await buildWorkspaceSnapshotMessages(cwd, { snapshot });
  assert.doesNotMatch(JSON.stringify({ index, snapshot, messages }), new RegExp(secret));
  assert.equal(snapshot.package, undefined);
  assert.equal(snapshot.projectInstructions.primary, undefined);
  assert.equal(snapshot.projectDescription, undefined);
  assert.deepEqual(index.scripts, {});
}));

test("automatic project description refuses linked directories and leaves the external target untouched", async () => fixture(async ({ cwd, outside }) => {
  const target = join(outside, "PROJECT.md");
  await writeFile(target, "EXTERNAL_NOTES_MUST_NOT_CHANGE");
  await symlink(outside, join(cwd, ".deecoo"), "dir");
  await assert.rejects(ensureProjectDescription(cwd), /symbolic links|outside workspace/i);
  assert.equal(await readFile(target, "utf8"), "EXTERNAL_NOTES_MUST_NOT_CHANGE");
}));

test("automatic project description rejects file links and internal directory links too", async () => fixture(async ({ cwd, outside }) => {
  await mkdir(join(cwd, ".deecoo"));
  const target = join(outside, "notes.md");
  await writeFile(target, "EXTERNAL_FILE_MUST_NOT_CHANGE");
  await symlink(target, join(cwd, ".deecoo", "PROJECT.md"));
  await assert.rejects(ensureProjectDescription(cwd), /symbolic links|outside workspace/i);
  assert.equal(await readFile(target, "utf8"), "EXTERNAL_FILE_MUST_NOT_CHANGE");
  assert.equal((await lstat(join(cwd, ".deecoo", "PROJECT.md"))).isSymbolicLink(), true);

  await rm(join(cwd, ".deecoo"), { recursive: true });
  await mkdir(join(cwd, "internal-context"));
  await symlink(join(cwd, "internal-context"), join(cwd, ".deecoo"), "dir");
  await assert.rejects(ensureProjectDescription(cwd), /symbolic links/i);
  assert.deepEqual(await readdir(join(cwd, "internal-context")), []);
}));

test("safe automatic project refresh atomically replaces the generated file and retains manual notes and rule priority", async () => fixture(async ({ cwd }) => {
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "safe-project", scripts: { test: "node --test" } }));
  await writeFile(join(cwd, ".deecoo.md"), "Use npm and small patches.");
  await writeFile(join(cwd, "AGENTS.md"), "Follow the project style.");
  const first = await ensureProjectDescription(cwd);
  await writeFile(first.path, "Manual notes survive refresh.\n" + first.content);
  const before = await lstat(first.path);
  await ensureProjectDescription(cwd);
  const after = await lstat(first.path);
  assert.notEqual(after.ino, before.ino, "refresh must replace a complete temporary file instead of truncating the destination");
  assert.match(await readFile(first.path, "utf8"), /Manual notes survive refresh/);
  assert.deepEqual(await readdir(join(cwd, ".deecoo")), ["PROJECT.md"]);
  const snapshot = await buildWorkspaceSnapshot(cwd);
  assert.equal(snapshot.projectInstructions.primary.path, ".deecoo.md");
  assert.equal(snapshot.projectInstructions.additional[0].path, "AGENTS.md");
  assert.match(snapshot.projectDescription.content, /Manual notes survive refresh/);
}));
