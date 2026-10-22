import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { delay, processIdentity, sameIdentity, processExists } from "./processTree.js";
import { detectSandbox, executionCommand, executionEnv, normalizeSandboxPolicy } from "./sandbox.js";
import { atomicWriteFile } from "../storage/atomic.js";

const TERMINAL = new Set(["exited", "stopped", "timed_out", "failed", "cleanup_unconfirmed"]);
const JOB_ID = /^[a-f0-9-]{36}$/;
const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));

export async function writeAtomic(path, value) {
  return atomicWriteFile(path, JSON.stringify(value, null, 2) + "\n", { backup: false });
}

export function createExecutionBackend(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const workspaceHash = createHash("sha256").update(cwd).digest("hex");
  // Keep supervisor records outside a command-controlled workspace: chmod/rm
  // of the project must not destroy the lifecycle channel.
  const stateDir = resolve(options.stateDir ?? join(tmpdir(), "deecoo-execution-jobs", workspaceHash));
  const ownerId = options.ownerId ?? workspaceHash;
  const defaultEnv = { ...(options.env ?? process.env) };
  const ownedJobs = new Set();
  let sandbox;
  const probe = () => sandbox ??= detectSandbox();
  const directory = (jobId) => {
    if (!JOB_ID.test(String(jobId))) throw Object.assign(new Error("Invalid execution job ID"), { code: "JOB_ID_INVALID" });
    return join(stateDir, jobId);
  };

  async function getJob(jobId) {
    let job;
    try { job = JSON.parse(await readFile(join(directory(jobId), "job.json"), "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw Object.assign(new Error("Execution job state is corrupt; refusing to infer a process identity or replay the command"), { code: "JOB_STATE_CORRUPT" });
      throw error;
    }
    if (job.schemaVersion !== 1) throw Object.assign(new Error("Unsupported execution job schema version"), { code: "JOB_SCHEMA_VERSION" });
    if (job.jobId !== jobId || job.ownerId !== ownerId || job.cwdRoot !== cwd) throw Object.assign(new Error("Execution job ownership mismatch"), { code: "JOB_OWNER_MISMATCH" });
    const result = { ...job };
    delete result.nonce;
    if (!TERMINAL.has(job.status) && job.supervisorPid && Date.now() - Date.parse(job.updatedAt) > 4000) {
      const actual = processIdentity(job.supervisorPid);
      const alive = actual ? sameIdentity(job.supervisorIdentity, actual) : processExists(job.supervisorPid);
      result.status = alive ? "unresponsive" : "orphaned";
      result.error = "Supervisor heartbeat expired; process cleanup is unconfirmed.";
    }
    return result;
  }

  async function readOutput(jobId, { stream = "stdout", offset = 0, maxBytes = 20 * 1024 } = {}) {
    await getJob(jobId);
    if (!["stdout", "stderr"].includes(stream)) throw new Error("stream must be stdout or stderr");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("Invalid output byte range (maximum 1MiB)");
    const handle = await open(join(directory(jobId), `${stream}.log`), "r");
    try {
      const info = await handle.stat();
      const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, info.size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      // Offsets are bytes, so callers may use base64 to reconstruct split UTF-8.
      const bytes = buffer.subarray(0, bytesRead);
      return { jobId, stream, offset, nextOffset: offset + bytesRead, totalBytes: info.size, text: bytes.toString("utf8"), base64: bytes.toString("base64"), truncated: offset + bytesRead < info.size };
    } finally { await handle.close(); }
  }

  async function startJob(args = {}) {
    if (!String(args.command ?? "").trim()) throw new Error("command is required");
    if (args.signal?.aborted) throw Object.assign(new Error(args.signal.reason?.message ?? "Task interrupted."), { code: "ABORT_ERR", name: "AbortError" });
    const timeoutMs = args.timeoutMs == null ? null : Number(args.timeoutMs);
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) throw new Error("timeoutMs must be a positive integer");
    const [jobCwd, realRoot] = await Promise.all([realpath(resolve(args.cwd ?? cwd)), realpath(cwd)]);
    if (jobCwd !== realRoot && !jobCwd.startsWith(realRoot + "/")) throw new Error("Execution cwd must remain within the backend workspace");
    const jobId = randomUUID();
    const nonce = randomUUID();
    const jobDir = directory(jobId);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    // A separate private temporary directory avoids granting access to job state.
    const tempDir = await mkdtemp(join(tmpdir(), `deecoo-exec-${jobId}-`));
    let policy, launch;
    try {
      policy = normalizeSandboxPolicy(options.sandboxPolicy, realRoot, stateDir, tempDir);
      launch = executionCommand({ command: String(args.command), cwd: jobCwd, policy, sandbox: probe() });
    } catch (error) { await rm(tempDir, { recursive: true, force: true }); throw error; }
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const job = { schemaVersion: 1, jobId, ownerId, nonce, cwdRoot: cwd, cwd: jobCwd, command: String(args.command), status: "starting", createdAt: now, updatedAt: now, exitCode: null, signal: null, timedOut: false, treeCleanup: null, sandbox: launch.sandbox, resources: policy.resources, stdoutBytes: 0, stderrBytes: 0 };
    await writeAtomic(join(jobDir, "job.json"), job);
    ownedJobs.add(jobId);
    await Promise.all([writeFile(join(jobDir, "stdout.log"), "", { mode: 0o600 }), writeFile(join(jobDir, "stderr.log"), "", { mode: 0o600 })]);
    const config = { job, launch, tempDir, env: executionEnv(args.replaceEnv ? { ...(args.env ?? {}) } : { ...defaultEnv, ...(args.env ?? {}) }, tempDir), timeoutMs, termGraceMs: options.termGraceMs ?? 200, killGraceMs: options.killGraceMs ?? 2000 };
    await writeAtomic(join(jobDir, "config.json"), config);
    const supervisor = spawn(process.execPath, [workerPath, join(jobDir, "config.json"), nonce], { cwd: jobCwd, env: executionEnv(defaultEnv, tempDir), detached: process.platform !== "win32", stdio: "ignore", windowsHide: true });
    let spawnError;
    supervisor.on("error", (error) => { spawnError = error; });
    supervisor.unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (args.signal?.aborted) return stopJob(jobId, { reason: "cancelled" });
      const snapshot = await getJob(jobId);
      if (snapshot.status !== "starting") return snapshot;
      await delay(15);
    }
    throw Object.assign(new Error(`Execution supervisor did not start; inspect job ${jobId}`), { code: "JOB_START_TIMEOUT", jobId });
  }

  async function stopJob(jobId, { reason = "cancelled" } = {}) {
    const jobDir = directory(jobId);
    const job = await getJob(jobId);
    if (TERMINAL.has(job.status)) return job;
    const privateJob = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
    const actual = processIdentity(job.supervisorPid);
    if (actual && privateJob.supervisorIdentity && !sameIdentity(privateJob.supervisorIdentity, actual)) throw Object.assign(new Error("Supervisor identity mismatch; refusing to signal a recycled PID"), { code: "JOB_IDENTITY_MISMATCH" });
    // The nonce is checked inside the original live supervisor. No reconnected
    // client ever sends a signal to a PID taken from a disk record.
    await writeAtomic(join(jobDir, "stop.json"), { nonce: privateJob.nonce, reason: String(reason), requestedAt: new Date().toISOString() });
    const deadline = Date.now() + (options.termGraceMs ?? 200) + (options.killGraceMs ?? 2000) + 4000;
    while (Date.now() < deadline) {
      const snapshot = await getJob(jobId);
      if (TERMINAL.has(snapshot.status)) return snapshot;
      await delay(25);
    }
    return { ...await getJob(jobId), ok: false, code: "JOB_CLEANUP_UNCONFIRMED", error: "The original supervisor did not confirm process-tree exit; no persisted PID was signalled.", treeCleanup: { confirmed: false } };
  }

  async function run(args = {}) {
    const maxBytes = args.maxOutputBytes ?? 20 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("maxOutputBytes must be an integer from 1 to 1MiB");
    const job = await startJob({ ...args, timeoutMs: args.timeoutMs ?? 30_000 });
    let stopping;
    const abort = () => { stopping ??= stopJob(job.jobId, { reason: "cancelled" }); };
    args.signal?.addEventListener("abort", abort, { once: true });
    if (args.signal?.aborted) abort();
    let snapshot = job;
    try {
      while (!TERMINAL.has(snapshot.status)) {
        if (stopping) { snapshot = await stopping; break; }
        await delay(25);
        snapshot = await getJob(job.jobId);
        if (["orphaned", "unresponsive"].includes(snapshot.status)) break;
      }
    } finally { args.signal?.removeEventListener("abort", abort); }
    const [stdout, stderr] = await Promise.all([readOutput(job.jobId, { maxBytes }), readOutput(job.jobId, { stream: "stderr", maxBytes })]);
    const ok = snapshot.status === "exited" && snapshot.exitCode === 0 && snapshot.treeCleanup?.confirmed;
    return { ...snapshot, ok: Boolean(ok), stdout: stdout.text, stderr: stderr.text, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, ...(ok ? {} : { error: snapshot.error ?? (snapshot.timedOut ? `Command timed out after ${args.timeoutMs ?? 30_000}ms` : snapshot.status === "stopped" ? "Command cancelled" : `Command failed (${snapshot.signal ?? snapshot.exitCode ?? snapshot.status})`), ...(snapshot.status === "stopped" ? { code: "ABORT_ERR" } : {}) }) };
  }

  function capabilities() {
    const configuredMode = typeof options.sandboxPolicy === "string" ? options.sandboxPolicy : options.sandboxPolicy?.mode ?? "auto";
    const enforced = configuredMode !== "off" && probe().available;
    return { platform: process.platform, durableJobs: true, diskOutput: true, explicitEnvironment: true, processTree: process.platform === "win32" ? "direct-process-only" : "owned-process-group", detachedEscapeContainment: process.platform === "linux" && enforced, sandbox: { ...probe(), configuredMode, enforced }, resources: { cpuSeconds: "per-process-hard-rlimit", fileSizeBytes: "per-file-hard-rlimit", openFiles: "per-process-hard-rlimit", maxProcesses: process.platform === "linux" ? "per-user-hard-rlimit" : false }, stateDir };
  }

  async function dispose({ stopRunning = false, removeState = false } = {}) {
    const stopped = [], removed = [], errors = [];
    for (const jobId of [...ownedJobs]) {
      try {
        let job = await getJob(jobId);
        if (!TERMINAL.has(job.status) && stopRunning) {
          job = await stopJob(jobId, { reason: "backend-disposed" });
          if (job.treeCleanup?.confirmed) stopped.push(jobId);
        }
        if (removeState) {
          if (!TERMINAL.has(job.status) || !job.treeCleanup?.confirmed) {
            errors.push({ jobId, code: "JOB_CLEANUP_UNCONFIRMED", error: "Job state was retained because process exit was not confirmed" });
            continue;
          }
          await rm(directory(jobId), { recursive: true, force: true });
          ownedJobs.delete(jobId);
          removed.push(jobId);
        }
      } catch (error) {
        if (error.code === "ENOENT") { ownedJobs.delete(jobId); continue; }
        errors.push({ jobId, code: error.code ?? "JOB_DISPOSE_FAILED", error: error.message });
      }
    }
    return { ok: errors.length === 0, stopped, removed, errors, ...(errors.length ? { code: "JOB_DISPOSE_INCOMPLETE" } : {}) };
  }

  return { run, startJob, getJob, readOutput, stopJob, capabilities, dispose };
}
