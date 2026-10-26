import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEffectLedger } from "../src/harness/effects.js";
import { createReviewFinalValidator, reviewCoverage } from "../src/reporter/reviewReport.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { runTask } from "../src/agent/taskRunner.js";
import { createSessionStore } from "../src/session/store.js";

const finalText = JSON.stringify({ schema_version: 1, review: { target: "a.js", base: "HEAD", project_context: "fixture", mode: "review", lanes: [] },
  findings: [], open_questions: [], test_gaps: [], residual_risks: [] });
const task = "完整审查 @a.js 的所有代码";
const checked = (effects, requested = task) => createReviewFinalValidator({ task: requested })({ finalText, attempt: 0, effects });

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "deecoo-review-coverage-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "a.js"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  const tools = createToolRuntime({ cwd, permissionMode: "read-only" });
  const effects = { revision: 0, events: [] };
  const read = async (args) => {
    const result = await tools.execute("read_file", { path: "a.js", ...args });
    assert.notEqual(result.ok, false, JSON.stringify(result));
    effects.events.push(...result.effects.events);
    effects.revision = result.workspaceRevision;
    return result;
  };
  return { cwd, tools, effects, read };
}

test("N-4: an explicit full-file review rejects truncated source, then recovers after a full read", async (t) => {
  const { read, effects } = await fixture(t);
  await read({ maxBytes: 20 });
  assert.equal(checked(effects).ok, false);
  assert.deepEqual(reviewCoverage({ task, effects }).incompleteFiles, ["a.js"]);
  await read({});
  assert.equal(checked(effects).ok, true);
  assert.deepEqual(reviewCoverage({ task, effects }).partialFiles, []);
});

test("N-4: complete same-version range reads jointly satisfy full requested coverage", async (t) => {
  const { read, effects } = await fixture(t);
  await read({ startLine: 2, endLine: 3 });
  assert.equal(checked(effects).ok, false);
  assert.equal(checked(effects, "Review only @a.js:2-3.").ok, true);
  const first = effects.events.at(-1);
  assert.equal(first.rangeComplete, true);
  assert.equal(first.totalLines, 3);
  assert.equal(first.startLine, 2);
  await read({ startLine: 1, endLine: 1 });
  assert.equal(checked(effects).ok, true);
});

test("N-4: range gaps, truncated lines and different file versions never establish full coverage", async (t) => {
  const { cwd, read, effects } = await fixture(t);
  await read({ startLine: 1, endLine: 1 });
  await read({ startLine: 3, endLine: 3 });
  assert.equal(checked(effects).ok, false, "missing the middle line");
  await read({ startLine: 2, endLine: 2, maxBytes: 8 });
  assert.equal(checked(effects).ok, false, "a cut-off line is not a complete range");
  await writeFile(join(cwd, "a.js"), "export const a = 4;\nexport const b = 5;\nexport const c = 6;\n");
  await read({ startLine: 2, endLine: 2 });
  assert.equal(checked(effects).ok, false, "old-version first and last lines cannot fill the new version");
  await read({});
  assert.equal(checked(effects).ok, true);
});

test("N-4: a later partial observation of the same complete version does not lose coverage", () => {
  const ledger = createEffectLedger();
  const complete = ledger.record("read_file", { path: "a.js" }, { content: "all", contentHash: "v1", sourceComplete: true }).effects.events;
  const partial = ledger.record("read_file", { path: "a.js" }, { content: "a", contentHash: "v1", sourceComplete: false }).effects.events;
  assert.equal(checked({ events: [...complete, ...partial] }).ok, true);
  const changed = ledger.record("read_file", { path: "a.js" }, { content: "b", contentHash: "v2", sourceComplete: false }).effects.events;
  assert.equal(checked({ events: [...complete, ...partial, ...changed] }).ok, false);
});

test("N-4: source evidence permits snippets, diff, YAML and JSON config without language allowlists", () => {
  for (const requested of [
    "Review this snippet:\n```arbitrary-language\nfunction(x) => x + 1\n```",
    "Review config:\n```yaml\ntimeout: 20\n```",
    "Review this config:\n```json\n{\"timeout\":20}\n```",
    "Review this diff:\n```diff\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n```",
  ]) assert.equal(checked(undefined, requested).ok, true, requested);
  for (const requested of [
    "Review project\n```text\nBuild failed yesterday\n```",
    "Review project\n```arbitrary\nBuild failed yesterday;\n```",
    "Review these logs:\n```console\nError: build failed;\n```",
    "Review project\n```\n\n```",
  ]) assert.equal(checked(undefined, requested).ok, false, requested);
  const effects = { events: [{ type: "diff-read", paths: ["a.js"] }] };
  assert.equal(checked(effects, "Review the diff in @a.js.").ok, true);
  assert.equal(checked(effects).ok, false, "a diff does not cover the entire file");
});

test("N-4: completeness words inside quoted source do not change a sampled review's scope", () => {
  const effects = { events: [{ type: "file-read", path: "a.js", truncated: true, contentHash: "v1" }] };
  assert.equal(checked(effects, "Review @a.js using this snippet:\n```js\nconst mode = 'full';\n```").ok, true);
});

test("N-4: passing review source coverage still cannot bypass explicit requiredChecks", async (t) => {
  const { cwd, tools } = await fixture(t);
  const sessionStore = await createSessionStore(cwd, { rootDir: join(cwd, "home"), privacyMode: "ephemeral" });
  const session = await sessionStore.createSession({ model: "synthetic" });
  let calls = 0;
  const result = await runTask({ cwd, tools, sessionStore, session, task,
    config: { model: "synthetic", quiet: true, stream: false, taskMode: "review", maxSteps: 5, requiredChecks: ["npm test"] },
    client: { async chatCompletion() {
      calls++;
      const message = calls === 1 ? { role: "assistant", tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }] }
        : { role: "assistant", content: finalText };
      return { choices: [{ message }], usage: { total_tokens: 1 } };
    } } });
  assert.notEqual(result.acceptance?.satisfied, true);
  assert.equal(result.acceptance?.checks[0]?.status, "missing");
  assert.notEqual(result.status, "completed");
});
