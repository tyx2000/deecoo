import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolRuntime } from "../src/tools/runtime.js";

test("SCOR-002 shell cancellation during approval persistence cannot start the command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-shell-cancel-"));
  const controller = new AbortController();
  try {
    await writeFile(join(directory, "source.txt"), "synthetic");
    const tools = createToolRuntime({
      cwd: directory,
      prompter: async () => "always",
      onApproveShellCommand: async () => { controller.abort(new Error("deadline during approval persistence")); },
    });
    const result = await tools.execute("run_shell", { command: "cp source.txt copied.txt" }, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ABORT_ERR");
    await assert.rejects(stat(join(directory, "copied.txt")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
