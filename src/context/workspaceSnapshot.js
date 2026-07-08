import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SNAPSHOT_README_CHARS = 6000;
const SNAPSHOT_DOC_CHARS = 5000;
const PROJECT_DESCRIPTION_READ_CHARS = 5000;
const TREE_DEPTH = 3;
const TREE_MAX_ENTRIES = 180;
const GIT_MAX_CHARS = 12000;
const DESCRIPTION_START = "<!-- deecoo:generated:start -->";
const DESCRIPTION_END = "<!-- deecoo:generated:end -->";
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".deecoo"]);
const INSTRUCTION_FILES = [".deecoo.md", "AGENTS.md", "CLAUDE.md"];

export async function buildWorkspaceSnapshot(cwd) {
  const [git, packageInfo, readme, projectInstructions, tree, projectDescription] = await Promise.all([
    readGitSnapshot(cwd),
    readPackageSummary(cwd),
    readReadmeSummary(cwd),
    readProjectInstructions(cwd),
    buildDirectoryTree(cwd),
    readProjectDescription(cwd),
  ]);

  return {
    schemaVersion: 1,
    cwd,
    git,
    package: packageInfo,
    readme,
    projectInstructions,
    tree,
    projectDescription,
  };
}

export async function buildWorkspaceSnapshotMessages(cwd) {
  const snapshot = await buildWorkspaceSnapshot(cwd);
  return [
    {
      role: "system",
      content: workspaceSnapshotContext(snapshot),
    },
  ];
}

export async function ensureProjectDescription(cwd) {
  const snapshot = await buildWorkspaceSnapshotWithoutProjectDescription(cwd);
  const generated = renderGeneratedProjectDescription(snapshot);
  const path = projectDescriptionPath(cwd);
  const next = await mergeGeneratedProjectDescription(path, generated);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return { path, content: next };
}

function workspaceSnapshotContext(snapshot) {
  const lines = [
    "Workspace snapshot:",
    "cwd: " + snapshot.cwd,
    "project instruction priority: .deecoo.md > AGENTS.md > CLAUDE.md > README.md",
    "git:",
    indent(formatGit(snapshot.git)),
    "package:",
    indent(formatPackage(snapshot.package)),
  ];

  if (snapshot.projectInstructions?.primary) {
    lines.push(
      "primary project instructions (" + snapshot.projectInstructions.primary.path + "):",
      indent(snapshot.projectInstructions.primary.content),
    );
  }
  if (snapshot.projectInstructions?.additional?.length) {
    lines.push("additional project instruction files:");
    for (const file of snapshot.projectInstructions.additional) {
      lines.push(indent(`${file.path}${file.truncated ? " (truncated)" : ""}:\n${file.content}`));
    }
  }
  if (snapshot.projectDescription?.content) {
    lines.push("project description file (.deecoo/PROJECT.md):", indent(snapshot.projectDescription.content));
  }
  if (snapshot.readme?.content) {
    lines.push("README excerpt:", indent(snapshot.readme.content));
  }
  lines.push("directory tree:", indent(snapshot.tree.lines.join("\n") || "(empty)"));
  if (snapshot.tree.truncated) lines.push("directory tree truncated: true");

  return lines.join("\n");
}

async function buildWorkspaceSnapshotWithoutProjectDescription(cwd) {
  const [git, packageInfo, readme, projectInstructions, tree] = await Promise.all([
    readGitSnapshot(cwd),
    readPackageSummary(cwd),
    readReadmeSummary(cwd),
    readProjectInstructions(cwd),
    buildDirectoryTree(cwd),
  ]);
  return {
    schemaVersion: 1,
    cwd,
    git,
    package: packageInfo,
    readme,
    projectInstructions,
    tree,
  };
}

async function readGitSnapshot(cwd) {
  const [status, stat] = await Promise.all([
    safeGit(cwd, ["status", "--short", "--branch"]),
    safeGit(cwd, ["diff", "--stat"]),
  ]);
  return {
    status: truncate(status.stdout.trim(), GIT_MAX_CHARS),
    diffStat: truncate(stat.stdout.trim(), GIT_MAX_CHARS),
    available: status.ok || stat.ok,
  };
}

async function safeGit(cwd, args) {
  try {
    const result = await execFileAsync("git", args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function readPackageSummary(cwd) {
  try {
    const content = await readFile(join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(content);
    return {
      path: "package.json",
      name: parsed.name ?? "",
      version: parsed.version ?? "",
      type: parsed.type ?? "",
      private: parsed.private === true,
      scripts: parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {},
      dependencies: objectKeys(parsed.dependencies),
      devDependencies: objectKeys(parsed.devDependencies),
    };
  } catch {
    return undefined;
  }
}

async function readReadmeSummary(cwd) {
  let entries = [];
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const readme = entries
    .filter((entry) => entry.isFile() && /^README(?:\.[A-Za-z0-9_-]+)?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))[0];
  if (!readme) return undefined;
  const content = await safeReadText(join(cwd, readme), SNAPSHOT_README_CHARS);
  if (!content) return undefined;
  return { path: readme, ...content };
}

async function readProjectInstructions(cwd) {
  const files = [];
  for (const name of INSTRUCTION_FILES) {
    const content = await safeReadText(join(cwd, name), SNAPSHOT_DOC_CHARS);
    if (content) files.push({ path: name, ...content });
  }
  if (!files.length) {
    const readme = await readReadmeSummary(cwd);
    if (readme) {
      return {
        primary: { ...readme, path: readme.path, fallback: true },
        additional: [],
      };
    }
  }
  return {
    primary: files[0],
    additional: files.slice(1),
  };
}

async function readProjectDescription(cwd) {
  const content = await safeReadText(projectDescriptionPath(cwd), PROJECT_DESCRIPTION_READ_CHARS);
  if (!content) return undefined;
  return { path: ".deecoo/PROJECT.md", ...content };
}

async function safeReadText(path, maxChars) {
  try {
    const content = await readFile(path, "utf8");
    return {
      content: truncate(content.trim(), maxChars),
      truncated: content.length > maxChars,
    };
  } catch {
    return undefined;
  }
}

async function buildDirectoryTree(cwd) {
  const lines = [];
  await walkTree(cwd, cwd, TREE_DEPTH, lines);
  return {
    lines: lines.slice(0, TREE_MAX_ENTRIES),
    truncated: lines.length > TREE_MAX_ENTRIES,
  };
}

async function walkTree(root, current, depth, lines) {
  if (depth < 0 || lines.length > TREE_MAX_ENTRIES) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (lines.length > TREE_MAX_ENTRIES) return;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(current, entry.name);
    const rel = relative(root, full).replaceAll("\\", "/");
    const level = rel.split("/").length - 1;
    lines.push(`${"  ".repeat(level)}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory()) {
      await walkTree(root, full, depth - 1, lines);
    }
  }
}

function renderGeneratedProjectDescription(snapshot) {
  const lines = [
    DESCRIPTION_START,
    "# Deecoo Project Context",
    "",
    "Generated by Deecoo. Manual notes can be kept outside the generated markers.",
    "",
    "## Project",
    "- Root: " + snapshot.cwd,
    "- Name: " + (snapshot.package?.name || basename(snapshot.cwd)),
    "- Package type: " + (snapshot.package?.type || "unknown"),
    "",
    "## Package Scripts",
    formatScripts(snapshot.package?.scripts),
    "",
    "## Dependencies",
    "- dependencies: " + listOrNone(snapshot.package?.dependencies),
    "- devDependencies: " + listOrNone(snapshot.package?.devDependencies),
    "",
    "## Git State",
    fenced(formatGit(snapshot.git)),
    "",
    "## Primary Project Instructions",
    formatPrimaryInstructions(snapshot.projectInstructions),
    "",
    "## Additional Project Instruction Files",
    formatAdditionalInstructions(snapshot.projectInstructions),
    "",
    "## README Excerpt",
    snapshot.readme?.content ? truncate(snapshot.readme.content, 3000) : "No README found.",
    "",
    "## Directory Snapshot",
    fenced(snapshot.tree.lines.join("\n") || "(empty)"),
    DESCRIPTION_END,
    "",
  ];
  return lines.join("\n");
}

async function mergeGeneratedProjectDescription(path, generated) {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    return generated;
  }

  const start = existing.indexOf(DESCRIPTION_START);
  const end = existing.indexOf(DESCRIPTION_END);
  if (start >= 0 && end > start) {
    const afterEnd = end + DESCRIPTION_END.length;
    return existing.slice(0, start) + generated.trimEnd() + existing.slice(afterEnd);
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + separator + generated;
}

function formatGit(git) {
  if (!git?.available) return "not a git repository or git unavailable";
  return [
    "status --short --branch:",
    git.status || "(clean)",
    "diff --stat:",
    git.diffStat || "(no unstaged diff)",
  ].join("\n");
}

function formatPackage(packageInfo) {
  if (!packageInfo) return "package.json not found";
  return [
    "name: " + (packageInfo.name || "(unnamed)"),
    "version: " + (packageInfo.version || "(none)"),
    "type: " + (packageInfo.type || "(unspecified)"),
    "private: " + String(packageInfo.private),
    "scripts: " + Object.keys(packageInfo.scripts).slice(0, 30).join(", "),
    "dependencies: " + listOrNone(packageInfo.dependencies),
    "devDependencies: " + listOrNone(packageInfo.devDependencies),
  ].join("\n");
}

function formatScripts(scripts = {}) {
  const entries = Object.entries(scripts);
  if (!entries.length) return "No scripts found.";
  return entries.map(([name, command]) => `- ${name}: \`${command}\``).join("\n");
}

function formatPrimaryInstructions(projectInstructions) {
  const primary = projectInstructions?.primary;
  if (!primary) return "No .deecoo.md, AGENTS.md, CLAUDE.md, or README.md found.";
  const label = primary.fallback ? `${primary.path} (fallback)` : primary.path;
  return `Source: ${label}\n\n${primary.content}`;
}

function formatAdditionalInstructions(projectInstructions) {
  const additional = projectInstructions?.additional ?? [];
  if (!additional.length) return "None.";
  return additional.map((file) => `### ${file.path}\n${file.content}`).join("\n\n");
}

function objectKeys(value) {
  return value && typeof value === "object" ? Object.keys(value).sort() : [];
}

function listOrNone(items = []) {
  return items.length ? items.slice(0, 80).join(", ") : "none";
}

function truncate(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd() + "\n[truncated " + hashText(text) + "]";
}

function hashText(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function indent(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
}

function fenced(content) {
  return "```text\n" + String(content ?? "") + "\n```";
}

function projectDescriptionPath(cwd) {
  return join(cwd, ".deecoo", "PROJECT.md");
}
