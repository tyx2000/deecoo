#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rankEvalCases } from "./matching.js";
import { scoreEvalCase, summarizeEvalResults } from "./scoring.js";
import { executeEvalSuite } from "./execution.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(argv) {
  const args = parseArgs(argv);
  const cases = await loadCases(args.casesDir, args.caseId);
  const runRecord = args.runPath ? await loadRunRecord(args.runPath) : undefined;
  const suggestions = runRecord ? rankEvalCases(cases, runRecord).slice(0, args.suggestionLimit) : [];
  if (args.suggest) {
    const report = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      source: "suggestions",
      runPath: args.runPath,
      suggestions,
    };
    console.log(args.json ? JSON.stringify(report, null, 2) : formatSuggestionReport(report));
    return;
  }

  const selectedCases = args.autoCase ? selectAutoCases(cases, suggestions, args.minMatchScore) : cases;
  let results = [];
  let summary;
  if (args.mode === "e2e") {
    ({ results, summary } = await executeEvalSuite(selectedCases, { trials: args.trials, keepWorkspaces: args.keepWorkspaces }));
  } else {
    for (const caseDefinition of selectedCases) {
      const run = runRecord ?? await loadFixtureRun(args.fixturesDir, caseDefinition.id);
      results.push(scoreEvalCase(caseDefinition, run));
    }
    summary = summarizeEvalResults(results);
  }

  const report = {
    schemaVersion: 2,
    evaluationKind: args.mode === "e2e" ? "harness-e2e" : "trace-grader",
    createdAt: new Date().toISOString(),
    source: args.mode === "e2e" ? "execution" : args.runPath ? "run" : "fixture",
    runPath: args.runPath || undefined,
    matchedCases: args.autoCase ? suggestions.slice(0, 1) : undefined,
    summary,
    results,
  };

  const written = args.writeReport ? await writeReports(args.reportDir, report) : [];
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTextReport(report, written));
  }

  if (summary.failed > 0 && (args.mode === "e2e" || args.failOnFailed)) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const args = {
    casesDir: undefined,
    fixturesDir: resolve(ROOT, "eval", "fixtures"),
    reportDir: resolve(ROOT, "eval", "reports"),
    caseId: "",
    runPath: "",
    suggest: false,
    autoCase: false,
    minMatchScore: 40,
    suggestionLimit: 5,
    json: false,
    writeReport: true,
    failOnFailed: false,
    mode: "trace",
    trials: 1,
    keepWorkspaces: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--case") args.caseId = argv[++index] ?? "";
    else if (arg === "--execute") args.mode = "e2e";
    else if (arg === "--mode") args.mode = argv[++index];
    else if (arg === "--trials") args.trials = Number(argv[++index]);
    else if (arg === "--keep-workspaces") args.keepWorkspaces = true;
    else if (arg === "--run") args.runPath = resolve(argv[++index] ?? "");
    else if (arg === "--suggest") args.suggest = true;
    else if (arg === "--auto-case") args.autoCase = true;
    else if (arg === "--min-match-score") args.minMatchScore = Number(argv[++index] ?? args.minMatchScore);
    else if (arg === "--suggestion-limit") args.suggestionLimit = Number(argv[++index] ?? args.suggestionLimit);
    else if (arg === "--cases-dir") args.casesDir = resolve(argv[++index] ?? args.casesDir);
    else if (arg === "--fixtures-dir") args.fixturesDir = resolve(argv[++index] ?? args.fixturesDir);
    else if (arg === "--report-dir") args.reportDir = resolve(argv[++index] ?? args.reportDir);
    else if (arg === "--json") args.json = true;
    else if (arg === "--no-report") args.writeReport = false;
    else if (arg === "--fail-on-failed") args.failOnFailed = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error("Unknown eval option: " + arg);
    }
  }

  if (!["trace", "e2e"].includes(args.mode)) throw new Error("--mode must be trace or e2e");
  if (!Number.isInteger(args.trials) || args.trials < 1 || args.trials > 100) throw new Error("--trials must be an integer between 1 and 100");
  if (args.mode === "trace" && (args.trials !== 1 || args.keepWorkspaces)) throw new Error("--trials and --keep-workspaces require --execute");
  if (args.mode === "e2e" && (args.runPath || args.suggest || args.autoCase)) throw new Error("--execute cannot be combined with --run, --suggest or --auto-case");
  args.casesDir ??= resolve(ROOT, "eval", args.mode === "e2e" ? "tasks" : "cases");
  if (args.runPath && !args.caseId && !args.suggest && !args.autoCase) {
    throw new Error("--run requires --case, --suggest, or --auto-case.");
  }

  return args;
}

function selectAutoCases(cases, suggestions, minMatchScore) {
  const best = suggestions[0];
  if (!best || best.score < minMatchScore) {
    throw new Error(`No eval case matched the run above min score ${minMatchScore}. Use --suggest to inspect candidates.`);
  }
  return cases.filter((caseDefinition) => caseDefinition.id === best.caseId);
}

async function loadCases(casesDir, caseId) {
  const entries = await readdir(casesDir);
  const caseFiles = entries.filter((entry) => entry.endsWith(".json")).sort();
  const cases = [];
  for (const fileName of caseFiles) {
    const caseDefinition = JSON.parse(await readFile(join(casesDir, fileName), "utf8"));
    if (!caseId || caseDefinition.id === caseId) cases.push(caseDefinition);
  }
  if (!cases.length) {
    throw new Error(caseId ? "No eval case found for " + caseId : "No eval cases found in " + casesDir);
  }
  return cases;
}

async function loadFixtureRun(fixturesDir, caseId) {
  const path = join(fixturesDir, caseId + ".json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Missing fixture run for eval case " + caseId + ": " + path);
    }
    throw error;
  }
}

async function loadRunRecord(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeReports(reportDir, report) {
  await mkdir(reportDir, { recursive: true });
  const stamp = report.createdAt.replace(/[:.]/g, "-");
  const jsonPath = join(reportDir, stamp + "-summary.json");
  const markdownPath = join(reportDir, stamp + "-summary.md");
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(markdownPath, formatMarkdownReport(report), "utf8");
  return [jsonPath, markdownPath];
}

function formatTextReport(report, written) {
  const lines = [
    `${report.evaluationKind === "harness-e2e" ? "Harness E2E" : "Trace grader (not E2E)"}: ${report.summary.passed}/${report.summary.total} passed, average ${report.summary.averageScore}`,
    ...(report.summary.trials ? [`Trials: ${report.summary.passedTrials}/${report.summary.trials}; tokens ${report.summary.totalTokens}; latency p50 ${report.summary.p50Ms}ms / p95 ${report.summary.p95Ms}ms`] : []),
    ...(report.matchedCases?.length ? [`Auto case: ${report.matchedCases[0].caseId} (${report.matchedCases[0].score})`, ""] : [""]),
    "",
    ...report.results.map((result) => {
      const status = result.passed ? "PASS" : "FAIL";
      return `${status} ${result.caseId} ${result.score} - ${result.title}`;
    }),
  ];
  if (written.length) {
    lines.push("", "Reports:", ...written.map((path) => "  " + path));
  }
  return lines.join("\n");
}

function formatSuggestionReport(report) {
  return [
    "Eval case suggestions:",
    "",
    ...report.suggestions.map((suggestion) =>
      `${suggestion.caseId} ${suggestion.score} - ${suggestion.title}` +
      (suggestion.reasons.length ? `\n  ${suggestion.reasons.join(", ")}` : ""),
    ),
  ].join("\n");
}

function formatMarkdownReport(report) {
  return [
    "# Deecoo Harness Eval",
    "",
    "- createdAt: " + report.createdAt,
    "- source: " + report.source,
    "- evaluationKind: " + report.evaluationKind,
    ...(report.runPath ? ["- runPath: " + report.runPath] : []),
    ...(report.matchedCases?.length ? ["- autoCase: " + report.matchedCases[0].caseId + " (" + report.matchedCases[0].score + ")"] : []),
    "- passed: " + report.summary.passed + "/" + report.summary.total,
    "- averageScore: " + report.summary.averageScore,
    "",
    "## Results",
    "",
    "| Case | Score | Status | Workflow | Verification | Tool Calls |",
    "| --- | ---: | --- | --- | --- | ---: |",
    ...report.results.map((result) =>
      "| " + [
        result.caseId,
        result.score,
        result.passed ? "PASS" : "FAIL",
        result.summary.workflowStatus,
        result.summary.verificationStatus,
        result.summary.toolCalls,
      ].join(" | ") + " |",
    ),
    "",
    "## Required Check Failures",
    "",
    ...(report.summary.failedRequiredChecks.length
      ? report.summary.failedRequiredChecks.map((item) => `- ${item.caseId} / ${item.check}: ${item.detail}`)
      : ["None"]),
    "",
  ].join("\n");
}

function printHelp() {
  console.log([
    "Usage:",
    "  npm run eval -- [options]",
    "",
    "Options:",
    "  --execute           Execute trusted cases in fresh temporary projects (default: eval/tasks)",
    "  --mode <trace|e2e>   Default trace grades existing records; it is not E2E execution",
    "  --trials <n>        Repeat each E2E case with fixed configuration (1-100)",
    "  --keep-workspaces   Keep E2E projects and include their paths in the report",
    "  --case <id>          Run a single eval case",
    "  --run <path>         Score a real audit/run JSON against --case",
    "  --suggest            Suggest matching eval cases for --run",
    "  --auto-case          Score --run against the highest-scoring matching case",
    "  --min-match-score <n> Minimum match score for --auto-case. Default: 40",
    "  --json               Print JSON report",
    "  --no-report          Do not write eval/reports artifacts",
    "  --fail-on-failed     Exit non-zero on trace failures (E2E failures always do)",
    "  --cases-dir <path>   Override case directory",
    "  --fixtures-dir <path> Override fixture run directory",
    "  --report-dir <path>  Override report directory",
  ].join("\n"));
}

main(process.argv).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
