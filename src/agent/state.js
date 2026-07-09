const MAX_TEXT = 4000;
const MAX_OBSERVATIONS = 80;
const MAX_STEPS = 200;
const MAX_ITEMS = 160;

export function createAgentState({ task, cwd }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    task: String(task ?? ""),
    cwd: String(cwd ?? ""),
    startedAt: now,
    updatedAt: now,
    currentPlan: undefined,
    filesRead: [],
    filesEdited: [],
    commandsRun: [],
    observations: [],
    steps: [],
    contextCompactions: [],
    process: undefined,
    usage: emptyUsage(),
  };
}

export function recordModelStep(state, { step, message, usage, startedAt, endedAt = Date.now(), error }) {
  const normalizedUsage = normalizeUsage(usage);
  addUsage(state.usage, normalizedUsage);
  pushStep(state, {
    step,
    type: "model",
    startedAt: iso(startedAt),
    endedAt: iso(endedAt),
    durationMs: Math.max(0, endedAt - startedAt),
    modelResponse: compactModelMessage(message),
    tokens: normalizedUsage,
    error: error ? String(error.message ?? error) : undefined,
  });
  if (message?.content) {
    pushObservation(state, {
      step,
      type: "model-response",
      summary: truncateOneLine(message.content, 500),
    });
  }
  touch(state);
  return state;
}

export function recordToolStep(state, { step, name, args, result, startedAt, endedAt = Date.now() }) {
  const ok = result?.ok !== false;
  const compactResult = compactToolObservation(result);
  const target = toolTarget(name, args, result);
  pushStep(state, {
    step,
    type: "tool",
    startedAt: iso(startedAt),
    endedAt: iso(endedAt),
    durationMs: Math.max(0, endedAt - startedAt),
    toolCall: {
      name,
      args: compactArgs(args),
      target,
    },
    toolResult: compactResult,
    error: ok ? undefined : result?.error ?? result?.code ?? "tool failed",
  });
  recordToolEffects(state, { step, name, args, result, target, ok });
  touch(state);
  return state;
}

export function recordContextCompaction(state, { beforeMessages, afterMessages, beforeChars, afterChars, step }) {
  state.contextCompactions.push({
    step,
    beforeMessages,
    afterMessages,
    beforeChars,
    afterChars,
    at: new Date().toISOString(),
  });
  state.contextCompactions = state.contextCompactions.slice(-20);
  pushObservation(state, {
    step,
    type: "context-compaction",
    summary: `Compacted live context from ${beforeMessages} to ${afterMessages} messages.`,
  });
  touch(state);
  return state;
}

export function recordProcessSnapshot(state, process) {
  if (!state || !process) return state;
  state.process = process;
  touch(state);
  return state;
}

export function buildAgentStateSummary(state) {
  const process = state?.process;
  return [
    "Task summary:",
    "- Task: " + truncateOneLine(state.task, 500),
    "- cwd: " + state.cwd,
    "- steps recorded: " + state.steps.length,
    "- files read: " + listSummary(state.filesRead),
    "- files edited: " + listSummary(state.filesEdited),
    "- commands run: " + listSummary(state.commandsRun),
    "- verification observations: " + observationSummary(state.observations),
    process
      ? "- process: blocked_duplicates=" +
        (process.duplicatesBlocked ?? 0) +
        ", thrash_nudges=" +
        (process.thrashNudges ?? 0) +
        ", pinned_files=" +
        (process.pinnedFiles ?? 0)
      : "- process: n/a",
    "- token usage: " + state.usage.totalTokens + " total (" + state.usage.promptTokens + " in / " + state.usage.completionTokens + " out)",
    "",
    "Recent steps:",
    ...state.steps.slice(-12).map(formatStepSummary),
  ].join("\n");
}

function recordToolEffects(state, { step, name, args, result, target, ok }) {
  if (name === "read_file" && args?.path) pushUnique(state.filesRead, args.path);
  if (name === "run_shell" && args?.command) pushUnique(state.commandsRun, args.command);
  for (const path of editedPaths(name, args, result)) pushUnique(state.filesEdited, path);

  const summary = toolObservationSummary({ name, target, ok, result });
  if (summary) {
    pushObservation(state, {
      step,
      type: name,
      target,
      ok,
      summary,
    });
  }
}

function editedPaths(name, args, result) {
  if (!["edit_file", "write_file", "apply_patch", "apply_patch_set", "apply_json_patch"].includes(name)) return [];
  if (Array.isArray(result?.files)) return result.files.map((file) => file.path ?? file).filter(Boolean);
  if (Array.isArray(args?.files)) return args.files.map((file) => file.path ?? file.from).filter(Boolean);
  return [args?.path].filter(Boolean);
}

function toolObservationSummary({ name, target, ok, result }) {
  if (name === "run_shell") {
    const status = ok ? "passed" : "failed";
    const failure = result?.failureSummary || result?.stderr || result?.stdout || result?.error || "";
    return `${target} ${status}${failure ? ": " + truncateOneLine(failure, 600) : ""}`;
  }
  if (!ok) return `${name} failed${target ? " on " + target : ""}: ${truncateOneLine(result?.error ?? result?.code ?? "", 500)}`;
  if (result?.summary) return truncateOneLine(result.summary, 500);
  if (result?.activity?.summary) return truncateOneLine(result.activity.summary, 500);
  if (target) return `${name} ${target}`;
  return name;
}

function compactModelMessage(message) {
  if (!message) return undefined;
  return {
    role: message.role,
    content: message.content ? truncateText(message.content, MAX_TEXT) : "",
    toolCalls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: truncateText(call.function?.arguments, 2000),
        }))
      : [],
  };
}

function compactToolObservation(result) {
  if (!result || typeof result !== "object") return result;
  const out = {};
  for (const key of [
    "ok",
    "code",
    "error",
    "recoverable",
    "suggestion",
    "cached",
    "alreadyAvailable",
    "reason",
    "priorStep",
    "truncated",
    "path",
    "bytesWritten",
    "status",
  ]) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  if (result.activity) out.activity = result.activity;
  if (result.failureSummary) out.failureSummary = truncateText(result.failureSummary, MAX_TEXT);
  if (result.stdout) out.stdout = truncateText(result.stdout, 2000);
  if (result.stderr) out.stderr = truncateText(result.stderr, 2000);
  if (result.diff) out.diff = truncateText(result.diff, MAX_TEXT);
  if (result.files) out.files = Array.isArray(result.files) ? result.files.slice(0, 40) : result.files;
  if (result.matches) out.matches = Array.isArray(result.matches) ? result.matches.slice(0, 20) : result.matches;
  if (result.content !== undefined) out.content = truncateText(result.content, 2000);
  return out;
}

function compactArgs(args) {
  if (!args || typeof args !== "object") return args;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out[key] = truncateText(value, key === "content" ? 500 : 2000);
    else if (Array.isArray(value)) out[key] = value.slice(0, 20);
    else out[key] = value;
  }
  return out;
}

function toolTarget(name, args, result) {
  return String(
    result?.activity?.target ??
      args?.path ??
      args?.directory ??
      args?.command ??
      args?.query ??
      args?.task ??
      name ??
      "",
  );
}

function pushStep(state, step) {
  state.steps.push(step);
  if (state.steps.length > MAX_STEPS) state.steps = state.steps.slice(-MAX_STEPS);
}

function pushObservation(state, observation) {
  state.observations.push({
    ...observation,
    at: new Date().toISOString(),
  });
  if (state.observations.length > MAX_OBSERVATIONS) state.observations = state.observations.slice(-MAX_OBSERVATIONS);
}

function pushUnique(list, value) {
  const text = String(value ?? "");
  if (!text || list.includes(text)) return;
  list.push(text);
  if (list.length > MAX_ITEMS) list.splice(0, list.length - MAX_ITEMS);
}

function normalizeUsage(usage) {
  return {
    promptTokens: Number(usage?.prompt_tokens ?? usage?.promptTokens ?? 0),
    completionTokens: Number(usage?.completion_tokens ?? usage?.completionTokens ?? 0),
    totalTokens: Number(usage?.total_tokens ?? usage?.totalTokens ?? 0),
  };
}

function addUsage(total, usage) {
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  total.totalTokens += usage.totalTokens;
}

function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function formatStepSummary(step) {
  if (step.type === "model") {
    const tools = step.modelResponse?.toolCalls?.map((call) => call.name).filter(Boolean).join(", ");
    return `- #${step.step} model ${step.durationMs}ms${tools ? " requested " + tools : ""}`;
  }
  const call = step.toolCall ?? {};
  const ok = step.toolResult?.ok === false ? "failed" : "ok";
  return `- #${step.step} tool ${call.name ?? "unknown"} ${ok} ${truncateOneLine(call.target ?? "", 160)} (${step.durationMs}ms)`;
}

function listSummary(values) {
  if (!values.length) return "none";
  return values.slice(-12).join(", ") + (values.length > 12 ? `, ... ${values.length - 12} more` : "");
}

function observationSummary(observations) {
  if (!observations.length) return "none";
  return observations.slice(-8).map((item) => truncateOneLine(item.summary, 220)).join(" | ");
}

function touch(state) {
  state.updatedAt = new Date().toISOString();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function truncateText(value, max) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) + `\n... truncated ${text.length - max} characters` : text;
}

function truncateOneLine(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) + "..." : text;
}
