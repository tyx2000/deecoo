import { randomUUID } from "node:crypto";
import { runAgent } from "../loop.js";

const MAX_WORKER_PROMPT_CHARS = 8000;

export function createSubagentRuntime({ client, workerTools, cwd, config, activeSkills = [], contextMessages = [] }) {
  const workers = new Map();

  return {
    async start(args = {}) {
      const description = truncateOneLine(args.description || args.prompt || "worker", 80);
      const prompt = normalizeWorkerPrompt(args.prompt);
      if (!prompt) return { ok: false, error: "prompt is required" };
      const worker = createWorker({ description, prompt });
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
  };

  function createWorker({ description, prompt }) {
    return {
      id: "agent-" + randomUUID().slice(0, 8),
      description,
      status: "running",
      messages: [
        ...contextMessages,
        {
          role: "system",
          content: workerSystemPrompt(),
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
      tools: workerTools,
      task: prompt,
      cwd,
      maxSteps: Math.max(1, Math.min(Number(config.subagentMaxSteps ?? 8), Number(config.maxSteps ?? 20))),
      model: config.model,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      thinking: config.thinking,
      stream: false,
      contextMessages: worker.messages,
      activeSkills,
    });
    worker.messages = result.messages ?? worker.messages;
    worker.status = "completed";
    addUsage(worker.usage, result.usage);
    return {
      ok: true,
      task_id: worker.id,
      status: worker.status,
      summary: "Worker " + action + ": " + worker.description,
      result: result.finalText,
      usage: result.usage,
      stoppedReason: result.stoppedReason,
      activity: { kind: "subagent", label: action === "started" ? "Ran worker" : "Continued worker", target: worker.description },
    };
  }
}

function workerSystemPrompt() {
  return [
    "You are a Deecoo worker agent executing a delegated software engineering subtask.",
    "Workers cannot see the full user conversation unless it is included in the prompt.",
    "Follow the delegated prompt exactly. If the prompt says research, do not modify files.",
    "Report concrete file paths, line numbers when available, commands run, verification status, and residual risks.",
    "Do not spawn additional workers. Use the available workspace tools directly.",
  ].join("\n");
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

