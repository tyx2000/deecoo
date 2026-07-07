import { isPathNotFoundError } from "./pathPolicy.js";

export function toolExceptionResult(error) {
  const result = {
    ok: false,
    error: error?.message ?? String(error),
  };
  if (error?.code) result.code = error.code;
  if (isPathNotFoundError(error)) {
    result.recoverable = true;
    result.suggestion =
      "This missing path is recoverable. Inspect the workspace with list_files or search_text before retrying.";
  }
  return result;
}
