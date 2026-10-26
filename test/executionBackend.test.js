import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createExecutionBackend } from "../src/execution/backend.js";
import { executionEnv, normalizeSandboxPolicy, seatbeltProfile } from "../src/execution/sandbox.js";
import { delay, sameIdentity } from "../src/execution/processTree.js";
import { runShell } from "../src/tools/shell.js";
import { createToolRuntime } from "../src/tools/runtime.js";
import { buildTaskSpec } from "../src/harness/taskSpec.js";
import { buildVerificationPlan } from "../src/verification/planner.js";
import { advanceVerificationState, emptyVerificationState } from "../src/verification/state.js";
import { evaluateTaskAcceptance } from "../src/harness/acceptance.js";

const execFileAsync = promisify(execFile);
const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const node = shellQuote(process.execPath);

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deecoo-execution-test-")));
  const cwd = join(root, "workspace");
  const stateDir = join(root, "jobs");
  await mkdir(cwd);
  const backend = createExecutionBackend({ cwd, stateDir, sandboxPolicy: { mode: "off" }, ...options });
  const jobs = [];
  t.after(async () => {
    for (const jobId of jobs) await backend.stopJob(jobId).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, stateDir, backend, jobs };
}

async function waitFor(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await delay(20); } while (Date.now() < deadline);
  assert.fail("fixture condition did not become true");
}

test("execution preserves code, stderr and explicit environment without changing process.env", async (t) => {
  const { backend, cwd } = await fixture(t, { env: { PATH: process.env.PATH, TASK_VALUE: "private-task", OPENAI_API_KEY: "not-for-child", NODE_OPTIONS: "--bad-injection" } });
  const before = process.env.TASK_VALUE;
  const result = await backend.run({ command: `${node} -e ${shellQuote("console.log(JSON.stringify({cwd:process.cwd(),value:process.env.TASK_VALUE,secret:process.env.OPENAI_API_KEY,inject:process.env.NODE_OPTIONS}));console.error('failure detail');process.exit(7)")}` });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.treeCleanup.confirmed, true);
  assert.deepEqual(JSON.parse(result.stdout), { cwd, value: "private-task" });
  assert.match(result.stderr, /failure detail/);
  assert.equal(process.env.TASK_VALUE, before);
});

test("execution streams more than exec maxBuffer to disk and reads byte ranges", async (t) => {
  const { backend } = await fixture(t);
  const result = await backend.run({ command: `${node} -e ${shellQuote("process.stdout.write('x'.repeat(5*1024*1024));process.stderr.write('end')")}` });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.length, 20 * 1024);
  assert.equal(result.stdoutTruncated, true);
  const tail = await backend.readOutput(result.jobId, { offset: 5 * 1024 * 1024 - 11, maxBytes: 20 });
  assert.equal(tail.text, "x".repeat(11));
  assert.equal(tail.totalBytes, 5 * 1024 * 1024);
  assert.equal(tail.truncated, false);
  assert.equal((await backend.readOutput(result.jobId, { stream: "stderr" })).text, "end");
});

test("a disconnected launcher can reconnect to its durable job and stop it", async (t) => {
  const { backend, cwd, stateDir, jobs } = await fixture(t);
  const moduleUrl = new URL("../src/execution/backend.js", import.meta.url).href;
  const code = `import {createExecutionBackend} from ${JSON.stringify(moduleUrl)}; const b=createExecutionBackend(${JSON.stringify({ cwd, stateDir, sandboxPolicy: { mode: "off" } })});const job=await b.startJob({command:${JSON.stringify(`${node} -e ${shellQuote("console.log('ready');setInterval(()=>{},1000)")}`)}});console.log(job.jobId);`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code], { timeout: 5000 });
  const jobId = stdout.trim(); jobs.push(jobId);
  const job = await backend.getJob(jobId);
  assert.equal(job.status, "running");
  await waitFor(async () => (await backend.readOutput(jobId)).text.includes("ready"));
  const stopped = await backend.stopJob(jobId);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.treeCleanup.confirmed, true);
});

test("concurrent jobs keep cwd and environment separate", async (t) => {
  const { cwd, backend } = await fixture(t, { env: { PATH: process.env.PATH } });
  await Promise.all([mkdir(join(cwd, "a")), mkdir(join(cwd, "b"))]);
  const command = `${node} -e ${shellQuote("setTimeout(()=>console.log(process.cwd()+' '+process.env.TASK_VALUE),40)")}`;
  const [a, b] = await Promise.all([backend.run({ command, cwd: join(cwd, "a"), env: { TASK_VALUE: "a" } }), backend.run({ command, cwd: join(cwd, "b"), env: { TASK_VALUE: "b" } })]);
  assert.equal(a.stdout.trim(), join(cwd, "a") + " a");
  assert.equal(b.stdout.trim(), join(cwd, "b") + " b");
});

test("a task can replace an injected backend's captured environment completely", async (t) => {
  const { backend } = await fixture(t, { env: { PATH: process.env.PATH, OLD_TASK_VALUE: "stale" } });
  const command = `${node} -e ${shellQuote("console.log(JSON.stringify({old:process.env.OLD_TASK_VALUE,current:process.env.CURRENT_TASK_VALUE}))")}`;
  const result = await backend.run({ command, env: { CURRENT_TASK_VALUE: "current" }, replaceEnv: true });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdout), { current: "current" });
});

async function treeFixture(t) {
  const f = await fixture(t, { termGraceMs: 80, killGraceMs: 2000 });
  const marker = join(f.cwd, "marker");
  const child = join(f.cwd, "grandchild.cjs");
  const parent = join(f.cwd, "parent.cjs");
  await writeFile(child, `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),15);`);
  await writeFile(parent, `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
  return { ...f, marker, command: `${node} ${shellQuote(parent)}` };
}

test("stop waits for TERM-ignoring descendants to die before returning", async (t) => {
  const { backend, marker, command, jobs } = await treeFixture(t);
  const job = await backend.startJob({ command }); jobs.push(job.jobId);
  await waitFor(async () => (await readFile(marker, "utf8").catch(() => "")).length > 1);
  const result = await backend.stopJob(job.jobId);
  assert.equal(result.status, "stopped");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.treeCleanup.confirmed, true);
  assert.equal(result.treeCleanup.escalated, true);
  const content = await readFile(marker, "utf8");
  await delay(120);
  assert.equal(await readFile(marker, "utf8"), content);
});

test("timeout cleans the process group and reports the real termination signal", async (t) => {
  const { backend, marker, command } = await treeFixture(t);
  const result = await backend.run({ command, timeoutMs: 200 });
  assert.equal(result.status, "timed_out");
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.exitCode, null);
  assert.equal(result.treeCleanup.confirmed, true);
  const content = await readFile(marker, "utf8");
  await delay(100);
  assert.equal(await readFile(marker, "utf8"), content);
});

test("abort uses the same confirmed tree cleanup", async (t) => {
  const { backend, marker, command } = await treeFixture(t);
  const controller = new AbortController();
  const pending = backend.run({ command, signal: controller.signal });
  await waitFor(async () => (await readFile(marker, "utf8").catch(() => "")).length > 1);
  controller.abort();
  const result = await pending;
  assert.equal(result.code, "ABORT_ERR");
  assert.equal(result.status, "stopped");
  assert.equal(result.treeCleanup.confirmed, true);
});

test("job IDs and ownership are validated, and identity comparison rejects PID reuse", async (t) => {
  const { backend, cwd, stateDir } = await fixture(t);
  await assert.rejects(backend.getJob("../../other"), /Invalid execution job ID/);
  const result = await backend.run({ command: "printf owner" });
  const foreign = createExecutionBackend({ cwd, stateDir, ownerId: "different-task" });
  await assert.rejects(foreign.stopJob(result.jobId), /ownership mismatch/);
  assert.equal(sameIdentity({ pid: 42, start: "old", command: "node" }, { pid: 42, start: "new", command: "node" }), false);
  assert.equal(sameIdentity(null, null), false);
});

test("a stale stop token cannot control a live supervisor and corrupt state never replays", async (t) => {
  const { backend, stateDir, jobs } = await fixture(t);
  const job = await backend.startJob({ command: `${node} -e ${shellQuote("setInterval(()=>{},1000)")}` }); jobs.push(job.jobId);
  await writeFile(join(stateDir, job.jobId, "stop.json"), JSON.stringify({ nonce: "stale-job-token", reason: "cancelled" }));
  await delay(100);
  assert.equal((await backend.getJob(job.jobId)).status, "running");
  assert.equal((await backend.stopJob(job.jobId)).treeCleanup.confirmed, true);
  await writeFile(join(stateDir, job.jobId, "job.json"), "{broken");
  await assert.rejects(backend.getJob(job.jobId), { code: "JOB_STATE_CORRUPT" });
});

test("required sandbox fails closed when the OS backend cannot launch", async (t) => {
  const f = await fixture(t, { sandboxPolicy: { mode: "required" } });
  if (f.backend.capabilities().sandbox.available) return t.skip("OS sandbox available; enforcement is covered separately");
  await assert.rejects(f.backend.run({ command: "printf should-not-execute" }), { code: "SANDBOX_UNAVAILABLE" });
});

test("OS sandbox blocks script filesystem/network access and preserves permitted work", async (t) => {
  const f = await fixture(t, { sandboxPolicy: { mode: "required" } });
  if (!f.backend.capabilities().sandbox.available) {
    assert.notEqual(process.env.DEECOO_REQUIRE_SANDBOX_TESTS, "1", f.backend.capabilities().sandbox.reason);
    return t.skip(f.backend.capabilities().sandbox.reason);
  }
  const outside = join(f.root, "outside-secret");
  await writeFile(outside, "synthetic-secret");
  const listener = createServer((socket) => socket.end("fixture"));
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const port = listener.address().port;
  const script = join(f.cwd, "probe.cjs");
  await writeFile(script, `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');const result={};try{fs.readFileSync(${JSON.stringify(outside)});result.read='allowed'}catch{result.read='denied'}try{fs.writeFileSync(${JSON.stringify(outside)},'overwrite');result.write='allowed'}catch{result.write='denied'}fs.writeFileSync('permitted','yes');result.child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`try{require('node:fs').readFileSync(${JSON.stringify(outside)});process.stdout.write('allowed')}catch{process.stdout.write('denied')}`)}],{encoding:'utf8'}).stdout;const socket=net.connect(${port},'127.0.0.1');socket.on('error',()=>{result.network='denied';console.log(JSON.stringify(result))});socket.on('connect',()=>{result.network='allowed';socket.destroy();console.log(JSON.stringify(result))})`);
  const result = await f.backend.run({ command: `${node} ${shellQuote(script)}`, timeoutMs: 3000 });
  assert.equal(result.ok, true, result.stderr || result.error);
  assert.equal(result.sandbox.enforced, true);
  assert.deepEqual(JSON.parse(result.stdout), { read: "denied", write: "denied", child: "denied", network: "denied" });
  assert.equal(await readFile(join(f.cwd, "permitted"), "utf8"), "yes");
  assert.equal(await readFile(outside, "utf8"), "synthetic-secret");
  await writeFile(join(f.cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "console.log(12345)"' } }));
  const projectCheck = await f.backend.run({ command: "npm test --silent" });
  assert.equal(projectCheck.ok, true, projectCheck.stderr || projectCheck.error);
  assert.match(projectCheck.stdout, /12345/);
});

test("hard CPU and file-size limits stop resource-heavy commands", async (t) => {
  const cpu = await fixture(t, { sandboxPolicy: { mode: "off", resources: { cpuSeconds: 1 } } });
  const result = await cpu.backend.run({ command: `${node} -e ${shellQuote("while(true){}")}`, timeoutMs: 4000 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.ok(["SIGKILL", "SIGXCPU"].includes(result.signal), result.signal);
  const file = await fixture(t, { sandboxPolicy: { mode: "off", resources: { fileSizeBytes: 4096 } } });
  const output = await file.backend.run({ command: `${node} -e ${shellQuote("require('node:fs').writeFileSync('too-large','x'.repeat(100000))")}` });
  assert.equal(output.ok, false);
  assert.ok((await stat(join(file.cwd, "too-large"))).size <= 4096);
});

test("resource policy applies hard open-file limits to the command", async (t) => {
  const { backend } = await fixture(t, { sandboxPolicy: { mode: "off", resources: { openFiles: 48 } } });
  const source = "const fs=require('node:fs');let count=0;try{for(;count<100;count++)fs.openSync('/dev/null','r')}catch(e){console.log(e.code+' '+count)}";
  const result = await backend.run({ command: `${node} -e ${shellQuote(source)}` });
  assert.equal(result.ok, true, result.stderr);
  assert.match(result.stdout, /^EMFILE \d+/);
  assert.ok(Number(result.stdout.trim().split(" ")[1]) < 48);
});

test("shell background jobs retain shell approval and policy", async () => {
  const calls = [];
  const executionBackend = { startJob: async (args) => { calls.push(args); return { jobId: "fixture", status: "running" }; } };
  const denied = await runShell("/tmp", { command: "echo hi > out", background: true }, async () => "deny", false, { executionBackend });
  assert.equal(denied.ok, false);
  assert.equal(calls.length, 0);
  const result = await runShell("/tmp", { command: "echo hi > out", background: true }, async () => "approve", false, { executionBackend });
  assert.equal(result.jobId, "fixture");
  assert.equal(result.shellPolicy.level, "warn");
  assert.equal(calls.length, 1);
});

test("real shell cwd creates scoped check evidence and refuses unsafe cwd before approval", async (t) => {
  const { backend, cwd, root } = await fixture(t);
  await mkdir(join(cwd, "packages", "api"), { recursive: true });
  await writeFile(join(cwd, "packages", "api", "package.json"), JSON.stringify({ scripts: { test: 'node -e "console.log(12345)"' } }));
  let prompts = 0;
  const runtime = createToolRuntime({ cwd, executionBackend: backend, prompter: async () => { prompts++; return "approve"; } });
  const result = await runtime.execute("run_shell", { command: "npm test", cwd: "packages/api" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.effects.events[0].scope, "packages/api");
  const taskSpec = buildTaskSpec({ task: "Run API tests", requiredChecks: [{ command: "npm test", scope: "packages/api" }] });
  const verificationPlan = buildVerificationPlan({ taskSpec });
  const verification = advanceVerificationState(emptyVerificationState(), { name: "run_shell", args: { command: "npm test" }, result }, { plan: verificationPlan });
  assert.equal(evaluateTaskAcceptance({ taskSpec, verificationPlan, verification }).satisfied, true);
  await Promise.all([mkdir(join(cwd, ".aws")), mkdir(join(cwd, "node_modules")), symlink(root, join(cwd, "outside"))]);
  for (const unsafeCwd of ["..", ".aws", "node_modules", "outside"]) {
    const denied = await runtime.execute("run_shell", { command: "echo hi > no-side-effect", cwd: unsafeCwd });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "SHELL_CWD_BLOCKED", unsafeCwd);
  }
  assert.equal(prompts, 1, "npm test runs workspace-defined code and needs one approval; invalid cwd must be rejected before risky-command approval");
});

test("dispose stops and removes only this backend instance's jobs", async (t) => {
  const { backend, cwd, stateDir, jobs } = await fixture(t);
  const other = createExecutionBackend({ cwd, stateDir, sandboxPolicy: { mode: "off" } });
  const command = `${node} -e ${shellQuote("setInterval(()=>{},1000)")}`;
  const ownJob = await backend.startJob({ command });
  const foreignJob = await other.startJob({ command }); jobs.push(foreignJob.jobId);
  t.after(() => other.dispose({ stopRunning: true, removeState: true }));
  const retained = await backend.dispose({ removeState: true });
  assert.equal(retained.ok, false);
  assert.equal((await backend.getJob(ownJob.jobId)).status, "running");
  const result = await backend.dispose({ stopRunning: true, removeState: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, [ownJob.jobId]);
  await assert.rejects(backend.getJob(ownJob.jobId), { code: "ENOENT" });
  assert.equal((await other.getJob(foreignJob.jobId)).status, "running");
});

test("environment injection is removed and sandbox profiles deny credentials and network", () => {
  const env = executionEnv({ PATH: "/bin", LD_PRELOAD: "bad", BASH_ENV: "bad", TASK: "ok", AUTH_TOKEN: "bad", NODE_TEST_CONTEXT: "child", npm_config_ignore_scripts: "true" }, "/private/tmp/job");
  assert.deepEqual(env, { PATH: "/bin", TASK: "ok", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false", GIT_PAGER: "cat", HOME: "/private/tmp/job", TMPDIR: "/private/tmp/job", TMP: "/private/tmp/job", TEMP: "/private/tmp/job", XDG_CACHE_HOME: "/private/tmp/job", XDG_CONFIG_HOME: "/private/tmp/job" });
  const policy = normalizeSandboxPolicy({ mode: "required", denyReadRoots: ["/private/tmp/synthetic-credential"] }, "/private/tmp/work", "/private/tmp/jobs", "/private/tmp/temp");
  const profile = seatbeltProfile(policy);
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /deny file-read\* \(subpath "\/private\/tmp\/synthetic-credential"\)/);
  assert.doesNotMatch(profile, /allow network/);
});
