import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { executeEvalSuite } from "../eval/execution.js";

test("NEXT-006 diverse real harness scenarios enforce outcomes and justified rejection", async () => {
  const ids = ["cross-file-feature", "python-javascript-price", "review-true-positive", "review-clean", "already-correct-no-change", "wrong-requested-command", "missing-required-check", "dependency-failure", "permission-denied-change", "test-tampering-rejected", "pre-existing-failure", "interruption-resume"];
  const definitions = await Promise.all(ids.map(async (id) => JSON.parse(await readFile(new URL(`../eval/tasks/${id}.json`, import.meta.url), "utf8"))));
  const result = await executeEvalSuite(definitions);
  assert.equal(result.summary.failed, 0, JSON.stringify(result.summary.failedRequiredChecks));
  const get = (id) => result.results.find((item) => item.caseId === id).trials[0];
  assert.deepEqual(get("cross-file-feature").changedFiles, ["src/greet.js", "src/name.js"]);
  assert.equal(get("already-correct-no-change").diagnostics.acceptance.completionType, "no-change");
  assert.equal(get("dependency-failure").diagnostics.acceptance.completionType, "blocked");
  assert.equal(get("pre-existing-failure").diagnostics.verification.evidence.at(-1).failureOrigin, "pre-existing");
  assert.equal(get("interruption-resume").recovery.checkpointUsed, true);
  assert.equal(get("test-tampering-rejected").taskPassed, false);
  assert.equal(get("test-tampering-rejected").checks.find((item) => item.name === "command:independent-behavior").observedPassed, false);
});
