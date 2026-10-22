import { buildTaskToolPolicy } from "../permissions/taskPolicy.js";
import { checkpointIdentity, createCheckpointWriter, validateCheckpoint, prepareCheckpointResume } from "../harness/checkpoints.js";
import { runAgent, serializeRunState } from "./loop.js";
import { buildAgentSystemMessage } from "./initialContext.js";
import { createSubagentRuntime } from "./subagents/runtime.js";
import { analyzeTaskCoordination } from "./coordination.js";
import { createRunTracer } from "../harness/tracer.js";
import { estimateCostUsd, isModelPriceKnown } from "../harness/cost.js";
import { budgetClient, createTaskBudget } from "../harness/budget.js";
import { createRateLimiter, rateLimitClient } from "../llm/rateLimiter.js";
import { createSecretRegistry } from "../config/secrets.js";
import { createRuntimeContext } from "../harness/runtimeContext.js";
import { createRunEventStream } from "../harness/events.js";
import { reconcileRunJournal } from "../harness/runProjection.js";
import { createChangeSet } from "../workspace/changes.js";
import { canPersist } from "../storage/governance.js";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createToolOutputStore } from "../storage/toolOutputs.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createExecutionBackend } from "../execution/backend.js";
import { buildBudgetedContext, buildContextBudget, contextItem, estimateTokens, measureContextMessages } from "../context/builder.js";
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
import { redact, saveRunAudit } from "../observability/audit.js";
import { saveRunOutputs } from "../reporter/outputs.js";
import { createReviewFinalValidator, formatReviewDisplayText } from "../reporter/reviewReport.js";
import { buildSessionContext, recordTurn } from "../session/store.js";
import { artifactContextMessages, saveSkillArtifact } from "../session/artifacts.js";
import { scorArtifactMetadata } from "../skills/scor.js";
import { createAssistantStreamPrinter, formatRunFooter, formatToolLine, printAssistantResponse } from "../terminal/markdown.js";
import { createSpinner } from "../terminal/spinner.js";
import { createPhaseProgress, formatActivityBlock, formatActivityStart } from "../cli/activity.js";
import { buildVerificationPlan, verificationPlanMessage } from "../verification/planner.js";

export async function runTask({ client, tools, task, cwd, config, sessionStore, session, activeSkills = [], envOverlay, signal, resumeCheckpoint }) {
  const startedAt = Date.now();
  const taskDeadline = createTaskDeadline(signal, config.taskTimeoutMs);
  let runtimeContext, privateJobDir, outcome, taskPluginScope;
  let failurePhase = "preparation";
  let secretRegistry = createSecretRegistry(config.env ?? process.env);
  if (config.apiKey) secretRegistry.add(config.apiKey, config.apiKeyEnv ?? "PROVIDER_API_KEY");
  try {
    runtimeContext = await createRuntimeContext({ cwd, env: config.env ?? process.env, overlay: envOverlay,
      runId: resumeCheckpoint?.metadata?.runId, sandboxPolicy: config.sandboxPolicy,
      taskId: resumeCheckpoint?.metadata?.taskId,
      jobStateDir: sessionStore?.projectDir ? join(sessionStore.projectDir, "jobs") : undefined });
    if ((sessionStore?.storagePolicy?.privacyMode ?? config.privacyMode ?? "standard") !== "standard") {
      privateJobDir = await mkdtemp(join(tmpdir(), "deecoo-private-execution-"));
      runtimeContext.jobStateDir = privateJobDir;
      runtimeContext.executionBackend = createExecutionBackend({ cwd: runtimeContext.cwd, stateDir: privateJobDir,
        env: runtimeContext.env, sandboxPolicy: config.sandboxPolicy });
    }
    tools.setRuntimeContext?.(runtimeContext);
    secretRegistry = createSecretRegistry(runtimeContext.env);
    if (config.apiKey) secretRegistry.add(config.apiKey, config.apiKeyEnv ?? "PROVIDER_API_KEY");
    if (config.setupPlugins !== undefined) {
      failurePhase = "plugin-setup";
      if (typeof config.setupPlugins !== "function") throw new TypeError("setupPlugins must be a trusted setup function.");
      if (!tools.createPluginScope) throw Object.assign(new Error("This tool runtime does not support task plugin scopes."), { code: "PLUGIN_SCOPE_UNAVAILABLE" });
      taskPluginScope = tools.createPluginScope({ id: "task_" + runtimeContext.taskId });
      await taskPluginScope.run(({ signal: setupSignal }) => config.setupPlugins(taskPluginScope, { signal: setupSignal }), { signal: taskDeadline.signal });
      failurePhase = "preparation";
    }
    outcome = await runTaskInner({ client, tools, task, cwd: runtimeContext.cwd, config, sessionStore, session, activeSkills,
      signal: taskDeadline.signal, taskDeadline, resumeCheckpoint, runtimeContext, secretRegistry, taskPluginScope });
    return outcome;
  } catch (error) {
    outcome = reportTaskFailure({ error, startedAt, taskDeadline, signal: taskDeadline.signal, secretRegistry, quiet: config.quiet });
    outcome.failurePhase = failurePhase;
    outcome.runId = runtimeContext?.runId; outcome.taskId = runtimeContext?.taskId;
    if (taskPluginScope) applyPluginCleanup(outcome, await disposeTaskPlugins(taskPluginScope, secretRegistry));
    if (session && sessionStore) {
      sessionStore.secretRegistry = secretRegistry;
      try {
        await sessionStore.assertTaskOwner?.(session.id, runtimeContext?.runId);
        await saveRunAudit(sessionStore, session, { task, cwd, model: config.model, ...outcome }, { secretRegistry });
        await saveRunOutputs(sessionStore, session, { task, result: outcome });
      } catch (failure) { outcome.persistenceFailure = { code: "FAILURE_REPORT_UNAVAILABLE", error: secretRegistry.redact(failure.message) }; }
    }
    return outcome;
  } finally {
    if (taskPluginScope) applyPluginCleanup(outcome, await disposeTaskPlugins(taskPluginScope, secretRegistry));
    if (privateJobDir) {
      const cleanup = await runtimeContext?.executionBackend?.dispose({ stopRunning: true, removeState: true }).catch((error) => ({ ok: false, code: "JOB_DISPOSE_INCOMPLETE", error: error.message }));
      if (cleanup?.ok) await rm(privateJobDir, { recursive: true, force: true });
      if (outcome) {
        outcome.jobCleanup = cleanup;
        if (!cleanup?.ok) { outcome.status = "failed"; outcome.stoppedReason = "JOB_DISPOSE_INCOMPLETE"; outcome.workflow = { ...outcome.workflow, status: "failed" }; }
      }
    }
    const output = tools.getOutputStore?.();
    const privateOutputs = (sessionStore?.storagePolicy?.privacyMode ?? config.privacyMode ?? "standard") !== "standard";
    let resumableOutputs = false;
    if (privateOutputs && outcome?.status !== "completed" && session && sessionStore?.loadCheckpoint && output?.owner) {
      // Budget/step/provider failures can also leave a valid continuation. The
      // checkpoint, not a short list of status strings, owns these references.
      const saved = await sessionStore.loadCheckpoint(session.id).catch(() => undefined);
      resumableOutputs = saved?.metadata?.runId === output.owner.runId && output.owner.sessionId === session.id && Array.isArray(saved.messages);
    }
    if (privateOutputs && !resumableOutputs && outcome?.status !== "interrupted" && outcome?.status !== "timed-out") {
      await output?.store?.dispose?.();
    }
    taskDeadline.dispose();
    await refreshProjectDescription(cwd);
  }
}

async function runTaskInner({ client, tools, task, cwd, config, sessionStore, session, activeSkills = [], signal, taskDeadline, resumeCheckpoint, runtimeContext, secretRegistry, taskPluginScope }) {
  const log = config.quiet ? () => {} : console.log;
  const spinner = config.quiet ? { start() {}, stop() {} } : createSpinner("Thinking");
  const streamPrinter = createAssistantStreamPrinter();
  let streamed = false;
  let streamedContent = "";
  const startedAt = Date.now();
  const contractTask = resolveTaskContractInput(task, session);
  const coordination = analyzeTaskCoordination(contractTask, { mode: config.taskMode });
  const taskSpec = buildTaskSpec({ task: contractTask, cwd, coordination, activeSkills, mode: config.taskMode, acceptance: config.taskAcceptance, requiredChecks: config.requiredChecks });
  // Preparation, checkpoints and dispatch must describe the same advertised
  // schemas. Apply the current task policy before resolving the planning call.
  tools.resetTaskPermissions?.();
  tools.setTaskToolPolicy?.(buildTaskToolPolicy(taskSpec));
  const preparation = client.prepareRequest ? await client.prepareRequest({ model: config.model, messages: [], tools: tools.schemas,
    ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}), ...(config.thinking ? { thinking: config.thinking } : {}) }, { signal }) : undefined;
  const effectiveMaxTokens = preparation?.request?.max_tokens ?? config.maxTokens ?? config.outputReserve ?? client.capabilities?.outputReserve ?? 4096;
  const effectiveCapabilities = preparation?.capabilities ?? client.capabilities;
  const contextOptions = { contextWindow: config.contextWindow ?? effectiveCapabilities?.contextWindow ?? 128000,
    outputReserve: Math.max(config.outputReserve ?? 0, effectiveMaxTokens ?? effectiveCapabilities?.outputReserve ?? 4096) };
  const identity = await checkpointIdentity({ cwd, model: config.model, tools, taskSpec, config, client });
  const resume = resumeCheckpoint ? prepareCheckpointResume(validateCheckpoint(resumeCheckpoint, identity)) : undefined;
  identity.taskId = runtimeContext.taskId;
  tools.restoreWorkspaceRevision?.(resume?.effects?.revision ?? 0);
  const contextMessages = session ? buildSessionContext(session) : [];
  const handoffMessages = await buildSkillHandoffMessages({ sessionStore, session, activeSkills });
  const projectIndex = await buildProjectIndex(cwd);
  const projectIndexMessages = await buildProjectIndexMessages(cwd, { index: projectIndex });
  const workspaceSnapshotMessages = await buildWorkspaceSnapshotMessages(cwd);
  const projectMemory = sessionStore ? await loadProjectMemory(sessionStore) : undefined;
  const projectMemoryMessage = memoryContextMessage(projectMemory);
  const longTermMemory = sessionStore ? await loadLongTermMemory(sessionStore) : undefined;
  const longTermMemoryMessage = longTermMemoryContextMessage(longTermMemory);
  const memoryLayers = memoryLayerSummary({ session, projectMemory, longTermMemory });
  const verificationPlan = buildVerificationPlan({ taskSpec, projectIndex });
  const reviewScopeMessages = await buildReviewScopeMessages({ cwd, task, activeSkills, requestType: coordination.requestType });
  // A continuation dispatches its saved projection, not a newly assembled
  // context. Only that actual surface is budget-checked by the agent loop.
  const preparedContext = resume ? { messages: [], metrics: { ...buildContextBudget(contextOptions), contextSource: "checkpoint",
    estimatedInputTokens: measureContextMessages(resume.messages) + estimateTokens(preparation?.request?.tools ?? tools.schemas ?? []) } } : buildBudgetedContext([
    contextItem(taskSpecMessage(taskSpec), 100, { layer: "task", required: true }),
    contextItem(verificationPlanMessage(verificationPlan), 90, { layer: "task", required: true }),
    contextItem(projectMemoryMessage, 80),
    contextItem(longTermMemoryMessage, 55),
    ...contextMessages.map((message) => contextItem(message, 50)),
    ...handoffMessages.map((message) => contextItem(message, 70)),
    ...workspaceSnapshotMessages.map((message) => contextItem(message, 65, message.role === "system" ? { required: true, layer: "instructions" } : {})),
    ...projectIndexMessages.map((message) => contextItem(message, 60)),
  ], { ...contextOptions, reservedMessages: [buildAgentSystemMessage({ cwd, requestType: coordination.requestType, activeSkills, coordination }),
    { role: "user", content: task }, ...reviewScopeMessages], reservedTools: preparation?.request?.tools ?? tools.schemas ?? [] });
  const baseContextMessages = preparedContext.messages;
  // Workers get a lighter, codebase-orientation slice of context (workspace snapshot + project
  // index + review scope) rather than the full orchestration context (session history, memory
  // layers, task spec, verification plan), which only the coordinating agent needs.
  // Select this orientation only when a worker actually starts, against its
  // own system prompt/task/tools. Unused current rules cannot reject a resume.
  const workerContextMessages = [...workspaceSnapshotMessages, ...projectIndexMessages];
  // One rate limiter shared by the main agent and every worker, so parallel dispatch cannot
  // independently burst the provider; a 429 anywhere triggers a cooldown all callers respect.
  let checkpointWriter;
  const rateLimiter = createRateLimiter({ maxConcurrent: config.maxConcurrentRequests ?? 5 });
  const priceOverrides = { pricePromptPerM: config.pricePromptPerM, priceCompletionPerM: config.priceCompletionPerM };
  const taskBudget = createTaskBudget({
    model: config.model,
    tokenBudget: config.tokenBudget,
    costBudgetUsd: config.costBudgetUsd,
    priceOverrides,
  });
  const limitedClient = budgetClient(rateLimitClient(client, rateLimiter), taskBudget);
  // Redact concrete secret values (API keys, tokens) from anything a tool surfaces to the model.
  if (sessionStore) sessionStore.secretRegistry = secretRegistry;
  const tracer = createRunTracer();
  let journalResume = resume?.runJournal;
  if (resume && canPersist(sessionStore) && sessionStore?.storagePolicy?.durableToolEvents && session && sessionStore.readToolEvents) {
    const records = (await sessionStore.readToolEvents(session.id)).filter((event) => event.runId === runtimeContext.runId);
    journalResume = reconcileRunJournal(journalResume, records, { runId: runtimeContext.runId, taskId: runtimeContext.taskId });
    if (journalResume.projection.usageSource === "aggregate-snapshot") {
      const recorded = journalResume.projection.usage;
      resume.usage = Object.fromEntries(["promptTokens", "completionTokens", "totalTokens"].map((key) => [key, Math.max(resume.usage?.[key] ?? 0, recorded[key] ?? 0)]));
    }
  }
  const events = createRunEventStream({ runId: runtimeContext.runId, taskId: runtimeContext.taskId, secretRegistry,
    resumeState: journalResume, includeSnapshots: (sessionStore?.storagePolicy?.privacyMode ?? config.privacyMode ?? "standard") === "standard",
    onEvent: (event) => { tracer.record(event); return config.onEvent?.(event); },
    persist: canPersist(sessionStore) && sessionStore?.storagePolicy?.durableToolEvents && session ? (event) => sessionStore.appendToolEvent(session.id, event) : undefined });
  tools.setEventSink?.((event) => events.emit(event));
  const outputOwner = { sessionId: session?.id ?? runtimeContext.taskId, runId: runtimeContext.runId };
  const priorOutputs = tools.getOutputStore?.();
  const outputPolicy = sessionStore?.storagePolicy ?? { privacyMode: config.privacyMode ?? "standard" };
  const outputStore = resume && priorOutputs?.owner?.sessionId === outputOwner.sessionId && priorOutputs.owner.runId === outputOwner.runId
    ? priorOutputs.store : tools.setOutputStore ? await createToolOutputStore({
      stateDir: config.outputStateDir ?? (sessionStore?.projectDir ? join(sessionStore.projectDir, "tool-outputs", outputOwner.sessionId) :
        join(tmpdir(), "deecoo-tool-outputs", createHash("sha256").update(cwd).digest("hex"))),
      owner: outputOwner, privacyMode: outputPolicy.privacyMode,
      retentionDays: outputPolicy.retentionDays, maxBytes: outputPolicy.maxBytes, maxFileBytes: outputPolicy.maxFileBytes, secretRegistry }) : undefined;
  if (outputStore && outputStore === priorOutputs?.store) outputStore.addSecretRegistry?.(secretRegistry);
  if (priorOutputs?.store && priorOutputs.store !== outputStore) await priorOutputs.store.dispose?.();
  tools.setOutputStore?.(outputStore, { owner: outputOwner, maxInlineBytes: Math.max(1024, Math.min(16000, Math.floor((contextOptions.contextWindow - contextOptions.outputReserve) / 8))) });
  const existingChangeSet = tools.getChangeSet?.();
  const volatileChanges = !canPersist(sessionStore) || sessionStore?.storagePolicy?.privacyMode === "redacted";
  const changeSet = taskSpec.mayWrite && tools.setChangeSet ? resumeCheckpoint?.metadata?.changeSetId && existingChangeSet?.id === resumeCheckpoint.metadata.changeSetId
    ? existingChangeSet : await createChangeSet({ cwd,
    stateDir: config.changeStateDir ?? (sessionStore?.projectDir ? join(sessionStore.projectDir, "changes") : undefined),
    task: contractTask, id: resumeCheckpoint?.metadata?.changeSetId,
    excludeRoots: sessionStore?.projectDir ? [sessionStore.projectDir] : [],
    persist: !volatileChanges }) : undefined;
  const workerContexts = () => [...(resume?.workerContexts ?? []), ...(tools.getWorkerContexts?.() ?? [])];
  const saveCheckpointState = async (snapshot) => {
    await events.emit({ type: "usage-snapshot", usage: snapshot.usage });
    await events.flush();
    const value = { ...snapshot, runJournal: events.checkpoint(), workerContexts: workerContexts() };
    try { await checkpointWriter?.save(value); }
    catch (error) { error.code ??= "CHECKPOINT_PERSIST_FAILED"; error.runSnapshot ??= value; throw error; }
  };
  const finishDiagnostics = (result) => {
    result.events = events.snapshot();
    result.metrics = { ...tracer.snapshot(), rateLimiter: rateLimiter.stats() };
    result.workerContexts = workerContexts();
    result.runJournal = events.checkpoint();
    result.checkpoint = checkpointWriter?.diagnostics?.();
    result.modelDiagnostics = { events: tracer.events().filter((event) => ["model-attempt-start", "model-attempt-end", "model-retry", "context-compacted"].includes(event.type)),
      coverage: { ...events.snapshot(), retainedTraceComplete: tracer.snapshot().droppedEvents === 0 && !journalResume?.sequence,
        contextSourceComplete: result.contextState?.sourceCompleteness === "complete" && !result.contextState?.privacyFiltered,
        droppedTraceEvents: tracer.snapshot().droppedEvents, retainedBytes: tracer.snapshot().retainedBytes, resumedFromSequence: journalResume?.sequence ?? 0 } };
  };
  try {
  checkpointWriter = session && sessionStore ? createCheckpointWriter({ store: sessionStore, sessionId: session.id,
    identity, task: contractTask, runId: runtimeContext.runId, strict: true }) : undefined;
  await checkpointWriter?.ready?.();
  if (changeSet) {
    if (resumeCheckpoint?.metadata?.changeSetId && volatileChanges && existingChangeSet?.id !== changeSet.id) throw Object.assign(new Error("The private in-memory change baseline is unavailable in this process. Start a new task to establish a new baseline; existing workspace edits are preserved."), { code: "CHANGE_BASELINE_UNAVAILABLE" });
    if (resumeCheckpoint?.metadata?.changeSetId) await changeSet.inspect(); else await changeSet.begin();
    identity.changeSetId = changeSet.id;
    tools.setChangeSet(changeSet);
  }
  await events.emit({ type: "run-start", model: config.model, capabilities: effectiveCapabilities, routeIdentity: preparation?.routeIdentity,
    context: preparedContext.metrics, preparationMs: Date.now() - startedAt, changeSetId: changeSet?.id });
  tools.setSubagentRuntime?.(
    createSubagentRuntime({
      client: limitedClient,
      createWorkerTools: tools.createWorkerTools?.bind(tools),
      workerTools: tools.createWorkerTools?.({ mode: "research" }) ?? tools,
      cwd,
      config: { ...config, maxTokens: effectiveMaxTokens, contextWindow: contextOptions.contextWindow, outputReserve: contextOptions.outputReserve },
      activeSkills,
      contextMessages: [...workerContextMessages, ...reviewScopeMessages],
      parentWorkingSet: () => tools.getWorkingSetSummary?.(),
      signal,
      verificationPlan,
      secretRegistry,
      onEvent: (event) => events.emit(event),
    }),
  );
  const phaseProgress = createPhaseProgress(coordination);
  const initialPhase = phaseProgress.start();
  if (initialPhase) log(initialPhase + "\n");

  if (config.costBudgetUsd && !isModelPriceKnown(config.model, priceOverrides)) {
    log(formatToolLine(`cost budget set but no price is known for model "${config.model}"; the budget is inactive. Set DEECOO_PRICE_PROMPT_PER_M and DEECOO_PRICE_COMPLETION_PER_M.`));
  }
  const taskValidator = createTaskFinalValidator({ taskSpec, verificationPlan });
  const reviewValidator = coordination.requestType === "review" ? createReviewFinalValidator({ task: contractTask }) : undefined;
  const finalValidator = reviewValidator ? (input) => {
    const review = reviewValidator(input), contract = taskValidator(input);
    return { ...review, ...contract, report: review.report, ok: review.ok && contract.ok,
      errors: [...(review.errors ?? []), ...(contract.errors ?? [])],
      reason: review.ok ? contract.reason : review.reason,
      maxRepairAttempts: Math.max(review.maxRepairAttempts ?? 0, contract.maxRepairAttempts ?? 0),
      repairPrompt: [review.ok ? "" : review.repairPrompt, contract.ok ? "" : contract.repairPrompt].filter(Boolean).join("\n\n") };
  } : taskValidator;
    const result = await runAgent({
      client: limitedClient,
      tools,
      task,
      cwd,
      model: config.model,
      maxTokens: effectiveMaxTokens,
      contextWindow: contextOptions.contextWindow,
      outputReserve: contextOptions.outputReserve,
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
      verificationPlan,
      resume,
      activeSkills,
      secretRegistry,
      onEvent: (event) => events.emit(event),
      onCheckpoint: checkpointWriter ? saveCheckpointState : undefined,
      finalValidator,
      signal,
      onModelStart: ({ step }) => {
        spinner.stop();
        log(formatToolLine("Thinking(step " + step + ") · waiting for model response"));
        spinner.start();
      },
      onModelEnd: () => spinner.stop(),
      onToolStart: ({ name, args, decision }) => {
        spinner.stop();
        const phase = phaseProgress.tool({ name, args });
        if (phase) log(phase + "\n");
        log(formatActivityStart({ name, args, decision }) + "\n");
        if (name === "agent") tracer.record({ type: "worker", name, description: args?.description, mode: args?.mode ?? args?.subagent_type });
      },
      onToolEnd: ({ name, args, result, decision }) => {
        spinner.stop();
        log(formatActivityBlock({ name, args, result, decision }) + "\n");
      },
      onTextDelta: ({ content }) => {
        spinner.stop();
        if (config.quiet) return;
        streamed = true;
        streamedContent += content;
        streamPrinter.push(content);
      },
    });

    result.runId = runtimeContext.runId;
    result.taskId = runtimeContext.taskId;
    result.capabilities = effectiveCapabilities;
    result.routeIdentity = preparation?.routeIdentity;
    result.effectiveConfig = preparation?.effectiveConfig;
    if (taskPluginScope) applyPluginCleanup(result, await disposeTaskPlugins(taskPluginScope, secretRegistry));
    result.contextMetrics = { ...preparedContext.metrics, ...tools.getMetrics?.() };
    result.metrics = { ...tracer.snapshot(), rateLimiter: rateLimiter.stats() };
    if (changeSet) { await changeSet.capture(); result.changes = await changeSet.inspect(); }
    await events.emit({ type: "run-end", status: result.workflow?.status, usage: result.usage,
      acceptance: result.acceptance, pluginCleanup: result.pluginCleanup, elapsedMs: Date.now() - startedAt });
    result.events = await events.flush();
    if (result.workflow?.status !== "completed") {
      await saveCheckpointState(serializeRunState({ ...result, step: result.steps }));
    }
    finishDiagnostics(result);
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
    if (config.quiet) {
      // Evaluation and embedding callers receive structured results without terminal output.
    } else if (streamed && finalTextWasStreamed(streamedContent, displayText)) {
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
        acceptance: result.acceptance, changes: result.changes, runId: result.runId, taskId: result.taskId,
        routeIdentity: result.routeIdentity, effectiveConfig: result.effectiveConfig, capabilities: result.capabilities, contextMetrics: result.contextMetrics, events: result.events, metrics: result.metrics, pluginCleanup: result.pluginCleanup,
        elapsedMs,
        costUsd,
        tracer: tracer.snapshot(),
        finalText: result.finalText,
        usage: result.usage,
        workflow: result.workflow,
        verification: result.verification,
        effects: result.effects,
        agentState: result.agentState,
        process: result.process,
        transitions: result.transitions,
        trace: result.trace,
        reviewReport: result.reviewReport,
        quarantine: result.quarantine,
        messages: result.messages,
        contextState: result.contextState, workerContexts: result.workerContexts, runJournal: result.runJournal, modelDiagnostics: result.modelDiagnostics, checkpoint: result.checkpoint,
      }, { secretRegistry });
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
      if (result.workflow?.status === "completed") {
        await checkpointWriter?.clear();
      }
    }
    return {
      ...result,
      status: result.workflow?.status === "completed" ? "completed" : "failed",
      elapsedMs,
      costUsd,
    };
  } catch (error) {
    spinner.stop();
    if (streamed) streamPrinter.finish();
    const result = reportTaskFailure({ error, startedAt, taskDeadline, signal, secretRegistry, taskBudget, quiet: config.quiet });
    result.runId = runtimeContext.runId; result.taskId = runtimeContext.taskId;
    result.routeIdentity = preparation?.routeIdentity; result.effectiveConfig = preparation?.effectiveConfig; result.capabilities = effectiveCapabilities;
    if (taskPluginScope) applyPluginCleanup(result, await disposeTaskPlugins(taskPluginScope, secretRegistry));
    if (changeSet) { try { await changeSet.capture(); result.changes = await changeSet.inspect(); } catch (captureError) { result.changeCaptureError = secretRegistry.redact(captureError.message); } }
    await events.emit({ type: "run-end", status: result.status, usage: result.usage, code: result.stoppedReason, pluginCleanup: result.pluginCleanup, elapsedMs: result.elapsedMs });
    result.events = await events.flush();
    if (error.runSnapshot) {
      try { await saveCheckpointState(error.runSnapshot); }
      catch (failure) { result.checkpointFailure = { code: failure.code, error: secretRegistry.redact(failure.message) }; }
    }
    finishDiagnostics(result);
    if (session && sessionStore) {
      try {
        await saveRunAudit(sessionStore, session, {
          task, cwd, model: config.model, requestType: coordination.requestType,
          ...result, tracer: tracer.snapshot(),
        }, { secretRegistry });
        await saveRunOutputs(sessionStore, session, { task, result });
      } catch {
        if (!config.quiet) console.error("Unable to persist failed run outputs.");
      }
    }
    return result;
  } finally {
    await events.flush();
    tools.setEventSink?.(undefined);
    await checkpointWriter?.flush();
  }
}

async function disposeTaskPlugins(scope, secretRegistry) {
  try { return redact(await scope.dispose(), { secretRegistry, maxTextChars: Infinity }); }
  catch (error) { return { ok: false, state: "dispose-failed", errors: [{ code: error.code ?? "PLUGIN_DISPOSE_FAILED", message: secretRegistry?.redact(error.message) ?? error.message }] }; }
}

function applyPluginCleanup(result, cleanup) {
  if (!result) return;
  result.pluginCleanup = cleanup;
  if (!cleanup.ok) {
    result.status = "failed";
    result.stoppedReason = "PLUGIN_DISPOSE_INCOMPLETE";
    result.workflow = { ...result.workflow, status: "failed", phase: "cleanup" };
    if (result.acceptance) result.acceptance = { ...result.acceptance, status: "failed", completionType: "partial" };
  }
}

function reportTaskFailure({ error, startedAt, taskDeadline, signal, secretRegistry, taskBudget, quiet = false }) {
  const timedOut = taskDeadline.timedOut;
  const budget = taskBudget?.stopped();
  const interrupted = !timedOut && !budget && isAbortError(error, signal);
  const status = timedOut ? "timed-out" : interrupted ? "interrupted" : "failed";
  const rawCode = String(error?.code ?? "");
  const code = rawCode && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(rawCode) && redact(rawCode, { secretRegistry }) === rawCode ? rawCode : "request_failed";
  const stoppedReason = timedOut ? "task_deadline_exceeded" : budget?.reason ?? (interrupted ? "interrupted" : code);
  const message = secretRegistry ? secretRegistry.redact(error?.message ?? String(error)) : error?.message ?? String(error);
  if (!quiet && timedOut) console.log(formatToolLine("task stopped: time budget exceeded"));
  else if (!quiet && interrupted) console.log(formatToolLine("task interrupted"));
  else if (!quiet) console.error("Request failed after retries: " + message);
  return {
    ...(error?.runSnapshot ? { agentState: error.runSnapshot.agentState, verification: error.runSnapshot.verification,
      effects: error.runSnapshot.effects, messages: error.runSnapshot.messages, contextState: error.runSnapshot.contextState, trace: error.runSnapshot.trace, acceptance: error.runSnapshot.acceptance,
      transitions: error.runSnapshot.transitions, steps: error.runSnapshot.step } : {}),
    status,
    elapsedMs: Date.now() - startedAt,
    timedOut,
    interrupted,
    stoppedReason,
    error: { message, code },
    ...(error?.contextSnapshotError ? { contextSnapshotError: redact(error.contextSnapshotError, { secretRegistry }) } : {}),
    usage: taskBudget?.snapshot() ?? error?.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    workflow: { status: "failed", phase: "error" },
  };
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

export function resolveTaskContractInput(task, session) {
  const text = String(task ?? "").trim();
  const previous = session?.turns?.at(-1)?.user;
  return previous && /^(?:继续(?:执行|实施|处理|完成)?|continue|proceed|go on)[。.!！\s]*$/i.test(text)
    ? String(previous) + "\n" + text : text;
}
