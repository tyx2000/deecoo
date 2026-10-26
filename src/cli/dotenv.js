import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// A project `.env` belongs to whoever authored the repository, so it may only choose a provider
// key and tuning values. Sandbox, permission, egress, endpoint, workspace, storage, and budget
// settings must come from the shell or settings.json, never from the workspace being opened.
const PROVIDER_KEYS = new Set(["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
const PROJECT_TUNING_KEYS = new Set([
  "DEECOO_PROVIDER", "DEECOO_MODEL", "DEECOO_THEME", "DEECOO_REASONING_EFFORT", "DEECOO_THINKING", "DEECOO_STREAM",
  "DEECOO_MAX_TOKENS", "DEECOO_TIMEOUT_MS", "DEECOO_API_RETRIES", "DEECOO_CONTEXT_WINDOW", "DEECOO_OUTPUT_RESERVE",
]);

export async function loadDotEnvIfPresent(directory) {
  const path = resolve(directory, ".env");
  try {
    await access(path);
  } catch {
    return { path, loaded: false, ignored: [] };
  }

  const ignored = [];
  const content = await readFile(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key.startsWith("DEECOO_") && !PROJECT_TUNING_KEYS.has(key)) { ignored.push(key); continue; }
    if (!isSupportedDotEnvKey(key) || process.env[key] !== undefined) continue;
    process.env[key] = stripQuotes(rawValue.trim());
  }
  return { path, loaded: true, ignored };
}

export function formatIgnoredDotEnvKeys({ path, ignored = [] } = {}) {
  if (!ignored.length) return "";
  return `Ignored ${[...new Set(ignored)].join(", ")} from ${path}: project .env files cannot change security, workspace, storage, or budget settings. Set them in the shell or settings.json.`;
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
