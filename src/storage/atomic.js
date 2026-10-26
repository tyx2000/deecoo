import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const queues = new Map();

// Cross-process serialization. A lock is reclaimed only when its recorded process is
// gone; age alone never lets a slow writer lose its lock. In-process queuing avoids
// accidental reentrancy races. Callers must not nest a lock on the same path.
export async function withFileLock(path, action, { timeoutMs = 10000, pollMs = 15, orphanGraceMs = 30000 } = {}) {
  const prior = queues.get(path) ?? Promise.resolve();
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const queued = prior.catch(() => {}).then(() => pending);
  queues.set(path, queued);
  await prior.catch(() => {});
  const lockPath = path + ".lock";
  const token = randomUUID();
  let acquired = false;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + timeoutMs;
    while (!acquired) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        acquired = true;
        await atomicWriteFile(lockPath + "/owner.json", JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { backup: false });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const info = await lstat(lockPath).catch(() => undefined);
        if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error("Unsafe storage lock: " + lockPath);
        let owner;
        try { owner = JSON.parse(await readStoredText(lockPath + "/owner.json")); } catch { /* interrupted lock creation */ }
        if ((owner?.pid && !processAlive(owner.pid)) || (!owner && info && Date.now() - info.mtimeMs > orphanGraceMs)) {
          await withFileLock(path + ".reclaim", async () => {
            let latest;
            try { latest = JSON.parse(await readStoredText(lockPath + "/owner.json")); } catch { /* orphan */ }
            const latestInfo = await lstat(lockPath).catch(() => undefined);
            if (!latestInfo || (latest?.pid && processAlive(latest.pid)) || (!latest && Date.now() - latestInfo.mtimeMs <= orphanGraceMs)) return;
            const abandoned = lockPath + ".abandoned-" + randomUUID();
            try { await rename(lockPath, abandoned); await rm(abandoned, { recursive: true, force: true }); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
          }, { timeoutMs, pollMs, orphanGraceMs });
          continue;
        }
        if (Date.now() >= deadline) throw Object.assign(new Error("Storage lock timed out: " + path), { code: "STORAGE_LOCK_TIMEOUT" });
        await delay(pollMs);
      }
    }
    return await action();
  } finally {
    if (acquired) {
      try {
        const owner = JSON.parse(await readStoredText(lockPath + "/owner.json"));
        if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
      } catch { /* never delete another owner's lock */ }
    }
    finish();
    if (queues.get(path) === queued) queues.delete(path);
  }
}

export async function atomicWriteFile(path, content, { backup = true, mode = 0o600, maxBytes = Infinity } = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (bytes.length > maxBytes) throw Object.assign(new Error("Storage capacity exceeded."), { code: "STORAGE_CAPACITY" });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertRegularOrMissing(path);
  const temporary = path + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (backup) {
      try { await atomicWriteFile(path + ".bak", await readStoredBytes(path), { backup: false, mode }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await assertRegularOrMissing(path);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
}

export async function readStoredFile(path, { encoding = "utf8", ...options } = {}) {
  return withFileLock(path, async () => { const bytes = await readStoredBytes(path); return encoding ? bytes.toString(encoding) : bytes; }, options);
}

export async function readJsonFile(path, options = {}) {
  return withFileLock(path, () => readJsonUnlocked(path, options), options);
}

export async function writeJsonFile(path, value, options = {}) {
  return withFileLock(path, async () => {
    const prepared = prepareJson(value, options);
    await atomicWriteFile(path, JSON.stringify(prepared, null, 2) + "\n", options);
    return prepared;
  }, options);
}

export async function updateJsonFile(path, updater, options = {}) {
  return withFileLock(path, async () => {
    const current = await readJsonUnlocked(path, options);
    const next = await updater(current);
    if (next === undefined) return current;
    const prepared = prepareJson(next, options);
    await atomicWriteFile(path, JSON.stringify(prepared, null, 2) + "\n", options);
    return prepared;
  }, options);
}

export async function removeStoredFile(path, { backups = true, ...options } = {}) {
  return withFileLock(path, async () => {
    await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (backups) await unlink(path + ".bak").catch((error) => { if (error.code !== "ENOENT") throw error; });
  }, options);
}

// A true append: only the new line is written, so a long run costs O(event) per event rather
// than rewriting the whole journal. An interrupted final append is repaired first.
export async function appendJsonEvent(path, event, { maxBytes = 8 * 1024 * 1024, mode = 0o600, ...options } = {}) {
  return withFileLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await assertRegularOrMissing(path);
    const line = Buffer.from(JSON.stringify(event) + "\n", "utf8");
    const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw Object.assign(new Error("Storage path is not a regular file: " + path), { code: "STORAGE_UNSAFE_PATH" });
      const size = await repairInterruptedTail(handle, info.size);
      if (size + line.length > maxBytes) throw Object.assign(new Error("Storage capacity exceeded."), { code: "STORAGE_CAPACITY" });
      await handle.write(line, 0, line.length, size);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return event;
  }, options);
}

// Keep a complete final record that only lacks its newline; drop a partial one.
async function repairInterruptedTail(handle, size) {
  if (!size || (await readRange(handle, size - 1, 1)).toString("utf8") === "\n") return size;
  let start = size;
  let boundary = -1;
  while (start > 0 && boundary < 0) {
    start = Math.max(0, start - 64 * 1024);
    const chunk = await readRange(handle, start, size - start);
    const index = chunk.lastIndexOf(10);
    if (index >= 0) boundary = start + index;
  }
  const tail = (await readRange(handle, boundary + 1, size - boundary - 1)).toString("utf8");
  try {
    JSON.parse(tail);
    await handle.write("\n", size);
    return size + 1;
  } catch {
    await handle.truncate(boundary + 1);
    return boundary + 1;
  }
}

async function readRange(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// One damaged line does not hide the rest of the journal. Its events are skipped and counted;
// run reconciliation then sees the missing sequence numbers as a history gap.
export async function readJsonEvents(path) {
  return withFileLock(path, async () => {
    await assertRegularOrMissing(path);
    let text;
    try { text = await readStoredText(path); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const lines = text.split("\n");
    const tail = lines.pop();
    if (tail) { try { JSON.parse(tail); lines.push(tail); } catch { /* interrupted trailing record has unknown outcome */ } }
    const events = [];
    let corruptEntries = 0;
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { corruptEntries += 1; }
    }
    Object.defineProperty(events, "corruptEntries", { value: corruptEntries, enumerable: false });
    return events;
  });
}

async function readJsonUnlocked(path, { fallback, recover = true, ...options } = {}) {
  await assertRegularOrMissing(path);
  let raw;
  try { raw = await readStoredText(path); } catch (error) { if (error.code === "ENOENT") return cloneFallback(fallback); throw error; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) {
    if (!recover) throw Object.assign(error, { code: "STORAGE_CORRUPT" });
    const quarantine = path + ".corrupt-" + Date.now() + "-" + randomUUID();
    await rename(path, quarantine);
    try {
      await assertRegularOrMissing(path + ".bak");
      parsed = JSON.parse(await readStoredText(path + ".bak"));
      parsed = prepareJson(parsed, options);
      await atomicWriteFile(path, JSON.stringify(parsed, null, 2) + "\n", { backup: false });
      options.onRecovery?.({ path, quarantine, recovered: true });
      return parsed;
    } catch (backupError) {
      if (backupError.code !== "ENOENT" && !(backupError instanceof SyntaxError)) throw backupError;
      options.onRecovery?.({ path, quarantine, recovered: false });
      return cloneFallback(fallback);
    }
  }
  return prepareJson(parsed, options);
}

async function readStoredBytes(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!(await handle.stat()).isFile()) throw Object.assign(new Error("Storage source is not a regular file."), { code: "STORAGE_UNSAFE_PATH" }); return await handle.readFile(); }
  finally { await handle.close(); }
}
async function readStoredText(path) { return (await readStoredBytes(path)).toString("utf8"); }

function prepareJson(value, { migrate, validate } = {}) {
  const prepared = migrate ? migrate(value) : value;
  if (validate && !validate(prepared)) throw Object.assign(new Error("Unsupported or invalid storage schema."), { code: "STORAGE_SCHEMA" });
  return prepared;
}
function cloneFallback(fallback) { return typeof fallback === "function" ? fallback() : fallback === undefined ? undefined : structuredClone(fallback); }
async function assertRegularOrMissing(path) {
  const info = await lstat(path).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw Object.assign(new Error("Storage path is not a regular file: " + path), { code: "STORAGE_UNSAFE_PATH" });
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }
async function syncDirectory(path) { const handle = await open(path, "r"); try { await handle.sync(); } catch (error) { if (!["EINVAL", "ENOTSUP"].includes(error.code)) throw error; } finally { await handle.close(); } }
