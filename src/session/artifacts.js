import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_ARTIFACT_CONTEXT_CHARS = 60000;

export async function saveSkillArtifact(store, session, { skillName, kind, title, content, metadata = {} }) {
  if (!store?.projectDir || !session?.id || !content) return undefined;
  const now = new Date().toISOString();
  const artifactDir = join(store.projectDir, "artifacts", session.id);
  await mkdir(artifactDir, { recursive: true });
  const index = await nextArtifactIndex(artifactDir);
  const safeSkill = safeName(skillName || "skill");
  const safeKind = safeName(kind || "output");
  const fileName = String(index).padStart(4, "0") + "-" + safeSkill + "-" + safeKind + ".md";
  const artifact = {
    id: fileName.replace(/\.md$/, ""),
    sessionId: session.id,
    skillName,
    kind,
    title: title || skillName || kind || "artifact",
    path: join(artifactDir, fileName),
    createdAt: now,
    metadata,
  };
  const body = artifactMarkdown(artifact, content);
  await writeFile(artifact.path, body, "utf8");
  session.artifacts ??= [];
  session.artifacts.push({ ...artifact, path: artifact.path });
  await store.save(session);
  return artifact;
}

export async function findLatestSkillArtifact(store, session, { skillName, kind } = {}) {
  const fromSession = [...(session?.artifacts ?? [])]
    .filter((artifact) => matchesArtifact(artifact, { skillName, kind }))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
  if (fromSession) return withContent(fromSession);

  if (!store?.projectDir || !session?.id) return undefined;
  const artifactDir = join(store.projectDir, "artifacts", session.id);
  const entries = await readdir(artifactDir).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const parsed = parseArtifactFileName(entry);
    if (!matchesArtifact(parsed, { skillName, kind })) continue;
    candidates.push({ ...parsed, path: join(artifactDir, entry) });
  }
  candidates.sort((a, b) => b.id.localeCompare(a.id));
  return candidates[0] ? withContent(candidates[0]) : undefined;
}

export async function artifactContextMessages(store, session, { activeSkillNames = [], maxArtifacts = 3 } = {}) {
  const artifacts = relevantArtifacts(session, { activeSkillNames, maxArtifacts });
  const hydrated = await Promise.all(artifacts.map((artifact) => withContent(artifact)));
  return hydrated.map((artifact) => artifactContextMessage(artifact)).filter(Boolean);
}

export function artifactContextMessage(artifact) {
  if (!artifact?.content) return undefined;
  return {
    role: "system",
    content: [
      "Skill handoff artifact available.",
      "Artifact: " + artifact.id,
      "Skill: " + (artifact.skillName ?? "unknown"),
      "Kind: " + (artifact.kind ?? "unknown"),
      "Path: " + artifact.path,
      "Use this artifact as the source of truth. Do not repeat the prior skill's work unless the user explicitly asks for a fresh review or the artifact is insufficient.",
      "Content:",
      artifact.content.slice(0, MAX_ARTIFACT_CONTEXT_CHARS),
    ].join("\n"),
  };
}

function relevantArtifacts(session, { activeSkillNames, maxArtifacts }) {
  const artifacts = [...(session?.artifacts ?? [])];
  const active = new Set(activeSkillNames);
  const scored = artifacts.map((artifact) => ({
    artifact,
    score: artifactScore(artifact, active),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.artifact.createdAt ?? "").localeCompare(String(a.artifact.createdAt ?? ""));
  });
  return scored.slice(0, maxArtifacts).map((entry) => entry.artifact);
}

function artifactScore(artifact, activeSkillNames) {
  let score = 0;
  if (activeSkillNames.has("post-cor") && artifact.skillName === "s-cor" && artifact.kind === "findings") score += 100;
  if (activeSkillNames.has(artifact.skillName)) score += 20;
  if (artifact.kind === "findings") score += 5;
  return score;
}

function artifactMarkdown(artifact, content) {
  return [
    "---",
    "id: " + artifact.id,
    "sessionId: " + artifact.sessionId,
    "skillName: " + artifact.skillName,
    "kind: " + artifact.kind,
    "createdAt: " + artifact.createdAt,
    "---",
    "",
    "# " + artifact.title,
    "",
    String(content).trim(),
    "",
  ].join("\n");
}

async function nextArtifactIndex(artifactDir) {
  const entries = await readdir(artifactDir).catch(() => []);
  let max = 0;
  for (const entry of entries) {
    const match = entry.match(/^(\d+)-/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

async function withContent(artifact) {
  try {
    return { ...artifact, content: await readFile(artifact.path, "utf8") };
  } catch {
    return artifact;
  }
}

function parseArtifactFileName(fileName) {
  const id = fileName.replace(/\.md$/, "");
  const parts = id.split("-");
  return {
    id,
    skillName: parts[1],
    kind: parts.slice(2).join("-"),
  };
}

function matchesArtifact(artifact, { skillName, kind }) {
  if (!artifact) return false;
  if (skillName && artifact.skillName !== skillName) return false;
  if (kind && artifact.kind !== kind) return false;
  return true;
}

function safeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "artifact";
}

