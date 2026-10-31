import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, readStoredFile } from "./atomic.js";

export const TRANSCRIPT_ARCHIVE_VERSION = 1;
const SEGMENT_NAME = /^(ctx_[A-Za-z0-9-]+)\.(\d{1,15})\.([0-9a-f]{16})\.jsonl$/;
const CONTEXT_ID = /^ctx_[A-Za-z0-9-]+$/;
const CONTENT_DIGEST = /^[0-9a-f]{64}$/;

// A context's raw transcript is append-only on disk as it is in memory. Committed records are
// sealed into immutable, content-addressed JSONL segments (a replacement record carries its
// compaction proof). A checkpoint or audit then stores only the records not yet sealed plus a
// reference to each sealed segment, so its size follows the live projection, not the history.
// File contents kept as source evidence are stored the same way, once per distinct content.
export function createTranscriptArchive({ dir, protect = (value) => value, maxFileBytes = Infinity } = {}) {
  // The checkpoint, which holds the unsealed tail, is rewritten every step; keep that tail small.
  const target = Math.max(1, Math.floor(Math.min(256 * 1024, maxFileBytes / 8)));
  const cursors = new Map();
  const contentDigests = new Map();
  const chains = new Map();
  const serialized = (contextId, action) => {
    const run = (chains.get(contextId) ?? Promise.resolve()).catch(() => {}).then(action);
    chains.set(contextId, run);
    return run.finally(() => { if (chains.get(contextId) === run) chains.delete(contextId); });
  };

  // Writes one segment for records [start, end) unless an identical one is already present.
  async function seal(cursor, state, start, end) {
    const records = state.transcript.slice(start, end);
    let compactionIndex = cursor.compactions, filtered = cursor.filtered;
    const lines = records.map((record) => {
      let line = record;
      if (record?.kind === "replacement") {
        const compaction = state.compactions[compactionIndex++];
        if (compaction?.compactionId !== record.compactionId) throw archiveFailure("CONTEXT_ARCHIVE_INVALID", "A replacement record has no matching compaction proof in commit order.");
        line = { ...record, compaction };
      }
      const raw = JSON.stringify(line), safe = JSON.stringify(protect(line));
      if (safe !== raw) filtered = true;
      return safe;
    });
    const content = lines.join("\n") + "\n";
    const digest = createHash("sha256").update(content).digest("hex");
    const name = state.contextId + "." + sequenceOf(state.contextId, records[0]) + "." + digest.slice(0, 16) + ".jsonl";
    const path = join(dir, name);
    if (!await lstat(path).then((info) => info.isFile(), () => false)) await atomicWriteFile(path, content, { backup: false, maxBytes: maxFileBytes });
    return { segments: [...cursor.segments, { name, records: records.length, compactions: compactionIndex - cursor.compactions, bytes: Buffer.byteLength(content), digest }],
      records: end, compactions: compactionIndex, filtered, lastId: records.at(-1).id };
  }

  async function sealContent(id, content, checked) {
    let digest = contentDigests.get(id), safe;
    if (!digest) { safe = protect(content); digest = createHash("sha256").update(safe).digest("hex"); }
    const path = join(dir, "content", digest + ".txt");
    if (!checked.has(digest) && !await lstat(path).then((info) => info.isFile(), () => false)) await atomicWriteFile(path, safe ?? protect(content), { backup: false, maxBytes: maxFileBytes });
    checked.add(digest);
    contentDigests.set(id, digest);
    return digest;
  }

  async function present(cursor) {
    return (await Promise.all(cursor.segments.map((segment) => lstat(join(dir, segment.name)).then((info) => info.isFile(), () => false)))).every(Boolean);
  }

  // A hydrated state names the segments it came from. Re-sealing along the same boundaries
  // reuses present, unchanged segments and rewrites a missing one or one that a newly known
  // secret would change, so the history on disk is filtered with the current registry.
  async function reopen(state) {
    let cursor = { segments: [], records: 0, compactions: 0, filtered: state.archive?.filtered === true, lastId: undefined };
    for (const segment of Array.isArray(state.archive?.segments) ? state.archive.segments : []) {
      if (!Number.isSafeInteger(segment?.records) || segment.records < 1 || cursor.records + segment.records > state.transcript.length) break;
      cursor = await seal(cursor, state, cursor.records, cursor.records + segment.records);
    }
    return cursor;
  }

  return {
    dir,
    async project(state) {
      if (!archivable(state) || state.archive?.unavailable) return state;
      return serialized(state.contextId, async () => {
        let cursor = cursors.get(state.contextId);
        // Retention may prune an idle session's segments between tasks of one process; the
        // in-memory transcript is authoritative, so reseal rather than reference a missing file.
        if (!cursor || !continues(cursor, state) || !await present(cursor)) cursor = await reopen(state);
        // Seal only full segments; the open tail stays inline until it reaches the target size.
        let start = cursor.records, bytes = 0;
        for (let index = cursor.records; index < state.transcript.length; index++) {
          const size = Buffer.byteLength(JSON.stringify(state.transcript[index])) + 1;
          if (index > start && bytes + size > target) { cursor = await seal(cursor, state, start, index); start = index; bytes = 0; }
          bytes += size;
        }
        if (bytes >= target) cursor = await seal(cursor, state, start, state.transcript.length);
        cursors.set(state.contextId, cursor);
        const { transcript, compactions, archive: _previous, ...rest } = state;
        const projected = { ...rest, transcript: transcript.slice(cursor.records), compactions: compactions.slice(cursor.compactions),
          archive: { version: TRANSCRIPT_ARCHIVE_VERSION, records: cursor.records, compactions: cursor.compactions, filtered: cursor.filtered, segments: cursor.segments } };
        if (cursor.filtered) {
          projected.privacyFiltered = true;
          if (projected.sourceCompleteness !== "legacy-prefix-unavailable") projected.sourceCompleteness = "filtered";
        }
        return projected;
      });
    },
    // Rebuilds the full saved state from its sealed prefix and inline tail. Any missing,
    // altered or inconsistent segment makes the whole prefix unavailable, never partly trusted.
    async hydrate(stored) {
      const ref = stored?.archive;
      if (!ref) return stored;
      if (ref.version !== TRANSCRIPT_ARCHIVE_VERSION || !archivable(stored) || !Array.isArray(ref.segments)) throw unavailable("invalid-reference");
      const transcript = [], compactions = [];
      for (const segment of ref.segments) {
        const match = SEGMENT_NAME.exec(String(segment?.name ?? ""));
        if (!match || match[1] !== stored.contextId || typeof segment.digest !== "string" || !segment.digest.startsWith(match[3])) throw unavailable("invalid-reference");
        let content;
        try { content = await readStoredFile(join(dir, segment.name)); }
        catch (error) { if (error.code === "ENOENT") throw unavailable("missing-segment"); throw error; }
        if (createHash("sha256").update(content).digest("hex") !== segment.digest) throw unavailable("segment-digest-mismatch");
        const lines = content.split("\n");
        if (lines.pop() !== "" || lines.length !== segment.records) throw unavailable("segment-record-count");
        let sealedCompactions = 0;
        for (const line of lines) {
          let parsed;
          try { parsed = JSON.parse(line); } catch { throw unavailable("segment-unreadable"); }
          const { compaction, ...record } = parsed;
          transcript.push(record);
          if (compaction) { compactions.push(compaction); sealedCompactions++; }
        }
        if (sealedCompactions !== segment.compactions) throw unavailable("segment-compaction-count");
      }
      if (transcript.length !== ref.records || compactions.length !== ref.compactions) throw unavailable("reference-count");
      return { ...stored, transcript: [...transcript, ...stored.transcript], compactions: [...compactions, ...stored.compactions] };
    },
    // A file read keeps a digest reference; the content is stored once under that digest.
    async archiveEffects(effects) {
      if (!Array.isArray(effects?.events)) return effects;
      const events = [], checked = new Set();
      for (const event of effects.events) {
        if (event?.type !== "file-read" || typeof event.content !== "string" || typeof event.id !== "string") { events.push(event); continue; }
        const { content, ...rest } = event;
        events.push({ ...rest, contentDigest: await sealContent(event.id, content, checked) });
      }
      return { ...effects, events };
    },
    // Content that is missing or altered is left out, so that read no longer counts as evidence.
    async hydrateEffects(effects) {
      if (!Array.isArray(effects?.events)) return effects;
      const events = [];
      for (const event of effects.events) {
        if (typeof event?.contentDigest !== "string" || event.content !== undefined) { events.push(event); continue; }
        let content;
        if (CONTENT_DIGEST.test(event.contentDigest)) {
          try { content = await readStoredFile(join(dir, "content", event.contentDigest + ".txt")); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        if (content !== undefined && createHash("sha256").update(content).digest("hex") === event.contentDigest) events.push({ ...event, content });
        else events.push({ ...event, contentOmitted: "unavailable" });
      }
      return { ...effects, events };
    },
  };
}

// The stored form of a checkpoint or run record: its main and worker contexts keep only
// their unsealed tails and segment references, and its file reads only content digests.
export async function archiveRunState(archive, value) {
  if (!archive || !value || typeof value !== "object") return value;
  const next = { ...value };
  if (next.contextState) next.contextState = await archive.project(next.contextState);
  if (next.effects) next.effects = await archive.archiveEffects(next.effects);
  if (Array.isArray(next.workerContexts)) {
    const workers = [];
    for (const entry of next.workerContexts) workers.push(entry?.contextState ? { ...entry, contextState: await archive.project(entry.contextState) } : entry);
    next.workerContexts = workers;
  }
  return next;
}

// Older (0.1.9) records hold the whole transcript inline and are returned unchanged.
export async function hydrateRunState(archive, value) {
  if (!archive || !value || typeof value !== "object") return value;
  const next = { ...value };
  if (next.effects) next.effects = await archive.hydrateEffects(next.effects);
  if (next.contextState?.archive) {
    try { next.contextState = await archive.hydrate(next.contextState); }
    catch (error) {
      if (error.code !== "CONTEXT_ARCHIVE_UNAVAILABLE") throw error;
      // The live projection in `messages` is intact; only the sealed history is gone. Resume
      // as a context whose earlier source is explicitly unavailable rather than half-verified.
      next.contextArchive = { status: "unavailable", contextId: next.contextState.contextId, reason: error.reason };
      next.contextState = undefined;
    }
  }
  if (Array.isArray(next.workerContexts)) {
    const workers = [];
    for (const entry of next.workerContexts) {
      if (!entry?.contextState?.archive) { workers.push(entry); continue; }
      try { workers.push({ ...entry, contextState: await archive.hydrate(entry.contextState) }); }
      catch (error) {
        if (error.code !== "CONTEXT_ARCHIVE_UNAVAILABLE") throw error;
        workers.push({ ...entry, contextState: { ...entry.contextState, archive: { ...entry.contextState.archive, unavailable: error.reason } } });
      }
    }
    next.workerContexts = workers;
  }
  return next;
}

function archivable(state) {
  return Boolean(state && typeof state === "object" && CONTEXT_ID.test(state.contextId ?? "") && Array.isArray(state.transcript) && Array.isArray(state.compactions));
}
function continues(cursor, state) {
  return cursor.records <= state.transcript.length && cursor.compactions <= state.compactions.length
    && (cursor.records === 0 || state.transcript[cursor.records - 1]?.id === cursor.lastId);
}
function sequenceOf(contextId, record) {
  const sequence = Number(String(record?.id ?? "").slice(contextId.length + 2));
  if (!String(record?.id ?? "").startsWith(contextId + ":m") || !Number.isSafeInteger(sequence) || sequence < 1) throw archiveFailure("CONTEXT_ARCHIVE_INVALID", "A transcript record has no sequence identity in its context.");
  return sequence;
}
function unavailable(reason) {
  return Object.assign(archiveFailure("CONTEXT_ARCHIVE_UNAVAILABLE", "The sealed transcript history of this context is unavailable (" + reason + ")."), { reason });
}
function archiveFailure(code, message) { return Object.assign(new Error(message), { code }); }
