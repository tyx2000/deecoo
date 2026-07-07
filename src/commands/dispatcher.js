import {
  deleteSession,
  exportSession,
  forkSession,
  loadSkillCommand,
  resumeSession,
  selectModel,
  selectPermissions,
  selectTheme,
  showTrace,
  showUsage,
} from "./actions.js";
import { EXIT_SIGNAL, isExitCommand, printSlashHelp } from "./registry.js";
import { shortSessionId } from "../cli/sessionView.js";

export async function runTopLevelCommand({ command, client, cwd, config, sessionStore, tools, settingsPath, startInteractive }) {
  if (command === "model") {
    await selectModel({ client, config, settingsPath });
    return;
  }
  if (command === "resume") {
    const session = await resumeSession({ sessionStore });
    if (session && isInteractiveTerminal()) {
      console.log("");
      await startInteractive({ initialSession: session });
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
    const skill = await loadSkillCommand();
    if (skill && isInteractiveTerminal()) {
      console.log("");
      await startInteractive({ initialActiveSkills: [skill] });
    }
    return;
  }
  if (command === "trace") {
    const session = (await sessionStore.listSessions())[0];
    await showTrace({ sessionStore, session });
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

export async function runSlashCommand({ command, client, config, sessionStore, tools, cwd, settingsPath, session }) {
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
    const skill = await loadSkillCommand();
    return skill ? { kind: "skill", skill } : undefined;
  }

  if (command === "/trace") {
    await showTrace({ sessionStore, session });
    return;
  }

  if (command === "/new") {
    const nextSession = await sessionStore.createSession({ model: config.model });
    console.log("New conversation: " + shortSessionId(nextSession.id));
    return { kind: "session", session: nextSession };
  }

  if (command === "/fork") {
    const forked = await forkSession({ sessionStore, session, model: config.model });
    return forked ? { kind: "session", session: forked } : undefined;
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

  console.log("Unknown command: " + command);
  printSlashHelp();
}

function isInteractiveTerminal() {
  return process.stdin.isTTY && process.stdout.isTTY;
}
