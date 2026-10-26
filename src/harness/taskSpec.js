import { inferTaskIntent } from "./taskIntent.js";
import { buildAcceptance } from "./acceptance.js";

export function buildTaskSpec({ task, cwd, coordination, activeSkills = [], mode, acceptance, requiredChecks }) {
  const text = String(task ?? "").trim();
  const contract = inferTaskIntent(text, { mode });
  const outcome = buildAcceptance({ task: text, intent: contract, acceptance, requiredChecks });
  // The task spec is shown to the model (and in a run's conversation) as pretty JSON, so key
  // order is the visible format. Keep the original reading order - schemaVersion, goal, cwd,
  // requestType - and append the v2 additions after it instead of leading with them.
  return {
    schemaVersion: 2,
    goal: text,
    cwd,
    requestType: contract.requestType,
    ...contract,
    complexity: coordination?.complex ? "complex" : "simple",
    constraints: {
      reviewOnly: !contract.mayWrite,
      activeSkills: activeSkills.map((skill) => skill.name || skill.id).filter(Boolean),
    },
    phases: (coordination?.phases ?? []).map((phase) => phase.name),
    riskDomains: (coordination?.riskDomains ?? []).map((domain) => domain.name),
    successCriteria: successCriteria(contract),
    acceptance: outcome,
    requiredChecks: outcome.requiredChecks,
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

function successCriteria({ requestType, requiresCodeChange, mayWrite }) {
  if (requestType === "review") {
    return [
      "Inspect relevant code before judging.",
      "Return schema-valid review findings or explicitly say there are no findings.",
      "Do not edit files.",
    ];
  }
  if (requiresCodeChange) {
    return [
      "Make minimal scoped changes.",
      "Run or explain relevant verification.",
      "Summarize changed files and residual risks.",
    ];
  }
  if (requestType === "command") {
    return ["Run the requested command or explain why it cannot be run.", "Report important output and exit status."];
  }
  return ["Answer the user request using inspected context when code facts are needed.", ...(!mayWrite ? ["Do not edit files or run commands with potential side effects."] : [])];
}
