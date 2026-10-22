import { mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { dataContextMessage } from "../harness/contentTrust.js";
import { appendJsonEvent, readJsonEvents, readJsonFile, removeStoredFile, updateJsonFile, withFileLock, writeJsonFile } from "../storage/atomic.js";
import { canPersist, pruneStorage, storageInventory, storagePolicy } from "../storage/governance.js";
import { markStoredContextProjection, redact } from "../observability/audit.js";

const RECENT_TURNS_FOR_CONTEXT = 6;
const MAX_SUMMARY_CHARS = 6000;
const MAX_TURN_CHARS = 2000;
const MAX_CONSTRAINT_CHARS = 1800;
const MAX_LEGACY_SUMMARY_CHARS = 1000;

export async function createSessionStore(cwd, options = {}) {
  const rootDir = options.rootDir ? resolve(options.rootDir) : deecooHome();
  const projectId = hash(cwd);
  const projectDir = join(rootDir, "sessions", projectId);
  const policy = storagePolicy(options);
  if (policy.privacyMode !== "ephemeral") await mkdir(projectDir, { recursive: true, mode: 0o700 });
  const volatileSessions = new Map();
  const volatileCheckpoints = new Map();
  const sessionPath = (id) => join(projectDir, safeSessionId(id) + ".json");
  const checkpointPath = (id) => join(projectDir, safeSessionId(id) + ".checkpoint.json");
  const deletionPath = (id) => join(projectDir, safeSessionId(id) + ".deleted.json");
  const operationPath = (id) => sessionPath(id) + ".operation";
  const ownerPath = (id) => join(projectDir, safeSessionId(id) + ".owner.json");
  const journalPath = (id) => join(projectDir, "journal", safeSessionId(id) + ".jsonl");
  const store = {
    rootDir, projectId, projectDir, storagePolicy: policy, secretRegistry: options.secretRegistry,
    async createSession({ model, title, summary = "", turns = [], history } = {}) {
      const now = new Date().toISOString();
      const initialHistory = Array.isArray(history) ? history : turns;
      const session = { schemaVersion: 2, revision: 0, id: randomUUID(), cwd,
        title: title || basename(cwd) || cwd, createdAt: now, updatedAt: now, model,
        summary, turns: [...turns], history: [...initialHistory], artifacts: [] };
      await store.save(session);
      return session;
    },
    async loadSession(id) {
      if (!canPersist(store)) return structuredClone(volatileSessions.get(id));
      return readSessionFile(sessionPath(id));
    },
    async listSessions() {
      if (!canPersist(store)) return [...volatileSessions.values()].map((session) => structuredClone(session));
      const entries = await readdir(projectDir).catch(() => []);
      const sessions = [];
      for (const entry of entries) {
        if (!/^[0-9a-fA-F-]{8,80}\.json$/.test(entry)) continue;
        const session = await readSessionFile(join(projectDir, entry));
        if (session) sessions.push(session);
      }
      return sessions.filter((session) => sessionHistory(session).length > 0 || session.summary || entries.includes(`${session.id}.checkpoint.json`))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async save(session) {
      safeSessionId(session.id);
      if (!canPersist(store)) { volatileSessions.set(session.id, structuredClone(session)); return session; }
      const value = await withFileLock(operationPath(session.id), async () => {
        if (await readJsonFile(deletionPath(session.id))) throw Object.assign(new Error("Session was deleted; stale state cannot recreate it."), { code: "SESSION_DELETED" });
        return updateJsonFile(sessionPath(session.id), (current) => {
        const next = current && current.revision !== (session.revision ?? 0) ? mergeSession(current, session) : structuredClone(session);
        next.schemaVersion = 2;
        next.revision = (current?.revision ?? 0) + 1;
        return policy.privacyMode === "redacted" ? redact(next, { secretRegistry: store.secretRegistry, maxTextChars: Infinity }) : next;
      }, { ...sessionReadOptions(), maxBytes: policy.maxFileBytes });
      });
      Object.assign(session, value);
      return session;
    },
    async deleteSession(id, { associated = true } = {}) {
      safeSessionId(id);
      volatileSessions.delete(id); volatileCheckpoints.delete(id);
      if (!canPersist(store)) return { id, associated, removed: [] };
      return withFileLock(operationPath(id), async () => {
        await store.assertTaskOwner(id);
        await writeJsonFile(deletionPath(id), { schemaVersion: 1, id, deletedAt: new Date().toISOString() });
      const paths = [sessionPath(id), checkpointPath(id), ownerPath(id)];
      if (associated) paths.push(journalPath(id));
      for (const path of paths) await removeStoredFile(path);
      const removed = [...paths];
      if (associated) {
        for (const kind of ["artifacts", "audit", "output", "outputs", "tool-outputs"]) {
          const path = join(projectDir, kind, id);
          await rm(path, { recursive: true, force: true }); removed.push(path);
        }
        // Corrupt quarantines may contain the same private session data.
        for (const entry of await readdir(projectDir)) {
          if (entry.startsWith(id + ".") && (entry.includes(".corrupt-") || entry.endsWith(".tmp"))) await rm(join(projectDir, entry), { force: true });
        }
      }
        return { id, associated, removed };
      });
    },
    async claimTaskOwner(id, { runId, taskId = runId } = {}) {
      if (!runId) throw new Error("runId is required for task ownership.");
      if (!canPersist(store)) return { runId, taskId, pid: process.pid };
      return updateJsonFile(ownerPath(id), (current) => {
        if (current && current.runId !== runId && processIsAlive(current.pid)) throw ownerConflict();
        return { schemaVersion: 1, sessionId: id, runId, taskId, pid: process.pid, claimedAt: new Date().toISOString() };
      });
    },
    async assertTaskOwner(id, runId) {
      if (!canPersist(store)) return;
      const owner = await readJsonFile(ownerPath(id));
      if (owner && processIsAlive(owner.pid) && owner.runId !== runId) throw ownerConflict();
    },
    async releaseTaskOwner(id, runId) {
      if (!canPersist(store)) return;
      return withFileLock(ownerPath(id), async () => {
        let owner;
        try { owner = JSON.parse(await readFile(ownerPath(id), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (owner?.runId === runId) await unlink(ownerPath(id));
      });
    },
    async saveCheckpoint(id, checkpoint) {
      if (!isSafeSessionId(id)) return;
      if (!canPersist(store)) { volatileCheckpoints.set(id, structuredClone(checkpoint)); return; }
      await store.assertTaskOwner(id, checkpoint.metadata?.runId);
      return writeJsonFile(checkpointPath(id), policy.privacyMode === "redacted" ? markStoredContextProjection(checkpoint, redact(checkpoint, { secretRegistry: store.secretRegistry, maxTextChars: Infinity })) : checkpoint, { maxBytes: policy.maxFileBytes });
    },
    async loadCheckpoint(id) {
      if (!isSafeSessionId(id)) return undefined;
      if (!canPersist(store)) return structuredClone(volatileCheckpoints.get(id));
      return readJsonFile(checkpointPath(id), { validate: (value) => value && typeof value === "object" });
    },
    async clearCheckpoint(id, { runId } = {}) {
      if (!isSafeSessionId(id)) return;
      volatileCheckpoints.delete(id);
      if (canPersist(store)) { await store.assertTaskOwner(id, runId); await removeStoredFile(checkpointPath(id)); }
    },
    async appendToolEvent(id, event) {
      if (!canPersist(store) || !policy.durableToolEvents) return undefined;
      await store.assertTaskOwner(id, event.runId);
      return appendJsonEvent(journalPath(id), { ...redact(event, { secretRegistry: store.secretRegistry, maxTextChars: Infinity }), schemaVersion: 1, sessionId: id, at: new Date().toISOString() }, { maxBytes: policy.maxFileBytes });
    },
    async readToolEvents(id) {
      if (!canPersist(store)) return [];
      return readJsonEvents(journalPath(id));
    },
    async prune(options) { return canPersist(store) ? pruneStorage(projectDir, policy, options) : { removed: [], bytesBefore: 0, bytesAfter: 0 }; },
    async inventory() { return canPersist(store) ? storageInventory(projectDir) : { files: [], totalBytes: 0 }; },
  };
  if (canPersist(store) && options.autoPrune !== false) await store.prune();
  return store;
}

function deecooHome() {
  return resolve(process.env.DEECOO_HOME ?? resolve(homedir(), ".deecoo"));
}

export function buildSessionContext(session) {
  const messages = [];
  if (session.summary) {
    messages.push(dataContextMessage({ source: "session-summary", kind: "derived-memory", scope: session.cwd,
      reference: session.id, content: session.summary }));
  }

  for (const turn of session.turns.slice(-RECENT_TURNS_FOR_CONTEXT)) {
    messages.push({ role: "user", content: truncate(turn.user, MAX_TURN_CHARS) });
    messages.push({ role: "assistant", content: truncate(turn.assistant, MAX_TURN_CHARS) });
  }

  return messages;
}

export async function recordTurn(store, session, { user, assistant, model }) {
  const now = new Date().toISOString();
  session.history ??= [...(session.turns ?? [])];
  // Also repair aliases supplied by older in-memory callers before appending.
  if (session.history === session.turns) session.history = [...session.history];
  if (sessionHistory(session).length === 0) {
    session.title = titleFrom(user);
  }

  const turn = {
    id: randomUUID(),
    user,
    assistant,
    model,
    at: now,
  };
  session.turns.push(turn);
  session.history.push(turn);
  session.model = model;
  session.updatedAt = now;
  compactSession(session);
  await store.save(session);
  return session;
}

function compactSession(session) {
  if (session.turns.length <= RECENT_TURNS_FOR_CONTEXT) return;

  const compactCount = session.turns.length - RECENT_TURNS_FOR_CONTEXT;
  const compacted = session.turns.slice(0, compactCount);
  const remaining = session.turns.slice(compactCount);
  const state = session.summaryState?.version === 1 ? session.summaryState : {
    version: 1,
    // Preserve a bounded part of a legacy plain summary once, never re-import a rendered summary.
    legacy: String(session.summary ?? "").slice(0, MAX_LEGACY_SUMMARY_CHARS),
    // Legacy files may have a full history even when the old rendered summary was truncated.
    // Recover constraints only from previously compacted user turns, not the recent-turn tail.
    constraints: (session.history ?? [])
      .slice(0, Math.max(0, (session.history?.length ?? 0) - session.turns.length))
      .flatMap((turn) => explicitUserConstraints(turn.user)),
    recent: [],
    failures: [],
  };
  for (const turn of compacted) {
    state.recent.push([
      `User: ${truncateOneLine(turn.user, 300)}`,
      `Assistant: ${truncateOneLine(turn.assistant, 500)}`,
    ].join("\n"));
    state.constraints.push(...explicitUserConstraints(turn.user));
    state.failures ??= [];
    state.failures.push(...criticalRunLines(turn.assistant));
  }
  state.constraints = recentEntriesWithin(state.constraints, MAX_CONSTRAINT_CHARS);
  state.failures = recentEntriesWithin(state.failures ?? [], 1200);
  const fixed = [
    state.constraints.length ? "Explicit user constraints (oldest to newest):\n" + state.constraints.join("\n") : "",
    state.failures.length ? "Verification and unresolved failures (validate against current state):\n" + state.failures.join("\n") : "",
    state.legacy ? "Earlier summary:\n" + state.legacy : "",
  ].filter(Boolean).join("\n\n");
  const recentHeader = "Recently compacted turns:\n";
  const separator = fixed ? "\n\n" : "";
  const recentBudget = MAX_SUMMARY_CHARS - fixed.length - separator.length - recentHeader.length;
  state.recent = recentEntriesWithin(state.recent, recentBudget, "\n\n");
  session.summaryState = state;
  session.summary = fixed + separator + recentHeader + state.recent.join("\n\n");
  session.turns = remaining;
}

function explicitUserConstraints(text) {
  // This is explicit-marker retention, not semantic extraction. Full history stays authoritative.
  return String(text ?? "").split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => /^(?:(?:constraint|requirement|remember)\s*:|(?:always|never|must)\b|(?:约束|要求)\s*[:：]|(?:请)?(?:记住|必须|不要|禁止|始终|务必))/i.test(line))
    .map((line) => truncateOneLine(line, 400));
}

function criticalRunLines(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /\b(?:failed|error|blocked|unresolved|required checks?|acceptance)\b|失败|错误|阻塞|未解决|验收|必需检查/i.test(line))
    .map((line) => truncateOneLine(line, 400));
}

function recentEntriesWithin(entries, budget, separator = "\n") {
  const retained = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = String(entries[index]);
    const cost = entry.length + (retained.length ? separator.length : 0);
    if (used + cost > budget) break;
    retained.unshift(entry);
    used += cost;
  }
  return retained;
}

function titleFrom(text) {
  return truncateOneLine(text, 60) || "Untitled session";
}

function sessionReadOptions() {
  return { migrate: migrateSession, validate: (value) => value?.schemaVersion === 2 && Boolean(value.id && value.cwd) };
}
async function readSessionFile(path) { return readJsonFile(path, sessionReadOptions()); }
function migrateSession(parsed) {
  if (!parsed || typeof parsed !== "object" || (parsed.schemaVersion ?? 1) > 2) return parsed;
  const rawHistory = parsed.history ?? [...(parsed.turns ?? [])];
  const history = rawHistory.map((turn, index) => ({ ...turn, id: turn.id ?? "legacy-" + hash(JSON.stringify(turn) + ":" + index) }));
  const turns = (parsed.turns ?? []).map((turn, index, recent) => {
    if (turn.id) return turn;
    const historyIndex = history.length - recent.length + index;
    if (historyIndex >= 0 && JSON.stringify(rawHistory[historyIndex]) === JSON.stringify(turn)) return history[historyIndex];
    return { ...turn, id: "legacy-recent-" + hash(JSON.stringify(turn) + ":" + index) };
  });
  return { ...parsed, schemaVersion: 2, revision: parsed.revision ?? 0, turns, history,
    summary: parsed.summary ?? "", artifacts: parsed.artifacts ?? [] };
}

function mergeSession(current, incoming) {
  const tombstones = [...new Set([...(current.artifactTombstones ?? []), ...(incoming.artifactTombstones ?? [])])];
  const merged = { ...current, ...incoming, history: mergeEntries(current.history, incoming.history, turnIdentity),
    artifactTombstones: tombstones,
    artifacts: mergeEntries(current.artifacts, incoming.artifacts, (item) => item.id).filter((item) => !tombstones.includes(item.id)) };
  // Rebuild summaries from authoritative complete history after a concurrent save.
  merged.turns = [...merged.history];
  merged.summaryState = undefined;
  merged.summary = current.summaryState?.legacy ?? incoming.summaryState?.legacy ?? "";
  compactSession(merged);
  return merged;
}
function mergeEntries(first = [], second = [], identity) {
  const seen = new Set();
  return [...first, ...second].filter((item) => { const key = identity(item); if (seen.has(key)) return false; seen.add(key); return true; });
}
function turnIdentity(turn) { return turn.id ?? hash(JSON.stringify(turn)); }
function safeSessionId(id) { if (!isSafeSessionId(id)) throw new Error("Invalid session id."); return id; }
function processIsAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }
function ownerConflict() { return Object.assign(new Error("Session belongs to another active task."), { code: "STORAGE_OWNER_CONFLICT" }); }

function sessionHistory(session) {
  return Array.isArray(session.history) ? session.history : session.turns ?? [];
}

function isSafeSessionId(id) {
  return /^[0-9a-fA-F-]{8,80}$/.test(String(id ?? ""));
}

function hash(value) {
  return createHash("sha1").update(value).digest("hex");
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function truncateOneLine(value, max) {
  return truncate(String(value ?? "").replace(/\s+/g, " ").trim(), max);
}
