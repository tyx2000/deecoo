export function loadConfig(env, args = {}) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing DEEPSEEK_API_KEY. Set it in ~/.deepcode/settings.json, your environment, or local .env file.",
    );
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(env.DEEPCODE_BASE_URL ?? "https://api.deepseek.com"),
    model: args.model ?? env.DEEPCODE_MODEL ?? "deepseek-v4-pro",
    cwd: env.DEEPCODE_CWD,
    maxSteps: numberFrom(args.maxSteps ?? env.DEEPCODE_MAX_STEPS, 20),
    maxTokens: numberFrom(env.DEEPCODE_MAX_TOKENS, 4096),
    timeoutMs: numberFrom(env.DEEPCODE_TIMEOUT_MS, 120000),
    retryAttempts: numberFrom(env.DEEPCODE_API_RETRIES, 5),
    permissionMode: normalizePermissionMode(env.DEEPCODE_PERMISSION_MODE ?? "ask-once"),
    theme: env.DEEPCODE_THEME ?? "tokyo-night",
    reasoningEffort: env.DEEPCODE_REASONING_EFFORT,
    thinking: env.DEEPCODE_THINKING,
    stream: booleanFrom(env.DEEPCODE_STREAM, true),
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
