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
      const prompt = normalizeWorkerPrompt(args.prompt);
      if (!prompt) return { ok: false, error: "prompt is required" };
      const worker = createWorker({ description, prompt, mode });
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
        mode: worker.mode,
        status: worker.status,
        startedAt: worker.startedAt,
        completedAt: worker.completedAt,
        usage: worker.usage,
      }));
    },
  };

  function createWorker({ description, prompt, mode }) {
    const tools = createWorkerTools?.({ mode }) ?? workerTools;
    return {
      id: "agent-" + randomUUID().slice(0, 8),
      description,
      mode,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      tools,
      messages: [
        ...contextMessages,
        {
          role: "system",
          content: workerSystemPrompt(mode, tools),
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
      mode: worker.mode,
      status: worker.status,
      summary: "Worker " + action + " (" + worker.mode + "): " + worker.description,
      result: result.finalText,
      usage: result.usage,
      stoppedReason: result.stoppedReason,
      activity: {
        kind: "subagent",
        label: action === "started" ? "Ran worker" : "Continued worker",
        target: worker.description,
        detail: worker.mode,
      },
    };
  }
}

function workerSystemPrompt(mode, tools) {
  return [
    "You are a Deecoo worker agent executing a delegated software engineering subtask.",
    "Worker mode: " + mode + ".",
    "Available tools: " + (tools?.schemas ?? []).map((schema) => schema.function.name).join(", ") + ".",
    "Workers cannot see the full user conversation unless it is included in the prompt.",
    "Follow the delegated prompt exactly.",
    mode === "research" ? "This is a read-only worker. Do not attempt shell commands or file edits." : "",
    mode === "verify" ? "This worker may run focused verification commands but must not edit files." : "",
    mode === "implement" ? "This worker may edit files only within the delegated scope." : "",
    "Report concrete file paths, line numbers when available, commands run, verification status, and residual risks.",
    "Do not spawn additional workers. Use the available workspace tools directly.",
  ].filter(Boolean).join("\n");
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
