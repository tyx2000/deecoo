import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("../bin/deecoo.js", import.meta.url).pathname;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// Keep the real subprocess's input pipe open, just as a shell keeps a terminal
// open after a task finishes. Only terminal detection/raw-mode are substituted;
// readline's keypress decoder, stdin flow, CLI, and task cleanup are unchanged.
async function ttyFixture(mode, run, { interactive = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "deecoo-tty-lifecycle-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const preloader = join(root, "provider.mjs");
  await writeFile(preloader, `
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
process.stdin.isRaw = false;
process.stdin.setRawMode = (raw) => { process.stdin.isRaw = Boolean(raw); return process.stdin; };
if (${JSON.stringify(mode)} === "cancel-paused") {
  const readline = await import("node:readline");
  readline.emitKeypressEvents(process.stdin);
  const earlierConsumer = () => {};
  process.stdin.on("keypress", earlierConsumer);
  process.stdin.off("keypress", earlierConsumer);
  process.stdin.pause();
}
let calls = 0;
globalThis.fetch = async (_url, init) => {
  calls++;
  if (${JSON.stringify(mode)} === "failure") throw new Error("synthetic-tty-provider-failure");
  if (["timeout", "cancel", "cancel-paused"].includes(${JSON.stringify(mode)})) {
    process.stdout.write("MODEL_PENDING\\n");
    await new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  }
  const message = ${JSON.stringify(mode)} === "approval" && calls === 1
    ? { role: "assistant", tool_calls: [{ id: "approved-write", type: "function", function: {
        name: "write_file", arguments: JSON.stringify({ path: "approved.txt", content: "approved\\n" })
      } }] }
    : { role: "assistant", content: (${JSON.stringify(mode)} === "approval"
        ? "Updated approved.txt with the approved line. Tests were not run because this fixture has no test runner. "
        : "") + "DEECOO_TTY_OK_" + calls };
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { total_tokens: 1 } }), { status: 200 });
};
`);
  const task = mode === "approval" ? "Create approved.txt, then report the result." : "Only reply DEECOO_TTY_OK without calling tools.";
  const child = spawn(process.execPath, ["--import", preloader, cli,
    "--cwd", cwd, "--settings", join(root, "settings.json"), "--privacy", "ephemeral",
    "--context-window", "128000", ...(interactive ? [] : ["--task-mode", mode === "approval" ? "edit" : "analysis", task]),
  ], {
    cwd,
    env: {
      PATH: process.env.PATH, TMPDIR: tmpdir(),
      DEECOO_HOME: join(root, "home"), DEEPSEEK_API_KEY: "synthetic-tty-key",
      DEECOO_STREAM: "false", DEECOO_API_RETRIES: "1", DEECOO_MAX_STEPS: "4",
      DEECOO_TASK_TIMEOUT_MS: mode === "timeout" ? "1000" : "5000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdin.on("error", () => {});
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  let closed = false;
  const outcome = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { closed = true; done({ code, signal }); });
  });
  const output = () => stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (predicate(output())) return;
      assert.equal(closed, false, `CLI exited before ${description}: ${stderr}\n${output()}`);
      await delay(10);
    }
    assert.fail(`CLI did not reach ${description}: ${stderr}\n${output()}`);
  };
  const finish = async () => {
    let timer;
    try {
      const result = await Promise.race([outcome, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CLI kept stdin alive after task completion: ${stderr}\n${output()}`)), 5000);
      })]);
      assert.equal(result.signal, null, stderr + output());
      return { ...result, stdout: output(), stderr };
    } finally { clearTimeout(timer); }
  };
  try { return await run({ child, cwd, waitFor, finish, output }); }
  finally {
    if (!closed) child.kill("SIGKILL");
    child.stdin.destroy();
    await outcome.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

for (const [mode, expectedCode] of [["success", 0], ["failure", 1], ["timeout", 124]]) {
  test(`CLI-EXIT-002: TTY single-task ${mode} exits naturally while stdin remains open`, async () => {
    await ttyFixture(mode, async ({ finish }) => {
      const result = await finish();
      assert.equal(result.code, expectedCode, result.stderr + result.stdout);
      if (mode === "success") assert.match(result.stdout, /DEECOO_TTY_OK_1/);
      if (mode === "failure") assert.match(result.stderr, /synthetic-tty-provider-failure/);
    });
  });
}

for (const mode of ["cancel", "cancel-paused"]) {
  test(`CLI-EXIT-002: Esc cancellation releases TTY input (${mode}) and exits naturally`, async () => {
    await ttyFixture(mode, async ({ child, waitFor, finish }) => {
      await waitFor((text) => text.includes("MODEL_PENDING"), "the model request");
      child.stdin.write("\x1b");
      const result = await finish();
      assert.equal(result.code, 130, result.stderr + result.stdout);
      assert.match(result.stdout, /interrupted: Esc/);
    });
  });
}

test("CLI-EXIT-002: a TTY file approval still accepts input before single-task exit", async () => {
  await ttyFixture("approval", async ({ child, cwd, waitFor, finish }) => {
    await waitFor((text) => text.includes("Always Approve"), "the file approval menu");
    child.stdin.write("\r");
    const result = await finish();
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(await readFile(join(cwd, "approved.txt"), "utf8"), "approved\n");
    assert.match(result.stdout, /DEECOO_TTY_OK_2/);
  });
});

test("CLI-EXIT-002: interactive tasks remain usable after task input cleanup", async () => {
  await ttyFixture("success", async ({ child, waitFor, finish }) => {
    await waitFor((text) => text.includes("deecoo >>"), "the initial interactive prompt");
    child.stdin.write("Only reply DEECOO_TTY_OK without tools.\r");
    await waitFor((text) => text.includes("DEECOO_TTY_OK_1") && text.lastIndexOf("deecoo >>") > text.lastIndexOf("DEECOO_TTY_OK_1"), "the prompt after the first response");
    child.stdin.write("Only reply DEECOO_TTY_OK again without tools.\r");
    await waitFor((text) => text.includes("DEECOO_TTY_OK_2") && text.lastIndexOf("deecoo >>") > text.lastIndexOf("DEECOO_TTY_OK_2"), "the prompt after the second response");
    child.stdin.write("/exit\r");
    const result = await finish();
    assert.equal(result.code, 0, result.stderr + result.stdout);
  }, { interactive: true });
});
