import { analyzeTaskCoordination } from "./coordination.js";
import { buildAgentSystemMessage } from "./initialContext.js";
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
  synchronizeWorkspaceRevision,
} from "../harness/processController.js";
import { advanceWorkflowState, createWorkflowState } from "../harness/workflow.js";
import { createVerificationStateMachine } from "../verification/state.js";
import { fenceUntrustedContent, markUntrustedToolResult } from "../harness/contentTrust.js";
import { estimateCostUsd } from "../harness/cost.js";
import { createMutex } from "../harness/mutex.js";
import { createQuarantine, projectUntrustedContent } from "../harness/quarantine.js";
import { linkSignals } from "../harness/budget.js";
import { compactToolResult } from "../tools/projection.js";
export { compactToolResult } from "../tools/projection.js";
import { appendEffects } from "../harness/effects.js";
import { buildBudgetedContext, buildContextBudget, contextWindowHint, estimateTokens, measureContextMessages } from "../context/builder.js";
import { randomUUID } from "node:crypto";
import { redact } from "../observability/audit.js";
import { applyContextCompaction, contextFingerprint, createContextState, isBalancedContextBoundary, planContextCompaction, snapshotContextState, syncContextState } from "../context/compaction.js";
import { projectModelRequest } from "../llm/requestSnapshot.js";

const MAX_LIVE_MESSAGE_CHARS = 180000;
const RECENT_LIVE_MESSAGES = 10;
const MAX_PARALLEL_DISPATCH = 4;
const LIVE_CONTEXT_STATES = new WeakMap();

export async function runAgent({
  client,
  tools,
  task,
  cwd,
  model,
  maxTokens,
  contextWindow,
  outputReserve,
  reasoningEffort,
  thinking,
  contextMessages = [],
  contextItems,
  activeSkills = [],
  stream = true,
  coordination: providedCoordination,
  maxSteps = 150,
  tokenBudget,
  deadline,
  costBudgetUsd,
  priceOverrides,
  reportTaskUsage = true,
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
  verificationPlan,
  signal,
}) {
  const taskBudget = client.taskBudget;
  const linkedSignal = linkSignals([signal, taskBudget?.signal]);
  signal = linkedSignal.signal;
  const quarantine = createQuarantine();
  const usage = resume?.usage ? { ...emptyUsage(), ...resume.usage } : emptyUsage();
  if (reportTaskUsage && resume?.usage && taskBudget && Object.values(taskBudget.snapshot()).every((value) => value === 0)) {
    taskBudget.record(resume.usage);
  }
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
  const verification = createVerificationStateMachine(resume?.verification, { plan: verificationPlan });
  const effects = Array.isArray(resume?.effects?.events) ? structuredClone(resume.effects.events) : [];
  const effectSnapshot = () => ({ version: 1, revision: tools.getWorkspaceRevision?.() ?? 0, events: [...effects] });
  let workflow = resume?.workflow
    ? structuredClone(resume.workflow)
    : advanceWorkflowState(createWorkflowState({ requestType }), { type: "planned" });
  let finalValidationAttempt = 0;
  let acceptance;
  let contextBudget = buildContextBudget({ contextWindow: contextWindow ?? client.capabilities?.contextWindow ?? 128000,
    outputReserve: Math.max(outputReserve ?? 0, maxTokens ?? outputReserve ?? client.capabilities?.outputReserve ?? 4096) });
  const systemMessage = buildAgentSystemMessage({ cwd, requestType, activeSkills, coordination, trustToolOutput });
  let initialContextMessages = contextMessages;
  if (!resume && contextItems) {
    try {
      const planning = client.prepareRequest ? await client.prepareRequest({ model, messages: [], tools: tools.schemas,
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        ...(thinking ? { thinking } : {}), ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }, { signal }) : undefined;
      const window = contextWindow ?? planning?.capabilities?.contextWindow ?? contextBudget.contextWindow;
      const reserve = Math.max(outputReserve ?? 0, planning?.request?.max_tokens ?? maxTokens ?? contextBudget.outputReserve);
      contextBudget = buildContextBudget({ contextWindow: window, outputReserve: reserve });
      initialContextMessages = buildBudgetedContext(contextItems, { contextWindow: window, outputReserve: reserve,
        reservedMessages: [systemMessage, { role: "user", content: task }], reservedTools: planning?.request?.tools ?? tools.schemas ?? [] }).messages;
    } catch (error) { linkedSignal.dispose(); throw error; }
  }
  // Resuming a prior run rehydrates its message history and step/usage counters; a fresh run
  // starts from the system prompt, injected context, and the task.
  const messages = Array.isArray(resume?.messages) && resume.messages.length
    ? resume.messages.slice()
    : [
        systemMessage,
        ...initialContextMessages,
        { role: "user", content: task },
      ];
  let contextState;
  try { contextState = createContextState(messages, { saved: resume?.contextState, legacy: !!resume && !resume.contextState }); }
  catch (error) { linkedSignal.dispose(); throw error; }
  const firstAssistant = messages.findIndex((message) => message.role === "assistant");
  contextState.protectedPrefixCount ??= resume ? firstAssistant < 0 ? messages.length : Math.max(1, firstAssistant) : 1 + initialContextMessages.length + 1;
  const contextSnapshot = () => snapshotContextState(contextState, messages);
  const compactionEvent = (transaction) => onEvent?.({ type: "context-compacted", step, transaction,
    liveMessageIds: [...contextState.liveMessageIds] });

  const currentUsage = () => reportTaskUsage && taskBudget ? taskBudget.snapshot() : { ...usage };
  const syncUsage = () => { agentState.usage = currentUsage(); };
  const finishRun = ({ finalText, stoppedReason, workflowType, extra = {} }) => {
    syncUsage();
    const process = snapshotProcessMetrics(processController);
    recordProcessSnapshot(agentState, process);
    return {
      finalText,
      messages,
      contextState: contextSnapshot(),
      steps: step,
      usage: currentUsage(),
      stoppedReason,
      transition: terminalTransition(stoppedReason ?? TERMINAL_TRANSITIONS.COMPLETED, { step }),
      transitions,
      trace,
      agentState,
      requestType,
      process,
      verification: verification.snapshot(),
      effects: effectSnapshot(),
      workflow: workflowType ? advanceWorkflowState(workflow, { type: workflowType, step }) : workflow,
      quarantine: quarantine.snapshot(),
      acceptance,
      ...extra,
    };
  };

  let step = Number.isFinite(resume?.step) ? resume.step + 1 : 1;
  try {
    while (true) {
      syncUsage();
      const sharedStop = taskBudget?.stopped();
      const budgetStop = sharedStop ?? evaluateBudgets({
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
      throwIfAborted(signal);
      compactLiveMessages(messages, {
        protectedPrefixCount: contextState.protectedPrefixCount,
        agentState,
        processController,
        step,
        contextState,
        onCompaction: compactionEvent,
        secretRegistry,
        maxEstimatedTokens: contextBudget.inputTokens - estimateTokens(tools.schemas ?? []),
      });
      let request = {
        model,
        messages,
        tools: tools.schemas,
        tool_choice: "auto",
        max_tokens: maxTokens,
      };
      if (thinking) request.thinking = thinking;
      if (reasoningEffort) request.reasoning_effort = reasoningEffort;
      let prepared = client.prepareRequest ? await client.prepareRequest(request, { signal }) : undefined;
      if (prepared) {
        contextBudget = buildContextBudget({ contextWindow: contextWindow ?? prepared.capabilities.contextWindow,
          outputReserve: Math.max(outputReserve ?? 0, prepared.effectiveConfig.maxTokens) });
        if (measureContextMessages(messages) + estimateTokens(prepared.request.tools ?? []) > contextBudget.inputTokens) {
          compactLiveMessages(messages, {
            protectedPrefixCount: contextState.protectedPrefixCount,
            agentState, processController, step, contextState, onCompaction: compactionEvent, secretRegistry,
            maxEstimatedTokens: contextBudget.inputTokens - estimateTokens(prepared.request.tools ?? []),
          });
          prepared = await client.prepareRequest({ ...request, messages }, { signal });
        }
        request = prepared.request;
      }
      const inputTokens = measureContextMessages(request.messages) + estimateTokens(request.tools ?? []);
      if (inputTokens > contextBudget.inputTokens) throw Object.assign(new Error("Required instructions, task, tools and current observations exceed the configured context window."
        + contextWindowHint({ contextWindow: contextBudget.contextWindow, contextWindowSource: contextWindow === undefined ? prepared?.capabilities.contextWindowSource : "configured" })),
        { code: "CONTEXT_BUDGET_EXCEEDED", contextBudget, estimatedInputTokens: inputTokens });
      if (prepared) onEvent?.({ type: "request-prepared", step, routeIdentity: prepared.routeIdentity,
        requestFingerprint: prepared.requestFingerprint, effectiveConfig: prepared.effectiveConfig, estimatedInputTokens: inputTokens });

      syncContextState(contextState, messages);
      const attemptId = "attempt_" + randomUUID();
      const requestSnapshot = projectModelRequest(request, { filterText: (text) => redact(text, { secretRegistry, maxTextChars: Infinity }) });
      onEvent?.({ type: "model-attempt-start", step, attemptId, request: requestSnapshot,
        requestHash: contextFingerprint(requestSnapshot), requestFingerprint: prepared?.requestFingerprint, messageIds: [...contextState.liveMessageIds],
        routeIdentity: prepared?.routeIdentity, effectiveConfig: prepared?.effectiveConfig ?? { source: "unprepared-client",
          contextWindow: contextBudget.contextWindow, outputReserve: contextBudget.outputReserve } });

      workflow = advanceWorkflowState(workflow, { type: "model-start", step });
      onModelStart?.({ step });
      const modelStartedAt = Date.now();
      let firstTokenAt;
      let completion;
      try { completion = await requestChatCompletion({
        client,
        request,
        prepared,
        stream,
        onTextDelta: (delta) => {
          if (firstTokenAt === undefined) { firstTokenAt = Date.now(); onEvent?.({ type: "first-token", step, latencyMs: firstTokenAt - modelStartedAt }); }
          onTextDelta?.(delta);
        },
        onRuntimeEvent: (event) => onEvent?.({ ...event, step, attemptId }),
        onModelEnd,
        step,
        signal,
      }); } catch (error) {
        onEvent?.({ type: "model-attempt-end", step, attemptId, outcome: signal?.aborted ? "interrupted" : "failed",
          reportedUsage: error?.usage, usageKnown: false, errorCode: error?.code ?? error?.name ?? "MODEL_REQUEST_FAILED", durationMs: Date.now() - modelStartedAt });
        throw error;
      }
      onEvent?.({ type: "model-attempt-end", step, attemptId, outcome: "completed", usage: completion.usage, usageKnown: !!completion.usage, durationMs: Date.now() - modelStartedAt });
      addUsage(usage, completion.usage);
      onEvent?.({ type: "model-call", step, attemptId, usage: completion.usage, durationMs: Date.now() - modelStartedAt, estimatedInputTokens: inputTokens });

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

      syncUsage();
      const completedBudgetStop = taskBudget?.stopped();
      if (completedBudgetStop) {
        return finishRun({ finalText: completedBudgetStop.message, stoppedReason: completedBudgetStop.reason, workflowType: "failed", extra: { budget: completedBudgetStop } });
      }
      throwIfAborted(signal);
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
          effects: effectSnapshot(),
          workflow,
          process,
          attempt: finalValidationAttempt,
        });
        acceptance = finalValidation?.acceptance;
        if (finalValidation?.ok && finalValidation.verificationDecision?.status === "unverified-with-reason") {
          verification.skip(finalValidation.verificationDecision.reason);
        }
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
            contextState: contextSnapshot(),
            steps: step,
            usage: currentUsage(),
            stoppedReason: TERMINAL_TRANSITIONS.PSEUDO_TOOL_CALL_TEXT,
            transition: terminalTransition(TERMINAL_TRANSITIONS.PSEUDO_TOOL_CALL_TEXT, { step }),
            transitions,
            trace,
            agentState,
            requestType,
            process,
            verification: verification.snapshot(),
            effects: effectSnapshot(),
            quarantine: quarantine.snapshot(),
            workflow: advanceWorkflowState(workflow, { type: "failed", step }),
          };
        }
        const failedReason = finalValidation?.reason ?? TERMINAL_TRANSITIONS.REVIEW_SCHEMA_INVALID;
        workflow = advanceWorkflowState(workflow, { type: finalValidation?.ok === false ? "failed" : "completed", step });
        return {
          finalText,
          messages,
          contextState: contextSnapshot(),
          steps: step,
          usage: currentUsage(),
          stoppedReason: finalValidation?.ok === false ? failedReason : undefined,
          transition: terminalTransition(finalValidation?.ok === false ? failedReason : TERMINAL_TRANSITIONS.COMPLETED, { step }),
          transitions,
          trace,
          agentState,
          requestType,
          process,
          reviewReport: finalValidation?.report,
          reviewValidation: finalValidation,
          acceptance,
          verification: verification.snapshot(),
          effects: effectSnapshot(),
          quarantine: quarantine.snapshot(),
          workflow,
        };
      }

      const evaluated = message.tool_calls.map((call) => {
        const name = call.function?.name;
        const parsedArguments = parseToolArguments(call.function?.arguments);
        const args = parsedArguments.args;
        workflow = advanceWorkflowState(workflow, { type: "tool-start", tool: name, step });
        // Decide immediately before execution so earlier tools in this turn can
        // invalidate cached observations. Evaluate and count each call once.
        const decision = { action: "pending", reasons: [] };
        const lane = name === "agent" ? "dispatch:" + call.id : undefined;
        return { call, name, args, argumentError: parsedArguments.error, decision, lane };
      });

      const runOne = async (item) => {
        const sharedStop = taskBudget?.stopped();
        if (sharedStop) throw Object.assign(new Error(sharedStop.message), { budget: sharedStop });
        throwIfAborted(signal);
        synchronizeWorkspaceRevision(processController, tools.getWorkspaceRevision?.());
        // Earlier tools in this same model turn may have changed the workspace.
        item.decision = evaluateToolCall(processController, { name: item.name, args: item.args, step, lane: item.lane });
        onToolStart?.({ name: item.name, args: item.args, decision: item.decision });
        const startedAt = Date.now();
        const result = item.argumentError
          ? {
              ok: false,
              code: "INVALID_TOOL_ARGUMENTS",
              error: "Tool arguments were incomplete or invalid JSON. Retry with one complete, valid JSON object.",
              recoverable: true,
            }
          : item.decision.action === "short_circuit"
            ? item.decision.result
            : await tools.execute(item.name, item.args, { signal });
        if (!taskBudget && ["agent", "send_message"].includes(item.name) && item.decision.action !== "short_circuit") {
          addUsage(usage, result?.usage);
        }
        const endedAt = Date.now();
        // One event boundary updates all projections, including effects completed
        // just before cancellation. Worker prose is never used for these facts.
        const verificationState = await recordMutex.run(() => {
          appendEffects(effects, result);
          recordToolObservation(processController, { name: item.name, args: item.args, result, step, lane: item.lane });
          const state = verification.observeTool({ name: item.name, args: item.args, result, step });
          transitions.push(continueTransition(result?.ok === false ? CONTINUE_TRANSITIONS.TOOL_ERROR : CONTINUE_TRANSITIONS.TOOL_USE, { step, tool: item.name }));
          recordToolStep(agentState, { step, name: item.name, args: item.args, result, startedAt, endedAt });
          trace.push(toolTraceEvent({ step, name: item.name, args: item.args, result, durationMs: Math.max(0, endedAt - startedAt) }));
          return state;
        });
        throwIfAborted(signal);
        return { ...item, result, startedAt, endedAt, verificationState };
      };

      // Read-only dispatches may overlap. The Worker runtime serializes all
      // potentially writing workers that share this workspace.
      const executedById = new Map();
      for (const item of evaluated.filter((item) => !isParallelDispatch(item))) {
        executedById.set(item.call.id, await runOne(item));
      }
      for (const executed of await mapWithConcurrency(evaluated.filter(isParallelDispatch), MAX_PARALLEL_DISPATCH, runOne)) {
        executedById.set(executed.call.id, executed);
      }

      for (const item of evaluated) {
        const { name, args, result, verificationState } = executedById.get(item.call.id);
        const transport = (value, preview = false) => {
          const marked = trustToolOutput ? markUntrustedToolResult(name, value)
            : { result: value, scan: { suspicious: false, reasons: [] } };
          let content = marked.result;
          if (trustToolOutput && marked.scan.suspicious) content = quarantineSuspiciousResult(name, content, quarantine, { preview });
          if (secretRegistry) content = redactResultSecrets(content, secretRegistry);
          return { result: content, scan: marked.scan };
        };
        const compacted = tools.projectResult
          ? await tools.projectResult(name, result, { secretRegistry, maxBytes: Math.max(1024, Math.min(16000, Math.floor(contextBudget.inputTokens / 8))),
            measure: (value) => Buffer.byteLength(JSON.stringify(transport(value, true).result)) })
          : compactToolResult(name, result);
        const { result: trustedResult, scan } = transport(compacted);
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
      syncUsage();
      await onCheckpoint?.(serializeRunState({
        step,
        messages,
        contextState: contextSnapshot(),
        usage: currentUsage(),
        workflow,
        process: snapshotProcessMetrics(processController),
        processController: serializeProcessController(processController),
        requestType,
        trace,
        transitions,
        agentState,
        verification: verification.snapshot(),
        effects: effectSnapshot(),
      }));
      step += 1;
    }
  } catch (error) {
    if (error?.usage) addUsage(usage, error.usage);
    syncUsage();
    const stopped = taskBudget?.stopped();
    if (stopped) {
      return finishRun({ finalText: stopped.message, stoppedReason: stopped.reason, workflowType: "failed", extra: { budget: stopped } });
    }
    if (error && typeof error === "object") {
      error.agentUsage = { ...usage };
      error.effects = effectSnapshot();
      let savedContext;
      try { savedContext = contextSnapshot(); }
      catch (snapshotError) {
        savedContext = snapshotContextState(contextState);
        error.contextSnapshotError = { code: snapshotError.code ?? "CONTEXT_SNAPSHOT_FAILED", message: snapshotError.message };
      }
      error.runSnapshot = serializeRunState({ step, messages, contextState: savedContext, usage: currentUsage(), workflow, trace, transitions, agentState, acceptance, verification: verification.snapshot(), effects: effectSnapshot(), processController: serializeProcessController(processController) });
    }
    throw error;
  } finally {
    linkedSignal.dispose();
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

export function serializeRunState({ step, messages, contextState, usage, workflow, process, processController, requestType, trace, transitions, agentState, verification, effects, acceptance }) {
  return {
    version: 1,
    at: new Date().toISOString(),
    step,
    requestType,
    status: workflow?.status,
    phase: workflow?.phase,
    messages: Array.isArray(messages) ? structuredClone(messages) : undefined,
    contextState: contextState ? structuredClone(contextState) : undefined,
    usage: { ...usage },
    workflow: workflow ? structuredClone(workflow) : undefined,
    process: process ? { ...process } : undefined,
    processController: processController ? structuredClone(processController) : undefined,
    trace: Array.isArray(trace) ? structuredClone(trace) : [],
    transitions: Array.isArray(transitions) ? structuredClone(transitions) : [],
    agentState: agentState ? structuredClone(agentState) : undefined,
    verification: verification ? structuredClone(verification) : undefined,
    effects: effects ? structuredClone(effects) : undefined,
    acceptance: acceptance ? structuredClone(acceptance) : undefined,
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
  { protectedPrefixCount, agentState, processController, step, contextState, onCompaction, secretRegistry,
    maxChars = MAX_LIVE_MESSAGE_CHARS, maxEstimatedTokens = Infinity } = {},
) {
  if (protectedPrefixCount !== undefined && (!Number.isSafeInteger(protectedPrefixCount) || protectedPrefixCount < 1)
    || typeof maxChars !== "number" || Number.isNaN(maxChars) || maxChars < 0
    || typeof maxEstimatedTokens !== "number" || Number.isNaN(maxEstimatedTokens)) throw Object.assign(new Error("Invalid context compaction budget or prefix."), { code: "COMPACTION_RANGE_INVALID" });
  const state = contextState ?? LIVE_CONTEXT_STATES.get(messages) ?? createContextState(messages);
  LIVE_CONTEXT_STATES.set(messages, state);
  syncContextState(state, messages);
  const beforeChars = messageChars(messages);
  if (beforeChars <= maxChars && measureContextMessages(messages) <= maxEstimatedTokens) return false;
  const beforeMessages = messages.length;
  let safePrefixCount = Math.max(1, Math.min(protectedPrefixCount ?? state.protectedPrefixCount ?? 1, messages.length));
  while (safePrefixCount > 1 && !isBalancedContextBoundary(messages, safePrefixCount)) safePrefixCount--;
  if (!isBalancedContextBoundary(messages, safePrefixCount)) return false;
  let end = Math.max(safePrefixCount, messages.length - RECENT_LIVE_MESSAGES);
  while (end > safePrefixCount && !isBalancedContextBoundary(messages, end)) end--;
  const bodies = compactionSummaryBodies(agentState, processController, messages.slice(safePrefixCount));
  let selected;
  for (;;) {
    if (end > safePrefixCount && isBalancedContextBoundary(messages, end)) {
      for (const content of bodies) {
        const body = redact(projectUntrustedContent(content).safe, { secretRegistry, maxTextChars: Infinity });
        const replacement = { role: "user", content: fenceUntrustedContent("context-compaction", body).text };
        let proposal;
        try { proposal = planContextCompaction({ messages, contextState: state, start: safePrefixCount, end, replacement,
          protectedPrefixCount: safePrefixCount }); }
        catch (error) { if (["COMPACTION_NO_PROGRESS", "COMPACTION_UNBALANCED_TOOLS"].includes(error.code)) continue; throw error; }
        const next = [...messages.slice(0, safePrefixCount), replacement, ...messages.slice(end)];
        if (!selected || proposal.afterTotalEstimate < selected.afterTotalEstimate) selected = proposal;
        if (messageChars(next) <= maxChars && proposal.afterTotalEstimate <= maxEstimatedTokens) { selected = proposal; break; }
      }
      if (selected && messageChars([...messages.slice(0, selected.start), selected.replacement, ...messages.slice(selected.end)]) <= maxChars
        && selected.afterTotalEstimate <= maxEstimatedTokens) break;
    }
    if (end >= messages.length) break;
    end++;
    while (end < messages.length && !isBalancedContextBoundary(messages, end)) end++;
  }
  if (!selected) return false;
  const transaction = applyContextCompaction(state, messages, selected);
  if (agentState) {
    if (processController) recordProcessSnapshot(agentState, snapshotProcessMetrics(processController));
    recordContextCompaction(agentState, { beforeMessages, afterMessages: messages.length, beforeChars,
      afterChars: messageChars(messages), step, transaction });
  }
  onCompaction?.(structuredClone(transaction));
  return true;
}

function compactionSummaryBodies(agentState, processController, source) {
  const heading = "Run state summary (local context compaction):";
  const full = [heading, agentState ? buildAgentStateSummary(agentState) : "No execution state recorded."];
  if (processController) full.push("", buildWorkingSetSummary(processController));
  const observations = (agentState?.observations ?? []).filter((entry) => entry.type !== "context-compaction").slice(-3)
    .map((entry) => String(entry.summary ?? "").slice(0, 120));
  const compact = [heading, ...observations];
  if (processController) {
    compact.push("Working-set observations:");
    const files = [...processController.workingSet.files.values()].slice(-1);
    for (const file of files) compact.push(String(file.path) + ": " + String(file.content).slice(0, 120));
  }
  const refs = [];
  for (const message of source) {
    if (message.role !== "tool") continue;
    try {
      const value = JSON.parse(message.content);
      if (/^out_[A-Za-z0-9_-]{32}$/.test(value.outputRef ?? "")) refs.push("outputRef=" + value.outputRef);
      if (typeof value.jobId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.jobId)) refs.push("jobId=" + value.jobId);
    } catch { /* non-JSON historical text remains in the source transcript */ }
  }
  const retained = [...new Set(refs)].slice(-8);
  if (retained.length) {
    const line = "Retained output references: " + retained.join(", ");
    full.push(line); compact.push(line);
  }
  return [full.join("\n"), compact.join("\n")];
}

async function requestChatCompletion({
  client,
  request,
  prepared,
  stream,
  onTextDelta,
  onModelEnd,
  step,
  onRuntimeEvent,
  finalizing = false,
  signal,
}) {
  try {
    if (prepared) return await prepared.dispatch({ stream: stream && typeof client.chatCompletionStream === "function", signal,
      onContent: (content) => onTextDelta?.({ content, step, finalizing }), onRuntimeEvent });
    if (stream && typeof client.chatCompletionStream === "function") {
      return await client.chatCompletionStream(request, {
        signal,
        onContent: (content) => onTextDelta?.({ content, step, finalizing }),
        onRuntimeEvent,
      });
    }
    return await client.chatCompletion(request, { signal, onRuntimeEvent });
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

function quarantineSuspiciousResult(name, result, quarantine, { preview = false } = {}) {
  const ids = [];
  const walk = (value, path = "") => {
    if (typeof value === "string") {
      const projection = projectUntrustedContent(value);
      if (!projection.withheld.length) return value;
      // Size checks must be pure: only the final projection commits quarantine
      // entries. Include this result's references rather than the entire run's.
      const held = preview ? { ...projection, id: "q" + (quarantine.size() + ids.length + 1) }
        : quarantine.store(value, { tool: name, field: path });
      ids.push(held.id);
      return `[quarantined ${held.id}: ${held.withheld.length} instruction-like line(s) withheld; inert projection below]\n` + held.safe;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}.${index}`));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      ["effects", "workspaceRevision", "provenance", "injectionSuspected"].includes(key) ? item : walk(item, path ? `${path}.${key}` : key)]));
  };
  const next = walk(result);
  if (next && typeof next === "object" && ids.length) next.quarantined = ids;
  return next;
}

function redactResultSecrets(result, secretRegistry) {
  if (typeof result === "string") return secretRegistry.redact(result);
  if (Array.isArray(result)) return result.map((value) => redactResultSecrets(value, secretRegistry));
  if (!result || typeof result !== "object") return result;
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, redactResultSecrets(value, secretRegistry)]));
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
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, runner));
  const failed = settled.find((entry) => entry.status === "rejected");
  if (failed) throw failed.reason;
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
  const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  total.promptTokens += prompt;
  total.completionTokens += completion;
  total.totalTokens += Number(usage.total_tokens ?? usage.totalTokens ?? prompt + completion);
}

function parseToolArguments(value) {
  if (!value) return { args: {}, error: "missing tool arguments" };
  if (typeof value === "object") return { args: value };
  try {
    const args = JSON.parse(value);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { args: {}, error: "tool arguments must be a JSON object" };
    }
    return { args };
  } catch (error) {
    return { args: {}, error: error instanceof Error ? error.message : "invalid JSON" };
  }
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
