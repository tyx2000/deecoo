import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJsonFile, removeStoredFile, withFileLock, writeJsonFile } from "./atomic.js";
import { safeStorageId, storageInventory, storagePolicy } from "./governance.js";
import { redact } from "../observability/audit.js";

const REFERENCE = /^out_[A-Za-z0-9_-]{32}$/;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_QUERY_BYTES = 4096;
const MAX_RESULTS = 500;
const SOURCE_KEYS = new Set(["tool", "invocationId", "workerId", "step"]);

// References name immutable, secret-filtered output; they never name a caller's
// path. Shared durable directories serialize quota checks with the final write.
export async function createToolOutputStore({ stateDir, owner, privacyMode = "standard", retentionDays, maxBytes, maxFileBytes, secretRegistry } = {}) {
  const identity = Object.freeze(validateOwner(owner));
  let policy;
  try { policy = storagePolicy({ privacyMode, retentionDays, maxBytes, maxFileBytes }); }
  catch { throw failure("OUTPUT_INVALID_CONFIG", "Tool output storage policy is invalid."); }
  if (policy.retentionDays !== Infinity && !Number.isFinite(new Date(Date.now() + policy.retentionDays * 86400000).getTime())) throw failure("OUTPUT_INVALID_CONFIG", "Tool output retention is outside the supported date range.");
  const durable = policy.privacyMode === "standard";
  const memory = new Map();
  let memoryBytes = 0;
  let disposed = false;
  let root;
  let rootIdentity;
  const requestedRoot = stateDir === undefined ? undefined : resolve(stateDir);
  const registries = new Map();
  const combinedRegistry = { redact(text) {
    for (const apply of registries.values()) {
      text = apply(text);
      if (typeof text !== "string") throw failure("OUTPUT_INVALID_SECRET_REGISTRY", "A secret registry must return filtered text.");
    }
    return text;
  } };
  const filter = (text) => redact(text, { secretRegistry: combinedRegistry, maxTextChars: Infinity });
  function addSecretRegistry(registry) {
    assertActive();
    if (!registry || typeof registry !== "object" || Array.isArray(registry) || typeof registry.redact !== "function") throw failure("OUTPUT_INVALID_SECRET_REGISTRY", "A secret registry must provide a redact function.");
    // Capture the existing method, retaining both its live rules and all older
    // registries when a resumed task installs its newly collected secrets.
    if (!registries.has(registry)) registries.set(registry, registry.redact.bind(registry));
  }
  if (secretRegistry !== undefined) addSecretRegistry(secretRegistry);

  if (durable) {
    if (!requestedRoot) throw failure("OUTPUT_INVALID_CONFIG", "A managed stateDir is required for durable tool output.");
    await storageOperation(async () => {
      const existing = await lstat(requestedRoot).catch(missing);
      if (existing?.isSymbolicLink() || existing && !existing.isDirectory()) throw unsafeState();
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      root = await realpath(requestedRoot);
      const info = await lstat(root);
      if ((info.mode & 0o077) !== 0) throw unsafeState();
      rootIdentity = { dev: info.dev, ino: info.ino };
    });
  }

  function assertActive() { if (disposed) throw failure("OUTPUT_STORE_DISPOSED", "This task's output store has been disposed."); }
  async function assertRoot() {
    const requested = await lstat(requestedRoot);
    const current = await lstat(root);
    if (requested.isSymbolicLink() || !current.isDirectory() || current.isSymbolicLink() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || (current.mode & 0o077) !== 0 || await realpath(requestedRoot) !== root) throw unsafeState();
  }
  const pathFor = (outputRef) => join(root, outputRef + ".json");
  async function load(outputRef) {
    assertActive();
    validateReference(outputRef);
    let record;
    if (durable) {
      record = await storageOperation(async () => {
        await assertRoot();
        const path = pathFor(outputRef);
        const info = await lstat(path).catch(missing);
        if (!info) return undefined;
        if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw unsafeState();
        if (info.size > policy.maxFileBytes) throw failure("OUTPUT_FILE_LIMIT", "Stored output exceeds this store's record size limit.");
        return readJsonFile(path, { recover: false });
      });
    } else record = memory.get(outputRef)?.record;
    assertActive();
    if (!record) throw failure("OUTPUT_NOT_FOUND", "The output reference is missing or has been pruned.");
    validateRecord(record, outputRef);
    if (record.owner.sessionId !== identity.sessionId || record.owner.runId !== identity.runId) throw failure("OUTPUT_OWNER_MISMATCH", "This output belongs to a different session or run.");
    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now()) throw failure("OUTPUT_EXPIRED", "This output reference has expired.");
    if (filter(record.text) !== record.text) throw failure("OUTPUT_REDACTION_CHANGED", "Secret filtering changed after this output was saved; the old reference cannot be returned.");
    return record;
  }
  async function purgeExpired() {
    if (!durable) {
      for (const [ref, entry] of memory) if (isExpired(entry.record)) { memoryBytes -= entry.bytes; memory.delete(ref); }
      return;
    }
    const inventory = await storageInventory(root);
    for (const file of inventory.files) {
      if (!/^(out_[A-Za-z0-9_-]{32})\.json$/.test(file.relativePath) || file.bytes > policy.maxFileBytes) continue;
      try {
        const record = await readJsonFile(file.path, { recover: false });
        validateRecord(record, file.relativePath.slice(0, -5));
        if (isExpired(record)) await removeStoredFile(file.path);
      } catch (error) {
        // Corruption/foreign files still consume quota; never silently delete
        // them or replace them with another body under a valid reference.
        if (!["OUTPUT_CORRUPT", "STORAGE_CORRUPT", "STORAGE_SCHEMA"].includes(error.code)) throw error;
      }
    }
  }

  return Object.freeze({
    owner: identity,
    privacyMode: policy.privacyMode,
    addSecretRegistry,
    async save(text, { source } = {}) {
      assertActive();
      if (typeof text !== "string" || Buffer.from(text, "utf8").toString("utf8") !== text) throw failure("OUTPUT_INVALID_TEXT", "Tool output must be valid UTF-8 text.");
      const safeSource = normalizeSource(source);
      for (const key of Object.keys(safeSource ?? {})) if (typeof safeSource[key] === "string" && filter(safeSource[key]) !== safeSource[key]) safeSource[key] = "redacted";
      const filtered = filter(text);
      const bytes = Buffer.from(filtered, "utf8");
      const now = Date.now();
      const outputRef = "out_" + randomBytes(24).toString("base64url");
      const expiresAt = policy.retentionDays === Infinity ? null : new Date(now + policy.retentionDays * 86400000).toISOString();
      const record = { schemaVersion: 1, outputRef, owner: identity, createdAt: new Date(now).toISOString(), expiresAt,
        ...(safeSource === undefined ? {} : { source: safeSource }), totalBytes: bytes.length, hash: digest(bytes), text: filtered };
      const recordBytes = Buffer.byteLength(JSON.stringify(record, null, 2) + "\n", "utf8");
      if (recordBytes > policy.maxFileBytes) throw failure("OUTPUT_FILE_LIMIT", "Tool output exceeds the configured record size limit; no output was saved.");
      if (recordBytes > policy.maxBytes) throw capacity();
      const persist = async () => {
        assertActive();
        await purgeExpired();
        const used = durable ? (await storageInventory(root)).totalBytes : memoryBytes;
        if (used + recordBytes > policy.maxBytes) throw capacity();
        assertActive();
        if (durable) {
          const path = pathFor(outputRef);
          if (await lstat(path).catch(missing)) throw failure("OUTPUT_REFERENCE_COLLISION", "Output reference allocation conflicted; retry saving.");
          await writeJsonFile(path, record, { backup: false, maxBytes: policy.maxFileBytes, mode: 0o600 });
        } else { memory.set(outputRef, { record, bytes: recordBytes }); memoryBytes += recordBytes; }
        return { outputRef, totalBytes: record.totalBytes, hash: record.hash, expiresAt };
      };
      if (!durable) return persist();
      return storageOperation(async () => {
        await assertRoot();
        return withFileLock(join(root, ".tool-output-transaction"), async () => { await assertRoot(); return persist(); });
      });
    },
    async read(args = {}) {
      const { outputRef, startLine, endLine } = args;
      const max = integer(args.maxBytes ?? 16384, "maxBytes", 1, MAX_READ_BYTES);
      const byLine = startLine !== undefined || endLine !== undefined;
      if (byLine && args.offset !== undefined) throw invalidRange("Line ranges cannot be combined with offset.");
      const firstLine = byLine ? integer(startLine ?? 1, "startLine", 1) : undefined;
      const lastLine = endLine === undefined ? undefined : integer(endLine, "endLine", 1);
      if (lastLine !== undefined && lastLine < firstLine) throw invalidRange("endLine must be >= startLine.");
      const record = await load(outputRef);
      const bytes = Buffer.from(record.text, "utf8");
      let offset = byLine ? 0 : integer(args.offset ?? 0, "offset", 0);
      let rangeEnd = bytes.length;
      if (offset > bytes.length) throw invalidRange("offset is beyond this output's byte length.");
      if (byLine) {
        const starts = lineStarts(bytes);
        offset = starts[firstLine - 1] ?? bytes.length;
        rangeEnd = lastLine === undefined ? bytes.length : starts[lastLine] ?? bytes.length;
      }
      const nextOffset = Math.min(offset + max, rangeEnd);
      const chunk = bytes.subarray(offset, nextOffset);
      let text = null;
      try { text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(chunk); } catch { /* arbitrary byte cursors can split code points */ }
      const eof = nextOffset === bytes.length;
      const truncated = nextOffset < rangeEnd;
      return { outputRef, text, base64: chunk.toString("base64"), encoding: text === null ? "base64" : "utf8",
        offset, nextOffset, rangeStartOffset: offset, rangeEndOffset: rangeEnd, totalBytes: record.totalBytes, hash: record.hash, expiresAt: record.expiresAt,
        eof, truncated, rangeComplete: !truncated,
        ...(byLine ? { startLine: firstLine, endLine: lineAt(bytes, nextOffset, { exclusive: true }), nextStartLine: nextOffset < bytes.length ? lineAt(bytes, nextOffset) : undefined } : {}) };
    },
    async search({ outputRef, query, maxResults = 50 } = {}) {
      if (typeof query !== "string" || !query || Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES || Buffer.from(query, "utf8").toString("utf8") !== query) throw failure("OUTPUT_INVALID_QUERY", "query must be nonempty UTF-8 literal text of at most 4096 bytes.");
      const limit = integer(maxResults, "maxResults", 1, MAX_RESULTS);
      const record = await load(outputRef);
      const matches = [];
      let cursor = 0, byteOffset = 0, line = 1, lineStart = 0, truncated = false;
      while (cursor <= record.text.length) {
        const index = record.text.indexOf(query, cursor);
        if (index < 0) break;
        if (matches.length >= limit) { truncated = true; break; }
        const prefix = record.text.slice(cursor, index);
        byteOffset += Buffer.byteLength(prefix, "utf8");
        for (let newline = record.text.indexOf("\n", cursor); newline >= 0 && newline < index; newline = record.text.indexOf("\n", newline + 1)) { line++; lineStart = newline + 1; }
        const end = record.text.indexOf("\n", index);
        let previewStart = Math.max(lineStart, index - 120);
        if (isLowSurrogate(record.text.charCodeAt(previewStart))) previewStart++;
        let previewEnd = Math.min(end < 0 ? record.text.length : end, previewStart + 300);
        if (isLowSurrogate(record.text.charCodeAt(previewEnd))) previewEnd--;
        matches.push({ line, column: index - lineStart + 1, offset: byteOffset, matchBytes: Buffer.byteLength(query, "utf8"),
          preview: record.text.slice(previewStart, previewEnd).replace(/\r$/, ""), previewStartColumn: previewStart - lineStart + 1,
          previewTruncated: previewStart > lineStart || (end < 0 ? record.text.length : end) > previewEnd });
        // Non-overlapping literal occurrences. Account for newlines in a match
        // too, so a multiline query cannot shift later match coordinates.
        for (let newline = query.indexOf("\n"); newline >= 0; newline = query.indexOf("\n", newline + 1)) { line++; lineStart = index + newline + 1; }
        byteOffset += Buffer.byteLength(query, "utf8");
        cursor = index + query.length;
      }
      return { outputRef, query, matches, truncated, totalBytes: record.totalBytes, hash: record.hash };
    },
    dispose() { disposed = true; memory.clear(); memoryBytes = 0; registries.clear(); },
  });
}

function validateOwner(owner) {
  try { return { sessionId: safeStorageId(owner?.sessionId, "session id"), runId: safeStorageId(owner?.runId, "run id") }; }
  catch { throw failure("OUTPUT_INVALID_OWNER", "Tool output requires valid session and run identities."); }
}
function normalizeSource(source) {
  if (source === undefined) return undefined;
  if (typeof source === "string") source = { tool: source };
  if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).some((key) => !SOURCE_KEYS.has(key))) throw failure("OUTPUT_INVALID_SOURCE", "Output source accepts only tool, invocationId, workerId and step metadata.");
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key === "step") { if (!Number.isSafeInteger(value) || value < 0) throw failure("OUTPUT_INVALID_SOURCE", "Output source step must be a nonnegative integer."); }
    else if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value)) throw failure("OUTPUT_INVALID_SOURCE", "Output source fields must be bounded identifiers.");
    out[key] = value;
  }
  return out;
}
function validateReference(ref) { if (typeof ref !== "string" || !REFERENCE.test(ref)) throw failure("OUTPUT_INVALID_REFERENCE", "outputRef must be an opaque tool output reference."); }
function validateRecord(record, ref) {
  if (!record || typeof record !== "object" || record.schemaVersion !== 1 || record.outputRef !== ref || !REFERENCE.test(record.outputRef) || typeof record.text !== "string" || !record.owner
    || !Number.isSafeInteger(record.totalBytes) || record.totalBytes < 0 || !/^[a-f0-9]{64}$/.test(record.hash ?? "") || !Number.isFinite(Date.parse(record.createdAt))
    || record.expiresAt !== null && !Number.isFinite(Date.parse(record.expiresAt))) throw corrupt();
  try { validateOwner(record.owner); normalizeSource(record.source); } catch { throw corrupt(); }
  const bytes = Buffer.from(record.text, "utf8");
  if (bytes.toString("utf8") !== record.text || bytes.length !== record.totalBytes || digest(bytes) !== record.hash) throw corrupt();
}
function lineStarts(bytes) { const starts = [0]; for (let index = bytes.indexOf(10); index >= 0; index = bytes.indexOf(10, index + 1)) if (index + 1 < bytes.length) starts.push(index + 1); return starts; }
function lineAt(bytes, offset, { exclusive = false } = {}) { if (exclusive && offset === 0) return 0; let line = 1; const end = exclusive ? offset - 1 : offset; for (let index = bytes.indexOf(10); index >= 0 && index < end; index = bytes.indexOf(10, index + 1)) line++; return line; }
function integer(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidRange(name + " must be an integer from " + minimum + " to " + maximum + "."); return value; }
function isLowSurrogate(code) { return code >= 0xdc00 && code <= 0xdfff; }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function isExpired(record) { return record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now(); }
function missing(error) { if (error.code === "ENOENT") return undefined; throw error; }
function failure(code, message, cause) { return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code }); }
function invalidRange(message) { return failure("OUTPUT_INVALID_RANGE", message); }
function corrupt() { return failure("OUTPUT_CORRUPT", "Stored output is corrupt or has an unsupported schema; no content was returned."); }
function capacity() { return failure("OUTPUT_CAPACITY", "Tool output storage capacity is exhausted; no new output was saved."); }
function unsafeState() { return failure("OUTPUT_UNSAFE_STATE", "The managed tool output storage path is unsafe."); }
async function storageOperation(action) {
  try { return await action(); }
  catch (error) {
    if (String(error.code ?? "").startsWith("OUTPUT_")) throw error;
    if (["STORAGE_CORRUPT", "STORAGE_SCHEMA"].includes(error.code) || error instanceof SyntaxError) throw corrupt();
    if (["STORAGE_UNSAFE_PATH", "ELOOP"].includes(error.code)) throw unsafeState();
    if (error.code === "STORAGE_CAPACITY") throw capacity();
    throw failure("OUTPUT_STORAGE_UNAVAILABLE", "Managed tool output storage is unavailable.", error);
  }
}
