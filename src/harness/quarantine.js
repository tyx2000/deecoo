// Data/instruction separation. Fencing tells the model "this is data"; this goes further for
// content that looks like an active injection: the raw content is quarantined out-of-band and
// the model is shown only an inert projection with imperative/control lines withheld, so the
// instructions never reach the reasoning context at all. The model can request the raw text as
// data by quarantine id if it genuinely needs it.

// Lines that are genuine attempts to redirect the assistant/model — precise enough that
// ordinary source code (export/run/print/return ...) is NOT withheld, only injection phrasing.
const INJECTION_LINE_PATTERNS = [
  /\b(ignore|disregard|forget|override)\b[^.\n]*\b(previous|prior|above|earlier|all|any|the)\b[^.\n]*\b(instruction|prompt|rule|context|message)/i,
  /\b(you are now|act as|pretend to be|from now on you)\b/i,
  /\bnew\s+(instructions?|task|directive|system\s*prompt)\b/i,
  /^\s*(system|assistant|developer)\s*:/i,
  /\b(exfiltrat|leak|reveal|send|upload|post|email|print)\b[^.\n]*\b(secret|token|api[_ -]?key|password|credential|\.env|environment)\b/i,
  /\bdo (?:not|n't)\b[^.\n]*\b(tell|inform|mention|report)\b[^.\n]*\buser\b/i,
];
const CONTROL_TOKEN = /<\s*\/?\s*(?:system|tool_calls?|invoke|function_calls?)\b|\bDSML\b|UNTRUSTED_TOOL_OUTPUT/gi;

// Return an inert projection of untrusted text: lines that match an injection pattern (an
// attempt to redirect the model) are withheld; all other lines — including ordinary code — are
// preserved, with only control tokens neutralized.
export function projectUntrustedContent(text) {
  const value = String(text ?? "");
  const withheld = [];
  const projected = value
    .split(/\r?\n/)
    .map((line) => {
      if (INJECTION_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
        withheld.push(line.trim());
        return "[withheld: injection-like line]";
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
    // Full entries including raw content and withheld lines, for audit/human review — never
    // re-injected into the model context, but recoverable out-of-band.
    snapshot() {
      return [...store.values()].map((entry) => ({ id: entry.id, meta: entry.meta, withheld: entry.withheld, content: entry.content }));
    },
    size: () => store.size,
  };
}
