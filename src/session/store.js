import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const RECENT_TURNS_FOR_CONTEXT = 6;
const MAX_SUMMARY_CHARS = 6000;
const MAX_TURN_CHARS = 2000;

export async function createSessionStore(cwd) {
  const rootDir = deecooHome();
  const projectId = hash(cwd);
  const projectDir = join(rootDir, "sessions", projectId);
  await mkdir(projectDir, { recursive: true });

  return {
    rootDir,
    projectId,
    projectDir,
    async createSession({ model, title, summary = "", turns = [], history } = {}) {
      const now = new Date().toISOString();
      const initialHistory = Array.isArray(history) ? history : turns;
      const session = {
        id: randomUUID(),
        cwd,
        title: title || basename(cwd) || cwd,
        createdAt: now,
        updatedAt: now,
        model,
        summary,
        turns,
        history: initialHistory,
        artifacts: [],
      };
      await saveSession(projectDir, session);
      return session;
    },
    async listSessions() {
      const entries = await readdir(projectDir).catch(() => []);
      const sessions = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const session = await readSessionFile(join(projectDir, entry));
        if (session) sessions.push(session);
      }
      return sessions
        .filter((session) => sessionHistory(session).length > 0 || session.summary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async save(session) {
      await saveSession(projectDir, session);
    },
    async deleteSession(id) {
      if (!isSafeSessionId(id)) {
        throw new Error("Invalid session id.");
      }
      await unlink(join(projectDir, `${id}.json`));
    },
    async saveCheckpoint(sessionId, checkpoint) {
      if (!isSafeSessionId(sessionId)) return;
      await writeFile(join(projectDir, `${sessionId}.checkpoint.json`), JSON.stringify(checkpoint), "utf8");
    },
    async loadCheckpoint(sessionId) {
      if (!isSafeSessionId(sessionId)) return undefined;
      try {
        return JSON.parse(await readFile(join(projectDir, `${sessionId}.checkpoint.json`), "utf8"));
      } catch {
        return undefined;
      }
    },
    async clearCheckpoint(sessionId) {
      if (!isSafeSessionId(sessionId)) return;
      await unlink(join(projectDir, `${sessionId}.checkpoint.json`)).catch(() => {});
    },
  };
}

function deecooHome() {
  return resolve(process.env.DEECOO_HOME ?? resolve(homedir(), ".deecoo"));
}

export function buildSessionContext(session) {
  const messages = [];
  if (session.summary) {
    messages.push({
      role: "system",
      content: `Previous conversation summary for this project:\n${session.summary}`,
    });
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
  if (sessionHistory(session).length === 0) {
    session.title = titleFrom(user);
  }

  const turn = {
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
  const additions = compacted
    .map((turn) => {
      return [
        `User: ${truncateOneLine(turn.user, 300)}`,
        `Assistant: ${truncateOneLine(turn.assistant, 500)}`,
      ].join("\n");
    })
    .join("\n\n");

  session.summary = truncate([session.summary, additions].filter(Boolean).join("\n\n"), MAX_SUMMARY_CHARS);
  session.turns = remaining;
}

function titleFrom(text) {
  return truncateOneLine(text, 60) || "Untitled session";
}

async function saveSession(projectDir, session) {
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${session.id}.json`), JSON.stringify(session, null, 2) + "\n", "utf8");
}

async function readSessionFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed.id || !parsed.cwd) return undefined;
    parsed.turns ??= [];
    parsed.history ??= [...parsed.turns];
    parsed.summary ??= "";
    parsed.artifacts ??= [];
    return parsed;
  } catch {
    return undefined;
  }
}

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
