import { createHash } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  assertExistingWorkspacePath,
  assertSafePath,
  assertWorkspaceWriteParent,
  DEFAULT_EXCLUDES,
  isPathNotFoundError,
  pathNotFoundResult,
  SENSITIVE_BASENAMES,
} from "./pathPolicy.js";
import { countLineChanges, countOccurrences, unifiedDiff } from "./textDiff.js";

export async function listFiles(workspace, getRealWorkspace, args) {
  const directory = args.directory ?? ".";
  const maxDepth = Math.min(Number(args.maxDepth ?? 2), 5);
  const root = assertSafePath(workspace, directory);
  const files = [];
  try {
    const info = await assertExistingWorkspacePath(workspace, getRealWorkspace, root);
    if (!info.isDirectory()) return { ok: false, error: "path is not a directory" };
    await walk(root, workspace, maxDepth, files);
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, root, directory, "directory");
    }
    throw error;
  }
  return {
    ok: true,
    files,
    activity: {
      kind: "list",
      label: "Listed files",
      target: relative(workspace, root) || ".",
      count: files.length,
    },
  };
}

async function walk(current, workspace, depth, files) {
  if (depth < 0) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (DEFAULT_EXCLUDES.has(entry.name) || SENSITIVE_BASENAMES.has(entry.name)) continue;
    const full = join(current, entry.name);
    const rel = relative(workspace, full);
    files.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) {
      await walk(full, workspace, depth - 1, files);
    }
  }
}

export async function readWorkspaceFile(workspace, getRealWorkspace, args, permissionState) {
  if (!args.path) return { ok: false, error: "path is required" };
  const path = assertSafePath(workspace, args.path);
  const maxBytes = Math.min(Number(args.maxBytes ?? 20000), 100000);
  const rel = relative(workspace, path);
  const cacheKey = `${rel}:${maxBytes}`;
  const cached = permissionState.readCache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      cached: true,
      activity: {
        ...cached.activity,
        label: "Read a file",
        detail: `${cached.activity.detail} cached`,
      },
    };
  }
  let info;
  try {
    info = await assertExistingWorkspacePath(workspace, getRealWorkspace, path);
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, args.path, "file");
    }
    throw error;
  }
  if (!info.isFile()) return { ok: false, error: "path is not a file" };
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, args.path, "file");
    }
    throw error;
  }
  const result = cachedReadResult(rel, content, maxBytes);
  permissionState.readCache.set(cacheKey, result);
  return result;
}

export async function editFile(workspace, getRealWorkspace, args, prompter, permissionState) {
  if (!args.path) return { ok: false, error: "path is required" };
  if (typeof args.search !== "string") return { ok: false, error: "search is required" };
  if (typeof args.replace !== "string") return { ok: false, error: "replace is required" };

  const path = assertSafePath(workspace, args.path);
  let original;
  try {
    const info = await assertExistingWorkspacePath(workspace, getRealWorkspace, path);
    if (!info.isFile()) return { ok: false, error: "path is not a file" };
    original = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, args.path, "file");
    }
    throw error;
  }
  const count = countOccurrences(original, args.search);
  if (count !== 1) {
    return { ok: false, error: `search must match exactly once; matched ${count} times` };
  }

  const next = original.replace(args.search, args.replace);
  const rel = relative(workspace, path);
  if (permissionState.mode === "read-only") {
    return { ok: false, error: "File edits are blocked by read-only permission mode." };
  }
  const allowed = await approveFileWrite({
    rel,
    action: "Apply edit",
    prompter,
    permissionState,
  });
  if (!allowed) return { ok: false, error: "User denied file edit." };

  const current = await readCurrentFileForWrite(workspace, getRealWorkspace, path, args.path);
  if (!current.ok) return current;
  const currentCount = countOccurrences(current.content, args.search);
  if (currentCount !== 1) {
    return {
      ok: false,
      error: `file changed before write; search must match exactly once, now matched ${currentCount} times`,
      code: "FILE_CHANGED_BEFORE_WRITE",
    };
  }
  const finalContent = current.content.replace(args.search, args.replace);
  const finalStats = countLineChanges(current.content, finalContent);

  await writeFile(path, finalContent, "utf8");
  updateReadCache(permissionState, rel, finalContent);
  return {
    ok: true,
    path: rel,
    bytesWritten: Buffer.byteLength(finalContent, "utf8"),
    activity: {
      kind: "edit",
      label: "Edited a file",
      target: rel,
      additions: finalStats.additions,
      deletions: finalStats.deletions,
    },
  };
}

export async function proposePatch(workspace, getRealWorkspace, args) {
  if (!args.path) return { ok: false, error: "path is required" };
  const hasContent = typeof args.content === "string";
  const hasReplacement = typeof args.search === "string" || typeof args.replace === "string";
  if (hasContent && hasReplacement) return { ok: false, error: "content is mutually exclusive with search/replace" };
  if (!hasContent && (typeof args.search !== "string" || typeof args.replace !== "string")) {
    return { ok: false, error: "provide either content or search and replace" };
  }

  const path = assertSafePath(workspace, args.path);
  let original;
  try {
    const info = await assertExistingWorkspacePath(workspace, getRealWorkspace, path);
    if (!info.isFile()) return { ok: false, error: "path is not a file" };
    original = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, args.path, "file");
    }
    throw error;
  }

  let next;
  if (hasContent) {
    next = args.content;
  } else {
    const count = countOccurrences(original, args.search);
    if (count !== 1) {
      return { ok: false, error: `search must match exactly once; matched ${count} times` };
    }
    next = original.replace(args.search, args.replace);
  }

  const rel = relative(workspace, path);
  const stats = countLineChanges(original, next);
  return {
    ok: true,
    path: rel,
    patch: unifiedDiff(original, next, rel),
    additions: stats.additions,
    deletions: stats.deletions,
    applied: false,
    activity: {
      kind: "patch",
      label: "Proposed a patch",
      target: rel,
      additions: stats.additions,
      deletions: stats.deletions,
      detail: "not applied",
    },
  };
}

export async function proposeStructuredPatchSet(workspace, getRealWorkspace, args) {
  const planned = await planPatchSet(workspace, getRealWorkspace, args);
  if (!planned.ok) return planned;

  const totals = patchSetTotals(planned.plans);
  return {
    ok: true,
    filesChanged: planned.plans.length,
    hunksApplied: planned.plans.reduce((total, plan) => total + (plan.hunks?.length ?? 0), 0),
    paths: planned.plans.map((plan) => plan.rel),
    files: planned.plans.map(patchSetPlanPreview),
    additions: totals.additions,
    deletions: totals.deletions,
    applied: false,
    activity: {
      kind: "patch",
      label: "Proposed a structured patch set",
      target: `${planned.plans.length} files`,
      additions: totals.additions,
      deletions: totals.deletions,
      detail: "not applied",
    },
  };
}

export async function applyStructuredPatch(workspace, getRealWorkspace, args, prompter, permissionState) {
  if (!args.path) return { ok: false, error: "path is required" };
  if (!Array.isArray(args.hunks) || args.hunks.length === 0) return { ok: false, error: "hunks must be a non-empty array" };

  const path = assertSafePath(workspace, args.path);
  let original;
  try {
    const info = await assertExistingWorkspacePath(workspace, getRealWorkspace, path);
    if (!info.isFile()) return { ok: false, error: "path is not a file" };
    original = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, args.path, "file");
    }
    throw error;
  }

  const planned = planStructuredPatch(original, args.hunks);
  if (!planned.ok) return planned;

  const rel = relative(workspace, path);
  if (permissionState.mode === "read-only") {
    return { ok: false, error: "File edits are blocked by read-only permission mode." };
  }
  const allowed = await approveFileWrite({
    rel,
    action: "Apply structured patch",
    prompter,
    permissionState,
  });
  if (!allowed) return { ok: false, error: "User denied file patch." };

  const current = await readCurrentFileForWrite(workspace, getRealWorkspace, path, args.path);
  if (!current.ok) return current;
  const finalPlan = planStructuredPatch(current.content, args.hunks);
  if (!finalPlan.ok) {
    return {
      ...finalPlan,
      error: `file changed before write; ${finalPlan.error}`,
      code: finalPlan.code ?? "FILE_CHANGED_BEFORE_WRITE",
    };
  }
  const finalStats = countLineChanges(current.content, finalPlan.content);

  await writeFile(path, finalPlan.content, "utf8");
  updateReadCache(permissionState, rel, finalPlan.content);
  return {
    ok: true,
    path: rel,
    hunksApplied: finalPlan.hunks.length,
    bytesWritten: Buffer.byteLength(finalPlan.content, "utf8"),
    additions: finalStats.additions,
    deletions: finalStats.deletions,
    activity: {
      kind: "patch",
      label: "Applied a structured patch",
      target: rel,
      additions: finalStats.additions,
      deletions: finalStats.deletions,
    },
  };
}

export async function applyStructuredPatchSet(workspace, getRealWorkspace, args, prompter, permissionState) {
  const planned = await planPatchSet(workspace, getRealWorkspace, args);
  if (!planned.ok) return planned;
  const { plans } = planned;

  if (permissionState.mode === "read-only") {
    return { ok: false, error: "File edits are blocked by read-only permission mode." };
  }
  const allowed = await approveFileWrite({
    rel: `${plans.length} files`,
    action: "Apply structured patch set",
    prompter,
    permissionState,
  });
  if (!allowed) return { ok: false, error: "User denied file patch set." };

  const fresh = await planPatchSet(workspace, getRealWorkspace, args);
  if (!fresh.ok) {
    return {
      ...fresh,
      error: `patch set changed before write; ${fresh.error}`,
      code: fresh.code ?? "PATCH_SET_CHANGED_BEFORE_WRITE",
    };
  }
  const freshPlans = fresh.plans;
  const written = [];
  for (const plan of freshPlans) {
    try {
      await applyPatchSetPlan(plan);
      written.push(plan);
      updateCacheForPatchSetPlan(permissionState, plan);
    } catch (error) {
      return await rollbackPatchSetWrites({ written, permissionState, cause: error });
    }
  }
  const totals = patchSetTotals(freshPlans);

  return {
    ok: true,
    filesChanged: freshPlans.length,
    hunksApplied: freshPlans.reduce((total, plan) => total + (plan.hunks?.length ?? 0), 0),
    paths: freshPlans.map((plan) => plan.rel),
    additions: totals.additions,
    deletions: totals.deletions,
    activity: {
      kind: "patch",
      label: "Applied a structured patch set",
      target: `${plans.length} files`,
      additions: totals.additions,
      deletions: totals.deletions,
    },
  };
}

async function planPatchSet(workspace, getRealWorkspace, args) {
  if (!Array.isArray(args.files) || args.files.length === 0) return { ok: false, error: "files must be a non-empty array" };
  const seen = new Set();
  const plans = [];

  for (const [index, file] of args.files.entries()) {
    const plan = await planPatchSetFile({ workspace, getRealWorkspace, file, index, seen });
    if (!plan.ok) return plan;
    plans.push(plan);
  }

  return { ok: true, plans };
}

function patchSetPlanPreview(plan) {
  if (plan.action === "update") {
    return {
      action: "update",
      path: plan.rel,
      patch: unifiedDiff(plan.original, plan.content, plan.rel),
      additions: plan.additions,
      deletions: plan.deletions,
    };
  }
  if (plan.action === "create") {
    return {
      action: "create",
      path: plan.rel,
      patch: unifiedDiff("", plan.content, plan.rel),
      additions: plan.additions,
      deletions: plan.deletions,
    };
  }
  return {
    action: "move",
    path: plan.rel,
    from: plan.fromRel,
    patch: [`rename from ${plan.fromRel}`, `rename to ${plan.rel}`].join("\n"),
    additions: 0,
    deletions: 0,
  };
}

export async function applyJsonPatch(workspace, getRealWorkspace, args, prompter, permissionState) {
  if (!args.path) return { ok: false, error: "path is required" };
  if (!Array.isArray(args.operations) || args.operations.length === 0) {
    return { ok: false, error: "operations must be a non-empty array" };
  }

  const path = assertSafePath(workspace, args.path);
  let original;
  try {
    const info = await assertExistingWorkspacePath(workspace, getRealWorkspace, path);
    if (!info.isFile()) return { ok: false, error: "path is not a file" };
    original = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, args.path, "file");
    }
    throw error;
  }

  const planned = planJsonPatch(original, args.operations);
  if (!planned.ok) return planned;
  const rel = relative(workspace, path);
  if (permissionState.mode === "read-only") {
    return { ok: false, error: "File edits are blocked by read-only permission mode." };
  }
  const allowed = await approveFileWrite({
    rel,
    action: "Apply JSON patch",
    prompter,
    permissionState,
  });
  if (!allowed) return { ok: false, error: "User denied JSON patch." };

  const current = await readCurrentFileForWrite(workspace, getRealWorkspace, path, args.path);
  if (!current.ok) return current;
  const finalPlan = planJsonPatch(current.content, args.operations);
  if (!finalPlan.ok) {
    return {
      ...finalPlan,
      error: `file changed before write; ${finalPlan.error}`,
      code: finalPlan.code ?? "FILE_CHANGED_BEFORE_WRITE",
    };
  }
  const finalStats = countLineChanges(current.content, finalPlan.content);

  await writeFile(path, finalPlan.content, "utf8");
  updateReadCache(permissionState, rel, finalPlan.content);
  return {
    ok: true,
    path: rel,
    operationsApplied: args.operations.length,
    bytesWritten: Buffer.byteLength(finalPlan.content, "utf8"),
    additions: finalStats.additions,
    deletions: finalStats.deletions,
    activity: {
      kind: "patch",
      label: "Applied a JSON patch",
      target: rel,
      additions: finalStats.additions,
      deletions: finalStats.deletions,
    },
  };
}

async function readCurrentFileForWrite(workspace, getRealWorkspace, path, requestedPath) {
  try {
    const info = await assertExistingWorkspacePath(workspace, getRealWorkspace, path);
    if (!info.isFile()) return { ok: false, error: "path is not a file" };
    return { ok: true, content: await readFile(path, "utf8") };
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, requestedPath, "file");
    }
    throw error;
  }
}

async function rollbackPatchSetWrites({ written, permissionState, cause }) {
  const rollbackErrors = [];
  for (const plan of [...written].reverse()) {
    try {
      await rollbackPatchSetPlan(plan);
      restoreCacheForPatchSetPlan(permissionState, plan);
    } catch (error) {
      rollbackErrors.push(`${plan.rel}: ${error.message}`);
    }
  }
  const rolledBack = rollbackErrors.length === 0;
  return {
    ok: false,
    error: rolledBack
      ? `patch set write failed and ${written.length} written file(s) were rolled back: ${cause.message}`
      : `patch set write failed and rollback had errors: ${rollbackErrors.join("; ")}`,
    code: rolledBack ? "PATCH_SET_WRITE_FAILED" : "PATCH_SET_ROLLBACK_FAILED",
    rolledBack,
    filesRolledBack: rolledBack ? written.map((plan) => plan.rel) : [],
    rollbackErrors,
  };
}

async function planPatchSetFile({ workspace, getRealWorkspace, file, index, seen }) {
  const action = file?.action ?? "update";
  if (action === "update") return await planPatchSetUpdate({ workspace, getRealWorkspace, file, index, seen });
  if (action === "create") return await planPatchSetCreate({ workspace, getRealWorkspace, file, index, seen });
  if (action === "move") return await planPatchSetMove({ workspace, getRealWorkspace, file, index, seen });
  return { ok: false, error: `file ${index + 1} action must be update, create, or move` };
}

async function planPatchSetUpdate({ workspace, getRealWorkspace, file, index, seen }) {
  if (!file?.path) return { ok: false, error: `file ${index + 1} path is required` };
  if (!Array.isArray(file.hunks) || file.hunks.length === 0) {
    return { ok: false, error: `file ${index + 1} hunks must be a non-empty array` };
  }

  const path = assertSafePath(workspace, file.path);
  const rel = relative(workspace, path);
  if (seen.has(rel)) return { ok: false, error: `duplicate patch path: ${rel}` };
  seen.add(rel);

  let original;
  try {
    const info = await assertExistingWorkspacePath(workspace, getRealWorkspace, path);
    if (!info.isFile()) return { ok: false, error: `path is not a file: ${rel}` };
    original = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, file.path, "file");
    }
    throw error;
  }

  const planned = planStructuredPatch(original, file.hunks);
  if (!planned.ok) return { ...planned, error: `${rel}: ${planned.error}` };
  const stats = countLineChanges(original, planned.content);
  return {
    ok: true,
    action: "update",
    path,
    rel,
    original,
    content: planned.content,
    hunks: planned.hunks,
    additions: stats.additions,
    deletions: stats.deletions,
  };
}

async function planPatchSetCreate({ workspace, getRealWorkspace, file, index, seen }) {
  if (!file?.path) return { ok: false, error: `file ${index + 1} path is required` };
  if (typeof file.content !== "string") return { ok: false, error: `file ${index + 1} content is required for create` };
  const path = assertSafePath(workspace, file.path);
  const rel = relative(workspace, path);
  if (seen.has(rel)) return { ok: false, error: `duplicate patch path: ${rel}` };
  seen.add(rel);
  try {
    await lstat(path);
    return { ok: false, error: `create target already exists: ${rel}` };
  } catch (error) {
    if (!isPathNotFoundError(error)) throw error;
  }
  await assertWorkspaceWriteParent(workspace, getRealWorkspace, path);
  const stats = countLineChanges("", file.content);
  return {
    ok: true,
    action: "create",
    path,
    rel,
    content: file.content,
    hunks: [],
    additions: stats.additions,
    deletions: stats.deletions,
  };
}

async function planPatchSetMove({ workspace, getRealWorkspace, file, index, seen }) {
  if (!file?.from) return { ok: false, error: `file ${index + 1} from is required for move` };
  if (!file?.path) return { ok: false, error: `file ${index + 1} path is required` };
  const fromPath = assertSafePath(workspace, file.from);
  const path = assertSafePath(workspace, file.path);
  const fromRel = relative(workspace, fromPath);
  const rel = relative(workspace, path);
  if (seen.has(fromRel)) return { ok: false, error: `duplicate patch path: ${fromRel}` };
  if (seen.has(rel)) return { ok: false, error: `duplicate patch path: ${rel}` };
  seen.add(fromRel);
  seen.add(rel);
  let original;
  try {
    const info = await assertExistingWorkspacePath(workspace, getRealWorkspace, fromPath);
    if (!info.isFile()) return { ok: false, error: `move source is not a file: ${fromRel}` };
    original = await readFile(fromPath, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) return pathNotFoundResult(workspace, fromPath, file.from, "file");
    throw error;
  }
  try {
    await lstat(path);
    return { ok: false, error: `move target already exists: ${rel}` };
  } catch (error) {
    if (!isPathNotFoundError(error)) throw error;
  }
  await assertWorkspaceWriteParent(workspace, getRealWorkspace, path);
  return {
    ok: true,
    action: "move",
    path,
    rel,
    fromPath,
    fromRel,
    original,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

async function applyPatchSetPlan(plan) {
  if (plan.action === "update") {
    await assertPatchSetUpdateStillCurrent(plan);
    await writeFile(plan.path, plan.content, "utf8");
  } else if (plan.action === "create") {
    await mkdir(dirname(plan.path), { recursive: true });
    await writeFile(plan.path, plan.content, { encoding: "utf8", flag: "wx" });
  } else if (plan.action === "move") {
    await assertPatchSetMoveStillCurrent(plan);
    await mkdir(dirname(plan.path), { recursive: true });
    await link(plan.fromPath, plan.path);
    try {
      await unlink(plan.fromPath);
    } catch (error) {
      await unlink(plan.path).catch(() => {});
      throw error;
    }
  }
}

async function assertPatchSetUpdateStillCurrent(plan) {
  const current = await readFile(plan.path, "utf8");
  if (current !== plan.original) {
    const error = new Error(`file changed before patch set write: ${plan.rel}`);
    error.code = "PATCH_SET_CHANGED_BEFORE_WRITE";
    throw error;
  }
}

async function assertPatchSetMoveStillCurrent(plan) {
  const current = await readFile(plan.fromPath, "utf8");
  if (current !== plan.original) {
    const error = new Error(`move source changed before patch set write: ${plan.fromRel}`);
    error.code = "PATCH_SET_CHANGED_BEFORE_WRITE";
    throw error;
  }
}

async function rollbackPatchSetPlan(plan) {
  if (plan.action === "update") {
    await writeFile(plan.path, plan.original, "utf8");
  } else if (plan.action === "create") {
    await unlink(plan.path);
  } else if (plan.action === "move") {
    await rename(plan.path, plan.fromPath);
  }
}

function patchSetTotals(plans) {
  return plans.reduce(
    (total, plan) => ({
      additions: total.additions + (plan.additions ?? 0),
      deletions: total.deletions + (plan.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
}

function updateCacheForPatchSetPlan(permissionState, plan) {
  if (plan.action === "update" || plan.action === "create") {
    updateReadCache(permissionState, plan.rel, plan.content);
  } else if (plan.action === "move") {
    deleteReadCache(permissionState, plan.fromRel);
    updateReadCache(permissionState, plan.rel, plan.original);
  }
}

function restoreCacheForPatchSetPlan(permissionState, plan) {
  if (plan.action === "update") {
    updateReadCache(permissionState, plan.rel, plan.original);
  } else if (plan.action === "create") {
    deleteReadCache(permissionState, plan.rel);
  } else if (plan.action === "move") {
    deleteReadCache(permissionState, plan.rel);
    updateReadCache(permissionState, plan.fromRel, plan.original);
  }
}

export async function writeWorkspaceFile(workspace, getRealWorkspace, args, prompter, permissionState) {
  if (!args.path) return { ok: false, error: "path is required" };
  if (typeof args.content !== "string") return { ok: false, error: "content is required" };
  if (args.expectedContent !== undefined && typeof args.expectedContent !== "string") {
    return { ok: false, error: "expectedContent must be a string when provided" };
  }
  if (args.expectedSha256 !== undefined && typeof args.expectedSha256 !== "string") {
    return { ok: false, error: "expectedSha256 must be a string when provided" };
  }

  const path = assertSafePath(workspace, args.path);
  let original = "";
  let existed = true;
  try {
    const info = await assertExistingWorkspacePath(workspace, getRealWorkspace, path);
    if (!info.isFile()) return { ok: false, error: "path is not a file" };
    original = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      existed = false;
      await assertWorkspaceWriteParent(workspace, getRealWorkspace, path);
    } else {
      throw error;
    }
  }

  const rel = relative(workspace, path);
  const guard = validateWriteExpectations({ rel, existed, original, expectedContent: args.expectedContent, expectedSha256: args.expectedSha256 });
  if (!guard.ok) return guard;

  if (permissionState.mode === "read-only") {
    return { ok: false, error: "File writes are blocked by read-only permission mode." };
  }
  const allowed = await approveFileWrite({
    rel,
    action: existed ? "Overwrite" : "Create",
    prompter,
    permissionState,
  });
  if (!allowed) return { ok: false, error: "User denied file write." };

  let finalOriginal = original;
  if (existed) {
    const current = await readCurrentFileForWrite(workspace, getRealWorkspace, path, args.path);
    if (!current.ok) return current;
    if (args.expectedContent === undefined && args.expectedSha256 === undefined && current.content !== original) {
      return {
        ok: false,
        error: `file changed before write: ${rel}`,
        code: "FILE_CHANGED_BEFORE_WRITE",
      };
    }
    const finalGuard = validateWriteExpectations({ rel, existed, original: current.content, expectedContent: args.expectedContent, expectedSha256: args.expectedSha256 });
    if (!finalGuard.ok) return finalGuard;
    finalOriginal = current.content;
  }
  const finalStats = countLineChanges(finalOriginal, args.content);

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, args.content, { encoding: "utf8", flag: existed ? "w" : "wx" });
  } catch (error) {
    if (!existed && error?.code === "EEXIST") {
      return {
        ok: false,
        error: `file appeared before create could complete: ${rel}`,
        code: "WRITE_CREATE_RACE",
      };
    }
    throw error;
  }
  updateReadCache(permissionState, rel, args.content);
  return {
    ok: true,
    path: rel,
    bytesWritten: Buffer.byteLength(args.content, "utf8"),
    activity: {
      kind: existed ? "write" : "create",
      label: existed ? "Wrote a file" : "Created a file",
      target: rel,
      additions: finalStats.additions,
      deletions: finalStats.deletions,
    },
  };
}

function validateWriteExpectations({ rel, existed, original, expectedContent, expectedSha256 }) {
  if (expectedContent === undefined && expectedSha256 === undefined) return { ok: true };
  if (!existed) {
    return {
      ok: false,
      error: `write expectations were provided but file does not exist: ${rel}`,
      code: "WRITE_EXPECTATION_MISMATCH",
    };
  }
  if (expectedContent !== undefined && original !== expectedContent) {
    return {
      ok: false,
      error: `expectedContent did not match current file: ${rel}`,
      code: "WRITE_EXPECTATION_MISMATCH",
    };
  }
  if (expectedSha256 !== undefined) {
    const actual = sha256Hex(original);
    if (actual !== expectedSha256) {
      return {
        ok: false,
        error: `expectedSha256 did not match current file: ${rel}`,
        code: "WRITE_EXPECTATION_MISMATCH",
        actualSha256: actual,
      };
    }
  }
  return { ok: true };
}

function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function planStructuredPatch(original, hunks) {
  const parsed = parseTextLines(original);
  const normalized = [];
  for (const [index, hunk] of hunks.entries()) {
    const oldStart = Number(hunk?.oldStart);
    const oldLines = hunk?.oldLines;
    const newLines = hunk?.newLines;
    if (!Number.isInteger(oldStart) || oldStart < 1) {
      return { ok: false, error: `hunk ${index + 1} oldStart must be a positive integer` };
    }
    if (!Array.isArray(oldLines) || !Array.isArray(newLines)) {
      return { ok: false, error: `hunk ${index + 1} oldLines and newLines must be arrays` };
    }
    if (![...oldLines, ...newLines].every((line) => typeof line === "string" && !line.includes("\n") && !line.includes("\r"))) {
      return { ok: false, error: `hunk ${index + 1} lines must be strings without line endings` };
    }
    normalized.push({ oldStart, oldLines, newLines, index });
  }

  normalized.sort((a, b) => a.oldStart - b.oldStart || a.index - b.index);
  let previousEnd = 0;
  for (const hunk of normalized) {
    const oldIndex = hunk.oldStart - 1;
    const maxStart = hunk.oldLines.length ? parsed.lines.length - hunk.oldLines.length : parsed.lines.length;
    if (oldIndex < 0 || oldIndex > maxStart) {
      return { ok: false, error: `hunk ${hunk.index + 1} starts outside the file` };
    }
    if (oldIndex < previousEnd) {
      return { ok: false, error: `hunk ${hunk.index + 1} overlaps a previous hunk` };
    }
    const actual = parsed.lines.slice(oldIndex, oldIndex + hunk.oldLines.length);
    if (!sameLines(actual, hunk.oldLines)) {
      return {
        ok: false,
        error: `hunk ${hunk.index + 1} context mismatch at line ${hunk.oldStart}`,
        code: "PATCH_CONTEXT_MISMATCH",
      };
    }
    previousEnd = oldIndex + Math.max(hunk.oldLines.length, 1);
  }

  const next = [...parsed.lines];
  let offset = 0;
  for (const hunk of normalized) {
    const oldIndex = hunk.oldStart - 1 + offset;
    next.splice(oldIndex, hunk.oldLines.length, ...hunk.newLines);
    offset += hunk.newLines.length - hunk.oldLines.length;
  }
  return {
    ok: true,
    content: serializeTextLines(next, parsed),
    hunks: normalized,
  };
}

function planJsonPatch(original, operations) {
  let value;
  try {
    value = JSON.parse(original);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}` };
  }

  for (const [index, operation] of operations.entries()) {
    const op = operation?.op;
    const pointer = operation?.pointer;
    if (!["set", "delete", "append"].includes(op)) {
      return { ok: false, error: `operation ${index + 1} op must be set, delete, or append` };
    }
    if (typeof pointer !== "string" || !pointer.startsWith("/")) {
      return { ok: false, error: `operation ${index + 1} pointer must be a JSON Pointer` };
    }
    const result = applyJsonOperation(value, operation);
    if (!result.ok) return { ...result, error: `operation ${index + 1}: ${result.error}` };
  }

  return {
    ok: true,
    content: JSON.stringify(value, null, 2) + "\n",
  };
}

function applyJsonOperation(root, operation) {
  const segments = parseJsonPointer(operation.pointer);
  const target = resolveJsonParent(root, segments);
  if (!target.ok) return target;
  const { parent, key } = target;
  if (operation.op === "set") {
    if (Array.isArray(parent)) {
      const index = arrayIndex(parent, key, { allowAppend: true });
      if (index === undefined) return { ok: false, error: `invalid array index ${key}` };
      if (index > parent.length) return { ok: false, error: `array index is beyond append position: ${key}` };
      if (index === parent.length) parent.push(operation.value);
      else parent[index] = operation.value;
    } else {
      parent[key] = operation.value;
    }
    return { ok: true };
  }
  if (operation.op === "delete") {
    if (Array.isArray(parent)) {
      const index = arrayIndex(parent, key);
      if (index === undefined || index >= parent.length) return { ok: false, error: `array index does not exist: ${key}` };
      parent.splice(index, 1);
    } else {
      if (!Object.prototype.hasOwnProperty.call(parent, key)) return { ok: false, error: `property does not exist: ${key}` };
      delete parent[key];
    }
    return { ok: true };
  }
  if (operation.op === "append") {
    const array = getJsonValue(root, segments);
    if (!Array.isArray(array)) return { ok: false, error: "append target must be an array" };
    array.push(operation.value);
    return { ok: true };
  }
  return { ok: false, error: "unsupported operation" };
}

function parseJsonPointer(pointer) {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function resolveJsonParent(root, segments) {
  if (!segments.length) return { ok: false, error: "root pointer cannot be used as an operation target" };
  const parentSegments = segments.slice(0, -1);
  const key = segments.at(-1);
  const parent = getJsonValue(root, parentSegments);
  if (parent === undefined || parent === null || typeof parent !== "object") {
    return { ok: false, error: "parent path does not exist or is not an object/array" };
  }
  return { ok: true, parent, key };
}

function getJsonValue(root, segments) {
  let current = root;
  for (const segment of segments) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = arrayIndex(current, segment);
      if (index === undefined || index >= current.length) return undefined;
      current = current[index];
    } else if (typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function arrayIndex(array, key, { allowAppend = false } = {}) {
  if (allowAppend && key === "-") return array.length;
  if (!/^(0|[1-9]\d*)$/.test(String(key))) return undefined;
  return Number(key);
}

function parseTextLines(text) {
  const value = String(text ?? "");
  if (value === "") return { lines: [], trailingNewline: false, lineEnding: "\n" };
  const lineEnding = value.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = value.endsWith("\n");
  const lines = value.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline, lineEnding };
}

function serializeTextLines(lines, parsed) {
  return lines.join(parsed.lineEnding) + (parsed.trailingNewline ? parsed.lineEnding : "");
}

function sameLines(left, right) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

async function approveFileWrite({ rel, action, prompter, permissionState }) {
  if (permissionState.mode === "read-only") return false;
  if (permissionState.mode === "workspace-write") return true;
  if (permissionState.mode === "ask-once" && permissionState.fileWriteApprovedForTask) return true;

  const question =
    permissionState.mode === "ask-once"
      ? `${action} ${rel}? This will allow further file edits for this task.`
      : `${action} ${rel}?`;
  const decision = await prompter(question, { kind: "file-write-approval" });
  if (decision === "always") {
    permissionState.mode = "workspace-write";
    permissionState.fileWriteApprovedForTask = true;
    return true;
  }
  const allowed = decision === true || decision === "approve";
  if (allowed && permissionState.mode === "ask-once") {
    permissionState.fileWriteApprovedForTask = true;
  }
  return allowed;
}

function updateReadCache(permissionState, rel, content) {
  const prefix = `${rel}:`;
  for (const [key] of permissionState.readCache) {
    if (!key.startsWith(prefix)) continue;
    const maxBytes = Number(key.slice(prefix.length));
    permissionState.readCache.set(key, cachedReadResult(rel, content, maxBytes));
  }
}

function deleteReadCache(permissionState, rel) {
  const prefix = `${rel}:`;
  for (const [key] of permissionState.readCache) {
    if (key.startsWith(prefix)) permissionState.readCache.delete(key);
  }
}

function cachedReadResult(rel, content, maxBytes) {
  return {
    ok: true,
    path: rel,
    truncated: Buffer.byteLength(content, "utf8") > maxBytes,
    content: content.slice(0, maxBytes),
    activity: {
      kind: "read",
      label: "Read a file",
      target: rel,
      detail: `${content.split(/\r?\n/).length} lines`,
    },
  };
}
