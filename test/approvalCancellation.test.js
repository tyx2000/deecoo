import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolRuntime } from "../src/tools/runtime.js";
import { createPrompter } from "../src/cli/prompter.js";
import { readPromptLine, selectOption } from "../src/terminal/select.js";
import { applyStructuredPatchSet } from "../src/tools/files.js";

const hunks = [{ oldStart: 1, oldLines: ["alpha"], newLines: ["beta"] }];
const mutations = [
  ["write_file", { path: "target.txt", content: "beta\n" }],
  ["edit_file", { path: "target.txt", search: "alpha", replace: "beta" }],
  ["apply_patch", { path: "target.txt", hunks }],
  ["apply_patch_set", { files: [{ path: "target.txt", hunks }] }],
  ["apply_json_patch", { path: "target.json", operations: [{ op: "set", pointer: "/value", value: "beta" }] }],
];

for (const [name, args] of mutations) {
  test("SCOR-002: cancelled approval cannot authorize " + name, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "deecoo-approval-cancel-"));
    try {
      await writeFile(join(cwd, "target.txt"), "alpha\n");
      await writeFile(join(cwd, "target.json"), '{"value":"alpha"}\n');
      const controller = new AbortController();
      let completeApproval;
      let notifyApproval;
      const approvalStarted = new Promise((resolve) => { notifyApproval = resolve; });
      const tools = createToolRuntime({ cwd, permissionMode: "ask-once", prompter: () => {
        notifyApproval();
        return new Promise((resolve) => { completeApproval = resolve; });
      } });
      const pending = tools.execute(name, args, { signal: controller.signal });
      await Promise.race([approvalStarted, pending.then((result) => { throw new Error("approval was not reached: " + JSON.stringify(result)); })]);
      controller.abort(new Error("task deadline"));
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.code, "ABORT_ERR");
      completeApproval("always");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(tools.getPermissionMode(), "ask-once");
      assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "alpha\n");
      assert.equal(await readFile(join(cwd, "target.json"), "utf8"), '{"value":"alpha"}\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("SCOR-002: cancellation during create approval leaves no new file or directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-create-cancel-"));
  try {
    const controller = new AbortController();
    const tools = createToolRuntime({ cwd, prompter: async () => { controller.abort(); return "approve"; } });
    const result = await tools.execute("write_file", { path: "new-dir/result.txt", content: "data" }, { signal: controller.signal });
    assert.equal(result.ok, false);
    await assert.rejects(stat(join(cwd, "new-dir")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("SCOR-002: patch-set cancellation restores the already completed write", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-patch-cancel-"));
  try {
    await writeFile(join(cwd, "first.txt"), "alpha\n");
    await writeFile(join(cwd, "second.txt"), "alpha\n");
    const controller = new AbortController();
    const readCache = new Map([["first.txt:20000", {}]]);
    const set = readCache.set.bind(readCache);
    readCache.set = (key, value) => {
      const result = set(key, value);
      if (value.content === "beta\n") controller.abort(new Error("cancel between patch plans"));
      return result;
    };
    const result = await applyStructuredPatchSet(cwd, () => realpath(cwd), {
      files: [{ path: "first.txt", hunks }, { path: "second.txt", hunks }],
    }, async () => true, { mode: "workspace-write", readCache }, controller.signal);
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(result.filesRolledBack, ["first.txt"]);
    assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "alpha\n");
    assert.equal(await readFile(join(cwd, "second.txt"), "utf8"), "alpha\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("SCOR-002: non-TTY approval prompt is aborted rather than waiting for input", async () => {
  const controller = new AbortController();
  const pending = createPrompter(false)("synthetic approval", { kind: "file-write-approval", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("SCOR-002: TTY menus and line prompts restore raw state and release keypress listeners on abort", async () => {
  const saved = {
    inputTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    outputTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
    inputRaw: Object.getOwnPropertyDescriptor(process.stdin, "isRaw"),
    setRawMode: process.stdin.setRawMode,
    write: process.stdout.write,
  };
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdin, "isRaw", { configurable: true, writable: true, value: false });
  process.stdin.setRawMode = (value) => { process.stdin.isRaw = value; };
  process.stdout.write = () => true;
  try {
    for (const prompt of [
      (signal) => selectOption({ title: "synthetic", options: [{ label: "yes", value: true }], signal }),
      (signal) => readPromptLine("synthetic", [], { signal }),
    ]) {
      const before = process.stdin.listenerCount("keypress");
      const controller = new AbortController();
      const pending = prompt(controller.signal);
      assert.equal(process.stdin.isRaw, true);
      controller.abort();
      await pending;
      assert.equal(process.stdin.listenerCount("keypress"), before);
      assert.equal(process.stdin.isRaw, false);
    }
  } finally {
    process.stdin.pause();
    process.stdout.write = saved.write;
    if (saved.setRawMode === undefined) delete process.stdin.setRawMode;
    else process.stdin.setRawMode = saved.setRawMode;
    for (const [target, key, descriptor] of [
      [process.stdin, "isTTY", saved.inputTTY], [process.stdout, "isTTY", saved.outputTTY], [process.stdin, "isRaw", saved.inputRaw],
    ]) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    }
  }
});
