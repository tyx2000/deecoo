// Data/instruction separation. Fencing tells the model "this is data"; this goes further for
// content that looks like an active injection: the raw content is quarantined out-of-band and
// the model is shown only an inert projection with imperative/control lines withheld, so the
// instructions never reach the reasoning context at all. The model can request the raw text as
// data by quarantine id if it genuinely needs it.

const IMPERATIVE_LINE = /^\s*(?:ignore|disregard|forget|override|stop|now|instead|you must|you should|please|do not|don't|execute|run|delete|remove|send|upload|post|reveal|print|export|act as|you are now|system\s*:|assistant\s*:|new instructions?\b)/i;
const CONTROL_TOKEN = /<\s*\/?\s*(?:system|tool_calls?|invoke|function_calls?)\b|\bDSML\b|UNTRUSTED_TOOL_OUTPUT/gi;

// Return an inert projection of untrusted text: lines that read as direct instructions to the
// assistant are withheld (replaced by a redaction marker) and control tokens are neutralized.
export function projectUntrustedContent(text) {
  const value = String(text ?? "");
  const withheld = [];
  const projected = value
    .split(/\r?\n/)
    .map((line) => {
      if (IMPERATIVE_LINE.test(line)) {
        withheld.push(line.trim());
        return "[withheld: instruction-like line]";
      }
      return line.replace(CONTROL_TOKEN, "[neutralized]");
    })
    .join("\n");
  return { safe: projected, withheld };
}

export function createQuarantine() {
  const store = new Map();
  let counter = 0;
  return {
    // Hold raw untrusted content out of the model context; returns an id and the safe projection.
    store(content, meta = {}) {
      const id = "q" + (counter += 1);
      const projection = projectUntrustedContent(content);
      store.set(id, { id, content: String(content ?? ""), meta, withheld: projection.withheld, at: Date.now() });
      return { id, safe: projection.safe, withheld: projection.withheld };
    },
    get(id) {
      return store.get(id);
    },
    list() {
      return [...store.values()].map((entry) => ({ id: entry.id, meta: entry.meta, withheldCount: entry.withheld.length }));
    },
    size: () => store.size,
  };
}
