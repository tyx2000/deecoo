import { relative } from "node:path";
import { realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const FILE_TOOLS = new Set(["edit_file", "write_file", "apply_patch", "apply_patch_set", "apply_json_patch"]);

// Only the executor produces these effects; model prose and structured worker
// reports are never parsed as runtime evidence.
export function createEffectLedger({ revision = 0, workspace } = {}) {
  const canonical = (path) => { try { return realpathSync(path); } catch { return path; } };
  workspace = workspace ? canonical(workspace) : undefined;
  let current = revision;
  const versions = new Map();
  return {
    revision: () => current,
    record(name, args, result, metadata = {}) {
      const events = [];
      if (result?.executionState === "not-started") return { ...result, workspaceRevision: current };
      if (result?.alreadyAvailable || result?.cached || result?.code === "ALREADY_AVAILABLE") {
        return { ...result, workspaceRevision: current };
      }
      if (name === "start_job" && result?.shellPolicy && result?.jobId) {
        current += 1;
        events.push({ id: randomUUID(), type: "workspace-uncertain", tool: name, paths: [], revision: current, jobId: result.jobId });
      } else if (FILE_TOOLS.has(name) && result?.ok === false && (result.uncertainPaths?.length ||
        ["PATCH_SET_ROLLBACK_FAILED", "EIO", "ENOSPC", "EDQUOT"].includes(result.code))) {
        current += 1;
        const paths = result.uncertainPaths ?? args.files?.flatMap((file) => [file.from, file.path].filter(Boolean)) ?? [args.path].filter(Boolean);
        events.push({ id: randomUUID(), type: "workspace-uncertain", tool: name, paths, revision: current });
      } else if (FILE_TOOLS.has(name) && result?.ok !== false) {
        const paths = result.paths ?? result.files?.flatMap((file) => typeof file === "string" ? [file] : [file.from, file.path].filter(Boolean)) ?? args.files?.flatMap((file) => [file.path, file.from].filter(Boolean)) ?? [args.path].filter(Boolean);
        current += 1;
        events.push({ id: randomUUID(), type: "file-change", tool: name, paths, revision: current });
      } else if (name === "run_shell" && !["SHELL_COMMAND_BLOCKED", "TASK_TOOL_BLOCKED", "WORKER_TOOL_BLOCKED"].includes(result?.code)
        && result?.shellPolicy) {
        // Arbitrary commands may mutate files even when they fail. No stale
        // read/verification is reused after such an execution.
        current += 1;
        events.push({ id: randomUUID(), type: "command", tool: name, command: String(args.command ?? ""),
          ok: result.ok !== false, revision: current, cwd: result.cwd ?? workspace, scope: result.relativeScope ?? (workspace && result.cwd ? relative(workspace, canonical(result.cwd)) || "." : "."), stdout: result.stdout, stderr: result.stderr, error: result.error });
      } else if (name === "read_file" && result?.ok !== false && typeof result?.content === "string") {
        const path = result.path ?? args.path;
        const contentHash = result.contentHash ?? createHash("sha256").update(result.content).digest("hex");
        if (versions.has(path) && versions.get(path) !== contentHash) {
          current += 1;
          events.push({ id: randomUUID(), type: "workspace-uncertain", tool: name, paths: [path], origin: "external", revision: current });
        }
        versions.set(path, contentHash);
        const complete = result.truncated !== true && result.sourceComplete !== false;
        events.push({ id: randomUUID(), type: "file-read", path, chars: result.content.length, truncated: !complete,
          contentHash, ...(typeof result.version === "string" ? { version: result.version } : {}),
          ...Object.fromEntries(["startLine", "endLine", "totalLines", "rangeComplete"].filter((key) => result[key] !== undefined).map((key) => [key, result[key]])),
          ...(complete && result.content.length <= 32768 ? { content: result.content } : {}), revision: current });
      } else if (name === "git_diff" && result?.ok !== false && String(result?.diff ?? "").trim()) {
        events.push({ id: randomUUID(), type: "diff-read", path: args.path,
          paths: [...String(result.diff).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]), revision: current });
      } else if (metadata.mutates && !["TOOL_INVALID_ARGUMENTS", "TOOL_READ_ONLY", "TASK_TOOL_BLOCKED", "WORKER_TOOL_BLOCKED", "TOOL_APPROVAL_DENIED"].includes(result?.code)) {
        current += 1;
        events.push({ id: randomUUID(), type: "workspace-uncertain", tool: name, paths: [], revision: current });
      }
      return { ...result, workspaceRevision: current,
        effects: { version: 1, revision: current, events } };
    },
    reset(nextRevision = 0) { current = nextRevision; versions.clear(); },
  };
}

export function appendEffects(target, result) {
  const seen = new Set(target.map((event) => event.id));
  for (const event of result?.effects?.events ?? []) {
    if (event?.id && !seen.has(event.id)) {
      target.push(event);
      seen.add(event.id);
    }
  }
}
