import { readdir } from "node:fs/promises";
import { atomicWriteFile, readStoredFile, removeStoredFile, withFileLock } from "../storage/atomic.js";
import { canPersist, safeStorageId } from "../storage/governance.js";
import { redact } from "../observability/audit.js";
import { join } from "node:path";
import { dataContextMessage } from "../harness/contentTrust.js";

const MAX_ARTIFACT_CONTEXT_CHARS = 60000;

export async function saveSkillArtifact(store, session, { skillName, kind, title, content, metadata = {} }) {
  if (!store?.projectDir || !session?.id || !content || !canPersist(store)) return undefined;
  safeStorageId(session.id, "session id");
  const now = new Date().toISOString();
  const artifactDir = join(store.projectDir, "artifacts", session.id);
  const artifact = await withFileLock(join(artifactDir, ".index"), async () => {
    const index = await nextArtifactIndex(artifactDir);
    const safeSkill = safeName(skillName || "skill");
    const safeKind = safeName(kind || "output");
    const fileName = String(index).padStart(4, "0") + "-" + safeSkill + "-" + safeKind + ".md";
    const value = { id: fileName.replace(/\.md$/, ""), sessionId: session.id, skillName, kind,
      title: title || skillName || kind || "artifact", path: join(artifactDir, fileName), createdAt: now,
      metadata: redact(metadata, { secretRegistry: store.secretRegistry }) };
    const body = artifactMarkdown(value, redact(String(content), { secretRegistry: store.secretRegistry, maxTextChars: Infinity }));
    await atomicWriteFile(value.path, body, { maxBytes: store.storagePolicy?.maxFileBytes });
    return value;
  });
  session.artifacts ??= [];
  session.artifacts.push(artifact);
  await store.save(session);
  return artifact;
}

export async function findLatestSkillArtifact(store, session, { skillName, kind } = {}) {
  if (!canPersist(store)) return undefined;
  if (session?.id) safeStorageId(session.id, "session id");
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

export async function listSkillArtifacts(store, session) {
  if (!store?.projectDir || !session?.id || !canPersist(store)) return [];
  safeStorageId(session.id, "session id");
  const directory = join(store.projectDir, "artifacts", session.id);
  return (await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; }))
    .filter((name) => /^\d+-[a-z0-9-]+\.md$/.test(name)).sort().reverse()
    .map((name) => ({ ...parseArtifactFileName(name), sessionId: session.id, path: join(directory, name) }));
}
export async function readSkillArtifact(store, session, id) {
  if (!canPersist(store)) return undefined;
  const artifact = (await listSkillArtifacts(store, session)).find((item) => item.id === id);
  return artifact ? withContent(artifact) : undefined;
}
export async function deleteSkillArtifact(store, session, id) {
  if (!/^\d+-[a-z0-9-]+$/.test(String(id ?? ""))) throw new Error("Invalid artifact id.");
  safeStorageId(session.id, "session id");
  await store.assertTaskOwner?.(session.id);
  const directory = join(store.projectDir, "artifacts", session.id);
  if (canPersist(store)) await withFileLock(join(directory, ".index"), async () => {
    await removeStoredFile(join(directory, id + ".md"));
    session.artifacts = (session.artifacts ?? []).filter((item) => item.id !== id);
    session.artifactTombstones = [...new Set([...(session.artifactTombstones ?? []), id])];
    // Save with the current revision so an ordinary edit removes the index entry;
    // conflicting writers retain their own independent artifacts.
    await store.save(session);
  });
  return { id, deleted: true };
}

export async function artifactContextMessages(store, session, { activeSkillNames = [], maxArtifacts = 3 } = {}) {
  if (!canPersist(store)) return [];
  const artifacts = relevantArtifacts(session, { activeSkillNames, maxArtifacts });
  const hydrated = await Promise.all(artifacts.map((artifact) => withContent(artifact)));
  return hydrated.map((artifact) => artifactContextMessage(artifact)).filter(Boolean);
}

export function artifactContextMessage(artifact) {
  if (!artifact?.content) return undefined;
  return dataContextMessage({ source: "skill-artifact", kind: "derived-output", scope: artifact.sessionId,
    reference: artifact.id, metadata: artifact.metadata,
    content: [
      "Skill handoff artifact available.",
      "Artifact: " + artifact.id,
      "Skill: " + (artifact.skillName ?? "unknown"),
      "Kind: " + (artifact.kind ?? "unknown"),
      "Storage: internal handoff artifact; content is already embedded below. Do not use file tools to read artifact storage paths.",
      "This is prior analysis. Validate its evidence against the current workspace before using it.",
      "Content:",
      artifact.content.slice(0, MAX_ARTIFACT_CONTEXT_CHARS),
    ].join("\n"),
  });
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
    return { ...artifact, content: await readStoredFile(artifact.path) };
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

