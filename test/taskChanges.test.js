import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChangeSet, lineHunks } from "../src/workspace/changes.js";

async function fixture(fn) { const cwd = await mkdtemp(join(tmpdir(), "deecoo-changes-")); try { await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); } }

test("task undo restores the user's dirty baseline instead of Git HEAD", async () => fixture(async (cwd) => {
  await writeFile(join(cwd, "a.js"), "user-dirty\n");
  const changes = await createChangeSet({ cwd }); await changes.begin();
  await writeFile(join(cwd, "a.js"), "agent-change\n"); await changes.capture();
  assert.match((await changes.exportPatch()).patch, /user-dirty/);
  assert.equal((await changes.decide({ action: "undo" })).ok, true);
  assert.equal(await readFile(join(cwd, "a.js"), "utf8"), "user-dirty\n");
  assert.equal((await changes.inspect()).files.length, 0);
}));

test("undo preserves non-overlapping later edits and refuses overlapping edits", async () => fixture(async (cwd) => {
  const original = "old\n1\n2\n3\n4\n5\ntail\n";
  await writeFile(join(cwd, "a.js"), original);
  const changes = await createChangeSet({ cwd }); await changes.begin();
  await writeFile(join(cwd, "a.js"), original.replace("old", "new")); await changes.capture();
  await writeFile(join(cwd, "a.js"), original.replace("old", "new").replace("tail", "user-tail"));
  assert.equal((await changes.decide({ action: "undo" })).ok, true);
  assert.equal(await readFile(join(cwd, "a.js"), "utf8"), original.replace("tail", "user-tail"));
  const second = await createChangeSet({ cwd }); await second.begin();
  await writeFile(join(cwd, "a.js"), original.replace("old", "agent")); await second.capture();
  await writeFile(join(cwd, "a.js"), original.replace("old", "user"));
  assert.equal((await second.decide({ action: "undo" })).ok, false);
  assert.match(await readFile(join(cwd, "a.js"), "utf8"), /^user/);
}));

test("independent hunks can be accepted and undone with stable stale-ID protection", async () => fixture(async (cwd) => {
  const before = "one\na\nb\nc\nd\ne\nf\ntwo\n";
  await writeFile(join(cwd, "a.js"), before);
  const changes = await createChangeSet({ cwd }); await changes.begin();
  await writeFile(join(cwd, "a.js"), before.replace("one", "ONE").replace("two", "TWO")); await changes.capture();
  const [a, b] = (await changes.inspect()).files[0].hunks;
  assert.ok(a && b);
  assert.equal((await changes.decide({ action: "accept", path: "a.js", hunkIds: [a.id] })).ok, true);
  const remaining = (await changes.inspect()).files[0].hunks;
  assert.equal(remaining.length, 1);
  assert.equal((await changes.decide({ action: "undo", path: "a.js", hunkIds: [a.id] })).ok, false);
  assert.equal((await changes.decide({ action: "undo", path: "a.js", hunkIds: [remaining[0].id] })).ok, true);
  assert.equal(await readFile(join(cwd, "a.js"), "utf8"), before.replace("one", "ONE"));
}));

test("persisted changes reopen and created/deleted text files restore safely", async () => fixture(async (cwd) => {
  await writeFile(join(cwd, "deleted.txt"), "keep\n");
  const changes = await createChangeSet({ cwd }); await changes.begin();
  await rm(join(cwd, "deleted.txt")); await writeFile(join(cwd, "new.txt"), "new\n"); await changes.capture();
  const reopened = await createChangeSet({ cwd, id: changes.id });
  assert.equal((await reopened.inspect()).files.length, 2);
  assert.equal((await reopened.decide({ action: "undo" })).ok, true);
  assert.equal(await readFile(join(cwd, "deleted.txt"), "utf8"), "keep\n");
  await assert.rejects(readFile(join(cwd, "new.txt")), { code: "ENOENT" });
}));

test("line hunks retain CRLF and empty-file behavior", () => {
  assert.equal(lineHunks("a\r\n", "b\r\n")[0].before, "a\r\n");
  assert.deepEqual(lineHunks("", ""), []);
});

test("internal state symlinks cannot redirect change snapshots outside workspace", async () => fixture(async (cwd) => {
  const outside = await mkdtemp(join(tmpdir(), "deecoo-change-outside-"));
  try { await symlink(outside, join(cwd, ".deecoo")); await assert.rejects(createChangeSet({ cwd }), /symlink|symbolic|outside/i); }
  finally { await rm(outside, { recursive: true, force: true }); }
}));
