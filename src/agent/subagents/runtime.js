import { randomUUID } from "node:crypto";
import { runAgent } from "../loop.js";
import { normalizeWorkerMode } from "../../tools/definitions.js";
import { linkSignals } from "../../harness/budget.js";
import { createMutex } from "../../harness/mutex.js";
import { contextItem } from "../../context/builder.js";

const MAX_WORKER_PROMPT_CHARS = 8000;
const MAX_WORKERS_PER_TASK = 8;
const MAX_SHARED_WORKING_SET_CHARS = 16000;

export function createSubagentRuntime({ client, createWorkerTools, workerTools, cwd, config, activeSkills = [], contextMessages = [], parentWorkingSet, signal, verificationPlan, onEvent, secretRegistry }) {
  const workers = new Map();
  const contextHistory = [];
  const workspaceWriter = createMutex();

  return {
    contextHistory: () => structuredClone(contextHistory),
    async start(args = {}, options = {}) {
      if (workers.size >= MAX_WORKERS_PER_TASK) {
        return { ok: false, error: "worker limit reached for this task", code: "WORKER_LIMIT_REACHED" };
      }
      const description = truncateOneLine(args.description || args.prompt || "worker", 80);
      const mode = normalizeWorkerMode(args.mode ?? args.subagent_type);
      const role = normalizeWorkerRole(args.role, mode, description);
      const prompt = normalizeWorkerPrompt(args.prompt);
      if (!prompt) return { ok: false, error: "prompt is required" };
      const worker = createWorker({ description, prompt, mode, role });
      workers.set(worker.id, worker);
      return runWorkerTurn({ worker, prompt, action: "started", signal: options.signal });
    },

    async send(args = {}, options = {}) {
      const id = String(args.to ?? args.task_id ?? "");
      const worker = workers.get(id);
      if (!worker) return { ok: false, error: "worker not found: " + id };
      if (worker.status === "stopped") return { ok: false, error: "worker is stopped: " + id };
      const message = normalizeWorkerPrompt(args.message);
      if (!message) return { ok: false, error: "message is required" };
      return runWorkerTurn({ worker, prompt: message, action: "continued", signal: options.signal });
    },

    async stop(args = {}) {
      const id = String(args.task_id ?? args.to ?? "");
      const worker = workers.get(id);
      if (!worker) return { ok: false, error: "worker not found: " + id };
      worker.status = "stopped";
      worker.controller.abort(new Error("Worker stopped."));
      return {
        ok: true,
        task_id: id,
        status: "stopped",
        summary: "Worker stopped: " + worker.description,
        activity: { kind: "subagent", label: "Stopped worker", target: worker.description },
      };
    },

    snapshot() {
      return [...workers.values()].map((worker) => ({
        id: worker.id,
        description: worker.description,
        role: worker.role,
        mode: worker.mode,
        status: worker.status,
        startedAt: worker.startedAt,
        completedAt: worker.completedAt,
        usage: worker.usage,
      }));
    },

    aggregate() {
      return aggregateWorkerResults([...workers.values()]);
    },
  };

  function createWorker({ description, prompt, mode, role }) {
    const id = "agent-" + randomUUID().slice(0, 8);
    const tools = createWorkerTools?.({ mode, workerId: id }) ?? workerTools;
    return {
      id,
      description,
      role,
      mode,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      tools,
      controller: new AbortController(),
      messages: [
        { role: "system", content: workerSystemPrompt({ mode, role, tools }) },
        ...contextMessages.filter((message) => message.role === "system"),
        ...contextMessages.filter((message) => message.role !== "system"),
        ...sharedWorkingSetMessages(),
      ],
      initialPrompt: prompt,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  function sharedWorkingSetMessages() {
    const summary = parentWorkingSet?.();
    if (!summary) return [];
    const bounded = summary.length > MAX_SHARED_WORKING_SET_CHARS ? summary.slice(0, MAX_SHARED_WORKING_SET_CHARS) + "\n... shared working set truncated" : summary;
    return [
      {
        role: "user",
        content:
          "Context already inspected by the coordinating agent — reuse these observations instead of re-reading the same files:\n\n" +
          bounded,
      },
    ];
  }

  async function runWorkerTurn({ worker, prompt, action, signal: callSignal }) {
    if (worker.active) return { ok: false, error: "worker is already running", code: "WORKER_BUSY" };
    worker.active = true;
    worker.status = "queued";
    try {
      const execute = () => executeWorkerTurn({ worker, prompt, action, callSignal });
      // Unknown command/write sets share one workspace lock. Research stays
      // concurrent; scoped parallel writers require a future conflict backend.
      if (worker.mode === "research") return await execute();
      const queued = linkSignals([signal, callSignal, worker.controller.signal, client.taskBudget?.signal]);
      try {
        const release = await acquireWriter(workspaceWriter, queued.signal);
        try { return await execute(); } finally { release(); }
      } finally { queued.dispose(); }
    } catch (error) {
      worker.status = "stopped";
      throw error;
    } finally {
      worker.active = false;
    }
  }

  async function executeWorkerTurn({ worker, prompt, action, callSignal }) {
    const turnId = randomUUID();
    const queuedMs = Date.now() - Date.parse(worker.startedAt);
    onEvent?.({ type: "worker-start", workerId: worker.id, mode: worker.mode, queuedMs });
    worker.status = "running";
    const linked = linkSignals([signal, callSignal, worker.controller.signal, client.taskBudget?.signal]);
    const deadline = createWorkerDeadline(linked.signal, config?.workerTimeoutMs);
    try {
      const result = await runAgent({
        client,
        tools: worker.tools,
        task: prompt,
        cwd,
        model: config.model,
        maxTokens: config.maxTokens,
        contextWindow: config.contextWindow,
        outputReserve: config.outputReserve,
        reasoningEffort: config.reasoningEffort,
        thinking: config.thinking,
        stream: false,
        maxSteps: config.maxSteps,
        tokenBudget: config.workerTokenBudget,
        reportTaskUsage: false,
        deadline: deadline.deadline,
        contextMessages: worker.messages,
        ...(action === "started" ? { contextItems: worker.messages.map((message) => contextItem(message, 60,
          message.role === "system" ? { required: true, layer: "instructions" } : {})) } : {}),
        activeSkills,
        signal: deadline.signal,
        verificationPlan,
        secretRegistry,
        onEvent: (event) => onEvent?.({ ...event, workerId: worker.id }),
      });
      if (result.contextState) contextHistory.push({ workerId: worker.id, turnId, contextState: result.contextState });
      worker.messages = result.messages ?? worker.messages;
      worker.status = result.workflow?.status === "failed" ? "stopped" : "completed";
      worker.completedAt = new Date().toISOString();
      onEvent?.({ type: "worker-end", workerId: worker.id, status: worker.status, usage: result.usage });
      worker.structured = parseWorkerStructured(result.finalText);
      addUsage(worker.usage, result.usage);
      return {
        ok: result.workflow?.status !== "failed",
        task_id: worker.id,
        role: worker.role,
        mode: worker.mode,
        status: worker.status,
        summary: "Worker " + action + " (" + worker.role + "/" + worker.mode + "): " + worker.description,
        result: result.finalText,
        structured: worker.structured,
        usage: result.usage,
        stoppedReason: result.stoppedReason,
        effects: result.effects,
        verification: result.verification,
        activity: {
          kind: "subagent",
          label: action === "started" ? "Ran worker" : "Continued worker",
          target: worker.description,
          detail: worker.role + "/" + worker.mode,
        },
      };
    } catch (error) {
      if (error.runSnapshot?.contextState) contextHistory.push({ workerId: worker.id, turnId, contextState: error.runSnapshot.contextState });
      addUsage(worker.usage, error?.agentUsage);
      worker.status = "stopped";
      worker.completedAt = new Date().toISOString();
      if (deadline.timedOut) {
        return {
          ok: false,
          task_id: worker.id,
          role: worker.role,
          mode: worker.mode,
          status: "stopped",
          code: "WORKER_TIMEOUT",
          usage: error?.agentUsage,
          effects: error?.effects,
          error: "Worker exceeded its time budget and was stopped.",
          summary: "Worker timed out (" + worker.role + "/" + worker.mode + "): " + worker.description,
          activity: { kind: "subagent", label: "Worker timed out", target: worker.description, detail: worker.role + "/" + worker.mode },
        };
      }
      throw error;
    } finally {
      deadline.dispose();
      linked.dispose();
    }
  }
}

function workerSystemPrompt({ mode, role, tools }) {
  return [
    "You are a Deecoo worker agent executing a delegated software engineering subtask.",
    "Worker role: " + role + ".",
    "Worker mode: " + mode + ".",
    "Available tools: " + (tools?.schemas ?? []).map((schema) => schema.function.name).join(", ") + ".",
    "Workers cannot see the full user conversation unless it is included in the prompt.",
    "Follow the delegated prompt exactly.",
    roleInstruction(role),
    mode === "research" ? "This is a read-only worker. Do not attempt shell commands or file edits." : "",
    mode === "verify" ? ((tools?.schemas ?? []).some((schema) => schema.function.name === "run_shell")
      ? "This worker may run focused verification commands under the parent's write permissions. Commands can have side effects; direct file-edit tools are unavailable."
      : "This worker can inspect files. The parent task is read-only, so commands and edits are unavailable.") : "",
    mode === "implement" ? "This worker may edit files only within the delegated scope." : "",
    "Report concrete file paths, line numbers when available, commands run, verification status, and residual risks.",
    "Do not spawn additional workers. Use the available workspace tools directly.",
    "End your reply with a fenced ```json block matching this shape so the coordinator can aggregate results:",
    '{"summary": string, "status": "done" | "blocked" | "needs-followup", "findings": [{"file": string, "line": number, "severity": "high"|"medium"|"low", "summary": string}], "filesTouched": string[], "commandsRun": string[], "residualRisks": string[]}',
  ].filter(Boolean).join("\n");
}

export function aggregateWorkerResults(workers = []) {
  const findings = [];
  const residualRisks = new Set();
  const filesTouched = new Set();
  const commandsRun = new Set();
  const seen = new Set();
  const byStatus = {};

  for (const worker of workers) {
    const structured = worker.structured;
    const status = structured?.status ?? worker.status ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (!structured) continue;
    for (const finding of structured.findings ?? []) {
      const key = (finding.file ?? "") + "::" + (finding.summary ?? "");
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ ...finding, source: worker.role ?? worker.description });
    }
    for (const risk of structured.residualRisks ?? []) residualRisks.add(risk);
    for (const file of structured.filesTouched ?? []) filesTouched.add(file);
    for (const command of structured.commandsRun ?? []) commandsRun.add(command);
  }

  findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return {
    workers: workers.length,
    byStatus,
    findings,
    residualRisks: [...residualRisks],
    filesTouched: [...filesTouched],
    commandsRun: [...commandsRun],
  };
}

function parseWorkerStructured(finalText) {
  const text = String(finalText ?? "");
  const match = text.match(/```json\s*([\s\S]*?)```/i);
  if (!match) return undefined;
  try {
    return normalizeWorkerStructured(JSON.parse(match[1].trim()));
  } catch {
    return undefined;
  }
}

function normalizeWorkerStructured(parsed) {
  if (!parsed || typeof parsed !== "object") return undefined;
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    status: typeof parsed.status === "string" ? parsed.status : undefined,
    findings: Array.isArray(parsed.findings) ? parsed.findings.map(normalizeFinding).filter(Boolean) : [],
    filesTouched: Array.isArray(parsed.filesTouched) ? parsed.filesTouched.map(String) : [],
    commandsRun: Array.isArray(parsed.commandsRun) ? parsed.commandsRun.map(String) : [],
    residualRisks: Array.isArray(parsed.residualRisks) ? parsed.residualRisks.map(String) : [],
  };
}

function normalizeFinding(finding) {
  if (typeof finding === "string") return { summary: finding };
  if (!finding || typeof finding !== "object") return undefined;
  const summary = finding.summary ?? finding.title;
  return {
    file: finding.file ? String(finding.file) : undefined,
    line: Number.isFinite(finding.line) ? finding.line : undefined,
    severity: finding.severity ? String(finding.severity).toLowerCase() : undefined,
    summary: summary ? String(summary) : undefined,
  };
}

function severityRank(severity) {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  if (severity === "low") return 1;
  return 0;
}

function createWorkerDeadline(parentSignal, timeoutMs) {
  if (!timeoutMs) return { signal: parentSignal, deadline: undefined, timedOut: false, dispose: () => {} };
  const controller = new AbortController();
  const state = { signal: controller.signal, deadline: Date.now() + timeoutMs, timedOut: false, dispose: () => {} };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new Error("Worker time budget exceeded."));
  }, timeoutMs);
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
  }
  state.dispose = () => {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", onParentAbort);
  };
  return state;
}

function normalizeWorkerRole(value, mode, description) {
  const role = String(value ?? "").toLowerCase();
  if (["planner", "coder", "reviewer", "tester", "security"].includes(role)) return role;
  const text = String(description ?? "").toLowerCase();
  if (/security|安全|auth|secret|permission/.test(text)) return "security";
  if (/test|verify|验证|tester|verifier/.test(text) || mode === "verify") return "tester";
  if (/code|coder|implement|实现|edit|修改/.test(text) || mode === "implement") return "coder";
  if (/review|审查|risk|风险/.test(text)) return "reviewer";
  return "planner";
}

function roleInstruction(role) {
  if (role === "planner") {
    return "Planner role: inspect constraints, identify files and risks, propose a concrete plan, and do not edit files.";
  }
  if (role === "coder") {
    return "Coder role: make scoped implementation changes only after understanding the local pattern, and report changed files and assumptions.";
  }
  if (role === "reviewer") {
    return "Reviewer role: independently look for correctness, design, maintainability, and edge-case issues with evidence; avoid confirming the implementer's assumptions.";
  }
  if (role === "tester") {
    return "Tester role: run or design focused validation, summarize exact commands and failures, and avoid code edits.";
  }
  if (role === "security") {
    return "Security role: independently check auth, authorization, injection, path traversal, secret handling, unsafe shell/file access, and privilege boundaries.";
  }
  return "";
}

function normalizeWorkerPrompt(value) {
  return String(value ?? "").trim().slice(0, MAX_WORKER_PROMPT_CHARS);
}

function truncateOneLine(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function addUsage(total, usage = {}) {
  total.promptTokens += Number(usage.promptTokens ?? usage.prompt_tokens ?? 0);
  total.completionTokens += Number(usage.completionTokens ?? usage.completion_tokens ?? 0);
  total.totalTokens += Number(usage.totalTokens ?? usage.total_tokens ?? 0);
}

function acquireWriter(mutex, signal) {
  const pending = mutex.acquire();
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let aborted = false;
    const onAbort = () => { aborted = true; signal.removeEventListener("abort", onAbort); reject(signal.reason ?? new Error("Worker stopped while queued.")); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then((release) => {
      signal.removeEventListener("abort", onAbort);
      if (aborted) release(); else resolve(release);
    });
  });
}
