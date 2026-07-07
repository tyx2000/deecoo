import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isScorActive } from "../skills/scor.js";

const execFileAsync = promisify(execFile);
const MAX_SCOPE_FILES = 80;

export async function buildReviewScopeMessages({ cwd, task, activeSkills, requestType }) {
  if (!isScorActive(activeSkills) || requestType !== "review") return [];
  const scope = await resolveReviewScope({ cwd, task });
  return [
    {
      role: "system",
      content: reviewScopeContext(scope),
    },
  ];
}

export async function resolveReviewScope({ cwd, task }) {
  const explicitFiles = extractExplicitFiles(task);
  if (explicitFiles.length) {
    return {
      mode: "explicit",
      files: explicitFiles.slice(0, MAX_SCOPE_FILES),
      truncated: explicitFiles.length > MAX_SCOPE_FILES,
      source: "user prompt",
    };
  }

  const changedFiles = await gitChangedFiles(cwd);
  if (changedFiles.length) {
    return {
      mode: "working-tree",
      files: changedFiles.slice(0, MAX_SCOPE_FILES),
      truncated: changedFiles.length > MAX_SCOPE_FILES,
      source: "git status and diff",
    };
  }

  return {
    mode: "project",
    files: [],
    truncated: false,
    source: "no explicit files or changed git files found",
  };
}

function reviewScopeContext(scope) {
  const lines = [
    "S-COR deterministic review scope:",
    "Mode: " + scope.mode,
    "Source: " + scope.source,
  ];
  if (scope.files.length) {
    lines.push("Files:");
    lines.push(...scope.files.map((file) => "- " + file));
    if (scope.truncated) lines.push("- ... additional files omitted from scope context");
  } else {
    lines.push("Files: none resolved; inspect the project or git history before concluding.");
  }
  lines.push("Review-only runtime policy is active: do not edit files during S-COR.");
  return lines.join("\n");
}

function extractExplicitFiles(task) {
  const matches = [...String(task ?? "").matchAll(/(?:^|\s)@([A-Za-z0-9_./-]+\.[A-Za-z0-9_./-]+)/g)];
  return [...new Set(matches.map((match) => match[1]).filter(Boolean))];
}

async function gitChangedFiles(cwd) {
  const [diffFiles, statusFiles] = await Promise.all([gitDiffNames(cwd), gitStatusNames(cwd)]);
  return [...new Set([...diffFiles, ...statusFiles])].sort();
}

async function gitDiffNames(cwd) {
  const result = await safeGit(cwd, ["diff", "--name-only", "HEAD"]);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function gitStatusNames(cwd) {
  const result = await safeGit(cwd, ["status", "--short"]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .map((line) => line.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

async function safeGit(cwd, args) {
  try {
    return await execFileAsync("git", args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 });
  } catch {
    return { stdout: "" };
  }
}
