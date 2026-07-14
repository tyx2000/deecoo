import { paint, paintFixed } from "../terminal/theme.js";
import { truncateOneLine } from "./sessionView.js";

const ADD_STYLE = { fg: "#16a34a", effect: "bold" };
const DELETE_STYLE = { fg: "#dc2626", effect: "bold" };
const TREE = paint("muted", "└");
const BRANCH = paint("muted", "├");
const PREVIEW_LIMIT = 5;

export function formatActivityBlock({ name, args, result, decision }) {
  const activity = result?.activity ?? fallbackActivity(name, args, result);
  const ok = result?.ok !== false;
  const statusDot = paint(ok ? "success" : "error", "●");
  const title = formatActivityTitle({ name, args, activity, ok });
  const reason = formatDecisionReason({ decision, result });
  const summary = formatActivitySummary({ name, args, result, activity });
  const detailLines = reason ? [paint("muted", reason), ...summary] : summary;
  const lines = [statusDot + " " + title];
  if (detailLines.length === 0) return lines.join("\n");

  for (const [index, line] of detailLines.entries()) {
    const marker = index === detailLines.length - 1 ? TREE : BRANCH;
    lines.push("  " + marker + " " + line);
  }
  return lines.join("\n");
}

export function formatActivityStart({ name, args, decision }) {
  const activity = fallbackActivity(name, args, {});
  const title = toolCallTitle(name, args, activity);
  const reason = formatDecisionReason({ decision, result: undefined });
  const lines = [paint("muted", "○") + " " + paint("title", "Starting " + title)];
  if (reason) lines.push("  " + TREE + " " + paint("muted", reason));
  return lines.join("\n");
}

function formatDecisionReason({ decision, result }) {
  if (result?.code === "ALREADY_AVAILABLE") {
    const at = result.priorStep ? " from step " + result.priorStep : "";
    return "why: reused earlier result" + at + reasonSuffix(result.reason);
  }
  if (result?.code === "DUPLICATE_FAILURE_LOOP") {
    return "why: blocked repeated identical failure" + reasonSuffix(result.reason);
  }
  const reasons = decision?.reasons ?? [];
  if (reasons.length) {
    return "why: executed · " + reasons.map(humanizeReason).join(", ");
  }
  return "";
}

function reasonSuffix(reason) {
  return reason ? " · " + humanizeReason(reason) : "";
}

function humanizeReason(reason) {
  return String(reason ?? "").replace(/_/g, " ");
}

function fallbackActivity(name, args, result) {
  const target = args?.path ?? args?.directory ?? args?.command ?? args?.description ?? "";
  return {
    kind: name,
    label: toolLabel(name),
    target,
    detail: result?.error,
  };
}

function toolLabel(name) {
  const labels = {
    read_file: "Read a file",
    list_files: "Listed files",
    search_text: "Searched code",
    propose_patch: "Proposed a patch",
    propose_patch_set: "Proposed a patch set",
    apply_patch: "Applied a patch",
    apply_patch_set: "Applied a patch set",
    apply_json_patch: "Applied a JSON patch",
    edit_file: "Edited a file",
    write_file: "Wrote a file",
    git_status: "Checked git status",
    git_diff: "Read git diff",
    run_shell: "Ran command",
    agent: "Ran worker",
    send_message: "Continued worker",
    task_stop: "Stopped worker",
  };
  return labels[name] ?? "Ran " + name;
}

function formatActivityTitle({ name, args, activity, ok }) {
  const title = toolCallTitle(name, args, activity);
  const changes = formatActivityChanges(activity);
  const failed = ok ? "" : paint("error", " failed");
  const detail = ok && activity.detail ? paint("muted", " · " + truncateOneLine(activity.detail, 80)) : "";
  return paint("title", title) + changes + detail + failed;
}

function toolCallTitle(name, args, activity) {
  if (name === "run_shell") return "Bash(" + truncateOneLine(args?.command ?? activity.target ?? "", 120) + ")";
  if (name === "read_file") return "Read(" + truncateOneLine(args?.path ?? activity.target ?? "", 120) + ")";
  if (name === "list_files") return "List(" + truncateOneLine(args?.directory ?? activity.target ?? ".", 120) + ")";
  if (name === "search_text") return "Search(" + truncateOneLine(args?.query ?? "", 90) + ")";
  if (name === "propose_patch") return "Patch(" + fileTarget(args, activity) + ")";
  if (name === "propose_patch_set") return "PatchSet(" + truncateOneLine(activity.target ?? "files", 120) + ")";
  if (name === "apply_patch") return "ApplyPatch(" + fileTarget(args, activity) + ")";
  if (name === "apply_patch_set") return "ApplyPatchSet(" + truncateOneLine(activity.target ?? "files", 120) + ")";
  if (name === "apply_json_patch") return "JsonPatch(" + fileTarget(args, activity) + ")";
  if (name === "edit_file") return "Edit(" + fileTarget(args, activity) + ")";
  if (name === "write_file") return "Write(" + fileTarget(args, activity) + ")";
  if (name === "git_status") return "Git(status)";
  if (name === "git_diff") return args?.staged ? "Git(diff --staged)" : "Git(diff)";
  if (name === "agent") return "Agent(" + truncateOneLine(activity.target ?? args?.description ?? "worker", 120) + ")";
  if (name === "send_message") return "AgentMessage(" + truncateOneLine(args?.to ?? activity.target ?? "worker", 80) + ")";
  if (name === "task_stop") return "AgentStop(" + truncateOneLine(args?.task_id ?? activity.target ?? "worker", 80) + ")";
  return toolLabel(name) + formatTargetSuffix(activity.target);
}

function fileTarget(args, activity) {
  return truncateOneLine(args?.path || activity.target || "<invalid arguments>", 120);
}

function formatTargetSuffix(target) {
  return target ? "(" + truncateOneLine(target, 120) + ")" : "";
}

function formatActivitySummary({ name, args, result, activity }) {
  if (result?.ok === false) {
    return [paint("error", truncateOneLine(result.error ?? "Tool failed", 180)), ...previewToolOutput(result)];
  }

  if (name === "run_shell") {
    return previewToolOutput(result, { emptyLabel: "(No output)" });
  }

  if (name === "git_status") {
    return previewText(result?.status, { emptyLabel: "(Clean working tree)" });
  }

  if (name === "git_diff") {
    return previewText(result?.diff, { emptyLabel: "(No diff)" });
  }

  if (name === "search_text") {
    const matches = result?.matches ?? [];
    if (!matches.length) return [paint("muted", "(No matches)")];
    return [
      paint("muted", String(matches.length) + " match" + (matches.length === 1 ? "" : "es")),
      ...matches.slice(0, PREVIEW_LIMIT).map((match) => paint("muted", truncateOneLine(match, 180))),
      ...truncatedLine(matches.length - PREVIEW_LIMIT),
    ];
  }

  if (name === "list_files") {
    const files = result?.files ?? [];
    if (!files.length) return [paint("muted", "(Empty)")];
    return [
      paint("muted", String(files.length) + " item" + (files.length === 1 ? "" : "s")),
      ...files.slice(0, PREVIEW_LIMIT).map((file) => paint("muted", truncateOneLine(file, 160))),
      ...truncatedLine(files.length - PREVIEW_LIMIT),
    ];
  }

  if (name === "read_file") {
    const meta = [activity.detail, result?.truncated ? "truncated" : ""].filter(Boolean).join(" · ");
    return [paint("muted", meta || "Read complete")];
  }

  if (name === "propose_patch") {
    return [paint("muted", "Patch proposal only; not applied"), ...previewText(result?.patch, { limit: 3 })];
  }

  if (name === "propose_patch_set") {
    return [
      paint("muted", "Patch set proposal only; not applied"),
      ...(result?.files ?? []).slice(0, PREVIEW_LIMIT).map((file) => paint("muted", truncateOneLine(`${file.action}: ${file.from ? `${file.from} -> ` : ""}${file.path}`, 160))),
      ...truncatedLine((result?.files?.length ?? 0) - PREVIEW_LIMIT),
    ];
  }

  if (name === "apply_patch") {
    return [paint("muted", String(result?.hunksApplied ?? 0) + " hunk" + (result?.hunksApplied === 1 ? "" : "s") + " applied")];
  }

  if (name === "apply_patch_set") {
    return [
      paint("muted", String(result?.hunksApplied ?? 0) + " hunk" + (result?.hunksApplied === 1 ? "" : "s") + " across " + String(result?.filesChanged ?? 0) + " file" + (result?.filesChanged === 1 ? "" : "s")),
      ...(result?.paths ?? []).slice(0, PREVIEW_LIMIT).map((path) => paint("muted", truncateOneLine(path, 160))),
      ...truncatedLine((result?.paths?.length ?? 0) - PREVIEW_LIMIT),
    ];
  }

  if (name === "apply_json_patch") {
    return [paint("muted", String(result?.operationsApplied ?? 0) + " operation" + (result?.operationsApplied === 1 ? "" : "s") + " applied")];
  }

  if (name === "edit_file" || name === "write_file") {
    const bytes = Number(result?.bytesWritten ?? 0);
    return [paint("muted", bytes ? String(bytes) + " bytes written" : "Write complete")];
  }

  if (name === "agent" || name === "send_message" || name === "task_stop") {
    const usage = result?.usage?.totalTokens ? " · " + compactNumber(result.usage.totalTokens) + " tokens" : "";
    const status = result?.status ? result.status + usage : activity.label + usage;
    return [paint("muted", status), ...previewText(result?.summary || result?.result, { limit: 2 })];
  }

  return activity.detail ? [paint("muted", truncateOneLine(activity.detail, 180))] : [];
}

function previewToolOutput(result, { emptyLabel = "" } = {}) {
  if (result?.failureSummary) return previewText(result.failureSummary, { emptyLabel });
  return previewText([result?.stdout, result?.stderr].filter(Boolean).join("\n"), { emptyLabel });
}

function previewText(value, { emptyLabel = "", limit = PREVIEW_LIMIT } = {}) {
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (!lines.length) return emptyLabel ? [paint("muted", emptyLabel)] : [];
  return [
    ...lines.slice(0, limit).map((line) => paint("muted", truncateOneLine(line, 180))),
    ...truncatedLine(lines.length - limit),
  ];
}

function truncatedLine(count) {
  return count > 0 ? [paint("muted", "... +" + count + " lines (details retained in tool result)")] : [];
}

function formatActivityChanges(activity) {
  const additions = Number(activity.additions ?? 0);
  const deletions = Number(activity.deletions ?? 0);
  if (!additions && !deletions) return "";
  return " " + paintFixed(ADD_STYLE, "+" + additions) + " " + paintFixed(DELETE_STYLE, "-" + deletions);
}


export function createPhaseProgress(coordination) {
  let currentPhase;
  const enabled = coordination?.complex === true;

  const transition = (phase, detail = "") => {
    if (!enabled || !phase || phase === currentPhase) return "";
    currentPhase = phase;
    return paint("title", "Phase") + paint("muted", " · ") + paint("title", phase) + (detail ? paint("muted", " · " + detail) : "");
  };

  return {
    start() {
      return transition("Planning", coordinationStartDetail(coordination));
    },
    tool({ name, args }) {
      const phase = phaseForTool(name, args, coordination);
      return transition(phase, phaseDetail(name, args));
    },
  };
}

function coordinationStartDetail(coordination) {
  const requestType = coordination?.requestType ?? "task";
  const domains = (coordination?.riskDomains ?? []).map((domain) => domain.name);
  return domains.length ? requestType + " · focus: " + domains.join(", ") : requestType;
}

function phaseForTool(name, args, coordination) {
  if (name === "agent") {
    const mode = String(args?.mode ?? args?.subagent_type ?? "research").toLowerCase();
    if (mode === "verify" || args?.role === "tester") return "Verification";
    if (mode === "implement" || args?.role === "coder") return "Implementation";
    if (coordination?.requestType === "review" || args?.role === "reviewer" || args?.role === "security") return "Risk review";
    return "Research";
  }
  if (name === "run_shell") return "Verification";
  if (["propose_patch", "propose_patch_set", "apply_patch", "apply_patch_set", "apply_json_patch", "edit_file", "write_file"].includes(name)) {
    return "Implementation";
  }
  if (["list_files", "read_file", "search_text", "git_status", "git_diff"].includes(name)) return "Research";
  return undefined;
}

function phaseDetail(name, args) {
  if (name !== "agent") return "";
  return truncateOneLine(args?.description ?? args?.role ?? "worker", 100);
}

function compactNumber(value) {
  const number = Number(value ?? 0);
  if (number >= 1000) return (number / 1000).toFixed(number >= 10000 ? 0 : 1) + "k";
  return String(number);
}
