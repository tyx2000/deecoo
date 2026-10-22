import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { assertSafePath, assertWorkspaceWriteParent, isSensitivePath, isExcludedWorkspacePath } from "../tools/pathPolicy.js";
import { createContextFileAccess } from "../context/fileAccess.js";
import { readJsonFile, writeJsonFile, updateJsonFile, withFileLock } from "../storage/atomic.js";
import { unifiedDiff } from "../tools/textDiff.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => a?.digest === b?.digest && a?.kind === b?.kind;
const lines = (value) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// A baseline contains the user's dirty tree, never a guessed Git revision.
export async function createChangeSet({ cwd, stateDir, task = "", id = randomUUID(), maxFiles = 10000, maxBytes = 64 * 1024 * 1024, persist = true, excludeRoots = [] } = {}) {
  const workspace = await realpath(resolve(cwd));
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid change-set ID");
  const directory = resolve(stateDir ?? join(workspace, ".deecoo", "changes"));
  const excluded = (await Promise.all([directory, ...excludeRoots].map(canonicalStoragePath))).map((path) => relative(workspace, path)).filter((path) => path && path !== ".." && !path.startsWith("../"));
  const file = join(directory, id + ".json");
  let volatileState;
  const save = async (value) => { if (persist) await writeJsonFile(file, value); else volatileState = structuredClone(value); };
  const lock = (action) => persist ? withFileLock(file + ".operation", action) : action();
  const access = await createContextFileAccess(workspace);
  if (directory === workspace || directory.startsWith(workspace + "/")) await assertWorkspaceWriteParent(workspace, async () => workspace, file);
  const snapshot = async () => {
    const entries = Object.create(null);
    let bytes = 0, count = 0;
    const walk = async (path = ".", depth = 0) => {
      if (depth > 64) throw new Error("Change snapshot depth limit exceeded");
      for (const item of await access.readDirectory(path)) {
        const name = path === "." ? item.name : path + "/" + item.name;
        if (excluded.some((path) => name === path || name.startsWith(path + "/"))) continue;
        if (name === ".deecoo" || name.startsWith(".deecoo/") || isExcludedWorkspacePath(name) || isSensitivePath(name)) continue;
        if (++count > maxFiles) throw new Error("Change snapshot file limit exceeded; configure a narrower workspace or larger limit");
        if (item.isDirectory()) { await walk(name, depth + 1); continue; }
        const entry = await readEntry(name);
        bytes += entry?.data ? Buffer.byteLength(entry.data, "base64") : 0;
        if (bytes > maxBytes) throw new Error("Change snapshot byte limit exceeded");
        if (entry) entries[name] = entry;
      }
    };
    await walk();
    return entries;
  };
  async function readEntry(path) {
    const full = assertSafePath(workspace, path);
    let info;
    try { info = await lstat(full); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    if (info.isSymbolicLink()) {
      const target = await readlink(full);
      return { kind: "symlink", target, digest: hash("link:" + target) };
    }
    if (!info.isFile()) return { kind: "special", digest: "special" };
    if (info.size > maxBytes) throw new Error("Change snapshot file exceeds byte limit: " + path);
    // Validate all parents, then pin the actual regular file without following a final link.
    await access.readDirectory(dirname(path));
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev) throw new Error("File changed while sampling " + path);
      const data = await handle.readFile();
      return { kind: "file", data: data.toString("base64"), mode: current.mode & 0o777,
        digest: hash(data) + ":" + (current.mode & 0o777), binary: data.includes(0) };
    } finally { await handle.close(); }
  }
  const load = async () => {
    const value = persist ? await readJsonFile(file, { fallback: undefined }) : structuredClone(volatileState);
    if (!value || value.version !== 1 || value.workspace !== workspace) throw new Error("Missing or incompatible change set " + id);
    return value;
  };
  const changedPaths = (state) => [...new Set([...Object.keys(state.before), ...Object.keys(state.after ?? {})])].filter((path) => !same(state.before[path], state.after?.[path])).sort();
  const text = (entry) => entry ? Buffer.from(entry.data ?? "", "base64").toString("utf8") : "";
  return {
    id, path: file,
    async begin() {
      const before = await snapshot();
      const state = { version: 1, id, workspace, task, createdAt: new Date().toISOString(), before, after: before, decisions: [] };
      if (persist) {
        await mkdir(directory, { recursive: true });
        await updateJsonFile(join(directory, "index.json"), (index = { version: 1, changes: [] }) => ({ ...index,
          changes: [...index.changes.filter((item) => item.id !== id), { id, workspace, task, createdAt: state.createdAt }] }));
      }
      await save(state); return { id, files: Object.keys(before).length };
    },
    async capture() {
      const after = await snapshot();
      return lock(async () => { const state = await load(); state.after = after; state.updatedAt = new Date().toISOString(); await save(state); return { id, paths: changedPaths(state) }; });
    },
    async inspect({ path } = {}) {
      const state = await load();
      const paths = path ? changedPaths(state).filter((item) => item === path) : changedPaths(state);
      const files = [];
      for (const name of paths) {
        const before = state.before[name], after = state.after[name], current = await readEntry(name);
        const textual = (!before || before.kind === "file" && !before.binary) && (!after || after.kind === "file" && !after.binary);
        files.push({ path: name, kind: !before ? "created" : !after ? "deleted" : "modified", drifted: !same(current, after),
          beforeHash: before?.digest, afterHash: after?.digest,
          ...(textual ? { diff: unifiedDiff(text(before), text(after), name), hunks: lineHunks(text(before), text(after)) } : { binary: true }) });
      }
      return { id, task: state.task, workspace, persistence: persist ? "durable" : "in-memory", files, decisions: state.decisions };
    },
    async decide({ action, path, hunkIds } = {}) {
      if (!["accept", "undo"].includes(action)) throw new Error("Action must be accept or undo");
      if (hunkIds && !path) throw new Error("Hunk decisions require one file path");
      return lock(async () => {
        const state = await load(); const outcomes = [];
        for (const name of changedPaths(state).filter((item) => !path || item === path)) {
          const before = state.before[name], after = state.after[name];
          try {
            const current = await readEntry(name);
            if ([before, after, current].some((entry) => entry && entry.kind !== "file")) throw new Error("Symbolic links and special files require manual conflict resolution");
            const binary = [before, after, current].some((entry) => entry?.binary);
            if (binary && hunkIds) throw new Error("Binary changes require a whole-file decision");
            const allHunks = lineHunks(text(before), text(after));
            const selected = hunkIds ? allHunks.filter((hunk) => hunkIds.includes(hunk.id)) : allHunks;
            if (hunkIds?.some((item) => !allHunks.some((hunk) => hunk.id === item))) throw new Error("Unknown or stale hunk ID");
            if (action === "accept") {
              if (!same(current, after)) throw new Error("File changed after task completion; inspect drift before accepting");
              if (!hunkIds) { if (after) state.before[name] = after; else delete state.before[name]; }
              else state.before[name] = textEntry(applyHunks(text(before), selected, false), before?.mode ?? after?.mode);
            } else {
              if (binary && !same(current, after)) throw new Error("Binary file changed after task completion");
              const target = binary ? Buffer.from(before?.data ?? "", "base64") : !hunkIds && same(current, after) ? text(before) : applyHunks(text(current), selected, true);
              // Revalidate immediately before mutation; preserve overlapping user changes.
              if (!same(await readEntry(name), current)) throw new Error("File changed before undo");
              if (!before && !hunkIds && target.length === 0) { await access.readDirectory(dirname(name)); await unlink(assertSafePath(workspace, name)); }
              else { await access.writeTextAtomically(name, target); await chmod(assertSafePath(workspace, name), before?.mode ?? after?.mode ?? 0o644); }
              if (!hunkIds) { if (before) state.after[name] = before; else delete state.after[name]; }
              else state.after[name] = textEntry(applyHunks(text(after), selected, true), after?.mode ?? before?.mode);
            }
            const outcome = { action, path: name, hunkIds: selected.map((hunk) => hunk.id), at: new Date().toISOString(), ok: true };
            outcomes.push(outcome); state.decisions.push(outcome);
          } catch (error) { outcomes.push({ action, path: name, ok: false, code: "CHANGE_CONFLICT", error: error.message }); }
        }
        await save(state);
        return { id, ok: outcomes.every((outcome) => outcome.ok), outcomes };
      });
    },
    async exportPatch(options) {
      const report = await this.inspect(options);
      if (report.files.some((file) => file.binary)) throw new Error("Patch export requires regular text files; binary/symlink changes are reported separately");
      return { id, patch: report.files.map((file) => file.diff).join("\n") + (report.files.length ? "\n" : "") };
    },
  };
}

export async function listChangeSets({ stateDir, cwd } = {}) {
  const directory = resolve(stateDir ?? join(cwd, ".deecoo", "changes"));
  const index = await readJsonFile(join(directory, "index.json"), { fallback: { version: 1, changes: [] } });
  const workspace = cwd ? await realpath(cwd) : undefined;
  return index.changes.filter((item) => !workspace || item.workspace === workspace).reverse();
}

async function canonicalStoragePath(path) {
  path = resolve(path);
  try { return await realpath(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; return join(await canonicalStoragePath(dirname(path)), basename(path)); }
}

function textEntry(value, mode = 0o644) { const data = Buffer.from(value); return { kind: "file", data: data.toString("base64"), mode, digest: hash(data) + ":" + mode, binary: false }; }

// Bounded LCS creates independent edit blocks; all line endings are retained.
export function lineHunks(beforeText, afterText) {
  const a = lines(beforeText), b = lines(afterText);
  if (a.length * b.length > 2_000_000) {
    let start = 0, ae = a.length, be = b.length;
    while (start < ae && start < be && a[start] === b[start]) start++;
    while (ae > start && be > start && a[ae - 1] === b[be - 1]) { ae--; be--; }
    return start === ae && start === be ? [] : [makeHunk(0, a, b, start, ae, start, be)];
  }
  const grid = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) grid[i][j] = a[i] === b[j] ? grid[i + 1][j + 1] + 1 : Math.max(grid[i + 1][j], grid[i][j + 1]);
  const hunks = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    const ai = i, bj = j;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break;
      if (j < b.length && (i === a.length || grid[i][j + 1] >= grid[i + 1][j])) j++; else i++;
    }
    hunks.push(makeHunk(hunks.length, a, b, ai, i, bj, j));
  }
  return hunks;
}
function makeHunk(index, a, b, ai, ae, bj, be) { return { id: "hunk-" + (index + 1) + "-" + hash(a.slice(ai, ae).join("") + "\0" + b.slice(bj, be).join("")).slice(0, 10), beforeStart: ai, afterStart: bj, before: a.slice(ai, ae).join(""), after: b.slice(bj, be).join(""), beforePrefix: a.slice(Math.max(0, ai - 3), ai).join(""), beforeSuffix: a.slice(ae, ae + 3).join(""), afterPrefix: b.slice(Math.max(0, bj - 3), bj).join(""), afterSuffix: b.slice(be, be + 3).join("") }; }
function applyHunks(value, hunks, reverse) {
  const edits = hunks.map((hunk) => {
    const from = reverse ? hunk.after : hunk.before, to = reverse ? hunk.before : hunk.after;
    const prefix = reverse ? hunk.afterPrefix : hunk.beforePrefix, suffix = reverse ? hunk.afterSuffix : hunk.beforeSuffix;
    const needle = prefix + from + suffix;
    const first = value.indexOf(needle);
    if ((!needle && value) || first < 0 || value.indexOf(needle, first + Math.max(1, needle.length)) >= 0) throw new Error("Hunk overlaps external edits or has ambiguous context");
    return { start: first + prefix.length, end: first + prefix.length + from.length, to };
  }).sort((a, b) => b.start - a.start);
  for (let index = 1; index < edits.length; index++) if (edits[index].end > edits[index - 1].start) throw new Error("Selected hunks overlap");
  for (const { start, end, to } of edits) {
    value = value.slice(0, start) + to + value.slice(end);
  }
  return value;
}
