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
  }
}
```

`DEEPSEEK_API_KEY` follows DeepSeek's official SDK examples. `DEECOO_*` variables are Deecoo-owned runtime settings, including `DEECOO_BASE_URL` for multi-provider routing.

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

Agent runs are capped by `DEECOO_MAX_STEPS` to prevent infinite tool loops. When the cap is reached, Deecoo now makes one final model request without tools so the model can summarize progress instead of exiting immediately. Increase the cap for larger tasks:

```bash
export DEECOO_MAX_STEPS=40
export DEECOO_SUBAGENT_MAX_STEPS=8
deecoo config import-env
```

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
- Provides workspace read/search tools, guarded file writes, and guarded shell execution
- Blocks common sensitive and heavy paths such as `.env`, `.git`, and `node_modules`


## Worker Delegation

Deecoo exposes three coordinator tools to the model for complex tasks:

- `agent`: run a scoped worker task with independent context.
- `send_message`: continue a previous worker when its loaded context is useful.
- `task_stop`: stop a worker that is obsolete or was sent in the wrong direction.

Workers currently run in-process and return a structured result to the main agent. They are useful for isolating research, focused implementation, and independent verification prompts, but they are not yet true background processes. Use `DEECOO_SUBAGENT_MAX_STEPS` to cap worker tool loops separately from the main task.
