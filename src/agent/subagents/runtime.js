import { randomUUID } from "node:crypto";
import { runAgent } from "../loop.js";
import { normalizeWorkerMode } from "../../tools/definitions.js";

const MAX_WORKER_PROMPT_CHARS = 8000;
const MAX_WORKERS_PER_TASK = 8;

export function createSubagentRuntime({ client, createWorkerTools, workerTools, cwd, config, activeSkills = [], contextMessages = [], signal }) {
  const workers = new Map();

  return {
    async start(args = {}) {
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
      return runWorkerTurn({ worker, prompt, action: "started" });
    },

    async send(args = {}) {
      const id = String(args.to ?? args.task_id ?? "");
      const worker = workers.get(id);
      if (!worker) return { ok: false, error: "worker not found: " + id };
      if (worker.status === "stopped") return { ok: false, error: "worker is stopped: " + id };
      const message = normalizeWorkerPrompt(args.message);
      if (!message) return { ok: false, error: "message is required" };
      return runWorkerTurn({ worker, prompt: message, action: "continued" });
    },

    async stop(args = {}) {
      const id = String(args.task_id ?? args.to ?? "");
      const worker = workers.get(id);
      if (!worker) return { ok: false, error: "worker not found: " + id };
      worker.status = "stopped";
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
  };

  function createWorker({ description, prompt, mode, role }) {
    const tools = createWorkerTools?.({ mode }) ?? workerTools;
    return {
      id: "agent-" + randomUUID().slice(0, 8),
      description,
      role,
      mode,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      tools,
      messages: [
        ...contextMessages,
        {
          role: "system",
          content: workerSystemPrompt({ mode, role, tools }),
        },
      ],
      initialPrompt: prompt,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  async function runWorkerTurn({ worker, prompt, action }) {
    worker.status = "running";
    const result = await runAgent({
      client,
      tools: worker.tools,
      task: prompt,
      cwd,
      model: config.model,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      thinking: config.thinking,
      stream: false,
      contextMessages: worker.messages,
      activeSkills,
      signal,
    });
    worker.messages = result.messages ?? worker.messages;
    worker.status = "completed";
    worker.completedAt = new Date().toISOString();
    addUsage(worker.usage, result.usage);
    return {
      ok: true,
      task_id: worker.id,
      role: worker.role,
      mode: worker.mode,
      status: worker.status,
      summary: "Worker " + action + " (" + worker.role + "/" + worker.mode + "): " + worker.description,
      result: result.finalText,
      usage: result.usage,
      stoppedReason: result.stoppedReason,
      activity: {
        kind: "subagent",
        label: action === "started" ? "Ran worker" : "Continued worker",
        target: worker.description,
        detail: worker.role + "/" + worker.mode,
      },
    };
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
    mode === "verify" ? "This worker may run focused verification commands but must not edit files." : "",
    mode === "implement" ? "This worker may edit files only within the delegated scope." : "",
    "Report concrete file paths, line numbers when available, commands run, verification status, and residual risks.",
    "Do not spawn additional workers. Use the available workspace tools directly.",
  ].filter(Boolean).join("\n");
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
