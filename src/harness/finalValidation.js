import { inferTaskIntent } from "./taskIntent.js";
import { verificationIsFresh, hasFailedVerification } from "../verification/state.js";
import { evaluateTaskAcceptance } from "./acceptance.js";
const MAX_REPAIR_ATTEMPTS = 2;

export function createTaskFinalValidator({ taskSpec, verificationPlan } = {}) {
  return ({ finalText, requestType, agentState, trace, verification, effects, completionType, attempt = 0 }) => {
    const errors = validateTaskFinal({ finalText, requestType, taskSpec, verificationPlan, agentState, trace, verification, effects, completionType });
    const acceptance = evaluateTaskAcceptance({ taskSpec, verificationPlan, verification, agentState, effects, completionType });
    if (errors.length === 0) return { ok: true, acceptance, ...((agentState?.filesEdited?.length && verificationPlan?.required && !verificationIsFresh(verification, verificationPlan))
      ? { verificationDecision: { status: "unverified-with-reason", reason: String(finalText).trim() } } : {}) };
    return {
      ok: false,
      acceptance,
      reason: "task_contract_invalid",
      errors,
      maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      repairPrompt: taskFinalRepairPrompt({ errors, taskSpec, agentState, attempt: attempt + 1 }),
    };
  };
}

export function validateTaskFinal({ finalText, requestType, taskSpec, verificationPlan, agentState, trace, verification, effects, completionType } = {}) {
  const text = String(finalText ?? "").trim();
  const task = String(taskSpec?.goal ?? "");
  const type = requestType ?? taskSpec?.requestType ?? "general";
  const filesEdited = agentState?.filesEdited ?? [];
  const toolTrace = Array.isArray(trace) ? trace : [];
  const acceptance = evaluateTaskAcceptance({ taskSpec, verificationPlan, verification, agentState, effects, completionType });
  const errors = [...acceptance.errors];

  if (isWeakCompletionText(text)) {
    errors.push("final answer is a weak completion marker and does not summarize completed work");
  }
  if (looksLikeInProgressText(text)) {
    errors.push("final answer still contains in-progress planning language instead of a completed result");
  }
  if (type === "command" && !(agentState?.commandsRun?.length) && !explainsSkippedVerification(text)) {
    errors.push("command task has no executed command evidence; execute it or explain why it could not run");
  }
  if ((taskSpec?.requiresCodeChange ?? inferTaskIntent(task).requiresCodeChange) && filesEdited.length === 0 && !successfulEditTool(toolTrace) && !(taskSpec?.acceptance && acceptance.completionType === "no-change" && acceptance.satisfied)) {
    errors.push("task appears to require code changes, but no successful file edit was recorded");
  }
  if (filesEdited.length > 0 && verificationPlan?.required && !verificationIsFresh(verification, verificationPlan)) {
    if (hasFailedVerification(verification, verificationPlan) || !explainsSkippedVerification(text)) {
      errors.push("files were edited but fresh successful verification evidence is missing or failed; run relevant checks or explicitly explain why verification was not run");
    }
  }
  if ((type === "edit" || type === "debug") && filesEdited.length > 0 && !mentionsChangedWork(text, filesEdited)) {
    errors.push("final answer does not mention changed files or implementation outcome");
  }

  return errors;
}

function taskFinalRepairPrompt({ errors, taskSpec, agentState, attempt }) {
  return [
    `Your previous final answer failed task completion validation on repair attempt ${attempt}.`,
    "Do not answer with only Done/完成.",
    "Do not describe planned tool use as prose. If work remains, call the required tools now.",
    "Validation errors:",
    ...errors.map((error) => "- " + error),
    "",
    "Task:",
    taskSpec?.goal ?? "",
    "",
    "Recorded file edits: " + list(agentState?.filesEdited),
    "Recorded commands: " + list(agentState?.commandsRun),
    "",
    "Continue from the current state. Complete the actual coding task, then provide a final answer with changed files, verification, and residual risks.",
  ].join("\n");
}

function successfulEditTool(trace) {
  return trace.some((entry) => {
    return (
      entry?.ok !== false &&
      ["edit_file", "write_file", "apply_patch", "apply_patch_set", "apply_json_patch"].includes(entry?.tool)
    );
  });
}

function isWeakCompletionText(text) {
  return /^(done|done\.|ok|okay|completed|complete|完成|已完成|好了)[。.!！\s]*$/i.test(text);
}

function looksLikeInProgressText(text) {
  return /^(?:let me|i need to|i will|i'll|我需要|我先|让我|准备)/i.test(text) &&
    !/(implemented|fixed|changed|修复|完成|改动)/i.test(text);
}

function explainsSkippedVerification(text) {
  return /(未运行|没有运行|无法运行|不能运行|跳过|not run|did not run|could not run|unable to run|skipped)/i.test(text) &&
    /(because|due to|missing|unavailable|not installed|no (?:test|runtime|dependency)|docs?[- ]only|documentation|environment|not provided|read.only|permission|policy|原因|因为|由于|缺少|未安装|环境|文档|没有.*测试|无.*测试|权限|策略)/i.test(text);
}

function mentionsChangedWork(text, filesEdited) {
  if (/(changed|modified|updated|edited|implemented|fixed|改动|修改|更新|实现|修复)/i.test(text)) return true;
  return filesEdited.some((file) => text.includes(file));
}

function list(values) {
  if (!Array.isArray(values) || values.length === 0) return "none";
  return values.slice(-8).join(", ") + (values.length > 8 ? ", ..." : "");
}
