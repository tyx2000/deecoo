import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { withFileLock } from "./atomic.js";

export function storagePolicy(options = {}) {
  const privacyMode = options.privacyMode ?? process.env.DEECOO_PRIVACY_MODE ?? "standard";
  if (!["standard", "redacted", "ephemeral"].includes(privacyMode)) throw new Error("privacyMode must be standard, redacted, or ephemeral");
  return { privacyMode,
    retentionDays: positiveOrInfinity(options.retentionDays, 90),
    maxBytes: positiveOrInfinity(options.maxBytes, 128 * 1024 * 1024),
    maxFileBytes: positiveOrInfinity(options.maxFileBytes, 8 * 1024 * 1024),
    durableToolEvents: options.durableToolEvents === true };
}

export function canPersist(store) { return store?.storagePolicy?.privacyMode !== "ephemeral"; }

// Call after writes or explicitly from storage management. No symlinks are
// traversed. Scope is the selected project; global memory is governed separately.
export async function pruneStorage(root, policy = {}, { now = Date.now(), dryRun = false } = {}) {
  const selected = storagePolicy(policy);
  return withFileLock(join(root, ".retention"), async () => {
    const files = await inventory(root);
    const cutoff = now - selected.retentionDays * 86400000;
    const protectedSessions = await activeOwners(root);
    const removed = [];
    let bytes = files.reduce((total, file) => total + file.bytes, 0);
    for (const file of files.sort((a, b) => a.modifiedAt - b.modifiedAt || a.path.localeCompare(b.path))) {
      if (file.modifiedAt >= cutoff && bytes <= selected.maxBytes) continue;
      // Active writers hold *.lock directories. Skip that record until their
      // transaction ends; a later sweep can safely prune it.
      const parts = file.relativePath.split(sep);
      if (protectedSessions.some((id) => parts.some((part) => part === id || part.startsWith(id + ".")))) continue;
      const primary = file.path.replace(/\.[0-9a-f-]{36}\.tmp$/, "").replace(/\.bak$/, "").replace(/\.corrupt-.+$/, "");
      if (await lstat(primary + ".lock").catch(() => undefined) || await lstat(primary + ".operation.lock").catch(() => undefined)) continue;
      if (!dryRun) await rm(file.path, { force: true });
      bytes -= file.bytes;
      removed.push({ path: file.path, bytes: file.bytes, reason: file.modifiedAt < cutoff ? "expired" : "capacity" });
    }
    return { root, dryRun, removed, bytesBefore: files.reduce((sum, file) => sum + file.bytes, 0), bytesAfter: bytes };
  });
}

export async function storageInventory(root) {
  const files = await inventory(root);
  return { root, files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

export function safeStorageId(id, label = "storage id") {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(String(id ?? ""))) throw new Error("Invalid " + label + ".");
  return String(id);
}
export function assertStorageChild(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === ".." || rel.startsWith(".." + sep)) throw new Error("Storage target must be a child of its root.");
  return resolve(path);
}
async function inventory(root, current = root, files = []) {
  const entries = await readdir(current, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  for (const entry of entries) {
    if (entry.name.endsWith(".lock") || entry.name === ".retention") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) await inventory(root, path, files);
    else if (entry.isFile()) {
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && !info.isSymbolicLink()) files.push({ path, relativePath: relative(root, path), bytes: info.size, modifiedAt: info.mtimeMs });
    }
  }
  return files;
}
async function activeOwners(root) {
  const ids = [];
  for (const entry of await readdir(root).catch(() => [])) {
    if (!entry.endsWith(".owner.json")) continue;
    const path = join(root, entry);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    try {
      const owner = JSON.parse(await readFile(path, "utf8"));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) continue;
      try { process.kill(owner.pid, 0); ids.push(entry.slice(0, -".owner.json".length)); } catch (error) { if (error.code !== "ESRCH") ids.push(entry.slice(0, -".owner.json".length)); }
    } catch { /* corrupt owner is handled by the owning store */ }
  }
  return ids;
}

function positiveOrInfinity(value, fallback) {
  if (value === undefined) return fallback;
  if (value === Infinity || value === "Infinity") return Infinity;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Storage limits must be nonnegative numbers.");
  return number;
}
