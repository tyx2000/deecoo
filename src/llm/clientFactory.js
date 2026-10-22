import { prepareModelRequest, createRouteIdentity } from "./prepareRequest.js";
import { adapterProtocol, providerCapabilities } from "./capabilities.js";
import { createAnthropicClient } from "./anthropicClient.js";
import { createDeepSeekClient, createOpenAICompatibleClient } from "./deepseekClient.js";

export function createModelClient(config) {
  const boundConfig = Object.freeze({ ...config,
    ...(config.thinking && typeof config.thinking === "object" ? { thinking: structuredClone(config.thinking) } : {}),
    ...(config.capabilities ? { capabilities: structuredClone(config.capabilities) } : {}),
    ...(config.capabilityOverrides ? { capabilityOverrides: structuredClone(config.capabilityOverrides) } : {}),
    ...(config.modelMetadata ? { modelMetadata: structuredClone(config.modelMetadata) } : {}) });
  if (boundConfig.protocol && boundConfig.protocol !== adapterProtocol(boundConfig.provider)) throw Object.assign(new Error("Configured protocol does not match the selected adapter"), { code: "PROVIDER_PROTOCOL_MISMATCH" });
  const client = buildModelClient(boundConfig);
  return { ...client, capabilities: providerCapabilities(boundConfig), routeIdentity: createRouteIdentity({ config: boundConfig }),
    prepareRequest(request, options) { return prepareModelRequest(this, request, boundConfig, options); } };
}

function buildModelClient(config) {
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
