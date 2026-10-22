import { randomUUID } from "node:crypto";
import { findWorkspaceSymbols, findWorkspaceReferences } from "../context/navigation.js";
import { createToolRegistry } from "./registry.js";
import { compactToolResult } from "./projection.js";
import { prepareModelToolResult } from "./modelOutput.js";
import { EXTRA_TOOL_DEFINITIONS } from "./extraDefinitions.js";
import { createExecutionBackend } from "../execution/backend.js";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { buildToolSchemas, normalizeWorkerMode, TOOL_CAPABILITIES, WORKER_TOOL_PROFILES } from "./definitions.js";
import { getFileReadMetrics, applyJsonPatch, applyStructuredPatch, applyStructuredPatchSet, editFile, listFiles, proposePatch, proposeStructuredPatchSet, readWorkspaceFile, writeWorkspaceFile } from "./files.js";
import { gitDiff, gitStatus } from "./git.js";
import { normalizeShellCommand } from "../permissions/shellPolicy.js";
import { toolExceptionResult } from "./results.js";
import { searchText } from "./search.js";
import { runShell } from "./shell.js";
import { effectiveToolNames, taskToolPolicyViolation } from "../permissions/taskPolicy.js";
import { createEffectLedger } from "../harness/effects.js";
import { createPluginScope as createResourceScope } from "../harness/pluginScope.js";

export function createToolRuntime({
  cwd,
  prompter,
  allowShellWithoutPrompt = false,
  permissionMode = "ask-once",
  approvedShellCommands = [],
  onApproveShellCommand,
  autoApproveAllShell = false,
  onApproveAllShellCommands,
  egressAllowlist,
  executionBackend,
  executionStateDir,
  sandboxPolicy,
  env,
}) {
  const workspace = resolve(cwd);
  let realWorkspace;
  const getRealWorkspace = () => {
    realWorkspace ??= realpath(workspace);
    return realWorkspace;
  };
  const permissionState = {
    mode: permissionMode,
    fileWriteApprovedForTask: false,
    approvedShellCommands: new Set(approvedShellCommands.map(normalizeShellCommand).filter(Boolean)),
    onApproveShellCommand,
    autoApproveAllShell,
    onApproveAllShellCommands,
    egressAllowlist,
    readCache: new Map(),
    taskToolPolicy: undefined,
    executionBackend: executionBackend ?? createExecutionBackend({ cwd: workspace, stateDir: executionStateDir, env, sandboxPolicy }),
    executionEnv: env,
  };
  let subagentRuntime;
  let workingSetProvider;
  const effects = createEffectLedger({ workspace });
  const registry = createToolRegistry();
  let runtimeContext;
  let changeSet;
  let eventSink;
  let outputStore;
  let outputOwner;
  let outputInlineBytes = 16000;
  let observerErrors = 0;
  const observedJobs = new Set();

  const runtime = {
    get schemas() { return schemasFor(); },
    get workerSchemas() { return schemasFor("research"); },
    capabilities() {
      return registry.list().map(({ schema, ...metadata }) => metadata);
    },
    getWorkspaceRevision() { return effects.revision(); },
    getMetrics() { return { fileReads: getFileReadMetrics(permissionState), observerErrors }; },
    registerTool(definition) { return registry.register(definition); },
    createPluginScope(options = {}) {
      const scope = createResourceScope(options);
      return Object.freeze({ ...scope, registerTool: (definition) => registry.registerHandle(definition, { scope }) });
    },
    setEventSink(sink) { eventSink = sink; },
    setOutputStore(store, options = {}) {
      const bytes = options.maxInlineBytes ?? 16000;
      if (!Number.isFinite(bytes) || bytes < 1024) throw new TypeError("Inline output byte limit must be finite and at least 1024.");
      outputStore = store; outputOwner = options.owner; outputInlineBytes = bytes;
    },
    getOutputStore() { return { store: outputStore, owner: outputOwner }; },
    projectResult(name, result, options = {}) {
      return prepareModelToolResult({ name, result, project: registry.project?.bind(registry), outputStore,
        maxBytes: Math.min(options.maxBytes ?? outputInlineBytes, outputInlineBytes), secretRegistry: options.secretRegistry, measure: options.measure });
    },
    setChangeSet(value) { changeSet = value; },
    getChangeSet() { return changeSet; },
    getExecutionBackend() { return permissionState.executionBackend; },
    setRuntimeContext(context) {
      runtimeContext = context;
      permissionState.executionEnv = context.env;
      permissionState.executionBackend = context.executionBackend ?? executionBackend ?? createExecutionBackend({ cwd: workspace,
        stateDir: context.jobStateDir ?? executionStateDir, env: context.env, sandboxPolicy: context.sandboxPolicy ?? sandboxPolicy });
    },
    restoreWorkspaceRevision(revision) { effects.reset(revision); permissionState.readCache.clear(); },
    setWorkingSetProvider(provider) {
      workingSetProvider = provider;
    },
    getWorkingSetSummary() {
      return workingSetProvider ? workingSetProvider() : undefined;
    },
    setSubagentRuntime(runtime) {
      subagentRuntime = runtime;
    },
    getWorkerContexts() { return subagentRuntime?.contextHistory?.() ?? []; },
    createWorkerTools({ mode = "research", workerId } = {}) {
      const workerMode = normalizeWorkerMode(mode);
      const allowedTools = { has: (name) => registry.get(name)?.workerModes.includes(workerMode) };
      return {
        mode: workerMode,
        getWorkspaceRevision: () => effects.revision(),
        projectResult: (name, result, options) => runtime.projectResult(name, result, options),
        get schemas() { return schemasFor(workerMode); },
        async execute(name, args, options) {
          if (!allowedTools.has(name)) {
            return {
              ok: false,
              error: `Tool ${name} is not available to ${workerMode} workers.`,
              code: "WORKER_TOOL_BLOCKED",
            };
          }
          const violation = policyViolation(name, args, workerMode);
          if (violation) return violation;
          return runtime.execute(name, args, { ...options, workerId });
        },
      };
    },
    setPermissionMode(mode) {
      permissionState.mode = mode;
      permissionState.fileWriteApprovedForTask = false;
    },
    getPermissionMode() {
      return permissionState.mode;
    },
    setTaskToolPolicy(policy) {
      permissionState.taskToolPolicy = normalizeTaskToolPolicy(policy);
    },
    clearTaskToolPolicy() {
      permissionState.taskToolPolicy = undefined;
    },
    resetTaskPermissions() {
      subagentRuntime = undefined;
      permissionState.fileWriteApprovedForTask = false;
      permissionState.readCache.clear();
      permissionState.contextReadMetrics = undefined;
      permissionState.taskToolPolicy = undefined;
      effects.reset();
      observedJobs.clear();
    },
    async execute(name, args = {}, options = {}) {
      const invocationId = randomUUID();
      const startedAt = Date.now();
      const emit = async (event) => {
        try { await eventSink?.({ ...event, invocationId, workerId: options.workerId,
          runId: runtimeContext?.runId, taskId: runtimeContext?.taskId, tool: name }); }
        catch { observerErrors++; }
      };
      await emit({ type: "tool-start" });
      let result, executionEntry;
      try { result = await executeTool(name, args, options, (entry) => { executionEntry = entry; }); }
      catch (error) { result = toolExceptionResult(error); }
      let observed = result;
      if (name !== "agent" && name !== "send_message") {
        if (name === "job_status" && ["exited", "stopped", "timed_out", "failed", "cleanup_unconfirmed"].includes(result?.status)) {
          if (!observedJobs.has(result.jobId)) {
            observedJobs.add(result.jobId);
            observed = effects.record("run_shell", { command: result.command }, { ...result,
              ok: result.status === "exited" && result.exitCode === 0 && result.treeCleanup?.confirmed,
              shellPolicy: { level: "allow", source: "previously-approved-job" } });
          }
        } else observed = effects.record(name, args, result, executionEntry);
      }
      if ((observed.effects?.events ?? []).some((event) => ["file-change", "workspace-uncertain", "command"].includes(event.type))) permissionState.readCache.clear();
      registry.copyProjection?.(result, observed);
      await emit({ type: "tool-end", ok: result?.ok !== false, code: result?.code,
        durationMs: Date.now() - startedAt, effects: observed?.effects?.events?.map(({ id, type, revision, paths }) => ({ id, type, revision, paths })) });
      return observed;
    },
  };

  function schemasFor(workerMode) {
    const schemas = registry.schemas((entry) => (!workerMode || entry.workerModes.includes(workerMode)) &&
      !policyViolation(entry.name, {}, workerMode));
    const agent = schemas.find((schema) => schema.function.name === "agent");
    if (agent) {
      const modes = ["research", "verify", "implement"].filter((mode) => !taskToolPolicyViolation("agent", { mode }, {
        permissionMode: permissionState.mode, taskPolicy: permissionState.taskToolPolicy }));
      agent.function.parameters.properties.mode.enum = modes;
      agent.function.parameters.properties.subagent_type.enum = modes;
      const readOnly = permissionState.mode === "read-only" || permissionState.taskToolPolicy?.mayWrite === false;
      agent.function.parameters.properties.mode.description = readOnly
        ? "Worker tool profile. research and verify may inspect files; commands and edits are unavailable for this read-only task."
        : "Worker tool profile. research inspects files; verify may run commands with side effects; implement may edit files.";
    }
    return schemas;
  }

  async function executeTool(name, args, options, onDispatch) {
      try {
        throwIfAborted(options.signal);
        const guardedPrompter = async (question, promptOptions = {}) => {
          throwIfAborted(options.signal);
          const decision = await abortableApproval(() => prompter(question, { ...promptOptions, signal: options.signal }), options.signal);
          throwIfAborted(options.signal);
          return decision;
        };
        const violation = policyViolation(name, { ...args, mode: name === "agent" ? normalizeWorkerMode(args?.mode ?? args?.subagent_type) : args?.mode });
        if (violation) return violation;
        const entry = registry.get(name);
        if (entry?.requiresApproval && !Object.hasOwn(handlers, name)) {
          const decision = await guardedPrompter("Execute extension tool: " + name, { kind: "extension-tool-approval", tool: name });
          if (![true, "approve", "allow", "once", "always"].includes(decision)) return { ok: false, code: "TOOL_APPROVAL_DENIED", error: "Extension tool approval denied." };
        }
        // Approval applies to this registration only. A replacement must pass
        // its own policy and approval rather than inheriting an earlier grant.
        if (registry.get(name) !== entry) return { ok: false, code: "TOOL_REGISTRATION_CHANGED", executionState: "not-started", error: "Tool registration changed before dispatch; inspect the current tool schema and issue a new call." };
        const finalViolation = policyViolation(name, { ...args, mode: name === "agent" ? normalizeWorkerMode(args?.mode ?? args?.subagent_type) : args?.mode });
        if (finalViolation) return { ...finalViolation, executionState: "not-started" };
        onDispatch?.(entry);
        const normalized = name === "send_message" && args.task_id ? { to: args.to ?? args.task_id, message: args.message } : args;
        return await registry.execute(name, normalized, { ...options, prompter: guardedPrompter });
      } catch (error) {
        return toolExceptionResult(error);
      }
  }

  function policyViolation(name, args, workerMode) {
    const entry = registry.get(name);
    const readOnly = permissionState.mode === "read-only" || permissionState.taskToolPolicy?.mayWrite === false;
    const violation = taskToolPolicyViolation(name, args, { permissionMode: permissionState.mode, taskPolicy: permissionState.taskToolPolicy });
    if (violation) return violation;
    if (entry?.mutates && readOnly) return { ok: false, code: "TOOL_READ_ONLY", error: "The effective task permissions are read-only." };
    if (entry?.mutates && workerMode === "research") return { ok: false, code: "WORKER_TOOL_BLOCKED", error: "Research workers cannot execute mutating extensions." };
    if (entry?.mutates && workerMode === "verify" && entry.category !== "execution" && name !== "run_shell") return { ok: false, code: "WORKER_TOOL_BLOCKED", error: "Verify workers cannot edit files through extensions." };
    if (workerMode && entry && !entry.workerModes.includes(workerMode)) return { ok: false, code: "WORKER_TOOL_BLOCKED", error: "Tool is unavailable to this Worker profile." };
    return null;
  }
  const handlers = {
    list_files: (args) => listFiles(workspace, getRealWorkspace, args),
    read_file: (args) => readWorkspaceFile(workspace, getRealWorkspace, args, permissionState),
    search_text: (args, options) => searchText(workspace, getRealWorkspace, args, options.signal),
    edit_file: (args, options) => editFile(workspace, getRealWorkspace, args, options.prompter, permissionState, options.signal),
    propose_patch: (args) => proposePatch(workspace, getRealWorkspace, args),
    propose_patch_set: (args) => proposeStructuredPatchSet(workspace, getRealWorkspace, args),
    apply_patch: (args, options) => applyStructuredPatch(workspace, getRealWorkspace, args, options.prompter, permissionState, options.signal),
    apply_patch_set: (args, options) => applyStructuredPatchSet(workspace, getRealWorkspace, args, options.prompter, permissionState, options.signal),
    apply_json_patch: (args, options) => applyJsonPatch(workspace, getRealWorkspace, args, options.prompter, permissionState, options.signal),
    write_file: (args, options) => writeWorkspaceFile(workspace, getRealWorkspace, args, options.prompter, permissionState, options.signal),
    git_status: (_args, options) => gitStatus(workspace, options.signal),
    git_diff: (args, options) => gitDiff(workspace, args, options.signal),
    run_shell: (args, options) => runShell(workspace, args, options.prompter, allowShellWithoutPrompt, permissionState, options.signal),
    agent: (args, options) => subagentRuntime ? subagentRuntime.start(args, options) : { ok: false, error: "Subagent runtime is not available." },
    send_message: (args, options) => subagentRuntime ? subagentRuntime.send(args, options) : { ok: false, error: "Subagent runtime is not available." },
    task_stop: (args) => subagentRuntime ? subagentRuntime.stop(args) : { ok: false, error: "Subagent runtime is not available." },
    start_job: (args, options) => runShell(workspace, { ...args, background: true }, options.prompter, allowShellWithoutPrompt, permissionState, options.signal),
    job_status: async (args) => ({ ok: true, ...await permissionState.executionBackend.getJob(args.jobId) }),
    read_job_output: async (args) => ({ ok: true, ...await permissionState.executionBackend.readOutput(args.jobId, args) }),
    read_output: async (args) => {
      if (!outputStore) return { ok: false, code: "OUTPUT_STORE_UNAVAILABLE", error: "This run has no output store." };
      const maxBytes = Math.min(args.maxBytes ?? 4096, Math.max(64, Math.floor(outputInlineBytes / 8)));
      return { ok: true, ...await outputStore.read({ ...args, maxBytes }), requestedMaxBytes: args.maxBytes ?? 4096, effectiveMaxBytes: maxBytes };
    },
    search_output: async (args) => {
      if (!outputStore) return { ok: false, code: "OUTPUT_STORE_UNAVAILABLE", error: "This run has no output store." };
      return { ok: true, ...await outputStore.search({ ...args, maxResults: Math.min(args.maxResults ?? 20, Math.max(1, Math.floor(outputInlineBytes / 700))) }) };
    },
    stop_job: async (args) => ({ ok: true, ...await permissionState.executionBackend.stopJob(args.jobId) }),
    find_symbols: (args) => findWorkspaceSymbols(workspace, getRealWorkspace, args, permissionState),
    find_references: (args) => findWorkspaceReferences(workspace, getRealWorkspace, args, permissionState),
    task_diff: async (args) => {
      if (!changeSet) return { ok: false, code: "NO_CHANGE_BASELINE", error: "This task has no change baseline." };
      await changeSet.capture(); return { ok: true, ...await changeSet.inspect(args) };
    },
  };
  for (const schema of buildToolSchemas({ includeSubagents: true })) {
    const metadata = TOOL_CAPABILITIES.find((item) => item.name === schema.function.name);
    registry.register({ ...metadata, schema, execute: handlers[schema.function.name],
      toModelContent: (_args, value) => compactToolResult(schema.function.name, value, { truncate: false }),
      workerModes: Object.entries(WORKER_TOOL_PROFILES).filter(([, names]) => names.has(schema.function.name)).map(([mode]) => mode) });
  }
  for (const definition of EXTRA_TOOL_DEFINITIONS) registry.register({ ...definition, execute: handlers[definition.name],
    toModelContent: (_args, value) => compactToolResult(definition.name, value, { truncate: false }) });

  return runtime;
}

function normalizeTaskToolPolicy(policy) {
  if (!policy) return undefined;
  return {
    ...policy,
    blockedTools: new Set(policy.blockedTools ?? []),
    allowedWorkerModes: policy.allowedWorkerModes ? new Set(policy.allowedWorkerModes.map(normalizeWorkerMode)) : undefined,
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error(signal.reason?.message ?? "Task interrupted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

async function abortableApproval(prompt, signal) {
  if (!signal) return prompt();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(prompt).then((decision) => { cleanup(); resolve(decision); }, (error) => { cleanup(); reject(error); });
  });
}
