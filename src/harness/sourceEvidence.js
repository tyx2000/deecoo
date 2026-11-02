// A resume is an executor-created boundary: history remains useful context, but source
// observations from before it cannot establish the current workspace's state.
export function sourceResumeRevision(events = []) {
  return events.reduce((revision, event) => event.type === "workspace-resumed" ? Math.max(revision, event.revision ?? 0) : revision, 0);
}

export function sourceEvidenceRevision(events = [], verification) {
  const checkIds = new Set((verification?.evidence ?? []).map((item) => item.id).filter(Boolean));
  return events.reduce((revision, event) => ["file-change", "workspace-uncertain", "workspace-resumed"].includes(event.type)
    || (event.type === "command" && !checkIds.has(event.id)) ? Math.max(revision, event.revision ?? 0) : revision, 0);
}
