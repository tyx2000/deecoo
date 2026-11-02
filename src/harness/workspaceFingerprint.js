import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export async function workspaceFingerprint(root, { maxEntries = 20_000, explicitPaths = [] } = {}) {
  const files = await gitVisibleFiles(root) ?? await walkedFiles(root, maxEntries);
  if (!files || files.length > maxEntries) return undefined;
  const targets = new Set(files);
  if (!(await addExplicitTargets(root, targets, explicitPaths, maxEntries))) return undefined;
  const hash = createHash("sha256");
  for (const relative of [...targets].sort()) {
    const info = await lstat(join(root, relative)).catch(() => undefined);
    hash.update(`${relative}\0${info?.size ?? -1}\0${info?.mtimeMs ?? -1}\n`);
  }
  return hash.digest("hex");
}

// Only the user's task selects extra progress targets; model commands cannot opt all build
// noise into progress. References are observations, never permission to read or write a path.
export function explicitProgressPaths(task) {
  const paths = [];
  const source = String(task ?? "");
  for (const match of source.matchAll(/["'`]([^"'`\n]+)["'`]|(?:^|[\s(（])@?([^\s"'`<>|,;!?，。；：！？)）]+)/g)) {
    const path = (match[1] ?? match[2]).replace(/[.:]+$/, "");
    if (/[\\/]|\.[A-Za-z0-9]{1,10}$/.test(path) && !path.includes("://")) paths.push(path);
  }
  return [...new Set(paths)].slice(0, 80);
}

function inside(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

async function addExplicitTargets(root, files, paths, maxEntries) {
  if (!paths.length) return true;
  const canonicalRoot = await realpath(root);
  const walk = async (path, rel) => {
    const info = await lstat(path).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (info?.isSymbolicLink()) return true;
    files.add(rel);
    if (files.size > maxEntries) return false;
    if (!info?.isDirectory()) return true;
    for (const child of await readdir(path)) {
      if (!SKIPPED_DIRECTORIES.has(child) && !(await walk(join(path, child), join(rel, child)))) return false;
    }
    return true;
  };
  for (const raw of paths) {
    const path = resolve(root, raw.replaceAll("\\", "/"));
    const rel = relative(root, path);
    if (!rel || !inside(root, path) || rel.split(sep).some((part) => SKIPPED_DIRECTORIES.has(part))) continue;
    // Missing future files are useful targets too. Check their nearest existing ancestor,
    // including symlink resolution, before touching metadata below it.
    let ancestor = dirname(path);
    let canonical;
    while (!canonical) {
      try { canonical = await realpath(ancestor); }
      catch (error) {
        if (error.code !== "ENOENT" || ancestor === dirname(ancestor)) return false;
        ancestor = dirname(ancestor);
      }
    }
    if (!inside(canonicalRoot, canonical)) continue;
    try { if (!(await walk(path, rel))) return false; }
    catch { return false; } // Unknown filesystem state must not be mistaken for no progress.
  }
  return true;
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
