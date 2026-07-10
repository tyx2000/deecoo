
import readline from "node:readline";
import { basename, resolve } from "node:path";
import { handleConfigCommand } from "./commands/config.js";
import { parseEgressAllowlist } from "./permissions/egress.js";
import { runSlashCommand, runTopLevelCommand } from "./commands/dispatcher.js";
import { APP_COMMANDS, EXIT_SIGNAL, SLASH_COMMANDS, isExitCommand, printSlashHelp } from "./commands/registry.js";
import { parseArgs, applyPositionalCwd, printHelp } from "./cli/args.js";
import { getGitBranch } from "./cli/git.js";
import { createPrompter } from "./cli/prompter.js";
import { runTask } from "./agent/taskRunner.js";
import { loadConfig } from "./config/env.js";
import { addApprovedShellCommand, applySettingsEnv, loadSettingsEnv, setAutoApproveAllShellCommands } from "./config/settings.js";
import { ensureProjectDescription } from "./context/workspaceSnapshot.js";
import { createDeepSeekClient } from "./llm/deepseekClient.js";
import { createSessionStore } from "./session/store.js";
import { listCodexSkills, loadCodexSkill } from "./skills/install.js";
import { formatToolLine } from "./terminal/markdown.js";
import { readPromptLine } from "./terminal/select.js";
import { getThemeName, setTheme } from "./terminal/theme.js";
import { createToolRuntime } from "./tools/runtime.js";
import { loadDotEnvIfPresent } from "./cli/dotenv.js";
import { sessionPromptHistory, shortSessionId } from "./cli/sessionView.js";
import { buildInputPrompt, clearTerminal, createTerminalTitleManager, printStartupInfo } from "./cli/terminalUi.js";
import { filterWorkspacePathOptions, listWorkspacePathOptions } from "./cli/workspacePaths.js";

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
  applySettingsEnv(settings.env, { overrideKeys: ["DEECOO_MODEL", "DEECOO_THEME"] });

  await loadDotEnvIfPresent(process.cwd());
  if (args.cwd) {
    await loadDotEnvIfPresent(resolve(args.cwd));
  }
  if (!args.cwd && process.env.DEECOO_CWD) {
    await loadDotEnvIfPresent(resolve(process.env.DEECOO_CWD));
  }

  if (args.command === "config") {
    await handleConfigCommand(args);
    return;
  }

  const config = loadConfig(process.env, args);
  config.theme = setTheme(config.theme);
  const cwd = resolve(args.cwd ?? config.cwd ?? process.cwd());
  const task = args.task.trim();
  const interactiveLaunch = !args.command && !task;
  const title = createTerminalTitleManager();
  title.set(`${basename(cwd) || cwd}###deecoo`);
  await initializeProjectDescription(cwd);

  const client = createDeepSeekClient(config);
  const prompter = createPrompter(args.yes);
  const tools = createToolRuntime({
    cwd,
    prompter,
    allowShellWithoutPrompt: args.yes,
    permissionMode: args.yesFiles ? "workspace-write" : config.permissionMode,
    approvedShellCommands: settings.permissions.shell.approvedCommands,
    autoApproveAllShell: settings.permissions.shell.autoApproveAll,
    onApproveShellCommand: (command) => addApprovedShellCommand({ settingsPath: args.settings, command }),
    onApproveAllShellCommands: () => setAutoApproveAllShellCommands({ settingsPath: args.settings }),
    egressAllowlist: parseEgressAllowlist(config.egressAllowlist),
  });
  const sessionStore = await createSessionStore(cwd);

  if (interactiveLaunch) {
    clearTerminal();
  }

  printStartupInfo([
    ["Workspace", cwd],
    ["Model", config.model],
    ["Permissions", tools.getPermissionMode()],
    ["Theme", getThemeName()],
  ]);

  try {
    if (args.command && APP_COMMANDS.has(args.command)) {
      await runTopLevelCommand({
        command: args.command,
        client,
        cwd,
        config,
        sessionStore,
        tools,
        settingsPath: args.settings,
        startInteractive: (options = {}) =>
          runInteractiveSession({ client, tools, cwd, config, sessionStore, settingsPath: args.settings, ...options }),
      });
      return;
    }

    if (!task) {
      await runInteractiveSession({ client, tools, cwd, config, sessionStore, settingsPath: args.settings });
      return;
    }

    const session = await sessionStore.createSession({ model: config.model });
    await runInterruptibleTask({ client, tools, task, cwd, config, sessionStore, session });
  } finally {
    title.restore();
  }
}

async function initializeProjectDescription(cwd) {
  try {
    await ensureProjectDescription(cwd);
  } catch {
    // Startup context is best-effort; readonly or non-git workspaces should still launch.
  }
}

async function loadSkillCatalog() {
  try {
    return await listCodexSkills();
  } catch {
    return [];
  }
}

function addActiveSkill(activeSkills, skill) {
  const index = activeSkills.findIndex((item) => item.id === skill.id);
  if (index >= 0) {
    activeSkills[index] = skill;
    return;
  }
  activeSkills.push(skill);
}

async function runInteractiveSession({
  client,
  tools,
  cwd,
  config,
  sessionStore,
  initialSession,
  settingsPath,
  initialActiveSkills = [],
}) {
  let session = initialSession;
  const activeSkills = [...initialActiveSkills];
  const skillCatalog = await loadSkillCatalog();
  let branch = await getGitBranch(cwd);

  try {
    while (true) {
      const prompt = buildInputPrompt({ config, cwd, branch });
      const pathOptions = await listWorkspacePathOptions(cwd);
      const task = (
        await readPromptLine(prompt, SLASH_COMMANDS, {
          history: session ? sessionPromptHistory(session) : undefined,
          triggers: [
            {
              trigger: "@",
              options: pathOptions,
              filterOptions: filterWorkspacePathOptions,
              finalizeOnSpace: true,
            },
            {
              trigger: "$",
              options: skillCatalog.map((skill) => ({
                label: `${skill.name.padEnd(28)} ${skill.sourceLabel.padEnd(8)} ${skill.summary}`,
                columns: [skill.name, skill.sourceLabel, skill.summary],
                value: skill,
                insertText: "",
              })),
              onSelect: async (option) => {
                const skill = await loadCodexSkill(option.value);
                addActiveSkill(activeSkills, skill);
                return { replacement: `$${skill.name} ` };
              },
            },
          ],
        })
      ).trim();
      if (!task) continue;
      if (isExitCommand(task)) break;
      if (task.startsWith("/")) {
        const commandResult = await runSlashCommand({
          command: task,
          client,
          config,
          sessionStore,
          tools,
          cwd,
          settingsPath,
          session,
        });
        if (commandResult === EXIT_SIGNAL) break;
        if (commandResult?.kind === "session") {
          session = commandResult.session;
        }
        if (commandResult?.kind === "skill") {
          addActiveSkill(activeSkills, commandResult.skill);
          console.log(formatToolLine(`active skill: ${commandResult.skill.name}`));
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
      await runInterruptibleTask({ client, tools, task, cwd, config, sessionStore, session, activeSkills });
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


async function runInterruptibleTask(params) {
  const interrupt = installTaskInterrupt();
  try {
    return await runTask({ ...params, signal: interrupt.signal });
  } finally {
    interrupt.dispose();
  }
}

function installTaskInterrupt() {
  const controller = new AbortController();
  if (!process.stdin.isTTY) {
    return { signal: controller.signal, dispose() {} };
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  let reported = false;
  const onKeypress = (_str, key = {}) => {
    if (key.name !== "escape" || controller.signal.aborted) return;
    reported = true;
    controller.abort(new Error("Task interrupted by Esc."));
    process.stdout.write("\n" + formatToolLine("interrupted: Esc") + "\n");
  };
  process.stdin.on("keypress", onKeypress);

  return {
    signal: controller.signal,
    dispose() {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      if (reported) process.stdout.write("\n");
    },
  };
}
