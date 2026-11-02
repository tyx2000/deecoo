import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyStructuredPatchSet } from "../src/tools/files.js";
import { createToolRuntime } from "../src/tools/runtime.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-edit-integrity-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, tools: createToolRuntime({ cwd, permissionMode: "workspace-write" }) };
}

async function interruptedPatch(t, action, interfere) {
  const { cwd } = await fixture(t);
  if (action === "move") await writeFile(join(cwd, "from.txt"), "MODEL");
  const controller = new AbortController();
  const cache = new Map([["result.txt:20000", {}]]), set = cache.set.bind(cache);
  let interrupted = false;
  cache.set = (key, value) => {
    set(key, value);
    if (!interrupted) {
      interrupted = true;
      interfere?.(cwd);
      controller.abort(new Error("cancel between patch plans"));
    }
    return cache;
  };
  const result = await applyStructuredPatchSet(cwd, () => realpath(cwd), { files: [
    action === "move" ? { action, from: "from.txt", path: "result.txt" } : { action, path: "result.txt", content: "MODEL" },
    { action: "create", path: "second.txt", content: "SECOND" },
  ] }, async () => true, { mode: "workspace-write", readCache: cache }, controller.signal);
  assert.equal(interrupted, true, "the test must reach the between-plan cancellation hook");
  assert.equal(result.ok, false);
  await assert.rejects(stat(join(cwd, "second.txt")), { code: "ENOENT" });
  return { cwd, result };
}

for (const action of ["create", "move"]) {
  test(`CUR-EDIT-001 ${action} rollback preserves concurrently edited content and reports partial recovery`, async (t) => {
    const { cwd, result } = await interruptedPatch(t, action, (cwd) => writeFileSync(join(cwd, "result.txt"), "USER EDIT"));
    assert.equal(result.rolledBack, false);
    assert.equal(result.code, "PATCH_SET_ROLLBACK_FAILED");
    assert.ok(result.uncertainPaths.includes("result.txt"));
    assert.ok(result.rollbackErrors.length > 0);
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "USER EDIT");
    if (action === "move") await assert.rejects(stat(join(cwd, "from.txt")), { code: "ENOENT" });
  });

  test(`CUR-EDIT-001 ${action} rollback refuses a replacement inode even with identical contents`, async (t) => {
    const { cwd, result } = await interruptedPatch(t, action, (cwd) => {
      renameSync(join(cwd, "result.txt"), join(cwd, "held-original.txt"));
      writeFileSync(join(cwd, "result.txt"), "MODEL");
    });
    assert.equal(result.rolledBack, false);
    assert.ok(result.uncertainPaths.includes("result.txt"));
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "MODEL");
    assert.equal(await readFile(join(cwd, "held-original.txt"), "utf8"), "MODEL");
  });

  test(`CUR-EDIT-001 unchanged ${action} rolls back normally on cancellation`, async (t) => {
    const { cwd, result } = await interruptedPatch(t, action);
    assert.equal(result.rolledBack, true, result.error);
    assert.equal(result.code, "PATCH_SET_WRITE_FAILED");
    assert.deepEqual(result.uncertainPaths, []);
    await assert.rejects(stat(join(cwd, "result.txt")), { code: "ENOENT" });
    if (action === "move") assert.equal(await readFile(join(cwd, "from.txt"), "utf8"), "MODEL");
  });
}

test("CUR-EDIT-001 move rollback does not replace a concurrently recreated source", async (t) => {
  const { cwd, result } = await interruptedPatch(t, "move", (cwd) => writeFileSync(join(cwd, "from.txt"), "NEW SOURCE"));
  assert.equal(result.rolledBack, false);
  assert.equal(await readFile(join(cwd, "from.txt"), "utf8"), "NEW SOURCE");
  assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "MODEL");
});

test("R2-P2-JSON unrelated numeric literals survive JSON-pointer edits without rounding", async (t) => {
  const { cwd, tools } = await fixture(t);
  await writeFile(join(cwd, "values.json"), '{"counter":9007199254740993,"negative":-9007199254740993,"decimal":0.10000000000000000000001,"huge":1e999,"tiny":1e-999,"zero":-0,"enabled":false,"items":[9007199254740995,2]}');
  const result = await tools.execute("apply_json_patch", { path: "values.json", operations: [
    { op: "set", pointer: "/enabled", value: true },
    { op: "set", pointer: "/items/1", value: 3 },
    { op: "append", pointer: "/items", value: "new" },
  ] });
  assert.equal(result.ok, true, result.error);
  const output = await readFile(join(cwd, "values.json"), "utf8");
  for (const literal of ["9007199254740993", "-9007199254740993", "0.10000000000000000000001", "1e999", "1e-999", "-0", "9007199254740995"]) assert.ok(output.includes(literal), literal);
  assert.equal(JSON.parse(output).enabled, true);
  assert.deepEqual(JSON.parse(output).items.slice(1), [3, "new"]);
});

test("R2-P2-JSON numeric preservation cannot collide with ordinary strings or operation values", async (t) => {
  const { cwd, tools } = await fixture(t);
  await writeFile(join(cwd, "values.json"), '{"counter":9007199254740993,"name":"__deecoo_json_number_0","escaped":"\\u005f_deecoo_raw_number_0","digits":"9007199254740993"}');
  const result = await tools.execute("apply_json_patch", { path: "values.json", operations: [
    { op: "set", pointer: "/new", value: "__deecoo_raw_number_0" },
    { op: "delete", pointer: "/name" },
  ] });
  assert.equal(result.ok, true, result.error);
  const output = await readFile(join(cwd, "values.json"), "utf8");
  assert.match(output, /"counter": 9007199254740993/);
  assert.equal(JSON.parse(output).escaped, "__deecoo_raw_number_0");
  assert.equal(JSON.parse(output).new, "__deecoo_raw_number_0");
  assert.equal(JSON.parse(output).digits, "9007199254740993");
  assert.equal(Object.hasOwn(JSON.parse(output), "name"), false);
});

test("R2-P2-JSON preserved numbers stay scalar and invalid JSON is not repaired implicitly", async (t) => {
  const { cwd, tools } = await fixture(t);
  for (const [source, pointer] of [['{"counter":9007199254740993}', "/counter/source"], ['{1:2}', "/enabled"]]) {
    await writeFile(join(cwd, "values.json"), source);
    const result = await tools.execute("apply_json_patch", { path: "values.json", operations: [{ op: "set", pointer, value: true }] });
    assert.equal(result.ok, false);
    assert.equal(await readFile(join(cwd, "values.json"), "utf8"), source);
  }
});

test("R2-P2-8 mixed EOL patch changes only the requested text", async (t) => {
  const { cwd, tools } = await fixture(t);
  await writeFile(join(cwd, "mixed.txt"), "one\r\ntwo\nthree\n");
  const result = await tools.execute("apply_patch", { path: "mixed.txt", hunks: [{ oldStart: 2, oldLines: ["two"], newLines: ["TWO"] }] });
  assert.equal(result.ok, true, result.error);
  assert.equal(await readFile(join(cwd, "mixed.txt"), "utf8"), "one\r\nTWO\nthree\n");
});

test("R2-P2-8 mixed EOL insertion/deletion preserve unaffected separators and no-final-newline", async (t) => {
  const { cwd, tools } = await fixture(t);
  for (const [newLines, expected] of [
    [["B", "B2"], "a\r\nB\nB2\nc\r\nd"],
    [[], "a\r\nc\r\nd"],
  ]) {
    await writeFile(join(cwd, "mixed.txt"), "a\r\nb\nc\r\nd");
    const result = await tools.execute("apply_patch", { path: "mixed.txt", hunks: [{ oldStart: 2, oldLines: ["b"], newLines }] });
    assert.equal(result.ok, true, result.error);
    assert.equal(await readFile(join(cwd, "mixed.txt"), "utf8"), expected);
  }
});

test("R2-P2-8 patch-set and pure EOL files retain their established newline behavior", async (t) => {
  const { cwd, tools } = await fixture(t);
  for (const eol of ["\n", "\r\n"]) {
    for (const trailing of [false, true]) {
      await writeFile(join(cwd, "pure.txt"), "a" + eol + "b" + (trailing ? eol : ""));
      const result = await tools.execute("apply_patch_set", { files: [{ path: "pure.txt", hunks: [{ oldStart: 2, oldLines: ["b"], newLines: ["B"] }] }] });
      assert.equal(result.ok, true, result.error);
      assert.equal(await readFile(join(cwd, "pure.txt"), "utf8"), "a" + eol + "B" + (trailing ? eol : ""));
    }
  }
});
