import { analyzeTaskCoordination } from "./coordination.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  buildAgentStateSummary,
  createAgentState,
  recordContextCompaction,
  recordModelStep,
  recordToolStep,
} from "./state.js";
import { CONTINUE_TRANSITIONS, TERMINAL_TRANSITIONS, continueTransition, terminalTransition } from "./transitions.js";
import { advanceWorkflowState, createWorkflowState } from "../harness/workflow.js";
import { createVerificationStateMachine } from "../verification/state.js";

const MAX_LIVE_MESSAGE_CHARS = 180000;
const RECENT_LIVE_MESSAGES = 10;

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
  onModelStart,
  onModelEnd,
  onToolStart,
  onToolEnd,
  onTextDelta,
  finalValidator,
  signal,
}) {
  const usage = emptyUsage();
  const coordination = analyzeTaskCoordination(task);
  const requestType = coordination.requestType;
  const trace = [];
  const transitions = [];
  const agentState = createAgentState({ task, cwd });
  const verification = createVerificationStateMachine();
  let workflow = advanceWorkflowState(createWorkflowState({ requestType }), { type: "planned" });
  let finalValidationAttempt = 0;
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(cwd, requestType, activeSkills, coordination),
    },
    ...contextMessages,
    {
      role: "user",
      content: task,
    },
  ];

  let step = 1;
  while (true) {
    throwIfAborted(signal);
    compactLiveMessages(messages, {
      protectedPrefixCount: 1 + contextMessages.length + 1,
      agentState,
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
          verification: verification.snapshot(),
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
        reviewReport: finalValidation?.report,
        reviewValidation: finalValidation,
        verification: verification.snapshot(),
        workflow,
      };
    }

    for (const call of message.tool_calls) {
      const name = call.function?.name;
      const args = parseToolArguments(call.function?.arguments);
      workflow = advanceWorkflowState(workflow, { type: "tool-start", tool: name, step });
      onToolStart?.({ name, args });
      throwIfAborted(signal);
      const toolStartedAt = Date.now();
      const result = await tools.execute(name, args, { signal });
      throwIfAborted(signal);
      const verificationState = verification.observeTool({ name, args, result, step });
      transitions.push(continueTransition(result?.ok === false ? CONTINUE_TRANSITIONS.TOOL_ERROR : CONTINUE_TRANSITIONS.TOOL_USE, { step, tool: name }));
      const toolEndedAt = Date.now();
      recordToolStep(agentState, { step, name, args, result, startedAt: toolStartedAt, endedAt: toolEndedAt });
      trace.push(toolTraceEvent({ step, name, args, result, durationMs: Math.max(0, toolEndedAt - toolStartedAt) }));
      onToolEnd?.({ name, args, result, verification: verificationState });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(compactToolResult(name, result)),
      });
    }
    step += 1;
  }
}

export function compactLiveMessages(messages, { protectedPrefixCount, agentState, step, maxChars = MAX_LIVE_MESSAGE_CHARS } = {}) {
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
  const summary = {
    role: "system",
    content: "Run state summary (local context compaction):\n" + buildAgentStateSummary(agentState),
  };
  messages.splice(0, messages.length, ...protectedMessages, summary, ...tail);
  if (agentState) {
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
  for (const key of ["ok", "code", "error", "recoverable", "suggestion", "cached", "truncated", "path", "requestedPath", "bytesWritten", "status", "task_id", "mode", "stoppedReason"]) {
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
    additions: activity.additions ?? 0,
    deletions: activity.deletions ?? 0,
    error: result?.ok === false ? result?.error ?? "" : "",
    durationMs,
  };
}
