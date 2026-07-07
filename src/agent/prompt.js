import { readFileSync } from "node:fs";
import { reviewSchemaInstructions } from "../reporter/reviewReport.js";

export function buildSystemPrompt(cwd, requestType, activeSkills = [], coordination) {
  return [
    renderPrompt("base.md", {
      cwd,
      requestType,
      activeSkills: formatActiveSkills(activeSkills),
    }),
    renderPrompt(taskPromptFile(requestType)),
    requestType === "review" ? reviewSchemaInstructions() : "",
    coordination?.complex
      ? renderPrompt("coordination.md", {
          coordinationProtocol: coordinationProtocol(coordination),
        })
      : "",
    renderPrompt("final-answer.md"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function taskPromptFile(requestType) {
  const known = new Set(["edit", "debug", "review", "analysis", "command", "general"]);
  return "task-" + (known.has(requestType) ? requestType : "general") + ".md";
}

function renderPrompt(fileName, values = {}) {
  const template = readPrompt(fileName);
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ""));
}

function readPrompt(fileName) {
  return readFileSync(new URL("../prompts/" + fileName, import.meta.url), "utf8").trim();
}

function coordinationProtocol(coordination) {
  const basis = bulletList(coordination.basis);
  const phases = bulletList((coordination.phases ?? []).map((phase) => phase.name + ": " + phase.reason));
  const domains = bulletList((coordination.riskDomains ?? []).map((domain) => domain.name + ": " + domain.reason));
  const parallel = bulletList((coordination.parallel ?? []).map(formatWorker));
  const serial = bulletList((coordination.serial ?? []).map(formatWorker));
  const verification = coordination.verification
    ? "  - " + formatWorker(coordination.verification)
    : "  - none";
  return [
    "- This task is classified as complex.",
    "- Before substantial tool work, provide a concise visible coordination note with split basis, phases, and worker strategy.",
    "- Do not reveal hidden chain-of-thought; describe coordination and observable work only.",
    "- Prefer worker tools for independent research, independent review, or independent verification; keep trivial work in the main context.",
    "- Split basis:",
    basis,
    "- Phases:",
    phases,
    "- Risk domains:",
    domains,
    "- Parallel candidates:",
    parallel,
    "- Serial candidates:",
    serial,
    "- Verification candidate:",
    verification,
  ].join("\n");
}

function formatWorker(worker) {
  const mode = worker.mode ? `mode=${worker.mode}; ` : "";
  return `${worker.name}: ${mode}${worker.goal} (${worker.reason})`;
}

function bulletList(items) {
  if (!items?.length) return "  - none";
  return items.map((item) => "  - " + item).join("\n");
}

function formatActiveSkills(activeSkills) {
  if (!activeSkills.length) return "- active skills: none";
  const blocks = activeSkills.slice(0, 6).map((skill) => {
    return [
      "Skill: " + skill.name,
      "Source: " + skill.sourceLabel + ":" + skill.relativePath,
      "Summary: " + skill.summary,
      "Instructions:",
      String(skill.content ?? "").trim(),
    ].join("\n");
  });
  return ["- active skills loaded for this run:", ...blocks.map((block) => indentBlock(block))].join("\n");
}

function indentBlock(block) {
  return String(block)
    .split(/\r?\n/)
    .map((line) => "  " + line)
    .join("\n");
}
