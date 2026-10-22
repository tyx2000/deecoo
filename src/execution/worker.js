// A detached supervisor owns the live ChildProcess. Agent/client exits do not
// terminate it, and reconnecting clients never signal a PID from persisted JSON.
import { spawn } from "node:child_process";
import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomic } from "./backend.js";
import { delay, groupExists, processIdentity, terminateOwnedGroup } from "./processTree.js";

async function main() {
  const [configPath, nonce] = process.argv.slice(2);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (nonce !== config.job.nonce) throw new Error("Execution supervisor identity token mismatch");
  const directory = dirname(configPath);
  const job = { ...config.job, supervisorPid: process.pid, supervisorIdentity: processIdentity(process.pid) };
  const save = async () => {
    job.updatedAt = new Date().toISOString();
    const [stdout, stderr] = await Promise.all([stat(join(directory, "stdout.log")), stat(join(directory, "stderr.log"))]);
    job.stdoutBytes = stdout.size; job.stderrBytes = stderr.size;
    await writeAtomic(join(directory, "job.json"), job);
  };
  const stdout = await open(join(directory, "stdout.log"), "a");
  const stderr = await open(join(directory, "stderr.log"), "a");
  let child;
  let closed = false;
  let spawnFailure;
  let stopReason;
  let cleanup;
  const requestShutdown = () => { stopReason ||= "cancelled"; };
  process.on("SIGTERM", requestShutdown);
  process.on("SIGINT", requestShutdown);
  try {
    child = spawn(config.launch.executable, config.launch.args, { cwd: job.cwd, env: config.env, detached: process.platform !== "win32", stdio: ["ignore", stdout.fd, stderr.fd], windowsHide: true });
    child.on("error", (error) => { spawnFailure = error; closed = true; });
    child.on("exit", (code, signal) => { job.exitCode = code; job.signal = signal; closed = true; });
    job.pid = child.pid ?? null;
    job.processIdentity = child.pid ? processIdentity(child.pid) : null;
    job.startedAt = new Date().toISOString();
    job.status = "running";
    await save();
    const started = Date.now();
    let lastSaved = started;
    while (!closed) {
      if (config.timeoutMs && Date.now() - started >= config.timeoutMs) stopReason = "timeout";
      try {
        const request = JSON.parse(await readFile(join(directory, "stop.json"), "utf8"));
        if (request.nonce === nonce) stopReason ||= request.reason === "timeout" ? "timeout" : "cancelled";
      } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      if (stopReason) break;
      if (Date.now() - lastSaved >= 250) { await save(); lastSaved = Date.now(); }
      await delay(40);
    }
    if (child.pid && (stopReason || groupExists(child.pid))) {
      job.status = "stopping";
      await save();
      cleanup = await terminateOwnedGroup(child.pid, { termGraceMs: config.termGraceMs, killGraceMs: config.killGraceMs });
    } else cleanup = { confirmed: true, escalated: false };
    // exit events carry the real code/signal; allow them to settle after KILL.
    const exitDeadline = Date.now() + config.killGraceMs;
    while (!closed && Date.now() < exitDeadline) await delay(10);
    job.treeCleanup = { ...cleanup, confirmed: cleanup.confirmed && closed, boundary: process.platform === "win32" ? "direct-process" : "process-group" };
    job.timedOut = stopReason === "timeout";
    job.status = !job.treeCleanup.confirmed ? "cleanup_unconfirmed" : spawnFailure ? "failed" : stopReason === "timeout" ? "timed_out" : stopReason ? "stopped" : "exited";
    if (spawnFailure) job.error = spawnFailure.message;
    if (!job.treeCleanup.confirmed) job.error = "Process group exit could not be confirmed";
    job.finishedAt = new Date().toISOString();
    await save();
  } catch (error) {
    if (child?.pid) cleanup = await terminateOwnedGroup(child.pid, config).catch(() => ({ confirmed: false }));
    job.status = cleanup?.confirmed === false ? "cleanup_unconfirmed" : "failed";
    job.treeCleanup = cleanup ?? { confirmed: !child?.pid };
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
    await save();
  } finally {
    process.removeListener("SIGTERM", requestShutdown);
    process.removeListener("SIGINT", requestShutdown);
    await stdout.close(); await stderr.close();
    await rm(config.tempDir, { recursive: true, force: true });
    // The env need not remain on disk after exit; logs and metadata are retained.
    await rm(configPath, { force: true });
  }
}

main().catch(() => { process.exitCode = 1; });
