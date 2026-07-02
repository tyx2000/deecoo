import { access, readdir, readFile } from "node:fs/promises";
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

export async function loadCodexSkill(skill) {
  const content = await readFile(join(skill.sourcePath, "SKILL.md"), "utf8");
  return {
    id: skill.id,
    name: skill.name,
    sourceLabel: skill.sourceLabel,
    sourcePath: skill.sourcePath,
    relativePath: skill.relativePath,
    summary: skill.summary,
    defaultPrompt: extractDefaultPrompt(content),
    content,
  };
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

function extractDefaultPrompt(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^default_prompt:\s*(.*)$/i);
    if (match?.[1]) return match[1].replace(/^["']|["']$/g, "").trim();
  }
  return "";
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
