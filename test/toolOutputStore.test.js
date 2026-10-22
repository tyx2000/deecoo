import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createSecretRegistry } from "../src/config/secrets.js";
import { createToolOutputStore } from "../src/storage/toolOutputs.js";

const owner = { sessionId: "session-one", runId: "run-one" };
const exec = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function temporary(action) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deecoo-tool-outputs-")));
  try { return await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const diskPath = (stateDir, outputRef) => join(stateDir, outputRef + ".json");

test("output references persist complete filtered text with private permissions and no status paths", async () => temporary(async (root) => {
  const stateDir = join(root, "outputs");
  const secretRegistry = createSecretRegistry({ CUSTOM_API_KEY: "private-value-unknown-format" });
  const store = await createToolOutputStore({ stateDir, owner, secretRegistry });
  const text = "line\n".repeat(20000) + "private-value-unknown-format sk-abcdefghijklmnop";
  const saved = await store.save(text, { source: { tool: "read_file", invocationId: "call-1", step: 2 } });
  const restored = await store.read({ outputRef: saved.outputRef, maxBytes: 1024 * 1024 });
  assert.match(saved.outputRef, /^out_[A-Za-z0-9_-]{32}$/);
  assert.equal(restored.text, secretRegistry.redact(text).replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]"));
  assert.equal(restored.totalBytes, Buffer.byteLength(restored.text));
  assert.equal(saved.hash, hash(restored.text));
  assert.equal(saved.hash, restored.hash);
  assert.equal(restored.eof, true);
  assert.equal(restored.truncated, false);
  assert.equal((await lstat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(diskPath(stateDir, saved.outputRef))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(saved).includes(stateDir));
  assert.ok(!JSON.stringify(restored).includes(stateDir));
  assert.equal((await readdir(stateDir)).some((name) => name.endsWith(".tmp") || name.endsWith(".bak") || name.endsWith(".lock")), false);
}));

test("byte pages reassemble UTF-8 exactly across every multibyte boundary", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner });
  const text = "\uFEFFa汉🙂\r\nb世界\n尾";
  const saved = await store.save(text);
  for (const size of [1, 2, 3, 5, 7]) {
    const chunks = []; let offset = 0; let split = false;
    do {
      const page = await store.read({ outputRef: saved.outputRef, offset, maxBytes: size });
      assert.equal(page.offset, offset);
      assert.ok(page.nextOffset > offset);
      const chunk = Buffer.from(page.base64, "base64");
      assert.equal(chunk.length, page.nextOffset - offset);
      if (page.text === null) { split = true; assert.equal(page.encoding, "base64"); }
      else assert.equal(Buffer.from(page.text).equals(chunk), true);
      chunks.push(chunk); offset = page.nextOffset;
      if (page.eof) break;
    } while (true);
    assert.equal(Buffer.concat(chunks).toString("utf8"), text);
    assert.equal(offset, saved.totalBytes);
    if (size === 1) assert.equal(split, true);
  }
  assert.equal((await store.read({ outputRef: saved.outputRef, maxBytes: 1000 })).text, text);
  const eof = await store.read({ outputRef: saved.outputRef, offset: saved.totalBytes, maxBytes: 5 });
  assert.equal(eof.base64, ""); assert.equal(eof.eof, true);
}));

test("line ranges expose absolute byte boundaries for lossless bounded continuation", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner });
  const text = "head\r\n汉🙂 first\r\nsecond 世界\nlast\n";
  const saved = await store.save(text);
  let page = await store.read({ outputRef: saved.outputRef, startLine: 2, endLine: 3, maxBytes: 4 });
  const rangeEnd = page.rangeEndOffset;
  const pieces = [Buffer.from(page.base64, "base64")];
  assert.equal(page.offset, Buffer.byteLength("head\r\n"));
  assert.equal(page.rangeComplete, false);
  assert.equal(page.eof, false);
  while (page.nextOffset < rangeEnd) {
    page = await store.read({ outputRef: saved.outputRef, offset: page.nextOffset, maxBytes: Math.min(4, rangeEnd - page.nextOffset) });
    pieces.push(Buffer.from(page.base64, "base64"));
  }
  assert.equal(Buffer.concat(pieces).toString("utf8"), "汉🙂 first\r\nsecond 世界\n");
  const full = await store.read({ outputRef: saved.outputRef, startLine: 2, endLine: 3 });
  assert.equal(full.text, "汉🙂 first\r\nsecond 世界\n");
  assert.equal(full.startLine, 2); assert.equal(full.endLine, 3);
  assert.equal(full.nextStartLine, 4); assert.equal(full.rangeComplete, true); assert.equal(full.eof, false);
  const beyond = await store.read({ outputRef: saved.outputRef, startLine: 9 });
  assert.equal(beyond.text, ""); assert.equal(beyond.eof, true);
}));

test("empty output, CRLF and final newline have explicit line and EOF behavior", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner });
  const empty = await store.save("");
  assert.equal((await store.read({ outputRef: empty.outputRef, startLine: 1 })).text, "");
  const saved = await store.save("a\r\nb\r\n");
  assert.equal((await store.read({ outputRef: saved.outputRef, startLine: 1, endLine: 1 })).text, "a\r\n");
  assert.equal((await store.read({ outputRef: saved.outputRef, startLine: 2, endLine: 2 })).text, "b\r\n");
  assert.equal((await store.read({ outputRef: saved.outputRef, startLine: 3 })).text, "");
}));

test("literal search reports UTF-8 offsets and never interprets regex syntax", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner });
  const text = "汉 [a-z]+\r\n🙂 (a+)+$\n[a-z]+ again\n";
  const saved = await store.save(text);
  const literal = await store.search({ outputRef: saved.outputRef, query: "[a-z]+", maxResults: 1 });
  assert.equal(literal.matches.length, 1); assert.equal(literal.truncated, true);
  assert.equal(literal.matches[0].line, 1); assert.equal(literal.matches[0].column, 3);
  assert.equal(literal.matches[0].offset, Buffer.byteLength("汉 "));
  assert.equal(Buffer.from(text).subarray(literal.matches[0].offset, literal.matches[0].offset + literal.matches[0].matchBytes).toString(), "[a-z]+");
  const hostile = await store.search({ outputRef: saved.outputRef, query: "(a+)+$" });
  assert.equal(hostile.matches.length, 1); assert.equal(hostile.matches[0].line, 2);
  assert.deepEqual((await store.search({ outputRef: saved.outputRef, query: "not-there" })).matches, []);
}));

test("multiline literal search keeps later match line and byte coordinates correct", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner });
  const text = "x汉\ny\nx汉\ny\n";
  const saved = await store.save(text);
  const found = await store.search({ outputRef: saved.outputRef, query: "汉\ny" });
  assert.deepEqual(found.matches.map((item) => item.line), [1, 3]);
  assert.deepEqual(found.matches.map((item) => item.offset), [1, Buffer.byteLength("x汉\ny\nx")]);
  const long = await store.save("x".repeat(1000) + "needle");
  const snippet = (await store.search({ outputRef: long.outputRef, query: "needle" })).matches[0];
  assert.equal(snippet.previewTruncated, true);
  assert.ok(snippet.preview.includes("needle"));
}));

test("owner authorization rejects different sessions and runs but permits same-owner reopen", async () => temporary(async (stateDir) => {
  const first = await createToolOutputStore({ stateDir, owner });
  const saved = await first.save("owned");
  const same = await createToolOutputStore({ stateDir, owner });
  assert.equal((await same.read({ outputRef: saved.outputRef })).text, "owned");
  for (const otherOwner of [{ ...owner, sessionId: "another-session" }, { ...owner, runId: "another-run" }]) {
    const other = await createToolOutputStore({ stateDir, owner: otherOwner });
    await assert.rejects(other.read({ outputRef: saved.outputRef }), { code: "OUTPUT_OWNER_MISMATCH" });
    await assert.rejects(other.search({ outputRef: saved.outputRef, query: "owned" }), { code: "OUTPUT_OWNER_MISMATCH" });
  }
}));

test("reference and range admission reject paths and invalid numeric inputs", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner });
  const saved = await store.save("abc");
  for (const ref of ["../../outside.json", "/etc/passwd", saved.outputRef + ".json", "out_" + "x".repeat(32) + "/.."]) await assert.rejects(store.read({ outputRef: ref }), { code: "OUTPUT_INVALID_REFERENCE" });
  for (const args of [{ offset: -1 }, { offset: 4 }, { maxBytes: 0 }, { maxBytes: Infinity }, { maxBytes: 1024 * 1024 + 1 }, { startLine: 0 }, { startLine: 2, endLine: 1 }, { startLine: 1, offset: 0 }]) await assert.rejects(store.read({ outputRef: saved.outputRef, ...args }), { code: "OUTPUT_INVALID_RANGE" });
  for (const query of ["", "q".repeat(4097), "\ud800"]) await assert.rejects(store.search({ outputRef: saved.outputRef, query }), { code: "OUTPUT_INVALID_QUERY" });
}));

test("source metadata accepts bounded identities and refuses raw arguments", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner });
  for (const source of [{ tool: "read_file", args: { path: "secret" } }, { rawArgs: "secret" }, { tool: "x".repeat(101) }, { tool: "read_file", step: -1 }]) await assert.rejects(store.save("body", { source }), { code: "OUTPUT_INVALID_SOURCE" });
  await store.save("body", { source: "read_file" });
  await assert.rejects(store.save("\ud800"), { code: "OUTPUT_INVALID_TEXT" });
  assert.equal((await readdir(stateDir)).length, 1);
}));

test("shared capacity rejects new saves without evicting live references", async () => temporary(async (stateDir) => {
  const options = { stateDir, owner, maxBytes: 1500, maxFileBytes: 1500 };
  const first = await createToolOutputStore(options); const second = await createToolOutputStore(options);
  const results = await Promise.allSettled([first.save("a".repeat(600)), second.save("b".repeat(600))]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.find((entry) => entry.status === "rejected").reason.code, "OUTPUT_CAPACITY");
  const saved = results.find((entry) => entry.status === "fulfilled").value;
  assert.equal((await first.read({ outputRef: saved.outputRef })).totalBytes, 600);
  assert.equal((await readdir(stateDir)).filter((name) => name.endsWith(".json")).length, 1);
}));

test("file and shared capacity limits reject full saves explicitly and leave existing records intact", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner, maxBytes: 2000, maxFileBytes: 1000 });
  const saved = await store.save("kept");
  await assert.rejects(store.save("x".repeat(1000)), { code: "OUTPUT_FILE_LIMIT" });
  assert.equal((await store.read({ outputRef: saved.outputRef })).text, "kept");
  const full = await createToolOutputStore({ stateDir, owner, maxBytes: 0, maxFileBytes: 1000 });
  await assert.rejects(full.save(""), { code: "OUTPUT_CAPACITY" });
}));

test("TTL expiry is explicit and expired records can release quota without evicting live ones", async () => temporary(async (stateDir) => {
  const expiring = await createToolOutputStore({ stateDir, owner, retentionDays: 0 });
  const expired = await expiring.save("old");
  await assert.rejects(expiring.read({ outputRef: expired.outputRef }), { code: "OUTPUT_EXPIRED" });
  const current = await createToolOutputStore({ stateDir, owner, maxBytes: 1000, maxFileBytes: 1000 });
  const saved = await current.save("current");
  assert.equal((await current.read({ outputRef: saved.outputRef })).text, "current");
  await assert.rejects(expiring.read({ outputRef: expired.outputRef }), { code: "OUTPUT_NOT_FOUND" });
  const forever = await createToolOutputStore({ stateDir, owner, retentionDays: Infinity });
  assert.equal((await forever.save("long lived")).expiresAt, null);
}));

test("redacted and ephemeral stores keep output in task memory and dispose invalidates it", async () => temporary(async (root) => {
  for (const privacyMode of ["redacted", "ephemeral"]) {
    const stateDir = join(root, privacyMode);
    const secretRegistry = createSecretRegistry({ CUSTOM_API_KEY: "nonstandard-secret-value" });
    const store = await createToolOutputStore({ stateDir, owner, privacyMode, secretRegistry });
    const saved = await store.save("nonstandard-secret-value visible");
    assert.equal((await store.read({ outputRef: saved.outputRef })).text, "[redacted:CUSTOM_API_KEY] visible");
    await assert.rejects(lstat(stateDir), { code: "ENOENT" });
    const another = await createToolOutputStore({ stateDir, owner, privacyMode });
    await assert.rejects(another.read({ outputRef: saved.outputRef }), { code: "OUTPUT_NOT_FOUND" });
    const own = await another.save("other task state");
    store.dispose(); store.dispose();
    await assert.rejects(store.read({ outputRef: saved.outputRef }), { code: "OUTPUT_STORE_DISPOSED" });
    await assert.rejects(store.save("late"), { code: "OUTPUT_STORE_DISPOSED" });
    assert.equal((await another.read({ outputRef: own.outputRef })).text, "other task state");
  }
}));

test("dispose affects only this instance and never deletes shared durable output", async () => temporary(async (stateDir) => {
  const first = await createToolOutputStore({ stateDir, owner }); const second = await createToolOutputStore({ stateDir, owner });
  const saved = await first.save("durable"); first.dispose();
  await assert.rejects(first.read({ outputRef: saved.outputRef }), { code: "OUTPUT_STORE_DISPOSED" });
  assert.equal((await second.read({ outputRef: saved.outputRef })).text, "durable");
}));

test("malformed JSON, unsupported schema, modified body and forged hashes fail explicitly", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner });
  for (const mutation of [() => '{"interrupted":', (record) => JSON.stringify({ ...record, schemaVersion: 99 }), (record) => JSON.stringify({ ...record, text: "tampered" }), (record) => JSON.stringify({ ...record, hash: "0".repeat(64) })]) {
    const saved = await store.save("original"); const path = diskPath(stateDir, saved.outputRef);
    const record = JSON.parse(await readFile(path, "utf8")); await writeFile(path, mutation(record));
    await assert.rejects(store.read({ outputRef: saved.outputRef }), { code: "OUTPUT_CORRUPT" });
    assert.equal((await readdir(stateDir)).some((name) => name.includes(".corrupt-")), false);
  }
}));

test("interrupted orphan temp files never become readable references and consume quota", async () => temporary(async (stateDir) => {
  const store = await createToolOutputStore({ stateDir, owner, maxBytes: 1000, maxFileBytes: 1000 });
  const ref = "out_" + "x".repeat(32);
  await writeFile(join(stateDir, ref + ".json.12345678-1234-1234-1234-123456789012.tmp"), "x".repeat(900), { mode: 0o600 });
  await assert.rejects(store.read({ outputRef: ref }), { code: "OUTPUT_NOT_FOUND" });
  await assert.rejects(store.save("new"), { code: "OUTPUT_CAPACITY" });
}));

test("storage links, replacement directories and public permissions cannot redirect reads", async () => temporary(async (root) => {
  const stateDir = join(root, "outputs"); const outside = join(root, "outside"); await mkdir(outside, { mode: 0o700 });
  const linked = join(root, "linked"); await symlink(outside, linked);
  await assert.rejects(createToolOutputStore({ stateDir: linked, owner }), { code: "OUTPUT_UNSAFE_STATE" });
  const store = await createToolOutputStore({ stateDir, owner }); const saved = await store.save("safe");
  await rm(diskPath(stateDir, saved.outputRef)); await symlink(join(outside, "private"), diskPath(stateDir, saved.outputRef));
  await assert.rejects(store.read({ outputRef: saved.outputRef }), { code: "OUTPUT_UNSAFE_STATE" });
  await rename(stateDir, stateDir + "-old"); await mkdir(stateDir, { mode: 0o700 });
  await assert.rejects(store.read({ outputRef: saved.outputRef }), { code: "OUTPUT_UNSAFE_STATE" });
  await chmod(outside, 0o755);
  await assert.rejects(createToolOutputStore({ stateDir: outside, owner }), { code: "OUTPUT_UNSAFE_STATE" });
}));

test("newly registered secrets cannot leak through an older immutable output reference", async () => temporary(async (stateDir) => {
  const registry = createSecretRegistry(); const store = await createToolOutputStore({ stateDir, owner, secretRegistry: registry });
  const saved = await store.save("later-identified-private-value"); registry.add("later-identified-private-value");
  await assert.rejects(store.read({ outputRef: saved.outputRef }), { code: "OUTPUT_REDACTION_CHANGED" });
}));

test("resumed stores append secret registries without clearing earlier live filtering rules", async () => temporary(async (stateDir) => {
  for (const privacyMode of ["standard", "redacted", "ephemeral"]) {
    const original = createSecretRegistry({ FIRST_API_KEY: "first-private-credential" });
    const next = createSecretRegistry({ SECOND_API_KEY: "second-private-credential" });
    const store = await createToolOutputStore({ stateDir, owner, privacyMode, secretRegistry: original });
    const old = await store.save("second-private-credential");
    assert.equal(store.addSecretRegistry(next), undefined);
    store.addSecretRegistry(next);
    original.redact = (text) => text;
    store.addSecretRegistry(original); // re-adding cannot replace its captured filter
    await assert.rejects(store.read({ outputRef: old.outputRef }), { code: "OUTPUT_REDACTION_CHANGED" });
    await assert.rejects(store.search({ outputRef: old.outputRef, query: "credential" }), { code: "OUTPUT_REDACTION_CHANGED" });
    original.add("third-private-credential", "THIRD_API_KEY");
    next.add("fourth-private-credential", "FOURTH_API_KEY");
    const current = await store.save("first-private-credential second-private-credential third-private-credential fourth-private-credential");
    const body = (await store.read({ outputRef: current.outputRef })).text;
    assert.equal(body, "[redacted:FIRST_API_KEY] [redacted:SECOND_API_KEY] [redacted:THIRD_API_KEY] [redacted:FOURTH_API_KEY]");
    for (const invalid of [undefined, null, [], {}, { redact: true }, () => ""]) assert.throws(() => store.addSecretRegistry(invalid), { code: "OUTPUT_INVALID_SECRET_REGISTRY" });
    store.dispose();
    assert.throws(() => store.addSecretRegistry(next), { code: "OUTPUT_STORE_DISPOSED" });
  }
}));

test("independent processes share the same durable quota lock", async () => temporary(async (stateDir) => {
  const script = `import {createToolOutputStore} from ${JSON.stringify(new URL("../src/storage/toolOutputs.js", import.meta.url).href)};const store=await createToolOutputStore({stateDir:process.argv[1],owner:{sessionId:'session-one',runId:'run-one'},maxBytes:1500,maxFileBytes:1500});try{const saved=await store.save('x'.repeat(600));console.log(JSON.stringify({ok:true,...saved}));}catch(error){console.log(JSON.stringify({ok:false,code:error.code}));}`;
  const children = await Promise.all([exec(process.execPath, ["--input-type=module", "-e", script, stateDir]), exec(process.execPath, ["--input-type=module", "-e", script, stateDir])]);
  const results = children.map((child) => JSON.parse(child.stdout.trim()));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok).code, "OUTPUT_CAPACITY");
  const store = await createToolOutputStore({ stateDir, owner });
  assert.equal((await store.read({ outputRef: results.find((result) => result.ok).outputRef })).totalBytes, 600);
}));


test("metadata source secrets are filtered and opening one owner never erases another's live output", async () => temporary(async (stateDir) => {
  const registry = createSecretRegistry(); registry.add("private-call-id");
  const first = await createToolOutputStore({ stateDir, owner, secretRegistry: registry, maxBytes: 1500, maxFileBytes: 1500 });
  const saved = await first.save("a".repeat(600), { source: { tool: "probe", invocationId: "private-call-id" } });
  const record = JSON.parse(await readFile(diskPath(stateDir, saved.outputRef), "utf8"));
  assert.equal(record.source.invocationId, "redacted");
  const second = await createToolOutputStore({ stateDir, owner: { sessionId: "session-two", runId: "run-two" }, maxBytes: 1500, maxFileBytes: 1500 });
  await assert.rejects(second.save("b".repeat(600)), { code: "OUTPUT_CAPACITY" });
  assert.equal((await first.read({ outputRef: saved.outputRef })).totalBytes, 600);
  second.dispose();
  assert.equal((await first.read({ outputRef: saved.outputRef })).totalBytes, 600);
}));
