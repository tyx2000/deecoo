import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitStatus(workspace, signal) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd: workspace,
      maxBuffer: 1024 * 1024,
      signal,
    });
    return {
      ok: true,
      status: stdout,
      activity: { kind: "git", label: "Checked git status", target: "." },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function gitDiff(workspace, args, signal) {
  const command = args.staged ? ["diff", "--staged"] : ["diff"];
  try {
    const { stdout } = await execFileAsync("git", command, {
      cwd: workspace,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    return {
      ok: true,
      diff: stdout,
      activity: { kind: "git", label: args.staged ? "Read staged diff" : "Read git diff", target: "." },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
