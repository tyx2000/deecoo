import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
import { countLineChanges, countOccurrences } from "./textDiff.js";

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
  const stats = countLineChanges(original, next);
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

  await writeFile(path, next, "utf8");
  updateReadCache(permissionState, rel, next);
  return {
    ok: true,
    path: rel,
    bytesWritten: Buffer.byteLength(next, "utf8"),
    activity: {
      kind: "edit",
      label: "Edited a file",
      target: rel,
      additions: stats.additions,
      deletions: stats.deletions,
    },
  };
}

export async function writeWorkspaceFile(workspace, getRealWorkspace, args, prompter, permissionState) {
  if (!args.path) return { ok: false, error: "path is required" };
  if (typeof args.content !== "string") return { ok: false, error: "content is required" };

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
  const stats = countLineChanges(original, args.content);
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

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, args.content, "utf8");
  updateReadCache(permissionState, rel, args.content);
  return {
    ok: true,
    path: rel,
    bytesWritten: Buffer.byteLength(args.content, "utf8"),
    activity: {
      kind: existed ? "write" : "create",
      label: existed ? "Wrote a file" : "Created a file",
      target: rel,
      additions: stats.additions,
      deletions: stats.deletions,
    },
  };
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
