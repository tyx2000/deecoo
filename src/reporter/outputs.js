import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function saveRunOutputs(store, session, { task, result }) {
  if (!store?.projectDir || !session?.id || !result) return [];
  const dir = join(store.projectDir, "outputs", session.id);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const outputs = [];
  if (result.reviewReport) {
    outputs.push(await writeOutput(dir, `${now}-review-report.json`, result.reviewReport));
  }
  if (result.verification) {
    outputs.push(await writeOutput(dir, `${now}-verification.json`, result.verification));
  }
  outputs.push(await writeOutput(dir, `${now}-run-result.json`, structuredRunResult({ task, result })));
  outputs.push(await writeOutput(dir, `${now}-summary.md`, summaryMarkdown({ task, result })));
  return outputs;
}

export function structuredRunResult({ task, result }) {
  return {
    schemaVersion: 1,
    task: String(task ?? ""),
    finalText: String(result?.finalText ?? ""),
    stoppedReason: result?.stoppedReason,
    requestType: result?.requestType,
    usage: result?.usage ?? {},
    workflow: result?.workflow ?? {},
    verification: result?.verification ?? {},
    agentState: summarizeAgentState(result?.agentState),
    process: result?.process ?? result?.agentState?.process,
    reviewReport: result?.reviewReport,
  };
}

export function summaryMarkdown({ task, result }) {
  return [
    "# Deecoo Run Summary",
    "",
    "## Task",
    "",
    String(task ?? "").trim(),
    "",
    "## Workflow",
    "",
    "- status: " + (result?.workflow?.status ?? "unknown"),
    "- phase: " + (result?.workflow?.phase ?? "unknown"),
    "",
    "## Verification",
    "",
    "- status: " + (result?.verification?.status ?? "not-run"),
    "- commands: " + (result?.verification?.commands?.length ?? 0),
    "",
    "## Agent State",
    "",
    "- steps: " + (result?.agentState?.steps?.length ?? 0),
    "- files read: " + listSummary(result?.agentState?.filesRead),
    "- files edited: " + listSummary(result?.agentState?.filesEdited),
    "- commands run: " + listSummary(result?.agentState?.commandsRun),
    "- context compactions: " + (result?.agentState?.contextCompactions?.length ?? 0),
    "- process duplicates blocked: " + (result?.process?.duplicatesBlocked ?? result?.agentState?.process?.duplicatesBlocked ?? 0),
    "- process thrash nudges: " + (result?.process?.thrashNudges ?? result?.agentState?.process?.thrashNudges ?? 0),
    "",
    "## Output",
    "",
    String(result?.finalText ?? "").trim(),
    "",
  ].join("\n");
}

function listSummary(values) {
  if (!Array.isArray(values) || values.length === 0) return "none";
  return values.slice(-8).join(", ") + (values.length > 8 ? ", ..." : "");
}

function summarizeAgentState(agentState) {
  if (!agentState) return undefined;
  return {
    schemaVersion: agentState.schemaVersion,
    task: agentState.task,
    cwd: agentState.cwd,
    startedAt: agentState.startedAt,
    updatedAt: agentState.updatedAt,
    usage: agentState.usage,
    filesRead: agentState.filesRead ?? [],
    filesEdited: agentState.filesEdited ?? [],
    commandsRun: agentState.commandsRun ?? [],
    observations: (agentState.observations ?? []).slice(-40),
    recentSteps: (agentState.steps ?? []).slice(-40),
    contextCompactions: agentState.contextCompactions ?? [],
    process: agentState.process,
  };
}

async function writeOutput(dir, fileName, content) {
  const path = join(dir, fileName);
  const body = typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n";
  await writeFile(path, body, "utf8");
  return { path, fileName };
}
