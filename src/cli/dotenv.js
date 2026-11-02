import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { recordEnvironmentSource } from "../config/environmentSources.js";

// A project `.env` belongs to whoever authored the repository, so it may only supply tuning
// values by default. Route/account values need explicit trust from CLI/shell. Sandbox,
// permission, egress, endpoint, workspace, storage, and budget
// settings must come from the shell or settings.json, never from the workspace being opened.
const PROVIDER_KEYS = new Set(["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
const ROUTE_KEYS = new Set([...PROVIDER_KEYS, "DEECOO_PROVIDER", "DEECOO_MODEL"]);
const PROJECT_TUNING_KEYS = new Set([
  "DEECOO_PROVIDER", "DEECOO_MODEL", "DEECOO_THEME", "DEECOO_REASONING_EFFORT", "DEECOO_THINKING", "DEECOO_STREAM",
  "DEECOO_MAX_TOKENS", "DEECOO_TIMEOUT_MS", "DEECOO_API_RETRIES", "DEECOO_CONTEXT_WINDOW", "DEECOO_OUTPUT_RESERVE",
]);

export async function loadDotEnvIfPresent(directory, { trusted = false, env = process.env } = {}) {
  const path = resolve(directory, ".env");
  try {
    await access(path);
  } catch {
    return { path, loaded: false, ignored: [], untrusted: [], appliedRoutes: [] };
  }

  const ignored = [];
  const untrusted = [];
  const appliedRoutes = [];
  const content = await readFile(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key.startsWith("DEECOO_") && !PROJECT_TUNING_KEYS.has(key)) { ignored.push(key); continue; }
    if (!isSupportedDotEnvKey(key) || env[key] !== undefined) continue;
    if (ROUTE_KEYS.has(key) && trusted !== true) { untrusted.push(key); continue; }
    env[key] = stripQuotes(rawValue.trim());
    recordEnvironmentSource(env, key, `project .env (${path})`);
    if (ROUTE_KEYS.has(key)) appliedRoutes.push(key);
  }
  return { path, loaded: true, ignored, untrusted, appliedRoutes };
}

export function formatIgnoredDotEnvKeys({ path, ignored = [], untrusted = [], appliedRoutes = [] } = {}) {
  const notices = [];
  if (ignored.length) notices.push(`Ignored ${[...new Set(ignored)].join(", ")} from ${path}: project .env files cannot change security, endpoint, workspace, storage, or budget settings. Set them in the shell or settings.json.`);
  if (untrusted.length) notices.push(`Ignored route/account values ${[...new Set(untrusted)].join(", ")} from ${path}. Use --trust-project-env only if you trust this project's provider, model and credentials; shell environment and settings remain available.`);
  if (appliedRoutes.length) notices.push(`Using trusted project .env route/account values from ${path}: ${[...new Set(appliedRoutes)].join(", ")}.`);
  return notices.join("\n");
}

function isSupportedDotEnvKey(key) {
  return PROVIDER_KEYS.has(key) || PROJECT_TUNING_KEYS.has(key);
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
