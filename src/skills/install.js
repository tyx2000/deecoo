import { access, cp, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const MAX_SCAN_DEPTH = 8;
const SKIP_DIRS = new Set([".git", "node_modules"]);

export async function listCodexSkills({ home = homedir() } = {}) {
  const roots = skillRoots(home);
  const skills = [];
  const seen = new Set();

  for (const root of roots) {
    if (!(await exists(root.path))) continue;
    const found = await findSkillDirs(root.path, root.path, root.label, MAX_SCAN_DEPTH);
    for (const skill of found) {
      const key = `${skill.sourcePath}:${skill.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push(skill);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.sourceLabel.localeCompare(b.sourceLabel));
}

export function projectSkillsDir(cwd) {
  return resolve(cwd, ".deepcode", "skills");
}

export async function listProjectSkills(cwd) {
  const root = projectSkillsDir(cwd);
  if (!(await exists(root))) return [];
  const found = await findSkillDirs(root, root, "project", 3);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function installCodexSkill({ skill, cwd }) {
  const targetRoot = projectSkillsDir(cwd);
  const targetName = safeSkillName(skill.name);
  const targetPath = join(targetRoot, targetName);
  await mkdir(targetRoot, { recursive: true });
  await cp(skill.sourcePath, targetPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => {
      const name = basename(source);
      return !SKIP_DIRS.has(name);
    },
  });
  return targetPath;
}

function skillRoots(home) {
  const codexHome = resolve(process.env.CODEX_HOME ?? join(home, ".codex"));
  return [
    { label: "codex", path: join(codexHome, "skills") },
    { label: "agents", path: join(home, ".agents", "skills") },
    { label: "plugins", path: join(codexHome, "plugins", "cache") },
  ];
}

async function findSkillDirs(root, current, sourceLabel, depth) {
  if (depth < 0) return [];
  const skillFile = join(current, "SKILL.md");
  if (await exists(skillFile)) {
    return [await readSkill(root, current, sourceLabel, skillFile)];
  }

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    results.push(...(await findSkillDirs(root, join(current, entry.name), sourceLabel, depth - 1)));
  }
  return results;
}

async function readSkill(root, sourcePath, sourceLabel, skillFile) {
  const name = basename(sourcePath);
  const relativePath = relative(root, sourcePath) || name;
  const summary = firstMeaningfulLine(await readFile(skillFile, "utf8"));
  return {
    id: `${sourceLabel}:${relativePath}`,
    name,
    sourceLabel,
    sourcePath,
    relativePath,
    summary,
  };
}

function firstMeaningfulLine(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  for (const line of lines) {
    const description = line.match(/^description:\s*(.*)$/i);
    if (description?.[1]) return description[1].replace(/^["']|["']$/g, "").trim().slice(0, 120);
  }
  for (const line of lines) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text === "---") continue;
    if (/^(name|description):\s*/i.test(text)) continue;
    if (text) return text.slice(0, 120);
  }
  return "No description";
}

function safeSkillName(value) {
  const safe = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "skill";
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
