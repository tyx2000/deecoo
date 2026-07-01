# DeepCode

Local coding-agent harness prototype.

## Configure

DeepCode stores user-level configuration here by default:

```text
~/.deepcode/settings.json
```

Official DeepSeek API usage needs one environment variable for authentication:

```bash
export DEEPSEEK_API_KEY="sk-..."
```

DeepCode keeps the API base URL as its own setting so the same harness can later point at other OpenAI-compatible providers or gateways. The default follows DeepSeek's official docs:

```bash
export DEEPCODE_BASE_URL="https://api.deepseek.com"
```

During debugging, the fastest path is to export the key and optional DeepCode runtime settings once, then import them:

```bash
export DEEPSEEK_API_KEY="sk-..."
export DEEPCODE_BASE_URL="https://api.deepseek.com"
export DEEPCODE_MODEL="deepseek-v4-pro"
deepcode config import-env
```

You can also initialize a settings file with defaults:

```bash
deepcode config init
deepcode config path
deepcode config show
```

The resulting `~/.deepcode/settings.json` looks like:

```json
{
  "env": {
    "DEEPSEEK_API_KEY": "sk-...",
    "DEEPCODE_BASE_URL": "https://api.deepseek.com",
    "DEEPCODE_MODEL": "deepseek-v4-pro"
  }
}
```

`DEEPSEEK_API_KEY` follows DeepSeek's official SDK examples. `DEEPCODE_*` variables are DeepCode-owned runtime settings, including `DEEPCODE_BASE_URL` for multi-provider routing.

Configuration precedence:

```text
CLI args > shell environment > ~/.deepcode/settings.json > local .env > defaults
```

## Run

Enter an interactive session from any project root:

```bash
deepcode
```

The prompt uses a two-line layout. The first line shows runtime context:

```text
deepcode##model##project##branch
> 
```

Branch is omitted when unavailable. The status line uses a fixed highlighted style independent of the selected theme.

Type `/` on the input line to open command suggestions inline. Continue typing to filter commands, use Up/Down to move, Tab to complete the selected command, and Enter to submit. A complete command match runs directly; a partial command match runs the currently selected suggestion. Backspace can delete `/`; unmatched slash input is submitted as typed. When the prompt is empty, Up/Down browse previous and next inputs.

Available commands:

```text
/resume Select previous project conversation
/permissions Select edit permission mode
/theme  Select terminal color theme
/model  Fetch provider models and select the active model
/usage  Show API key balance/usage information
/help   Show commands
/exit   Leave DeepCode
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

Use `DEEPCODE_THEME` to make a theme the startup default:

```bash
export DEEPCODE_THEME=neon-edge
deepcode config import-env
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
DEEPCODE_PERMISSION_MODE=ask-once
```

Edit approval prompts use a three-option selector: `Approve`, `Deny`, and `Always Approve`. `Always Approve` allows subsequent workspace file edits in the current DeepCode process without asking again.

`/usage` calls the provider balance endpoint available on DeepSeek-compatible APIs:

```text
GET /user/balance
```

Conversation history is stored locally per project:

```text
~/.deepcode/sessions/<project-hash>/*.json
```

For local debugging or tests, override the storage root:

```bash
export DEEPCODE_HOME=/tmp/deepcode-dev
```

`/resume` lists only the current project's conversations, sorted by last update time. The full local transcript is retained for audit and future compaction, but DeepCode does not send the full history on every request. It sends:

Resume rows use:

```text
session-id  conversation-summary  YYYY/MM/DD HH:MM:SS
```

The picker supports typing to filter, highlighted matches, and a highlighted selected row.

Slash commands also work as top-level commands:

```bash
deepcode model
deepcode resume
deepcode permissions
deepcode theme
deepcode usage
```

In an interactive terminal, `deepcode resume` selects a previous project conversation and then continues inside that conversation.

```text
1. Project system prompt
2. Local conversation summary
3. Recent turns
4. Current user request
```

This keeps context useful without repeatedly uploading the entire conversation.

Agent runs are capped by `DEEPCODE_MAX_STEPS` to prevent infinite tool loops. When the cap is reached, DeepCode now makes one final model request without tools so the model can summarize progress instead of exiting immediately. Increase the cap for larger tasks:

```bash
export DEEPCODE_MAX_STEPS=40
deepcode config import-env
```

Or run one task directly:

```bash
node ./bin/deepcode.js "review this project"
```

The CLI uses the current terminal directory as the workspace by default. You can override it:

```bash
node ./bin/deepcode.js --cwd /path/to/repo "summarize this repo"
```

You can point at another settings file or directory:

```bash
node ./bin/deepcode.js --settings /path/to/settings.json "review this project"
```

After global linking, `deepcode` is available from any project directory:

```bash
npm link
deepcode "review this project"
```

## Current Scope

- Reads `DEEPSEEK_API_KEY` and `DEEPCODE_*` settings from `~/.deepcode/settings.json`, environment, and optional local `.env`
- Calls DeepSeek through the OpenAI-compatible Chat Completions API
- Runs a minimal agent loop with local tool execution
- Provides workspace read/search tools, guarded file writes, and guarded shell execution
- Blocks common sensitive and heavy paths such as `.env`, `.git`, and `node_modules`
