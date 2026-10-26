import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyStructuredPatchSet, writeWorkspaceFile } from "../src/tools/files.js";
import { secureWrite } from "../src/tools/secureFs.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "deecoo-write-boundary-"));
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(workspace); await mkdir(outside);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, outside, real: () => realpath(workspace),
    permissions: { mode: "ask-always", readCache: new Map() } };
}

test("DS-CHECK-SEC-002 creation refuses a parent swapped during approval without creating outside directories", async t => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "parent"));
  const approve = async () => {
    await rename(join(f.workspace, "parent"), join(f.workspace, "original-parent"));
    await symlink(f.outside, join(f.workspace, "parent"));
    return "approve";
  };
  const outcome = await writeWorkspaceFile(f.workspace, f.real, { path: "parent/nested/result.txt", content: "ESCAPED" }, approve, f.permissions).catch(error => ({ ok: false, code: error.code }));
  assert.equal(outcome.ok, false);
  assert.deepEqual(await readdir(f.outside), [], "Neither file nor intermediate directory may appear outside");
});

test("DS-CHECK-SEC-002 nested create, compare-before-overwrite, patch create and move preserve legitimate behavior", async t => {
  const f = await fixture(t), approve = async () => "approve";
  assert.equal((await writeWorkspaceFile(f.workspace, f.real, { path: "src/nested/a.txt", content: "old\n" }, approve, f.permissions)).ok, true);
  assert.equal((await writeWorkspaceFile(f.workspace, f.real, { path: "src/nested/a.txt", expectedContent: "old\n", content: "new\n" }, approve, f.permissions)).ok, true);
  assert.equal((await writeWorkspaceFile(f.workspace, f.real, { path: "src/nested/a.txt", expectedContent: "old\n", content: "bad\n" }, approve, f.permissions)).ok, false);
  const patched = await applyStructuredPatchSet(f.workspace, f.real, { files: [
    { action: "create", path: "src/created/a.txt", content: "created\n" },
    { action: "move", from: "src/nested/a.txt", path: "src/moved/a.txt" },
  ] }, approve, f.permissions);
  assert.equal(patched.ok, true, patched.error);
  assert.equal(await readFile(join(f.workspace, "src/created/a.txt"), "utf8"), "created\n");
  assert.equal(await readFile(join(f.workspace, "src/moved/a.txt"), "utf8"), "new\n");
});

test("DS-CHECK-SEC-002 patch-set create refuses a replaced parent and leaves outside content unchanged", async t => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "parent"));
  await writeFile(join(f.outside, "keep.txt"), "keep");
  const approve = async () => {
    await rename(join(f.workspace, "parent"), join(f.workspace, "old-parent"));
    await symlink(f.outside, join(f.workspace, "parent"));
    return "approve";
  };
  const result = await applyStructuredPatchSet(f.workspace, f.real, { files: [{ action: "create", path: "parent/new.txt", content: "bad" }] }, approve, f.permissions).catch(error => ({ ok: false, code: error.code }));
  assert.equal(result.ok, false);
  assert.deepEqual(await readdir(f.outside), ["keep.txt"]);
  assert.equal(await readFile(join(f.outside, "keep.txt"), "utf8"), "keep");
});

test("DS-CHECK-SEC-002 cancellation during post-approval validation creates no file", async t => {
  const f = await fixture(t), controller = new AbortController();
  let approved = false;
  const real = async () => {
    const path = await realpath(f.workspace);
    if (approved) controller.abort(new Error("cancel during parent validation"));
    return path;
  };
  const result = await writeWorkspaceFile(f.workspace, real, { path: "created.txt", content: "AFTER_ABORT" }, async () => {
    approved = true; return "approve";
  }, f.permissions, controller.signal).catch(error => ({ ok: false, code: error.code }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "ABORT_ERR");
  assert.deepEqual(await readdir(f.workspace), []);
});

test("DS-CHECK-SEC-002 the root descriptor must retain the identity authorized before approval", async t => {
  const f = await fixture(t);
  const holder = join(f.root, "holder"), workspace = join(holder, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(f.outside, "workspace"));
  let approved = false, swapped = false;
  const real = async () => {
    const original = await realpath(workspace);
    if (approved && !swapped) {
      swapped = true;
      await rename(holder, join(f.root, "old-holder"));
      await symlink(f.outside, holder);
    }
    return original;
  };
  const outcome = await writeWorkspaceFile(workspace, real, { path: "created.txt", content: "ESCAPED" }, async () => {
    approved = true; return "approve";
  }, f.permissions).catch(error => ({ ok: false, code: error.code }));
  assert.equal(outcome.ok, false);
  assert.deepEqual(await readdir(join(f.outside, "workspace")), []);
});

test("DS-CHECK-SEC-002 a killed partial write is reported uncertain rather than fully rolled back", async t => {
  const f = await fixture(t);
  // Warm the compiler cache before applying the child's file-size limit.
  await secureWrite(f.workspace, join(f.workspace, "warm.txt"), "warm", { create: true });
  await writeFile(join(f.workspace, "a.txt"), "one\n");
  await writeFile(join(f.workspace, "b.txt"), "two\n");
  const runtime = new URL("../src/tools/runtime.js", import.meta.url).href;
  const script = `import{createToolRuntime}from ${JSON.stringify(runtime)};
const tools=createToolRuntime({cwd:${JSON.stringify(f.workspace)},permissionMode:'workspace-write'});
const r=await tools.execute('apply_patch_set',{files:[
{path:'a.txt',hunks:[{oldStart:1,oldLines:['one'],newLines:['ONE']}]},
{path:'b.txt',hunks:[{oldStart:1,oldLines:['two'],newLines:['x'.repeat(100000)]}]}]});
console.log(JSON.stringify(r));`;
  const child = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", 'ulimit -S -f 1; exec "$@"', "deecoo-limit-fixture", process.execPath, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.equal(result.code, "PATCH_SET_ROLLBACK_FAILED");
  assert.ok(result.uncertainPaths.includes("b.txt"));
  assert.ok(result.effects.events.some(event => event.type === "workspace-uncertain"));
  assert.equal(await readFile(join(f.workspace, "a.txt"), "utf8"), "one\n");
});
