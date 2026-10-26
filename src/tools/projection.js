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
  // Arrays keep their element type; how many items were cut is reported beside them.
  const omittedItems = {};
  for (const [key, limit] of [["files", 120], ["matches", 80], ["symbols", 80], ["references", 80]]) {
    if (!result[key]) continue;
    compact[key] = array(result[key], limit);
    if (Array.isArray(result[key]) && compact[key].length < result[key].length) omittedItems[key] = result[key].length - compact[key].length;
  }
  if (Object.keys(omittedItems).length) {
    compact.truncated = true;
    compact.sourceComplete = false;
    compact.omittedItems = omittedItems;
  }
  if (result.text !== undefined) compact.text = text(result.text, 30000);
  if (result.content !== undefined) compact.content = text(result.content, 30000);
  if (truncate && typeof result.content === "string" && result.content.length > 30000) {
    compact.truncated = true;
    compact.sourceComplete = false;
    compact.projectionTruncated = true;
    // Point a line-addressed read at the first line this projection did not show in full.
    if (Number.isSafeInteger(result.startLine)) {
      const completeLines = result.content.slice(0, 30000).split("\n").length - 1;
      compact.endLine = result.startLine + Math.max(1, completeLines) - 1;
      compact.nextStartLine = result.startLine + Math.max(1, completeLines);
    }
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
  return values.slice(0, maxItems);
}

function truncateText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... truncated ${text.length - maxChars} additional characters`;
}
