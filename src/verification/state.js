import { canonicalCheckCommand, matchingCheckIds } from "../harness/acceptance.js";
const FILE_TOOLS = new Set(["edit_file", "write_file", "apply_patch", "apply_patch_set", "apply_json_patch"]);

export function isVerificationCommand(command, plan) {
  const text = String(command ?? "").trim();
  if (!canonicalCheckCommand(text)) return false;
  // These modes print metadata or collect tests without executing checks. A
  // zero exit status from them is not validation evidence.
  if (/(?:^|\s)(?:--(?:help|version|dry-run|ignore-scripts|list(?:-tests|Tests)?|collect-only|show-?config|no-run|if-present)(?:[=\s]|$)|-(?:h|v|V|list)(?:\s|$))/i.test(text)) return false;
  if (matchingCheckIds(text, plan?.requiredChecks).length) return true;
  if (plan?.commands?.some((item) => canonicalCheckCommand(item.command) === canonicalCheckCommand(text))) return true;
  return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w-]+)?|check|typecheck|lint|build|vitest|jest)|node\s+--test|(?:python3?\s+-m\s+)?pytest|cargo\s+(?:test|check|clippy)|go\s+test|swift\s+test|dotnet\s+test|make\s+(?:test|check)|xcodebuild\s+test)(?:\s|$)/i.test(text);
}

export function emptyVerificationState() {
  return { status: "not-run", commands: [], evidence: [], transitions: [], workspaceRevision: 0, validationRevision: 0, mutationCount: 0, seenEffectIds: [], hadFailure: false };
}

export function createVerificationStateMachine(initial, { plan } = {}) {
  let state = { ...emptyVerificationState(), ...(initial ? structuredClone(initial) : {}) };
  state.evidence ??= [];
  state.seenEffectIds ??= [];
  if (initial && initial.status === "pending") state.validationRevision = Math.max(state.validationRevision, state.workspaceRevision);
  return {
    observeTool(event) { state = advanceVerificationState(state, event, { plan }); return structuredClone(state); },
    skip(reason) { state = { ...state, status: "unverified-with-reason", reason: String(reason) }; },
    snapshot: () => structuredClone(state),
  };
}

export function advanceVerificationState(state, event, { plan } = {}) {
  let next = { ...emptyVerificationState(), ...(state ?? {}) };
  next.commands = [...(next.commands ?? [])];
  next.evidence = [...(next.evidence ?? [])];
  next.transitions = [...(next.transitions ?? [])];
  next.seenEffectIds = [...(next.seenEffectIds ?? [])];
  const rawEffects = event.result?.effects?.events;
  let effects = rawEffects;
  if (!Array.isArray(effects)) {
    if (event.result?.alreadyAvailable || event.result?.cached) return next;
    if (event.name === "run_shell" && !["SHELL_COMMAND_BLOCKED", "TASK_TOOL_BLOCKED"].includes(event.result?.code)) {
      effects = [{ type: "command", command: event.args?.command, ok: event.result?.ok !== false,
        revision: next.workspaceRevision + 1, ...event.result }];
    } else if (FILE_TOOLS.has(event.name) && event.result?.ok !== false) {
      effects = [{ type: "file-change", revision: next.workspaceRevision + 1 }];
    } else effects = [];
  }
  for (const effect of effects) {
    if (effect.id && next.seenEffectIds.includes(effect.id)) continue;
    if (effect.id) next.seenEffectIds.push(effect.id);
    const before = next.status;
    const revision = Number.isFinite(effect.revision) ? effect.revision : next.workspaceRevision;
    next.workspaceRevision = Math.max(next.workspaceRevision, revision);
    if (effect.type === "file-change" || effect.type === "workspace-uncertain") {
      next.validationRevision = revision;
      next.mutationCount += 1;
      next.status = latestEvidence(next).some((item) => !item.ok) ? "fixed-pending-rerun" : next.evidence.length ? "pending" : "not-run";
      delete next.reason;
    } else if (effect.type === "command") {
      const isCheck = isVerificationCommand(effect.command, plan);
      if (!isCheck) next.validationRevision = revision;
      const attempt = { command: String(effect.command ?? ""), ok: effect.ok !== false, revision,
        validatedRevision: next.validationRevision, scope: effect.scope ?? ".", cwd: effect.cwd, checkIds: matchingCheckIds(effect.command, plan?.requiredChecks, { scope: effect.scope ?? "." }),
        step: event.step, id: effect.id, stdout: summarize(effect.stdout), stderr: summarize(effect.stderr), error: effect.error ?? "" };
      next.commands.push(attempt);
      delete next.reason;
      if (isCheck) {
        const baseline = next.evidence.find((item) => canonicalCheckCommand(item.command) === canonicalCheckCommand(attempt.command) && item.failureOrigin === "baseline");
        if (!attempt.ok) attempt.failureOrigin = next.mutationCount === 0 ? "baseline" : baseline ? "pre-existing" : "introduced-or-unclassified";
        next.evidence.push(attempt);
        if (!attempt.ok) next.hadFailure = true;
      }
      const latest = latestEvidence(next);
      next.status = latest.some((item) => !item.ok) ? "failed" :
        latest.some((item) => item.ok && (item.validatedRevision ?? item.revision) === next.validationRevision)
          ? next.hadFailure ? "failed-then-passed" : "passed"
          : next.evidence.length ? "pending" : "not-run";
    } else continue;
    next.transitions.push({ from: before, to: next.status, type: effect.type, command: effect.command, step: event.step, revision });
  }
  return next;
}

export function verificationIsFresh(state, plan) {
  if (plan?.requiredChecks?.some((check) => check.required !== false)) {
    const revision = state?.validationRevision ?? state?.workspaceRevision;
    return plan.requiredChecks.filter((check) => check.required !== false).every((check) => {
      const latest = (state?.evidence ?? []).filter((item) => matchingCheckIds(item.command, [check], { scope: item.scope ?? "." }).length).at(-1);
      return latest?.ok && (latest.validatedRevision ?? latest.revision) === revision;
    }) && !hasFailedVerification(state, plan);
  }
  return ["passed", "failed-then-passed"].includes(state?.status) &&
    latestEvidence(state).some((item) => item.ok && (item.validatedRevision ?? item.revision) === (state.validationRevision ?? state.workspaceRevision)) &&
    !latestEvidence(state).some((item) => !item.ok);
}
export function hasFailedVerification(state, plan) {
  return latestEvidence(state, plan).some((item) => !item.ok);
}
function latestEvidence(state, plan) {
  const latest = new Map();
  for (const item of state?.evidence ?? []) {
    const ids = plan?.requiredChecks ? matchingCheckIds(item.command, plan.requiredChecks, { scope: item.scope ?? "." }) : item.checkIds ?? [];
    for (const key of ids.length ? ids.map((id) => "check:" + id) : [canonicalCheckCommand(item.command) ?? item.command]) latest.set(key, item);
  }
  return [...latest.values()];
}
function summarize(value) {
  const text = String(value ?? "").trim();
  return text.length > 1000 ? text.slice(0, 1000) + "\n... truncated" : text;
}
