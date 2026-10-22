import { createOpenAICompatibleClient } from "./deepseekClient.js";

// Providers whose GET /models reports per-model limits (context_window,
// max_output_tokens). Other routes keep the conservative fallback unless a
// window is configured explicitly.
const REPORTS_MODEL_LIMITS = new Set(["deepseek"]);

// Best effort: one short request, no retries. The result is bound to this
// provider, endpoint and model, so modelMetadataFor never applies it elsewhere.
export async function discoverModelMetadata(config, { timeoutMs = 3000 } = {}) {
  if (!REPORTS_MODEL_LIMITS.has(config.provider) || config.contextWindow !== undefined || config.modelMetadata || !config.apiKey) return undefined;
  try {
    const listing = await createOpenAICompatibleClient({ ...config, retryAttempts: 1, timeoutMs }).listModels();
    const entry = Array.isArray(listing?.data) ? listing.data.find((item) => item?.id === config.model) : undefined;
    const contextWindow = positiveInteger(entry?.context_window);
    if (!contextWindow) return undefined;
    const maxOutputTokens = positiveInteger(entry.max_output_tokens);
    return { model: config.model, provider: config.provider, baseUrl: config.baseUrl, contextWindow, ...(maxOutputTokens ? { maxOutputTokens } : {}) };
  } catch {
    return undefined;
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
