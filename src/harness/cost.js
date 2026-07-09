// Cost accounting. Token budgets bound quantity; this bounds spend. Prices are USD per
// million tokens (prompt/completion) and are provider-configurable via DEECOO_PRICE_* env.

const DEFAULT_PRICES = {
  "deepseek-v4-pro": { prompt: 0.28, completion: 0.42 },
  "deepseek-v4-flash": { prompt: 0.07, completion: 0.14 },
};

const FALLBACK_PRICE = { prompt: 0, completion: 0 };

export function resolveModelPrice(model, overrides = {}) {
  const key = String(model ?? "").toLowerCase();
  const prompt = numeric(overrides.pricePromptPerM);
  const completion = numeric(overrides.priceCompletionPerM);
  if (prompt !== undefined || completion !== undefined) {
    return { prompt: prompt ?? 0, completion: completion ?? 0 };
  }
  return DEFAULT_PRICES[key] ?? FALLBACK_PRICE;
}

export function estimateCostUsd(usage, model, overrides = {}) {
  const price = resolveModelPrice(model, overrides);
  const promptTokens = Number(usage?.promptTokens ?? usage?.prompt_tokens ?? 0);
  const completionTokens = Number(usage?.completionTokens ?? usage?.completion_tokens ?? 0);
  const cost = (promptTokens / 1_000_000) * price.prompt + (completionTokens / 1_000_000) * price.completion;
  return Math.round(cost * 1e6) / 1e6;
}

export function formatCostUsd(cost) {
  const value = Number(cost ?? 0);
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return "$" + value.toFixed(value < 1 ? 4 : 2);
}

function numeric(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
