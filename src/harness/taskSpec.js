export function buildTaskSpec({ task, cwd, coordination, activeSkills = [] }) {
  const text = String(task ?? "").trim();
  return {
    schemaVersion: 1,
    goal: text,
    cwd,
    requestType: coordination?.requestType ?? "general",
    complexity: coordination?.complex ? "complex" : "simple",
    constraints: {
      reviewOnly: coordination?.requestType === "review",
      activeSkills: activeSkills.map((skill) => skill.name || skill.id).filter(Boolean),
    },
    phases: (coordination?.phases ?? []).map((phase) => phase.name),
    riskDomains: (coordination?.riskDomains ?? []).map((domain) => domain.name),
    successCriteria: successCriteria(text, coordination?.requestType),
  };
}

export function taskSpecMessage(taskSpec) {
  return {
    role: "system",
    content: [
      "Structured task spec:",
      JSON.stringify(taskSpec, null, 2),
      "Use this as the execution contract. If the user request conflicts with this derived spec, follow the user request and state the correction.",
    ].join("\n"),
  };
}

function successCriteria(task, requestType) {
  if (requestType === "review") {
    return [
      "Inspect relevant code before judging.",
      "Return schema-valid review findings or explicitly say there are no findings.",
      "Do not edit files.",
    ];
  }
  if (requestType === "edit" || requestType === "debug") {
    return [
      "Make minimal scoped changes.",
      "Run or explain relevant verification.",
      "Summarize changed files and residual risks.",
    ];
  }
  if (requestType === "command") {
    return ["Run the requested command or explain why it cannot be run.", "Report important output and exit status."];
  }
  return ["Answer the user request using inspected context when code facts are needed."];
}
