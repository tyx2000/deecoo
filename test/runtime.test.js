import assert from "node:assert/strict";
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
