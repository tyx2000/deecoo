import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeSettingsEnv } from "../config/settings.js";
import { listRunAudits, readRunAudit } from "../observability/audit.js";
import { listCodexSkills, loadCodexSkill } from "../skills/install.js";
import { createSpinner } from "../terminal/spinner.js";
import { selectOption } from "../terminal/select.js";
import { getThemeName, listThemes, paint, setTheme } from "../terminal/theme.js";
import {
  exportFileName,
  formatSessionTime,
  printSessionTranscript,
  sessionHistory,
  sessionOptionLabel,
  sessionSummary,
  sessionToMarkdown,
  shortSessionId,
  truncateOneLine,
} from "../cli/sessionView.js";

export async function selectPermissions({ config, tools }) {
  const modes = [
    { label: "ask-once          Confirm first file edit per task, then allow rest of task", value: "ask-once" },
    { label: "ask-every-edit    Confirm every file edit", value: "ask-every-edit" },
    { label: "workspace-write   Allow file edits inside workspace", value: "workspace-write" },
    { label: "read-only         Block file edits", value: "read-only" },
  ];
  const selected = await selectOption({
    title: "Permission mode",
    options: modes,
    selectedIndex: Math.max(0, modes.findIndex((mode) => mode.value === tools.getPermissionMode())),
  });
  if (!selected) return;
  config.permissionMode = selected.value;
  tools.setPermissionMode(selected.value);
  console.log("Permissions: " + selected.value);
}

export async function selectTheme({ config, settingsPath }) {
  const themes = listThemes();
  const selected = await selectOption({
    title: "Theme",
    options: themes.map((theme) => ({ label: theme.label, value: theme.name })),
    selectedIndex: Math.max(0, themes.findIndex((theme) => theme.name === getThemeName())),
  });
  if (!selected) return;
  config.theme = setTheme(selected.value);
  await persistSetting({ settingsPath, env: { DEECOO_THEME: getThemeName() } });
  console.log(paint("success", "Theme: " + getThemeName()));
}

export async function resumeSession({ sessionStore }) {
  const sessions = await sessionStore.listSessions();
  if (sessions.length === 0) {
    console.log("No previous conversations for this project.");
    return undefined;
  }
  const selected = await selectOption({
    title: "Resume conversation",
    options: sessions.map((session) => ({ label: sessionOptionLabel(session), value: session })),
  });
  if (!selected) return undefined;
  printSessionTranscript(selected.value);
  return selected.value;
}

export async function deleteSession({ sessionStore }) {
  const sessions = await sessionStore.listSessions();
  if (sessions.length === 0) {
    console.log("No previous conversations for this project.");
    return undefined;
  }
  const selected = await selectOption({
    title: "Delete conversation",
    options: sessions.map((session) => ({ label: sessionOptionLabel(session), value: session })),
  });
  if (!selected) return undefined;
  const session = selected.value;
  const confirmed = await selectOption({
    title: "Delete " + shortSessionId(session.id) + " permanently?",
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
  console.log("Deleted conversation: " + shortSessionId(session.id) + "  " + sessionSummary(session));
  return session;
}

export async function forkSession({ sessionStore, session, model }) {
  if (!session) {
    console.log("No active conversation to fork.");
    return undefined;
  }
  const answers = sessionHistory(session)
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => String(turn.assistant ?? "").trim());
  if (answers.length === 0) {
    console.log("No assistant answers in this conversation to fork.");
    return undefined;
  }
  const selected = await selectOption({
    title: "Fork from answer",
    options: answers.map(({ turn, index }) => ({
      label: "Turn " + String(index + 1).padStart(2, "0") + "  " + formatSessionTime(turn.at) + "  " + truncateOneLine(turn.assistant, 90),
      value: { turn, index },
    })),
  });
  if (!selected) return undefined;
  const { turn, index } = selected.value;
  const forkTurn = {
    user: "Forked context from " + shortSessionId(session.id) + " turn " + (index + 1),
    assistant: turn.assistant,
    model: turn.model ?? model,
    at: new Date().toISOString(),
  };
  const forked = await sessionStore.createSession({
    model,
    title: "Fork: " + truncateOneLine(turn.assistant, 54),
    summary: "Forked from conversation " + session.id + ", turn " + (index + 1) + ". The selected assistant answer is the initial context for this new conversation.",
    turns: [forkTurn],
    history: [forkTurn],
  });
  console.log("Forked conversation: " + shortSessionId(forked.id) + " from " + shortSessionId(session.id) + " turn " + (index + 1));
  return forked;
}

export async function exportSession({ sessionStore, cwd }) {
  const sessions = await sessionStore.listSessions();
  if (sessions.length === 0) {
    console.log("No previous conversations for this project.");
    return undefined;
  }
  const selected = await selectOption({
    title: "Export conversation",
    options: sessions.map((session) => ({ label: sessionOptionLabel(session), value: session })),
  });
  if (!selected) return undefined;
  const session = selected.value;
  const outputPath = join(resolve(session.cwd ?? cwd), exportFileName(session));
  await writeFile(outputPath, sessionToMarkdown(session), "utf8");
  console.log("Exported conversation: " + outputPath);
  return outputPath;
}

export async function loadSkillCommand() {
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
      title: "Load skill",
      options: skills.map((skill) => ({
        label: skill.name.padEnd(28) + " " + skill.sourceLabel.padEnd(8) + " " + skill.summary,
        columns: [skill.name, skill.sourceLabel, skill.summary],
        value: skill,
      })),
    });
    if (!selected) return undefined;
    const skill = await loadCodexSkill(selected.value);
    console.log("Loaded skill: " + skill.name);
    return skill;
  } catch (error) {
    spinner.stop();
    console.error("Unable to load skill: " + error.message);
    return undefined;
  }
}

export async function selectModel({ client, config, settingsPath }) {
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
    await persistSetting({ settingsPath, env: { DEECOO_MODEL: config.model } });
    console.log("Model: " + config.model);
  } catch (error) {
    spinner.stop();
    console.error("Unable to load models after retries: " + error.message);
  }
}

export async function showUsage({ client }) {
  const spinner = createSpinner("Loading usage");
  spinner.start();
  try {
    const balance = await client.getBalance();
    spinner.stop();
    printUsage(balance);
  } catch (error) {
    spinner.stop();
    console.error("Unable to load usage after retries: " + error.message);
  }
}

export async function showTrace({ sessionStore, session }) {
  if (!session) {
    console.log("No active conversation.");
    return;
  }
  const audits = await listRunAudits(sessionStore, session);
  if (audits.length === 0) {
    console.log("No audit traces for this conversation.");
    return;
  }
  const audit = await readRunAudit(audits[0].path);
  console.log([
    "Latest trace: " + audits[0].path,
    "task: " + truncateOneLine(audit.task, 100),
    "requestType: " + (audit.requestType ?? "-"),
    "workflow: " + (audit.workflow?.status ?? "-") + " / " + (audit.workflow?.phase ?? "-"),
    "verification: " + (audit.verification?.status ?? "-"),
    "steps: " + (audit.trace?.length ?? 0),
    "tool calls:",
    ...(audit.trace ?? []).slice(-12).map((entry) => "  - " + entry.tool + " " + (entry.ok ? "ok" : "failed") + " " + truncateOneLine(entry.target, 80)),
  ].join("\n"));
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
        (info.currency ?? "balance") + ": total=" + (info.total_balance ?? "-") + " granted=" + (info.granted_balance ?? "-") + " topped_up=" + (info.topped_up_balance ?? "-"),
      );
    }
    if (balance.is_available !== undefined) {
      console.log("available: " + balance.is_available);
    }
    return;
  }
  console.log(JSON.stringify(balance, null, 2));
}

async function persistSetting({ settingsPath, env }) {
  try {
    await writeSettingsEnv({ settingsPath, env });
  } catch (error) {
    console.error("Unable to persist setting: " + error.message);
  }
}
