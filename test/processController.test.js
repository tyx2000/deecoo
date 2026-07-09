import assert from "node:assert/strict";
import { test } from "node:test";
import { compactLiveMessages } from "../src/agent/loop.js";
import { createAgentState, recordToolStep } from "../src/agent/state.js";
import {
  analyzeProcessQuality,
  buildWorkingSetSummary,
  createProcessController,
  evaluateToolCall,
  maybeBuildProcessNudge,
  recordToolObservation,
  snapshotProcessMetrics,
  toolSignature,
} from "../src/harness/processController.js";
import { scoreEvalCase } from "../eval/scoring.js";

test("tool signatures are stable for equivalent read args", () => {
  assert.equal(
    toolSignature("read_file", { path: "src/a.js", maxBytes: 1000 }),
    toolSignature("read_file", { maxBytes: 1000, path: "src/a.js" }),
  );
  assert.notEqual(
    toolSignature("read_file", { path: "src/a.js" }),
    toolSignature("read_file", { path: "src/b.js" }),
  );
});

test("process controller short-circuits duplicate successful reads", () => {
  const controller = createProcessController();
  const first = evaluateToolCall(controller, { name: "read_file", args: { path: "src/a.js" }, step: 1 });
  assert.equal(first.action, "allow");
  recordToolObservation(controller, {
    name: "read_file",
    args: { path: "src/a.js" },
    result: { ok: true, content: "const a = 1;\n" },
    step: 1,
  });

  const second = evaluateToolCall(controller, { name: "read_file", args: { path: "src/a.js" }, step: 2 });
  assert.equal(second.action, "short_circuit");
  assert.equal(second.result.code, "ALREADY_AVAILABLE");
  assert.equal(second.result.content, "const a = 1;\n");
  assert.equal(second.result.alreadyAvailable, true);

  recordToolObservation(controller, {
    name: "read_file",
    args: { path: "src/a.js" },
    result: second.result,
    step: 2,
  });
  assert.equal(snapshotProcessMetrics(controller).duplicatesBlocked, 1);
});

test("process controller blocks repeated identical failures", () => {
  const controller = createProcessController({ maxIdenticalFailures: 2 });
  for (const step of [1, 2]) {
    const decision = evaluateToolCall(controller, {
      name: "search_text",
      args: { query: "missingSymbol" },
      step,
    });
    assert.equal(decision.action, "allow");
    recordToolObservation(controller, {
      name: "search_text",
      args: { query: "missingSymbol" },
      result: { ok: false, error: "no matches", code: "NO_MATCH" },
      step,
    });
  }

  const blocked = evaluateToolCall(controller, {
    name: "search_text",
    args: { query: "missingSymbol" },
    step: 3,
  });
  assert.equal(blocked.action, "short_circuit");
  assert.equal(blocked.result.code, "DUPLICATE_FAILURE_LOOP");
  assert.equal(blocked.result.ok, false);
});

test("identical successful shell short-circuits when nothing changed between", () => {
  const controller = createProcessController();
  recordToolObservation(controller, {
    name: "run_shell",
    args: { command: "ls src" },
    result: { ok: true, stdout: "a.js\nb.js\n" },
    step: 1,
  });

  const second = evaluateToolCall(controller, { name: "run_shell", args: { command: "ls src" }, step: 2 });
  assert.equal(second.action, "short_circuit");
  assert.equal(second.result.code, "ALREADY_AVAILABLE");
  assert.equal(second.result.stdout, "a.js\nb.js\n");
});

test("re-running a verification command after an edit is not short-circuited as a duplicate", () => {
  const controller = createProcessController();
  recordToolObservation(controller, {
    name: "run_shell",
    args: { command: "npm test" },
    result: { ok: true, stdout: "1 passing\n" },
    step: 1,
  });
  recordToolObservation(controller, {
    name: "edit_file",
    args: { path: "src/a.js", search: "old", replace: "new" },
    result: { ok: true, activity: { target: "src/a.js" } },
    step: 2,
  });

  const rerun = evaluateToolCall(controller, { name: "run_shell", args: { command: "npm test" }, step: 3 });
  assert.equal(rerun.action, "allow");
});

test("a repeated failing search is allowed again after an intervening mutation", () => {
  const controller = createProcessController({ maxIdenticalFailures: 2 });
  for (const step of [1, 2]) {
    recordToolObservation(controller, {
      name: "search_text",
      args: { query: "makeThing" },
      result: { ok: false, error: "no matches", code: "NO_MATCH" },
      step,
    });
  }
  recordToolObservation(controller, {
    name: "write_file",
    args: { path: "src/thing.js", content: "export function makeThing() {}" },
    result: { ok: true, activity: { target: "src/thing.js" } },
    step: 3,
  });

  const decision = evaluateToolCall(controller, { name: "search_text", args: { query: "makeThing" }, step: 4 });
  assert.equal(decision.action, "allow");
});

test("re-reading a fully-captured file under a different byte range reuses the prior read", () => {
  const controller = createProcessController();
  recordToolObservation(controller, {
    name: "read_file",
    args: { path: "src/a.js", maxBytes: 5000 },
    result: { ok: true, content: "export const a = 1;\n", truncated: false },
    step: 1,
  });

  const reused = evaluateToolCall(controller, { name: "read_file", args: { path: "src/a.js", maxBytes: 2000 }, step: 2 });
  assert.equal(reused.action, "short_circuit");
  assert.equal(reused.result.reason, "file_already_captured");
  assert.equal(reused.result.content, "export const a = 1;\n");
});

test("re-reading a previously truncated file with a larger range is allowed", () => {
  const controller = createProcessController({ maxPinnedFileChars: 10 });
  recordToolObservation(controller, {
    name: "read_file",
    args: { path: "src/big.js", maxBytes: 10 },
    result: { ok: true, content: "0123456789ABCDEF", truncated: true },
    step: 1,
  });

  const decision = evaluateToolCall(controller, { name: "read_file", args: { path: "src/big.js", maxBytes: 5000 }, step: 2 });
  assert.equal(decision.action, "allow");
});

test("successful edit invalidates prior read observation for that path", () => {
  const controller = createProcessController();
  recordToolObservation(controller, {
    name: "read_file",
    args: { path: "src/a.js" },
    result: { ok: true, content: "old" },
    step: 1,
  });
  recordToolObservation(controller, {
    name: "edit_file",
    args: { path: "src/a.js", search: "old", replace: "new" },
    result: { ok: true, activity: { target: "src/a.js" } },
    step: 2,
  });

  const decision = evaluateToolCall(controller, { name: "read_file", args: { path: "src/a.js" }, step: 3 });
  assert.equal(decision.action, "allow");
});

test("process controller nudges after inspection-only thrash", () => {
  const controller = createProcessController({ thrashInspectionStreak: 4, thrashNudgeCooldownSteps: 0 });
  for (const [step, path] of [
    [1, "a.js"],
    [2, "b.js"],
    [3, "c.js"],
    [4, "d.js"],
  ]) {
    recordToolObservation(controller, {
      name: "read_file",
      args: { path },
      result: { ok: true, content: `// ${path}` },
      step,
    });
  }

  const nudge = maybeBuildProcessNudge(controller, { step: 4 });
  assert.ok(nudge);
  assert.match(nudge.content, /Process guard/);
  assert.match(nudge.content, /consecutive inspection-only/);
  assert.equal(snapshotProcessMetrics(controller).thrashNudges, 1);
});

test("working-set summary pins file content for compaction reuse", () => {
  const controller = createProcessController();
  recordToolObservation(controller, {
    name: "read_file",
    args: { path: "src/a.js" },
    result: { ok: true, content: "export function a() { return 1; }\n" },
    step: 1,
  });
  recordToolObservation(controller, {
    name: "search_text",
    args: { query: "export function a", directory: "src" },
    result: { ok: true, matches: ["src/a.js:1:export function a"] },
    step: 2,
  });

  const summary = buildWorkingSetSummary(controller);
  assert.match(summary, /src\/a\.js/);
  assert.match(summary, /export function a/);
  assert.match(summary, /recent searches/);
  assert.match(summary, /Do not repeat/);
});

test("live compaction includes pinned working set", () => {
  const state = createAgentState({ task: "fix tests", cwd: "/tmp/project" });
  const controller = createProcessController();
  recordToolStep(state, {
    step: 1,
    name: "read_file",
    args: { path: "src/a.js" },
    result: { ok: true, content: "const value = 42;\n" },
    startedAt: 1000,
    endedAt: 1010,
  });
  recordToolObservation(controller, {
    name: "read_file",
    args: { path: "src/a.js" },
    result: { ok: true, content: "const value = 42;\n" },
    step: 1,
  });

  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "fix tests" },
    { role: "assistant", content: "x".repeat(300) },
    { role: "tool", content: "y".repeat(300) },
  ];
  const compacted = compactLiveMessages(messages, {
    protectedPrefixCount: 2,
    agentState: state,
    processController: controller,
    step: 2,
    maxChars: 100,
  });

  assert.equal(compacted, true);
  assert.match(messages[2].content, /Run state summary/);
  assert.match(messages[2].content, /Working-set observations/);
  assert.match(messages[2].content, /const value = 42/);
  assert.ok(state.process);
});

test("process quality analysis and eval scoring measure efficiency", () => {
  const thrashy = analyzeProcessQuality({
    trace: [
      { tool: "list_files", target: ".", ok: true },
      { tool: "list_files", target: ".", ok: true },
      { tool: "read_file", target: "a.js", ok: true },
      { tool: "read_file", target: "a.js", ok: true },
      { tool: "read_file", target: "a.js", ok: true },
      { tool: "search_text", target: "foo", ok: true },
    ],
  });
  assert.ok(thrashy.duplicateRate > 0.3);
  assert.ok(thrashy.inspectionStreakMax >= 4);
  assert.ok(thrashy.efficiency < 0.8);

  const clean = scoreEvalCase(
    {
      id: "clean",
      title: "Clean",
      category: "implementation",
      expected: {
        requestType: "edit",
        mustUseTools: ["read_file", "edit_file"],
      },
    },
    {
      requestType: "edit",
      finalText: "Done.",
      workflow: { status: "completed" },
      trace: [
        { tool: "read_file", target: "a.js", ok: true },
        { tool: "edit_file", target: "a.js", ok: true },
      ],
    },
  );
  assert.equal(clean.passed, true);
  assert.equal(clean.checks.find((check) => check.name === "processEfficiency").passed, true);

  const wasteful = scoreEvalCase(
    {
      id: "wasteful",
      title: "Wasteful",
      category: "implementation",
      expected: {
        requestType: "edit",
        maxDuplicateRate: 0.1,
        maxInspectionStreak: 2,
        minProcessEfficiency: 0.9,
      },
    },
    {
      requestType: "edit",
      finalText: "Done.",
      workflow: { status: "completed" },
      trace: [
        { tool: "read_file", target: "a.js", ok: true },
        { tool: "read_file", target: "a.js", ok: true },
        { tool: "read_file", target: "a.js", ok: true },
        { tool: "list_files", target: ".", ok: true },
        { tool: "list_files", target: ".", ok: true },
      ],
    },
  );
  assert.equal(wasteful.checks.find((check) => check.name === "processEfficiency").passed, false);
});
