import { relative } from "node:path";
import { execReadOnlyGit } from "../permissions/gitPolicy.js";
import { assertSafePath, isExcludedWorkspacePath, isSensitivePath } from "./pathPolicy.js";

export async function gitStatus(workspace, signal) {
  try {
    const { stdout } = await execReadOnlyGit(workspace, ["status", "--short", "--branch", "--", "."], {
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

export async function gitDiff(workspace, args = {}, signal) {
  try {
    const explicitPath = args.path === undefined ? undefined : relative(workspace, assertSafePath(workspace, String(args.path))) || ".";
    const command = ["diff", "--relative", "--no-renames", ...(args.staged ? ["--staged"] : [])];
    const { stdout: names } = await execReadOnlyGit(workspace, [...command, "--name-only", "-z", "--", ...(explicitPath ? [explicitPath] : [])], { signal });
    const safePaths = names.split("\0").filter((path) => path && !isSensitivePath(path) && !isExcludedWorkspacePath(path));
    let stdout = "";
    for (let index = 0; index < safePaths.length; index += 32) {
      const result = await execReadOnlyGit(workspace, [...command, "--", ...safePaths.slice(index, index + 32)], { signal });
      stdout += result.stdout;
      if (Buffer.byteLength(stdout, "utf8") > 4 * 1024 * 1024) throw new Error("Git diff exceeded the 4 MiB output limit. Narrow the requested path.");
    }
    return {
      ok: true,
      diff: stdout,
      activity: { kind: "git", label: args.staged ? "Read staged diff" : "Read git diff", target: "." },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
