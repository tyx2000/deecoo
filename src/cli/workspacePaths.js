import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const PATH_TRIGGER_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".deecoo",
]);
const MAX_PATH_TRIGGER_OPTIONS = 800;

export async function listWorkspacePathOptions(cwd) {
  const entries = [];
  await collectWorkspacePathOptions(resolve(cwd), resolve(cwd), entries, 4);
  return entries.slice(0, MAX_PATH_TRIGGER_OPTIONS).map((entry) => ({
    label: `${entry.path}${entry.directory ? "/" : ""}`,
    value: entry.path,
    directory: entry.directory,
    insertText: entry.directory ? `@${entry.path}/` : `@${entry.path} `,
    finalInsertText: `@${entry.path}${entry.directory ? "/" : ""} `,
  }));
}

export function filterWorkspacePathOptions(query, options) {
  const normalizedQuery = String(query ?? "").replace(/^\/+/, "");
  const slashIndex = normalizedQuery.lastIndexOf("/");
  const parent = slashIndex >= 0 ? normalizedQuery.slice(0, slashIndex + 1) : "";
  const leafQuery = slashIndex >= 0 ? normalizedQuery.slice(slashIndex + 1).toLowerCase() : normalizedQuery.toLowerCase();

  return options.filter((option) => {
    const label = String(option.label ?? "");
    if (!label.startsWith(parent)) return false;
    const rest = label.slice(parent.length).replace(/\/$/, "");
    if (!rest || rest.includes("/")) return false;
    return !leafQuery || rest.toLowerCase().includes(leafQuery);
  });
}

async function collectWorkspacePathOptions(root, current, entries, depth) {
  if (depth < 0 || entries.length >= MAX_PATH_TRIGGER_OPTIONS) return;
  let dirents;
  try {
    dirents = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of dirents) {
    if (entries.length >= MAX_PATH_TRIGGER_OPTIONS) return;
    if (PATH_TRIGGER_EXCLUDES.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    const rel = relativePath(root, fullPath);
    entries.push({ path: rel, directory: entry.isDirectory() });
    if (entry.isDirectory()) {
      await collectWorkspacePathOptions(root, fullPath, entries, depth - 1);
    }
  }
}

function relativePath(root, path) {
  return path.slice(root.length + 1).replaceAll("\\", "/");
}
