export const WORKER_TOOL_PROFILES = {
  research: new Set(["list_files", "read_file", "search_text", "git_status", "git_diff"]),
  verify: new Set(["list_files", "read_file", "search_text", "git_status", "git_diff", "run_shell"]),
  implement: new Set(["list_files", "read_file", "search_text", "git_status", "git_diff", "run_shell", "edit_file", "write_file"]),
};

export const TOOL_CAPABILITIES = [
  { name: "list_files", category: "files", mutates: false, requiresApproval: false, description: "List workspace files." },
  { name: "read_file", category: "files", mutates: false, requiresApproval: false, description: "Read a workspace file." },
  { name: "search_text", category: "search", mutates: false, requiresApproval: false, description: "Search workspace text." },
  { name: "git_status", category: "git", mutates: false, requiresApproval: false, description: "Read git status." },
  { name: "git_diff", category: "git", mutates: false, requiresApproval: false, description: "Read git diff." },
  { name: "run_shell", category: "shell", mutates: true, requiresApproval: true, description: "Run a guarded shell command." },
  { name: "edit_file", category: "files", mutates: true, requiresApproval: true, description: "Edit a file by unique replacement." },
  { name: "write_file", category: "files", mutates: true, requiresApproval: true, description: "Create or overwrite a file." },
  { name: "agent", category: "orchestration", mutates: false, requiresApproval: false, description: "Run a worker agent." },
  { name: "send_message", category: "orchestration", mutates: false, requiresApproval: false, description: "Continue a worker agent." },
  { name: "task_stop", category: "orchestration", mutates: false, requiresApproval: false, description: "Stop a worker agent." },
];

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
