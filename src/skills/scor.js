export function isScorActive(activeSkills = []) {
  return activeSkills.some((skill) => (skill.name || skill.id) === "s-cor");
}

export function scorReviewToolPolicy() {
  return {
    name: "s-cor review mode",
    blockedTools: ["propose_patch", "propose_patch_set", "apply_patch", "apply_patch_set", "apply_json_patch", "edit_file", "write_file"],
    allowedWorkerModes: ["research", "verify"],
  };
}

export function scorArtifactMetadata(text) {
  const findingIds = uniqueMatches(text, /\bSCOR-\d{3,}\b/g);
  const severities = uniqueMatches(text, /\bP[0-3]\b/g);
  const confidence = {
    confirmed: countMatches(text, /\bCONFIRMED\b/gi),
    likely: countMatches(text, /\bLIKELY\b/gi),
    plausible: countMatches(text, /\bPLAUSIBLE\b/gi),
  };
  return {
    schemaVersion: 1,
    hasStructuredFindings: findingIds.length > 0,
    findingCount: findingIds.length,
    findingIds,
    severities,
    confidence,
    hasNoFindingsStatement: /\b(no findings|no actionable findings|no issues found)\b/i.test(String(text ?? "")),
  };
}

function uniqueMatches(text, pattern) {
  return [...new Set([...String(text ?? "").matchAll(pattern)].map((match) => match[0]))];
}

function countMatches(text, pattern) {
  return [...String(text ?? "").matchAll(pattern)].length;
}
