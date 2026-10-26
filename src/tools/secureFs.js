import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getSystemErrorName } from "node:util";
import { assertSafePath } from "./pathPolicy.js";

const source = fileURLToPath(new URL("./secureFs.c", import.meta.url));
let helper;

function run(executable, args, { input, root, cwd, env, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const detached = !root && process.platform !== "win32";
    const child = spawn(executable, args, { cwd, env, detached, stdio: ["pipe", "pipe", "pipe", ...(root ? [root.fd] : [])] });
    const timer = timeoutMs ? setTimeout(() => {
      try { if (detached && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
    }, timeoutMs) : undefined;
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-4096); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", () => {});
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      let errorCode = "SECURE_FS_FAILED";
      if (code === 240) errorCode = "FILE_CHANGED_BEFORE_WRITE";
      else if (Number.isInteger(code) && code > 0 && code < 240) { try { errorCode = getSystemErrorName(-code); } catch {} }
      reject(Object.assign(new Error(stderr.trim() || `Secure filesystem operation failed (${signal ?? code}).`), { code: errorCode,
        workspaceMutationUncertain: Boolean(root) && (Boolean(signal) || !stderr.trim() || /^(?:write content|move source removal):/.test(stderr)) }));
    });
    child.stdin.end(input);
  });
}

async function buildHelper() {
  if (process.platform === "win32") throw Object.assign(new Error("Descriptor-safe workspace writes require a POSIX host; no unsafe path-based fallback is used."), { code: "SECURE_FS_UNAVAILABLE" });
  const bytes = await readFile(source);
  const digest = createHash("sha256").update(bytes).update(process.platform + process.arch).digest("hex");
  const cache = join(tmpdir(), `deecoo-secure-fs-${process.getuid()}-${digest}`);
  await mkdir(cache, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(cache);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("Unsafe secure filesystem helper cache");
  const executable = join(cache, "mutate");
  try {
    const entry = await lstat(executable);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o022)) throw new Error("Unsafe secure filesystem helper executable");
    return executable;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(cache, randomUUID());
  const sourceSnapshot = temporary + ".c";
  try {
    await writeFile(sourceSnapshot, bytes, { flag: "wx", mode: 0o600 });
    await run("/usr/bin/cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", sourceSnapshot, "-o", temporary], { cwd: dirname(source), timeoutMs: 10000,
      env: { PATH: "/usr/bin:/bin", TMPDIR: cache, LC_ALL: "C" } });
    await chmod(temporary, 0o700);
    await rename(temporary, executable);
    return executable;
  } catch (error) {
    throw Object.assign(new Error(`Cannot build descriptor-safe workspace writer. Install a C compiler (/usr/bin/cc). ${error.message}`), { code: "SECURE_FS_UNAVAILABLE", cause: error });
  } finally { await rm(temporary, { force: true }); await rm(sourceSnapshot, { force: true }); }
}

export function workspaceIdentity(workspace, permissionState) {
  // Bind before any approval/await. A changed ancestor path must not substitute a
  // different ordinary directory when the mutation later opens its root fd.
  if (!permissionState.workspaceIdentity) {
    const path = realpathSync(workspace), info = statSync(path, { bigint: true });
    if (!info.isDirectory()) throw new Error("Workspace root is not a directory");
    permissionState.workspaceIdentity = { path, dev: String(info.dev), ino: String(info.ino) };
  }
  return permissionState.workspaceIdentity;
}

async function mutate(workspace, operation, path, options = {}) {
  throwIfAborted(options.signal);
  helper ??= buildHelper().catch(error => { helper = undefined; throw error; });
  const executable = await helper;
  throwIfAborted(options.signal);
  assertSafePath(workspace, path);
  const rel = relative(workspace, path);
  const identity = options.identity ?? workspaceIdentity(workspace, {});
  const root = await open(identity.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    throwIfAborted(options.signal);
    const actual = await root.stat({ bigint: true });
    if (String(actual.dev) !== identity.dev || String(actual.ino) !== identity.ino) throw Object.assign(new Error("The authorized workspace root changed before mutation."), { code: "WORKSPACE_ROOT_CHANGED" });
    throwIfAborted(options.signal);
    const args = [operation, rel];
    let input;
    if (operation === "create" || operation === "write") {
      const original = Buffer.from(options.original ?? "", "utf8"), content = Buffer.from(options.content, "utf8");
      args.push(String(original.length), String(content.length));
      input = Buffer.concat([original, content]);
    } else if (operation === "move") {
      assertSafePath(workspace, options.target);
      args.push(relative(workspace, options.target));
    }
    await run(executable, args, { input, root });
  } finally { await root.close(); }
}

export const secureWrite = (workspace, path, content, options = {}) => mutate(workspace, options.create ? "create" : "write", path, { ...options, content });
export const secureMove = (workspace, from, target, options = {}) => mutate(workspace, "move", from, { ...options, target });
export const secureUnlink = (workspace, path, options = {}) => mutate(workspace, "unlink", path, options);

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error(signal.reason?.message ?? "Task interrupted."), { code: "ABORT_ERR", name: "AbortError" });
}
