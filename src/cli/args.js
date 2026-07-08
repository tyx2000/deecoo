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
    settings: undefined,
    yes: false,
    yesFiles: false,
    help: false,
    taskParts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--cwd") {
      args.cwd = argv[++i];
    } else if (arg === "--model") {
      args.model = argv[++i];
    } else if (arg === "--settings") {
      args.settings = argv[++i];
    } else if (arg === "--yes" || arg === "-y") {
      args.yes = true;
    } else if (arg === "--yes-files" || arg === "--auto-approve-files") {
      args.yesFiles = true;
    } else if (!args.command && args.taskParts.length === 0 && (arg === "config" || APP_COMMANDS.has(arg))) {
      args.command = arg;
    } else if (args.command === "config" && !args.configAction) {
      args.configAction = arg;
    } else {
      args.taskParts.push(arg);
    }
  }

  return {
    command: args.command,
    configAction: args.configAction,
    cwd: args.cwd,
    model: args.model,
    settings: args.settings,
    yes: args.yes,
    yesFiles: args.yesFiles,
    help: args.help,
    taskParts: args.taskParts,
    task: args.taskParts.join(" "),
  };
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
    "  deecoo delete",
    "  deecoo eval",
    "  deecoo export",
    "  deecoo permissions",
    "  deecoo skills",
    "  deecoo trace",
    "  deecoo theme",
    "  deecoo usage",
    "  deecoo config <path|init|import-env|show>",
    "",
    "Running without a task starts an interactive session in the current workspace.",
    "Inside the session, type / to open the command menu.",
    "",
    "Options:",
    "  --cwd <path>         Workspace directory. Defaults to current directory.",
    "  --settings <path>    App settings file or directory. Defaults to " + appSettingsPath() + ".",
    "  --model <model>     Override DEECOO_MODEL.",
    "  --yes, -y           Auto-approve guarded shell commands.",
    "  --yes-files         Auto-approve workspace file writes for scripted runs.",
    "  --help, -h          Show help.",
  ].join("\n"));
}
