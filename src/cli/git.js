import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getGitBranch(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") return "";
    return branch;
  } catch {
    return "";
  }
}

