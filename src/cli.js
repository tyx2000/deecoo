import { execFile } from "node:child_process";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { analyzeTaskCoordination, runAgent } from "./agent/loop.js";
import { loadConfig } from "./config/env.js";
import {
  appSettingsPath,
  applySettingsEnv,
  collectSettingsEnv,
  defaultSettingsEnv,
  loadSettingsEnv,
  writeSettingsEnv,
} from "./config/settings.js";
import { createDeepSeekClient } from "./llm/deepseekClient.js";
import { buildSessionContext, createSessionStore, recordTurn } from "./session/store.js";
import { installCodexSkill, listCodexSkills, listProjectSkills, projectSkillsDir } from "./skills/install.js";
import {
  createAssistantStreamPrinter,
  formatActionPrompt,
  formatRunFooter,
  formatToolLine,
  printAssistantResponse,
  renderMarkdown,
} from "./terminal/markdown.js";
import { readPromptLine, selectOption } from "./terminal/select.js";
import { createSpinner } from "./terminal/spinner.js";
import { getThemeName, listThemes, paint, paintFixed, setTheme } from "./terminal/theme.js";
import { createToolRuntime } from "./tools/runtime.js";

const SLASH_COMMANDS = sortSlashCommands([
  { label: "/resume Select previous project conversation", value: "/resume" },
  { label: "/delete Delete previous project conversation", value: "/delete" },
  { label: "/export Export previous project conversation", value: "/export" },
  { label: "/permissions Select edit permission mode", value: "/permissions" },
  { label: "/skills Install a Codex skill into this project", value: "/skills" },
  { label: "/theme  Select terminal color theme", value: "/theme" },
  { label: "/model  Select active model", value: "/model" },
  { label: "/usage  Show API key balance/usage", value: "/usage" },
  { label: "/help   Show commands", value: "/help" },
  { label: "/exit   Leave DeepCode", value: "/exit" },
]);

const APP_COMMANDS = new Set(["model", "resume", "delete", "export", "permissions", "skills", "theme", "usage", "help"]);
const EXIT_SIGNAL = Symbol("exit");
const execFileAsync = promisify(execFile);
const ADD_STYLE = { fg: "#16a34a", effect: "bold" };
const DELETE_STYLE = { fg: "#dc2626", effect: "bold" };

export async function main(argv) {
  const args = parseArgs(argv);
  await applyPositionalCwd(args);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.command === "help") {
    printSlashHelp();
    return;
  }

  const settings = await loadSettingsEnv({ settingsPath: args.settings });
  applySettingsEnv(settings.env);

  await loadDotEnvIfPresent(process.cwd());
  if (args.cwd) {
    await loadDotEnvIfPresent(resolve(args.cwd));
  }
  if (!args.cwd && process.env.DEEPCODE_CWD) {
    await loadDotEnvIfPresent(resolve(process.env.DEEPCODE_CWD));
  }

  if (args.command === "config") {
    await handleConfigCommand(args);
    return;
  }

  const config = loadConfig(process.env, args);
  config.theme = setTheme(config.theme);
  const cwd = resolve(args.cwd ?? config.cwd ?? process.cwd());
  const task = args.task.trim();
  const title = createTerminalTitleManager();
  title.set(`${basename(cwd) || cwd}###deepcode`);

  const client = createDeepSeekClient(config);
  const prompter = createPrompter(args.yes);
  const tools = createToolRuntime({
    cwd,
    prompter,
    allowShellWithoutPrompt: args.yes,
    permissionMode: args.yes ? "workspace-write" : config.permissionMode,
  });
  const sessionStore = await createSessionStore(cwd);

  printStartupInfo([
    ["Workspace", cwd],
    ["Model", config.model],
    ["Permissions", tools.getPermissionMode()],
    ["Theme", getThemeName()],
  ]);

  try {
    if (args.command && APP_COMMANDS.has(args.command)) {
      await runTopLevelCommand({ command: args.command, client, cwd, config, sessionStore, tools, settingsPath: args.settings });
      return;
    }

    if (!task) {
      await runInteractiveSession({ client, tools, cwd, config, sessionStore, settingsPath: args.settings });
      return;
    }

    const session = await sessionStore.createSession({ model: config.model });
    await runTask({ client, tools, task, cwd, config, sessionStore, session });
  } finally {
    title.restore();
  }
}

async function runTopLevelCommand({ command, client, cwd, config, sessionStore, tools, settingsPath }) {
  if (command === "model") {
    await selectModel({ client, config, settingsPath });
    return;
  }
  if (command === "resume") {
    const session = await resumeSession({ sessionStore });
    if (session && process.stdin.isTTY && process.stdout.isTTY) {
      console.log("");
      await runInteractiveSession({ client, tools, cwd, config, sessionStore, initialSession: session, settingsPath });
    }
    return;
  }
  if (command === "delete") {
    await deleteSession({ sessionStore });
    return;
  }
  if (command === "export") {
    await exportSession({ sessionStore, cwd });
    return;
  }
  if (command === "permissions") {
    await selectPermissions({ config, tools });
    return;
  }
  if (command === "skills") {
    await installSkillCommand({ cwd });
    return;
  }
  if (command === "theme") {
    await selectTheme({ config, settingsPath });
    return;
  }
  if (command === "usage") {
    await showUsage({ client });
  }
}

async function handleConfigCommand(args) {
  const action = args.configAction ?? "help";

  if (action === "path") {
    const settings = await loadSettingsEnv({ settingsPath: args.settings });
    console.log(settings.path);
    return;
  }

  if (action === "init") {
    const importedEnv = collectSettingsEnv(process.env);
    const result = await writeSettingsEnv({
      settingsPath: args.settings,
      env: {
        ...defaultSettingsEnv(),
        ...importedEnv,
      },
    });
    console.log(`Wrote ${result.path}`);
    console.log("Set DEEPSEEK_API_KEY before running DeepCode if it was not already imported.");
    return;
  }

  if (action === "import-env") {
    const importedEnv = collectSettingsEnv(process.env);
    if (Object.keys(importedEnv).length === 0) {
      throw new Error("No supported environment variables found to import.");
    }

    const result = await writeSettingsEnv({ settingsPath: args.settings, env: importedEnv });
    console.log(`Wrote ${result.path}`);
    console.log(`Imported: ${Object.keys(importedEnv).sort().join(", ")}`);
    return;
  }

  if (action === "show") {
    const settings = await loadSettingsEnv({ settingsPath: args.settings });
    console.log(JSON.stringify(redactSecrets(settings.env), null, 2));
    return;
  }

  printConfigHelp();
}

async function runTask({ client, tools, task, cwd, config, sessionStore, session }) {
  const spinner = createSpinner("Thinking");
  const streamPrinter = createAssistantStreamPrinter();
  let streamed = false;
  const startedAt = Date.now();
  tools.resetTaskPermissions?.();
  const projectSkills = await listProjectSkills(cwd);
  const coordination = analyzeTaskCoordination(task);
  printCoordinationPlan(coordination);

  try {
    const result = await runAgent({
      client,
      tools,
      task,
      cwd,
      maxSteps: config.maxSteps,
      model: config.model,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      thinking: config.thinking,
      stream: config.stream,
      contextMessages: session ? buildSessionContext(session) : [],
      projectSkills,
      onModelStart: () => spinner.start(),
      onModelEnd: () => spinner.stop(),
      onToolStart: () => {},
      onToolEnd: ({ name, args, result }) => {
        spinner.stop();
        const reason = result?.cached ? "" : `${formatActivityReason({ name, args })}\n`;
        console.log(`${reason}${formatActivityLine({ name, args, result })}\n`);
      },
      onTextDelta: ({ content }) => {
        spinner.stop();
        streamed = true;
        streamPrinter.push(content);
      },
    });

    const elapsedMs = Date.now() - startedAt;
    const footer = formatRunFooter({
      elapsedMs,
      steps: result.steps,
      usage: result.usage,
      stoppedReason: result.stoppedReason,
    });
    if (streamed) {
      streamPrinter.finish(footer);
    } else {
      printAssistantResponse(result.finalText, footer);
    }
    if (session && sessionStore) {
      await recordTurn(sessionStore, session, {
        user: task,
        assistant: result.finalText,
        model: config.model,
      });
    }
    return {
      elapsedMs,
      usage: result.usage,
    };
  } catch (error) {
    spinner.stop();
    console.error(`Request failed after retries: ${error.message}`);
    return {
      elapsedMs: Date.now() - startedAt,
    };
  }
}

function formatActivityLine({ name, args, result }) {
  const activity = result?.activity ?? fallbackActivity(name, args, result);
  const icon = activityIcon(activity.kind);
  const label = result?.ok === false ? paint("error", `${activity.label} failed`) : paint("muted", activity.label);
  const target = activity.target ? ` ${paint("inlineCode", activity.target)}` : "";
  const detail = activity.detail ? ` ${paint("muted", activity.detail)}` : "";
  const changes = formatActivityChanges(activity);
  return `${paint("muted", icon)} ${label}${target}${changes}${detail}`;
}

function formatActivityReason({ name, args }) {
  const target = activityReasonTarget(args);
  return activityReasonText(name, target);
}

function activityReasonTarget(args) {
  return args?.path ?? args?.directory ?? args?.query ?? args?.command ?? "";
}

function activityReasonText(name, target) {
  const subject = target ? paint("inlineCode", truncateOneLine(target, 120)) : "the workspace";
  const withSubject = (prefix, suffix) => `${paint("muted", prefix)}${subject}${paint("muted", suffix)}`;
  const reasons = {
    list_files: () => withSubject("Inspecting ", " to understand the project structure before choosing the next step."),
    read_file: () => withSubject("Reading ", " to verify the current implementation before making changes."),
    search_text: () => withSubject("Searching for ", " to locate the relevant code path."),
    edit_file: () => withSubject("Updating ", " to apply the targeted change requested for this task."),
    write_file: () => withSubject("Writing ", " to persist the new or updated implementation."),
    git_status: () => paint("muted", "Checking git status to see which files changed in this workspace."),
    git_diff: () => paint("muted", "Reading the git diff to review the concrete code changes."),
    run_shell: () => withSubject("Running ", " to verify behavior or gather command output."),
  };
  return reasons[name]?.() ?? paint("muted", `Using ${name} to continue the task.`);
}

function fallbackActivity(name, args, result) {
  const target = args?.path ?? args?.directory ?? args?.command ?? "";
  return {
    kind: name,
    label: toolLabel(name),
    target,
    detail: result?.error,
  };
}

function toolLabel(name) {
  const labels = {
    read_file: "Read a file",
    list_files: "Listed files",
    search_text: "Searched code",
    edit_file: "Edited a file",
    write_file: "Wrote a file",
    git_status: "Checked git status",
    git_diff: "Read git diff",
    run_shell: "Ran command",
  };
  return labels[name] ?? `Ran ${name}`;
}

function activityIcon(kind) {
  if (kind === "read") return "▣";
  if (kind === "edit" || kind === "write" || kind === "create") return "✎";
  if (kind === "search") return "⌕";
  if (kind === "command") return "▻";
  if (kind === "git") return "⑂";
  return "•";
}

function formatActivityChanges(activity) {
  const additions = Number(activity.additions ?? 0);
  const deletions = Number(activity.deletions ?? 0);
  if (!additions && !deletions) return "";
  return ` ${paintFixed(ADD_STYLE, `+${additions}`)} ${paintFixed(DELETE_STYLE, `-${deletions}`)}`;
}

function printCoordinationPlan(coordination) {
  if (!coordination?.complex) return;
  console.log(paint("title", "Coordination"));
  console.log(paint("muted", `Request type: ${coordination.requestType}`));
  console.log(paint("muted", "Split basis:"));
  for (const basis of coordination.basis) {
    console.log(`${paint("muted", "  -")} ${basis}`);
  }
  console.log(paint("muted", "Agents:"));
  for (const agent of coordination.agents) {
    console.log(`${paint("muted", "  -")} ${paint("inlineCode", agent.name)} ${paint("muted", agent.goal)}`);
  }
  console.log(paint("muted", "Execution: current runtime coordinates these roles in one agent; parallel subagent runner is not enabled yet."));
  console.log("");
}

async function runInteractiveSession({ client, tools, cwd, config, sessionStore, initialSession, settingsPath }) {
  let session = initialSession;
  let branch = await getGitBranch(cwd);

  try {
    while (true) {
      const prompt = buildInputPrompt({ config, cwd, branch });
      const task = (
        await readPromptLine(prompt, SLASH_COMMANDS, {
          history: session ? sessionPromptHistory(session) : undefined,
        })
      ).trim();
      if (!task) continue;
      if (isExitCommand(task)) break;
      if (task.startsWith("/")) {
        const commandResult = await runSlashCommand({ command: task, client, config, sessionStore, tools, cwd, settingsPath });
        if (commandResult === EXIT_SIGNAL) break;
        if (commandResult?.kind === "session") {
          session = commandResult.session;
        }
        if (commandResult?.kind === "delete" && commandResult.deletedSessionId === session?.id) {
          session = await sessionStore.createSession({ model: config.model });
          console.log(formatToolLine(`new conversation: ${shortSessionId(session.id)}`));
        }
        console.log("");
        continue;
      }
      if (!session) {
        session = await sessionStore.createSession({ model: config.model });
        console.log(formatToolLine(`session: ${session.title}`));
      }
      await runTask({ client, tools, task, cwd, config, sessionStore, session });
      branch = await getGitBranch(cwd);
      console.log("");
    }
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }
}

function buildInputPrompt({ config, cwd, branch }) {
  const parts = ["deepcode", config.model, basename(cwd) || cwd];
  if (branch) parts.push(branch);
  const status = parts.join(" >> ");
  if (!process.stdout.isTTY) return `${status}\n> `;
  return `${paint("title", status)}\n${paint("prompt", ">")} `;
}

function printStartupInfo(entries) {
  const width = Math.max(...entries.map(([label]) => label.length));
  console.log("");
  for (const [label, value] of entries) {
    console.log(paint("title", `${label.padStart(width)} : ${value}`));
  }
  console.log("");
}

async function getGitBranch(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") return "";
    return branch;
  } catch {
    return "";
  }
}

async function runSlashCommand({ command, client, config, sessionStore, tools, cwd, settingsPath }) {
  if (isExitCommand(command)) {
    return EXIT_SIGNAL;
  }

  if (command === "/help") {
    printSlashHelp();
    return;
  }

  if (command === "/model") {
    await selectModel({ client, config, settingsPath });
    return;
  }

  if (command === "/usage") {
    await showUsage({ client });
    return;
  }

  if (command === "/permissions") {
    await selectPermissions({ config, tools });
    return;
  }

  if (command === "/skills") {
    await installSkillCommand({ cwd });
    return;
  }

  if (command === "/theme") {
    await selectTheme({ config, settingsPath });
    return;
  }

  if (command === "/resume") {
    const session = await resumeSession({ sessionStore });
    return session ? { kind: "session", session } : undefined;
  }

  if (command === "/delete") {
    const deleted = await deleteSession({ sessionStore });
    return deleted ? { kind: "delete", deletedSessionId: deleted.id } : undefined;
  }

  if (command === "/export") {
    await exportSession({ sessionStore, cwd });
    return;
  }

  console.log(`Unknown command: ${command}`);
  printSlashHelp();
}

function isExitCommand(value) {
  const command = String(value ?? "").trim().toLowerCase();
  return command === "/exit" || command === "exit" || command === "quit";
}

async function selectPermissions({ config, tools }) {
  const modes = [
    {
      label: "ask-once          Confirm first file edit per task, then allow rest of task",
      value: "ask-once",
    },
    {
      label: "ask-every-edit    Confirm every file edit",
      value: "ask-every-edit",
    },
    {
      label: "workspace-write   Allow file edits inside workspace",
      value: "workspace-write",
    },
    {
      label: "read-only         Block file edits",
      value: "read-only",
    },
  ];
  const selected = await selectOption({
    title: "Permission mode",
    options: modes,
    selectedIndex: Math.max(0, modes.findIndex((mode) => mode.value === tools.getPermissionMode())),
  });

  if (!selected) return;
  config.permissionMode = selected.value;
  tools.setPermissionMode(selected.value);
  console.log(`Permissions: ${selected.value}`);
}

async function selectTheme({ config, settingsPath }) {
  const themes = listThemes();
  const selected = await selectOption({
    title: "Theme",
    options: themes.map((theme) => ({ label: theme.label, value: theme.name })),
    selectedIndex: Math.max(0, themes.findIndex((theme) => theme.name === getThemeName())),
  });

  if (!selected) return;
  config.theme = setTheme(selected.value);
  await persistSetting({ settingsPath, env: { DEEPCODE_THEME: getThemeName() } });
  console.log(paint("success", `Theme: ${getThemeName()}`));
}

async function resumeSession({ sessionStore }) {
  const sessions = await sessionStore.listSessions();
  if (sessions.length === 0) {
    console.log("No previous conversations for this project.");
    return undefined;
  }

  const selected = await selectOption({
    title: "Resume conversation",
    options: sessions.map((session) => ({
      label: sessionOptionLabel(session),
      value: session,
    })),
  });

  if (!selected) return undefined;
  printSessionTranscript(selected.value);
  return selected.value;
}

async function deleteSession({ sessionStore }) {
  const sessions = await sessionStore.listSessions();
  if (sessions.length === 0) {
    console.log("No previous conversations for this project.");
    return undefined;
  }

  const selected = await selectOption({
    title: "Delete conversation",
    options: sessions.map((session) => ({
      label: sessionOptionLabel(session),
      value: session,
    })),
  });
  if (!selected) return undefined;

  const session = selected.value;
  const confirmed = await selectOption({
    title: `Delete ${shortSessionId(session.id)} permanently?`,
    options: [
      { label: "Cancel", value: false },
      { label: "Delete", value: true },
    ],
    selectedIndex: 0,
    filterable: false,
  });

  if (!confirmed?.value) {
    console.log("Delete canceled.");
    return undefined;
  }

  await sessionStore.deleteSession(session.id);
  console.log(`Deleted conversation: ${shortSessionId(session.id)}  ${sessionSummary(session)}`);
  return session;
}

async function exportSession({ sessionStore, cwd }) {
  const sessions = await sessionStore.listSessions();
  if (sessions.length === 0) {
    console.log("No previous conversations for this project.");
    return undefined;
  }

  const selected = await selectOption({
    title: "Export conversation",
    options: sessions.map((session) => ({
      label: sessionOptionLabel(session),
      value: session,
    })),
  });
  if (!selected) return undefined;

  const session = selected.value;
  const outputPath = join(resolve(session.cwd ?? cwd), exportFileName(session));
  await writeFile(outputPath, sessionToMarkdown(session), "utf8");
  console.log(`Exported conversation: ${outputPath}`);
  return outputPath;
}

async function installSkillCommand({ cwd }) {
  const spinner = createSpinner("Loading skills");
  spinner.start();
  try {
    const skills = await listCodexSkills();
    spinner.stop();
    if (skills.length === 0) {
      console.log("No Codex skills found.");
      return undefined;
    }

    const selected = await selectOption({
      title: "Install skill",
      options: skills.map((skill) => ({
        label: `${skill.name.padEnd(28)} ${skill.sourceLabel.padEnd(8)} ${skill.summary}`,
        value: skill,
      })),
    });
    if (!selected) return undefined;

    const targetPath = await installCodexSkill({ skill: selected.value, cwd });
    console.log(`Installed skill: ${selected.value.name}`);
    console.log(`Target: ${targetPath}`);
    console.log(`Project skills: ${projectSkillsDir(cwd)}`);
    return targetPath;
  } catch (error) {
    spinner.stop();
    console.error(`Unable to install skill: ${error.message}`);
    return undefined;
  }
}

async function selectModel({ client, config, settingsPath }) {
  const spinner = createSpinner("Loading models");
  spinner.start();

  try {
    const result = await client.listModels();
    spinner.stop();
    const models = normalizeModels(result);
    if (models.length === 0) {
      console.log("No models returned by provider.");
      return;
    }

    const selected = await selectOption({
      title: "Select model",
      options: models.map((model) => ({ label: model, value: model })),
      selectedIndex: Math.max(0, models.indexOf(config.model)),
    });

    if (!selected) return;
    config.model = selected.value;
    await persistSetting({ settingsPath, env: { DEEPCODE_MODEL: config.model } });
    console.log(`Model: ${config.model}`);
  } catch (error) {
    spinner.stop();
    console.error(`Unable to load models after retries: ${error.message}`);
  }
}

async function showUsage({ client }) {
  const spinner = createSpinner("Loading usage");
  spinner.start();

  try {
    const balance = await client.getBalance();
    spinner.stop();
    printUsage(balance);
  } catch (error) {
    spinner.stop();
    console.error(`Unable to load usage after retries: ${error.message}`);
  }
}

function normalizeModels(result) {
  if (Array.isArray(result?.data)) {
    return result.data.map((item) => item.id).filter(Boolean);
  }
  if (Array.isArray(result?.models)) {
    return result.models.map((item) => item.id ?? item).filter(Boolean);
  }
  return [];
}

function printUsage(balance) {
  if (Array.isArray(balance?.balance_infos)) {
    for (const info of balance.balance_infos) {
      console.log(
        `${info.currency ?? "balance"}: total=${info.total_balance ?? "-"} granted=${info.granted_balance ?? "-"} topped_up=${info.topped_up_balance ?? "-"}`,
      );
    }
    if (balance.is_available !== undefined) {
      console.log(`available: ${balance.is_available}`);
    }
    return;
  }

  console.log(JSON.stringify(balance, null, 2));
}

function printSlashHelp() {
  console.log(`Commands:\n${SLASH_COMMANDS.map((command) => `  ${command.label}`).join("\n")}`);
}

function sortSlashCommands(commands) {
  return [...commands].sort((a, b) => {
    if (a.value === "/exit") return 1;
    if (b.value === "/exit") return -1;
    return a.value.localeCompare(b.value);
  });
}

function formatSessionTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number) => String(number).padStart(2, "0");
  return [
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

function shortSessionId(id) {
  return String(id).slice(0, 8);
}

function sessionOptionLabel(session) {
  return `${shortSessionId(session.id).padEnd(8)}  ${formatSessionTime(session.updatedAt)}  ${sessionSummary(session)}`;
}

function sessionSummary(session) {
  const source = session.history?.[0]?.user || session.turns[0]?.user || session.summary || session.title || "Untitled session";
  return String(source).replace(/\s+/g, " ").trim().slice(0, 80);
}

function printSessionTranscript(session) {
  console.log(
    `Active session: ${shortSessionId(session.id)}  ${formatSessionTime(session.updatedAt)}  ${sessionSummary(session)}`,
  );
  if (session.summary) {
    console.log("");
    console.log(formatToolLine("summary"));
    console.log(renderMarkdown(session.summary));
  }

  const turns = sessionHistory(session);
  if (turns.length === 0) {
    console.log("");
    console.log(formatToolLine("No recorded turns."));
    return;
  }

  console.log("");
  console.log(formatToolLine("conversation"));
  for (const [index, turn] of turns.entries()) {
    console.log("");
    console.log(paint("title", `Turn ${index + 1}  ${formatSessionTime(turn.at)}`));
    console.log(paint("muted", "User"));
    console.log(renderMarkdown(turn.user?.trim() || "_empty_"));
    console.log("");
    console.log(paint("muted", "Assistant"));
    console.log(renderMarkdown(turn.assistant?.trim() || "_empty_"));
  }
}

function exportFileName(session) {
  const time = formatSessionTime(session.updatedAt).replace(/[/: ]/g, "-");
  const title = slugify(sessionSummary(session)).slice(0, 48) || "conversation";
  return `deepcode-session-${shortSessionId(session.id)}-${time}-${title}.md`;
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function sessionToMarkdown(session) {
  const lines = [
    `# DeepCode Conversation ${shortSessionId(session.id)}`,
    "",
    `- Session ID: ${session.id}`,
    `- Project: ${session.cwd}`,
    `- Title: ${session.title ?? sessionSummary(session)}`,
    `- Model: ${session.model ?? "-"}`,
    `- Created: ${formatSessionTime(session.createdAt)}`,
    `- Updated: ${formatSessionTime(session.updatedAt)}`,
    "",
  ];

  if (session.summary) {
    lines.push("## Summary", "", session.summary.trim(), "");
  }

  lines.push("## Turns", "");
  const turns = sessionHistory(session);
  if (!turns.length) {
    lines.push("_No recorded turns._", "");
  }

  for (const [index, turn] of turns.entries()) {
    lines.push(`### Turn ${index + 1} - ${formatSessionTime(turn.at)}`, "");
    lines.push("#### User", "", turn.user?.trim() || "_empty_", "");
    lines.push("#### Assistant", "", turn.assistant?.trim() || "_empty_", "");
    if (turn.model) {
      lines.push(`_Model: ${turn.model}_`, "");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function sessionPromptHistory(session) {
  return sessionHistory(session).map((turn) => turn.user).filter(Boolean);
}

function sessionHistory(session) {
  return Array.isArray(session.history) ? session.history : session.turns ?? [];
}

function truncateOneLine(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function loadDotEnvIfPresent(directory) {
  const path = resolve(directory, ".env");
  try {
    await access(path);
  } catch {
    return;
  }

  const content = await readFile(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!isSupportedDotEnvKey(key) || process.env[key] !== undefined) continue;
    process.env[key] = stripQuotes(rawValue.trim());
  }
}

function isSupportedDotEnvKey(key) {
  return key === "DEEPSEEK_API_KEY" || key.startsWith("DEEPCODE_");
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    command: undefined,
    configAction: undefined,
    cwd: undefined,
    model: undefined,
    maxSteps: undefined,
    settings: undefined,
    yes: false,
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
    } else if (arg === "--max-steps") {
      args.maxSteps = Number(argv[++i]);
    } else if (arg === "--settings") {
      args.settings = argv[++i];
    } else if (arg === "--yes" || arg === "-y") {
      args.yes = true;
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
    maxSteps: args.maxSteps,
    settings: args.settings,
    yes: args.yes,
    help: args.help,
    taskParts: args.taskParts,
    task: args.taskParts.join(" "),
  };
}

async function applyPositionalCwd(args) {
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

function createTerminalTitleManager() {
  let changed = false;
  return {
    set(title) {
      if (!process.stdout.isTTY) return;
      changed = true;
      writeTerminalTitle(title);
    },
    restore() {
      if (!changed) return;
      writeTerminalTitle("");
    },
  };
}

function writeTerminalTitle(title) {
  process.stdout.write(`\x1B]0;${title}\x07`);
}

function redactSecrets(env) {
  const redacted = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = isSecretKey(key) ? "********" : value;
  }
  return redacted;
}

function isSecretKey(key) {
  return (
    /(^|_)API_KEY$/i.test(key) ||
    /(^|_)SECRET(_|$)/i.test(key) ||
    /(^|_)PASSWORD$/i.test(key) ||
    /(^|_)(ACCESS|REFRESH)_TOKEN$/i.test(key)
  );
}

function printConfigHelp() {
  console.log(`Usage:
  deepcode config path
  deepcode config init
  deepcode config import-env
  deepcode config show

Config defaults to ${appSettingsPath()}.
Use --settings <path> to override the settings file or directory.
`);
}

async function persistSetting({ settingsPath, env }) {
  try {
    await writeSettingsEnv({ settingsPath, env });
  } catch (error) {
    console.error(`Unable to persist setting: ${error.message}`);
  }
}

function createPrompter(autoYes) {
  return async (question, options = {}) => {
    if (autoYes) return true;
    if (
      (options.kind === "file-write-approval" || options.kind === "shell-command-approval") &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const selected = await selectOption({
        title: question,
        options: [
          { label: "Approve", value: "approve" },
          { label: "Deny", value: "deny" },
          { label: "Always Approve", value: "always" },
        ],
        filterable: false,
      });
      return selected?.value ?? "deny";
    }
    const answer = await readPromptLine(`${formatActionPrompt(question)} [y/N] `, []);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  };
}

function printHelp() {
  console.log(`Usage:
  deepcode [options]
  deepcode [options] <task>
  deepcode model
  deepcode resume
  deepcode delete
  deepcode export
  deepcode permissions
  deepcode skills
  deepcode theme
  deepcode usage
  deepcode config <path|init|import-env|show>

Running without a task starts an interactive session in the current workspace.
Inside the session, type / to open the command menu.

Options:
  --cwd <path>         Workspace directory. Defaults to current directory.
  --settings <path>    App settings file or directory. Defaults to ${appSettingsPath()}.
  --model <model>     Override DEEPCODE_MODEL.
  --max-steps <n>     Override DEEPCODE_MAX_STEPS.
  --yes, -y           Auto-approve guarded shell commands.
  --help, -h          Show help.
`);
}
