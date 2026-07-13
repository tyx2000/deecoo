import { runAgent } from "./loop.js";
import { createSubagentRuntime } from "./subagents/runtime.js";
import { analyzeTaskCoordination } from "./coordination.js";
import { createRunTracer } from "../harness/tracer.js";
import { estimateCostUsd, isModelPriceKnown } from "../harness/cost.js";
import { createRateLimiter, rateLimitClient } from "../llm/rateLimiter.js";
import { createSecretRegistry } from "../config/secrets.js";
import { withIsolatedEnv } from "../harness/isolation.js";
import { buildContextMessages, contextItem } from "../context/builder.js";
import { buildProjectIndex, buildProjectIndexMessages } from "../context/projectIndex.js";
import { buildReviewScopeMessages } from "../context/reviewScope.js";
import { buildWorkspaceSnapshotMessages, ensureProjectDescription } from "../context/workspaceSnapshot.js";
import { createTaskFinalValidator } from "../harness/finalValidation.js";
import { buildTaskSpec, taskSpecMessage } from "../harness/taskSpec.js";
import {
  loadLongTermMemory,
  loadProjectMemory,
  longTermMemoryContextMessage,
  memoryContextMessage,
  memoryLayerSummary,
  recordProjectMemory,
  summarizeRunForMemory,
} from "../memory/projectMemory.js";
import { saveRunAudit } from "../observability/audit.js";
import { saveRunOutputs } from "../reporter/outputs.js";
import { createReviewFinalValidator, formatReviewDisplayText } from "../reporter/reviewReport.js";
import { buildSessionContext, recordTurn } from "../session/store.js";
import { artifactContextMessages, saveSkillArtifact } from "../session/artifacts.js";
import { isScorActive, scorArtifactMetadata, scorReviewToolPolicy } from "../skills/scor.js";
import { createAssistantStreamPrinter, formatRunFooter, formatToolLine, printAssistantResponse } from "../terminal/markdown.js";
import { createSpinner } from "../terminal/spinner.js";
import { formatActivityBlock, formatActivityStart, printCoordinationPlan } from "../cli/activity.js";
import { buildVerificationPlan, verificationPlanMessage } from "../verification/planner.js";

export async function runTask({ client, tools, task, cwd, config, sessionStore, session, activeSkills = [], envOverlay, signal }) {
  // Apply this task's environment in an isolated, self-restoring scope so concurrent in-process
  // tasks never clobber each other's env or leak into the global process environment.
  return withIsolatedEnv(envOverlay ?? {}, () =>
    runTaskInner({ client, tools, task, cwd, config, sessionStore, session, activeSkills, signal }),
  );
}

async function runTaskInner({ client, tools, task, cwd, config, sessionStore, session, activeSkills = [], signal }) {
  const spinner = createSpinner("Thinking");
  const streamPrinter = createAssistantStreamPrinter();
  let streamed = false;
  let streamedContent = "";
  const startedAt = Date.now();
  const contextMessages = session ? buildSessionContext(session) : [];
  const handoffMessages = await buildSkillHandoffMessages({ sessionStore, session, activeSkills });
  const coordination = analyzeTaskCoordination(task);
  const taskSpec = buildTaskSpec({ task, cwd, coordination, activeSkills });
  const projectIndex = await buildProjectIndex(cwd);
  const projectIndexMessages = await buildProjectIndexMessages(cwd);
  const workspaceSnapshotMessages = await buildWorkspaceSnapshotMessages(cwd);
  const projectMemory = sessionStore ? await loadProjectMemory(sessionStore) : undefined;
  const projectMemoryMessage = memoryContextMessage(projectMemory);
  const longTermMemory = sessionStore ? await loadLongTermMemory(sessionStore) : undefined;
  const longTermMemoryMessage = longTermMemoryContextMessage(longTermMemory);
  const memoryLayers = memoryLayerSummary({ session, projectMemory, longTermMemory });
  const verificationPlan = buildVerificationPlan({ taskSpec, projectIndex });
  const baseContextMessages = buildContextMessages([
    contextItem(taskSpecMessage(taskSpec), 100),
    contextItem(verificationPlanMessage(verificationPlan), 90),
    contextItem(projectMemoryMessage, 80),
    contextItem(longTermMemoryMessage, 55),
    ...contextMessages.map((message) => contextItem(message, 50)),
    ...handoffMessages.map((message) => contextItem(message, 70)),
    ...workspaceSnapshotMessages.map((message) => contextItem(message, 65)),
    ...projectIndexMessages.map((message) => contextItem(message, 60)),
  ]);
  const reviewScopeMessages = await buildReviewScopeMessages({
    cwd,
    task,
    activeSkills,
    requestType: coordination.requestType,
  });
  // Workers get a lighter, codebase-orientation slice of context (workspace snapshot + project
  // index + review scope) rather than the full orchestration context (session history, memory
  // layers, task spec, verification plan), which only the coordinating agent needs.
  const workerContextMessages = buildContextMessages([
    ...workspaceSnapshotMessages.map((message) => contextItem(message, 65)),
    ...projectIndexMessages.map((message) => contextItem(message, 60)),
  ]);
  tools.resetTaskPermissions?.();
  if (isScorActive(activeSkills) && coordination.requestType === "review") {
    tools.setTaskToolPolicy?.(scorReviewToolPolicy());
  }
  // One rate limiter shared by the main agent and every worker, so parallel dispatch cannot
  // independently burst the provider; a 429 anywhere triggers a cooldown all callers respect.
  const rateLimiter = createRateLimiter({ maxConcurrent: config.maxConcurrentRequests ?? 5 });
  const limitedClient = rateLimitClient(client, rateLimiter);
  // Redact concrete secret values (API keys, tokens) from anything a tool surfaces to the model.
  const secretRegistry = createSecretRegistry(process.env);
  if (config.apiKey) secretRegistry.add(config.apiKey, "DEEPSEEK_API_KEY");
  tools.setSubagentRuntime?.(
    createSubagentRuntime({
      client: limitedClient,
      createWorkerTools: tools.createWorkerTools?.bind(tools),
      workerTools: tools.createWorkerTools?.({ mode: "research" }) ?? tools,
      cwd,
      config,
      activeSkills,
      contextMessages: [...workerContextMessages, ...reviewScopeMessages],
      parentWorkingSet: () => tools.getWorkingSetSummary?.(),
      signal,
    }),
  );
  printCoordinationPlan(coordination);

  const taskDeadline = createTaskDeadline(signal, config.taskTimeoutMs);
  const tracer = createRunTracer();
  const priceOverrides = { pricePromptPerM: config.pricePromptPerM, priceCompletionPerM: config.priceCompletionPerM };
  if (config.costBudgetUsd && !isModelPriceKnown(config.model, priceOverrides)) {
    console.log(formatToolLine(`cost budget set but no price is known for model "${config.model}"; the budget is inactive. Set DEECOO_PRICE_PROMPT_PER_M and DEECOO_PRICE_COMPLETION_PER_M.`));
  }
  try {
    const result = await runAgent({
      client: limitedClient,
      tools,
      task,
      cwd,
      model: config.model,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      thinking: config.thinking,
      stream: coordination.requestType === "review" ? false : config.stream,
      coordination,
      maxSteps: config.maxSteps,
      tokenBudget: config.tokenBudget,
      costBudgetUsd: config.costBudgetUsd,
      priceOverrides,
      deadline: taskDeadline.deadline,
      contextMessages: [...baseContextMessages, ...reviewScopeMessages],
      activeSkills,
      secretRegistry,
      onEvent: (event) => tracer.record(event),
      onCheckpoint: session && sessionStore
        ? (snapshot) => {
            void persistCheckpoint(sessionStore, session, snapshot);
          }
        : undefined,
      finalValidator:
        coordination.requestType === "review"
          ? createReviewFinalValidator()
          : createTaskFinalValidator({ taskSpec, verificationPlan }),
      signal: taskDeadline.signal,
      onModelStart: ({ step }) => {
        spinner.stop();
        console.log(formatToolLine("Thinking(step " + step + ") · waiting for model response"));
        spinner.start();
      },
      onModelEnd: () => spinner.stop(),
      onToolStart: ({ name, args, decision }) => {
        spinner.stop();
        console.log(formatActivityStart({ name, args, decision }) + "\n");
        if (name === "agent") tracer.record({ type: "worker", name, description: args?.description, mode: args?.mode ?? args?.subagent_type });
      },
      onToolEnd: ({ name, args, result, decision }) => {
        spinner.stop();
        console.log(formatActivityBlock({ name, args, result, decision }) + "\n");
      },
      onTextDelta: ({ content }) => {
        spinner.stop();
        streamed = true;
        streamedContent += content;
        streamPrinter.push(content);
      },
    });

    const elapsedMs = Date.now() - startedAt;
    const costUsd = estimateCostUsd(result.usage, config.model, priceOverrides);
    const footer = formatRunFooter({
      elapsedMs,
      steps: result.steps,
      usage: result.usage,
      stoppedReason: result.stoppedReason,
      costUsd,
    });
    const displayText = result.requestType === "review"
      ? formatReviewDisplayText({ report: result.reviewReport, finalText: result.finalText })
      : result.finalText;
    if (streamed && finalTextWasStreamed(streamedContent, displayText)) {
      streamPrinter.finish(footer);
    } else if (streamed) {
      streamPrinter.finish();
      printAssistantResponse(displayText, footer);
    } else {
      printAssistantResponse(displayText, footer);
    }
    if (session && sessionStore) {
      await saveRunAudit(sessionStore, session, {
        task,
        cwd,
        model: config.model,
        requestType: result.requestType,
        taskSpec,
        verificationPlan,
        memoryLayers,
        elapsedMs,
        costUsd,
        tracer: tracer.snapshot(),
        finalText: result.finalText,
        usage: result.usage,
        workflow: result.workflow,
        verification: result.verification,
        agentState: result.agentState,
        process: result.process,
        transitions: result.transitions,
        trace: result.trace,
        reviewReport: result.reviewReport,
        quarantine: result.quarantine,
        messages: result.messages,
      });
      await saveRunOutputs(sessionStore, session, { task, result });
      for (const entry of summarizeRunForMemory({ task, result })) {
        await recordProjectMemory(sessionStore, entry);
      }
      await maybeSaveSkillArtifacts({ sessionStore, session, activeSkills, task, result });
      await recordTurn(sessionStore, session, {
        user: task,
        assistant: result.finalText,
        model: config.model,
      });
      // The run finished; drop its resumable checkpoint (kept only for crash/interrupt recovery).
      await sessionStore.clearCheckpoint?.(session.id);
    }
    return {
      elapsedMs,
      usage: result.usage,
    };
  } catch (error) {
    spinner.stop();
    if (taskDeadline.timedOut) {
      if (streamed) streamPrinter.finish();
      console.log(formatToolLine("task stopped: time budget exceeded"));
      return {
        elapsedMs: Date.now() - startedAt,
        timedOut: true,
      };
    }
    if (isAbortError(error, signal)) {
      if (streamed) streamPrinter.finish();
      console.log(formatToolLine("task interrupted"));
      return {
        elapsedMs: Date.now() - startedAt,
        interrupted: true,
      };
    }
    console.error("Request failed after retries: " + error.message);
    return {
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    taskDeadline.dispose();
    await refreshProjectDescription(cwd);
  }
}

const lastCheckpointWrite = new Map();

// Persist a resumable checkpoint to disk, throttled so a fast loop does not thrash the FS.
// The full message history is written so a crashed/interrupted run can actually be resumed.
async function persistCheckpoint(sessionStore, session, snapshot) {
  const now = Date.now();
  if (now - (lastCheckpointWrite.get(session.id) ?? 0) < 2500) return;
  lastCheckpointWrite.set(session.id, now);
  try {
    await sessionStore.saveCheckpoint(session.id, snapshot);
  } catch {
    // A failed checkpoint must never fail the task.
  }
}

function createTaskDeadline(parentSignal, timeoutMs) {
  if (!timeoutMs) return { signal: parentSignal, deadline: undefined, timedOut: false, dispose: () => {} };
  const controller = new AbortController();
  const state = { signal: controller.signal, deadline: Date.now() + timeoutMs, timedOut: false, dispose: () => {} };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new Error("Task time budget exceeded."));
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

async function refreshProjectDescription(cwd) {
  try {
    await ensureProjectDescription(cwd);
  } catch {
    // Project context is helpful, but it should never make a task fail.
  }
}


async function buildSkillHandoffMessages({ sessionStore, session, activeSkills }) {
  if (!sessionStore || !session) return [];
  return artifactContextMessages(sessionStore, session, {
    activeSkillNames: activeSkills.map((skill) => skill.name),
    maxArtifacts: 3,
  });
}

async function maybeSaveSkillArtifacts({ sessionStore, session, activeSkills, task, result }) {
  for (const skill of activeSkills) {
    const skillName = skill.name || skill.id || "skill";
    const kind = skillName === "s-cor" ? "findings" : "output";
    const metadata = {
      task,
      requestType: result.requestType,
      stoppedReason: result.stoppedReason,
      verification: result.verification,
    };
    if (result.reviewReport) metadata.reviewReport = result.reviewReport;
    if (skillName === "s-cor") metadata.scor = scorArtifactMetadata(result.finalText);
    await saveSkillArtifact(sessionStore, session, {
      skillName,
      kind,
      title: skillName + " " + kind,
      content: result.finalText,
      metadata,
    });
  }
}

function finalTextWasStreamed(streamedContent, finalText) {
  const final = String(finalText ?? "").trim();
  if (!final) return true;
  return String(streamedContent ?? "").endsWith(final);
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || /aborted|interrupted/i.test(error?.message ?? "");
}
