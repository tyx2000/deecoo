// Compatibility projection for built-in tools. Registered extensions own their projection.
export function compactToolResult(name, result, { truncate = true } = {}) {
  const text = (value, limit) => truncate ? truncateText(value, limit) : String(value ?? "");
  const array = (value, limit) => truncate ? compactArray(value, limit) : value;
  if (!result || typeof result !== "object") return result;
  const compact = {};
  for (const key of [
    "ok",
    "code",
    "error",
    "recoverable",
    "suggestion",
    "cached",
    "alreadyAvailable",
    "reason",
    "priorStep",
    "signature",
    "truncated",
    "path",
    "requestedPath",
    "bytesWritten",
    "status",
    "task_id",
    "mode",
    "stoppedReason",
    "jobId", "exitCode", "signal", "treeCleanup", "sandbox", "nextOffset", "offset", "eof",
    "sourceComplete", "contentHash", "version", "startLine", "endLine", "totalLines", "confidence", "metrics",
    "command", "cwd", "outputRef", "hash", "encoding", "retrievalHint", "expiresAt", "requestedMaxBytes", "effectiveMaxBytes", "executionState", "rangeStartOffset", "rangeEndOffset", "rangeComplete", "nextStartLine", "totalBytes", "base64", "stream", "createdAt", "updatedAt", "supervisorPid",
  ]) {
    if (result[key] !== undefined) compact[key] = result[key];
  }
  if (result.activity) compact.activity = result.activity;
  if (result.usage) compact.usage = result.usage;
  if (result.files) compact.files = array(result.files, 120);
  if (result.matches) compact.matches = array(result.matches, 80);
  if (result.symbols) compact.symbols = array(result.symbols, 80);
  if (result.references) compact.references = array(result.references, 80);
  if (truncate && ([result.matches, result.symbols, result.references].some((items) => Array.isArray(items) && items.length > 80) || Array.isArray(result.files) && result.files.length > 120)) compact.truncated = true;
  if (result.text !== undefined) compact.text = text(result.text, 30000);
  if (result.content !== undefined) compact.content = text(result.content, 30000);
  if (truncate && typeof result.content === "string" && result.content.length > 30000) {
    compact.truncated = true;
    compact.sourceComplete = false;
    compact.projectionTruncated = true;
  }
  if (result.failureSummary !== undefined) compact.failureSummary = text(result.failureSummary, 12000);
  if (result.stdout !== undefined) compact.stdout = text(result.stdout, 12000);
  if (result.stderr !== undefined) compact.stderr = text(result.stderr, 12000);
  if (result.diff !== undefined) compact.diff = text(result.diff, 20000);
  if (result.status !== undefined && name === "git_status") compact.status = text(result.status, 8000);
  if (result.summary !== undefined) compact.summary = text(result.summary, 4000);
  if (result.result !== undefined) compact.result = text(result.result, 16000);
  return compact;
}

function compactArray(values, maxItems) {
  if (!Array.isArray(values) || values.length <= maxItems) return values;
  return [
    ...values.slice(0, maxItems),
    `... truncated ${values.length - maxItems} additional item${values.length - maxItems === 1 ? "" : "s"}`,
  ];
}

function truncateText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... truncated ${text.length - maxChars} additional characters`;
}
