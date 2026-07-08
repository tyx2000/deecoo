import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rankEvalCases } from "../../eval/matching.js";
import { scoreEvalCase } from "../../eval/scoring.js";

const DEFAULT_EVAL_CASES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "eval", "cases");

export async function buildTraceEvalSuggestionLines({ audit, auditPath, casesDir = DEFAULT_EVAL_CASES_DIR, limit = 3 }) {
  const cases = await loadEvalCases(casesDir);
  const suggestions = rankEvalCases(cases, audit).slice(0, limit);
  if (!suggestions.length || suggestions[0].score <= 0) return [];

  const quotedAuditPath = quoteShellArg(auditPath);
  return [
    "eval suggestions:",
    ...suggestions.map((suggestion) => "  - " + suggestion.caseId + " " + suggestion.score + " " + suggestion.title),
    "eval command: npm run eval -- --case " + suggestions[0].caseId + " --run " + quotedAuditPath,
    "auto-case: npm run eval -- --run " + quotedAuditPath + " --auto-case",
  ];
}

export async function buildTraceEvalResultLines({ audit, auditPath, casesDir = DEFAULT_EVAL_CASES_DIR, minMatchScore = 40 }) {
  const cases = await loadEvalCases(casesDir);
  const suggestions = rankEvalCases(cases, audit);
  const best = suggestions[0];
  if (!best || best.score < minMatchScore) {
    return [
      "No eval case matched the latest trace above score " + minMatchScore + ".",
      "Use /trace to inspect the audit and add a more specific eval case if needed.",
    ];
  }

  const caseDefinition = cases.find((item) => item.id === best.caseId);
  const result = scoreEvalCase(caseDefinition, audit);
  return [
    "Eval: " + (result.passed ? "PASS" : "FAIL") + " " + result.caseId + " " + result.score + " - " + result.title,
    "Matched: " + best.caseId + " " + best.score + (best.reasons.length ? " (" + best.reasons.join(", ") + ")" : ""),
    "Audit: " + auditPath,
    "Checks:",
    ...result.checks.map((check) => "  - " + check.name + " " + (check.passed ? "pass" : "fail") + " " + check.detail),
  ];
}

async function loadEvalCases(casesDir) {
  const entries = await readdir(casesDir);
  const cases = [];
  for (const entry of entries.filter((item) => item.endsWith(".json")).sort()) {
    cases.push(JSON.parse(await readFile(join(casesDir, entry), "utf8")));
  }
  return cases;
}

function quoteShellArg(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return "'" + text.replaceAll("'", "'\\''") + "'";
}
