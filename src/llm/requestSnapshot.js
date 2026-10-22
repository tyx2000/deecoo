// Snapshot only model payload fields. Authentication and transport options do
// not belong to request diagnostics. Schema keys describe tool contracts, so
// filtering their values must not replace a property named "token" wholesale.
const FIELDS = new Set(["model", "messages", "tools", "tool_choice", "max_tokens", "max_completion_tokens", "reasoning_effort", "thinking", "temperature", "top_p", "stop", "frequency_penalty", "presence_penalty", "parallel_tool_calls", "response_format", "stream", "seed"]);

export function projectModelRequest(request, { filterText = (value) => value } = {}) {
  const visit = (value) => {
    if (typeof value === "string") return filterText(value);
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const out = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const safeKey = filterText(key);
      let unique = safeKey, suffix = 1;
      while (Object.hasOwn(out, unique)) unique = safeKey + "#" + ++suffix;
      out[unique] = visit(item);
    }
    return Object.fromEntries(Object.entries(out));
  };
  return visit(Object.fromEntries(Object.entries(request ?? {}).filter(([key]) => FIELDS.has(key))));
}
