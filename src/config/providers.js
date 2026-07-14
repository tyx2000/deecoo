export const PROVIDER_NAMES = ["deepseek", "openai", "anthropic"];

const PROVIDERS = {
  deepseek: {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    protocol: "openai-compatible",
  },
  openai: {
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.1",
    protocol: "openai-compatible",
  },
  anthropic: {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    protocol: "anthropic-messages",
  },
};

export function providerDefaults(provider) {
  const name = normalizeProviderName(provider);
  return { name, ...PROVIDERS[name] };
}

export function normalizeProviderName(value, fallback) {
  const name = String(value ?? "").trim().toLowerCase();
  if (PROVIDERS[name]) return name;
  if (fallback !== undefined) return normalizeProviderName(fallback);
  throw new Error(`Unsupported provider "${value}". Supported providers: ${PROVIDER_NAMES.join(", ")}.`);
}

export function inferProviderFromModel(model) {
  const value = String(model ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (value.startsWith("deepseek")) return "deepseek";
  if (value.startsWith("claude")) return "anthropic";
  if (/^(gpt-|o[1345](?:-|$)|chatgpt-|codex-)/.test(value)) return "openai";
  return undefined;
}

export function providerApiKeyEnv(provider) {
  return providerDefaults(provider).apiKeyEnv;
}

export function isProviderApiKey(key) {
  return PROVIDER_NAMES.some((provider) => PROVIDERS[provider].apiKeyEnv === key);
}
