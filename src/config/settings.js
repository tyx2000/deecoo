import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";

export async function loadSettingsEnv({ settingsPath } = {}) {
  const path = resolveSettingsPath(settingsPath ?? process.env.DEEPCODE_SETTINGS_PATH);

  try {
    await access(path);
  } catch {
    return { path, loaded: false, env: {} };
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  const env = normalizeSettingsEnv(parsed);

  return { path, loaded: true, env };
}

export function applySettingsEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    if (!isSupportedSettingsKey(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = String(value);
  }
}

export function appSettingsPath() {
  return resolve(deepcodeHome(), "settings.json");
}

export async function writeSettingsEnv({ settingsPath, env }) {
  const path = resolveSettingsPath(settingsPath ?? process.env.DEEPCODE_SETTINGS_PATH);
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

export function collectSettingsEnv(env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isSupportedSettingsKey(key)) continue;
    if (key === "DEEPCODE_SETTINGS_PATH") continue;
    if (value === undefined || value === "") continue;
    result[key] = value;
  }
  return result;
}

export function defaultSettingsEnv() {
  return {
    DEEPCODE_BASE_URL: "https://api.deepseek.com",
    DEEPCODE_MODEL: "deepseek-v4-pro",
    DEEPCODE_MAX_STEPS: 20,
    DEEPCODE_MAX_TOKENS: 4096,
    DEEPCODE_TIMEOUT_MS: 120000,
    DEEPCODE_API_RETRIES: 5,
    DEEPCODE_PERMISSION_MODE: "ask-once",
    DEEPCODE_THEME: "tokyo-night",
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

function isSupportedSettingsKey(key) {
  return key === "DEEPSEEK_API_KEY" || key.startsWith("DEEPCODE_");
}

function deepcodeHome() {
  return resolve(process.env.DEEPCODE_HOME ?? resolve(homedir(), ".deepcode"));
}
