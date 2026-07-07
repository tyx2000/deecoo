import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function saveRunOutputs(store, session, { task, result }) {
  if (!store?.projectDir || !session?.id || !result) return [];
  const dir = join(store.projectDir, "outputs", session.id);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const outputs = [];
  if (result.reviewReport) {
    outputs.push(await writeOutput(dir, `${now}-review-report.json`, result.reviewReport));
  }
  if (result.verification) {
    outputs.push(await writeOutput(dir, `${now}-verification.json`, result.verification));
  }
  outputs.push(await writeOutput(dir, `${now}-summary.md`, summaryMarkdown({ task, result })));
  return outputs;
}

export function summaryMarkdown({ task, result }) {
  return [
    "# Deecoo Run Summary",
    "",
    "## Task",
    "",
    String(task ?? "").trim(),
    "",
    "## Workflow",
    "",
    "- status: " + (result?.workflow?.status ?? "unknown"),
    "- phase: " + (result?.workflow?.phase ?? "unknown"),
    "",
    "## Verification",
    "",
    "- status: " + (result?.verification?.status ?? "not-run"),
    "- commands: " + (result?.verification?.commands?.length ?? 0),
    "",
    "## Output",
    "",
    String(result?.finalText ?? "").trim(),
    "",
  ].join("\n");
}

async function writeOutput(dir, fileName, content) {
  const path = join(dir, fileName);
  const body = typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n";
  await writeFile(path, body, "utf8");
  return { path, fileName };
}
