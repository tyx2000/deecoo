import { createHash } from "node:crypto";
import { adapterProtocol, deepFreeze, providerCapabilities, endpointFingerprint } from "./capabilities.js";
import { linkSignals } from "../harness/budget.js";
export { endpointFingerprint } from "./capabilities.js";

// A run sends the same tool schemas on every step; canonicalizing and hashing them each time is
// avoidable work. Equal serialized schemas always have equal canonical fingerprints.
const schemaFingerprintCache = new Map();
export function schemaFingerprint(tools = []) {
  const key = JSON.stringify(tools);
  let fingerprint = schemaFingerprintCache.get(key);
  if (fingerprint === undefined) {
    fingerprint = stableFingerprint(tools);
    schemaFingerprintCache.set(key, fingerprint);
    if (schemaFingerprintCache.size > 16) schemaFingerprintCache.delete(schemaFingerprintCache.keys().next().value);
  }
  return fingerprint;
}
export function stableFingerprint(value) {
  const canonical = (input) => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.keys(input).sort().filter((key) => input[key] !== undefined).map((key) => [key, canonical(input[key])])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function createRouteIdentity({ config = {}, client, model, tools = [] } = {}) {
  const route = client?.routeIdentity;
  const identity = { version: 1, provider: route?.provider ?? config.provider ?? "custom",
    protocol: route?.protocol ?? config.protocol ?? adapterProtocol(config.provider),
    model: model ?? config.model ?? route?.model ?? "unspecified",
    endpointHash: route?.endpointHash ?? endpointFingerprint(config.baseUrl),
    toolsSchemaFingerprint: schemaFingerprint(tools) };
  return deepFreeze({ ...identity, hash: stableFingerprint(identity) });
}

// A single tool call (for example writing a report file) can need far more
// than 4096 output tokens. Routes that declare their output limit get room for
// it, without reserving more than a quarter of the context window; undeclared
// routes keep the widely accepted 4096.
export function defaultOutputTokens(capabilities) {
  if (capabilities.maxOutputTokens === undefined) return 4096;
  return Math.max(capabilities.minOutputTokens, Math.min(32768, capabilities.maxOutputTokens, Math.floor(capabilities.contextWindow / 4)));
}

export function prepareModelRequest(receiver, input, config = {}, { signal } = {}) {
  throwIfAborted(signal);
  let request;
  try {
    const { signal: _ignored, ...data } = input ?? {};
    request = JSON.parse(JSON.stringify(data, (_key, value) => {
      if (["bigint", "function", "symbol"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-JSON request data");
      return value;
    }));
  } catch { throw failure("REQUEST_NOT_SERIALIZABLE", "Model requests must contain serializable data"); }
  const model = request.model ?? config.model;
  if (typeof model !== "string" || !model.trim()) throw failure("MODEL_REQUIRED", "A prepared request requires an explicit model");
  request.model = model;
  const capabilities = providerCapabilities({ ...config, model });
  if (request.tools?.length && capabilities.toolCalling === false) throw unsupported("toolCalling");
  if (request.stream === true && capabilities.streaming === false) throw unsupported("streaming");
  const sources = {};
  const rawMax = request.max_tokens ?? request.max_completion_tokens ?? config.maxTokens ?? defaultOutputTokens(capabilities);
  if (request.max_tokens !== undefined && request.max_completion_tokens !== undefined && request.max_tokens !== request.max_completion_tokens) throw failure("OUTPUT_LIMIT_CONFLICT", "Conflicting output-token limits");
  if (!Number.isSafeInteger(rawMax) || rawMax < capabilities.minOutputTokens) throw failure("OUTPUT_LIMIT_INVALID", "Output-token limit must be an integer at least the route minimum");
  const effectiveMax = Math.min(rawMax, capabilities.maxOutputTokens ?? rawMax, capabilities.contextWindow - 1);
  if (effectiveMax < capabilities.minOutputTokens) throw failure("OUTPUT_LIMIT_INVALID", "Context window cannot accommodate the route output minimum");
  sources.maxTokens = effectiveMax !== rawMax ? "route-limit" : request.max_tokens !== undefined || request.max_completion_tokens !== undefined ? "request" : config.maxTokens !== undefined ? "configured"
    : capabilities.maxOutputTokens !== undefined ? "route-default" : "adapter-compatible-default";
  delete request.max_completion_tokens;
  request.max_tokens = effectiveMax;
  const reasoning = request.reasoning_effort ?? config.reasoningEffort;
  if (reasoning !== undefined) {
    if (typeof reasoning !== "string" || !reasoning.trim()) throw failure("REASONING_EFFORT_INVALID", "reasoningEffort must be a nonempty string");
    if (capabilities.reasoningEffort === false && reasoning !== "none") throw unsupported("reasoningEffort");
    if (capabilities.reasoningEffortValues && !capabilities.reasoningEffortValues.includes(reasoning)) throw failure("REASONING_EFFORT_INVALID", "reasoningEffort is not declared by this route");
    if (capabilities.reasoningEffort === false) delete request.reasoning_effort;
    else request.reasoning_effort = reasoning;
    sources.reasoningEffort = capabilities.reasoningEffort === "unknown" ? "unknown-compatible-pass-through" : capabilities.sources.reasoningEffort;
  }
  const thinking = request.thinking ?? config.thinking;
  if (thinking !== undefined) {
    const disabled = thinking === false || ["disabled", "off", "false"].includes(thinking) || thinking?.type === "disabled";
    if (!disabled && capabilities.thinking === false) throw unsupported("thinking");
    if (capabilities.thinking === false) delete request.thinking;
    else request.thinking = structuredClone(thinking);
    sources.thinking = capabilities.thinking === "unknown" ? "unknown-compatible-pass-through" : capabilities.sources.thinking;
  }
  // The provider methods and this config close over the same route. A wrapper's
  // public routeIdentity property is observational metadata, not routing input.
  const routeIdentity = createRouteIdentity({ config, model, tools: request.tools ?? [] });
  const effectiveConfig = deepFreeze({ provider: routeIdentity.provider, model, protocol: routeIdentity.protocol,
    maxTokens: effectiveMax, effectiveMaxTokens: effectiveMax, requestedMaxTokens: rawMax,
    contextWindow: capabilities.contextWindow, contextWindowSource: capabilities.contextWindowSource,
    minOutputTokens: capabilities.minOutputTokens, maxOutputTokens: capabilities.maxOutputTokens,
    reasoningEffort: request.reasoning_effort,
    thinking: request.thinking ?? (routeIdentity.provider === "anthropic" ? { type: "disabled" } : undefined), sources });
  const immutableRequest = deepFreeze(request);
  // The route hash already covers the tool schemas, so the request body is fingerprinted without them.
  const { tools: _schemas, ...requestBody } = immutableRequest;
  const requestFingerprint = stableFingerprint({ request: requestBody, effectiveConfig, capabilities, route: routeIdentity.hash });
  // Capture the OUTER receiver's methods. Object-spread budget and rate-limit
  // wrappers therefore stay on the actual dispatch path, including streaming.
  const complete = receiver?.chatCompletion;
  const completeStream = receiver?.chatCompletionStream;
  let consumed = false;
  const prepared = { request: immutableRequest, effectiveConfig, capabilities, routeIdentity, requestFingerprint,
    async dispatch({ stream = false, signal: dispatchSignal, onContent, onRuntimeEvent, onProgress } = {}) {
      if (consumed) throw failure("PREPARED_REQUEST_CONSUMED", "A prepared request can be dispatched only once");
      consumed = true;
      const linked = linkSignals([signal, dispatchSignal]);
      try {
        throwIfAborted(linked.signal);
        if (stream && capabilities.streaming === false) throw unsupported("streaming");
        if (stream) {
          if (typeof completeStream !== "function") throw failure("PROVIDER_STREAMING_UNAVAILABLE", "This client does not implement streaming dispatch");
          return await completeStream.call(receiver, immutableRequest, { signal: linked.signal, onContent, onRuntimeEvent, onProgress });
        }
        if (typeof complete !== "function") throw failure("PROVIDER_DISPATCH_UNAVAILABLE", "This client does not implement model dispatch");
        return await complete.call(receiver, immutableRequest, { signal: linked.signal, onRuntimeEvent });
      } finally { linked.dispose(); }
    },
  };
  return Object.freeze(prepared);
}

function unsupported(feature) { return failure("MODEL_CAPABILITY_UNSUPPORTED", `The selected adapter/model route explicitly does not support ${feature}`); }
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : failure("ABORT_ERR", "Request canceled before dispatch"); }
