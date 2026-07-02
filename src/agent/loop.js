import { analyzeTaskCoordination } from "./coordination.js";
import { buildFinalizationPrompt, buildSystemPrompt } from "./prompt.js";
import { CONTINUE_TRANSITIONS, TERMINAL_TRANSITIONS, continueTransition, terminalTransition } from "./transitions.js";

export async function runAgent({
  client,
  tools,
  task,
  cwd,
  maxSteps,
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
}) {
  const usage = emptyUsage();
  const coordination = analyzeTaskCoordination(task);
  const requestType = coordination.requestType;
  const trace = [];
  const transitions = [];
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

  for (let step = 1; step <= maxSteps; step += 1) {
    const request = {
      model,
      messages,
      tools: tools.schemas,
      tool_choice: "auto",
      max_tokens: maxTokens,
    };
    if (thinking) request.thinking = thinking;
    if (reasoningEffort) request.reasoning_effort = reasoningEffort;

    onModelStart?.({ step });
    const completion = await requestChatCompletion({
      client,
      request,
      stream,
      onTextDelta,
      onModelEnd,
      step,
    });
    addUsage(usage, completion.usage);

    const message = completion.choices?.[0]?.message;
    if (!message) {
      throw new Error("DeepSeek returned no message.");
    }

    messages.push(message);

    if (!message.tool_calls?.length) {
      if (looksLikePseudoToolCall(message.content)) {
        return {
          finalText:
            "The model returned tool-call markup as plain text instead of a final answer. I stopped before showing that raw internal markup. Please continue with a narrower request, or increase DEECOO_MAX_STEPS if the task requires more tool rounds.",
          messages,
          steps: step,
          usage,
          stoppedReason: TERMINAL_TRANSITIONS.PSEUDO_TOOL_CALL_TEXT,
          transition: terminalTransition(TERMINAL_TRANSITIONS.PSEUDO_TOOL_CALL_TEXT, { step }),
          transitions,
          trace,
          requestType,
        };
      }
      return {
        finalText: message.content || "Done.",
        messages,
        steps: step,
        usage,
        transition: terminalTransition(TERMINAL_TRANSITIONS.COMPLETED, { step }),
        transitions,
        trace,
        requestType,
      };
    }

    for (const call of message.tool_calls) {
      const name = call.function?.name;
      const args = parseToolArguments(call.function?.arguments);
      onToolStart?.({ name, args });
      const result = await tools.execute(name, args);
      transitions.push(continueTransition(result?.ok === false ? CONTINUE_TRANSITIONS.TOOL_ERROR : CONTINUE_TRANSITIONS.TOOL_USE, { step, tool: name }));
      trace.push(toolTraceEvent({ step, name, args, result }));
      onToolEnd?.({ name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  transitions.push(continueTransition(CONTINUE_TRANSITIONS.FINALIZE_AFTER_MAX_STEPS, { step: maxSteps }));
  return await forceFinalResponse({
    client,
    model,
    messages,
    maxTokens,
    reasoningEffort,
    thinking,
    maxSteps,
    usage,
    trace,
    transitions,
    requestType,
    onModelStart,
    onModelEnd,
    onTextDelta,
  });
}

async function forceFinalResponse({
  client,
  model,
  messages,
  maxTokens,
  reasoningEffort,
  thinking,
  maxSteps,
  usage,
  trace = [],
  transitions = [],
  requestType = "general",
  onModelStart,
  onModelEnd,
  onTextDelta,
}) {
  const finalMessages = [
    ...messages,
    {
      role: "system",
      content: buildFinalizationPrompt({ requestType, trace, maxSteps }),
    },
  ];
  const request = {
    model,
    messages: finalMessages,
    max_tokens: maxTokens,
  };
  if (thinking) request.thinking = thinking;
  if (reasoningEffort) request.reasoning_effort = reasoningEffort;

  onModelStart?.({ step: maxSteps + 1, finalizing: true });
  try {
    const completion = await requestChatCompletion({
      client,
      request,
      stream: Boolean(onTextDelta),
      onTextDelta,
      onModelEnd,
      step: maxSteps + 1,
      finalizing: true,
    });
    addUsage(usage, completion.usage);
    const message = completion.choices?.[0]?.message;
    if (message?.content && !looksLikePseudoToolCall(message.content)) {
      finalMessages.push(message);
      return {
        finalText: message.content,
        messages: finalMessages,
        steps: maxSteps,
        usage,
        stoppedReason: TERMINAL_TRANSITIONS.MAX_STEPS_FINALIZED,
        transition: terminalTransition(TERMINAL_TRANSITIONS.MAX_STEPS_FINALIZED, { step: maxSteps }),
        transitions,
        trace,
        requestType,
      };
    }
  } catch {
    // Fall back to a local explanation below if the finalization request fails.
  }

  return {
    finalText: `Stopped after ${maxSteps} agent steps without a final response. The model kept requesting tools until the local step guard was reached, or returned tool-call markup instead of a readable final answer. Increase DEECOO_MAX_STEPS or ask a narrower task to continue.`,
    messages,
    steps: maxSteps,
    usage,
    stoppedReason: TERMINAL_TRANSITIONS.MAX_STEPS,
    transition: terminalTransition(TERMINAL_TRANSITIONS.MAX_STEPS, { step: maxSteps }),
    transitions,
    trace,
    requestType,
  };
}

async function requestChatCompletion({
  client,
  request,
  stream,
  onTextDelta,
  onModelEnd,
  step,
  finalizing = false,
}) {
  try {
    if (stream && typeof client.chatCompletionStream === "function") {
      return await client.chatCompletionStream(request, {
        onContent: (content) => onTextDelta?.({ content, step, finalizing }),
      });
    }
    return await client.chatCompletion(request);
  } finally {
    onModelEnd?.({ step, finalizing });
  }
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

function toolTraceEvent({ step, name, args, result }) {
  const activity = result?.activity ?? {};
  return {
    step,
    tool: name,
    target: activity.target ?? args?.path ?? args?.directory ?? args?.command ?? args?.query ?? "",
    ok: result?.ok !== false,
    cached: Boolean(result?.cached),
    additions: activity.additions ?? 0,
    deletions: activity.deletions ?? 0,
    error: result?.ok === false ? result?.error ?? "" : "",
  };
}
