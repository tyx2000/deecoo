import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execReadOnlyGit } from "../permissions/gitPolicy.js";

// Sizes and modification times of the workspace's source files as one digest. It answers "did
// anything change?" for commands whose writes the harness cannot see (appending to a file).
// Generated output is not progress: a rerun build or test that only rewrites coverage, build
// output, or caches must still count as a repeat. In a Git work tree that means the files Git
// does not ignore; elsewhere, everything outside well-known tool and output directories. A
// workspace too large to scan cheaply yields undefined, which callers treat as "unknown", never
// as "unchanged".
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".deecoo"]);
const OUTPUT_DIRECTORIES = new Set(["coverage", ".nyc_output", "dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".cache", ".parcel-cache", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".venv", ".gradle"]);

export async function workspaceFingerprint(root, { maxEntries = 20_000 } = {}) {
  const files = await gitVisibleFiles(root) ?? await walkedFiles(root, maxEntries);
  if (!files || files.length > maxEntries) return undefined;
  const hash = createHash("sha256");
  for (const relative of files) {
    const info = await lstat(join(root, relative)).catch(() => undefined);
    hash.update(`${relative}\0${info?.size ?? -1}\0${info?.mtimeMs ?? -1}\n`);
  }
  return hash.digest("hex");
}

// Tracked files plus untracked files that .gitignore does not exclude. An empty listing (the
// workspace sits inside an ignored directory of an outer repository) falls back to the walk.
async function gitVisibleFiles(root) {
  try {
    const { stdout } = await execReadOnlyGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 32 * 1024 * 1024 });
    const files = [...new Set(stdout.split("\0").filter((path) => path && !path.split("/").some((part) => SKIPPED_DIRECTORIES.has(part))))].sort();
    return files.length ? files : undefined;
  } catch {
    return undefined;
  }
}

async function walkedFiles(root, maxEntries) {
  const files = [];
  const walk = async (directory, prefix) => {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); } catch { return true; }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const relative = prefix + child.name;
      if (child.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(child.name) || OUTPUT_DIRECTORIES.has(child.name)) continue;
        if (!(await walk(join(directory, child.name), relative + "/"))) return false;
        continue;
      }
      if (files.push(relative) > maxEntries) return false;
    }
    return true;
  };
  return (await walk(root, "")) ? files : undefined;
}
