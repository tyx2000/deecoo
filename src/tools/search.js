import { spawn } from "node:child_process";
import { relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { assertExistingWorkspacePath, assertSafePath, isSensitivePath, isExcludedWorkspacePath, isPathNotFoundError, pathNotFoundResult } from "./pathPolicy.js";
import { toolExceptionResult } from "./results.js";

const SEARCH_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 250;
const MAX_SEARCH_BYTES = 1024 * 1024;

export async function searchText(workspace, getRealWorkspace, args, signal) {
  if (!args.query) return { ok: false, error: "query is required" };
  const directory = assertSafePath(workspace, args.directory ?? ".");
  const requestedLimit = Number(args.maxResults ?? 50);
  const maxResults = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(Math.trunc(requestedLimit), 200)) : 50;
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
  if (maxResults === 0) return searchResult(workspace, directory, args.query, [], false);

  try {
    // Discover candidates with rg's native ignore rules, then apply the same
    // sensitive-path predicate as read/list/write. Positive glob exceptions
    // would override .gitignore and accidentally expose ignored files.
    const candidates = await collectSearch(workspace, ["--files", "--hidden", "--null",
      ...["node_modules", ".git", "dist", "build", "coverage", ".next"].flatMap((name) => ["--glob", `!**/${name}/**`]),
      "--", relative(workspace, directory) || "."], 20000, signal, { delimiter: "\0" });
    if (candidates.truncated) return { ok: false, code: "SEARCH_SCOPE_TOO_LARGE", error: "Too many search candidates. Narrow the directory." };
    const safePaths = candidates.matches.filter((path) => !isSensitivePath(path) && !isExcludedWorkspacePath(path));
    const matches = [];
    let truncated = false;
    let batch = [];
    let batchBytes = 0;
    const searchBatch = async () => {
      if (!batch.length) return;
      const result = await collectSearch(workspace, ["--with-filename", "--line-number", "--hidden", "-e", String(args.query), "--", ...batch], maxResults - matches.length, signal);
      matches.push(...result.matches);
      truncated ||= result.truncated;
      batch = []; batchBytes = 0;
    };
    for (const path of safePaths) {
      if (batchBytes + Buffer.byteLength(path) > 60000) await searchBatch();
      if (truncated || matches.length >= maxResults) { truncated = true; break; }
      batch.push(path); batchBytes += Buffer.byteLength(path) + 1;
    }
    if (!truncated) await searchBatch();
    return searchResult(workspace, directory, args.query, matches, truncated);
  } catch (error) {
    return toolExceptionResult(error);
  }
}

function collectSearch(cwd, args, maxResults, signal, { delimiter = "\n" } = {}) {
  return new Promise((resolve, reject) => {
    // No stdin is needed for a workspace search. Closing it also prevents accidental waits.
    const child = spawn("rg", args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    const matches = [];
    let pending = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let closed = false;
    let forceKillTimeout;
    let childError;
    const stopChild = () => {
      if (closed) return;
      child.kill("SIGTERM");
      forceKillTimeout ??= setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, SEARCH_TIMEOUT_MS);

    const stopAtLimit = () => {
      truncated = true;
      stopChild();
    };
    const consume = (text) => {
      pending += text;
      let end;
      while (matches.length < maxResults && (end = pending.indexOf(delimiter)) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        if (line) matches.push(line);
      }
      if (matches.length >= maxResults) stopAtLimit();
    };
    child.stdout.on("data", (chunk) => {
      if (truncated || timedOut) return;
      const available = MAX_SEARCH_BYTES - bytes;
      const kept = chunk.subarray(0, available);
      bytes += kept.length;
      consume(decoder.write(kept));
      if (!truncated && bytes >= MAX_SEARCH_BYTES) stopAtLimit();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
    });
    child.on("error", (error) => {
      childError = error;
      if (error.code === "ABORT_ERR") stopChild();
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      if (childError) return reject(childError);
      if (signal?.aborted) {
        const error = new Error("Search was aborted.");
        error.code = "ABORT_ERR";
        return reject(error);
      }
      if (timedOut) {
        const error = new Error("Search exceeded its 30 second time limit. Narrow the query or directory.");
        error.code = "SEARCH_TIMEOUT";
        return reject(error);
      }
      // A byte limit may split a UTF-8 character. Keep only characters already fully decoded.
      consume(truncated ? "" : decoder.end());
      if (pending && matches.length < maxResults) matches.push(pending.replace(/\r$/, ""));
      if (truncated || code === 0 || code === 1) return resolve({ matches, truncated });
      const error = new Error(stderr.trim() || `ripgrep exited with code ${code}.`);
      error.code = code;
      reject(error);
    });
  });
}

function searchResult(workspace, directory, query, matches, truncated) {
  return {
    ok: true,
    matches: matches.filter((line) => !isSensitivePath(String(line).replace(/:\d+:[\s\S]*$/, ""))),
    truncated,
    activity: {
      kind: "search",
      label: "Searched code",
      target: relative(workspace, directory) || ".",
      detail: query,
    },
  };
}
