import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);
const MAX_FILES = 400;
const MAX_DEPTH = 4;

export async function buildProjectIndex(cwd) {
  const files = [];
  await walk(cwd, cwd, MAX_DEPTH, files);
  files.sort();
  const packageInfo = await readPackageInfo(cwd);
  return {
    root: cwd,
    projectName: packageInfo?.name ?? basename(cwd),
    packageManager: packageManager(files),
    scripts: packageInfo?.scripts ?? {},
    manifests: files.filter(isManifest).slice(0, 30),
    sourceFiles: files.filter((file) => /^src\//.test(file)).slice(0, 80),
    testFiles: files.filter(isTestFile).slice(0, 80),
    configFiles: files.filter(isConfigFile).slice(0, 60),
    fileCount: files.length,
    truncated: files.length >= MAX_FILES,
  };
}

export async function buildProjectIndexMessages(cwd) {
  const index = await buildProjectIndex(cwd);
  return [
    {
      role: "system",
      content: projectIndexContext(index),
    },
  ];
}

function projectIndexContext(index) {
  return [
    "Project index snapshot:",
    "Name: " + index.projectName,
    "Package manager: " + (index.packageManager || "unknown"),
    "Scripts: " + Object.keys(index.scripts).slice(0, 20).join(", "),
    "Manifests: " + index.manifests.join(", "),
    "Config files: " + index.configFiles.slice(0, 30).join(", "),
    "Source files: " + index.sourceFiles.slice(0, 40).join(", "),
    "Test files: " + index.testFiles.slice(0, 40).join(", "),
    "Indexed files: " + index.fileCount + (index.truncated ? " (truncated)" : ""),
  ].join("\n");
}

async function walk(root, current, depth, files) {
  if (depth < 0 || files.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(current, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      await walk(root, full, depth - 1, files);
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
}

async function readPackageInfo(cwd) {
  try {
    return JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function packageManager(files) {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("package-lock.json")) return "npm";
  if (files.includes("bun.lockb")) return "bun";
  return files.includes("package.json") ? "npm" : "";
}

function isManifest(file) {
  return /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|requirements\.txt)$/.test(file);
}

function isTestFile(file) {
  return /(^test\/|\/test\/|\.test\.|\.spec\.)/.test(file);
}

function isConfigFile(file) {
  return /(^|\/)(tsconfig|vite\.config|webpack\.config|eslint|prettier|jest|vitest|settings|\.github\/workflows)/.test(file);
}
