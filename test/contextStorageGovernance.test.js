import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { appendJsonEvent, atomicWriteFile, readJsonEvents, readJsonFile, updateJsonFile, writeJsonFile } from "../src/storage/atomic.js";
import { pruneStorage, storageInventory } from "../src/storage/governance.js";
import { createSessionStore, recordTurn, buildSessionContext } from "../src/session/store.js";
import { deleteSkillArtifact, listSkillArtifacts, readSkillArtifact, saveSkillArtifact } from "../src/session/artifacts.js";
import { deleteRunOutput, listRunOutputs, readRunOutput, saveRunOutputs } from "../src/reporter/outputs.js";
import { createSecretRegistry } from "../src/config/secrets.js";
import { saveRunAudit } from "../src/observability/audit.js";
import { listMemory, editMemory, deleteMemory, pruneMemory, recordProjectMemory, loadProjectMemory } from "../src/memory/projectMemory.js";
import { buildContextBudget, buildBudgetedContext, contextItem, measureContextMessages } from "../src/context/builder.js";
import { createCodeNavigator } from "../src/context/navigation.js";
import { readWorkspaceFile, getFileReadMetrics } from "../src/tools/files.js";
import { createCheckpointWriter } from "../src/harness/checkpoints.js";

const exec = promisify(execFile);
async function temporary(action) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "deecoo-context-storage-")));
  try { return await action(path); } finally { await rm(path, { recursive: true, force: true }); }
}

test("NEXT-007 reserves model output, budgets layers and fails explicitly for oversized required context", () => {
  const budget = buildContextBudget({ contextWindow: 512, outputReserve: 128, safetyReserve: 32 });
  assert.equal(budget.inputTokens, 352);
  assert.equal(budget.exactTokenizer, false);
  const result = buildBudgetedContext([
    contextItem({ role: "system", content: "Never remove access checks." }, 100, { required: true, layer: "instructions" }),
    contextItem({ role: "user", content: "Acceptance: tests must pass." }, 99, { required: true, layer: "task" }),
    contextItem({ role: "user", content: "too much ".repeat(1000) }, 60, { layer: "retrieval" }),
    contextItem({ role: "user", content: "Old failed check: npm test" }, 70, { layer: "history" }),
  ], { contextWindow: 512, outputReserve: 128, safetyReserve: 32 });
  assert.ok(measureContextMessages(result.messages) <= budget.inputTokens);
  assert.match(JSON.stringify(result.messages), /Never remove/);
  assert.match(JSON.stringify(result.messages), /Acceptance/);
  assert.equal(result.metrics.droppedItems, 1);
  assert.throws(() => buildBudgetedContext([contextItem({ content: "x".repeat(1000) }, 1, { required: true })], { contextWindow: 128, outputReserve: 32, safetyReserve: 8 }), { code: "CONTEXT_BUDGET_EXCEEDED" });
});

test("NEXT-007 line ranges and zero-based offsets share complete-file versions, never claim full source", async () => temporary(async (cwd) => {
  const text = Array.from({ length: 1000 }, (_, index) => `line ${index + 1} 汉字\n`).join("");
  await writeFile(join(cwd, "long.txt"), text);
  const state = { readCache: new Map() };
  const read = (args) => readWorkspaceFile(cwd, async () => cwd, { path: "long.txt", ...args }, state);
  const slice = await read({ startLine: 701, endLine: 703 });
  assert.equal(slice.content, "line 701 汉字\nline 702 汉字\nline 703 汉字\n");
  assert.equal(slice.sourceComplete, false);
  assert.equal(slice.truncated, false);
  const offset = await read({ offset: 700, limit: 3 });
  assert.equal(offset.content, slice.content);
  assert.equal(offset.contentHash, slice.contentHash);
  const full = await read({ maxBytes: 100000 });
  assert.equal(full.sourceComplete, true);
  assert.equal(full.content, text);
  assert.equal(full.version, slice.version);
  assert.equal((await read({ startLine: 2, offset: 1 })).code, "INVALID_READ_RANGE");
}));

test("NEXT-007 read cache detects external changes with unchanged file length and restored mtime", async () => temporary(async (cwd) => {
  const path = join(cwd, "a.js");
  await writeFile(path, "export const value = 1;\n");
  const state = { readCache: new Map() };
  const read = () => readWorkspaceFile(cwd, async () => cwd, { path: "a.js" }, state);
  const first = await read();
  assert.equal((await read()).cached, true);
  await writeFile(path, "export const value = 2;\n");
  await utimes(path, 1000, 1000);
  const second = await read();
  assert.notEqual(second.version, first.version);
  assert.equal(second.cached, undefined);
  assert.match(second.content, /2/);
  assert.deepEqual(getFileReadMetrics(state), { reads: 3, cacheHits: 1, cacheMisses: 2, invalidations: 1, bytesRead: 72 });
}));

test("NEXT-007 cached reads recheck symlink boundaries before reuse", async () => temporary(async (cwd) => {
  await writeFile(join(cwd, "a.txt"), "safe");
  const state = { readCache: new Map() };
  await readWorkspaceFile(cwd, async () => cwd, { path: "a.txt" }, state);
  await rm(join(cwd, "a.txt"));
  await symlink("/etc/passwd", join(cwd, "a.txt"));
  await assert.rejects(readWorkspaceFile(cwd, async () => cwd, { path: "a.txt" }, state), /symbolic links/);
}));

test("NEXT-007 lexical navigation locates cross-file references and invalidates edited/deleted symbols", async () => temporary(async (cwd) => {
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src/a.js"), "export function calculate(value) { return value + 1; }\n");
  await writeFile(join(cwd, "src/b.js"), "import { calculate } from './a.js';\ncalculate(2);\n");
  const navigator = await createCodeNavigator(cwd);
  const symbols = await navigator.symbols({ query: "calculate" });
  assert.equal(symbols.symbols[0].path, "src/a.js");
  assert.equal(symbols.symbols[0].line, 1);
  const references = await navigator.references({ symbol: "calculate", includeDeclarations: false });
  assert.equal(references.references.length, 2);
  assert.equal(references.navigationMode, "lexical-not-language-server");
  assert.ok(references.metrics.cacheHits >= 2);
  await writeFile(join(cwd, "src/a.js"), "export function replacement(value) { return value; }\n");
  assert.equal((await navigator.symbols({ query: "calculate" })).symbols.length, 0);
  assert.ok(navigator.metrics().invalidations >= 1);
  await rm(join(cwd, "src/a.js"));
  assert.equal((await navigator.symbols({ query: "replacement" })).symbols.length, 0);
  await assert.rejects(navigator.symbols({ directory: "../" }), /outside workspace/);
}));

test("NEXT-008 atomic updates serialize independent processes without losing increments", async () => temporary(async (cwd) => {
  const path = join(cwd, "counter.json");
  await writeJsonFile(path, { count: 0 });
  const script = `import { updateJsonFile } from ${JSON.stringify(new URL("../src/storage/atomic.js", import.meta.url).href)}; for(let i=0;i<12;i++) await updateJsonFile(process.argv[1], value => ({count:value.count+1}));`;
  await Promise.all([exec(process.execPath, ["--input-type=module", "-e", script, path]), exec(process.execPath, ["--input-type=module", "-e", script, path])]);
  assert.equal((await readJsonFile(path)).count, 24);
  assert.ok((await readdir(cwd)).every((file) => !file.endsWith(".tmp") && !file.endsWith(".lock")));
}));

test("NEXT-008 corrupt JSON recovers the last good backup and preserves quarantine; future schema is explicit", async () => temporary(async (cwd) => {
  const path = join(cwd, "state.json");
  await writeJsonFile(path, { schemaVersion: 1, value: "old" });
  await writeJsonFile(path, { schemaVersion: 1, value: "new" });
  await writeFile(path, '{"interrupted":');
  assert.equal((await readJsonFile(path)).value, "old");
  assert.ok((await readdir(cwd)).some((file) => file.includes(".corrupt-")));
  await writeFile(path, JSON.stringify({ schemaVersion: 99 }));
  await assert.rejects(readJsonFile(path, { validate: (value) => value.schemaVersion === 1 }), { code: "STORAGE_SCHEMA" });
  assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 99);
  await assert.rejects(atomicWriteFile(path, "too large", { maxBytes: 1 }), { code: "STORAGE_CAPACITY" });
  assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 99);
}));

test("NEXT-008 abandoned process lock is reclaimed without relying on age of live owners", async () => temporary(async (cwd) => {
  const path = join(cwd, "state.json");
  await writeFile(path, '{"value":1}');
  await mkdir(path + ".lock");
  await writeFile(path + ".lock/owner.json", JSON.stringify({ pid: 2147483647, token: "dead" }));
  assert.equal((await readJsonFile(path)).value, 1);
  await mkdir(path + ".lock");
  await writeFile(path + ".lock/owner.json", JSON.stringify({ pid: process.pid, token: "live" }));
  await assert.rejects(readJsonFile(path, { timeoutMs: 20, pollMs: 5 }), { code: "STORAGE_LOCK_TIMEOUT" });
}));

test("NEXT-008 sessions merge complete histories across processes and migrate legacy schema", async () => temporary(async (rootDir) => {
  const store = await createSessionStore("/synthetic-shared-session", { rootDir });
  const session = await store.createSession({ model: "offline" });
  const script = `import {createSessionStore,recordTurn} from ${JSON.stringify(new URL("../src/session/store.js", import.meta.url).href)}; const store=await createSessionStore('/synthetic-shared-session',{rootDir:process.argv[1]}); const session=await store.loadSession(process.argv[2]); for(let i=0;i<3;i++) await recordTurn(store,session,{user:process.argv[3]+i,assistant:'ok'});`;
  await Promise.all([exec(process.execPath, ["--input-type=module", "-e", script, rootDir, session.id, "first-"]), exec(process.execPath, ["--input-type=module", "-e", script, rootDir, session.id, "second-"])]);
  const restored = await store.loadSession(session.id);
  assert.equal(restored.history.length, 6);
  assert.equal(new Set(restored.history.map((turn) => turn.id)).size, 6);
  await writeFile(join(store.projectDir, "12345678.json"), JSON.stringify({ id: "12345678", cwd: "/legacy", turns: [{ user: "old", assistant: "old" }] }));
  const legacy = await store.loadSession("12345678");
  assert.equal(legacy.schemaVersion, 2);
  assert.equal(legacy.history.length, 1);
}));

test("NEXT-008 owner claims protect checkpoints; tool journal preserves unknown outcomes without replay", async () => temporary(async (rootDir) => {
  const store = await createSessionStore("/synthetic-owner-session", { rootDir, durableToolEvents: true });
  const session = await store.createSession();
  const writer = createCheckpointWriter({ store, sessionId: session.id, identity: {}, task: "inspect", runId: "one" });
  await writer.save({ version: 1, step: 1, messages: [] });
  await assert.rejects(store.claimTaskOwner(session.id, { runId: "two" }), { code: "STORAGE_OWNER_CONFLICT" });
  await assert.rejects(store.saveCheckpoint(session.id, { metadata: { runId: "two" } }), { code: "STORAGE_OWNER_CONFLICT" });
  await store.appendToolEvent(session.id, { runId: "one", callId: "call-1", phase: "before", tool: "write_file", args: { path: "a" } });
  const events = await store.readToolEvents(session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "before");
  assert.equal(events[0].sessionId, session.id);
  await writer.flush();
  await store.claimTaskOwner(session.id, { runId: "two" });
  await store.releaseTaskOwner(session.id, "two");
}));

test("NEXT-008 Memory management supports stable ids, edits, deletion, expiry and concurrent updates", async () => temporary(async (projectDir) => {
  const store = { projectDir, rootDir: projectDir };
  await Promise.all([recordProjectMemory(store, { projectFact: "first" }), recordProjectMemory(store, { projectFact: "second" })]);
  const items = await listMemory(store);
  assert.equal(items.length, 2);
  const id = items[0].id;
  await editMemory(store, { id, text: "edited", expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal((await listMemory(store)).length, 1);
  assert.equal((await listMemory(store, { includeExpired: true })).find((item) => item.id === id).text, "edited");
  assert.deepEqual((await pruneMemory(store)).removed, [{ id, scope: "project" }]);
  const remaining = (await listMemory(store))[0];
  assert.equal((await deleteMemory(store, { id: remaining.id })).deleted, true);
  assert.equal((await loadProjectMemory(store)).facts.length, 0);
}));

test("NEXT-008 retention/capacity inventory skips links; ephemeral privacy writes no sessions, audits, artifacts or Memory", async () => temporary(async (rootDir) => {
  const archive = join(rootDir, "archive");
  await mkdir(archive);
  await writeFile(join(archive, "old.json"), "old");
  await utimes(join(archive, "old.json"), 1000, 1000);
  await writeFile(join(archive, "new.json"), "new");
  await symlink("/etc/passwd", join(archive, "outside"));
  const dry = await pruneStorage(archive, { retentionDays: 1 }, { dryRun: true });
  assert.equal(dry.removed.length, 1);
  assert.equal((await readFile(join(archive, "old.json"), "utf8")), "old");
  await pruneStorage(archive, { retentionDays: 1 });
  assert.equal((await storageInventory(archive)).files.length, 1);
  const store = await createSessionStore("/private-project", { rootDir: join(rootDir, "private"), privacyMode: "ephemeral" });
  const session = await store.createSession();
  await recordTurn(store, session, { user: "private prompt", assistant: "private result" });
  await recordProjectMemory(store, { projectFact: "private fact" });
  assert.equal((await listMemory(store)).length, 1);
  assert.equal(await saveRunAudit(store, session, { task: "private" }), undefined);
  assert.equal(await saveSkillArtifact(store, session, { content: "private" }), undefined);
  assert.equal((await readdir(rootDir)).includes("private"), false);
}));

test("NEXT-008 deleting a session removes only its selected associated storage", async () => temporary(async (rootDir) => {
  const store = await createSessionStore("/delete-test", { rootDir });
  const session = await store.createSession();
  await recordTurn(store, session, { user: "hi", assistant: "hello" });
  await saveSkillArtifact(store, session, { skillName: "test", kind: "analysis", content: "full artifact" });
  await saveRunAudit(store, session, { task: "test" });
  await recordProjectMemory(store, { projectFact: "retained project fact" });
  await store.saveCheckpoint(session.id, { step: 1, messages: [] });
  await writeFile(join(store.projectDir, session.id + ".json.12345678-1234-1234-1234-123456789012.tmp"), "interrupted private snapshot");
  const deleted = await store.deleteSession(session.id);
  assert.equal(deleted.associated, true);
  assert.equal((await readdir(store.projectDir)).some((name) => name.endsWith(".tmp")), false);
  assert.equal(await store.loadSession(session.id), undefined);
  assert.equal(await store.loadCheckpoint(session.id), undefined);
  assert.equal((await loadProjectMemory(store)).facts.length, 1);
  await assert.rejects(readFile(join(store.projectDir, "artifacts", session.id)), { code: "ENOENT" });
}));

test("NEXT-007 compaction retains marked acceptance and unresolved failure evidence", async () => {
  const session = { turns: [], history: [], summary: "" };
  const store = { async save() {} };
  await recordTurn(store, session, { user: "Requirement: npm test and npm run check must both pass.", assistant: "Unresolved: npm test failed with a fixture error." });
  for (let index = 0; index < 9; index += 1) await recordTurn(store, session, { user: "continue " + index, assistant: "inspection " + index });
  const context = JSON.stringify(buildSessionContext(session));
  assert.match(context, /npm test and npm run check/);
  assert.match(context, /npm test failed/);
});


test("NEXT-008 output storage preserves complete redacted content and supports selected viewing/deletion", async () => temporary(async (rootDir) => {
  const store = await createSessionStore("/output-test", { rootDir });
  store.secretRegistry = createSecretRegistry({ CUSTOM_API_KEY: "nonstandard-private-value" });
  const session = await store.createSession();
  const content = "visible ".repeat(9000) + "nonstandard-private-value";
  await saveRunOutputs(store, session, { task: "inspect", result: { finalText: content, workflow: { status: "completed" } } });
  const outputs = await listRunOutputs(store, session);
  assert.equal(outputs.length, 2);
  const json = outputs.find((item) => item.fileName.endsWith(".json"));
  const restored = await readRunOutput(store, session, json.fileName);
  assert.equal(restored.finalText, store.secretRegistry.redact(content));
  assert.ok(restored.finalText.length > 70000);
  assert.ok(!restored.finalText.includes("nonstandard-private-value"));
  await deleteRunOutput(store, session, json.fileName);
  assert.equal((await listRunOutputs(store, session)).length, 1);
  await assert.rejects(readRunOutput(store, session, "../../outside.json"), /Invalid output/);
  const privateStore = await createSessionStore("/output-private-test", { rootDir, privacyMode: "ephemeral" });
  assert.deepEqual(await saveRunOutputs(privateStore, session, { task: "private", result: { finalText: "private" } }), []);
}));

test("NEXT-008 artifact indices serialize writers and deletions survive stale session saves", async () => temporary(async (rootDir) => {
  const store = await createSessionStore("/artifact-test", { rootDir });
  const session = await store.createSession();
  const stale = structuredClone(session);
  const [first, second] = await Promise.all([
    saveSkillArtifact(store, session, { skillName: "review", kind: "findings", content: "first" }),
    saveSkillArtifact(store, stale, { skillName: "review", kind: "findings", content: "second" }),
  ]);
  assert.notEqual(first.id, second.id);
  assert.equal((await listSkillArtifacts(store, session)).length, 2);
  assert.match((await readSkillArtifact(store, session, first.id)).content, /first/);
  const current = await store.loadSession(session.id);
  const old = structuredClone(current);
  await deleteSkillArtifact(store, current, first.id);
  await store.save(old);
  assert.equal((await store.loadSession(session.id)).artifacts.some((item) => item.id === first.id), false);
  assert.equal((await listSkillArtifacts(store, session)).length, 1);
}));

test("NEXT-008 deleted session tombstones reject stale saves; retention protects live task owners", async () => temporary(async (rootDir) => {
  const store = await createSessionStore("/session-delete-test", { rootDir });
  const session = await store.createSession();
  await recordTurn(store, session, { user: "hi", assistant: "hello" });
  await store.claimTaskOwner(session.id, { runId: "active" });
  const active = await store.prune({ now: Date.now() + 100 * 86400000 });
  assert.equal(active.removed.length, 0);
  await assert.rejects(store.deleteSession(session.id), { code: "STORAGE_OWNER_CONFLICT" });
  await store.releaseTaskOwner(session.id, "active");
  await store.deleteSession(session.id);
  await assert.rejects(store.save(session), { code: "SESSION_DELETED" });
  assert.equal(await store.loadSession(session.id), undefined);
}));

test("NEXT-008 journal tolerates only an interrupted tail and preserves a complete final record without newline", async () => temporary(async (rootDir) => {
  const path = join(rootDir, "events.jsonl");
  await appendJsonEvent(path, { phase: "before", id: 1 });
  await writeFile(path, (await readFile(path, "utf8")) + '{"phase":');
  assert.deepEqual(await readJsonEvents(path), [{ phase: "before", id: 1 }]);
  await appendJsonEvent(path, { phase: "after", id: 1 });
  assert.equal((await readJsonEvents(path)).length, 2);
  await writeFile(path, '{"id":1}\n{"id":2}');
  assert.equal((await readJsonEvents(path)).length, 2);
  await appendJsonEvent(path, { id: 3 });
  assert.equal((await readJsonEvents(path)).length, 3);
  await writeFile(path, '{"id":1}\ncorrupt\n{"id":3}\n');
  // A damaged middle line is skipped and counted instead of hiding every other event.
  const tolerant = await readJsonEvents(path);
  assert.deepEqual(tolerant, [{ id: 1 }, { id: 3 }]);
  assert.equal(tolerant.corruptEntries, 1);
}));

test("NEXT-008 checkpoint ownership readiness propagates rejection before a caller can execute", async () => temporary(async (rootDir) => {
  const store = await createSessionStore("/owner-ready-test", { rootDir });
  const session = await store.createSession();
  const first = createCheckpointWriter({ store, sessionId: session.id, runId: "first", identity: {}, task: "one" });
  await first.ready();
  const rejected = createCheckpointWriter({ store, sessionId: session.id, runId: "second", identity: {}, task: "two" });
  await assert.rejects(rejected.ready(), { code: "STORAGE_OWNER_CONFLICT" });
  await assert.rejects(rejected.flush(), { code: "STORAGE_OWNER_CONFLICT" });
  await first.save({ messages: [], step: 1 });
  assert.equal((await store.loadCheckpoint(session.id)).metadata.runId, "first");
  await first.flush();
}));


test("NEXT-008 legacy duplicate turns keep distinct stable ids during concurrent merge", async () => temporary(async (rootDir) => {
  const store = await createSessionStore("/legacy-duplicates", { rootDir });
  const turn = { user: "repeat", assistant: "same" };
  await writeFile(join(store.projectDir, "12345678.json"), JSON.stringify({ id: "12345678", cwd: "/legacy-duplicates", turns: [turn, turn], history: [turn, turn] }));
  const first = await store.loadSession("12345678");
  const second = await store.loadSession("12345678");
  assert.notEqual(first.history[0].id, first.history[1].id);
  assert.deepEqual(first.history.map((item) => item.id), second.history.map((item) => item.id));
  await Promise.all([recordTurn(store, first, { user: "one", assistant: "ok" }), recordTurn(store, second, { user: "two", assistant: "ok" })]);
  const restored = await store.loadSession("12345678");
  assert.equal(restored.history.length, 4);
  assert.equal(restored.history.filter((item) => item.user === "repeat").length, 2);
}));
