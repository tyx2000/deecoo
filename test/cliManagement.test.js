import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { parseArgs } from "../src/cli/args.js";
import { loadConfig } from "../src/config/env.js";
import { createSessionStore } from "../src/session/store.js";
import { recordProjectMemory, listMemory } from "../src/memory/projectMemory.js";
import { createChangeSet } from "../src/workspace/changes.js";
import { createExecutionBackend } from "../src/execution/backend.js";

const exec = promisify(execFile);
const cli = new URL("../bin/deecoo.js", import.meta.url).pathname;
async function workspace(fn) { const root = await mkdtemp(join(tmpdir(), "deecoo-management-")); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
const environment = (root, extra = {}) => ({ PATH: process.env.PATH, DEECOO_HOME: join(root, "home"), ...extra });
async function invoke(root, args, extra = {}) {
  const options = { cwd: root, env: environment(root, extra), timeout: 15000, maxBuffer: 1024 * 1024 };
  try { const result = await exec(process.execPath, [cli, "--cwd", root, "--settings", join(root, "settings.json"), "--json", ...args], options); return { ...result, status: 0, value: JSON.parse(result.stdout) }; }
  catch (error) { return { ...error, status: error.code, value: JSON.parse(error.stdout) }; }
}

test("machine argument parsing is explicit, validates limits, and honors -- literals", () => {
  const args = parseArgs(["--jsonl", "--sandbox", "required", "--sandbox-network", "deny", "--privacy", "ephemeral", "--retention-days", "0", "--context-window", "8192", "--output-reserve", "0", "--", "--literal", "jobs"]);
  assert.equal(args.nonInteractive, true); assert.equal(args.outputFormat, "jsonl"); assert.equal(args.retentionDays, 0); assert.equal(args.outputReserve, 0);
  assert.equal(args.task, "--literal jobs"); assert.equal(args.command, undefined);
  for (const input of [["--json", "--jsonl"], ["--sandbox", "invalid"], ["--context-window", "0"], ["--retention-days", "-1"], ["--cwd"], ["--unknown"]]) assert.throws(() => parseArgs(input));
  const config = loadConfig({}, { management: true, sandbox: "off", sandboxNetwork: "allow", privacyMode: "ephemeral", retentionDays: 0, outputReserve: 0, nonInteractive: true });
  assert.equal(config.apiKey, undefined); assert.equal(config.outputReserve, 0); assert.equal(config.retentionDays, 0); assert.equal(config.stream, false); assert.deepEqual(config.sandboxPolicy, { mode: "off", network: "allow" });
});

test("offline CLI capabilities, errors and help are structured without any provider credential", async () => workspace(async (root) => {
  const result = await invoke(root, ["jobs", "capabilities"]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.value.result.durableJobs, true); assert.equal(result.stderr, "");
  assert.equal((await invoke(root, ["jobs", "status"])).value.type, "error");
  assert.equal((await invoke(root, ["--help"])).value.type, "help");
  const noTask = await invoke(root, []); assert.equal(noTask.status, 1); assert.equal(noTask.value.type, "error");
  await assert.rejects(stat(join(root, ".deecoo", "PROJECT.md")), { code: "ENOENT" });
}));

test("offline CLI Memory list/edit/delete/prune uses selected project without automatic pruning", async () => workspace(async (root) => {
  const store = await createSessionStore(root, { rootDir: join(root, "home"), autoPrune: false });
  await recordProjectMemory(store, { projectFact: "Old user fact", expiresAt: "2000-01-01T00:00:00.000Z" });
  const [entry] = await listMemory(store, { includeExpired: true });
  const listed = await invoke(root, ["memory", "list", "--include-expired", "--retention-days", "0"]);
  assert.equal(listed.value.result.entries[0].id, entry.id, "listing must not prune old storage as a side effect");
  const edited = await invoke(root, ["memory", "edit", entry.id, "--text", "Updated user fact", "--expires-at", "none"]);
  assert.equal(edited.value.result.entry.text, "Updated user fact");
  const removed = await invoke(root, ["memory", "delete", entry.id]); assert.equal(removed.value.result.deleted, true);
  assert.equal((await invoke(root, ["memory", "list"])).value.result.entries.length, 0);
  assert.deepEqual((await invoke(root, ["memory", "prune"])).value.result.removed, []);
}));

test("offline CLI storage dry-run reports selected files without deleting them", async () => workspace(async (root) => {
  const store = await createSessionStore(root, { rootDir: join(root, "home"), autoPrune: false });
  const record = join(store.projectDir, "old-record.json"); await writeFile(record, "{}\n");
  const status = await invoke(root, ["storage", "status", "--retention-days", "0"]); assert.ok(status.value.result.files.some((file) => file.path === record));
  const dry = await invoke(root, ["storage", "prune", "--retention-days", "0", "--dry-run"]); assert.ok(dry.value.result.removed.some((file) => file.path === record)); assert.equal(await readFile(record, "utf8"), "{}\n");
  const pruned = await invoke(root, ["storage", "prune", "--retention-days", "0"]); assert.ok(pruned.value.result.removed.some((file) => file.path === record)); await assert.rejects(stat(record), { code: "ENOENT" });
}));

test("offline CLI task changes can be inspected, exported and undone with drift protection", async () => workspace(async (root) => {
  await writeFile(join(root, "a.js"), "user baseline\n");
  const store = await createSessionStore(root, { rootDir: join(root, "home"), autoPrune: false });
  const changes = await createChangeSet({ cwd: root, stateDir: join(store.projectDir, "changes"), id: "cli-change", task: "synthetic edit" });
  await changes.begin(); await writeFile(join(root, "a.js"), "task update\n"); await changes.capture();
  const listed = await invoke(root, ["changes", "list"]); assert.equal(listed.value.result.changes[0].id, changes.id);
  const shown = await invoke(root, ["changes", "show", changes.id, "--path", "a.js"]); assert.match(shown.value.result.files[0].diff, /task update/);
  const exported = await invoke(root, ["changes", "export", changes.id]); assert.match(exported.value.result.patch, /user baseline/);
  const undone = await invoke(root, ["changes", "undo", changes.id, "--path", "a.js"]); assert.equal(undone.value.result.ok, true); assert.equal(await readFile(join(root, "a.js"), "utf8"), "user baseline\n");
  const missing = await invoke(root, ["changes", "undo", changes.id, "--path", "missing.js"]); assert.equal(missing.status, 1);
}));

test("offline CLI reconnects to real durable job output and status using project ownership", async () => workspace(async (root) => {
  const store = await createSessionStore(root, { rootDir: join(root, "home"), autoPrune: false });
  const backend = createExecutionBackend({ cwd: root, stateDir: join(store.projectDir, "jobs"), sandboxPolicy: { mode: "off" } });
  const job = await backend.run({ command: "printf CLI_JOB_OUTPUT", timeoutMs: 1000 });
  const status = await invoke(root, ["jobs", "status", job.jobId]); assert.equal(status.value.result.status, "exited");
  const output = await invoke(root, ["jobs", "output", job.jobId, "--offset", "0", "--max-bytes", "7"]); assert.equal(output.value.result.text, "CLI_JOB"); assert.equal(output.value.result.truncated, true);
  const stopped = await invoke(root, ["jobs", "stop", job.jobId]); assert.equal(stopped.value.result.status, "exited");
}));

test("actual JSON and JSONL task CLI emits quiet redacted results with no interactive prompts", async () => workspace(async (root) => {
  const preloader = join(root, "provider.mjs");
  await writeFile(preloader, "globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'Inspected the empty fixture. synthetic-machine-secret-20261022'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200});\n");
  const env = environment(root, { DEEPSEEK_API_KEY: "synthetic-machine-secret-20261022", DEECOO_STREAM: "false", DEECOO_API_RETRIES: "1" });
  for (const format of ["--json", "--jsonl"]) {
    const result = await exec(process.execPath, ["--import", preloader, cli, "--cwd", root, "--settings", join(root, "settings.json"), format, "--privacy", "ephemeral", "explain the empty fixture"], { cwd: root, env, timeout: 15000 });
    const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.at(-1).type, "result"); assert.equal(records.at(-1).result.status, "completed");
    assert.equal(result.stderr, ""); assert.equal(result.stdout.includes("synthetic-machine-secret-20261022"), false); assert.equal(result.stdout.includes("\u001b"), false);
    if (format === "--jsonl") assert.ok(records.some((record) => record.type === "event"));
    else assert.equal(records.length, 1);
  }
}));

test("actual CLI loads an explicit acceptance JSON contract and reports missing required targets", async () => workspace(async (root) => {
  const preloader = join(root, "provider.mjs");
  await writeFile(preloader, "globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'The fixture was inspected.'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200});\n");
  const contract = join(root, "acceptance.json"); await writeFile(contract, JSON.stringify({ requiredChecks: [{ id: "required-test", command: "npm test" }] }));
  const result = await exec(process.execPath, ["--import", preloader, cli, "--cwd", root, "--settings", join(root, "settings.json"), "--json", "--acceptance", contract, "explain the fixture"], { cwd: root, env: environment(root, { DEEPSEEK_API_KEY: "fake", DEECOO_API_RETRIES: "1" }), timeout: 15000 }).then(() => assert.fail("Missing required target must fail"), (error) => error);
  const value = JSON.parse(result.stdout); assert.equal(value.result.acceptance.satisfied, false); assert.equal(value.result.acceptance.checks[0].id, "required-test"); assert.equal(value.result.acceptance.completionType, "partial");
}));
