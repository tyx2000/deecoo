import { normalizeEvalRun } from "./scoring.js";

const REQUEST_TYPE_WEIGHT = 35;
const TOOL_WEIGHT = 8;
const VERIFICATION_WEIGHT = 15;
const KEYWORD_WEIGHT = 6;
const CATEGORY_WEIGHT = 8;

export function rankEvalCases(cases, run) {
  const normalizedRun = normalizeEvalRun(run);
  return cases
    .map((caseDefinition) => matchEvalCase(caseDefinition, normalizedRun))
    .sort((a, b) => b.score - a.score || a.caseId.localeCompare(b.caseId));
}

export function matchEvalCase(caseDefinition, run) {
  const expected = caseDefinition.expected ?? {};
  const match = caseDefinition.match ?? {};
  const runText = searchableRunText(run);
  const usedTools = new Set((run.trace ?? []).map((entry) => entry.tool ?? entry.name).filter(Boolean));
  const reasons = [];
  let score = 0;

  const expectedRequestType = match.requestType ?? expected.requestType;
  if (expectedRequestType && run.requestType === expectedRequestType) {
    score += REQUEST_TYPE_WEIGHT;
    reasons.push("requestType:" + expectedRequestType);
  }

  const categoryHint = categoryMatches(caseDefinition.category, run);
  if (categoryHint) {
    score += CATEGORY_WEIGHT;
    reasons.push(categoryHint);
  }

  const toolHints = match.tools ?? expected.mustUseTools ?? [];
  for (const tool of toolHints) {
    if (!usedTools.has(tool)) continue;
    score += TOOL_WEIGHT;
    reasons.push("tool:" + tool);
  }

  const verificationHint = match.verification ?? (expected.mustRunVerification ? "required" : "");
  if (verificationHint === "required" && verificationPassedOrRecovered(run)) {
    score += VERIFICATION_WEIGHT;
    reasons.push("verification:run");
  } else if (verificationHint === "not-run" && (run.verification?.commands?.length ?? 0) === 0) {
    score += VERIFICATION_WEIGHT;
    reasons.push("verification:not-run");
  }

  for (const keyword of match.keywords ?? []) {
    if (!runText.includes(String(keyword).toLowerCase())) continue;
    score += KEYWORD_WEIGHT;
    reasons.push("keyword:" + keyword);
  }

  return {
    caseId: caseDefinition.id,
    title: caseDefinition.title,
    category: caseDefinition.category,
    score,
    reasons,
  };
}

function categoryMatches(category, run) {
  if (category === "review" && run.requestType === "review") return "category:review";
  if (category === "permission" && hasBlockedGuardrail(run)) return "category:permission";
  if (category === "verification" && run.verification?.status === "failed-then-passed") return "category:verification";
  if (category === "implementation" && run.requestType === "edit" && !hasBlockedGuardrail(run) && run.verification?.status !== "failed-then-passed") {
    return "category:implementation";
  }
  return "";
}

function verificationPassedOrRecovered(run) {
  return run.verification?.status === "passed" || run.verification?.status === "failed-then-passed";
}

function hasBlockedGuardrail(run) {
  return (run.trace ?? []).some((entry) => (entry.code ?? entry.result?.code) === "SHELL_COMMAND_BLOCKED");
}

function searchableRunText(run) {
  return [
    run.task,
    run.finalText,
    run.requestType,
    run.verification?.status,
    ...(run.trace ?? []).flatMap((entry) => [entry.tool, entry.name, entry.target, entry.error, entry.code, entry.result?.code]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
