
import readline from "node:readline";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { handleConfigCommand } from "./commands/config.js";
import { parseEgressAllowlist } from "./permissions/egress.js";
import { createSecretRegistry, resolveSecretReference } from "./config/secrets.js";
import { runSlashCommand, runTopLevelCommand } from "./commands/dispatcher.js";
import { APP_COMMANDS, EXIT_SIGNAL, SLASH_COMMANDS, isExitCommand, printSlashHelp } from "./commands/registry.js";
import { parseArgs, applyPositionalCwd, printHelp } from "./cli/args.js";
import { getGitBranch } from "./cli/git.js";
import { createPrompter } from "./cli/prompter.js";
import { taskExitCode } from "./cli/exitStatus.js";
import { runTask } from "./agent/taskRunner.js";
import { loadConfig } from "./config/env.js";
import { addApprovedShellCommand, applySettingsEnv, loadSettingsEnv, resolveShellPermissions, setAutoApproveAllShellCommands } from "./config/settings.js";
import { ensureProjectDescription } from "./context/workspaceSnapshot.js";
import { createModelClient } from "./llm/clientFactory.js";
import { discoverModelMetadata } from "./llm/modelDiscovery.js";
import { createSessionStore } from "./session/store.js";
import { listCodexSkills, loadCodexSkill } from "./skills/install.js";
import { formatToolLine } from "./terminal/markdown.js";
import { readPromptLine } from "./terminal/select.js";
import { getThemeName, setTheme } from "./terminal/theme.js";
import { createToolRuntime } from "./tools/runtime.js";
import { runManagementCommand } from "./cli/management.js";
import { redact } from "./observability/audit.js";
import { structuredRunResult } from "./reporter/outputs.js";
import { loadDotEnvIfPresent } from "./cli/dotenv.js";
import { sessionPromptHistory, shortSessionId } from "./cli/sessionView.js";
import { buildInputPrompt, clearTerminal, createTerminalTitleManager, printStartupInfo } from "./cli/terminalUi.js";
import { filterWorkspacePathOptions, listWorkspacePathOptions } from "./cli/workspacePaths.js";
import { formatVersion, getVersionInfo } from "./version.js";

export async function main(argv) {
  let args;
  try { args = parseArgs(argv); return await mainInner(args); }
  catch (error) {
    const optionArgs = argv.slice(0, argv.indexOf("--") < 0 ? argv.length : argv.indexOf("--"));
    if (!args?.nonInteractive && !optionArgs.some((arg) => ["--json", "--jsonl", "--non-interactive"].includes(arg))) throw error;
    const secretRegistry = createSecretRegistry(process.env);
    console.log(JSON.stringify({ schemaVersion: 1, type: "error", error: redact({ code: error.code ?? "CLI_ERROR", message: error.message ?? String(error) }, { secretRegistry }) }));
    process.exitCode = 1;
  }
}

async function mainInner(args) {
  if (args.version) {
    const info = await getVersionInfo();
    console.log(args.outputFormat ? JSON.stringify({ schemaVersion: 1, type: "version", ...info }) : info.name + " " + formatVersion(info));
    return;
  }
  await applyPositionalCwd(args);
  if (args.help) {
    if (args.outputFormat) { console.log(JSON.stringify({ schemaVersion: 1, type: "help", usage: "deecoo [options] <task>", commands: [...APP_COMMANDS, "jobs", "memory", "storage", "changes"], machineOptions: ["--version", "--json", "--jsonl", "--non-interactive", "--sandbox", "--sandbox-network", "--acceptance", "--context-window", "--output-reserve", "--privacy", "--retention-days"] })); return; }
    printHelp();
    return;
  }

  if (args.command === "help") {
    if (args.outputFormat) { console.log(JSON.stringify({ schemaVersion: 1, type: "help", commands: [...APP_COMMANDS, "jobs", "memory", "storage", "changes"] })); return; }
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
    if (args.outputFormat) {
      const action = args.configAction ?? "show";
      if (!["show", "path"].includes(action) || args.provider || args.apiKey) throw new Error("Machine config supports only show or path");
      const secretRegistry = createSecretRegistry(process.env);
      console.log(JSON.stringify({ schemaVersion: 1, kind: "management-result", command: "config", action, ok: true, result: action === "path" ? { path: settings.path } : redact(settings, { secretRegistry }) }));
      return;
    }
    await handleConfigCommand(args);
    return;
  }

  const config = loadConfig(process.env, args, settings);
  // Dereference an indirect API key (file:PATH / env:NAME) so the raw secret need not be stored
  // in plaintext settings.json.
  if (!args.management) config.apiKey = (await resolveSecretReference(config.apiKey)) ?? config.apiKey;
  config.theme = setTheme(config.theme);
  const cwd = resolve(args.cwd ?? config.cwd ?? process.cwd());
  const secretRegistry = createSecretRegistry(process.env);
  if (config.apiKey) secretRegistry.add(config.apiKey, config.apiKeyEnv);
  if (args.acceptancePath) {
    const path = resolve(args.acceptancePath);
    if ((await stat(path)).size > 1024 * 1024) throw new Error("Acceptance contract exceeds 1MiB");
    const contract = JSON.parse(await readFile(path, "utf8"));
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error("Acceptance file must contain a JSON object");
    config.taskAcceptance = contract.acceptance ?? contract;
    config.requiredChecks = contract.requiredChecks ?? contract.acceptance?.requiredChecks;
  }
  const sessionStore = await createSessionStore(cwd, { privacyMode: config.privacyMode, retentionDays: config.retentionDays,
    maxBytes: config.storageMaxBytes, durableToolEvents: config.durableToolEvents, secretRegistry, autoPrune: !args.management });
  if (args.management) {
    const result = await runManagementCommand({ args, cwd, config, sessionStore });
    console.log(JSON.stringify(redact(result, { secretRegistry }), null, args.outputFormat ? undefined : 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (args.nonInteractive && !args.task.trim() && !args.command) throw new Error("Non-interactive execution requires an explicit task or management command");
  if (args.nonInteractive && args.command && !(args.command === "continue" && args.sessionId)) throw new Error("Non-interactive commands require an explicit local management command or continue --session ID");
  if (args.outputFormat === "jsonl") config.onEvent = (event) => console.log(JSON.stringify({ schemaVersion: 1, type: "event", event: redact(event, { secretRegistry }) }));
  const emitResult = (result) => {
    if (!args.outputFormat) return;
    const value = { ...structuredRunResult({ task: result.agentState?.task ?? args.task, result }), acceptance: result.acceptance, runId: result.runId, taskId: result.taskId, changes: result.changes, terminationSignal: result.terminationSignal };
    console.log(JSON.stringify({ schemaVersion: 1, type: "result", result: redact(value, { secretRegistry }) }));
  };
  const modelMetadata = discoverModelMetadata(config);
  const permissions = await resolveShellPermissions(settings.permissions, { workspace: cwd });
  const task = args.task.trim();
  const interactiveLaunch = !args.command && !task;
  const title = createTerminalTitleManager();
  if (!args.nonInteractive) title.set(`${basename(cwd) || cwd}###deecoo`);
  await initializeProjectDescription(cwd);

  config.modelMetadata ??= await modelMetadata;
  const client = createModelClient(config);
  const prompter = args.nonInteractive ? async () => "deny" : createPrompter(args.yes);
  const tools = createToolRuntime({
    cwd,
    prompter,
    allowShellWithoutPrompt: args.yes,
    permissionMode: args.yesFiles ? "workspace-write" : config.permissionMode,
    approvedShellCommands: permissions.shell.approvedCommands,
    autoApproveAllShell: permissions.shell.autoApproveAll,
    onApproveShellCommand: (command) => addApprovedShellCommand({ settingsPath: args.settings, command, workspace: cwd }),
    onApproveAllShellCommands: () => setAutoApproveAllShellCommands({ settingsPath: args.settings, workspace: cwd }),
    egressAllowlist: parseEgressAllowlist(config.egressAllowlist),
    executionStateDir: resolve(sessionStore.projectDir, "jobs"),
    sandboxPolicy: config.sandboxPolicy,
    env: process.env,
  });

  if (interactiveLaunch) {
    clearTerminal();
  }

  if (!args.nonInteractive) printStartupInfo([
    ["Version", formatVersion(await getVersionInfo())],
    ["Workspace", cwd],
    ["Provider", config.provider],
    ["Model", config.model],
    ["Context", `${client.capabilities.contextWindow} tokens (${client.capabilities.contextWindowSource})`],
    ["Permissions", tools.getPermissionMode()],
    ["Theme", getThemeName()],
  ]);

  try {
    if (args.nonInteractive && args.command === "continue") {
      const session = await sessionStore.loadSession(args.sessionId);
      const checkpoint = await sessionStore.loadCheckpoint(args.sessionId);
      if (!session || !checkpoint) throw new Error("The selected session has no resumable checkpoint");
      const result = await runInterruptibleTask({ client, tools, task: checkpoint.metadata?.task ?? "", cwd, config, sessionStore, session, envOverlay: settings.env, resumeCheckpoint: checkpoint });
      emitResult(result); process.exitCode = result.terminationSignal === "SIGTERM" ? 143 : taskExitCode(result); return;
    }
    if (args.command && APP_COMMANDS.has(args.command)) {
      await runTopLevelCommand({
        command: args.command,
        client,
        cwd,
        config,
        sessionStore,
        tools,
        settingsPath: args.settings,
        continueInterrupted: async ({ session, checkpoint }) => {
          const result = await runInterruptibleTask({ client, tools, task: checkpoint.metadata?.task ?? "", cwd, config, sessionStore, session,
            envOverlay: settings.env, resumeCheckpoint: checkpoint });
          process.exitCode = result.terminationSignal === "SIGTERM" ? 143 : taskExitCode(result);
        },
        startInteractive: (options = {}) =>
          runInteractiveSession({ client, tools, cwd, config, sessionStore, settingsPath: args.settings, envOverlay: settings.env, ...options }),
      });
      return;
    }

    if (!task) {
      await runInteractiveSession({ client, tools, cwd, config, sessionStore, settingsPath: args.settings, envOverlay: settings.env });
      return;
    }

    const session = await sessionStore.createSession({ model: config.model });
    const result = await runInterruptibleTask({ client, tools, task, cwd, config, sessionStore, session, envOverlay: settings.env });
    emitResult(result);
    process.exitCode = result.terminationSignal === "SIGTERM" ? 143 : taskExitCode(result);
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
  envOverlay = {},
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
        if (commandResult?.kind === "continue-task") {
          const result = await runInterruptibleTask({ client, tools, task: commandResult.checkpoint.metadata?.task ?? "", cwd, config,
            sessionStore, session, activeSkills, envOverlay, resumeCheckpoint: commandResult.checkpoint });
          if (result.terminationSignal) return;
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
      const result = await runInterruptibleTask({ client, tools, task, cwd, config, sessionStore, session, activeSkills, envOverlay });
      if (result.terminationSignal) return;
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
  const interrupt = installTaskInterrupt(params.config?.nonInteractive);
  try {
    const result = await runTask({ ...params, signal: interrupt.signal });
    if (interrupt.terminationSignal) {
      result.terminationSignal = interrupt.terminationSignal;
      process.exitCode = interrupt.terminationSignal === "SIGTERM" ? 143 : 130;
    }
    return result;
  } finally {
    interrupt.dispose();
  }
}

function installTaskInterrupt(nonInteractive = false) {
  const controller = new AbortController();
  let terminationSignal;
  const onSignal = (name) => {
    terminationSignal ??= name;
    if (!controller.signal.aborted) controller.abort(Object.assign(new Error(`Task interrupted by ${name}.`), { code: "ABORT_ERR" }));
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint); process.on("SIGTERM", onSigterm);
  const disposeSignals = () => { process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm); };
  if (nonInteractive || !process.stdin.isTTY) {
    return { signal: controller.signal, get terminationSignal() { return terminationSignal; }, dispose: disposeSignals };
  }

  const wasFlowing = process.stdin.readableFlowing;
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
  // emitKeypressEvents reuses its decoder and may leave a previously paused
  // stream paused; explicitly acquire input for Esc handling on every task.
  process.stdin.resume();

  return {
    signal: controller.signal,
    get terminationSignal() { return terminationSignal; },
    dispose() {
      disposeSignals();
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      // The keypress listener resumes stdin even when no prompt was opened. A
      // one-shot task must release that read handle so Node can exit naturally.
      if (wasFlowing !== true) process.stdin.pause();
      if (reported) process.stdout.write("\n");
    },
  };
}
