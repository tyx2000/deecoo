import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { appSettingsPath } from "../config/settings.js";
import { APP_COMMANDS } from "../commands/registry.js";

export function parseArgs(argv) {
  const args = {
    command: undefined,
    configAction: undefined,
    cwd: undefined,
    model: undefined,
    provider: undefined,
    apiKey: undefined,
    settings: undefined,
    yes: false,
    yesFiles: false,
    help: false,
    taskParts: [],
  };

  const valueOptions = new Map([
    ["--acceptance", "acceptancePath"], ["--sandbox", "sandbox"], ["--sandbox-network", "sandboxNetwork"],
    ["--context-window", "contextWindow"], ["--output-reserve", "outputReserve"], ["--privacy", "privacyMode"],
    ["--retention-days", "retentionDays"], ["--storage-max-bytes", "storageMaxBytes"], ["--session", "sessionId"],
    ["--scope", "scope"], ["--text", "memoryText"], ["--expires-at", "expiresAt"], ["--path", "path"],
    ["--stream", "outputStream"], ["--offset", "offset"], ["--max-bytes", "maxBytes"], ["--output", "outputPath"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") { args.taskParts.push(...argv.slice(i + 1)); break; }
    if (valueOptions.has(arg)) {
      args[valueOptions.get(arg)] = requiredOptionValue(argv, i, arg); i += 1;
    } else if (arg === "--json" || arg === "--jsonl") {
      const outputFormat = arg.slice(2);
      if (args.outputFormat && args.outputFormat !== outputFormat) throw new Error("Choose only --json or --jsonl");
      args.outputFormat = outputFormat; args.nonInteractive = true;
    } else if (arg === "--non-interactive") args.nonInteractive = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--include-expired") args.includeExpired = true;
    else if (arg === "--durable-tool-events") args.durableToolEvents = true;
    else if (arg === "--hunk") { args.hunkIds ??= []; args.hunkIds.push(requiredOptionValue(argv, i, arg)); i += 1; }
    else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--cwd") {
      args.cwd = requiredOptionValue(argv, i, arg); i += 1;
    } else if (arg === "--task-mode") {
      const mode = requiredOptionValue(argv, i, arg);
      if (!["edit", "debug", "review", "analysis", "command", "general", "read-only"].includes(mode)) throw new Error("Invalid task mode: " + mode);
      args.taskMode = mode;
      i += 1;
    } else if (arg === "--model") {
      args.model = requiredOptionValue(argv, i, arg); i += 1;
    } else if (args.command === "config" && (arg === "-provider" || arg === "--provider")) {
      args.provider = requiredOptionValue(argv, i, arg);
      i += 1;
    } else if (args.command === "config" && (arg === "-key" || arg === "--key")) {
      args.apiKey = requiredOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === "--settings") {
      args.settings = requiredOptionValue(argv, i, arg); i += 1;
    } else if (arg === "--yes" || arg === "-y") {
      args.yes = true;
    } else if (arg === "--yes-files" || arg === "--auto-approve-files") {
      args.yesFiles = true;
    } else if (!args.command && args.taskParts.length === 0 && (arg === "config" || ["jobs", "memory", "storage", "changes"].includes(arg) || APP_COMMANDS.has(arg))) {
      args.command = arg;
    } else if (args.command === "config" && !args.configAction) {
      args.configAction = arg;
    } else if (arg.startsWith("--")) {
      throw new Error("Unknown option: " + arg + "; use -- before literal task arguments");
    } else {
      args.taskParts.push(arg);
    }
  }

  for (const [key, allowed] of [["sandbox", ["off", "auto", "required"]], ["sandboxNetwork", ["deny", "allow"]], ["privacyMode", ["standard", "redacted", "ephemeral"]], ["scope", ["project", "global", "all"]], ["outputStream", ["stdout", "stderr"]]]) {
    if (args[key] !== undefined && !allowed.includes(args[key])) throw new Error(`Invalid ${key}: ${args[key]}`);
  }
  for (const key of ["contextWindow", "outputReserve", "retentionDays", "storageMaxBytes", "offset", "maxBytes"]) {
    if (args[key] === undefined) continue;
    const value = Number(args[key]);
    if (!Number.isSafeInteger(value) || value < 0 || (["contextWindow", "maxBytes"].includes(key) && value === 0)) throw new Error(`Invalid ${key}: ${args[key]}`);
    args[key] = value;
  }
  if (args.nonInteractive) args.outputFormat ??= "json";
  return { ...args, management: ["jobs", "memory", "storage", "changes"].includes(args.command), task: args.taskParts.join(" ") };
}

function requiredOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
  return value;
}

export async function applyPositionalCwd(args) {
  if (args.cwd || args.command || args.taskParts.length === 0) return;
  const candidate = resolve(args.taskParts[0]);
  let info;
  try {
    info = await stat(candidate);
  } catch {
    return;
  }
  if (!info.isDirectory()) return;
  args.cwd = candidate;
  args.taskParts = args.taskParts.slice(1);
  args.task = args.taskParts.join(" ");
}

export function printHelp() {
  console.log([
    "Usage:",
    "  deecoo [options]",
    "  deecoo [options] <task>",
    "  deecoo model",
    "  deecoo resume",
    "  deecoo continue",
    "  deecoo delete",
    "  deecoo eval",
    "  deecoo export",
    "  deecoo permissions",
    "  deecoo skills",
    "  deecoo trace",
    "  deecoo theme",
    "  deecoo usage",
    "  deecoo jobs <status ID|output ID|stop ID|capabilities>",
    "  deecoo memory <list|edit ID --text TEXT|delete ID|prune> [--scope project|global|all]",
    "  deecoo storage <status|prune> [--dry-run]",
    "  deecoo changes <list|show ID|accept ID|undo ID|export ID> [--path FILE] [--hunk ID]",
    "  deecoo config -provider <deepseek|openai|anthropic> -key <api-key>",
    "  deecoo config <path|init|import-env|show|reset-shell-approvals>",
    "",
    "Running without a task starts an interactive session in the current workspace.",
    "Inside the session, type / to open the command menu.",
    "",
    "Options:",
    "  --cwd <path>         Workspace directory. Defaults to current directory.",
    "  --settings <path>    App settings file or directory. Defaults to " + appSettingsPath() + ".",
    "  --task-mode <mode>  Explicit edit/debug/review/analysis/command/read-only intent.",
    "  --model <model>     Override DEECOO_MODEL.",
    "  --yes, -y           Auto-approve guarded shell commands.",
    "  --yes-files         Auto-approve workspace file writes for scripted runs.",
    "  --json | --jsonl    Quiet structured results; JSONL also emits run events.",
    "  --non-interactive   Never prompt; requires a task or explicit local command.",
    "  --sandbox <mode>    off, auto, or required; --sandbox-network deny|allow.",
    "  --acceptance <file> Explicit JSON acceptance and required checks.",
    "  --context-window N --output-reserve N  Model context token limits.",
    "  --privacy <mode>    standard, redacted, or ephemeral storage.",
    "  --retention-days N --storage-max-bytes N --durable-tool-events",
    "  --                  Treat all following values as literal task/command arguments.",
    "  --help, -h          Show help.",
  ].join("\n"));
}
