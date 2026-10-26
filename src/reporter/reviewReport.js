const REQUIRED_TOP_LEVEL = ["schema_version", "review", "findings", "open_questions", "test_gaps", "residual_risks"];
const FINDING_REQUIRED = [
  "id",
  "severity",
  "status",
  "confidence",
  "confidence_score",
  "lane",
  "scope",
  "file",
  "finding",
  "impact",
  "evidence",
  "reliable_solution",
  "solution_fit",
  "verification_status",
  "post_cor_candidate",
];

const ENUMS = {
  severity: new Set(["P0", "P1", "P2", "P3"]),
  confidence: new Set(["high", "medium", "low"]),
  lane: new Set(["code", "errors", "tests", "types", "comments", "simplify", "security", "performance", "architecture"]),
  scope: new Set(["current-diff", "pre-existing", "unclear"]),
  verification_status: new Set(["proven-by-code", "proven-by-test", "not-run", "blocked"]),
};

export function reviewSchemaInstructions() {
  return [
    "Structured review schema:",
    "For review tasks, include one fenced JSON block at the end of the final answer. The block must be valid JSON and match this shape:",
    "```json",
    JSON.stringify(exampleReviewReport(), null, 2),
    "```",
    "Rules: findings may be empty; every main finding needs file, evidence, scope, verification_status, and post_cor_candidate. Keep confidence_score below 80 out of findings unless exploratory review was explicitly requested.",
  ].join("\n");
}

export function createReviewFinalValidator({ maxRepairAttempts = 2, task: requestedTask } = {}) {
  return ({ finalText, attempt, task, effects }) => {
    const validation = validateReviewReportText(finalText);
    const coverage = reviewCoverage({ task: requestedTask ?? task, effects });
    if (validation.ok && coverage.errors.length) {
      validation.ok = false;
      validation.errors.push(...coverage.errors);
    }
    if (validation.ok) {
      return {
        ok: true,
        report: { ...validation.report, coverage },
        errors: [],
      };
    }
    return {
      ok: false,
      report: undefined,
      errors: validation.errors,
      maxRepairAttempts,
      repairPrompt: reviewRepairPrompt(validation.errors, attempt + 1),
    };
  };
}

export function reviewCoverage({ task, effects } = {}) {
  const events = effects?.events ?? [];
  const text = String(task ?? "");
  const observations = fileCoverage(events);
  const files = [...new Set([...observations.keys(), ...events.filter((event) => event.type === "diff-read").flatMap((event) => event.paths ?? [event.path])].filter(Boolean))];
  const inlineSource = hasInlineSource(text);
  const requested = [...text.matchAll(/(?:^|[\s(])@([\w./-]+\.[\w.-]+)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)?/g)]
    .map((match) => ({ path: match[1].replace(/^\.\//, "").replace(/[.,]+$/, ""), startLine: Number(match[2] ?? match[4]) || undefined,
      endLine: Number(match[3] ?? match[5] ?? match[2] ?? match[4]) || undefined }));
  const requestedFiles = [...new Set(requested.map((item) => item.path))];
  const missingFiles = requestedFiles.filter((path) => !files.includes(path));
  const scopeText = text.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  const fullRequested = /\b(?:full|entire|whole)\b|\bcomplete\s+(?:review|source|code|files?|contents?)\b|\bcompletely\b|\ball\s+(?:code|lines|contents?|files)\b|完整|全文|全部|所有代码|所有行/i.test(scopeText);
  const incompleteFiles = [...new Set(requested.filter(({ path, startLine, endLine }) => {
    const observed = observations.get(path);
    if (startLine) return !observed || !coversLines(observed, startLine, endLine);
    return fullRequested && !observed?.complete;
  }).map((item) => item.path))];
  const errors = [];
  if (!files.length && !inlineSource) errors.push("Review has no runtime source evidence. Read relevant source files or a non-empty diff before concluding, including when findings are empty.");
  if (missingFiles.length) errors.push("Requested review files have not been inspected: " + missingFiles.join(", "));
  if (incompleteFiles.length) errors.push("Requested review scope lacks complete same-version source coverage: " + incompleteFiles.join(", ") + ". Read the full files or all requested line ranges before concluding.");
  const partialFiles = [...observations].filter(([, value]) => !value.complete).map(([path]) => path);
  return { files, inlineSource, requestedFiles, missingFiles, partialFiles, incompleteFiles,
    scope: fullRequested ? "full-requested-files" : requested.some((item) => item.startLine) ? "requested-lines" : "sampled", revision: effects?.revision,
    status: errors.length || partialFiles.length ? "partial" : "inspected", errors };
}

function fileCoverage(events) {
  const files = new Map();
  for (const event of events) {
    if (event.type === "file-change" || event.type === "workspace-uncertain") {
      for (const path of event.paths ?? []) files.delete(path.replace(/^\.\//, ""));
    }
    if (event.type !== "file-read" || !event.path) continue;
    const path = event.path.replace(/^\.\//, "");
    const version = event.version ?? event.contentHash;
    let observed = files.get(path);
    if (!observed || !version || observed.version !== version) {
      observed = { version, complete: false, ranges: [], totalLines: undefined };
      files.set(path, observed);
    }
    if (Number.isSafeInteger(event.totalLines) && event.totalLines >= 0) observed.totalLines = event.totalLines;
    if (!event.truncated) observed.complete = true;
    if (event.rangeComplete === true && Number.isSafeInteger(event.startLine) && event.startLine >= 1 &&
      Number.isSafeInteger(event.endLine) && event.endLine >= event.startLine) {
      observed.ranges.push([event.startLine, event.endLine]);
    }
    if (version && observed.totalLines !== undefined && coversLines(observed, 1, observed.totalLines)) observed.complete = true;
  }
  return files;
}

function coversLines(observed, start, end) {
  if (observed.complete) return observed.totalLines === undefined || end <= observed.totalLines;
  if (end < start) return observed.totalLines === 0;
  let next = start;
  for (const [first, last] of observed.ranges.toSorted((a, b) => a[0] - b[0])) {
    if (first > next) break;
    if (last >= next) next = last + 1;
    if (next > end) return true;
  }
  return false;
}

function hasInlineSource(task) {
  // Evidence depends on the supplied body and its declared subject, not on a
  // programming-language tag allowlist. Configs (including JSON/YAML), diffs,
  // and unknown-language snippets remain valid; an arbitrary log fence is not.
  for (const match of task.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)) {
    const body = match[2].trim();
    if (!body) continue;
    const info = match[1].trim();
    const context = task.slice(Math.max(0, match.index - 160), match.index);
    const logSubject = /\b(?:logs?|stdout|stderr|console|output|stacktrace)\b|日志|输出|堆栈/i.test(info + " " + context);
    const sourceSubject = /\b(?:code|source|snippet|config(?:uration)?|diff|patch|query|script)\b|代码|源码|片段|配置|补丁|查询|脚本/i.test(context);
    if (logSubject && !sourceSubject) continue;
    if (/^(?:diff --git |@@\s+-\d|---\s+[^\n]+\n\+\+\+\s+)/m.test(body)) return true;
    if (/\{[\s\S]*\}|=>|<\/?[\w:-]+(?:\s|>)/.test(body) || /^\s*(?:\w+\s+){0,3}[\w.$"'\[\]-]+\s*(?:=|:)\s*\S/m.test(body)) return true;
    if (sourceSubject && !/^(?:text|logs?|console|output|stdout|stderr)$/i.test(info)) return true;
  }
  return false;
}

export function validateReviewReportText(text) {
  const candidates = extractJsonCandidates(text);
  const parseErrors = [];
  for (const candidate of candidates) {
    let report;
    try {
      report = JSON.parse(candidate);
    } catch (error) {
      parseErrors.push(error.message);
      continue;
    }
    const errors = validateReviewReport(report);
    if (errors.length === 0) return { ok: true, report: aggregateReviewReport(report), errors: [] };
    parseErrors.push(...errors);
  }
  return {
    ok: false,
    report: undefined,
    errors: candidates.length ? unique(parseErrors) : ["Missing fenced JSON review report."],
  };
}

export function validateReviewReport(report) {
  const errors = [];
  if (!isObject(report)) return ["Review report must be a JSON object."];
  for (const key of REQUIRED_TOP_LEVEL) {
    if (report[key] === undefined) errors.push(`Missing top-level field: ${key}.`);
  }
  if (report.schema_version !== 1) errors.push("schema_version must be 1.");
  if (!isObject(report.review)) errors.push("review must be an object.");
  for (const key of ["target", "base", "project_context", "mode", "lanes"]) {
    if (report.review && report.review[key] === undefined) errors.push(`review.${key} is required.`);
  }
  if (report.review && !Array.isArray(report.review.lanes)) errors.push("review.lanes must be an array.");
  for (const key of ["findings", "open_questions", "test_gaps", "residual_risks"]) {
    if (!Array.isArray(report[key])) errors.push(`${key} must be an array.`);
  }
  if (Array.isArray(report.findings)) {
    report.findings.forEach((finding, index) => validateFinding(finding, index, errors));
  }
  return errors;
}

export function aggregateReviewReport(report) {
  const findings = [];
  const seen = new Set();
  for (const finding of report.findings ?? []) {
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(finding);
  }
  findings.sort(compareFindings);
  return {
    ...report,
    findings,
    aggregation: {
      originalFindingCount: report.findings?.length ?? 0,
      findingCount: findings.length,
      duplicateCount: Math.max(0, (report.findings?.length ?? 0) - findings.length),
      severityCounts: severityCounts(findings),
    },
  };
}

export function formatReviewReportMarkdown(report) {
  const findings = report?.findings ?? [];
  const review = report?.review ?? {};
  const lines = [
    "## Review Summary",
    "",
    "- target: " + fallback(review.target),
    "- mode: " + fallback(review.mode),
    "- findings: " + String(findings.length),
  ];
  if (report?.coverage) {
    lines.push("- source coverage: " + report.coverage.status + " (" + (report.coverage.files?.length ?? 0) + " file(s); project-wide completeness is not inferred)");
    if (report.coverage.partialFiles?.length) lines.push("- partial file reads: " + report.coverage.partialFiles.join(", "));
  }
  const counts = report?.aggregation?.severityCounts ?? severityCounts(findings);
  const nonzeroCounts = Object.entries(counts).filter(([, count]) => count > 0);
  if (nonzeroCounts.length) {
    lines.push("- severity: " + nonzeroCounts.map(([severity, count]) => `${severity}=${count}`).join(", "));
  }
  lines.push("");

  if (!findings.length) {
    lines.push("No findings.");
  } else {
    lines.push("## Findings", "");
    for (const finding of findings) {
      lines.push(
        `### ${finding.severity} ${finding.id}: ${finding.finding}`,
        "",
        "- file: " + fallback(finding.file),
        "- confidence: " + fallback(finding.confidence) + " (" + fallback(finding.confidence_score) + ")",
        "- impact: " + fallback(finding.impact),
        "- evidence: " + fallback(finding.evidence),
        "- fix: " + fallback(finding.reliable_solution),
        "- verification: " + fallback(finding.verification_status),
        "",
      );
    }
  }

  appendSection(lines, "Open Questions", report?.open_questions);
  appendSection(lines, "Test Gaps", report?.test_gaps);
  appendSection(lines, "Residual Risks", report?.residual_risks);
  return lines.join("\n").trim();
}

export function formatReviewDisplayText({ report, finalText }) {
  if (report) return formatReviewReportMarkdown(report);

  const prose = stripTrailingReviewJson(finalText);
  if (prose !== undefined) {
    return prose || "Review completed, but no human-readable summary was produced.";
  }

  const parsed = parseWholeReviewJson(finalText);
  if (parsed) return formatReviewReportMarkdown(aggregateReviewReport(parsed));
  return String(finalText ?? "").trim() || "Review completed, but no human-readable summary was produced.";
}

function validateFinding(finding, index, errors) {
  const label = `findings[${index}]`;
  if (!isObject(finding)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  for (const key of FINDING_REQUIRED) {
    if (finding[key] === undefined || finding[key] === "") errors.push(`${label}.${key} is required.`);
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (finding[key] !== undefined && !allowed.has(finding[key])) {
      errors.push(`${label}.${key} must be one of: ${[...allowed].join(", ")}.`);
    }
  }
  const score = Number(finding.confidence_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) errors.push(`${label}.confidence_score must be 0-100.`);
  if (Number.isFinite(score) && score < 80) errors.push(`${label}.confidence_score below 80 cannot be in findings.`);
  if (typeof finding.post_cor_candidate !== "boolean") errors.push(`${label}.post_cor_candidate must be boolean.`);
}

function extractJsonCandidates(text) {
  const candidates = [];
  const fencePattern = /```(?:json|JSON)?[^\n]*\n([\s\S]*?)```/g;
  for (const match of String(text ?? "").matchAll(fencePattern)) {
    const content = match[1].trim();
    if (content.startsWith("{") && content.endsWith("}")) candidates.push(content);
  }
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
  return candidates;
}

function stripTrailingReviewJson(text) {
  const value = String(text ?? "").trim();
  const withoutFence = value.replace(/\n*(?:---[ \t]*\n+)?```json[^\n]*\n[\s\S]*?```\s*$/i, "").trim();
  return withoutFence === value ? undefined : withoutFence;
}

function parseWholeReviewJson(text) {
  const value = String(text ?? "").trim().replace(/^```json[^\n]*\n/i, "").replace(/\n?```\s*$/, "");
  try {
    const report = JSON.parse(value);
    return isObject(report) && isObject(report.review) && Array.isArray(report.findings) ? report : undefined;
  } catch {
    return undefined;
  }
}

function reviewRepairPrompt(errors, attempt) {
  return [
    `Your review output failed structured schema validation on repair attempt ${attempt}.`,
    "Rewrite the final answer. Keep findings concise, but include a valid fenced JSON review report at the end.",
    "Validation errors:",
    ...errors.map((error) => "- " + error),
    "",
    reviewSchemaInstructions(),
  ].join("\n");
}

function exampleReviewReport() {
  return {
    schema_version: 1,
    review: {
      target: "current diff or requested scope",
      base: "HEAD, staged, branch, or unknown",
      project_context: "language/runtime/project type",
      mode: "quick/deep/security-focused/test-focused/maintainability/pre-merge/synthesis",
      lanes: ["code", "tests"],
    },
    findings: [
      {
        id: "SCOR-001",
        severity: "P1",
        status: "open",
        confidence: "high",
        confidence_score: 90,
        lane: "code",
        scope: "current-diff",
        file: "src/example.js:42",
        finding: "Short title",
        impact: "Concrete user/security/operational impact.",
        evidence: "Specific file, line, condition, or control path.",
        reliable_solution: "Specific fix direction.",
        solution_fit: "suited=yes; executable=yes; cost=low; verification=focused test",
        verification_status: "proven-by-code",
        post_cor_candidate: true,
        reviewer_agreement: "n/a",
      },
    ],
    open_questions: [],
    test_gaps: [],
    residual_risks: [],
  };
}

function findingKey(finding) {
  return [
    String(finding.file ?? "").toLowerCase(),
    String(finding.finding ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
    String(finding.evidence ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
  ].join("|");
}

function compareFindings(a, b) {
  const severityDelta = severityRank(a.severity) - severityRank(b.severity);
  if (severityDelta !== 0) return severityDelta;
  return Number(b.confidence_score ?? 0) - Number(a.confidence_score ?? 0);
}

function severityRank(value) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[value] ?? 99;
}

function severityCounts(findings) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) counts[finding.severity] += 1;
  }
  return counts;
}

function appendSection(lines, title, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  lines.push("", "## " + title, "");
  for (const item of items) lines.push("- " + fallback(item));
}

function fallback(value) {
  const text = String(value ?? "").trim();
  return text || "n/a";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values)];
}
