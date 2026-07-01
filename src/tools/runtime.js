import { execFile, exec } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { paint } from "../terminal/theme.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const DEFAULT_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
]);

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_ed25519",
]);

export function createToolRuntime({
  cwd,
  prompter,
  allowShellWithoutPrompt = false,
  permissionMode = "ask-once",
}) {
  const workspace = resolve(cwd);
  const permissionState = {
    mode: permissionMode,
    fileWriteApprovedForTask: false,
    shellApprovedAlways: false,
    readCache: new Map(),
  };

  const runtime = {
    schemas: buildToolSchemas(),
    setPermissionMode(mode) {
      permissionState.mode = mode;
      permissionState.fileWriteApprovedForTask = false;
    },
    getPermissionMode() {
      return permissionState.mode;
    },
    resetTaskPermissions() {
      permissionState.fileWriteApprovedForTask = false;
      permissionState.readCache.clear();
    },
    async execute(name, args) {
      try {
        switch (name) {
          case "list_files":
            return listFiles(workspace, args);
          case "read_file":
            return readWorkspaceFile(workspace, args, permissionState);
          case "search_text":
            return searchText(workspace, args);
          case "edit_file":
            return editFile(workspace, args, prompter, allowShellWithoutPrompt, permissionState);
          case "write_file":
            return writeWorkspaceFile(workspace, args, prompter, allowShellWithoutPrompt, permissionState);
          case "git_status":
            return gitStatus(workspace);
          case "git_diff":
            return gitDiff(workspace, args);
          case "run_shell":
            return runShell(workspace, args, prompter, allowShellWithoutPrompt, permissionState);
          default:
            return { ok: false, error: `Unknown tool: ${name}` };
        }
      } catch (error) {
        return toolExceptionResult(error);
      }
    },
  };

  return runtime;
}

function buildToolSchemas() {
  return [
    {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List files under a workspace directory, excluding heavy and sensitive folders. If a directory is missing, treat that result as recoverable and try a known parent directory.",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Directory relative to workspace root." },
            maxDepth: { type: "integer", description: "Maximum traversal depth." },
          },
          required: ["directory"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a non-sensitive text file from the workspace. If the path is missing, treat that result as recoverable and use list_files or search_text to find the correct path.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to workspace root." },
            maxBytes: { type: "integer", description: "Maximum bytes to return." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_text",
        description:
          "Search text in workspace files using ripgrep when available. If the directory is missing, treat that result as recoverable and search from a known parent directory.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            directory: { type: "string" },
            maxResults: { type: "integer" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_status",
        description: "Show git status for the workspace.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Safely edit an existing workspace file by replacing a unique search string. Shows a diff and asks for confirmation before writing. If the path is missing, inspect the workspace with list_files or search_text before retrying.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to workspace root." },
            search: { type: "string", description: "Exact text to replace. Must match once." },
            replace: { type: "string", description: "Replacement text." },
          },
          required: ["path", "search", "replace"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Write a workspace file. Shows a diff and asks for confirmation before writing.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to workspace root." },
            content: { type: "string", description: "Full file content to write." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_diff",
        description: "Show git diff for the workspace.",
        parameters: {
          type: "object",
          properties: {
            staged: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_shell",
        description: "Run a shell command in the workspace after local permission approval.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeoutMs: { type: "integer" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
  ];
}

async function listFiles(workspace, args) {
  const directory = args.directory ?? ".";
  const maxDepth = Math.min(Number(args.maxDepth ?? 2), 5);
  const root = assertSafePath(workspace, directory);
  const files = [];
  try {
    await walk(root, workspace, maxDepth, files);
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, root, directory, "directory");
    }
    throw error;
  }
  return {
    ok: true,
    files,
    activity: {
      kind: "list",
      label: "Listed files",
      target: relative(workspace, root) || ".",
      count: files.length,
    },
  };
}

async function walk(current, workspace, depth, files) {
  if (depth < 0) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (DEFAULT_EXCLUDES.has(entry.name) || SENSITIVE_BASENAMES.has(entry.name)) continue;
    const full = join(current, entry.name);
    const rel = relative(workspace, full);
    files.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) {
      await walk(full, workspace, depth - 1, files);
    }
  }
}

async function readWorkspaceFile(workspace, args, permissionState) {
  if (!args.path) return { ok: false, error: "path is required" };
  const path = assertSafePath(workspace, args.path);
  assertNotSensitive(path);
  const maxBytes = Math.min(Number(args.maxBytes ?? 20000), 100000);
  const rel = relative(workspace, path);
  const cacheKey = `${rel}:${maxBytes}`;
  const cached = permissionState.readCache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      cached: true,
      activity: {
        ...cached.activity,
        label: "Read a file",
        detail: `${cached.activity.detail} cached`,
      },
    };
  }
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, args.path, "file");
    }
    throw error;
  }
  if (!info.isFile()) return { ok: false, error: "path is not a file" };
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, args.path, "file");
    }
    throw error;
  }
  const result = cachedReadResult(rel, content, maxBytes);
  permissionState.readCache.set(cacheKey, result);
  return result;
}

async function editFile(workspace, args, prompter, allowWithoutPrompt, permissionState) {
  if (!args.path) return { ok: false, error: "path is required" };
  if (typeof args.search !== "string") return { ok: false, error: "search is required" };
  if (typeof args.replace !== "string") return { ok: false, error: "replace is required" };

  const path = assertSafePath(workspace, args.path);
  assertNotSensitive(path);
  let original;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return pathNotFoundResult(workspace, path, args.path, "file");
    }
    throw error;
  }
  const count = countOccurrences(original, args.search);
  if (count !== 1) {
    return { ok: false, error: `search must match exactly once; matched ${count} times` };
  }

  const next = original.replace(args.search, args.replace);
  const rel = relative(workspace, path);
  const stats = countLineChanges(original, next);
  if (permissionState.mode === "read-only") {
    return { ok: false, error: "File edits are blocked by read-only permission mode." };
  }
  const allowed = await approveFileWrite({
    rel,
    action: "Apply edit",
    prompter,
    allowWithoutPrompt,
    permissionState,
  });
  if (!allowed) return { ok: false, error: "User denied file edit." };

  await writeFile(path, next, "utf8");
  updateReadCache(permissionState, rel, next);
  return {
    ok: true,
    path: rel,
    bytesWritten: Buffer.byteLength(next, "utf8"),
    activity: {
      kind: "edit",
      label: "Edited a file",
      target: rel,
      additions: stats.additions,
      deletions: stats.deletions,
    },
  };
}

async function writeWorkspaceFile(workspace, args, prompter, allowWithoutPrompt, permissionState) {
  if (!args.path) return { ok: false, error: "path is required" };
  if (typeof args.content !== "string") return { ok: false, error: "content is required" };

  const path = assertSafePath(workspace, args.path);
  assertNotSensitive(path);
  let original = "";
  let existed = true;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if (isPathNotFoundError(error)) {
      existed = false;
    } else {
      throw error;
    }
  }

  const rel = relative(workspace, path);
  const stats = countLineChanges(original, args.content);
  if (permissionState.mode === "read-only") {
    return { ok: false, error: "File writes are blocked by read-only permission mode." };
  }
  const allowed = await approveFileWrite({
    rel,
    action: existed ? "Overwrite" : "Create",
    prompter,
    allowWithoutPrompt,
    permissionState,
  });
  if (!allowed) return { ok: false, error: "User denied file write." };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, args.content, "utf8");
  updateReadCache(permissionState, rel, args.content);
  return {
    ok: true,
    path: rel,
    bytesWritten: Buffer.byteLength(args.content, "utf8"),
    activity: {
      kind: existed ? "write" : "create",
      label: existed ? "Wrote a file" : "Created a file",
      target: rel,
      additions: stats.additions,
      deletions: stats.deletions,
    },
  };
}

async function approveFileWrite({ rel, action, prompter, allowWithoutPrompt, permissionState }) {
  if (allowWithoutPrompt) return true;
  if (permissionState.mode === "read-only") return false;
  if (permissionState.mode === "workspace-write") return true;
  if (permissionState.mode === "ask-once" && permissionState.fileWriteApprovedForTask) return true;

  const question =
    permissionState.mode === "ask-once"
      ? `${action} ${rel}? This will allow further file edits for this task.`
      : `${action} ${rel}?`;
  const decision = await prompter(question, { kind: "file-write-approval" });
  if (decision === "always") {
    permissionState.mode = "workspace-write";
    permissionState.fileWriteApprovedForTask = true;
    return true;
  }
  const allowed = decision === true || decision === "approve";
  if (allowed && permissionState.mode === "ask-once") {
    permissionState.fileWriteApprovedForTask = true;
  }
  return allowed;
}

async function searchText(workspace, args) {
  if (!args.query) return { ok: false, error: "query is required" };
  const directory = assertSafePath(workspace, args.directory ?? ".");
  const maxResults = Math.min(Number(args.maxResults ?? 50), 200);
  let info;
  try {
    info = await stat(directory);
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
      { cwd: workspace, maxBuffer: 1024 * 1024 },
    );
    return {
      ok: true,
      matches: stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults),
      activity: {
        kind: "search",
        label: "Searched code",
        target: relative(workspace, directory) || ".",
        detail: args.query,
      },
    };
  } catch (error) {
    if (error.code === 1) {
      return {
        ok: true,
        matches: [],
        activity: {
          kind: "search",
          label: "Searched code",
          target: relative(workspace, directory) || ".",
          detail: args.query,
        },
      };
    }
    return toolExceptionResult(error);
  }
}

async function gitStatus(workspace) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd: workspace,
      maxBuffer: 1024 * 1024,
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

async function gitDiff(workspace, args) {
  const command = args.staged ? ["diff", "--staged"] : ["diff"];
  try {
    const { stdout } = await execFileAsync("git", command, {
      cwd: workspace,
      maxBuffer: 4 * 1024 * 1024,
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

async function runShell(workspace, args, prompter, allowShellWithoutPrompt, permissionState) {
  if (!args.command) return { ok: false, error: "command is required" };
  const decision =
    allowShellWithoutPrompt || permissionState.shellApprovedAlways
      ? "approve"
      : await prompter(`Run shell command: ${args.command}`, { kind: "shell-command-approval" });
  if (decision === "always") {
    permissionState.shellApprovedAlways = true;
  }
  const allowed = decision === true || decision === "approve" || decision === "always";
  if (!allowed) return { ok: false, error: "User denied shell command." };

  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: workspace,
      timeout: Number(args.timeoutMs ?? 120000),
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout,
      stderr,
      activity: { kind: "command", label: "Ran command", target: args.command },
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error: error.message,
    };
  }
}

function countOccurrences(text, search) {
  if (search.length === 0) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = text.indexOf(search, index);
    if (next === -1) return count;
    count += 1;
    index = next + search.length;
  }
}

function countLineChanges(original, next) {
  const before = diffLines(original);
  const after = diffLines(next);
  const max = Math.max(before.length, after.length);
  let additions = 0;
  let deletions = 0;

  for (let index = 0; index < max; index += 1) {
    if (before[index] === after[index]) continue;
    if (before[index] !== undefined) deletions += 1;
    if (after[index] !== undefined) additions += 1;
  }

  return { additions, deletions };
}

function diffLines(value) {
  const text = String(value ?? "");
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function updateReadCache(permissionState, rel, content) {
  const prefix = `${rel}:`;
  for (const [key] of permissionState.readCache) {
    if (!key.startsWith(prefix)) continue;
    const maxBytes = Number(key.slice(prefix.length));
    permissionState.readCache.set(key, cachedReadResult(rel, content, maxBytes));
  }
}

function cachedReadResult(rel, content, maxBytes) {
  return {
    ok: true,
    path: rel,
    truncated: Buffer.byteLength(content, "utf8") > maxBytes,
    content: content.slice(0, maxBytes),
    activity: {
      kind: "read",
      label: "Read a file",
      target: rel,
      detail: `${content.split(/\r?\n/).length} lines`,
    },
  };
}

function isPathNotFoundError(error) {
  return error?.code === "ENOENT";
}

function pathNotFoundResult(workspace, fullPath, requestedPath, kind) {
  const rel = relative(workspace, fullPath) || ".";
  return {
    ok: false,
    error: `${kind} not found: ${rel}`,
    code: "ENOENT",
    path: rel,
    requestedPath,
    recoverable: true,
    suggestion:
      "This path may be a wrong guess. Use list_files on a known parent directory or search_text from the workspace root to locate the correct path, then retry.",
  };
}

function toolExceptionResult(error) {
  const result = {
    ok: false,
    error: error?.message ?? String(error),
  };
  if (error?.code) result.code = error.code;
  if (isPathNotFoundError(error)) {
    result.recoverable = true;
    result.suggestion =
      "This missing path is recoverable. Inspect the workspace with list_files or search_text before retrying.";
  }
  return result;
}

function assertSafePath(workspace, path) {
  const full = resolve(workspace, path);
  const rel = relative(workspace, full);
  if (rel.startsWith("..") || rel === ".." || rel.startsWith("/") || rel.includes("\0")) {
    throw new Error(`Access outside workspace is denied: ${path}`);
  }
  assertNotSensitive(full);
  return full;
}

function assertNotSensitive(path) {
  const name = basename(path);
  if (SENSITIVE_BASENAMES.has(name) || path.includes("/.git/") || path.includes("/node_modules/")) {
    throw new Error(`Access to sensitive or excluded path is denied: ${name}`);
  }
}
