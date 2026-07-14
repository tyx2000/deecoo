import { inferProviderFromModel, normalizeProviderName, providerDefaults } from "./providers.js";

export function loadConfig(env, args = {}, settings = {}) {
  const cliModelProvider = inferProviderFromModel(args.model);
  const envModelProvider = inferProviderFromModel(env.DEECOO_MODEL);
  const provider = normalizeProviderName(
    env.DEECOO_PROVIDER ?? cliModelProvider ?? envModelProvider ?? settings.activeProvider ?? "deepseek",
  );
  const defaults = providerDefaults(provider);
  const providerSettings = settings.providers?.[provider] ?? {};
  const apiKey = env[defaults.apiKeyEnv] ?? providerSettings.apiKey;
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${provider}". Run: deecoo config -provider ${provider} -key sk-...`,
    );
  }

  return {
    provider,
    apiKeyEnv: defaults.apiKeyEnv,
    apiKey,
    baseUrl: normalizeBaseUrl(env.DEECOO_BASE_URL ?? providerSettings.baseUrl ?? defaults.baseUrl),
    model: args.model ?? env.DEECOO_MODEL ?? providerSettings.model ?? defaults.model,
    cwd: env.DEECOO_CWD,
    maxTokens: numberFrom(env.DEECOO_MAX_TOKENS, 4096),
    timeoutMs: numberFrom(env.DEECOO_TIMEOUT_MS, 120000),
    retryAttempts: numberFrom(env.DEECOO_API_RETRIES, 5),
    maxSteps: numberFrom(env.DEECOO_MAX_STEPS, 150),
    tokenBudget: optionalNumberFrom(env.DEECOO_TOKEN_BUDGET),
    costBudgetUsd: optionalNumberFrom(env.DEECOO_COST_BUDGET_USD),
    pricePromptPerM: optionalNumberFrom(env.DEECOO_PRICE_PROMPT_PER_M),
    priceCompletionPerM: optionalNumberFrom(env.DEECOO_PRICE_COMPLETION_PER_M),
    taskTimeoutMs: optionalNumberFrom(env.DEECOO_TASK_TIMEOUT_MS),
    workerTimeoutMs: optionalNumberFrom(env.DEECOO_WORKER_TIMEOUT_MS),
    egressAllowlist: env.DEECOO_EGRESS_ALLOWLIST,
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

function optionalNumberFrom(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
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
