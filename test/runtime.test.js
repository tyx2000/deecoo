import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolRuntime } from "../src/tools/runtime.js";

function runtime(cwd) {
  return createToolRuntime({
    cwd,
    prompter: async () => "approve",
    permissionMode: "workspace-write",
  });
}

function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

test("read_file rejects symlinks that point outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "deecoo-runtime-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace, { recursive: true });
  await writeFile(outside, "outside secret", "utf8");
  await symlink(outside, join(workspace, "link.txt"), "file");

  const tools = runtime(workspace);
  const result = await tools.execute("read_file", { path: "link.txt" });

  assert.equal(result.ok, false);
  assert.match(result.error, /symbolic links/i);
});

test("write_file rejects existing symlinks instead of overwriting their targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "deecoo-runtime-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace, { recursive: true });
  await writeFile(outside, "outside original", "utf8");
  await symlink(outside, join(workspace, "link.txt"), "file");

  const tools = runtime(workspace);
  const result = await tools.execute("write_file", { path: "link.txt", content: "changed" });

  assert.equal(result.ok, false);
  assert.match(result.error, /symbolic links/i);
  assert.equal(await readFile(outside, "utf8"), "outside original");
});

test("write_file validates expected content before overwriting", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-runtime-"));
  await writeFile(join(workspace, "target.txt"), "original\n", "utf8");
  const tools = runtime(workspace);

  const stale = await tools.execute("write_file", {
    path: "target.txt",
    content: "changed\n",
    expectedContent: "stale\n",
  });
  const updated = await tools.execute("write_file", {
    path: "target.txt",
    content: "changed\n",
    expectedContent: "original\n",
  });

  assert.equal(stale.ok, false);
  assert.equal(stale.code, "WRITE_EXPECTATION_MISMATCH");
  assert.equal(updated.ok, true);
  assert.equal(await readFile(join(workspace, "target.txt"), "utf8"), "changed\n");
});

test("write_file validates expected SHA-256 before prompting", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-runtime-"));
  await writeFile(join(workspace, "target.txt"), "original\n", "utf8");
  let prompted = false;
  const tools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      prompted = true;
      return "approve";
    },
    permissionMode: "ask-every-edit",
  });

  const result = await tools.execute("write_file", {
    path: "target.txt",
    content: "changed\n",
    expectedSha256: sha256Hex("stale\n"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "WRITE_EXPECTATION_MISMATCH");
  assert.equal(prompted, false);
  assert.equal(await readFile(join(workspace, "target.txt"), "utf8"), "original\n");
});

test("edit_file revalidates unique search after approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-runtime-"));
  const target = join(workspace, "target.txt");
  await writeFile(target, "original\n", "utf8");
  const tools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      await writeFile(target, "changed\n", "utf8");
      return "approve";
    },
    permissionMode: "ask-every-edit",
  });

  const result = await tools.execute("edit_file", {
    path: "target.txt",
    search: "original",
    replace: "updated",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "FILE_CHANGED_BEFORE_WRITE");
  assert.equal(await readFile(target, "utf8"), "changed\n");
});

test("write_file revalidates expected content after approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-runtime-"));
  const target = join(workspace, "target.txt");
  await writeFile(target, "original\n", "utf8");
  const tools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      await writeFile(target, "changed\n", "utf8");
      return "approve";
    },
    permissionMode: "ask-every-edit",
  });

  const result = await tools.execute("write_file", {
    path: "target.txt",
    content: "updated\n",
    expectedContent: "original\n",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "WRITE_EXPECTATION_MISMATCH");
  assert.equal(await readFile(target, "utf8"), "changed\n");
});

test("write_file rejects unguarded overwrite when file changes after approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-runtime-"));
  const target = join(workspace, "target.txt");
  await writeFile(target, "original\n", "utf8");
  const tools = createToolRuntime({
    cwd: workspace,
    prompter: async () => {
      await writeFile(target, "changed\n", "utf8");
      return "approve";
    },
    permissionMode: "ask-every-edit",
  });

  const result = await tools.execute("write_file", {
    path: "target.txt",
    content: "updated\n",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "FILE_CHANGED_BEFORE_WRITE");
  assert.equal(await readFile(target, "utf8"), "changed\n");
});

test("search_text rejects symlink directories that point outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "deecoo-runtime-"));
  const workspace = join(root, "workspace");
  const outsideDir = join(root, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "secret.txt"), "needle", "utf8");
  await symlink(outsideDir, join(workspace, "linked-dir"), "dir");

  const tools = runtime(workspace);
  const result = await tools.execute("search_text", { query: "needle", directory: "linked-dir" });

  assert.equal(result.ok, false);
  assert.match(result.error, /symbolic links/i);
});
