import { analyzeTaskCoordination } from "./coordination.js";
import { buildSystemPrompt } from "./prompt.js";
import { CONTINUE_TRANSITIONS, TERMINAL_TRANSITIONS, continueTransition, terminalTransition } from "./transitions.js";

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
  signal,
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

  let step = 1;
  while (true) {
    throwIfAborted(signal);
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
      signal,
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
            "The model returned tool-call markup as plain text instead of a final answer. I stopped before showing that raw internal markup. Please continue with a narrower request.",
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
      throwIfAborted(signal);
      const result = await tools.execute(name, args, { signal });
      throwIfAborted(signal);
      transitions.push(continueTransition(result?.ok === false ? CONTINUE_TRANSITIONS.TOOL_ERROR : CONTINUE_TRANSITIONS.TOOL_USE, { step, tool: name }));
      trace.push(toolTraceEvent({ step, name, args, result }));
      onToolEnd?.({ name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(compactToolResult(name, result)),
      });
    }
    step += 1;
  }
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
