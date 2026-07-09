# Deecoo

Local coding-agent harness prototype.

## Configure

Deecoo stores user-level configuration here by default:

```text
~/.deecoo/settings.json
```

Official DeepSeek API usage needs one environment variable for authentication:

```bash
export DEEPSEEK_API_KEY="sk-..."
```

Deecoo keeps the API base URL as its own setting so the same harness can later point at other OpenAI-compatible providers or gateways. The default follows DeepSeek's official docs:

```bash
export DEECOO_BASE_URL="https://api.deepseek.com"
```

During debugging, the fastest path is to export the key and optional Deecoo runtime settings once, then import them:

```bash
export DEEPSEEK_API_KEY="sk-..."
export DEECOO_BASE_URL="https://api.deepseek.com"
export DEECOO_MODEL="deepseek-v4-pro"
deecoo config import-env
```

You can also initialize a settings file with defaults:

```bash
deecoo config init
deecoo config path
deecoo config show
```

The resulting `~/.deecoo/settings.json` looks like:

```json
{
  "env": {
    "DEEPSEEK_API_KEY": "sk-...",
    "DEECOO_BASE_URL": "https://api.deepseek.com",
    "DEECOO_MODEL": "deepseek-v4-pro"
  },
  "permissions": {
    "shell": {
      "approvedCommands": [],
      "autoApproveAll": false
    }
  }
}
```

`DEEPSEEK_API_KEY` follows DeepSeek's official SDK examples. `DEECOO_*` variables are Deecoo-owned runtime settings, including `DEECOO_BASE_URL` for multi-provider routing.

Run budgets bound the agent loop so a task cannot loop or fan out unbounded:

```text
DEECOO_MAX_STEPS=150            Hard cap on agent loop iterations (default 150).
DEECOO_TOKEN_BUDGET=            Stop the run once total tokens reach this (default: off).
DEECOO_COST_BUDGET_USD=         Stop the run once estimated spend reaches this (default: off).
DEECOO_PRICE_PROMPT_PER_M=      Override prompt price (USD per 1M tokens) for cost estimates.
DEECOO_PRICE_COMPLETION_PER_M=  Override completion price (USD per 1M tokens).
DEECOO_TASK_TIMEOUT_MS=         Wall-clock budget for a whole task (default: off).
DEECOO_WORKER_TIMEOUT_MS=       Wall-clock budget for a single dispatched worker (default: off).
```

When a budget is hit the run ends with a terminal `*_budget_exceeded` / `task_deadline_exceeded` reason and a clear message rather than hanging. Each step emits a versioned, JSON-serializable checkpoint (`serializeRunState`) via `onCheckpoint`, and a typed event stream (`onEvent`) drives a live run tracer (`createRunTracer`) whose metrics are persisted with the run audit. `runAgent` accepts a `resume` snapshot (message history + step + usage) to continue a prior run.

Operational hardening: tool output (file contents, shell stdout, git diffs) is fenced as untrusted data with an injection scan, so the model treats it as data, not instructions. Shell commands that touch credential paths (`~/.ssh`, `~/.aws`, `id_rsa`, `/etc/shadow`, …) are hard-blocked, and secret-looking environment variables are stripped from the child process. The run footer reports estimated cost.

Configuration precedence:

```text
CLI args > shell environment > ~/.deecoo/settings.json > local .env > defaults
```

## Run

Enter an interactive session from any project root:

```bash
deecoo
```

The prompt uses a two-line layout. The first line shows runtime context:

```text
deecoo >> model >> project >> branch
> 
```

Branch is omitted when unavailable. The status line uses highlighted text and the ` >> ` separator.

Type `/` on the input line to open command suggestions inline. Continue typing to filter commands, use Up/Down to move, Tab to complete the selected command, and Enter to submit. A complete command match runs directly; a partial command match runs the currently selected suggestion. Backspace can delete `/`; unmatched slash input is submitted as typed. When the prompt is empty, Up/Down browse previous and next inputs.

Available commands:

```text
/resume Select previous project conversation
/permissions Select edit permission mode
/theme  Select terminal color theme
/model  Fetch provider models and select the active model
/usage  Show API key balance/usage information
/help   Show commands
/exit   Leave Deecoo
```

Model requests show a highlighted thinking spinner. Final answers are rendered with ANSI terminal styling for common Markdown: headings, lists, links, inline code, fenced code blocks, aligned tables, and diff blocks. Terminal Markdown is an approximation, not browser-grade rendering; nested HTML and advanced extensions are intentionally out of scope for now.

Themes can be changed immediately inside the app:

```text
/theme
```

Available themes:

```text
tokyo-night
gruvbox
catppuccin
starship
neon-edge
mono-focus
```

Use `DEECOO_THEME` to make a theme the startup default:

```bash
export DEECOO_THEME=neon-edge
deecoo config import-env
```

Diff output gets fixed-width pale red/green backgrounds:

```diff
- old line
+ new line
```

Each agent run ends with a footer containing elapsed time, agent steps, and token usage when the provider returns usage metadata.

File-edit permissions default to `ask-once`:

```text
read-only         Block file edits
ask-every-edit    Confirm every file edit
ask-once          Confirm first file edit per task, then allow rest of task
workspace-write   Allow file edits inside workspace
```

Use `/permissions` to switch during an interactive session, or set:

```bash
DEECOO_PERMISSION_MODE=ask-once
```

Edit approval prompts use a three-option selector: `Approve`, `Deny`, and `Always Approve`. `Always Approve` allows subsequent workspace file edits in the current Deecoo process without asking again.

Shell commands are classified by `src/permissions/shellPolicy.js` into `allow`, `warn`, and `block`. `allow`-level commands (e.g. read-only or otherwise unremarkable commands) never prompt. `warn`-level commands (e.g. `rm`, `git push`, `npm install`/`npm i`, network access, output redirection with `>`/`>>`, backgrounded commands ending in `&`, and interpreter one-liners like `node -e`/`python -c`) prompt with a four-option selector: `Approve`, `Deny`, `Always Approve This Command`, and `Always Approve All Commands`.

`Always Approve This Command` stores the exact normalized command under `permissions.shell.approvedCommands` in `settings.json`, so that same command can run later without another prompt. `Always Approve All Commands` sets `permissions.shell.autoApproveAll` in `settings.json`, suppressing shell prompts entirely for the rest of this and future sessions. Destructive commands classified as `block` (`git reset --hard`, `sudo`, recursive force `rm`, piping a download into a shell, etc.) are always refused regardless of these settings.

Both settings are global (`~/.deecoo/settings.json` by default) and persist until explicitly cleared. Run `deecoo config reset-shell-approvals` to clear both the per-command approval list and `autoApproveAll` in one step.

`--yes` only auto-approves guarded shell commands. For scripted runs that should also allow workspace file writes, pass `--yes-files` or set `DEECOO_PERMISSION_MODE=workspace-write` explicitly:

```bash
deecoo --yes --yes-files "apply the requested fix"
```

`/usage` calls the provider balance endpoint available on DeepSeek-compatible APIs:

```text
GET /user/balance
```

Conversation history is stored locally per project:

```text
~/.deecoo/sessions/<project-hash>/*.json
```

For local debugging or tests, override the storage root:

```bash
export DEECOO_HOME=/tmp/deecoo-dev
```

`/resume` lists only the current project's conversations, sorted by last update time. The full local transcript is retained for audit and future compaction, but Deecoo does not send the full history on every request. It sends:

Resume rows use:

```text
session-id  conversation-summary  YYYY/MM/DD HH:MM:SS
```

The picker supports typing to filter, highlighted matches, and a highlighted selected row.

Slash commands also work as top-level commands:

```bash
deecoo model
deecoo resume
deecoo permissions
deecoo theme
deecoo usage
```

In an interactive terminal, `deecoo resume` selects a previous project conversation and then continues inside that conversation.

```text
1. Project system prompt
2. Local conversation summary
3. Recent turns
4. Current user request
```

This keeps context useful without repeatedly uploading the entire conversation.

Agent runs continue until the model returns a final answer or an unrecoverable error occurs. Deecoo no longer stops a task because a local step counter was reached.

Or run one task directly:

```bash
node ./bin/deecoo.js "review this project"
```

The CLI uses the current terminal directory as the workspace by default. You can override it:

```bash
node ./bin/deecoo.js --cwd /path/to/repo "summarize this repo"
```

You can point at another settings file or directory:

```bash
node ./bin/deecoo.js --settings /path/to/settings.json "review this project"
```

After global linking, `deecoo` is available from any project directory:

```bash
npm link
deecoo "review this project"
```

## Current Scope

- Reads `DEEPSEEK_API_KEY` and `DEECOO_*` settings from `~/.deecoo/settings.json`, environment, and optional local `.env`
- Calls DeepSeek through the OpenAI-compatible Chat Completions API
- Runs a minimal agent loop with local tool execution
- Provides workspace read/search tools, guarded file writes, guarded shell execution, and persisted exact shell-command approvals
- Blocks common sensitive and heavy paths such as `.env`, `.git`, and `node_modules`


## Worker Delegation

Deecoo exposes three coordinator tools to the model for complex tasks:

- `agent`: run a scoped worker task with independent context.
- `send_message`: continue a previous worker when its loaded context is useful.
- `task_stop`: stop a worker that is obsolete or was sent in the wrong direction.

Workers currently run in-process and return a structured result to the main agent. They are useful for isolating research, focused implementation, and independent verification prompts, but they are not yet true background processes. Workers also continue until they return a final answer or hit an unrecoverable error.

## Harness Engineering

Deecoo records a structured task spec, workflow state, verification plan, project index snapshot, workspace snapshot, and audit trace for each run. Audit files are stored under the project session directory and redact common secret patterns before writing.

The workspace snapshot is intentionally small: current working directory, git status, `git diff --stat`, package metadata, project instructions, README excerpt, and a shallow directory tree. Deecoo looks for project instructions in priority order: `.deecoo.md`, `AGENTS.md`, `CLAUDE.md`, then `README.md` as a fallback. This gives the remote model early project memory with skill-like rules such as package manager, verification commands, patch size, and files that should not be edited. Deecoo also maintains `.deecoo/PROJECT.md` inside each workspace as a generated project-context cache for remote models. The generated section is refreshed on startup and after each task attempt; manual notes can live outside the generated markers.

The runtime also exposes tool capability metadata, shell-command guardrails, structured review schema validation, review finding aggregation, project memory, and output adapters for run summaries, review reports, and verification records.

Harness behavior can be evaluated with the fixture-based eval suite:

```bash
npm run eval
npm run eval -- --case small-bugfix
npm run eval -- --case small-bugfix --run /path/to/audit.json
npm run eval -- --run /path/to/audit.json --suggest
npm run eval -- --run /path/to/audit.json --auto-case
deecoo eval
```

Eval cases live in `eval/cases`, fixture run records live in `eval/fixtures`, and generated reports are written to `eval/reports`. The suite scores completion, request classification, required and forbidden tool usage, verification behavior, final output coverage, and unexpected tool failures. Fixture runs are the deterministic default; real audit JSON can be scored explicitly with `--run`.

Use `--suggest` to rank candidate cases for a real audit, or `--auto-case` to score the audit against the highest-scoring match. Without `--suggest` or `--auto-case`, real audit scoring requires `--case` so one run is not accidentally compared against unrelated task types.

`/trace` and `deecoo trace` show the latest audit path plus ranked eval suggestions and ready-to-run eval commands when cases are available. `/eval` and `deecoo eval` score the latest audit directly against the best matching eval case.

The harness is split by capability boundary:

```text
src/agent/          agent loop, prompt assembly, coordination, worker runtime
src/context/        project index, review scope, context budget assembly
src/harness/        task spec and workflow state contracts
src/verification/   verification state machine and command planner
src/permissions/    permission and shell-command policy
src/memory/         project memory persistence
src/observability/  audit trace persistence and redaction
src/reporter/       structured review reports and output adapters
src/tools/          local tool runtime, schemas, file/search helpers, shell/git executors
```

`src/tools/runtime.js` owns tool dispatch, task-scoped permission state, and worker tool filtering. Concrete executors live in focused modules: `src/tools/files.js`, `src/tools/search.js`, `src/tools/shell.js`, and `src/tools/git.js`. Tool schemas and worker profiles live in `src/tools/definitions.js`; path containment and sensitive-path checks live in `src/tools/pathPolicy.js`; edit line-count helpers live in `src/tools/textDiff.js`; shared tool error adaptation lives in `src/tools/results.js`.

Use `/trace` inside an interactive session, or `deecoo trace`, to inspect the latest audit trace for a conversation.
