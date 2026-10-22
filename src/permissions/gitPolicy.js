import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { promisify } from "node:util";
import { sanitizeShellEnv } from "./shellPolicy.js";

const execFileAsync = promisify(execFile);
const BASE_ARGS = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", `core.hooksPath=${devNull}`];

// Git's read commands can execute repository-configured helpers. Disable the known helper
// entry points for these calls; this does not provide OS isolation from an untrusted repository.
export async function execReadOnlyGit(cwd, args, options = {}) {
  const execution = { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024, ...options,
    env: { ...sanitizeShellEnv(process.env), GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" } };
  let filterKeys = [];
  try {
    const { stdout } = await execFileAsync("git", [...BASE_ARGS, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], execution);
    filterKeys = stdout.split("\0").filter(Boolean);
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  const overrides = filterKeys.flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
  const command = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...args.slice(1)]
    : args[0] === "status" ? ["status", "--ignore-submodules=all", ...args.slice(1)] : args;
  return execFileAsync("git", [...BASE_ARGS, ...overrides, ...command], execution);
}
