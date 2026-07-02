import { paint, paintFixed } from "../terminal/theme.js";
import { truncateOneLine } from "./sessionView.js";

const ADD_STYLE = { fg: "#16a34a", effect: "bold" };
const DELETE_STYLE = { fg: "#dc2626", effect: "bold" };

export function formatActivityLine({ name, args, result }) {
  const activity = result?.activity ?? fallbackActivity(name, args, result);
  const icon = activityIcon(activity.kind);
  const label = result?.ok === false ? paint("error", activity.label + " failed") : paint("muted", activity.label);
  const target = activity.target ? " " + paint("inlineCode", activity.target) : "";
  const detail = activity.detail ? " " + paint("muted", activity.detail) : "";
  const changes = formatActivityChanges(activity);
  return paint("muted", icon) + " " + label + target + changes + detail;
}

export function formatActivityReason({ name, args }) {
  const target = activityReasonTarget(args);
  return activityReasonText(name, target);
}

function activityReasonTarget(args) {
  return args?.path ?? args?.directory ?? args?.query ?? args?.command ?? "";
}

function activityReasonText(name, target) {
  const subject = target ? paint("inlineCode", truncateOneLine(target, 120)) : "the workspace";
  const withSubject = (prefix, suffix) => paint("muted", prefix) + subject + paint("muted", suffix);
  const reasons = {
    list_files: () => withSubject("Inspecting ", " to understand the project structure before choosing the next step."),
    read_file: () => withSubject("Reading ", " to verify the current implementation before making changes."),
    search_text: () => withSubject("Searching for ", " to locate the relevant code path."),
    edit_file: () => withSubject("Updating ", " to apply the targeted change requested for this task."),
    write_file: () => withSubject("Writing ", " to persist the new or updated implementation."),
    git_status: () => paint("muted", "Checking git status to see which files changed in this workspace."),
    git_diff: () => paint("muted", "Reading the git diff to review the concrete code changes."),
    run_shell: () => withSubject("Running ", " to verify behavior or gather command output."),
    agent: () => withSubject("Delegating ", " to a scoped worker for independent progress."),
    send_message: () => withSubject("Continuing worker ", " with a focused follow-up."),
    task_stop: () => withSubject("Stopping worker ", " because its direction is no longer useful."),
  };
  return reasons[name]?.() ?? paint("muted", "Using " + name + " to continue the task.");
}

function fallbackActivity(name, args, result) {
  const target = args?.path ?? args?.directory ?? args?.command ?? "";
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

function activityIcon(kind) {
  if (kind === "read") return "▣";
  if (kind === "edit" || kind === "write" || kind === "create") return "✎";
  if (kind === "search") return "⌕";
  if (kind === "command") return "▻";
  if (kind === "subagent") return "◇";
  if (kind === "git") return "⑂";
  return "•";
}

function formatActivityChanges(activity) {
  const additions = Number(activity.additions ?? 0);
  const deletions = Number(activity.deletions ?? 0);
  if (!additions && !deletions) return "";
  return " " + paintFixed(ADD_STYLE, "+" + additions) + " " + paintFixed(DELETE_STYLE, "-" + deletions);
}


export function printCoordinationPlan(coordination) {
  if (!coordination?.complex) return;
  console.log(paint("title", "Coordination"));
  console.log(paint("muted", "Request type: " + coordination.requestType));
  printList("Split basis", coordination.basis);
  printList("Phases", (coordination.phases ?? []).map((phase) => phase.name + " - " + phase.reason));
  printList("Risk domains", (coordination.riskDomains ?? []).map((domain) => domain.name + " - " + domain.reason));
  printWorkers("Parallel candidates", coordination.parallel ?? []);
  printWorkers("Serial candidates", coordination.serial ?? []);
  if (coordination.verification) {
    printWorkers("Verification", [coordination.verification]);
  }
  console.log(paint("muted", "Execution: worker tools are available in-process; write-heavy overlapping work should remain serial."));
  console.log("");
}

function printList(title, items) {
  console.log(paint("muted", title + ":"));
  if (!items?.length) {
    console.log(paint("muted", "  - none"));
    return;
  }
  for (const item of items) {
    console.log(paint("muted", "  -") + " " + item);
  }
}

function printWorkers(title, workers) {
  console.log(paint("muted", title + ":"));
  if (!workers.length) {
    console.log(paint("muted", "  - none"));
    return;
  }
  for (const worker of workers) {
    const suffix = worker.reason ? paint("muted", " - " + worker.reason) : "";
    console.log(paint("muted", "  -") + " " + paint("inlineCode", worker.name) + " " + paint("muted", worker.goal) + suffix);
  }
}
