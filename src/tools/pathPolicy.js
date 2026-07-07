import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

export const DEFAULT_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
]);

export const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_ed25519",
]);

export function isPathNotFoundError(error) {
  return error?.code === "ENOENT";
}

export function pathNotFoundResult(workspace, fullPath, requestedPath, kind) {
  const rel = relative(workspace, fullPath) || ".";
  return {
    ok: false,
    error: `${kind} not found: ${rel}`,
    code: "ENOENT",
    path: rel,
    requestedPath,
    recoverable: true,
    suggestion:
      "This path may be a wrong guess. Use list_files on a known parent directory or search_text from the workspace root to locate the correct path, then retry.",
  };
}

export function assertSafePath(workspace, path) {
  const full = resolve(workspace, path);
  const rel = relative(workspace, full);
  if (rel.startsWith("..") || rel === ".." || rel.startsWith("/") || rel.includes("\0")) {
    throw new Error(`Access outside workspace is denied: ${path}`);
  }
  assertNotSensitive(full);
  return full;
}

export async function assertExistingWorkspacePath(workspace, getRealWorkspace, path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Access through symbolic links is denied: ${relative(workspace, path) || "."}`);
  }

  const realTarget = await realpath(path);
  assertInsideWorkspace(await getRealWorkspace(), realTarget);
  assertNotSensitive(realTarget);
  return info;
}

export async function assertWorkspaceWriteParent(workspace, getRealWorkspace, path) {
  let current = dirname(path);
  while (true) {
    assertSafePath(workspace, current);
    let info;
    try {
      info = await assertExistingWorkspacePath(workspace, getRealWorkspace, current);
    } catch (error) {
      if (!isPathNotFoundError(error)) throw error;
      const next = dirname(current);
      if (next === current) throw error;
      current = next;
      continue;
    }

    if (!info.isDirectory()) {
      throw new Error(`Write parent is not a directory: ${relative(workspace, current) || "."}`);
    }
    return;
  }
}

export function assertInsideWorkspace(realWorkspace, realTarget) {
  const rel = relative(realWorkspace, realTarget);
  if (rel.startsWith("..") || rel === ".." || rel.startsWith("/") || rel.includes("\0")) {
    throw new Error(`Access outside workspace is denied: ${realTarget}`);
  }
}

export function assertNotSensitive(path) {
  const name = basename(path);
  if (SENSITIVE_BASENAMES.has(name) || path.includes("/.git/") || path.includes("/node_modules/")) {
    throw new Error(`Access to sensitive or excluded path is denied: ${name}`);
  }
}
