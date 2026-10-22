import { basename, join, relative } from "node:path";
import { dataContextMessage } from "../harness/contentTrust.js";
import { createContextFileAccess } from "./fileAccess.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);
const MAX_FILES = 400;
const MAX_DEPTH = 4;

export async function buildProjectIndex(cwd) {
  const access = await createContextFileAccess(cwd);
  const files = [];
  await walk(cwd, cwd, MAX_DEPTH, files, access);
  files.sort();
  const packageInfo = await readPackageInfo(access);
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

export async function buildProjectIndexMessages(cwd, { index } = {}) {
  const current = index ?? await buildProjectIndex(cwd);
  return [
    dataContextMessage({ source: "project-index", scope: "project", kind: "project-index", reference: cwd, content: projectIndexContext(current) }),
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

async function walk(root, current, depth, files, access) {
  if (depth < 0 || files.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await access.readDirectory(relative(root, current) || ".");
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(current, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      await walk(root, full, depth - 1, files, access);
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
}

async function readPackageInfo(access) {
  try {
    return JSON.parse(await access.readText("package.json"));
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
