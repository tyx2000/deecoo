// A read_output response is already a page of an immutable stored body. Shrink
// its source bytes to the final transport budget; never spill this page again.
export function shrinkOutputPage(page, { cap, measure = jsonBytes } = {}) {
  if (!Number.isSafeInteger(cap) || cap < 1 || typeof measure !== "function") throw new TypeError("A positive output page budget and measure function are required.");
  if (!page || typeof page !== "object" || Array.isArray(page)) return unreadable(page, cap, measure);
  if (page.ok === false && !Object.hasOwn(page, "base64")) return measure(page) <= cap ? page : unreadable(page, cap, measure);
  const bytes = decodePage(page);
  if (!bytes) return unreadable(page, cap, measure);

  const candidate = (length) => {
    const chunk = bytes.subarray(0, length);
    const nextOffset = page.offset + length;
    const rangeEndOffset = page.rangeEndOffset ?? page.totalBytes;
    const text = utf8(chunk);
    const result = { ...page, text, base64: chunk.toString("base64"), encoding: text === null ? "base64" : "utf8",
      nextOffset, rangeEndOffset, eof: nextOffset === page.totalBytes, rangeComplete: nextOffset === rangeEndOffset,
      truncated: nextOffset < rangeEndOffset,
      effectiveMaxBytes: length < bytes.length ? length : page.effectiveMaxBytes ?? length };
    if (length < bytes.length) {
      // These line coordinates describe the old page tail. A byte continuation
      // is exact even when this shorter tail is inside a line or code point.
      delete result.endLine;
      delete result.nextStartLine;
    }
    return result;
  };
  const complete = candidate(bytes.length);
  if (measure(complete) <= cap) return complete;
  if (!bytes.length) return unreadable(page, cap, measure);
  let selected = candidate(1);
  if (measure(selected) > cap) return unreadable(page, cap, measure);
  let low = 2, high = bytes.length - 1;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const next = candidate(length);
    // UTF-8 validity can change the presence of text, so this need not choose
    // the largest possible page. Every selected page is measured and advances.
    if (measure(next) <= cap) { selected = next; low = length + 1; }
    else high = length - 1;
  }
  return selected;
}

function decodePage(page) {
  if (typeof page.outputRef !== "string" || !/^out_[A-Za-z0-9_-]{32}$/.test(page.outputRef)
    || typeof page.base64 !== "string" || !Number.isSafeInteger(page.offset) || page.offset < 0
    || !Number.isSafeInteger(page.nextOffset) || page.nextOffset < page.offset
    || !Number.isSafeInteger(page.totalBytes) || page.totalBytes < page.nextOffset
    || page.rangeEndOffset !== undefined && (!Number.isSafeInteger(page.rangeEndOffset) || page.rangeEndOffset < page.nextOffset || page.rangeEndOffset > page.totalBytes)) return undefined;
  const bytes = Buffer.from(page.base64, "base64");
  if (bytes.toString("base64") !== page.base64 || bytes.length !== page.nextOffset - page.offset) return undefined;
  if (!bytes.length && page.offset < (page.rangeEndOffset ?? page.totalBytes)) return undefined;
  // Do not reconstruct an encoded copy if the already filtered readable text
  // differs. Store admission must first apply the current host secret rules.
  const text = utf8(bytes);
  if (text !== null && page.text !== text) return undefined;
  return bytes;
}
function utf8(bytes) {
  try { return new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return null; } // arbitrary byte cursors can split code points
}
function unreadable(page, cap, measure) {
  const identity = { ...(typeof page?.outputRef === "string" && /^out_[A-Za-z0-9_-]{32}$/.test(page.outputRef) ? { outputRef: page.outputRef } : {}),
    ...(Number.isSafeInteger(page?.offset) && page.offset >= 0 ? { offset: page.offset } : {}) };
  const result = { ok: false, code: "OUTPUT_PAGE_UNREADABLE", ...identity,
    error: "No stored bytes were consumed: this output page cannot fit the transport budget or has invalid byte metadata." };
  if (measure(result) <= cap) return result;
  delete result.error;
  if (measure(result) <= cap) return result;
  throw Object.assign(new RangeError("The output page error cannot fit the transport budget; no stored bytes were consumed."), { code: "OUTPUT_PAGE_UNREADABLE" });
}
function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
