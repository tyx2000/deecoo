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

export function createReviewFinalValidator({ maxRepairAttempts = 2 } = {}) {
  return ({ finalText, attempt }) => {
    const validation = validateReviewReportText(finalText);
    if (validation.ok) {
      return {
        ok: true,
        report: validation.report,
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
