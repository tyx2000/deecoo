import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { normalizeShellCommand } from "../permissions/shellPolicy.js";

export async function loadSettingsEnv({ settingsPath } = {}) {
  const path = resolveSettingsPath(settingsPath ?? process.env.DEECOO_SETTINGS_PATH);

  try {
    await access(path);
  } catch {
    return { path, loaded: false, env: {}, permissions: normalizeSettingsPermissions({}) };
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  const env = normalizeSettingsEnv(parsed);

  return { path, loaded: true, env, permissions: normalizeSettingsPermissions(parsed) };
}

export function applySettingsEnv(env, { overrideKeys = [] } = {}) {
  const override = new Set(overrideKeys);
  for (const [key, value] of Object.entries(env)) {
    if (!isSupportedSettingsKey(key)) continue;
    if (process.env[key] !== undefined && !override.has(key)) continue;
    process.env[key] = String(value);
  }
}

export function appSettingsPath() {
  return resolve(deecooHome(), "settings.json");
}

export async function writeSettingsEnv({ settingsPath, env }) {
  const path = resolveSettingsPath(settingsPath ?? process.env.DEECOO_SETTINGS_PATH);
  const existing = await readSettingsFile(path);
  const currentEnv = normalizeSettingsEnv(existing);
  const next = {
    ...existing,
    env: {
      ...currentEnv,
      ...normalizeSettingsEnv(env),
    },
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { path, env: next.env };
}

export async function addApprovedShellCommand({ settingsPath, command }) {
  const normalizedCommand = normalizeShellCommand(command);
  if (!normalizedCommand) throw new Error("command is required");

  const path = resolveSettingsPath(settingsPath ?? process.env.DEECOO_SETTINGS_PATH);
  const existing = await readSettingsFile(path);
  const permissions = normalizeSettingsPermissions(existing);
  const approvedCommands = new Set(permissions.shell.approvedCommands);
  approvedCommands.add(normalizedCommand);

  const next = {
    ...existing,
    permissions: {
      ...(existing.permissions && typeof existing.permissions === "object" ? existing.permissions : {}),
      shell: {
        ...(existing.permissions?.shell && typeof existing.permissions.shell === "object" ? existing.permissions.shell : {}),
        approvedCommands: [...approvedCommands].sort(),
      },
    },
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { path, approvedCommands: next.permissions.shell.approvedCommands };
}

export async function setAutoApproveAllShellCommands({ settingsPath }) {
  const path = resolveSettingsPath(settingsPath ?? process.env.DEECOO_SETTINGS_PATH);
  const existing = await readSettingsFile(path);

  const next = {
    ...existing,
    permissions: {
      ...(existing.permissions && typeof existing.permissions === "object" ? existing.permissions : {}),
      shell: {
        ...(existing.permissions?.shell && typeof existing.permissions.shell === "object" ? existing.permissions.shell : {}),
        autoApproveAll: true,
      },
    },
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { path, autoApproveAll: true };
}

export function collectSettingsEnv(env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isSupportedSettingsKey(key)) continue;
    if (key === "DEECOO_SETTINGS_PATH") continue;
    if (value === undefined || value === "") continue;
    result[key] = value;
  }
  return result;
}

export function defaultSettingsEnv() {
  return {
    DEECOO_BASE_URL: "https://api.deepseek.com",
    DEECOO_MODEL: "deepseek-v4-pro",
    DEECOO_MAX_TOKENS: 4096,
    DEECOO_TIMEOUT_MS: 120000,
    DEECOO_API_RETRIES: 5,
    DEECOO_PERMISSION_MODE: "ask-once",
    DEECOO_THEME: "tokyo-night",
  };
}

function resolveSettingsPath(settingsPath) {
  if (!settingsPath) return appSettingsPath();
  const resolved = resolve(settingsPath);
  return extname(resolved) === ".json" ? resolved : resolve(resolved, "settings.json");
}

async function readSettingsFile(path) {
  try {
    await access(path);
  } catch {
    return {};
  }

  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

function normalizeSettingsEnv(settings) {
  const source = settings.env && typeof settings.env === "object" ? settings.env : settings;
  const env = {};

  for (const [key, value] of Object.entries(source)) {
    if (!isSupportedSettingsKey(key)) continue;
    if (value === undefined || value === null) continue;
    env[key] = value;
  }

  return env;
}

function normalizeSettingsPermissions(settings) {
  const approvedCommands = Array.isArray(settings.permissions?.shell?.approvedCommands)
    ? settings.permissions.shell.approvedCommands.map(normalizeShellCommand).filter(Boolean)
    : [];
  const autoApproveAll = settings.permissions?.shell?.autoApproveAll === true;

  return {
    shell: {
      approvedCommands: [...new Set(approvedCommands)],
      autoApproveAll,
    },
  };
}

function isSupportedSettingsKey(key) {
  return key === "DEEPSEEK_API_KEY" || key.startsWith("DEECOO_");
}

function deecooHome() {
  return resolve(process.env.DEECOO_HOME ?? resolve(homedir(), ".deecoo"));
}
