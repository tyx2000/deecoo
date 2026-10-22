import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { taskExitCode } from "../src/cli/exitStatus.js";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/deecoo.js");

async function runFixture(mode, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-cli-exit-"));
  try {
    const preloader = join(directory, "fetch.mjs");
    await writeFile(preloader, [
      "globalThis.fetch = async (_url, init) => {",
      mode === "failure" ? "throw new Error('synthetic-provider-unavailable');" :
      mode === "timeout" ? "await new Promise((_, reject) => { if(init.signal.aborted) reject(init.signal.reason); else init.signal.addEventListener('abort', () => reject(init.signal.reason), {once:true}); });" :
      "return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'The fixture contains no package manifest.'}}],usage:{total_tokens:1}}),{status:200});",
      "};",
    ].join("\n"));
    return spawnSync(process.execPath, ["--import", preloader, cliPath, "--cwd", directory,
      "--settings", join(directory, "settings.json"), "explain the project"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        DEECOO_HOME: join(directory, "home"),
        DEEPSEEK_API_KEY: "synthetic-provider-key",
        DEECOO_STREAM: "false",
        DEECOO_API_RETRIES: "1",
        ...overrides,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("SCOR-004 actual single-task CLI returns failure after a provider error", async () => {
  const result = await runFixture("failure");
  assert.match(result.stderr, /synthetic-provider-unavailable/);
  assert.equal(result.status, 1);
});

test("SCOR-004 actual single-task CLI succeeds with a completed task", async () => {
  const result = await runFixture("success");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Version\s*:\s*\d+\.\d+\.\d+/);
});

test("SCOR-004 actual single-task CLI returns a distinct timeout status", async () => {
  const result = await runFixture("timeout", { DEECOO_TASK_TIMEOUT_MS: "100" });
  assert.equal(result.status, 124, result.stderr + result.stdout);
});

test("SCOR-004 CLI maps unsuccessful terminal states to nonzero exit codes", () => {
  assert.equal(taskExitCode({ status: "interrupted" }), 130);
  assert.equal(taskExitCode({ status: "failed", stoppedReason: "token_budget_exceeded" }), 1);
  assert.equal(taskExitCode({ status: "failed", stoppedReason: "task_contract_invalid" }), 1);
  assert.equal(taskExitCode(undefined), 1);
});
