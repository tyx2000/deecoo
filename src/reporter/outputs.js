import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { atomicWriteFile, readJsonFile, readStoredFile, removeStoredFile, withFileLock, writeJsonFile } from "../storage/atomic.js";
import { canPersist, safeStorageId } from "../storage/governance.js";
import { markStoredContextProjection, redact } from "../observability/audit.js";
import { join } from "node:path";

export async function saveRunOutputs(store, session, { task, result }) {
  if (!store?.projectDir || !session?.id || !result || !canPersist(store)) return [];
  safeStorageId(session.id, "session id");
  const dir = join(store.projectDir, "outputs", session.id);
  const now = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID();
  const outputs = [];
  if (result.reviewReport) {
    outputs.push(await writeOutput(store, dir, `${now}-review-report.json`, result.reviewReport));
  }
  if (result.verification) {
    outputs.push(await writeOutput(store, dir, `${now}-verification.json`, result.verification));
  }
  outputs.push(await writeOutput(store, dir, `${now}-run-result.json`, structuredRunResult({ task, result })));
  outputs.push(await writeOutput(store, dir, `${now}-summary.md`, summaryMarkdown({ task, result })));
  await store.prune?.();
  return outputs;
}

export function structuredRunResult({ task, result }) {
  return {
    schemaVersion: 1,
    task: String(task ?? ""),
    finalText: String(result?.finalText ?? ""),
    status: result?.status ?? result?.workflow?.status,
    error: result?.error,
    stoppedReason: result?.stoppedReason,
    requestType: result?.requestType,
    runId: result?.runId,
    taskId: result?.taskId,
    acceptance: result?.acceptance,
    changes: result?.changes,
    capabilities: result?.capabilities,
    routeIdentity: result?.routeIdentity,
    effectiveConfig: result?.effectiveConfig,
    pluginCleanup: result?.pluginCleanup,
    contextState: result?.contextState,
    workerContexts: result?.workerContexts,
    runJournal: result?.runJournal,
    modelDiagnostics: result?.modelDiagnostics,
    checkpoint: result?.checkpoint,
    checkpointFailure: result?.checkpointFailure,
    contextSnapshotError: result?.contextSnapshotError,
    contextArchiveFailure: result?.contextArchiveFailure,
    failurePhase: result?.failurePhase,
    persistenceFailure: result?.persistenceFailure,
    contextMetrics: result?.contextMetrics,
    metrics: result?.metrics,
    events: result?.events,
    jobCleanup: result?.jobCleanup,
    usage: result?.usage ?? {},
    workflow: result?.workflow ?? {},
    verification: result?.verification ?? {},
    effects: result?.effects,
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

export async function listRunOutputs(store, session) {
  if (!store?.projectDir || !session?.id || !canPersist(store)) return [];
  const dir = outputDirectory(store, session);
  return (await readdir(dir).catch((error) => { if (error.code === "ENOENT") return []; throw error; }))
    .filter((fileName) => /\.(?:json|md)$/.test(fileName)).sort().reverse().map((fileName) => ({ path: join(dir, fileName), fileName }));
}
export async function readRunOutput(store, session, fileName) {
  const path = outputPath(store, session, fileName);
  if (!canPersist(store)) return undefined;
  return fileName.endsWith(".json") ? readJsonFile(path) : readStoredFile(path);
}
export async function deleteRunOutput(store, session, fileName) {
  const path = outputPath(store, session, fileName);
  await store.assertTaskOwner?.(session.id);
  if (canPersist(store)) await removeStoredFile(path);
  return { fileName, deleted: true };
}
async function writeOutput(store, dir, fileName, content) {
  const path = join(dir, fileName);
  const safe = markStoredContextProjection(content, redact(content, { secretRegistry: store.secretRegistry, maxTextChars: Infinity }), store.storagePolicy);
  const options = { maxBytes: store.storagePolicy?.maxFileBytes };
  if (typeof safe === "string") await withFileLock(path, () => atomicWriteFile(path, safe, options));
  else await writeJsonFile(path, safe, options);
  return { path, fileName };
}
function outputDirectory(store, session) {
  safeStorageId(session.id, "session id");
  return join(store.projectDir, "outputs", session.id);
}
function outputPath(store, session, fileName) {
  if (!/^[A-Za-z0-9_-]+\.(?:json|md)$/.test(String(fileName ?? ""))) throw new Error("Invalid output file name.");
  return join(outputDirectory(store, session), fileName);
}
