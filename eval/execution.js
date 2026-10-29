import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { runTask } from "../src/agent/taskRunner.js";
import { createExecutionBackend } from "../src/execution/backend.js";
import { createSessionStore } from "../src/session/store.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { createReplayClient } from "../src/llm/replay.js";
import { isModelPriceKnown } from "../src/harness/cost.js";
import { countLineChanges } from "../src/tools/textDiff.js";
import { summarizeEvalResults } from "./scoring.js";

const INSTRUMENTATION_FILE = ".deecoo/PROJECT.md";
const DEFAULT_CONFIG = Object.freeze({ model: "scripted-eval", stream: false, quiet: true, maxSteps: 20, maxTokens: 2048, taskTimeoutMs: 30000 });

// These are trusted, authored local scenarios. A temporary project prevents edits
// to the checkout; it is not an OS sandbox for arbitrary model-generated programs.
export async function executeEvalCase(caseDefinition, { trials = 1, clientFactory, keepWorkspaces = false } = {}) {
  validateDefinition(caseDefinition);
  validateTrials(trials);
  const definition = structuredClone(caseDefinition);
  const results = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    results.push(await executeTrial(definition, { trial, clientFactory, keepWorkspaces }));
  }
  const checks = results.flatMap((result) => result.checks.map((check) => ({ ...check, name: `trial-${result.trial}/${check.name}` })));
  const passed = results.every((result) => result.passed);
  return {
    caseId: definition.id,
    title: definition.title ?? definition.id,
    category: definition.category ?? "harness-regression",
    evaluationKind: clientFactory ? "provider-e2e" : "harness-e2e",
    passed,
    score: Math.round(100 * results.filter((result) => result.passed).length / trials),
    checks,
    trials: results,
    config: { ...DEFAULT_CONFIG, ...definition.execution.config, quiet: true, stream: false },
    summary: {
      workflowStatus: passed ? "completed" : "failed",
      verificationStatus: results.some((result) => result.checks.some((check) => check.name.startsWith("command:")))
        ? results.every((result) => result.checks.filter((check) => check.name.startsWith("command:")).every((check) => check.passed)) ? "passed" : "failed" : "not-run",
      toolCalls: results.reduce((total, result) => total + result.diagnostics.toolCalls.length, 0),
      ...summarizeTrials(results),
    },
  };
}

export async function executeEvalSuite(cases, options = {}) {
  const results = [];
  for (const definition of cases) results.push(await executeEvalCase(definition, options));
  return {
    results,
    summary: { ...summarizeEvalResults(results), ...summarizeTrials(results.flatMap((result) => result.trials)) },
  };
}

async function executeTrial(definition, { trial, clientFactory, keepWorkspaces }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deecoo-eval-")));
  const workspace = join(root, "workspace");
  const startedAt = performance.now();
  const execution = definition.execution;
  const config = { ...DEFAULT_CONFIG, ...execution.config, changeStateDir: join(root, "changes"), quiet: true, stream: false };
  let run = {};
  let before;
  let after;
  let checks = [];
  let recovery;
  const humanInterventions = 0;
  let approvalRequests = 0;
  let taskPassed = false;
  try {
    await mkdir(workspace);
    for (const [path, content] of Object.entries(execution.files)) {
      const target = workspacePath(workspace, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    before = await snapshotWorkspace(workspace);
    const client = clientFactory
      ? await clientFactory({ caseDefinition: structuredClone(definition), workspace, trial, config: { ...config } })
      : execution.replay
        ? createReplayClient(execution.replay, { strict: execution.replayStrict !== false })
        : createScriptedEvalClient(execution.scripted);
    const executionEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NODE_|npm_config_|NPM_CONFIG_)/.test(key)));
    const makeTools = () => createToolRuntime({ cwd: workspace, executionBackend: createExecutionBackend({ cwd: workspace, stateDir: join(root, "jobs"), env: executionEnv, sandboxPolicy: config.sandboxPolicy ?? { mode: "off" } }), permissionMode: execution.permissionMode ?? "workspace-write", prompter: async () => { approvalRequests += 1; return execution.approvalDecision ?? "approve"; } });
    const tools = makeTools();
    // Node's test runner exports NODE_TEST_CONTEXT to children; inheriting it can
    // make a nested `node --test` skip all tests and exit 0. Remove host test and
    // npm option injection for a reproducible execution environment.
    const envOverlay = Object.fromEntries(Object.keys(process.env)
      .filter((key) => /^(?:NODE_|npm_config_|NPM_CONFIG_)/.test(key)).map((key) => [key, undefined]));
    let sessionStore, session;
    if (execution.resumeScripted) { sessionStore = await createSessionStore(workspace, { rootDir: join(root, "sessions") }); session = await sessionStore.createSession({ model: config.model }); }
    run = await runTask({ client, tools, task: definition.task, cwd: workspace, config, envOverlay, sessionStore, session });
    if (execution.resumeScripted) {
      const checkpoint = await sessionStore.loadCheckpoint(session.id);
      recovery = { initialStatus: run.status, checkpointUsed: Boolean(checkpoint) };
      if (!checkpoint) throw new Error("Recovery scenario did not persist a resumable checkpoint");
      run = await runTask({ client: createScriptedEvalClient(execution.resumeScripted), tools: makeTools(), task: definition.task, cwd: workspace, config, envOverlay, sessionStore, session, resumeCheckpoint: checkpoint });
    }
    // Sample before graders run, so a grader cannot hide a task's side effects.
    after = await snapshotWorkspace(workspace);
    // Independent checks import the candidate's code, so they get the same OS sandbox the task's
    // own commands had; a provider benchmark must not hand model-written code the host's access.
    const grader = createExecutionBackend({ cwd: workspace, stateDir: join(root, "grader-jobs"), sandboxPolicy: config.sandboxPolicy ?? { mode: "off" } });
    try { checks = await gradeWorkspace(definition, workspace, before, after, grader); }
    finally { await grader.dispose({ stopRunning: true, removeState: true }).catch(() => {}); }
    checks.unshift(...gradeRun(definition, run));
    if (recovery) checks.push(requiredCheck("recovery", ["failed", "interrupted"].includes(recovery.initialStatus) && recovery.checkpointUsed && run.status === "completed", JSON.stringify(recovery)));
  } catch (error) {
    checks.push(requiredCheck("execution", false, error.message));
  } finally {
    if (!keepWorkspaces) await rm(root, { recursive: true, force: true });
  }
  taskPassed = checks.length > 0 && checks.every((check) => !check.required || check.passed);
  for (const name of execution.expectedCheckFailures ?? []) {
    const check = checks.find((item) => item.name === name);
    if (!check) checks.push(requiredCheck("expected-rejection:" + name, false, "Expected rejection check was not executed"));
    else { check.observedPassed = check.passed; check.expectedPassed = false; check.passed = !check.passed; check.detail = "Expected independent rejection; " + check.detail; }
  }
  const calls = (run.trace ?? []).flatMap((entry) => entry.toolCalls ?? (entry.tool ? [entry] : []));
  return {
    trial,
    passed: checks.length > 0 && checks.every((check) => !check.required || check.passed),
    humanInterventions, approvalRequests, taskPassed,
    ...(recovery ? { recovery } : {}),
    elapsedMs: Math.round(performance.now() - startedAt),
    usage: normalizeUsage(run.usage),
    provider: clientFactory ? "configured" : execution.replay ? "replay" : "scripted",
    costUsd: isModelPriceKnown(config.model, config) ? run.costUsd ?? null : null,
    ...(!clientFactory ? { actualSpendUsd: 0 } : {}),
    checks,
    changedFiles: before && after ? changedFiles(before, after) : [],
    workspaceState: { before, after, ignoredPaths: [INSTRUMENTATION_FILE, ".deecoo/ (container only)"] },
    ...(keepWorkspaces ? { workspace } : {}),
    diagnostics: {
      status: run.status ?? "failed",
      workflowStatus: run.workflow?.status ?? "unknown",
      stoppedReason: run.stoppedReason,
      error: run.error,
      requestType: run.requestType,
      verification: run.verification,
      acceptance: run.acceptance ?? run.reviewValidation?.acceptance,
      reviewReport: run.reviewReport,
      validationErrors: run.reviewValidation?.errors,
      toolCalls: calls.map((call) => ({ tool: call.tool ?? call.name, ok: call.ok })),
      finalText: run.finalText,
    },
  };
}

// Each turn yields real model protocol messages. Only the provider is scripted;
// runTask, workers, permissions, tools, shell execution and files remain real.
export function createScriptedEvalClient(scripted = {}) {
  const queues = Array.isArray(scripted) ? { main: scripted } : scripted;
  const positions = { main: 0, worker: 0 };
  let callId = 0;
  const completion = async (request) => {
    const role = (request.messages ?? []).some((message) => String(message.content ?? "").includes("You are a Deecoo worker agent")) ? "worker" : "main";
    const index = positions[role]++;
    const turn = queues[role]?.[index];
    if (!turn) throw new Error(`Script exhausted for ${role} at turn ${index + 1}`);
    if (turn.interrupt) throw Object.assign(new Error("Authored eval interruption"), { name: "AbortError", code: "ABORT_ERR" });
    if (turn.response) return structuredClone(turn.response);
    const tools = turn.tools ?? (turn.tool ? [{ tool: turn.tool, arguments: turn.arguments ?? {} }] : []);
    return {
      choices: [{ message: { role: "assistant", content: turn.text ?? null,
        ...(tools.length ? { tool_calls: tools.map((tool) => ({ id: `eval-call-${++callId}`, type: "function", function: { name: tool.tool, arguments: JSON.stringify(tool.arguments ?? {}) } })) } : {}),
      } }],
      usage: turn.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  };
  return {
    chatCompletion: completion,
    async chatCompletionStream(request, handlers = {}) {
      const response = await completion(request);
      const content = response.choices?.[0]?.message?.content;
      if (content) handlers.onContent?.(content);
      return response;
    },
    async listModels() { return { data: [] }; },
  };
}

function gradeRun(definition, run) {
  const expected = definition.execution.expectedRun ?? {};
  const expectedStatus = expected.status ?? "completed";
  const checks = [requiredCheck("completion", run.status === expectedStatus && (expectedStatus !== "completed" || run.workflow?.status === "completed"), `expected=${expectedStatus}; run=${run.status ?? "unknown"}; workflow=${run.workflow?.status ?? "unknown"}`)];
  if (expected.stoppedReason) checks.push(requiredCheck("stopped-reason", run.stoppedReason === expected.stoppedReason, `Stopped: ${run.stoppedReason}`));
  if (expected.verificationStatus) checks.push(requiredCheck("verification-status", run.verification?.status === expected.verificationStatus, `Verification: ${run.verification?.status}`));
  if (expected.completionType) checks.push(requiredCheck("completion-type", (run.acceptance ?? run.reviewValidation?.acceptance)?.completionType === expected.completionType, `Completion type: ${(run.acceptance ?? run.reviewValidation?.acceptance)?.completionType}`));
  if (expected.validationError) checks.push(requiredCheck("validation-error", (run.reviewValidation?.errors ?? []).some((error) => String(error).includes(expected.validationError)), JSON.stringify(run.reviewValidation?.errors)));
  // Context-pressure scenarios prove compaction ran and that the goal survived it in the
  // context the model saw last.
  if (expected.minCompactions) checks.push(requiredCheck("context-compaction", (run.agentState?.contextCompactions?.length ?? 0) >= expected.minCompactions, `Compactions: ${run.agentState?.contextCompactions?.length ?? 0}`));
  const finalContext = (run.messages ?? []).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")).join("\n");
  for (const text of expected.contextIncludes ?? []) checks.push(requiredCheck("context-includes:" + text.slice(0, 40), finalContext.includes(text), "Final model context retained the expected text"));
  const findings = run.reviewReport?.findings ?? [];
  if (expected.findingCount !== undefined) checks.push(requiredCheck("review-finding-count", findings.length === expected.findingCount, `Findings: ${findings.length}`));
  for (const finding of expected.findings ?? []) checks.push(requiredCheck("review-finding:" + finding.id, findings.some((item) => sameReviewFinding(item, finding)), "Review finding matched independent authored expectation"));
  return checks;
}

// The same issue is the same file (and line, when the expectation names one) with matching
// evidence and, if given, severity. The reviewer's own id is not part of correctness unless an
// expectation explicitly requires it.
function sameReviewFinding(item, finding) {
  const [path, line] = String(finding.file ?? "").split(":");
  const [itemPath, itemLine] = String(item.file ?? "").split(":");
  return itemPath === path && (!line || itemLine === line)
    && (!finding.evidenceIncludes || String(item.evidence ?? "").includes(finding.evidenceIncludes))
    && (!finding.severity || item.severity === finding.severity)
    && (!finding.requireId || item.id === finding.id);
}

async function gradeWorkspace(definition, workspace, before, after, grader) {
  const execution = definition.execution;
  const changed = changedFiles(before, after);
  const unauthorized = changed.filter((path) => !execution.allowedChanges.some((scope) => pathMatches(path, scope)));
  const checks = [requiredCheck("change-scope", unauthorized.length === 0, unauthorized.length ? `Unexpected changes: ${unauthorized.join(", ")}` : `Allowed changes: ${changed.join(", ") || "none"}`)];
  // Paths alone cannot tell a one-line fix from a whole-file rewrite; a line budget can.
  if (execution.maxChangedLines !== undefined) {
    let changedLines = 0;
    for (const path of changed.filter((item) => !item.endsWith("/"))) {
      const current = after[path]?.kind === "file" ? await readGraderFile(workspace, path) : undefined;
      const { additions, deletions } = countLineChanges(execution.files[path] ?? "", current ?? "");
      changedLines += additions + deletions;
    }
    checks.push(requiredCheck("change-size", changedLines <= execution.maxChangedLines, `Changed lines: ${changedLines} (limit ${execution.maxChangedLines})`));
  }
  for (const spec of execution.checks.files ?? []) {
    let passed = false;
    let detail;
    try {
      const content = await readGraderFile(workspace, spec.path);
      passed = spec.absent ? content === undefined : content !== undefined &&
        (spec.equals === undefined || content === spec.equals) &&
        (spec.contains === undefined || content.includes(spec.contains));
      detail = passed ? "Final file check passed" : "Final file content did not match";
    } catch (error) { detail = error.message; }
    checks.push(requiredCheck("file:" + spec.path, passed, detail));
  }
  for (const path of execution.checks.unchanged ?? []) {
    const touched = changed.filter((file) => pathMatches(file, path));
    checks.push(requiredCheck("unchanged:" + path, touched.length === 0, touched.length ? `Changed: ${touched.join(", ")}` : "File hashes unchanged"));
  }
  for (let index = 0; index < (execution.checks.commands ?? []).length; index += 1) {
    const spec = execution.checks.commands[index];
    const result = await runIndependentCommand(spec, workspace, grader);
    checks.push({ ...requiredCheck("command:" + (spec.name ?? index + 1), result.exitCode === (spec.expectExitCode ?? 0) && !result.error,
      `Independent command exited ${result.exitCode ?? "without an exit code"}${result.error ? ": " + result.error : ""}`), evidence: result });
  }
  return checks;
}

async function runIndependentCommand(spec, workspace, grader) {
  const args = spec.args ?? [];
  const executable = spec.command === "node" ? process.execPath : spec.command;
  const quote = (word) => "'" + String(word).replaceAll("'", "'\\''") + "'";
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  try {
    const result = await grader.run({ command: [executable, ...args].map(quote).join(" "), cwd: workspace, env, replaceEnv: true,
      timeoutMs: spec.timeoutMs ?? 10000, maxOutputBytes: 128 * 1024 });
    const exited = result.status === "exited";
    return { command: spec.command, args, exitCode: exited ? result.exitCode : null, sandbox: result.sandbox,
      stdout: String(result.stdout ?? "").slice(0, 8192), stderr: String(result.stderr ?? "").slice(0, 8192),
      ...(exited ? {} : { error: result.error ?? "Independent command did not exit normally" }) };
  } catch (error) {
    return { command: spec.command, args, exitCode: null, stdout: "", stderr: "", error: error.message };
  }
}

async function snapshotWorkspace(workspace) {
  const files = Object.create(null);
  let bytes = 0;
  let entries = 0;
  const walk = async (directory, prefix = "", depth = 0) => {
    if (depth > 32) throw new Error("Eval workspace exceeds snapshot depth limit (32)");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 2000) throw new Error("Eval workspace exceeds 2000 entry snapshot limit");
      const relative = prefix + entry.name;
      if (relative === INSTRUMENTATION_FILE && entry.isFile()) continue;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        // The harness creates this container for PROJECT.md. Its other contents
        // are still traversed and graded, including empty subdirectories.
        if (relative !== ".deecoo") files[relative + "/"] = { kind: "directory", mode: (await lstat(target)).mode & 0o7777 };
        await walk(target, relative + "/", depth + 1);
      }
      else if (entry.isSymbolicLink()) files[relative] = { kind: "symlink", target: await readlink(target) };
      else if (entry.isFile()) {
        const stat = await lstat(target);
        bytes += stat.size;
        if (bytes > 16 * 1024 * 1024) throw new Error("Eval workspace exceeds 16 MiB snapshot limit");
        files[relative] = { kind: "file", hash: createHash("sha256").update(await readFile(target)).digest("hex"), mode: stat.mode & 0o7777 };
      } else files[relative] = { kind: "special" };
    }
  };
  await walk(workspace);
  return files;
}

async function readGraderFile(workspace, path) {
  const target = workspacePath(workspace, path);
  let current = workspace;
  for (const part of path.split("/")) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    if (stat.isSymbolicLink()) throw new Error("Independent file check refuses symlink: " + path);
  }
  return readFile(target, "utf8");
}

function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => JSON.stringify(before[path]) !== JSON.stringify(after[path])).sort();
}

function workspacePath(workspace, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error("Invalid eval workspace path: " + path);
  const target = resolve(workspace, path);
  if (!target.startsWith(workspace + sep)) throw new Error("Eval path escapes workspace: " + path);
  return target;
}

function pathMatches(path, scope) { return scope.endsWith("/") ? path.startsWith(scope) : path === scope; }
function requiredCheck(name, passed, detail) { return { name, passed, required: true, detail }; }
function normalizeUsage(usage = {}) {
  return { promptTokens: usage.promptTokens ?? usage.prompt_tokens ?? 0, completionTokens: usage.completionTokens ?? usage.completion_tokens ?? 0, totalTokens: usage.totalTokens ?? usage.total_tokens ?? 0 };
}
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : 0; }
function summarizeTrials(trials) {
  const passedTrials = trials.filter((trial) => trial.passed).length;
  return { trials: trials.length, passedTrials, successRate: trials.length ? passedTrials / trials.length : 0,
    totalTokens: trials.reduce((total, trial) => total + trial.usage.totalTokens, 0),
    elapsedMs: trials.reduce((total, trial) => total + trial.elapsedMs, 0), p50Ms: percentile(trials.map((trial) => trial.elapsedMs), 0.5), p95Ms: percentile(trials.map((trial) => trial.elapsedMs), 0.95),
    costUsd: trials.every((trial) => trial.costUsd !== null) ? trials.reduce((total, trial) => total + trial.costUsd, 0) : null };
}
function validateTrials(trials) { if (!Number.isInteger(trials) || trials < 1 || trials > 100) throw new Error("--trials must be an integer between 1 and 100"); }
function validateDefinition(definition) {
  const execution = definition?.execution;
  if (!definition?.id || typeof definition.task !== "string" || !definition.task.trim() || !execution) throw new Error("E2E eval requires id, task and execution definition");
  if (!execution.files || typeof execution.files !== "object" || Array.isArray(execution.files)) throw new Error("E2E eval requires execution.files");
  for (const [path, content] of Object.entries(execution.files)) { workspacePath("/eval-workspace", path); if (typeof content !== "string") throw new Error("Eval fixture files must contain strings"); }
  if (!Array.isArray(execution.allowedChanges)) throw new Error("E2E eval requires explicit execution.allowedChanges (use [] for read-only)");
  for (const path of [...execution.allowedChanges, ...(execution.checks?.unchanged ?? [])]) workspacePath("/eval-workspace", path.endsWith("/") ? path.slice(0, -1) : path);
  const checks = execution.checks ?? {};
  if (execution.maxChangedLines !== undefined && (!Number.isSafeInteger(execution.maxChangedLines) || execution.maxChangedLines < 0)) throw new Error("execution.maxChangedLines must be a nonnegative integer");
  if (execution.expectedCheckFailures && (!Array.isArray(execution.expectedCheckFailures) || execution.expectedCheckFailures.some((name) => typeof name !== "string"))) throw new Error("expectedCheckFailures must be check names");
  if (execution.expectedRun?.status && !["completed", "failed"].includes(execution.expectedRun.status)) throw new Error("expectedRun.status must be completed or failed");
  if (!(checks.files?.length || checks.commands?.length)) throw new Error("E2E eval requires independent file or command checks");
  for (const spec of checks.files ?? []) {
    workspacePath("/eval-workspace", spec.path);
    if (!spec.absent && spec.exists !== true && spec.equals === undefined && spec.contains === undefined) throw new Error("File checks require exists, equals, contains or absent");
  }
  for (const spec of checks.commands ?? []) {
    // An executable or test file inside the candidate project is editable by the
    // agent. Only accept verifier code held in the trusted definition and run it
    // with this process's absolute Node executable, without shell/PATH lookup.
    const args = spec.args ?? [];
    const offset = args[0] === "--input-type=module" ? 1 : 0;
    if (spec.command !== "node" || args.length !== offset + 2 || !["-e", "--eval"].includes(args[offset]) || typeof args[offset + 1] !== "string") {
      throw new Error("Independent commands require node with inline -e verifier code; workspace executables or test scripts are mutable");
    }
    if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 30000)) throw new Error("Independent command timeout must be between 1 and 30000 ms");
  }
}
