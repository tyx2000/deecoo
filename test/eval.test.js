import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rankEvalCases } from "../eval/matching.js";
import { normalizeEvalRun, scoreEvalCase, summarizeEvalResults } from "../eval/scoring.js";
import { buildTraceEvalResultLines, buildTraceEvalSuggestionLines } from "../src/commands/evalTrace.js";

test("eval scoring passes a completed verified edit run", () => {
  const result = scoreEvalCase(
    {
      id: "case-1",
      title: "Verified edit",
      category: "implementation",
      expected: {
        requestType: "edit",
        mustUseTools: ["read_file", "edit_file", "run_shell"],
        disallowTools: ["agent"],
        mustRunVerification: true,
        finalMustMention: ["npm test"],
      },
    },
    {
      requestType: "edit",
      finalText: "Fixed and verified with npm test.",
      workflow: { status: "completed" },
      verification: { status: "passed", commands: [{ command: "npm test", ok: true }] },
      trace: [
        { tool: "read_file", ok: true },
        { tool: "edit_file", ok: true },
        { tool: "run_shell", ok: true },
      ],
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
});

test("eval scoring fails required checks when required tools are missing", () => {
  const result = scoreEvalCase(
    {
      id: "case-2",
      title: "Missing tool",
      category: "implementation",
      expected: {
        requestType: "edit",
        mustUseTools: ["edit_file"],
      },
    },
    {
      requestType: "edit",
      finalText: "Done.",
      workflow: { status: "completed" },
      trace: [{ tool: "read_file", ok: true }],
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.checks.find((check) => check.name === "requiredTools").required, true);
});

test("eval scoring ignores expected guardrail failures", () => {
  const result = scoreEvalCase(
    {
      id: "case-3",
      title: "Guardrail",
      category: "permission",
      expected: {
        requestType: "edit",
        mustUseTools: ["run_shell"],
        allowedToolFailureCodes: ["SHELL_COMMAND_BLOCKED"],
      },
    },
    {
      requestType: "edit",
      finalText: "Blocked by guardrails.",
      workflow: { status: "completed" },
      trace: [{ tool: "run_shell", ok: false, result: { ok: false, code: "SHELL_COMMAND_BLOCKED" } }],
    },
  );

  assert.equal(result.checks.find((check) => check.name === "toolErrors").passed, true);
});

test("eval summary reports pass counts and required failures", () => {
  const summary = summarizeEvalResults([
    { caseId: "a", passed: true, score: 100, checks: [] },
    {
      caseId: "b",
      passed: false,
      score: 60,
      checks: [{ name: "requiredTools", required: true, passed: false, detail: "missing: edit_file" }],
    },
  ]);

  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.averageScore, 80);
  assert.equal(summary.failedRequiredChecks.length, 1);
});

test("eval run normalization derives final text from audit messages", () => {
  const run = normalizeEvalRun({
    requestType: "edit",
    workflow: { status: "completed" },
    messages: [
      { role: "assistant", content: "", tool_calls: [{ id: "1" }] },
      { role: "tool", content: "{}" },
      { role: "assistant", content: "Fixed and verified." },
    ],
  });

  assert.equal(run.finalText, "Fixed and verified.");
  assert.deepEqual(run.trace, []);
  assert.equal(run.verification.status, "not-run");
});

test("eval matcher ranks permission and verification runs against the right case", () => {
  const cases = [
    {
      id: "permission-sensitive",
      title: "Permission",
      category: "permission",
      match: { requestType: "edit", tools: ["run_shell"], keywords: ["blocked"], verification: "not-run" },
    },
    {
      id: "verification-recovery",
      title: "Recovery",
      category: "verification",
      match: { requestType: "edit", tools: ["edit_file", "run_shell"], keywords: ["failed", "passed"], verification: "required" },
    },
  ];

  const permissionRank = rankEvalCases(cases, {
    requestType: "edit",
    finalText: "Blocked by guardrails.",
    verification: { status: "not-run", commands: [] },
    trace: [{ tool: "run_shell", code: "SHELL_COMMAND_BLOCKED" }],
  });
  const recoveryRank = rankEvalCases(cases, {
    requestType: "edit",
    finalText: "Failed first, fixed, passed after rerun.",
    verification: { status: "failed-then-passed", commands: [{}, {}] },
    trace: [{ tool: "run_shell" }, { tool: "edit_file" }, { tool: "run_shell" }],
  });

  assert.equal(permissionRank[0].caseId, "permission-sensitive");
  assert.equal(recoveryRank[0].caseId, "verification-recovery");
});

test("trace eval suggestions include ranked cases and runnable commands", async () => {
  const casesDir = await mkdtemp(join(tmpdir(), "deecoo-eval-cases-"));
  await writeFile(
    join(casesDir, "permission-sensitive.json"),
    JSON.stringify({
      id: "permission-sensitive",
      title: "Permission",
      category: "permission",
      match: { requestType: "edit", tools: ["run_shell"], keywords: ["blocked"], verification: "not-run" },
    }),
    "utf8",
  );
  await writeFile(
    join(casesDir, "small-bugfix.json"),
    JSON.stringify({
      id: "small-bugfix",
      title: "Bugfix",
      category: "implementation",
      match: { requestType: "edit", tools: ["edit_file", "run_shell"], verification: "required" },
    }),
    "utf8",
  );

  const lines = await buildTraceEvalSuggestionLines({
    casesDir,
    auditPath: "/tmp/deecoo audit/latest.json",
    audit: {
      requestType: "edit",
      finalText: "Blocked by guardrails.",
      verification: { status: "not-run", commands: [] },
      trace: [{ tool: "run_shell", code: "SHELL_COMMAND_BLOCKED" }],
    },
  });

  assert.match(lines.join("\n"), /permission-sensitive/);
  assert.match(lines.join("\n"), /npm run eval -- --case permission-sensitive --run '\/tmp\/deecoo audit\/latest\.json'/);
  assert.match(lines.join("\n"), /--auto-case/);
});

test("trace eval result scores the best matching case", async () => {
  const casesDir = await mkdtemp(join(tmpdir(), "deecoo-eval-result-cases-"));
  await writeFile(
    join(casesDir, "verification-recovery.json"),
    JSON.stringify({
      id: "verification-recovery",
      title: "Recovery",
      category: "verification",
      match: { requestType: "edit", tools: ["edit_file", "run_shell"], keywords: ["failed", "passed"], verification: "required" },
      expected: {
        requestType: "edit",
        mustUseTools: ["edit_file", "run_shell"],
        mustRunVerification: true,
        allowedFailedTools: ["run_shell"],
        finalMustMention: ["failed", "passed"],
      },
    }),
    "utf8",
  );

  const lines = await buildTraceEvalResultLines({
    casesDir,
    auditPath: "/tmp/audit.json",
    audit: {
      requestType: "edit",
      finalText: "Failed first, fixed, passed after rerun.",
      workflow: { status: "completed" },
      verification: { status: "failed-then-passed", commands: [{}, {}] },
      trace: [{ tool: "run_shell", ok: false }, { tool: "edit_file", ok: true }, { tool: "run_shell", ok: true }],
    },
  });

  assert.match(lines.join("\n"), /Eval: PASS verification-recovery 100/);
  assert.match(lines.join("\n"), /Matched: verification-recovery/);
});
