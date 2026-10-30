import { createHash } from "node:crypto";

const COMPLETION_TYPES = ["modified", "no-change", "partial", "blocked"];
const UNSAFE_COMMAND = /[;&|\n\r$`<>]/;
const METADATA_FLAGS = /(?:^|\s)(?:--(?:help|version|dry-run|ignore-scripts|list(?:-tests|Tests)?|collect-only|show-?config|no-run|if-present)(?:[=\s]|$)|-(?:h|v|V|list)(?:\s|$))/i;

// Command matching is deliberately exact after a small set of documented CLI
// aliases. Similar names, subsets, collection-only runs and shell chains cannot
// establish the requested outcome. Other equivalent paths must be explicit.
export function canonicalCheckCommand(command) {
  const text = String(command ?? "").trim();
  if (!text || UNSAFE_COMMAND.test(text) || METADATA_FLAGS.test(text)) return undefined;
  const match = text.match(/^(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([\w:.-]+)(.*)$/);
  if (match && (match[2] || (match[1] === "npm" ? /^(?:test|start|stop|restart)$/.test(match[3]) : /^(?:test(?::[\w-]+)?|check|lint|typecheck|build)$/.test(match[3])))) return `${match[1]} run ${match[3]}${match[4]}`;
  return text;
}

export function normalizeRequiredChecks(checks = [], { source = "explicit" } = {}) {
  if (!Array.isArray(checks)) throw new Error("requiredChecks must be an array");
  const seen = new Set();
  return checks.map((value) => {
    const item = typeof value === "string" ? { command: value } : value;
    const rawPaths = item?.executionPaths ?? item?.commands ?? (item?.command ? [item.command] : []);
    const executionPaths = rawPaths.map((path) => ({ ...(typeof path === "string" ? { command: path } : path) }));
    if (!executionPaths.length || executionPaths.some((path) => !canonicalCheckCommand(path.command))) throw new Error("Each required check needs safe executable executionPaths");
    const scope = item.scope ?? ".";
    const target = item.target ?? canonicalCheckCommand(executionPaths[0].command);
    const id = item.id ?? "check-" + createHash("sha256").update(JSON.stringify([target, scope])).digest("hex").slice(0, 12);
    if (seen.has(id)) throw new Error("Duplicate required check id: " + id);
    seen.add(id);
    return { id, purpose: item.purpose ?? `Execute ${executionPaths[0].command}`, target, scope,
      required: item.required !== false, executionPaths, source: item.source ?? source };
  });
}

export function inferRequiredChecks(task) {
  const checks = [];
  // Derived candidates cover concrete, executable requests. Explicit contracts
  // override this list rather than being merged with guessed requirements.
  const pattern = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:.-]+(?:\s+--(?:\s+(?!(?:and|then|并|然后|且|与)\b)[^\s,;。`]+)+)?|\bnode\s+--test(?:\s+(?!(?:and|then|please|report|并|然后|且|与)\b)[\w./*-]+)*|\b(?:python3?\s+-m\s+)?pytest(?:\s+(?!(?:and|then|please|report|并|然后|且|与)\b)[\w./*-]+)*|\bcargo\s+(?:test|check|clippy)|\bgo\s+test(?:\s+(?!(?:and|then|please|report|并|然后|且|与)\b)[\w./*-]+)*|\bswift\s+test|\bdotnet\s+test/g;
  for (const match of String(task ?? "").matchAll(pattern)) {
    const prefix = String(task).slice(Math.max(0, match.index - 30), match.index);
    if (/(?:do not|don't|never|不要|无需|不必|禁止)\s*(?:run|execute|运行|执行)?\s*$/i.test(prefix)) continue;
    const command = match[0].replace(/[.!?。]+$/, "");
    const key = canonicalCheckCommand(command);
    if (key && !checks.some((item) => canonicalCheckCommand(item.command) === key)) checks.push({ command });
  }
  return normalizeRequiredChecks(checks, { source: "inferred" });
}

export function buildAcceptance({ task, intent, acceptance = {}, requiredChecks } = {}) {
  const conditionalNoChange = /(?:if\b[^.!。\n]*(?:already|necessary|needed)|(?:already|无需|不必|无需改动|无需修改|不需要修改)|若[^。\n]*(?:已|需要)|如(?:果)?[^。\n]*(?:已|需要))/i.test(String(task));
  const allowedCompletionTypes = acceptance.allowedCompletionTypes ?? (intent.requiresCodeChange
    ? ["modified", ...(conditionalNoChange ? ["no-change"] : []), "partial", "blocked"]
    : ["no-change", ...(intent.mayWrite ? ["modified"] : []), "partial", "blocked"]);
  if (!Array.isArray(allowedCompletionTypes) || allowedCompletionTypes.some((type) => !COMPLETION_TYPES.includes(type))) throw new Error("Invalid acceptance.allowedCompletionTypes");
  if (!allowedCompletionTypes.length) throw new Error("At least one allowed completion type is required");
  for (const requirement of acceptance.requirements ?? []) {
    if (requirement?.kind !== "file-content" || typeof requirement.path !== "string" || !requirement.path ||
      (typeof requirement.equals !== "string" && (typeof requirement.contains !== "string" || !requirement.contains))) throw new Error("Source requirements need file-content, path and equals or nonempty contains");
  }
  const targetPaths = acceptance.targetPaths ?? [...String(task).matchAll(/(?:^|[\s`@])((?:[\w.-]+\/)*[\w.-]+\.(?:js|ts|jsx|tsx|py|rs|go|swift|java|json|md|c|cpp|h))(?:\b|`)/g)].map((match) => match[1]);
  if (!Array.isArray(targetPaths) || targetPaths.some((path) => typeof path !== "string" || !path)) throw new Error("acceptance.targetPaths must contain paths");
  return { schemaVersion: 1, allowedCompletionTypes, targetPaths: [...new Set(targetPaths)],
    requirements: structuredClone(acceptance.requirements ?? []),
    requiredChecksSource: requiredChecks !== undefined || acceptance.requiredChecks !== undefined ? "explicit" : "inferred",
    requiredChecks: normalizeRequiredChecks(requiredChecks ?? acceptance.requiredChecks ?? inferRequiredChecks(task)),
    noChangeRequiresSourceEvidence: intent.requiresCodeChange || acceptance.noChangeRequiresSourceEvidence !== false };
}

export function matchingCheckIds(command, checks = [], { scope = "." } = {}) {
  const canonical = canonicalCheckCommand(command);
  return canonical ? checks.filter((check) => check.executionPaths?.some((path) => canonicalCheckCommand(path.command) === canonical && (path.scope ?? check.scope ?? ".") === scope)).map((check) => check.id) : [];
}

export function evaluateTaskAcceptance({ taskSpec, verificationPlan, verification, agentState, effects, completionType } = {}) {
  const contract = taskSpec?.acceptance;
  const requiredChecks = verificationPlan?.requiredChecks ?? taskSpec?.requiredChecks ?? contract?.requiredChecks ?? [];
  const modified = Boolean(agentState?.filesEdited?.length || effects?.events?.some((effect) => effect.type === "file-change"));
  const checks = requiredChecks.map((check) => {
    const attempts = (verification?.evidence ?? []).filter((item) => matchingCheckIds(item.command, [check], { scope: item.scope ?? "." }).length);
    const latest = attempts.at(-1);
    const revision = verification?.validationRevision ?? verification?.workspaceRevision;
    const fresh = latest && (latest.validatedRevision ?? latest.revision) === revision;
    return { id: check.id, target: check.target, scope: check.scope, required: check.required !== false,
      status: !latest ? "missing" : !latest.ok ? "failed" : !fresh ? "stale" : "passed",
      evidenceId: latest?.id, command: latest?.command, revision: latest?.revision, failureOrigin: latest?.failureOrigin };
  });
  const source = collectSourceEvidence(agentState, effects, verification);
  const requirements = (contract?.requirements ?? []).map((requirement) => {
    const observation = source.find((item) => item.path === requirement.path);
    const passed = requirement.kind === "file-content" && observation?.content !== undefined &&
      (requirement.equals === undefined || observation.content === requirement.equals) &&
      (requirement.contains === undefined || observation.content.includes(requirement.contains));
    return { id: requirement.id ?? "source:" + requirement.path, required: requirement.required !== false,
      status: passed ? "passed" : "missing", path: requirement.path, evidenceId: observation?.id };
  });
  const pending = [...checks, ...requirements].filter((check) => check.required && check.status !== "passed");
  const latestFailures = new Map();
  for (const item of verification?.evidence ?? []) {
    const ids = matchingCheckIds(item.command, requiredChecks, { scope: item.scope ?? "." });
    for (const key of ids.length ? ids.map((id) => "check:" + id) : [canonicalCheckCommand(item.command)]) latestFailures.set(key, item);
  }
  const failedEvidence = [...latestFailures.values()].filter((item) => !item.ok);
  const inferredType = modified ? "modified" : "no-change";
  const type = completionType ?? inferredType;
  const errors = [];
  const uncertain = Boolean(agentState?.uncertainFiles?.length);
  if (uncertain) errors.push("file mutation outcome is uncertain after an I/O or rollback failure; inspect these files before completing: " + agentState.uncertainFiles.join(", "));
  if (["partial", "blocked"].includes(type)) errors.push(`task outcome is ${type}, rather than fully completed`);
  for (const failure of failedEvidence) errors.push(`executed verification failed: ${failure.command}`);
  if (contract && !contract.allowedCompletionTypes.includes(type)) errors.push(`completion type ${type} is not allowed by the task contract`);
  for (const check of pending) errors.push(`required check ${check.id} (${check.target ?? check.path}) is ${check.status}`);
  if (contract && type === "no-change" && taskSpec.requiresCodeChange) {
    const paths = contract.targetPaths ?? [];
    const coverage = paths.length ? paths.every((path) => source.some((item) => item.path === path)) : source.length > 0;
    const proof = checks.some((check) => check.required && check.status === "passed") || requirements.some((check) => check.required && check.status === "passed");
    if (contract.noChangeRequiresSourceEvidence && (!coverage || !proof)) errors.push("no-change requires fresh complete source inspection and executed checks or source assertions proving the existing requirement");
  }
  const outcome = errors.length ? (uncertain || failedEvidence.length || checks.some((check) => check.status === "failed") ? "blocked" : "partial") : type;
  return { schemaVersion: 1, completionType: outcome, workResult: inferredType, requestedCompletionType: type, status: errors.length ? outcome : "satisfied",
    satisfied: errors.length === 0, checks, requirements, sourceEvidence: source.map(({ content, ...item }) => item), errors };
}

// File reads recorded before this revision can no longer serve as source evidence; later
// mutations only move it forward.
export function sourceEvidenceRevision(events = [], verification) {
  const checkIds = new Set((verification?.evidence ?? []).map((item) => item.id).filter(Boolean));
  return events.filter((event) => ["file-change", "workspace-uncertain"].includes(event.type) || (event.type === "command" && !checkIds.has(event.id))).at(-1)?.revision ?? 0;
}

function collectSourceEvidence(agentState, effects, verification) {
  const events = effects?.events ?? [];
  const lastMutation = sourceEvidenceRevision(events, verification);
  const current = verification?.workspaceRevision ?? effects?.revision ?? agentState?.workspaceRevision ?? 0;
  const out = events.filter((event) => event.type === "file-read" && !event.truncated && event.chars > 0 && event.revision >= lastMutation)
    .map((event) => ({ id: event.id, path: event.path, revision: event.revision, ...(typeof event.content === "string" ? { content: event.content } : {}) }));
  // Legacy callers keep executor observations in agentState. They are accepted
  // only as actual complete read tool results, never as model statements.
  for (const step of agentState?.steps ?? []) {
    if (step.toolCall?.name !== "read_file" || step.toolResult?.ok === false || step.toolResult?.truncated) continue;
    const content = step.toolResult?.content;
    if (typeof content !== "string" || !content || /\.\.\. truncated/.test(content)) continue;
    const path = step.toolCall.args?.path;
    if (events.length && !out.some((item) => item.path === path)) continue;
    const existing = out.find((item) => item.path === path);
    if (existing) existing.content = content;
    else out.push({ path, revision: current, content });
  }
  return out;
}
