const DEFAULT_CONTEXT_BUDGET = 120000;
const DEFAULT_LAYERS = { instructions: 0.30, task: 0.20, history: 0.25, retrieval: 0.20, memory: 0.05 };

// Deliberately conservative UTF-8 byte estimate, NOT an exact model tokenizer.
// Byte-level tokenizers cannot need more text tokens than UTF-8 bytes; providers
// still add framing/tool-schema tokens, covered separately by safetyReserve.
export function estimateTokens(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? ""), "utf8");
}
export function estimateMessageTokens(message) { return 12 + estimateTokens(message); }
export function measureContextMessages(messages) { return messages.reduce((total, message) => total + estimateMessageTokens(message), 0); }

export function buildContextBudget({ contextWindow = 128000, outputReserve, safetyReserve, tokenBudget, layers = DEFAULT_LAYERS } = {}) {
  const window = positiveInteger(contextWindow, "contextWindow");
  const output = positiveInteger(outputReserve ?? Math.min(8192, Math.floor(window / 4)), "outputReserve", true);
  const safety = positiveInteger(safetyReserve ?? Math.min(2048, Math.floor(window / 16)), "safetyReserve", true);
  const available = window - output - safety;
  if (available <= 0) throw new Error("Context window must exceed output and safety reserves.");
  const inputTokens = tokenBudget === undefined ? available : Math.min(available, positiveInteger(tokenBudget, "tokenBudget"));
  const sum = Object.values(layers).reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum <= 0 || Object.values(layers).some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Context layer weights must be nonnegative with a positive total.");
  return { contextWindow: window, outputReserve: output, safetyReserve: safety, inputTokens,
    layers: Object.fromEntries(Object.entries(layers).map(([key, value]) => [key, Math.floor(inputTokens * value / sum)])),
    estimator: "conservative-utf8-byte-estimate", exactTokenizer: false };
}

export function buildBudgetedContext(items, options = {}) {
  const started = performance.now();
  const budget = buildContextBudget(options);
  // System instructions, the original task and advertised tool schemas live
  // outside the selectable context, but compete for the same input window.
  const reservedInputTokens = measureContextMessages(options.reservedMessages ?? [])
    + (options.reservedTools === undefined ? 0 : estimateTokens(options.reservedTools));
  const availableContextTokens = budget.inputTokens - reservedInputTokens;
  if (availableContextTokens < 0) throw Object.assign(new Error("Required request instructions, task and tools exceed the model input budget."),
    { code: "CONTEXT_BUDGET_EXCEEDED", requiredTokens: reservedInputTokens, budget });
  const sorted = items.filter((item) => item?.message).map((item, index) => ({ ...item, index,
    message: normalizeMessage(item.message), layer: item.layer ?? inferLayer(item) }))
    .sort((a, b) => Number(b.required === true) - Number(a.required === true) || (b.priority ?? 0) - (a.priority ?? 0) || a.index - b.index);
  const selected = [];
  const deferred = [];
  const usedByLayer = {};
  let used = reservedInputTokens;
  for (const item of sorted) {
    const cost = estimateMessageTokens(item.message);
    const layerUsed = usedByLayer[item.layer] ?? 0;
    const layerLimit = budget.layers[item.layer] === undefined ? availableContextTokens
      : Math.floor(budget.layers[item.layer] * availableContextTokens / budget.inputTokens);
    if (used + cost > budget.inputTokens) {
      if (item.required) throw Object.assign(new Error("Required context exceeds the model input budget."), { code: "CONTEXT_BUDGET_EXCEEDED", requiredTokens: used + cost, budget });
      deferred.push({ ...item, cost }); continue;
    }
    if (!item.required && layerUsed + cost > layerLimit) { deferred.push({ ...item, cost }); continue; }
    selected.push(item); used += cost; usedByLayer[item.layer] = layerUsed + cost;
  }
  // Unused layer capacity can be borrowed in priority order after every layer has
  // had a chance to retain context. Never clip an instruction or trust envelope.
  for (const item of deferred) {
    if (used + item.cost > budget.inputTokens) continue;
    selected.push(item); used += item.cost; usedByLayer[item.layer] = (usedByLayer[item.layer] ?? 0) + item.cost;
  }
  selected.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.index - b.index);
  const messages = systemFirst(selected.map((item) => item.message));
  return { messages, metrics: { ...budget, estimatedInputTokens: used, estimatedContextTokens: used - reservedInputTokens,
    reservedInputTokens, availableContextTokens, usedByLayer,
    selectedItems: selected.length, droppedItems: sorted.length - selected.length,
    sourceItems: sorted.length, preparationMs: performance.now() - started } };
}

export function buildContextMessages(items, options = {}) {
  // Explicit legacy character budget remains compatible for existing callers.
  if (options.budget !== undefined && !["contextWindow", "tokenBudget", "outputReserve", "safetyReserve"].some((key) => options[key] !== undefined)) {
    const sorted = items.filter((item) => item?.message).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    const messages = []; let used = 0;
    for (const item of sorted) { const message = normalizeMessage(item.message); if (used + message.content.length > options.budget) continue; messages.push(message); used += message.content.length; }
    return systemFirst(messages);
  }
  return buildBudgetedContext(items, { tokenBudget: DEFAULT_CONTEXT_BUDGET, ...options }).messages;
}

export function contextItem(message, priority, options = {}) { return { message, priority, ...options }; }
function normalizeMessage(message) { return { role: message.role ?? "system", content: String(message.content ?? "") }; }
function systemFirst(messages) { return [...messages.filter((message) => message.role === "system"), ...messages.filter((message) => message.role !== "system")]; }
function inferLayer(item) { if (item.message?.role === "system") return "instructions"; if ((item.priority ?? 0) >= 90) return "task"; if ((item.priority ?? 0) >= 70) return "memory"; return "retrieval"; }
function positiveInteger(value, name, zero = false) { const number = Number(value); if (!Number.isInteger(number) || number < (zero ? 0 : 1)) throw new Error(name + " must be " + (zero ? "a nonnegative" : "a positive") + " integer."); return number; }
