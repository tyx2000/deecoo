import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonFile } from "../storage/atomic.js";
import { canPersist, safeStorageId } from "../storage/governance.js";
import { join } from "node:path";
import { projectModelRequest } from "../llm/requestSnapshot.js";

const MAX_AUDIT_TEXT = 40000;
const TOKEN_METRIC_KEYS = new Set([
  "prompttokens", "completiontokens", "totaltokens", "inputtokens", "outputtokens",
  "cachedtokens", "reasoningtokens", "cachereadinputtokens", "cachecreationinputtokens",
  "maxtokens", "maxcompletiontokens", "tokenbudget", "workertokenbudget", "tokenusage",
  "requestedmaxtokens", "effectivemaxtokens", "minoutputtokens", "maxoutputtokens", "estimatedinputtokens", "outputreserve", "budgettokens",
]);
const METRIC_SOURCE_LABELS = new Set(["request", "configured", "adapter-compatible-default", "route-limit", "unknown-model", "model-metadata", "adapter-compatible-minimum"]);
const SECRET_PATTERNS = [
  /(DEEPSEEK_API_KEY\s*[:=]\s*)[^\s"']+/gi,
  /(OPENAI_API_KEY\s*[:=]\s*)[^\s"']+/gi,
  /(ANTHROPIC_API_KEY\s*[:=]\s*)[^\s"']+/gi,
  /(Authorization:\s*Bearer\s+)[^\s"']+/gi,
  /\b([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*[:=]\s*)[^\s"']+/gi,
  /\b([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*\s*[:=]\s*)[^\s"']+/gi,
];

export async function saveRunAudit(store, session, audit, options = {}) {
  if (!store?.projectDir || !session?.id || !audit || !canPersist(store)) return undefined;
  safeStorageId(session.id, "session id");
  const now = new Date().toISOString();
  const auditDir = join(store.projectDir, "audit", session.id);
  const fileName = now.replace(/[:.]/g, "-") + "-" + randomUUID() + ".json";
  const path = join(auditDir, fileName);
  const safe = markStoredContextProjection(audit, redact(audit, { secretRegistry: store.secretRegistry, ...options }), store.storagePolicy);
  const body = {
    schemaVersion: 1,
    sessionId: session.id,
    createdAt: now,
    ...safe,
  };
  await writeJsonFile(path, body, { maxBytes: store.storagePolicy?.maxFileBytes });
  return { path, createdAt: now };
}

// Stored privacy projections preserve historical hashes as provenance, but
// cannot claim those hashes can be recomputed from filtered source messages.
export function markStoredContextProjection(source, projected, { privacyMode } = {}) {
  if (source?.contextState && projected?.contextState && JSON.stringify(source.contextState) !== JSON.stringify(projected.contextState)) {
    projected.contextState.privacyFiltered = true;
    if (projected.contextState.sourceCompleteness !== "legacy-prefix-unavailable") projected.contextState.sourceCompleteness = "filtered";
  }
  if (Array.isArray(source?.workerContexts) && Array.isArray(projected?.workerContexts)) {
    source.workerContexts.forEach((entry, index) => markStoredContextProjection(entry, projected.workerContexts[index], { privacyMode }));
  }
  if (privacyMode === "redacted" && Array.isArray(projected?.modelDiagnostics?.events)) {
    for (const event of projected.modelDiagnostics.events) if (event.type === "model-attempt-start") { delete event.request; event.snapshotOmitted = true; }
    projected.modelDiagnostics.coverage = { ...projected.modelDiagnostics.coverage, requestSnapshotsComplete: false,
      retainedTraceComplete: false, snapshotPolicy: "omitted-for-privacy" };
  }
  return projected;
}

export async function listRunAudits(store, session) {
  if (!store?.projectDir || !session?.id || !canPersist(store)) return [];
  safeStorageId(session.id, "session id");
  const auditDir = join(store.projectDir, "audit", session.id);
  const entries = await readdir(auditDir).catch(() => []);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .reverse()
    .map((entry) => ({ fileName: entry, path: join(auditDir, entry) }));
}

export async function readRunAudit(path) {
  return readJsonFile(path, { validate: (value) => value?.schemaVersion === 1 });
}

export function redact(value, options = {}) {
  if (typeof value === "string") return redactString(value, options.secretRegistry, options.maxTextChars);
  if (Array.isArray(value)) return value.map((item) => redact(item, options));
  if (!value || typeof value !== "object") return value;
  if (value.type === "model-attempt-start" && value.request && typeof value.request === "object") {
    const { request, ...rest } = value;
    const safe = redact(rest, options);
    safe.request = projectModelRequest(request, { filterText: (text) => redactString(text, options.secretRegistry, Infinity) });
    return safe;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const metricKey = key.replace(/[_-]/g, "").toLowerCase();
    const safeMetric = TOKEN_METRIC_KEYS.has(metricKey) && (typeof item === "number" && Number.isFinite(item)
      || options.metricSources === true && typeof item === "string" && METRIC_SOURCE_LABELS.has(item));
    if (!safeMetric && /api[_-]?key|token|secret|authorization|password/i.test(key)) {
      Object.defineProperty(out, key, { value: "[REDACTED]", enumerable: true, configurable: true, writable: true });
    } else {
      Object.defineProperty(out, key, { value: redact(item, { ...options, metricSources: key === "sources" }), enumerable: true, configurable: true, writable: true });
    }
  }
  return out;
}

function redactString(value, secretRegistry, maxTextChars = MAX_AUDIT_TEXT) {
  // Remove concrete values before truncation, which could otherwise expose a key prefix.
  let text = secretRegistry ? secretRegistry.redact(value) : value;
  text = text.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (_match, prefix) => (prefix ? prefix + "[REDACTED]" : "[REDACTED]"));
  }
  return text.length > maxTextChars ? text.slice(0, maxTextChars) + "\n... truncated for audit" : text;
}
