import { analyzeTaskCoordination } from "./coordination.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  buildAgentStateSummary,
  createAgentState,
  recordContextCompaction,
  recordModelStep,
  recordProcessSnapshot,
  recordToolStep,
} from "./state.js";
import { CONTINUE_TRANSITIONS, TERMINAL_TRANSITIONS, continueTransition, terminalTransition } from "./transitions.js";
import {
  buildWorkingSetSummary,
  createProcessController,
  evaluateToolCall,
  hasWorkingSet,
  maybeBuildProcessNudge,
  recordToolObservation,
  serializeProcessController,
  snapshotProcessMetrics,
} from "../harness/processController.js";
import { advanceWorkflowState, createWorkflowState } from "../harness/workflow.js";
import { createVerificationStateMachine } from "../verification/state.js";
import { CONTENT_TRUST_INSTRUCTION, markUntrustedToolResult } from "../harness/contentTrust.js";
import { estimateCostUsd } from "../harness/cost.js";
import { createMutex } from "../harness/mutex.js";
import { createQuarantine } from "../harness/quarantine.js";

const MAX_LIVE_MESSAGE_CHARS = 180000;
const RECENT_LIVE_MESSAGES = 10;
const MAX_PARALLEL_DISPATCH = 4;

export async function runAgent({
  client,
  tools,
  task,
  cwd,
  model,
  maxTokens,
  reasoningEffort,
  thinking,
  contextMessages = [],
  activeSkills = [],
  stream = true,
  coordination: providedCoordination,
  maxSteps = 150,
  tokenBudget,
  deadline,
  costBudgetUsd,
  priceOverrides,
  trustToolOutput = true,
  resume,
  onModelStart,
  onModelEnd,
  onToolStart,
  onToolEnd,
  onTextDelta,
  onCheckpoint,
  onEvent,
  secretRegistry,
  finalValidator,
  signal,
}) {
  const quarantine = createQuarantine();
  const usage = resume?.usage ? { ...emptyUsage(), ...resume.usage } : emptyUsage();
  const coordination = providedCoordination ?? analyzeTaskCoordination(task);
  const requestType = coordination.requestType;
  const trace = Array.isArray(resume?.trace) ? structuredClone(resume.trace) : [];
  const transitions = Array.isArray(resume?.transitions) ? structuredClone(resume.transitions) : [];
  const agentState = hydrateAgentState(resume?.agentState, { task, cwd, usage });
  const processController = createProcessController({ restore: resume?.processController });
  // Concurrent dispatches record their observations while running, so guard the shared
  // controller with a mutex; each dispatch records under its own stable lane so a mutation in
  // one never invalidates another's observations. Serial tools use the default (main) lane.
  const recordMutex = createMutex();
  // Expose this run's pinned observations so dispatched workers can reuse them instead of
  // re-reading the same files. Worker tool runtimes lack this hook, so the call safely no-ops.
  tools.setWorkingSetProvider?.(() => (hasWorkingSet(processController) ? buildWorkingSetSummary(processController) : undefined));
  const verification = createVerificationStateMachine(resume?.verification);
  let workflow = resume?.workflow
    ? structuredClone(resume.workflow)
    : advanceWorkflowState(createWorkflowState({ requestType }), { type: "planned" });
  let finalValidationAttempt = 0;
  const systemContent = trustToolOutput
    ? buildSystemPrompt(cwd, requestType, activeSkills, coordination) + "\n\n" + CONTENT_TRUST_INSTRUCTION
    : buildSystemPrompt(cwd, requestType, activeSkills, coordination);
  // Resuming a prior run rehydrates its message history and step/usage counters; a fresh run
  // starts from the system prompt, injected context, and the task.
  const messages = Array.isArray(resume?.messages) && resume.messages.length
    ? resume.messages.slice()
    : [
        { role: "system", content: systemContent },
        ...contextMessages,
        { role: "user", content: task },
      ];

  const finishRun = ({ finalText, stoppedReason, workflowType, extra = {} }) => {
    const process = snapshotProcessMetrics(processController);
    recordProcessSnapshot(agentState, process);
    return {
      finalText,
      messages,
      steps: step,
      usage,
      stoppedReason,
      transition: terminalTransition(stoppedReason ?? TERMINAL_TRANSITIONS.COMPLETED, { step }),
      transitions,
      trace,
      agentState,
      requestType,
      process,
      verification: verification.snapshot(),
      workflow: workflowType ? advanceWorkflowState(workflow, { type: workflowType, step }) : workflow,
      quarantine: quarantine.snapshot(),
      ...extra,
    };
  };

  let step = Number.isFinite(resume?.step) ? resume.step + 1 : 1;
  while (true) {
    throwIfAborted(signal);
    const budgetStop = evaluateBudgets({
      step,
      maxSteps,
      tokens: usage.totalTokens,
      tokenBudget,
      deadline,
      cost: costBudgetUsd ? estimateCostUsd(usage, model, priceOverrides) : 0,
      costBudgetUsd,
    });
    if (budgetStop) {
      return finishRun({ finalText: budgetStop.message, stoppedReason: budgetStop.reason, workflowType: "failed", extra: { budget: budgetStop } });
    }
    compactLiveMessages(messages, {
      protectedPrefixCount: 1 + contextMessages.length + 1,
      agentState,
      processController,
      step,
    });
    const request = {
      model,
      messages,
      tools: tools.schemas,
      tool_choice: "auto",
      max_tokens: maxTokens,
    };
    if (thinking) request.thinking = thinking;
    if (reasoningEffort) request.reasoning_effort = reasoningEffort;

    workflow = advanceWorkflowState(workflow, { type: "model-start", step });
    onModelStart?.({ step });
    const modelStartedAt = Date.now();
    const completion = await requestChatCompletion({
      client,
      request,
      stream,
      onTextDelta,
      onModelEnd,
      step,
      signal,
    });
    addUsage(usage, completion.usage);
    onEvent?.({ type: "model-call", step, usage: completion.usage });

    const message = completion.choices?.[0]?.message;
    if (!message) {
      throw new Error("DeepSeek returned no message.");
    }
    recordModelStep(agentState, {
      step,
      message,
      usage: completion.usage,
      startedAt: modelStartedAt,
    });

    messages.push(message);

    if (!message.tool_calls?.length) {
      const process = snapshotProcessMetrics(processController);
      recordProcessSnapshot(agentState, process);
      const finalText = message.content || "Done.";
      const finalValidation = finalValidator?.({
        finalText,
        messages,
        requestType,
        task,
        agentState,
        trace,
        verification: verification.snapshot(),
        workflow,
        process,
        attempt: finalValidationAttempt,
      });
      if (finalValidation && !finalValidation.ok && finalValidationAttempt < finalValidation.maxRepairAttempts) {
        transitions.push(continueTransition(CONTINUE_TRANSITIONS.FINAL_VALIDATION_REPAIR, {
          step,
          errors: finalValidation.errors,
        }));
        workflow = advanceWorkflowState(workflow, { type: "final-validation-repair", step });
        messages.push({
          role: "user",
          content: finalValidation.repairPrompt,
        });
        finalValidationAttempt += 1;
        step += 1;
        continue;
      }
      if (looksLikePseudoToolCall(message.content)) {
        return {
          finalText:
            "The model returned tool-call markup as plain text instead of a final answer. I stopped before showing that raw internal markup. Please continue with a narrower request.",
          messages,
          steps: step,
          usage,
          stoppedReason: TERMINAL_TRANSITIONS.PSEUDO_TOOL_CALL_TEXT,
          transition: terminalTransition(TERMINAL_TRANSITIONS.PSEUDO_TOOL_CALL_TEXT, { step }),
          transitions,
          trace,
          agentState,
          requestType,
          process,
          verification: verification.snapshot(),
          quarantine: quarantine.snapshot(),
          workflow: advanceWorkflowState(workflow, { type: "failed", step }),
        };
      }
      const failedReason = finalValidation?.reason ?? TERMINAL_TRANSITIONS.REVIEW_SCHEMA_INVALID;
      workflow = advanceWorkflowState(workflow, { type: finalValidation?.ok === false ? "failed" : "completed", step });
      return {
        finalText,
        messages,
        steps: step,
        usage,
        stoppedReason: finalValidation?.ok === false ? failedReason : undefined,
        transition: terminalTransition(finalValidation?.ok === false ? failedReason : TERMINAL_TRANSITIONS.COMPLETED, { step }),
        transitions,
        trace,
        agentState,
        requestType,
        process,
        reviewReport: finalValidation?.report,
        reviewValidation: finalValidation,
        verification: verification.snapshot(),
        quarantine: quarantine.snapshot(),
        workflow,
      };
    }

    const evaluated = message.tool_calls.map((call) => {
      const name = call.function?.name;
      const args = parseToolArguments(call.function?.arguments);
      workflow = advanceWorkflowState(workflow, { type: "tool-start", tool: name, step });
      const decision = evaluateToolCall(processController, { name, args, step });
      // Concurrent dispatches get a stable per-dispatch lane; serial tools stay in the main
      // lane so their cross-turn dedup is unchanged.
      const lane = isParallelDispatch({ name, decision }) ? "dispatch:" + call.id : undefined;
      onToolStart?.({ name, args, decision });
      return { call, name, args, decision, lane };
    });

    const runOne = async (item) => {
      throwIfAborted(signal);
      const startedAt = Date.now();
      const result =
        item.decision.action === "short_circuit"
          ? item.decision.result
          : await tools.execute(item.name, item.args, { signal });
      throwIfAborted(signal);
      // Record while running (under the mutex) so concurrent dispatches never race on the
      // shared controller and each stays isolated in its own lane.
      await recordMutex.run(() => recordToolObservation(processController, { name: item.name, args: item.args, result, step, lane: item.lane }));
      return { ...item, result, startedAt, endedAt: Date.now() };
    };

    // Independent subagent dispatches are I/O-bound on the model and isolated from the parent
    // workspace, so run them concurrently; every other tool stays serial because dedup and
    // observation semantics assume ordered execution.
    const executedById = new Map();
    for (const item of evaluated.filter((item) => !isParallelDispatch(item))) {
      executedById.set(item.call.id, await runOne(item));
    }
    for (const executed of await mapWithConcurrency(evaluated.filter(isParallelDispatch), MAX_PARALLEL_DISPATCH, runOne)) {
      executedById.set(executed.call.id, executed);
    }

    for (const item of evaluated) {
      const { name, args, result, startedAt, endedAt } = executedById.get(item.call.id);
      const verificationState = verification.observeTool({ name, args, result, step });
      transitions.push(continueTransition(result?.ok === false ? CONTINUE_TRANSITIONS.TOOL_ERROR : CONTINUE_TRANSITIONS.TOOL_USE, { step, tool: name }));
      recordToolStep(agentState, { step, name, args, result, startedAt, endedAt });
      trace.push(toolTraceEvent({ step, name, args, result, durationMs: Math.max(0, endedAt - startedAt) }));
      const compacted = compactToolResult(name, result);
      let { result: trustedResult, scan } = trustToolOutput
        ? markUntrustedToolResult(name, compacted)
        : { result: compacted, scan: { suspicious: false, reasons: [] } };
      // Data/instruction separation: when injection is suspected, quarantine the raw content
      // out-of-band and show the model only an inert projection with imperative lines withheld.
      if (trustToolOutput && scan.suspicious) {
        trustedResult = quarantineSuspiciousResult(name, trustedResult, quarantine);
      }
      // Redact any known secret values that a tool surfaced before the model or logs see them.
      if (secretRegistry) trustedResult = redactResultSecrets(trustedResult, secretRegistry);
      onToolEnd?.({ name, args, result, decision: item.decision, verification: verificationState, injection: scan });
      onEvent?.({
        type: "tool-call",
        step,
        tool: name,
        ok: result?.ok !== false,
        reused: result?.alreadyAvailable === true || result?.code === "ALREADY_AVAILABLE",
        injectionSuspected: scan.suspicious,
      });
      messages.push({
        role: "tool",
        tool_call_id: item.call.id,
        content: JSON.stringify(trustedResult),
      });
    }

    const processNudge = maybeBuildProcessNudge(processController, { step });
    if (processNudge) {
      messages.push(processNudge);
      transitions.push(continueTransition(CONTINUE_TRANSITIONS.TOOL_USE, { step, tool: "process_guard" }));
    }
    onEvent?.({ type: "step", step });
    onCheckpoint?.(serializeRunState({
      step,
      messages,
      usage,
      workflow,
      process: snapshotProcessMetrics(processController),
      processController: serializeProcessController(processController),
      requestType,
      trace,
      transitions,
      agentState,
      verification: verification.snapshot(),
    }));
    step += 1;
  }
}

function evaluateBudgets({ step, maxSteps, tokens, tokenBudget, deadline, cost = 0, costBudgetUsd }) {
  if (maxSteps && step > maxSteps) {
    return {
      reason: TERMINAL_TRANSITIONS.STEP_BUDGET_EXCEEDED,
      limit: maxSteps,
      observed: step,
      message: `Stopped after reaching the step budget (${maxSteps} steps). The task did not converge; narrow the request or raise DEECOO_MAX_STEPS.`,
    };
  }
  if (tokenBudget && tokens >= tokenBudget) {
    return {
      reason: TERMINAL_TRANSITIONS.TOKEN_BUDGET_EXCEEDED,
      limit: tokenBudget,
      observed: tokens,
      message: `Stopped after reaching the token budget (${tokenBudget} tokens used ${tokens}). Narrow the request or raise DEECOO_TOKEN_BUDGET.`,
    };
  }
  if (costBudgetUsd && cost >= costBudgetUsd) {
    return {
      reason: TERMINAL_TRANSITIONS.COST_BUDGET_EXCEEDED,
      limit: costBudgetUsd,
      observed: cost,
      message: `Stopped after reaching the cost budget ($${costBudgetUsd}; estimated $${cost.toFixed(4)}). Narrow the request or raise DEECOO_COST_BUDGET_USD.`,
    };
  }
  if (deadline && Date.now() >= deadline) {
    return {
      reason: TERMINAL_TRANSITIONS.TASK_DEADLINE_EXCEEDED,
      limit: deadline,
      observed: Date.now(),
      message: "Stopped after reaching the task time budget. Narrow the request or raise DEECOO_TASK_TIMEOUT_MS.",
    };
  }
  return undefined;
}

export function serializeRunState({ step, messages, usage, workflow, process, processController, requestType, trace, transitions, agentState, verification }) {
  return {
    version: 1,
    at: new Date().toISOString(),
    step,
    requestType,
    status: workflow?.status,
    phase: workflow?.phase,
    messages: Array.isArray(messages) ? structuredClone(messages) : undefined,
    usage: { ...usage },
    workflow: workflow ? structuredClone(workflow) : undefined,
    process: process ? { ...process } : undefined,
    processController: processController ? structuredClone(processController) : undefined,
    trace: Array.isArray(trace) ? structuredClone(trace) : [],
    transitions: Array.isArray(transitions) ? structuredClone(transitions) : [],
    agentState: agentState ? structuredClone(agentState) : undefined,
    verification: verification ? structuredClone(verification) : undefined,
  };
}

function hydrateAgentState(saved, { task, cwd, usage }) {
  const base = createAgentState({ task, cwd });
  if (!saved || typeof saved !== "object") {
    base.usage = { ...base.usage, ...usage };
    return base;
  }
  return {
    ...base,
    ...structuredClone(saved),
    task: String(saved.task ?? task ?? ""),
    cwd: String(saved.cwd ?? cwd ?? ""),
    usage: { ...base.usage, ...(saved.usage ?? {}), ...usage },
  };
}

export function compactLiveMessages(
  messages,
  { protectedPrefixCount, agentState, processController, step, maxChars = MAX_LIVE_MESSAGE_CHARS } = {},
) {
  const beforeChars = messageChars(messages);
  if (beforeChars <= maxChars) return false;
  const beforeMessages = messages.length;
  const safePrefixCount = Math.max(1, Math.min(protectedPrefixCount ?? 1, messages.length));
  const protectedMessages = messages.slice(0, safePrefixCount);
  const dynamicMessages = messages.slice(safePrefixCount).filter((message) => !isRunStateSummary(message));
  let tailStart = Math.max(0, dynamicMessages.length - RECENT_LIVE_MESSAGES);
  while (tailStart > 0 && dynamicMessages[tailStart]?.role === "tool") {
    tailStart -= 1;
  }
  const tail = dynamicMessages.slice(tailStart);
  const summaryParts = ["Run state summary (local context compaction):", buildAgentStateSummary(agentState)];
  if (processController) {
    summaryParts.push("", buildWorkingSetSummary(processController));
  }
  const summary = {
    role: "system",
    content: summaryParts.join("\n"),
  };
  messages.splice(0, messages.length, ...protectedMessages, summary, ...tail);
  if (agentState) {
    if (processController) {
      recordProcessSnapshot(agentState, snapshotProcessMetrics(processController));
    }
    recordContextCompaction(agentState, {
      beforeMessages,
      afterMessages: messages.length,
      beforeChars,
      afterChars: messageChars(messages),
      step,
    });
  }
  return true;
}

function isRunStateSummary(message) {
  return message?.role === "system" && String(message.content ?? "").startsWith("Run state summary (local context compaction):");
}

async function requestChatCompletion({
  client,
  request,
  stream,
  onTextDelta,
  onModelEnd,
  step,
  finalizing = false,
  signal,
}) {
  try {
    if (stream && typeof client.chatCompletionStream === "function") {
      return await client.chatCompletionStream(request, {
        signal,
        onContent: (content) => onTextDelta?.({ content, step, finalizing }),
      });
    }
    return await client.chatCompletion(request, { signal });
  } finally {
    onModelEnd?.({ step, finalizing });
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("Task interrupted.");
  error.name = "AbortError";
  throw error;
}

function isParallelDispatch(item) {
  return item.name === "agent" && item.decision.action !== "short_circuit";
}

const QUARANTINE_FIELDS = ["content", "stdout", "stderr", "diff", "status", "failureSummary", "result", "summary"];

function quarantineSuspiciousResult(name, result, quarantine) {
  if (!result || typeof result !== "object") return result;
  const next = { ...result };
  for (const field of QUARANTINE_FIELDS) {
    if (typeof next[field] !== "string" || next[field].length === 0) continue;
    const held = quarantine.store(next[field], { tool: name, field });
    next[field] =
      `[quarantined ${held.id}: ${held.withheld.length} instruction-like line(s) withheld; inert projection below]\n` + held.safe;
  }
  next.quarantined = quarantine.list().map((entry) => entry.id);
  return next;
}

const SECRET_REDACTABLE_FIELDS = ["content", "stdout", "stderr", "diff", "status", "failureSummary", "result", "summary", "error"];

function redactResultSecrets(result, secretRegistry) {
  if (!result || typeof result !== "object") return result;
  let next = result;
  for (const field of SECRET_REDACTABLE_FIELDS) {
    if (typeof result[field] !== "string" || result[field].length === 0) continue;
    const redacted = secretRegistry.redact(result[field]);
    if (redacted !== result[field]) {
      if (next === result) next = { ...result };
      next[field] = redacted;
    }
  }
  return next;
}

async function mapWithConcurrency(items, limit, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function looksLikePseudoToolCall(content) {
  const text = String(content ?? "");
  return (
    /\bDSML\b/.test(text) ||
    /<\|?\s*\|?\s*tool_calls\s*>/i.test(text) ||
    /<\s*tool_calls\s*>/i.test(text) ||
    /<\s*invoke\s+name=/i.test(text)
  );
}

function emptyUsage() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(total, usage) {
  if (!usage) return;
  total.promptTokens += Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  total.completionTokens += Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  total.totalTokens += Number(usage.total_tokens ?? usage.totalTokens ?? 0);
}

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function compactToolResult(name, result) {
  if (!result || typeof result !== "object") return result;
  const compact = {};
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
    "signature",
    "truncated",
    "path",
    "requestedPath",
    "bytesWritten",
    "status",
    "task_id",
    "mode",
    "stoppedReason",
  ]) {
    if (result[key] !== undefined) compact[key] = result[key];
  }
  if (result.activity) compact.activity = result.activity;
  if (result.usage) compact.usage = result.usage;
  if (result.files) compact.files = compactArray(result.files, 120);
  if (result.matches) compact.matches = compactArray(result.matches, 80);
  if (result.content !== undefined) compact.content = truncateText(result.content, 30000);
  if (result.failureSummary !== undefined) compact.failureSummary = truncateText(result.failureSummary, 12000);
  if (result.stdout !== undefined) compact.stdout = truncateText(result.stdout, 12000);
  if (result.stderr !== undefined) compact.stderr = truncateText(result.stderr, 12000);
  if (result.diff !== undefined) compact.diff = truncateText(result.diff, 20000);
  if (result.status !== undefined && name === "git_status") compact.status = truncateText(result.status, 8000);
  if (result.summary !== undefined) compact.summary = truncateText(result.summary, 4000);
  if (result.result !== undefined) compact.result = truncateText(result.result, 16000);
  return compact;
}

function compactArray(values, maxItems) {
  if (!Array.isArray(values) || values.length <= maxItems) return values;
  return [
    ...values.slice(0, maxItems),
    `... truncated ${values.length - maxItems} additional item${values.length - maxItems === 1 ? "" : "s"}`,
  ];
}

function truncateText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... truncated ${text.length - maxChars} additional characters`;
}

function messageChars(messages) {
  return messages.reduce((total, message) => total + String(message?.content ?? "").length, 0);
}

function toolTraceEvent({ step, name, args, result, durationMs }) {
  const activity = result?.activity ?? {};
  return {
    step,
    tool: name,
    target: activity.target ?? args?.path ?? args?.directory ?? args?.command ?? args?.query ?? "",
    ok: result?.ok !== false,
    code: result?.code ?? "",
    cached: Boolean(result?.cached),
    alreadyAvailable: Boolean(result?.alreadyAvailable || result?.code === "ALREADY_AVAILABLE"),
    additions: activity.additions ?? 0,
    deletions: activity.deletions ?? 0,
    error: result?.ok === false ? result?.error ?? "" : "",
    durationMs,
  };
}
