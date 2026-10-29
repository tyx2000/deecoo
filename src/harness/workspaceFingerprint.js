import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

// Sizes and modification times of the workspace's files as one digest. It answers "did anything
// change?" for commands whose writes the harness cannot see (appending to a file, writing build
// output). Version-control, dependency, and Deecoo's own project directories are skipped; a
// workspace too large to scan cheaply yields undefined, which callers treat as "unknown", never as
// "unchanged".
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".deecoo"]);

export async function workspaceFingerprint(root, { maxEntries = 20_000 } = {}) {
  const hash = createHash("sha256");
  let entries = 0;
  const walk = async (directory, prefix) => {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); } catch { return true; }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (++entries > maxEntries) return false;
      const relative = prefix + child.name;
      if (child.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(child.name)) continue;
        hash.update(relative + "/\n");
        if (!(await walk(join(directory, child.name), relative + "/"))) return false;
        continue;
      }
      const info = await lstat(join(directory, child.name)).catch(() => undefined);
      hash.update(`${relative}\0${info?.size ?? -1}\0${info?.mtimeMs ?? -1}\n`);
    }
    return true;
  };
  return (await walk(root, "")) ? hash.digest("hex") : undefined;
}
