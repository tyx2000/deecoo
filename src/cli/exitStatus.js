// Single-task CLI status; interactive sessions display failures and remain usable.
export function taskExitCode(result) {
  if (result?.timedOut || result?.stoppedReason === "task_deadline_exceeded") return 124;
  if (result?.interrupted || result?.status === "interrupted") return 130;
  return result?.status === "completed" && result?.workflow?.status === "completed" ? 0 : 1;
}
