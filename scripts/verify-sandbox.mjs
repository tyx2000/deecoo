// A strict host gate: an unavailable OS backend is a failure here, not a skip.
import { spawnSync } from "node:child_process";
import { detectSandbox } from "../src/execution/sandbox.js";

const sandbox = detectSandbox();
if (!sandbox.available) {
  process.stderr.write(`Required host sandbox test cannot launch: ${sandbox.reason}\n`);
  process.exitCode = 1;
} else {
  const names = ["OS sandbox blocks script filesystem/network access"];
  const files = ["test/executionBackend.test.js"];
  if (process.platform === "darwin") {
    names.push("REVIEW-P0-5", "R2-P0-1 a sandboxed job");
    files.push("test/reviewFixes.test.js", "test/reviewRound2Fixes.test.js");
  }
  const result = spawnSync(process.execPath, ["--test", "--test-name-pattern", names.join("|"), ...files], {
    stdio: "inherit", env: { ...process.env, DEECOO_REQUIRE_SANDBOX_TESTS: "1" },
  });
  if (result.error) { process.stderr.write(result.error.message + "\n"); process.exitCode = 1; }
  else process.exitCode = result.status ?? 1;
}
