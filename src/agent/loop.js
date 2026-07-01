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
  projectSkills = [],
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
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(cwd, requestType, projectSkills, coordination),
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
            "The model returned tool-call markup as plain text instead of a final answer. I stopped before showing that raw internal markup. Please continue with a narrower request, or increase DEEPCODE_MAX_STEPS if the task requires more tool rounds.",
          messages,
          steps: step,
          usage,
          stoppedReason: "pseudo_tool_call_text",
          trace,
          requestType,
        };
      }
      return {
        finalText: message.content || "Done.",
        messages,
        steps: step,
        usage,
        trace,
        requestType,
      };
    }

    for (const call of message.tool_calls) {
      const name = call.function?.name;
      const args = parseToolArguments(call.function?.arguments);
      onToolStart?.({ name, args });
      const result = await tools.execute(name, args);
      trace.push(toolTraceEvent({ step, name, args, result }));
      onToolEnd?.({ name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

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
        stoppedReason: "max_steps_finalized",
        trace,
        requestType,
      };
    }
  } catch {
    // Fall back to a local explanation below if the finalization request fails.
  }

  return {
    finalText: `Stopped after ${maxSteps} agent steps without a final response. The model kept requesting tools until the local step guard was reached, or returned tool-call markup instead of a readable final answer. Increase DEEPCODE_MAX_STEPS or ask a narrower task to continue.`,
    messages,
    steps: maxSteps,
    usage,
    stoppedReason: "max_steps",
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

export function analyzeTaskCoordination(task) {
  const requestType = classifyRequest(task);
  const basis = coordinationBasis(task, requestType);
  const complex = basis.length >= 2 || String(task ?? "").length > 180;
  return {
    requestType,
    complex,
    basis,
    agents: complex ? coordinationAgents(requestType) : [],
  };
}

function classifyRequest(task) {
  const text = String(task ?? "").toLowerCase();
  if (/(报错|错误|失败|bug|debug|修复|fix|failed|error|crash|异常)/i.test(text)) return "debug";
  if (/(修改|新增|实现|继续|完善|改造|搭建|接入|add|implement|update|change|refactor|build)/i.test(text)) {
    return "edit";
  }
  if (/(review|审查|评审|code review|风险|隐患)/i.test(text)) return "review";
  if (/(解释|说明|分析|为什么|架构|方案|路径|是否合理|how|why|explain|analy[sz]e|architecture)/i.test(text)) {
    return "analysis";
  }
  if (/(运行|执行|命令|run|command|测试|test|验证|check)/i.test(text)) return "command";
  return "general";
}

function buildSystemPrompt(cwd, requestType, projectSkills = [], coordination) {
  return `You are DeepCode, a local coding agent running inside a CLI harness.

Workspace:
- cwd: ${cwd}
- request type: ${requestType}
${formatProjectSkills(projectSkills)}

Global rules:
- You cannot access files directly. Use tools to inspect the workspace.
- Do not assume unseen code.
- Keep changes minimal and explain what you need before risky actions.
- Prefer list_files, search_text, read_file, git_status, and git_diff before run_shell.
- Use edit_file for precise replacements and write_file when creating or replacing a full file.
- Tool errors are observations, not task-ending failures.
- If a tool result has code "ENOENT" or recoverable true, the path was probably guessed incorrectly. Continue by using list_files on a known parent directory or search_text from the workspace root, then retry with the discovered path.
- Do not stop the task solely because one file or directory path was missing.
- Shell commands are guarded by the local harness.
- File edits are guarded by the local harness and require confirmation.
- Never request secrets or read .env files.
- Do not reveal hidden chain-of-thought. When useful, give short visible progress notes that summarize what you are checking or changing.
- Treat visible progress as concise action summaries, not private reasoning.
- Do not emit internal tool-call markup as plain text.
- Avoid repeating the same read/search when the tool observation already answered it.

Request-type protocol:
${requestTypeProtocol(requestType)}

Complex-task coordination:
${coordinationProtocol(coordination)}

Final response format:
- For edit/debug tasks: summarize problem, changes, reason, verification, remaining risks, and next steps.
- For review tasks: list findings first with evidence, then open questions and test gaps.
- For analysis tasks: explain architecture, tradeoffs, and recommended path without claiming files were changed.
- For command tasks: report command outcome and relevant output summary.
- Keep the final answer concise and readable in a terminal.`;
}

function coordinationProtocol(coordination) {
  if (!coordination?.complex) {
    return "- This task is not classified as complex. Use the narrowest single-agent workflow.";
  }
  const basis = coordination.basis.map((item) => `  - ${item}`).join("\n");
  const agents = coordination.agents.map((agent) => `  - ${agent.name}: ${agent.goal}`).join("\n");
  return [
    "- This task is classified as complex.",
    "- Before substantial tool work, provide a concise visible coordination note with split basis and agent/subagent goals.",
    "- Do not reveal hidden chain-of-thought; describe coordination and observable work only.",
    "- If the runtime cannot execute subagents in parallel, coordinate these roles sequentially within the current agent.",
    "- Split basis:",
    basis,
    "- Candidate agents/subagents:",
    agents,
  ].join("\n");
}

function formatProjectSkills(projectSkills) {
  if (!projectSkills.length) return "- project skills: none";
  const lines = projectSkills.slice(0, 20).map((skill) => {
    return `  - ${skill.name}: ${skill.summary} (${skill.relativePath})`;
  });
  return ["- project skills available:", ...lines].join("\n");
}

function requestTypeProtocol(requestType) {
  const protocols = {
    edit: [
      "- Inspect relevant files before editing.",
      "- Use edit_file/write_file only after the relevant current content is known.",
      "- After edits, run the most focused available validation command when practical.",
      "- If validation cannot run, say exactly why.",
    ],
    debug: [
      "- Reproduce or inspect the failure signal first.",
      "- Locate the smallest relevant code path before editing.",
      "- Apply a targeted fix and run a regression check when practical.",
      "- Call out any remaining uncertainty.",
    ],
    review: [
      "- Use a code-review stance.",
      "- Prioritize bugs, regressions, security, edge cases, and missing tests.",
      "- Do not edit files unless the user explicitly asks for fixes.",
    ],
    analysis: [
      "- Prefer explanation and architecture guidance over file edits.",
      "- Use tools only when local project facts are needed.",
      "- Separate facts observed from recommendations inferred.",
    ],
    command: [
      "- Run or inspect only the command-relevant path.",
      "- Summarize important output; do not dump noisy logs unless needed.",
    ],
    general: [
      "- Choose the narrowest workflow that satisfies the user request.",
      "- Ask for clarification only when a reasonable safe default is not possible.",
    ],
  };
  return (protocols[requestType] ?? protocols.general).join("\n");
}

function coordinationBasis(task, requestType) {
  const text = String(task ?? "");
  const basis = [];
  const clauseCount = text.split(/[，,；;。.\n]+/).map((part) => part.trim()).filter(Boolean).length;
  if (clauseCount >= 3) basis.push("request contains multiple distinct requirements");
  if (text.length > 180) basis.push("request is long enough to benefit from staged coordination");
  if (/(修改|新增|实现|改造|接入|完善|edit|write|implement|refactor|build)/i.test(text)) {
    basis.push("task may require code changes");
  }
  if (/(验证|测试|运行|check|test|verify|run)/i.test(text)) {
    basis.push("task asks for validation or command execution");
  }
  if (/(架构|方案|路径|隐患|风险|architecture|risk|design)/i.test(text)) {
    basis.push("task includes architecture, risk, or design reasoning");
  }
  if (/(subagent|agent|并行|拆分|协调|parallel)/i.test(text)) {
    basis.push("task explicitly mentions agent decomposition or parallel work");
  }
  if ((requestType === "edit" || requestType === "debug") && basis.length === 1) {
    basis.push("edit/debug work benefits from separate inspect, implement, and verify phases");
  }
  return [...new Set(basis)];
}

function coordinationAgents(requestType) {
  const common = [
    {
      name: "Inspector",
      goal: "identify relevant files, existing patterns, constraints, and prior observations before edits",
    },
    {
      name: "Verifier",
      goal: "run or define focused validation and report failures, uncertainty, and residual risk",
    },
  ];
  if (requestType === "review") {
    return [
      {
        name: "Reviewer",
        goal: "find bugs, regressions, edge cases, security issues, and missing tests with file-level evidence",
      },
      {
        name: "Risk Assessor",
        goal: "rank findings by severity and separate confirmed issues from assumptions",
      },
    ];
  }
  if (requestType === "analysis") {
    return [
      {
        name: "Architect",
        goal: "evaluate implementation paths, tradeoffs, and boundaries without making code changes",
      },
      {
        name: "Risk Assessor",
        goal: "identify hidden assumptions, future migration costs, and validation strategy",
      },
    ];
  }
  if (requestType === "command") {
    return [
      {
        name: "Command Runner",
        goal: "execute the requested command or focused diagnostics and capture meaningful output",
      },
      ...common.slice(1),
    ];
  }
  return [
    common[0],
    {
      name: "Implementer",
      goal: "apply minimal scoped changes consistent with existing project patterns",
    },
    common[1],
  ];
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

function buildFinalizationPrompt({ requestType, trace, maxSteps }) {
  const traceSummary = trace.length
    ? trace
        .slice(-20)
        .map((event) => {
          const changes =
            event.additions || event.deletions ? ` +${event.additions ?? 0} -${event.deletions ?? 0}` : "";
          const status = event.ok ? "ok" : `failed ${event.error}`;
          return `- step ${event.step}: ${event.tool} ${event.target || "."}${changes} (${status})`;
        })
        .join("\n")
    : "- no tools completed";
  return `The local agent reached its tool step limit (${maxSteps}). Do not call tools.
Request type: ${requestType}
Recent tool trace:
${traceSummary}

Give the user a concise final response describing what was completed, what is still pending, verification status, remaining risks, and how to continue.`;
}
