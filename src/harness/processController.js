const IDEMPOTENT_TOOLS = new Set(["list_files", "read_file", "search_text", "git_status", "git_diff"]);
const MUTATING_TOOLS = new Set([
  "edit_file",
  "write_file",
  "apply_patch",
  "apply_patch_set",
  "apply_json_patch",
  "run_shell",
]);
const PROGRESS_TOOLS = new Set([
  "edit_file",
  "write_file",
  "apply_patch",
  "apply_patch_set",
  "apply_json_patch",
  "propose_patch",
  "propose_patch_set",
  "run_shell",
  "agent",
  "send_message",
  "task_stop",
]);

const DEFAULTS = {
  duplicateWindow: 12,
  maxIdenticalSuccesses: 1,
  maxIdenticalFailures: 2,
  thrashInspectionStreak: 4,
  thrashNudgeCooldownSteps: 2,
  maxPinnedFiles: 8,
  maxPinnedFileChars: 12000,
  maxPinnedSearchChars: 4000,
  maxHistory: 80,
  maxObservations: 200,
};

export function createProcessController(options = {}) {
  const { restore, ...configOptions } = options;
  const config = { ...DEFAULTS, ...configOptions };
  const controller = {
    config,
    history: [],
    observations: new Map(),
    workingSet: {
      files: new Map(),
      searches: [],
      lists: [],
      git: {},
    },
    metrics: emptyMetrics(),
    lastNudgeStep: 0,
    lastProgressStep: 0,
    lastMutationStep: 0,
    // Per-lane mutation steps let one controller be shared across concurrent workers without
    // a mutation in one lane invalidating another lane's observations. Unset lane === single
    // lane, which keeps existing behavior exactly.
    laneMutation: new Map(),
  };
  if (restore) restoreProcessController(controller, restore);
  return controller;
}

// Serialize enough of the controller that a resumed run keeps its dedup memory and pinned
// working set instead of re-reading everything it had already inspected.
export function serializeProcessController(controller) {
  return {
    history: controller.history.slice(-controller.config.maxHistory),
    observations: [...controller.observations.entries()],
    workingSet: {
      files: [...controller.workingSet.files.entries()],
      searches: controller.workingSet.searches.slice(),
      lists: controller.workingSet.lists.slice(),
      git: { ...controller.workingSet.git },
    },
    metrics: { ...controller.metrics },
    lastMutationStep: controller.lastMutationStep,
    lastProgressStep: controller.lastProgressStep,
    laneMutation: [...controller.laneMutation.entries()],
  };
}

function restoreProcessController(controller, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (Array.isArray(snapshot.history)) controller.history = structuredClone(snapshot.history);
  if (Array.isArray(snapshot.observations)) controller.observations = new Map(structuredClone(snapshot.observations));
  if (snapshot.workingSet) {
    controller.workingSet.files = new Map(structuredClone(snapshot.workingSet.files ?? []));
    controller.workingSet.searches = structuredClone(snapshot.workingSet.searches ?? []);
    controller.workingSet.lists = structuredClone(snapshot.workingSet.lists ?? []);
    controller.workingSet.git = structuredClone(snapshot.workingSet.git ?? {});
  }
  if (snapshot.metrics) controller.metrics = { ...controller.metrics, ...snapshot.metrics };
  if (Number.isFinite(snapshot.lastMutationStep)) controller.lastMutationStep = snapshot.lastMutationStep;
  if (Number.isFinite(snapshot.lastProgressStep)) controller.lastProgressStep = snapshot.lastProgressStep;
  if (Array.isArray(snapshot.laneMutation)) controller.laneMutation = new Map(snapshot.laneMutation);
}

function laneMutationStep(controller, lane) {
  return lane ? controller.laneMutation.get(lane) ?? 0 : controller.lastMutationStep;
}

export function toolSignature(name, args = {}) {
  return `${name}::${stableStringify(normalizeArgs(name, args))}`;
}

export function evaluateToolCall(controller, { name, args, step, lane }) {
  controller.metrics.totalEvaluated += 1;
  const signature = toolSignature(name, args);
  const baseline = laneMutationStep(controller, lane);
  const prior = freshObservation(controller, signature, baseline, lane);

  // Near-duplicate read: the same file was already captured in full (possibly under a
  // different maxBytes) and nothing has mutated since. Reuse it instead of re-reading.
  if (!prior && name === "read_file") {
    const reusable = reusableFullRead(controller, args, baseline, lane);
    if (reusable) {
      controller.metrics.duplicatesBlocked += 1;
      return {
        action: "short_circuit",
        signature,
        reasons: ["file_already_captured"],
        result: shortCircuitResult(name, args, reusable, {
          reason: "file_already_captured",
          suggestion:
            "You already captured this file's full contents in a prior read. Reuse that instead of reading it again; only re-read after an edit, or if you need a genuinely larger range of a previously truncated file.",
        }),
      };
    }
  }

  if (!prior) {
    return { action: "allow", signature, reasons: [] };
  }

  const identicalInWindow = countRecentIdentical(controller, signature, controller.config.duplicateWindow, baseline, lane);
  const reasons = [];

  if (IDEMPOTENT_TOOLS.has(name) && prior.ok) {
    if (identicalInWindow >= controller.config.maxIdenticalSuccesses) {
      controller.metrics.duplicatesBlocked += 1;
      return {
        action: "short_circuit",
        signature,
        reasons: ["duplicate_idempotent_success"],
        result: shortCircuitResult(name, args, prior, {
          reason: "duplicate_idempotent_success",
          suggestion:
            "This observation is already available and still valid. Reuse the prior result instead of repeating the same inspection. Proceed to the next concrete step (edit, verify, or a new path).",
        }),
      };
    }
  }

  if (name === "run_shell" && prior.ok) {
    if (identicalInWindow >= controller.config.maxIdenticalSuccesses) {
      controller.metrics.duplicatesBlocked += 1;
      return {
        action: "short_circuit",
        signature,
        reasons: ["duplicate_successful_shell"],
        result: shortCircuitResult(name, args, prior, {
          reason: "duplicate_successful_shell",
          suggestion:
            "This command already succeeded recently with no intervening relevant change. Reuse that outcome; only re-run after edits or if you need different flags/cwd.",
        }),
      };
    }
  }

  if (!prior.ok && identicalInWindow >= controller.config.maxIdenticalFailures) {
    controller.metrics.duplicatesBlocked += 1;
    return {
      action: "short_circuit",
      signature,
      reasons: ["duplicate_failure_loop"],
      result: {
        ok: false,
        code: "DUPLICATE_FAILURE_LOOP",
        alreadyAvailable: true,
        recoverable: true,
        priorStep: prior.step,
        signature,
        error: prior.error || prior.code || "Repeated the same failing tool call.",
        suggestion:
          "Stop repeating the same failing call. Change the path/query/command, inspect a parent directory, or pick a different approach.",
        activity: {
          kind: "process-guard",
          label: "Blocked repeated failure",
          target: toolTarget(name, args),
          detail: `same as step ${prior.step}`,
        },
      },
    };
  }

  if (identicalInWindow >= 1) {
    reasons.push("recent_repeat");
  }
  return { action: "allow", signature, reasons };
}

export function recordToolObservation(controller, { name, args, result, step, lane }) {
  const signature = toolSignature(name, args);
  const ok = result?.ok !== false;
  const target = toolTarget(name, args, result);
  const entry = {
    step,
    lane,
    name,
    args: compactArgs(args),
    signature,
    ok,
    code: result?.code,
    error: result?.error,
    target,
    alreadyAvailable: Boolean(result?.alreadyAvailable || result?.code === "ALREADY_AVAILABLE"),
    summary: observationSummary(name, target, ok, result),
    pinned: pinPayload(name, args, result),
    at: new Date().toISOString(),
  };

  controller.history.push({
    step,
    lane,
    name,
    signature,
    ok,
    target,
    alreadyAvailable: entry.alreadyAvailable,
    progress: PROGRESS_TOOLS.has(name) && ok && !entry.alreadyAvailable,
  });
  if (controller.history.length > controller.config.maxHistory) {
    controller.history = controller.history.slice(-controller.config.maxHistory);
  }

  // Keep the first full observation; short-circuit reuse should not wipe pinned payload.
  if (!entry.alreadyAvailable || !controller.observations.has(signature)) {
    controller.observations.set(signature, entry);
  }
  trimMap(controller.observations, controller.config.maxObservations);
  controller.metrics.totalTools += 1;
  if (entry.alreadyAvailable) controller.metrics.reusesServed += 1;

  updateWorkingSet(controller, entry, result);

  if (MUTATING_TOOLS.has(name) && ok && !entry.alreadyAvailable) {
    if (lane) controller.laneMutation.set(lane, step);
    else controller.lastMutationStep = step;
    invalidateAfterMutation(controller, name, args, result);
  }
  if (PROGRESS_TOOLS.has(name) && ok && !entry.alreadyAvailable) {
    controller.lastProgressStep = step;
    controller.metrics.progressEvents += 1;
  }

  return entry;
}

// Detect A→B→A→B style oscillation: a repeating cycle of non-identical tool calls that the
// identical-repeat guard misses. Scans the recent signature stream for a block of period p
// (2..maxPeriod) that repeats at least `minRepeats` times back-to-back.
export function detectOscillation(controller, { maxPeriod = 4, minRepeats = 2 } = {}) {
  for (let period = 2; period <= maxPeriod; period += 1) {
    const needed = period * minRepeats;
    if (controller.history.length < needed) continue;
    const window = controller.history.slice(-needed);
    // A cycle that includes real progress (an edit, patch, verify shell, or worker) is genuine
    // iterative work, not thrashing — never flag it as oscillation.
    if (window.some((item) => item.progress || (PROGRESS_TOOLS.has(item.name) && item.ok && !item.alreadyAvailable))) continue;
    const block = window.slice(0, period).map((item) => item.signature);
    if (new Set(block).size < 2) continue; // identical repeats are handled elsewhere
    let matches = true;
    for (let i = period; i < window.length && matches; i += 1) {
      if (window[i].signature !== window[i - period].signature) matches = false;
    }
    if (matches) {
      return { oscillating: true, period, repeats: minRepeats, cycle: controller.history.slice(-period).map((item) => `${item.name}(${item.target || ""})`) };
    }
  }
  return { oscillating: false };
}

export function maybeBuildProcessNudge(controller, { step } = {}) {
  const cooldown = controller.config.thrashNudgeCooldownSteps;
  const canNudge = step - controller.lastNudgeStep > cooldown;

  const oscillation = detectOscillation(controller);
  if (oscillation.oscillating && canNudge) {
    controller.lastNudgeStep = step;
    controller.metrics.thrashNudges += 1;
    return {
      role: "user",
      content: [
        "Process guard (harness):",
        `- You are oscillating: the tool sequence ${oscillation.cycle.join(" -> ")} has repeated with period ${oscillation.period} and is not making progress.`,
        "Required next step:",
        "1. Break the loop — do not repeat that sequence.",
        "2. Choose a materially different approach: make a concrete edit, run a decisive verification, delegate a worker, or explain the blocker to the user.",
      ].join("\n"),
    };
  }

  const streak = inspectionStreak(controller);
  if (streak < controller.config.thrashInspectionStreak) return undefined;
  if (!canNudge) return undefined;

  controller.lastNudgeStep = step;
  controller.metrics.thrashNudges += 1;
  const recent = controller.history.slice(-streak).map((item) => `${item.name}(${item.target || ""})`).join(", ");
  const working = workingSetBrief(controller);
  return {
    role: "user",
    content: [
      "Process guard (harness):",
      `- You have made ${streak} consecutive inspection-only tool calls without progress (edit, patch, verify shell, or worker).`,
      `- Recent inspections: ${recent}`,
      working ? `- Working set already available:\n${working}` : "- Working set: none pinned yet.",
      "Required next step:",
      "1. Stop re-inspecting the same paths/queries.",
      "2. Either make a minimal edit/patch, run a focused verification command, delegate a worker, or explain a concrete blocker.",
      "3. Only re-read a file if it was edited, truncated, or the pinned content is insufficient for the next action.",
    ].join("\n"),
  };
}

export function buildWorkingSetSummary(controller) {
  const lines = [
    "Working-set observations (pinned; prefer these over re-inspection):",
    workingSetBrief(controller) || "- (empty)",
  ];

  const files = [...controller.workingSet.files.values()].slice(-controller.config.maxPinnedFiles);
  for (const file of files) {
    lines.push("");
    lines.push(`### file: ${file.path}`);
    lines.push(`- step: ${file.step}`);
    lines.push(`- truncated: ${file.truncated ? "true" : "false"}`);
    if (file.shaHint) lines.push(`- shaHint: ${file.shaHint}`);
    lines.push("```");
    lines.push(file.content);
    lines.push("```");
  }

  if (controller.workingSet.searches.length) {
    lines.push("");
    lines.push("### recent searches");
    for (const search of controller.workingSet.searches.slice(-4)) {
      lines.push(`- step ${search.step}: query=${JSON.stringify(search.query)} dir=${search.directory || "."}`);
      lines.push(indent(search.summary));
    }
  }

  if (controller.workingSet.lists.length) {
    lines.push("");
    lines.push("### recent directory listings");
    for (const list of controller.workingSet.lists.slice(-4)) {
      lines.push(`- step ${list.step}: ${list.directory} (${list.count} entries)`);
      if (list.preview) lines.push(indent(list.preview));
    }
  }

  if (controller.workingSet.git.status || controller.workingSet.git.diff) {
    lines.push("");
    lines.push("### git");
    if (controller.workingSet.git.status) {
      lines.push("- status @ step " + controller.workingSet.git.status.step + ":");
      lines.push(indent(controller.workingSet.git.status.content));
    }
    if (controller.workingSet.git.diff) {
      lines.push("- diff @ step " + controller.workingSet.git.diff.step + ":");
      lines.push(indent(controller.workingSet.git.diff.content));
    }
  }

  lines.push("");
  lines.push(
    "Do not repeat list_files/read_file/search_text/git_* for targets already summarized above unless the file was edited, the observation was truncated, or you need a different range/query.",
  );
  return lines.join("\n");
}

export function hasWorkingSet(controller) {
  const workingSet = controller.workingSet;
  return Boolean(
    workingSet.files.size ||
      workingSet.searches.length ||
      workingSet.lists.length ||
      workingSet.git.status ||
      workingSet.git.diff,
  );
}

export function snapshotProcessMetrics(controller) {
  const totalTools = controller.metrics.totalTools;
  const uniqueTargets = new Set(controller.history.map((item) => `${item.name}:${item.target}`)).size;
  return {
    ...controller.metrics,
    totalTools,
    uniqueTargets,
    historyLength: controller.history.length,
    pinnedFiles: controller.workingSet.files.size,
    duplicateRate: totalTools ? Number((controller.metrics.duplicatesBlocked / totalTools).toFixed(3)) : 0,
    inspectionOnlyStreak: inspectionStreak(controller),
  };
}

export function analyzeProcessQuality(run) {
  const trace = Array.isArray(run?.trace) ? run.trace : [];
  const process = run?.process ?? run?.agentState?.process;
  const inspectionCounts = new Map();
  const successfulShellAt = new Map();
  let duplicates = 0;
  let inspectionStreakMax = 0;
  let currentInspectionStreak = 0;
  let progressCount = 0;
  let alreadyAvailable = 0;
  let lastProgressIndex = -1;

  for (let index = 0; index < trace.length; index += 1) {
    const entry = trace[index];
    const name = entry.tool ?? entry.name ?? "";
    const target = String(entry.target ?? "");
    const signature = `${name}::${target}`;
    const reused = Boolean(entry.cached || entry.code === "ALREADY_AVAILABLE" || entry.alreadyAvailable);
    if (reused) alreadyAvailable += 1;

    if (IDEMPOTENT_TOOLS.has(name) || reused) {
      if (IDEMPOTENT_TOOLS.has(name)) {
        const count = (inspectionCounts.get(signature) ?? 0) + 1;
        inspectionCounts.set(signature, count);
        if (count > 1) duplicates += 1;
      }
      currentInspectionStreak += 1;
      inspectionStreakMax = Math.max(inspectionStreakMax, currentInspectionStreak);
      continue;
    }

    if (name === "run_shell") {
      currentInspectionStreak = 0;
      if (entry.ok === false) continue;
      const priorIndex = successfulShellAt.get(signature);
      // Same successful shell with no intervening edit/progress is wasteful.
      // fail -> edit -> re-run is intentional recovery and is not counted.
      if (priorIndex !== undefined && lastProgressIndex <= priorIndex) {
        duplicates += 1;
      }
      successfulShellAt.set(signature, index);
      progressCount += 1;
      lastProgressIndex = index;
      continue;
    }

    if (PROGRESS_TOOLS.has(name) && entry.ok !== false) {
      progressCount += 1;
      lastProgressIndex = index;
      currentInspectionStreak = 0;
      continue;
    }

    currentInspectionStreak = 0;
  }

  const toolCalls = trace.length;
  const duplicateRate = toolCalls ? duplicates / toolCalls : 0;
  const processDuplicateRate = process?.duplicateRate ?? duplicateRate;
  const thrashNudges = process?.thrashNudges ?? 0;
  const duplicatesBlocked = process?.duplicatesBlocked ?? alreadyAvailable;

  // Soft efficiency score in [0, 1]: penalize wasteful re-inspection and thrash, not recovery loops.
  let efficiency = 1;
  efficiency -= Math.min(0.45, duplicateRate * 1.2);
  efficiency -= Math.min(0.3, Math.max(0, inspectionStreakMax - 3) * 0.08);
  if (toolCalls >= 4 && progressCount === 0) efficiency -= 0.2;
  efficiency = Math.max(0, Math.min(1, efficiency));

  return {
    toolCalls,
    duplicates,
    duplicateRate: Number(duplicateRate.toFixed(3)),
    processDuplicateRate: Number(processDuplicateRate.toFixed(3)),
    duplicatesBlocked,
    thrashNudges,
    inspectionStreakMax,
    progressCount,
    alreadyAvailable,
    efficiency: Number(efficiency.toFixed(3)),
  };
}

function emptyMetrics() {
  return {
    totalEvaluated: 0,
    totalTools: 0,
    duplicatesBlocked: 0,
    reusesServed: 0,
    thrashNudges: 0,
    progressEvents: 0,
  };
}

function shortCircuitResult(name, args, prior, { reason, suggestion }) {
  const result = {
    ok: true,
    code: "ALREADY_AVAILABLE",
    alreadyAvailable: true,
    cached: true,
    reason,
    priorStep: prior.step,
    signature: prior.signature,
    suggestion,
    path: args?.path ?? prior.target,
    activity: {
      kind: "process-guard",
      label: "Reused observation",
      target: toolTarget(name, args),
      detail: `same as step ${prior.step}`,
    },
  };

  if (prior.pinned?.content !== undefined) {
    result.content = prior.pinned.content;
    result.truncated = prior.pinned.truncated;
  }
  if (prior.pinned?.files) result.files = prior.pinned.files;
  if (prior.pinned?.matches) result.matches = prior.pinned.matches;
  if (prior.pinned?.status !== undefined) result.status = prior.pinned.status;
  if (prior.pinned?.diff !== undefined) result.diff = prior.pinned.diff;
  if (prior.pinned?.stdout !== undefined) result.stdout = prior.pinned.stdout;
  if (prior.summary) result.summary = prior.summary;
  return result;
}

function updateWorkingSet(controller, entry, result) {
  if (entry.alreadyAvailable && entry.name !== "read_file") return;

  if (entry.name === "read_file" && entry.ok && result?.content !== undefined) {
    const path = String(entry.args?.path ?? entry.target ?? "");
    if (!path) return;
    const original = String(result.content);
    const content = truncateText(original, controller.config.maxPinnedFileChars);
    controller.workingSet.files.set(path, {
      path,
      step: entry.step,
      content,
      truncated: Boolean(result.truncated) || original.length > controller.config.maxPinnedFileChars,
      shaHint: simpleHash(original).slice(0, 8),
    });
    trimMap(controller.workingSet.files, controller.config.maxPinnedFiles);
    return;
  }

  if (entry.name === "list_files" && entry.ok) {
    const files = Array.isArray(result?.files) ? result.files : [];
    controller.workingSet.lists.push({
      step: entry.step,
      directory: String(entry.args?.directory ?? "."),
      count: files.length,
      preview: files.slice(0, 40).join("\n"),
    });
    controller.workingSet.lists = controller.workingSet.lists.slice(-6);
    return;
  }

  if (entry.name === "search_text" && entry.ok) {
    const matches = Array.isArray(result?.matches) ? result.matches : [];
    controller.workingSet.searches.push({
      step: entry.step,
      query: String(entry.args?.query ?? ""),
      directory: String(entry.args?.directory ?? ""),
      summary: truncateText(
        matches
          .slice(0, 20)
          .map((match) => (typeof match === "string" ? match : JSON.stringify(match)))
          .join("\n"),
        controller.config.maxPinnedSearchChars,
      ),
    });
    controller.workingSet.searches = controller.workingSet.searches.slice(-6);
    return;
  }

  if (entry.name === "git_status" && entry.ok) {
    controller.workingSet.git.status = {
      step: entry.step,
      content: truncateText(String(result?.status ?? result?.content ?? ""), 4000),
    };
    return;
  }

  if (entry.name === "git_diff" && entry.ok) {
    controller.workingSet.git.diff = {
      step: entry.step,
      content: truncateText(String(result?.diff ?? result?.content ?? ""), 6000),
    };
  }
}

function invalidateAfterMutation(controller, name, args, result) {
  // Observation staleness for the dedup gate is handled centrally by lastMutationStep;
  // here we only prune the pinned working set that feeds the compaction summary so it
  // never surfaces content the mutation may have changed.
  for (const path of editedPaths(name, args, result)) {
    controller.workingSet.files.delete(path);
  }

  // A shell command can touch arbitrary files, so its edited paths are unknown — drop all
  // pinned reads to avoid surfacing stale file bodies after a codemod/formatter/etc.
  if (name === "run_shell") {
    controller.workingSet.files.clear();
  }

  // Directory listings and git snapshots are often stale after writes/shell.
  controller.workingSet.lists = [];
  controller.workingSet.git = {};
}

function editedPaths(name, args, result) {
  if (!["edit_file", "write_file", "apply_patch", "apply_patch_set", "apply_json_patch"].includes(name)) return [];
  if (Array.isArray(result?.files)) return result.files.map((file) => file.path ?? file).filter(Boolean).map(String);
  if (Array.isArray(args?.files)) return args.files.map((file) => file.path ?? file.from).filter(Boolean).map(String);
  return [args?.path].filter(Boolean).map(String);
}

function inspectionStreak(controller) {
  let streak = 0;
  for (let index = controller.history.length - 1; index >= 0; index -= 1) {
    const item = controller.history[index];
    if (IDEMPOTENT_TOOLS.has(item.name) || item.alreadyAvailable) {
      streak += 1;
      continue;
    }
    if (PROGRESS_TOOLS.has(item.name) && item.ok) break;
    if (!IDEMPOTENT_TOOLS.has(item.name)) break;
  }
  return streak;
}

function freshObservation(controller, signature, baseline = controller.lastMutationStep, lane) {
  const prior = controller.observations.get(signature);
  if (!prior) return undefined;
  if (lane && prior.lane !== lane) return undefined;
  // An observation recorded before the most recent mutation may be stale.
  if (prior.step < baseline) return undefined;
  return prior;
}

function reusableFullRead(controller, args, baseline = controller.lastMutationStep, lane) {
  const path = String(args?.path ?? "");
  if (!path) return undefined;
  let best;
  for (const observation of controller.observations.values()) {
    if (observation.name !== "read_file" || observation.target !== path) continue;
    if (lane && observation.lane !== lane) continue;
    if (!observation.ok || observation.pinned?.truncated) continue;
    if (observation.step < baseline) continue;
    if (!best || observation.step > best.step) best = observation;
  }
  return best;
}

function countRecentIdentical(controller, signature, windowSize, baseline = controller.lastMutationStep, lane) {
  const recent = controller.history.slice(-windowSize);
  return recent.filter(
    (item) => item.signature === signature && item.step >= baseline && (!lane || item.lane === lane),
  ).length;
}

function workingSetBrief(controller) {
  const lines = [];
  const files = [...controller.workingSet.files.keys()];
  if (files.length) lines.push("  - files: " + files.join(", "));
  if (controller.workingSet.searches.length) {
    lines.push(
      "  - searches: " +
        controller.workingSet.searches
          .slice(-3)
          .map((item) => JSON.stringify(item.query))
          .join(", "),
    );
  }
  if (controller.workingSet.lists.length) {
    lines.push(
      "  - listed: " +
        controller.workingSet.lists
          .slice(-3)
          .map((item) => item.directory)
          .join(", "),
    );
  }
  if (controller.workingSet.git.status) lines.push("  - git_status: pinned");
  if (controller.workingSet.git.diff) lines.push("  - git_diff: pinned");
  return lines.join("\n");
}

function pinPayload(name, args, result) {
  if (!result || result.ok === false) return undefined;
  if (name === "read_file") {
    const original = String(result.content ?? "");
    return {
      content: truncateText(original, DEFAULTS.maxPinnedFileChars),
      truncated: Boolean(result.truncated) || original.length > DEFAULTS.maxPinnedFileChars,
    };
  }
  if (name === "list_files") {
    return { files: Array.isArray(result.files) ? result.files.slice(0, 120) : result.files };
  }
  if (name === "search_text") {
    return { matches: Array.isArray(result.matches) ? result.matches.slice(0, 40) : result.matches };
  }
  if (name === "git_status") {
    return { status: truncateText(String(result.status ?? ""), 4000) };
  }
  if (name === "git_diff") {
    return { diff: truncateText(String(result.diff ?? ""), 6000) };
  }
  if (name === "run_shell") {
    return {
      stdout: truncateText(String(result.stdout ?? ""), 4000),
      status: result.status,
    };
  }
  return undefined;
}

function observationSummary(name, target, ok, result) {
  if (result?.summary) return truncateText(String(result.summary), 400);
  if (!ok) return `${name} failed${target ? " on " + target : ""}: ${truncateText(result?.error ?? result?.code ?? "", 300)}`;
  if (target) return `${name} ${target}`;
  return name;
}

function normalizeArgs(name, args = {}) {
  if (!args || typeof args !== "object") return {};
  if (name === "read_file") {
    return { path: String(args.path ?? ""), maxBytes: args.maxBytes ?? null };
  }
  if (name === "list_files") {
    return { directory: String(args.directory ?? "."), maxDepth: args.maxDepth ?? null };
  }
  if (name === "search_text") {
    return {
      query: String(args.query ?? ""),
      directory: String(args.directory ?? ""),
      maxResults: args.maxResults ?? null,
    };
  }
  if (name === "git_diff") {
    return { path: String(args.path ?? ""), ref: String(args.ref ?? ""), staged: Boolean(args.staged) };
  }
  if (name === "run_shell") {
    return { command: String(args.command ?? "").trim() };
  }
  const out = {};
  for (const key of Object.keys(args).sort()) {
    const value = args[key];
    if (typeof value === "string" && value.length > 500) out[key] = value.slice(0, 500);
    else out[key] = value;
  }
  return out;
}

function compactArgs(args) {
  if (!args || typeof args !== "object") return args;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out[key] = truncateText(value, key === "content" ? 400 : 1000);
    else if (Array.isArray(value)) out[key] = value.slice(0, 20);
    else out[key] = value;
  }
  return out;
}

function toolTarget(name, args = {}, result) {
  return String(
    result?.activity?.target ??
      args.path ??
      args.directory ??
      args.command ??
      args.query ??
      args.task ??
      name ??
      "",
  );
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function truncateText(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... truncated ${text.length - max} characters`;
}

function indent(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
}

function trimMap(map, maxSize) {
  while (map.size > maxSize) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function simpleHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
