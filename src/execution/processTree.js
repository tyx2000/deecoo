import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Linux exposes a boot-relative start tick, which distinguishes recycled PIDs.
// On macOS ps supplies creation time plus argv. Some hosting sandboxes forbid ps;
// durable stop then uses the supervisor's nonce handshake, never a persisted PID.
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return { pid, start: fields[19], command: readFileSync(`/proc/${pid}/cmdline`, "utf8"), state: fields[0] };
    }
    const value = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat=", "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = value.match(/^(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+([\s\S]*)$/);
    return match ? { pid, start: match[1].replace(/\s+/g, " "), state: match[2], command: match[3] } : null;
  } catch { return null; }
}

export function sameIdentity(expected, actual = processIdentity(expected?.pid)) {
  return Boolean(expected && actual && expected.pid === actual.pid && expected.start === actual.start && expected.command === actual.command);
}

export function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function groupExists(pgid) {
  if (process.platform === "win32") return processExists(pgid);
  try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export async function terminateOwnedGroup(pgid, { termGraceMs = 200, killGraceMs = 2000, onSignal } = {}) {
  const send = (signal) => {
    try {
      process.kill(process.platform === "win32" ? pgid : -pgid, signal);
      onSignal?.(signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  if (!groupExists(pgid)) return { confirmed: true, escalated: false };
  send("SIGTERM");
  const termDeadline = Date.now() + termGraceMs;
  while (groupExists(pgid) && Date.now() < termDeadline) await delay(20);
  const escalated = groupExists(pgid);
  if (escalated) send("SIGKILL");
  const killDeadline = Date.now() + killGraceMs;
  while (groupExists(pgid) && Date.now() < killDeadline) await delay(20);
  return { confirmed: !groupExists(pgid), escalated };
}
