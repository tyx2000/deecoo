import { formatToolLine, renderMarkdown } from "../terminal/markdown.js";
import { paint } from "../terminal/theme.js";

export function formatSessionTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number) => String(number).padStart(2, "0");
  return [
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

export function shortSessionId(id) {
  return String(id).slice(0, 8);
}

export function sessionOptionLabel(session) {
  return `${shortSessionId(session.id).padEnd(8)}  ${formatSessionTime(session.updatedAt)}  ${sessionSummary(session)}`;
}

export function sessionSummary(session) {
  const source = session.history?.[0]?.user || session.turns[0]?.user || session.summary || session.title || "Untitled session";
  return String(source).replace(/\s+/g, " ").trim().slice(0, 80);
}

export function printSessionTranscript(session) {
  console.log(
    `Active session: ${shortSessionId(session.id)}  ${formatSessionTime(session.updatedAt)}  ${sessionSummary(session)}`,
  );
  if (session.summary) {
    console.log("");
    console.log(formatToolLine("summary"));
    console.log(renderMarkdown(session.summary));
  }

  const turns = sessionHistory(session);
  if (turns.length === 0) {
    console.log("");
    console.log(formatToolLine("No recorded turns."));
    return;
  }

  console.log("");
  console.log(formatToolLine("conversation"));
  for (const [index, turn] of turns.entries()) {
    console.log("");
    console.log(paint("title", `Turn ${index + 1}  ${formatSessionTime(turn.at)}`));
    console.log(paint("muted", "User"));
    console.log(renderMarkdown(turn.user?.trim() || "_empty_"));
    console.log("");
    console.log(paint("muted", "Assistant"));
    console.log(renderMarkdown(turn.assistant?.trim() || "_empty_"));
  }
}

export function exportFileName(session) {
  const time = formatSessionTime(session.updatedAt).replace(/[/: ]/g, "-");
  const title = slugify(sessionSummary(session)).slice(0, 48) || "conversation";
  return `deecoo-session-${shortSessionId(session.id)}-${time}-${title}.md`;
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function sessionToMarkdown(session) {
  const lines = [
    `# Deecoo Conversation ${shortSessionId(session.id)}`,
    "",
    `- Session ID: ${session.id}`,
    `- Project: ${session.cwd}`,
    `- Title: ${session.title ?? sessionSummary(session)}`,
    `- Model: ${session.model ?? "-"}`,
    `- Created: ${formatSessionTime(session.createdAt)}`,
    `- Updated: ${formatSessionTime(session.updatedAt)}`,
    "",
  ];

  if (session.summary) {
    lines.push("## Summary", "", session.summary.trim(), "");
  }

  lines.push("## Turns", "");
  const turns = sessionHistory(session);
  if (!turns.length) {
    lines.push("_No recorded turns._", "");
  }

  for (const [index, turn] of turns.entries()) {
    lines.push(`### Turn ${index + 1} - ${formatSessionTime(turn.at)}`, "");
    lines.push("#### User", "", turn.user?.trim() || "_empty_", "");
    lines.push("#### Assistant", "", turn.assistant?.trim() || "_empty_", "");
    if (turn.model) {
      lines.push(`_Model: ${turn.model}_`, "");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function sessionPromptHistory(session) {
  return sessionHistory(session).map((turn) => turn.user).filter(Boolean);
}

export function sessionHistory(session) {
  return Array.isArray(session.history) ? session.history : session.turns ?? [];
}

export function truncateOneLine(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
