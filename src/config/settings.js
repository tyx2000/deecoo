import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { normalizeShellCommand } from "../permissions/shellPolicy.js";
import {
  PROVIDER_NAMES,
  inferProviderFromModel,
  isProviderApiKey,
  normalizeProviderName,
  providerDefaults,
} from "./providers.js";

export async function loadSettingsEnv({ settingsPath } = {}) {
  const path = resolveSettingsPath(settingsPath ?? process.env.DEECOO_SETTINGS_PATH);

  try {
    await access(path);
  } catch {
    return {
      path,
      loaded: false,
      env: {},
      activeProvider: "deepseek",
      providers: defaultProviderSettings(),
      permissions: normalizeSettingsPermissions({}),
    };
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  const env = normalizeSettingsEnv(parsed);

  const activeProvider = normalizeActiveProvider(parsed, env);
  return {
    path,
    loaded: true,
    env: operationalSettingsEnv(env),
    activeProvider,
    providers: normalizeSettingsProviders(parsed, env),
    permissions: normalizeSettingsPermissions(parsed),
  };
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
  const next = mergeSettings(existing, normalizeSettingsEnv(env));

  await writeSettingsFile(path, next);
  return { path, env: next.env };
}

export async function writeProviderSettings({ settingsPath, provider, apiKey, baseUrl, model, activate = true }) {
  const name = normalizeProviderName(provider);
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("API key is required.");
  const path = resolveSettingsPath(settingsPath ?? process.env.DEECOO_SETTINGS_PATH);
  const existing = await readSettingsFile(path);
  const next = mergeSettings(existing, {}, {
    activeProvider: activate ? name : undefined,
    provider: name,
    providerConfig: { apiKey: apiKey.trim(), baseUrl, model },
  });

  await writeSettingsFile(path, next);
  return { path, activeProvider: next.activeProvider, provider: name, config: next.providers[name] };
}

export async function writeProviderModel({ settingsPath, provider, model }) {
  const name = normalizeProviderName(provider);
  if (typeof model !== "string" || !model.trim()) throw new Error("model is required");
  const path = resolveSettingsPath(settingsPath ?? process.env.DEECOO_SETTINGS_PATH);
  const existing = await readSettingsFile(path);
  const next = mergeSettings(existing, {}, {
    activeProvider: name,
    provider: name,
    providerConfig: { model: model.trim() },
  });

  await writeSettingsFile(path, next);
  return { path, activeProvider: name, model: next.providers[name].model };
}

export async function addApprovedShellCommand({ settingsPath, command }) {
  const normalizedCommand = normalizeShellCommand(command);
  if (!normalizedCommand) throw new Error("command is required");

  const { path, shell } = await updateShellPermissions({
    settingsPath,
    mutate: (currentShell) => {
      const approvedCommands = new Set(Array.isArray(currentShell.approvedCommands) ? currentShell.approvedCommands : []);
      approvedCommands.add(normalizedCommand);
      return { ...currentShell, approvedCommands: [...approvedCommands].sort() };
    },
  });
  return { path, approvedCommands: shell.approvedCommands };
}

export async function setAutoApproveAllShellCommands({ settingsPath }) {
  const { path } = await updateShellPermissions({
    settingsPath,
    mutate: (currentShell) => ({ ...currentShell, autoApproveAll: true }),
  });
  return { path, autoApproveAll: true };
}

export async function resetShellApprovals({ settingsPath }) {
  const { path } = await updateShellPermissions({
    settingsPath,
    mutate: () => ({ approvedCommands: [], autoApproveAll: false }),
  });
  return { path, approvedCommands: [], autoApproveAll: false };
}

async function updateShellPermissions({ settingsPath, mutate }) {
  const path = resolveSettingsPath(settingsPath ?? process.env.DEECOO_SETTINGS_PATH);
  const existing = await readSettingsFile(path);
  const currentShell = existing.permissions?.shell && typeof existing.permissions.shell === "object" ? existing.permissions.shell : {};
  const shell = mutate(currentShell);
  const migrated = mergeSettings(existing, {});

  const next = {
    ...migrated,
    permissions: {
      ...(migrated.permissions && typeof migrated.permissions === "object" ? migrated.permissions : {}),
      shell,
    },
  };

  await writeSettingsFile(path, next);
  return { path, shell };
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
    DEECOO_MAX_TOKENS: 4096,
    DEECOO_TIMEOUT_MS: 120000,
    DEECOO_API_RETRIES: 5,
    DEECOO_PERMISSION_MODE: "ask-once",
    DEECOO_THEME: "tokyo-night",
  };
}

function mergeSettings(existing, envUpdates, providerUpdate = {}) {
  const currentEnv = normalizeSettingsEnv(existing);
  let activeProvider = normalizeActiveProvider(existing, currentEnv);
  const providers = normalizeSettingsProviders(existing, currentEnv);
  const updates = normalizeSettingsEnv(envUpdates);

  const modelProvider = inferProviderFromModel(updates.DEECOO_MODEL);
  const keyProviders = PROVIDER_NAMES.filter((provider) => updates[providerDefaults(provider).apiKeyEnv]);
  const requestedProvider = updates.DEECOO_PROVIDER
    ? normalizeProviderName(updates.DEECOO_PROVIDER)
    : modelProvider ?? (keyProviders.length === 1 ? keyProviders[0] : activeProvider);
  if (updates.DEECOO_PROVIDER || modelProvider || keyProviders.length === 1) activeProvider = requestedProvider;

  for (const provider of PROVIDER_NAMES) {
    const defaults = providerDefaults(provider);
    if (updates[defaults.apiKeyEnv]) {
      providers[provider] = { ...providers[provider], apiKey: String(updates[defaults.apiKeyEnv]) };
    }
  }
  if (updates.DEECOO_MODEL) providers[requestedProvider] = { ...providers[requestedProvider], model: String(updates.DEECOO_MODEL) };
  if (updates.DEECOO_BASE_URL) providers[requestedProvider] = { ...providers[requestedProvider], baseUrl: String(updates.DEECOO_BASE_URL) };

  if (providerUpdate.provider) {
    const name = normalizeProviderName(providerUpdate.provider);
    const values = Object.fromEntries(
      Object.entries(providerUpdate.providerConfig ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    );
    providers[name] = { ...providers[name], ...values };
  }
  if (providerUpdate.activeProvider) activeProvider = normalizeProviderName(providerUpdate.activeProvider);

  const nextEnv = { ...operationalSettingsEnv(currentEnv), ...operationalSettingsEnv(updates) };
  return {
    ...existing,
    schemaVersion: 2,
    activeProvider,
    providers,
    env: nextEnv,
  };
}

function defaultProviderSettings() {
  return Object.fromEntries(
    PROVIDER_NAMES.map((provider) => {
      const defaults = providerDefaults(provider);
      return [provider, { baseUrl: defaults.baseUrl, model: defaults.model }];
    }),
  );
}

function normalizeSettingsProviders(settings, env) {
  const providers = defaultProviderSettings();
  for (const provider of PROVIDER_NAMES) {
    const source = settings.providers?.[provider];
    if (source && typeof source === "object") {
      providers[provider] = {
        ...providers[provider],
        ...Object.fromEntries(
          ["apiKey", "baseUrl", "model"].filter((key) => typeof source[key] === "string" && source[key].trim()).map((key) => [key, source[key].trim()]),
        ),
      };
    }
    const key = providerDefaults(provider).apiKeyEnv;
    if (!providers[provider].apiKey && env[key]) providers[provider].apiKey = String(env[key]);
  }

  const legacyProvider = normalizeActiveProvider(settings, env);
  if (env.DEECOO_BASE_URL) providers[legacyProvider].baseUrl = String(env.DEECOO_BASE_URL);
  if (env.DEECOO_MODEL) providers[legacyProvider].model = String(env.DEECOO_MODEL);
  return providers;
}

function normalizeActiveProvider(settings, env) {
  const candidate = settings.activeProvider ?? settings.provider ?? env.DEECOO_PROVIDER;
  if (candidate) return normalizeProviderName(candidate, "deepseek");
  return inferProviderFromModel(env.DEECOO_MODEL) ?? "deepseek";
}

function operationalSettingsEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !isProviderApiKey(key) && !["DEECOO_PROVIDER", "DEECOO_MODEL", "DEECOO_BASE_URL"].includes(key)),
  );
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

async function writeSettingsFile(path, settings) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
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
  return isProviderApiKey(key) || key.startsWith("DEECOO_");
}

function deecooHome() {
  return resolve(process.env.DEECOO_HOME ?? resolve(homedir(), ".deecoo"));
}
