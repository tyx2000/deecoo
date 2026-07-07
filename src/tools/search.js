import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import { assertExistingWorkspacePath, assertSafePath, isPathNotFoundError, pathNotFoundResult } from "./pathPolicy.js";
import { toolExceptionResult } from "./results.js";

const execFileAsync = promisify(execFile);

export async function searchText(workspace, getRealWorkspace, args, signal) {
  if (!args.query) return { ok: false, error: "query is required" };
  const directory = assertSafePath(workspace, args.directory ?? ".");
  const maxResults = Math.min(Number(args.maxResults ?? 50), 200);
  let info;
  try {
    info = await assertExistingWorkspacePath(workspace, getRealWorkspace, directory);
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, directory, args.directory ?? ".", "directory");
    }
    throw error;
  }
  if (!info.isDirectory()) {
    return { ok: false, error: "search directory is not a directory" };
  }

  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--line-number",
        "--hidden",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!.git/**",
        "--glob",
        "!.env*",
        args.query,
        relative(workspace, directory) || ".",
      ],
      { cwd: workspace, maxBuffer: 1024 * 1024, signal },
    );
    return searchResult(workspace, directory, args.query, stdout, maxResults);
  } catch (error) {
    if (error.code === 1) {
      return searchResult(workspace, directory, args.query, "", maxResults);
    }
    return toolExceptionResult(error);
  }
}

function searchResult(workspace, directory, query, stdout, maxResults) {
  return {
    ok: true,
    matches: stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults),
    activity: {
      kind: "search",
      label: "Searched code",
      target: relative(workspace, directory) || ".",
      detail: query,
    },
  };
}
