import { createAnthropicClient } from "./anthropicClient.js";
import { createDeepSeekClient, createOpenAICompatibleClient } from "./deepseekClient.js";

export function createModelClient(config) {
  if (config.provider === "deepseek") return createDeepSeekClient(config);
  if (config.provider === "openai") {
    return createOpenAICompatibleClient(config, {
      provider: "OpenAI",
      supportsBalance: false,
      transformRequest: toOpenAIRequest,
    });
  }
  if (config.provider === "anthropic") return createAnthropicClient(config);
  throw new Error(`Unsupported provider: ${config.provider}`);
}

export function toOpenAIRequest(request) {
  const next = { ...request };
  delete next.thinking;
  if (next.max_tokens !== undefined) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
  }
  return next;
}
