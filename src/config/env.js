export function loadConfig(env, args = {}) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing DEEPSEEK_API_KEY. Set it in ~/.deecoo/settings.json, your environment, or local .env file.",
    );
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(env.DEECOO_BASE_URL ?? "https://api.deepseek.com"),
    model: args.model ?? env.DEECOO_MODEL ?? "deepseek-v4-pro",
    cwd: env.DEECOO_CWD,
    maxTokens: numberFrom(env.DEECOO_MAX_TOKENS, 4096),
    timeoutMs: numberFrom(env.DEECOO_TIMEOUT_MS, 120000),
    retryAttempts: numberFrom(env.DEECOO_API_RETRIES, 5),
    permissionMode: normalizePermissionMode(env.DEECOO_PERMISSION_MODE ?? "ask-once"),
    theme: env.DEECOO_THEME ?? "tokyo-night",
    reasoningEffort: env.DEECOO_REASONING_EFFORT,
    thinking: env.DEECOO_THINKING,
    stream: booleanFrom(env.DEECOO_STREAM, true),
  };
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function numberFrom(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function booleanFrom(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function normalizePermissionMode(value) {
  const allowed = new Set(["read-only", "ask-every-edit", "ask-once", "workspace-write"]);
  return allowed.has(value) ? value : "ask-once";
}
