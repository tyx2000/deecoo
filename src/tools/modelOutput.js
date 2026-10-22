import { StringDecoder } from "node:string_decoder";
import { redact } from "../observability/audit.js";
import { shrinkOutputPage } from "./outputPage.js";

// A model-facing projection never owns execution effects. Only its bounded,
// filtered copy is retained here; the executor result remains authoritative.
export async function prepareModelToolResult({ name, result, project, outputStore, maxBytes = 16000, secretRegistry, measure } = {}) {
  if (!Number.isFinite(maxBytes)) throw new TypeError("Model output byte limit must be finite.");
  const cap = Math.max(1024, Math.min(65536, Math.floor(maxBytes)));
  const size = measure ?? ((value) => Buffer.byteLength(JSON.stringify(value)));
  let projection;
  let projectionError;
  try { projection = project ? project(result) : result; }
  catch (error) {
    projection = result;
    projectionError = { code: error.code ?? "TOOL_OUTPUT_RENDER_FAILED", executionState: "executed", error: error.message };
  }
  projection = filterPayload(typeof projection === "string" ? { ok: result?.ok !== false, content: projection }
    : !projection || typeof projection !== "object" || Array.isArray(projection) ? { ok: result?.ok !== false, value: projection } : projection, secretRegistry);
  // Raw job bytes belong to the host-facing execution API. They must not bypass
  // the model projection's text filter through an encoded copy of the same data.
  if (name === "read_job_output" && projection && typeof projection === "object" && Object.hasOwn(projection, "base64")) {
    const { base64: _rawBytes, ...textOnly } = projection;
    projection = { ...textOnly, filtered: true, lossless: false };
  }
  if (projectionError) projection = filterPayload({ ...asObject(projection), projectionError }, secretRegistry);
  const text = JSON.stringify(projection);
  if (text === undefined) return { ok: false, code: "TOOL_OUTPUT_INVALID", executionState: "executed", error: "The completed tool produced no JSON model projection." };
  if (name === "read_output") return shrinkOutputPage(projection, { cap, measure: size });
  if (size(projection) <= cap) return projection;
  const status = { ok: result?.ok !== false, ...(/^[A-Z][A-Z0-9_]{0,99}$/.test(result?.code ?? "") ? { code: result.code } : {}),
    executionState: "executed", sourceComplete: false, truncated: true };
  // Job output is already durable and authorized by its job ID. Keep that
  // retrieval contract rather than duplicating its full log in a spill file.
  if (["run_shell", "read_job_output"].includes(name) && result?.jobId) return fitPreview({ ...status, jobId: result.jobId,
    stream: result.stream ?? "stdout", offset: result.offset ?? 0, totalBytes: result.totalBytes,
    retrievalHint: "Use read_job_output with this jobId and offset, selecting stdout or stderr and a smaller maxBytes; preview is not a consumed page." }, text, cap, secretRegistry, size);
  try {
    if (!outputStore) throw Object.assign(new Error("No output store is configured for this run."), { code: "OUTPUT_STORE_UNAVAILABLE" });
    const ref = await outputStore.save(text, { source: { tool: name } });
    return fitPreview({ ...status, ...ref,
      ...(projectionError ? { projectionError: { code: projectionError.code, executionState: "executed", error: brief(redact(projectionError.error, { secretRegistry, maxTextChars: Infinity })) } } : {}),
      retrievalHint: "Use read_output with outputRef and byte offset/maxBytes, or search_output with a literal query. Stored text is the complete filtered model projection as JSON." }, text, cap, secretRegistry, size);
  } catch (error) {
    return fitPreview({ ...status, ok: false, toolSucceeded: result?.ok !== false, code: "TOOL_OUTPUT_UNAVAILABLE",
      projectionError: { code: error.code ?? "OUTPUT_STORAGE_FAILED", error: brief(redact(error.message, { secretRegistry, maxTextChars: Infinity })) },
      retrievalHint: "Execution has already settled. Full output could not be retained; request a narrower observation instead of repeating a side effect." }, text, cap, secretRegistry, size);
  }
}

function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : { value }; }
function brief(value) { return new StringDecoder("utf8").write(Buffer.from(String(value ?? "")).subarray(0, 160)); }
function filterPayload(value, registry) {
  const cleanKeys = (item) => {
    if (Array.isArray(item)) return item.map(cleanKeys);
    if (!item || typeof item !== "object") return item;
    const out = Object.create(null);
    for (const [key, child] of Object.entries(item)) {
      const safe = redact(key, { secretRegistry: registry, maxTextChars: Infinity });
      let unique = safe, suffix = 1;
      while (Object.hasOwn(out, unique)) unique = safe + "#" + ++suffix;
      out[unique] = cleanKeys(child);
    }
    return Object.fromEntries(Object.entries(out));
  };
  return cleanKeys(redact(value, { secretRegistry: registry, maxTextChars: Infinity }));
}
function fitPreview(base, text, cap, registry, size) {
  base = filterPayload(base, registry);
  const data = Buffer.from(text);
  // Budget the actual transport envelope too. Error prose is expendable; the
  // settled execution status and opaque retrieval reference are not.
  if (size({ ...base, preview: textPreview(data, 0) }) > cap) {
    if (base.projectionError) base.projectionError = { code: base.projectionError.code };
    base.retrievalHint = base.outputRef ? "Use read_output or search_output with outputRef."
      : base.jobId ? "Use read_job_output with jobId and offset." : "Execution settled; request a narrower observation.";
  }
  let low = 0, high = Math.min(cap, data.length), selected = { ...base, preview: textPreview(data, 0) };
  if (size(selected) > cap) throw new RangeError("Model output transport metadata exceeds its byte limit.");
  while (low <= high) {
    const bytes = Math.floor((low + high) / 2);
    const candidate = { ...base, preview: textPreview(data, bytes) };
    if (size(candidate) <= cap) { selected = candidate; low = bytes + 1; }
    else high = bytes - 1;
  }
  return selected;
}
function textPreview(data, bytes) {
  const each = Math.floor(bytes / 2);
  const head = new StringDecoder("utf8").write(data.subarray(0, each));
  let tailStart = Math.max(0, data.length - each);
  while (tailStart < data.length && (data[tailStart] & 0xc0) === 0x80) tailStart++;
  const tail = data.subarray(tailStart).toString("utf8");
  return { head, tail, omittedBytes: data.length - Buffer.byteLength(head) - Buffer.byteLength(tail) };
}
