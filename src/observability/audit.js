import { readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { readJsonFile, withFileLock, writeJsonFile } from "../storage/atomic.js";
import { canPersist, safeStorageId } from "../storage/governance.js";
import { join } from "node:path";
import { projectModelRequest } from "../llm/requestSnapshot.js";

const MAX_AUDIT_TEXT = 40000;
// Kept beside the per-session directory so that directory holds only audit records.
export const auditChainHeadPath = (projectDir, sessionId) => join(projectDir, "audit", sessionId + ".chain-head");
const TOKEN_METRIC_KEYS = new Set([
  "prompttokens", "completiontokens", "totaltokens", "inputtokens", "outputtokens",
  "cachedtokens", "reasoningtokens", "cachereadinputtokens", "cachecreationinputtokens",
  "maxtokens", "maxcompletiontokens", "tokenbudget", "workertokenbudget", "tokenusage",
  "requestedmaxtokens", "effectivemaxtokens", "minoutputtokens", "maxoutputtokens", "estimatedinputtokens", "outputreserve", "budgettokens",
  "estimatedcontexttokens", "reservedinputtokens", "availablecontexttokens",
]);
const METRIC_SOURCE_LABELS = new Set(["request", "configured", "adapter-compatible-default", "route-limit", "unknown-model", "model-metadata", "adapter-compatible-minimum"]);
const SECRET_PATTERNS = [
  /(DEEPSEEK_API_KEY\s*[:=]\s*)[^\s"']+/gi,
  /(OPENAI_API_KEY\s*[:=]\s*)[^\s"']+/gi,
  /(ANTHROPIC_API_KEY\s*[:=]\s*)[^\s"']+/gi,
  /(Authorization:\s*Bearer\s+)[^\s"']+/gi,
];
// Credential-named assignments in free text are redacted by the shape of the assigned value, not
// the name alone, so source such as `promptTokens = Number(...)` or `max_tokens: 4096` stays readable.
const CREDENTIAL_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]+)/gi;
const KNOWN_SECRET_PREFIX = /^(?:sk-|sk_|pk_|rk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|eyJ|npm_)/;

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
  // Each record links to the previous one by digest and the chain head records the newest, so
  // an edited, removed, or reordered record is detectable (a hash chain, not a signature).
  const headPath = auditChainHeadPath(store.projectDir, session.id);
  await withFileLock(headPath + ".chain", async () => {
    const head = await readJsonFile(headPath);
    body.integrity = { algorithm: "sha256", sequence: (head?.sequence ?? 0) + 1, previousDigest: head?.digest ?? null };
    body.integrity.digest = auditDigest(body);
    await writeJsonFile(path, body, { maxBytes: store.storagePolicy?.maxFileBytes });
    await writeJsonFile(headPath, { schemaVersion: 1, sequence: body.integrity.sequence, digest: body.integrity.digest, fileName });
  });
  return { path, createdAt: now, integrity: body.integrity };
}

export async function verifyRunAuditChain(store, session) {
  const records = [];
  for (const entry of (await listRunAudits(store, session)).reverse()) {
    const audit = await readRunAudit(entry.path).catch(() => undefined);
    if (!audit) return { ok: false, reason: "unreadable-record", fileName: entry.fileName };
    records.push({ fileName: entry.fileName, audit });
  }
  const chained = records.filter((record) => record.audit.integrity).sort((a, b) => a.audit.integrity.sequence - b.audit.integrity.sequence);
  let previous;
  for (const { fileName, audit } of chained) {
    if (auditDigest(audit) !== audit.integrity.digest) return { ok: false, reason: "digest-mismatch", fileName };
    if (previous && (audit.integrity.sequence !== previous.sequence + 1 || audit.integrity.previousDigest !== previous.digest)) return { ok: false, reason: "chain-gap", fileName };
    previous = audit.integrity;
  }
  const head = await readJsonFile(auditChainHeadPath(store.projectDir, session.id)).catch(() => undefined);
  if (head && (!previous || head.sequence !== previous.sequence || head.digest !== previous.digest)) return { ok: false, reason: "head-mismatch", fileName: head.fileName };
  // Retention pruning removes the oldest records; the chain is verified from the first one kept.
  return { ok: true, records: chained.length, legacyRecords: records.length - chained.length, firstSequence: chained[0]?.audit.integrity.sequence };
}

function auditDigest(body) {
  const { integrity: { digest: _digest, ...integrity } = {}, ...rest } = JSON.parse(JSON.stringify(body));
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical({ ...rest, integrity }))).digest("hex");
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
  text = text.replace(CREDENTIAL_ASSIGNMENT, (match, prefix, value) => looksLikeSecretValue(value) ? prefix + "[REDACTED]" : match);
  return text.length > maxTextChars ? text.slice(0, maxTextChars) + "\n... truncated for audit" : text;
}

function looksLikeSecretValue(value) {
  if (KNOWN_SECRET_PREFIX.test(value)) return value.length >= 8;
  if (value.length < 12 || /^\d+$/.test(value) || !/^[A-Za-z0-9+/=_.~-]+$/.test(value)) return false;
  // Identifiers and member paths (`config.tokenBudget`) are code, not credentials.
  return /\d/.test(value) || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value);
}

// Value-only filtering for durable state that must keep its structure (sessions, checkpoints):
// known secret values and credential-shaped strings are replaced; keys and numbers are untouched.
export function redactSecretValues(value, { secretRegistry } = {}) {
  if (typeof value === "string") return redactString(value, secretRegistry, Infinity);
  if (Array.isArray(value)) return value.map((item) => redactSecretValues(item, { secretRegistry }));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecretValues(item, { secretRegistry })]));
}
