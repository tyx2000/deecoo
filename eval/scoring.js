const DEFAULT_WEIGHTS = {
  completion: 25,
  requestType: 10,
  requiredTools: 15,
  disallowedTools: 15,
  verification: 20,
  output: 10,
  toolErrors: 5,
};

const PASSING_SCORE = 80;

export function scoreEvalCase(caseDefinition, run) {
  const normalizedRun = normalizeEvalRun(run);
  const expected = caseDefinition.expected ?? {};
  const weights = { ...DEFAULT_WEIGHTS, ...(caseDefinition.weights ?? {}) };
  const checks = [
    scoreCompletion(normalizedRun, weights.completion),
    scoreRequestType(expected, normalizedRun, weights.requestType),
    scoreRequiredTools(expected, normalizedRun, weights.requiredTools),
    scoreDisallowedTools(expected, normalizedRun, weights.disallowedTools),
    scoreVerification(expected, normalizedRun, weights.verification),
    scoreOutput(expected, normalizedRun, weights.output),
    scoreToolErrors(expected, normalizedRun, weights.toolErrors),
  ].filter((check) => check.weight > 0);

  const score = Math.round(checks.reduce((sum, check) => sum + check.score, 0));
  const maxScore = checks.reduce((sum, check) => sum + check.weight, 0);
  const normalizedScore = maxScore ? Math.round((score / maxScore) * 100) : 0;

  return {
    caseId: caseDefinition.id,
    title: caseDefinition.title,
    category: caseDefinition.category,
    score: normalizedScore,
    passed: normalizedScore >= (caseDefinition.passingScore ?? PASSING_SCORE) && checks.every((check) => !check.required || check.passed),
    checks,
    summary: {
      workflowStatus: normalizedRun.workflow?.status ?? "unknown",
      verificationStatus: normalizedRun.verification?.status ?? "not-run",
      requestType: normalizedRun.requestType ?? "unknown",
      steps: normalizedRun.steps ?? normalizedRun.trace?.length ?? 0,
      toolCalls: toolCalls(normalizedRun).length,
      totalTokens: normalizedRun.usage?.totalTokens ?? normalizedRun.usage?.total_tokens ?? 0,
    },
  };
}

export function normalizeEvalRun(run) {
  if (!run || typeof run !== "object") return {};
  return {
    ...run,
    finalText: run.finalText ?? run.output ?? latestAssistantText(run.messages),
    trace: Array.isArray(run.trace) ? run.trace : [],
    verification: run.verification ?? { status: "not-run", commands: [] },
    workflow: run.workflow ?? { status: "unknown" },
  };
}

export function summarizeEvalResults(results) {
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const averageScore = total ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / total) : 0;
  const failedRequiredChecks = results.flatMap((result) =>
    result.checks
      .filter((check) => check.required && !check.passed)
      .map((check) => ({ caseId: result.caseId, check: check.name, detail: check.detail })),
  );

  return {
    total,
    passed,
    failed: total - passed,
    averageScore,
    failedRequiredChecks,
  };
}

function latestAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.tool_calls?.length) continue;
    if (typeof message.content === "string" && message.content.trim()) return message.content;
  }
  return "";
}

function scoreCompletion(run, weight) {
  const workflowCompleted = run?.workflow?.status === "completed";
  const finalText = String(run?.finalText ?? run?.output ?? "").trim();
  const passed = workflowCompleted && finalText.length > 0;
  return checkResult({
    name: "completion",
    passed,
    required: true,
    weight,
    detail: passed ? "workflow completed with final output" : "workflow did not complete with final output",
  });
}

function scoreRequestType(expected, run, weight) {
  if (!expected.requestType) return skippedCheck("requestType", weight);
  const passed = run?.requestType === expected.requestType;
  return checkResult({
    name: "requestType",
    passed,
    required: true,
    weight,
    detail: passed ? expected.requestType : `expected ${expected.requestType}, got ${run?.requestType ?? "unknown"}`,
  });
}

function scoreRequiredTools(expected, run, weight) {
  const requiredTools = expected.mustUseTools ?? [];
  if (!requiredTools.length) return skippedCheck("requiredTools", weight);
  const used = new Set(toolCalls(run).map((call) => call.tool));
  const missing = requiredTools.filter((tool) => !used.has(tool));
  return checkResult({
    name: "requiredTools",
    passed: missing.length === 0,
    required: true,
    weight,
    detail: missing.length ? "missing: " + missing.join(", ") : "used: " + requiredTools.join(", "),
  });
}

function scoreDisallowedTools(expected, run, weight) {
  const disallowedTools = expected.disallowTools ?? [];
  if (!disallowedTools.length) return skippedCheck("disallowedTools", weight);
  const used = new Set(toolCalls(run).map((call) => call.tool));
  const violations = disallowedTools.filter((tool) => used.has(tool));
  return checkResult({
    name: "disallowedTools",
    passed: violations.length === 0,
    required: true,
    weight,
    detail: violations.length ? "used disallowed: " + violations.join(", ") : "no disallowed tools used",
  });
}

function scoreVerification(expected, run, weight) {
  if (!expected.mustRunVerification) return skippedCheck("verification", weight);
  const commands = run?.verification?.commands ?? [];
  const status = run?.verification?.status ?? "not-run";
  const accepted = new Set(["passed", "failed-then-passed"]);
  const passed = commands.length > 0 && accepted.has(status);
  return checkResult({
    name: "verification",
    passed,
    required: true,
    weight,
    detail: passed ? `${status}, ${commands.length} command(s)` : `status ${status}, ${commands.length} command(s)`,
  });
}

function scoreOutput(expected, run, weight) {
  const requiredMentions = expected.finalMustMention ?? [];
  if (!requiredMentions.length) return skippedCheck("output", weight);
  const text = String(run?.finalText ?? run?.output ?? "").toLowerCase();
  const missing = requiredMentions.filter((item) => !text.includes(String(item).toLowerCase()));
  return checkResult({
    name: "output",
    passed: missing.length === 0,
    required: false,
    weight,
    detail: missing.length ? "missing mentions: " + missing.join(", ") : "required mentions present",
  });
}

function scoreToolErrors(expected, run, weight) {
  const allowedFailureCodes = new Set(expected.allowedToolFailureCodes ?? []);
  const allowedFailedTools = new Set(expected.allowedFailedTools ?? []);
  const failed = toolCalls(run).filter((call) => call.ok === false && !allowedFailureCodes.has(call.code) && !allowedFailedTools.has(call.tool));
  return checkResult({
    name: "toolErrors",
    passed: failed.length === 0,
    required: false,
    weight,
    detail: failed.length ? `${failed.length} failed tool call(s)` : "no failed tool calls",
  });
}

function toolCalls(run) {
  return (run?.trace ?? []).map((entry) => ({
    tool: entry.tool ?? entry.name,
    ok: entry.ok ?? entry.result?.ok,
    code: entry.code ?? entry.result?.code,
    target: entry.target ?? entry.args?.path ?? entry.args?.command ?? "",
  }));
}

function skippedCheck(name, weight) {
  return {
    name,
    skipped: true,
    passed: true,
    required: false,
    weight: 0,
    score: 0,
    detail: "not configured",
    configuredWeight: weight,
  };
}

function checkResult({ name, passed, required, weight, detail }) {
  return {
    name,
    passed,
    required,
    weight,
    score: passed ? weight : 0,
    detail,
  };
}
