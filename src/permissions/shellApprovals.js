import { normalizeShellCommand } from "./shellPolicy.js";

const PREFIX = "cwd-v1:";

// The cwd is already canonicalized by the shell tool/settings boundary. A versioned key makes
// command-only grants distinguishable, so loading an old settings file cannot widen approval.
export function shellApprovalKey(cwd, command) {
  return PREFIX + JSON.stringify([cwd, normalizeShellCommand(command)]);
}

export function parseShellApprovalKey(value) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(value.slice(PREFIX.length));
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((item) => typeof item !== "string" || !item)) return undefined;
    if (shellApprovalKey(...parsed) !== value) return undefined;
    return { cwd: parsed[0], command: parsed[1] };
  } catch { return undefined; }
}
