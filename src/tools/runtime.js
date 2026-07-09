import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { buildToolSchemas, normalizeWorkerMode, TOOL_CAPABILITIES, WORKER_TOOL_PROFILES } from "./definitions.js";
import { applyJsonPatch, applyStructuredPatch, applyStructuredPatchSet, editFile, listFiles, proposePatch, proposeStructuredPatchSet, readWorkspaceFile, writeWorkspaceFile } from "./files.js";
import { gitDiff, gitStatus } from "./git.js";
import { normalizeShellCommand } from "../permissions/shellPolicy.js";
import { toolExceptionResult } from "./results.js";
import { searchText } from "./search.js";
import { runShell } from "./shell.js";

export function createToolRuntime({
  cwd,
  prompter,
  allowShellWithoutPrompt = false,
  permissionMode = "ask-once",
  approvedShellCommands = [],
  onApproveShellCommand,
  autoApproveAllShell = false,
  onApproveAllShellCommands,
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
    readCache: new Map(),
    taskToolPolicy: undefined,
  };
  let subagentRuntime;
  let workingSetProvider;

  const runtime = {
    schemas: buildToolSchemas({ includeSubagents: true }),
    workerSchemas: buildToolSchemas({ includeSubagents: false }),
    capabilities() {
      return TOOL_CAPABILITIES;
    },
    setWorkingSetProvider(provider) {
      workingSetProvider = provider;
    },
    getWorkingSetSummary() {
      return workingSetProvider ? workingSetProvider() : undefined;
    },
    setSubagentRuntime(runtime) {
      subagentRuntime = runtime;
    },
    createWorkerTools({ mode = "research" } = {}) {
      const workerMode = normalizeWorkerMode(mode);
      const allowedTools = WORKER_TOOL_PROFILES[workerMode];
      return {
        mode: workerMode,
        schemas: buildToolSchemas({ includeSubagents: false, allowedTools }),
        async execute(name, args, options) {
          if (!allowedTools.has(name)) {
            return {
              ok: false,
              error: `Tool ${name} is not available to ${workerMode} workers.`,
              code: "WORKER_TOOL_BLOCKED",
            };
          }
          return runtime.execute(name, args, options);
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
      permissionState.fileWriteApprovedForTask = false;
      permissionState.readCache.clear();
      permissionState.taskToolPolicy = undefined;
    },
    async execute(name, args, options = {}) {
      try {
        throwIfAborted(options.signal);
        const policyViolation = taskToolPolicyViolation(name, args, permissionState.taskToolPolicy);
        if (policyViolation) return policyViolation;
        switch (name) {
          case "list_files":
            return await listFiles(workspace, getRealWorkspace, args);
          case "read_file":
            return await readWorkspaceFile(workspace, getRealWorkspace, args, permissionState);
          case "search_text":
            return await searchText(workspace, getRealWorkspace, args, options.signal);
          case "edit_file":
            return await editFile(workspace, getRealWorkspace, args, prompter, permissionState);
          case "propose_patch":
            return await proposePatch(workspace, getRealWorkspace, args);
          case "propose_patch_set":
            return await proposeStructuredPatchSet(workspace, getRealWorkspace, args);
          case "apply_patch":
            return await applyStructuredPatch(workspace, getRealWorkspace, args, prompter, permissionState);
          case "apply_patch_set":
            return await applyStructuredPatchSet(workspace, getRealWorkspace, args, prompter, permissionState);
          case "apply_json_patch":
            return await applyJsonPatch(workspace, getRealWorkspace, args, prompter, permissionState);
          case "write_file":
            return await writeWorkspaceFile(workspace, getRealWorkspace, args, prompter, permissionState);
          case "git_status":
            return await gitStatus(workspace, options.signal);
          case "git_diff":
            return await gitDiff(workspace, args, options.signal);
          case "run_shell":
            return await runShell(workspace, args, prompter, allowShellWithoutPrompt, permissionState, options.signal);
          case "agent":
            return subagentRuntime ? await subagentRuntime.start(args) : { ok: false, error: "Subagent runtime is not available." };
          case "send_message":
            return subagentRuntime ? await subagentRuntime.send(args) : { ok: false, error: "Subagent runtime is not available." };
          case "task_stop":
            return subagentRuntime ? await subagentRuntime.stop(args) : { ok: false, error: "Subagent runtime is not available." };
          default:
            return { ok: false, error: `Unknown tool: ${name}` };
        }
      } catch (error) {
        return toolExceptionResult(error);
      }
    },
  };

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

function taskToolPolicyViolation(name, args, policy) {
  if (!policy) return undefined;
  if (policy.blockedTools?.has(name)) {
    return {
      ok: false,
      error: `Tool ${name} is blocked by ${policy.name || "the active task policy"}.`,
      code: "TASK_TOOL_BLOCKED",
    };
  }
  if (name === "agent" && policy.allowedWorkerModes) {
    const mode = normalizeWorkerMode(args?.mode ?? args?.subagent_type);
    if (!policy.allowedWorkerModes.has(mode)) {
      return {
        ok: false,
        error: `Worker mode ${mode} is blocked by ${policy.name || "the active task policy"}.`,
        code: "TASK_WORKER_MODE_BLOCKED",
      };
    }
  }
  return undefined;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("Task interrupted.");
  error.name = "AbortError";
  throw error;
}
