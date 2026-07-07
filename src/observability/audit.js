import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_AUDIT_TEXT = 40000;
const SECRET_PATTERNS = [
  /(sk-[A-Za-z0-9_-]{12,})/g,
  /(DEEPSEEK_API_KEY\s*[:=]\s*)[^\s"']+/gi,
  /(Authorization:\s*Bearer\s+)[^\s"']+/gi,
  /([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*[:=]\s*)[^\s"']+/gi,
  /([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*\s*[:=]\s*)[^\s"']+/gi,
];

export async function saveRunAudit(store, session, audit) {
  if (!store?.projectDir || !session?.id || !audit) return undefined;
  const now = new Date().toISOString();
  const auditDir = join(store.projectDir, "audit", session.id);
  await mkdir(auditDir, { recursive: true });
  const fileName = now.replace(/[:.]/g, "-") + ".json";
  const path = join(auditDir, fileName);
  const body = {
    schemaVersion: 1,
    sessionId: session.id,
    createdAt: now,
    ...redact(audit),
  };
  await writeFile(path, JSON.stringify(body, null, 2) + "\n", "utf8");
  return { path, createdAt: now };
}

export async function listRunAudits(store, session) {
  if (!store?.projectDir || !session?.id) return [];
  const auditDir = join(store.projectDir, "audit", session.id);
  const entries = await readdir(auditDir).catch(() => []);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .reverse()
    .map((entry) => ({ fileName: entry, path: join(auditDir, entry) }));
}

export async function readRunAudit(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function redact(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api[_-]?key|token|secret|authorization|password/i.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redact(item);
    }
  }
  return out;
}

function redactString(value) {
  let text = value.length > MAX_AUDIT_TEXT ? value.slice(0, MAX_AUDIT_TEXT) + "\n... truncated for audit" : value;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (_match, prefix) => (prefix ? prefix + "[REDACTED]" : "[REDACTED]"));
  }
  return text;
}
