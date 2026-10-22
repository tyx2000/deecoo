import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolRuntime } from "../src/tools/runtime.js";

function runtime(cwd) {
  return createToolRuntime({ cwd, permissionMode: "read-only", prompter: async () => false });
}

test("search treats leading-hyphen patterns as patterns and empty matches return promptly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-search-contract-"));
  try {
    await writeFile(join(directory, "sample.txt"), "--files\n--no-ignore\n-needle\nnormal needle\n");
    const tools = runtime(directory);
    for (const query of ["--files", "--no-ignore", "-needle", "normal.*needle"]) {
      const result = await tools.execute("search_text", { query }, { signal: AbortSignal.timeout(2000) });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.matches.length, 1);
      assert.match(result.matches[0], /sample\.txt:\d+:/);
    }
    const empty = await tools.execute("search_text", { query: "not-present-at-all" }, { signal: AbortSignal.timeout(2000) });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.matches, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("search returns bounded successful results instead of overflowing the child buffer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-search-large-"));
  try {
    await writeFile(join(directory, "large.txt"), ("needle " + "x".repeat(100) + "\n").repeat(20000));
    const result = await runtime(directory).execute("search_text", { query: "needle", maxResults: 5 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.matches.length, 5);
    assert.equal(result.truncated, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("search cancellation ends an active child and preserves its abort error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-search-abort-"));
  const previousPath = process.env.PATH;
  try {
    const executable = join(directory, "rg");
    await writeFile(executable, "#!" + process.execPath + "\nsetInterval(() => {}, 1000);\n");
    await chmod(executable, 0o755);
    process.env.PATH = directory + ":" + previousPath;
    const result = await runtime(directory).execute("search_text", { query: "needle" }, { signal: AbortSignal.timeout(100) });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ABORT_ERR");
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("byte-limited search preserves valid UTF-8 and marks its partial last result truncated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-search-utf8-"));
  try {
    await writeFile(join(directory, "large.txt"), "needle " + "😀".repeat(400000) + "\n");
    const result = await runtime(directory).execute("search_text", { query: "needle" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.truncated, true);
    assert.equal(result.matches.length, 1);
    assert.ok(!result.matches[0].includes("\uFFFD"));
    assert.ok(Buffer.byteLength(result.matches[0]) <= 1024 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("search cancellation force-ends a child that ignores SIGTERM after its grace period", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-search-stubborn-"));
  const previousPath = process.env.PATH;
  try {
    const executable = join(directory, "rg");
    const ready = join(directory, "ready");
    await writeFile(executable, "#!" + process.execPath + "\n" +
      "process.on('SIGTERM', () => {});\n" +
      "require('node:fs').writeFileSync(" + JSON.stringify(ready) + ", 'ready');\n" +
      "setInterval(() => {}, 1000);\n");
    await chmod(executable, 0o755);
    process.env.PATH = directory + ":" + previousPath;
    const controller = new AbortController();
    const resultPromise = runtime(directory).execute("search_text", { query: "needle" }, { signal: controller.signal });
    let childReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await readFile(ready, "utf8").catch(() => "") === "ready") {
        childReady = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    const result = await resultPromise;
    assert.equal(childReady, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ABORT_ERR");
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
