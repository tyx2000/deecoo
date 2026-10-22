import { createHash } from "node:crypto";

const UNKNOWN = "unknown";
const FEATURES = ["toolCalling", "streaming", "incrementalUsage", "reasoningEffort", "thinking", "multimodal"];
export const FALLBACK_CONTEXT_WINDOW = 32768;

export function adapterProtocol(provider = "custom") {
  return provider === "anthropic" ? "anthropic-messages" : ["openai", "deepseek"].includes(provider) ? "openai-compatible" : "unspecified";
}

// Adapter support and remote-model support are different facts. In particular,
// these adapters currently omit thinking/reasoning fields on some routes.
export function adapterCapabilities(provider = "custom") {
  if (!["openai", "deepseek", "anthropic"].includes(provider)) return Object.freeze(Object.fromEntries(FEATURES.map((feature) => [feature, UNKNOWN])));
  return Object.freeze({ toolCalling: true, streaming: true, incrementalUsage: true,
    reasoningEffort: provider === "anthropic" ? false : true,
    thinking: ["openai", "anthropic"].includes(provider) ? false : true,
    multimodal: false });
}

export function modelMetadataFor(config = {}, model = config.model) {
  const metadata = config.modelMetadata;
  if (!metadata || typeof metadata !== "object") return {};
  const candidate = metadata.models?.[model] ?? metadata[model] ?? metadata;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  if (candidate.model !== undefined && candidate.model !== model) return {};
  if (candidate.provider !== undefined && candidate.provider !== (config.provider ?? "custom")) return {};
  if (candidate.protocol !== undefined && candidate.protocol !== (config.protocol ?? adapterProtocol(config.provider))) return {};
  if (candidate.baseUrl !== undefined && endpointFingerprint(candidate.baseUrl) !== endpointFingerprint(config.baseUrl)) return {};
  return candidate;
}

export function providerCapabilities(config = {}) {
  const provider = config.provider ?? "custom";
  const protocol = config.protocol ?? adapterProtocol(provider);
  const adapter = adapterCapabilities(provider);
  const metadata = modelMetadataFor(config);
  const configured = config.capabilityOverrides ?? config.capabilities ?? {};
  const sources = {};
  sources.protocol = config.protocol !== undefined ? "configured" : protocol === "unspecified" ? "unknown-adapter" : "adapter-implementation";
  const features = {};
  for (const feature of FEATURES) {
    const value = configured[feature] ?? metadata.capabilities?.[feature] ?? metadata[feature] ?? UNKNOWN;
    if (![true, false, UNKNOWN].includes(value)) throw new Error("Invalid capability: " + feature);
    if (adapter[feature] === false) { features[feature] = false; sources[feature] = "adapter-unsupported"; }
    else { features[feature] = value; sources[feature] = configured[feature] !== undefined ? "configured" : value !== UNKNOWN ? "model-metadata" : "unknown-model"; }
  }
  const configuredWindow = config.contextWindow ?? configured.contextWindow;
  const metadataWindow = metadata.contextWindow ?? metadata.context?.contextWindow;
  const contextWindow = positive(configuredWindow ?? metadataWindow ?? config.contextWindowFallback ?? FALLBACK_CONTEXT_WINDOW, "contextWindow");
  const contextWindowSource = configuredWindow !== undefined ? "configured" : metadataWindow !== undefined ? "model-metadata" : "conservative-fallback";
  const minOutputTokens = positive(config.minOutputTokens ?? configured.minOutputTokens ?? metadata.minOutputTokens ?? 1, "minOutputTokens");
  const maxOutput = config.maxOutputTokens ?? configured.maxOutputTokens ?? metadata.maxOutputTokens ?? metadata.maxTokens;
  const maxOutputTokens = maxOutput === undefined ? undefined : positive(maxOutput, "maxOutputTokens");
  if (maxOutputTokens !== undefined && maxOutputTokens < minOutputTokens) throw new Error("maxOutputTokens must be at least minOutputTokens");
  sources.contextWindow = contextWindowSource;
  sources.minOutputTokens = config.minOutputTokens !== undefined || configured.minOutputTokens !== undefined ? "configured" : metadata.minOutputTokens !== undefined ? "model-metadata" : "adapter-compatible-minimum";
  sources.maxOutputTokens = config.maxOutputTokens !== undefined || configured.maxOutputTokens !== undefined ? "configured" : maxOutputTokens === undefined ? "unknown-model" : "model-metadata";
  const effortValues = configured.reasoningEffortValues ?? metadata.reasoningEffortValues;
  if (effortValues !== undefined && (!Array.isArray(effortValues) || effortValues.some((value) => typeof value !== "string" || !value))) throw new Error("reasoningEffortValues must be nonempty strings");
  return deepFreeze({ version: 2, provider, protocol, model: config.model, ...features, adapter,
    contextWindow, contextWindowSource, minOutputTokens, maxOutputTokens,
    ...(effortValues ? { reasoningEffortValues: [...effortValues] } : {}),
    outputReserve: config.outputReserve ?? config.maxTokens ?? 4096,
    balance: provider === "deepseek", sources });
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function positive(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(label + " must be a positive integer");
  return number;
}

// Persist only a digest. Credentials are excluded, while non-authentication
// query parameters (for example deployment/api-version) still bind the route.
export function endpointFingerprint(value) {
  let endpoint = "unconfigured-endpoint";
  if (value) {
    let url;
    try { url = new URL(String(value)); } catch { throw endpointError(); }
    if (!["https:", "http:"].includes(url.protocol)) throw endpointError();
    url.username = ""; url.password = ""; url.hash = "";
    const routeParams = [...url.searchParams].filter(([key]) => !isCredentialParameter(key));
    routeParams.sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    for (const [key, item] of routeParams) url.searchParams.append(key, item);
    endpoint = url.toString().replace(/\/$/, "");
  }
  return createHash("sha256").update(JSON.stringify(endpoint)).digest("hex");
}

function isCredentialParameter(key) {
  return /(?:^|[-_])(?:api[-_]?key|access[-_]?key|token|secret|password|authorization|signature|sig|auth|credential|session|code)(?:$|[-_])/i.test(key)
    || /^(?:key|accesskey|apikey|x-amz-|x-goog-)/i.test(key);
}
function endpointError() { return Object.assign(new Error("Provider endpoint must be an absolute HTTP or HTTPS URL"), { code: "PROVIDER_ENDPOINT_INVALID" }); }
