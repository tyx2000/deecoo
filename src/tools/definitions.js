export const WORKER_TOOL_PROFILES = {
  research: new Set(["list_files", "read_file", "search_text", "git_status", "git_diff"]),
  verify: new Set(["list_files", "read_file", "search_text", "git_status", "git_diff", "run_shell"]),
  implement: new Set(["list_files", "read_file", "search_text", "git_status", "git_diff", "run_shell", "propose_patch", "propose_patch_set", "apply_patch", "apply_patch_set", "apply_json_patch", "edit_file", "write_file"]),
};

export const TOOL_CAPABILITIES = [
  { name: "list_files", category: "files", mutates: false, requiresApproval: false, description: "List workspace files." },
  { name: "read_file", category: "files", mutates: false, requiresApproval: false, description: "Read a workspace file." },
  { name: "search_text", category: "search", mutates: false, requiresApproval: false, description: "Search workspace text." },
  { name: "git_status", category: "git", mutates: false, requiresApproval: false, description: "Read git status." },
  { name: "git_diff", category: "git", mutates: false, requiresApproval: false, description: "Read git diff." },
  { name: "run_shell", category: "shell", mutates: true, requiresApproval: true, description: "Run a guarded shell command." },
  { name: "propose_patch", category: "files", mutates: false, requiresApproval: false, description: "Preview a file patch without applying it." },
  { name: "propose_patch_set", category: "files", mutates: false, requiresApproval: false, description: "Preview a validated structured patch set without applying it." },
  { name: "apply_patch", category: "files", mutates: true, requiresApproval: true, description: "Apply validated structured file hunks." },
  { name: "apply_patch_set", category: "files", mutates: true, requiresApproval: true, description: "Apply validated structured hunks across multiple files." },
  { name: "apply_json_patch", category: "files", mutates: true, requiresApproval: true, description: "Apply structured JSON AST operations." },
  { name: "edit_file", category: "files", mutates: true, requiresApproval: true, description: "Edit a file by unique replacement." },
  { name: "write_file", category: "files", mutates: true, requiresApproval: true, description: "Create or overwrite a file." },
  { name: "agent", category: "orchestration", mutates: false, requiresApproval: false, description: "Run a worker agent." },
  { name: "send_message", category: "orchestration", mutates: false, requiresApproval: false, description: "Continue a worker agent." },
  { name: "task_stop", category: "orchestration", mutates: false, requiresApproval: false, description: "Stop a worker agent." },
];

function patchHunkSchema() {
  return {
    type: "object",
    properties: {
      oldStart: { type: "integer", description: "1-based line where oldLines starts; for insertion, line before which to insert." },
      oldLines: { type: "array", items: { type: "string" }, description: "Current lines that must match exactly." },
      newLines: { type: "array", items: { type: "string" }, description: "Replacement lines." },
    },
    required: ["oldStart", "oldLines", "newLines"],
    additionalProperties: false,
  };
}

function patchSetParameters() {
  return {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["update", "create", "move"], description: "Patch operation. Defaults to update." },
            path: { type: "string", description: "File path relative to workspace root." },
            from: { type: "string", description: "Source path for move operations." },
            content: { type: "string", description: "Full file content for create operations." },
            hunks: {
              type: "array",
              items: patchHunkSchema(),
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    required: ["files"],
    additionalProperties: false,
  };
}

export function buildToolSchemas({ includeSubagents = true, allowedTools } = {}) {
  const schemas = [
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
        name: "propose_patch",
        description:
          "Preview a patch for a workspace file without writing it. Use for medium, risky, or user-confirmed edits before applying with apply_patch, apply_patch_set, apply_json_patch, edit_file, or write_file. Provide either search+replace for a unique replacement or content for a full-file proposal.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to workspace root." },
            search: { type: "string", description: "Exact text to replace. Must match once when used." },
            replace: { type: "string", description: "Replacement text for search." },
            content: { type: "string", description: "Full proposed file content. Mutually exclusive with search+replace." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description:
          "Apply structured hunks to one existing workspace file after validating that each oldLines block still matches the current file. Use after propose_patch or for complex line-based edits. Hunk oldStart is 1-based; oldLines and newLines are arrays of complete lines without line endings.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to workspace root." },
            hunks: {
              type: "array",
              items: patchHunkSchema(),
            },
          },
          required: ["path", "hunks"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "apply_patch_set",
        description:
          "Apply structured hunks to multiple existing workspace files as one validated patch set. The harness reads and validates every file before asking for approval or writing anything. Duplicate paths are rejected; use one file entry per path.",
        parameters: patchSetParameters(),
      },
    },
    {
      type: "function",
      function: {
        name: "propose_patch_set",
        description:
          "Preview a structured patch set across multiple workspace files without writing anything. The harness validates every file using the same rules as apply_patch_set, including stale hunk context, duplicate paths, create overwrite, and move target overwrite checks.",
        parameters: patchSetParameters(),
      },
    },
    {
      type: "function",
      function: {
        name: "apply_json_patch",
        description:
          "Apply JSON AST operations to one workspace JSON file. Operations are validated against parsed JSON and preserve JSON formatting with two-space indentation. Paths use JSON Pointer syntax such as /scripts/test or /dependencies/name.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "JSON file path relative to workspace root." },
            operations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  op: { type: "string", enum: ["set", "delete", "append"], description: "AST operation." },
                  pointer: { type: "string", description: "JSON Pointer target path." },
                  value: { description: "Value for set or append." },
                },
                required: ["op", "pointer"],
                additionalProperties: false,
              },
            },
          },
          required: ["path", "operations"],
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
          "Create or replace a workspace file. Prefer apply_patch/apply_patch_set for partial edits and apply_json_patch for JSON. When overwriting an existing file after reading it, include expectedContent or expectedSha256 so stale full-file writes are rejected.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to workspace root." },
            content: { type: "string", description: "Full file content to write." },
            expectedContent: { type: "string", description: "Optional exact current file content required before overwriting an existing file." },
            expectedSha256: { type: "string", description: "Optional SHA-256 hex digest of the current file content required before overwriting an existing file." },
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

  const filteredSchemas = allowedTools
    ? schemas.filter((schema) => allowedTools.has(schema.function.name))
    : schemas;

  if (!includeSubagents) return filteredSchemas;
  return [
    ...filteredSchemas,
    {
      type: "function",
      function: {
        name: "agent",
        description:
          "Run a delegated worker subtask with its own context. Use for independent research, focused implementation, or independent verification. Worker prompts must be self-contained with purpose, mode, scope, file paths if known, constraints, and done criteria.",
        parameters: {
          type: "object",
          properties: {
            description: { type: "string", description: "Short worker label shown in activity output." },
            mode: {
              type: "string",
              enum: ["research", "verify", "implement"],
              description:
                "Worker tool profile. research is read-only; verify can also run shell commands; implement can edit files.",
            },
            subagent_type: { type: "string", description: "Legacy worker type; prefer mode." },
            role: {
              type: "string",
              enum: ["planner", "coder", "reviewer", "tester", "security"],
              description:
                "Worker role preset. planner plans and researches; coder implements; reviewer reviews correctness/design; tester validates; security checks security risks. Role does not grant tools; mode controls tools.",
            },
            prompt: { type: "string", description: "Self-contained worker instructions." },
          },
          required: ["description", "prompt"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "send_message",
        description: "Continue an existing worker by task id when its prior context is useful.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Worker task id returned by agent." },
            message: { type: "string", description: "Self-contained follow-up or correction." },
          },
          required: ["to", "message"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "task_stop",
        description: "Stop a worker that is no longer relevant or was sent in the wrong direction.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Worker task id returned by agent." },
          },
          required: ["task_id"],
          additionalProperties: false,
        },
      },
    },
  ];
}

export function normalizeWorkerMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "verification" || normalized === "verifier" || normalized === "test") return "verify";
  if (normalized === "implementation" || normalized === "implementer" || normalized === "edit" || normalized === "write") return "implement";
  if (normalized === "review" || normalized === "analysis" || normalized === "inspect" || normalized === "read") return "research";
  return WORKER_TOOL_PROFILES[normalized] ? normalized : "research";
}
