import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("../bin/deecoo.js", import.meta.url).pathname;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const ptyAvailable = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty, termios"], { stdio: "ignore" }).status === 0;
const ptyTestOptions = { skip: ptyAvailable ? false : "A real PTY probe requires the optional Python 3 standard library." };
// A real PTY, not isTTY/setRawMode substitutions. Python only transports bytes;
// Node's actual terminal detection, raw mode and keypress decoder run unchanged.
const ptyBridge = `
import errno, fcntl, os, pty, select, signal, struct, subprocess, sys, termios
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
inputs = [master, 0]
try:
  while True:
    ready, _, _ = select.select(inputs, [], [], 0.1)
    for source in ready:
      try:
        data = os.read(source, 65536)
      except OSError as error:
        if source == master and error.errno == errno.EIO: data = b""
        else: raise
      if source == master:
        if not data:
          sys.exit(child.wait())
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
      elif data: os.write(master, data)
      else: inputs.remove(0)
finally:
  if child.poll() is None:
    os.killpg(child.pid, signal.SIGKILL)
    child.wait()
  os.close(master)
`;

async function cliFixture({ tty = false, ignoresAbort = false }, run) {
  const root = await mkdtemp(join(tmpdir(), "deecoo-cli-interrupt-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const preloader = join(root, "provider.mjs");
  await writeFile(preloader, `
globalThis.fetch = async (_url, init) => {
  process.stdout.write("REQUEST_PENDING raw=" + Boolean(process.stdin.isRaw) + "\\n");
  return new Promise((_resolve, reject) => {
    const abort = () => {
      process.stdout.write("CANCEL_RECEIVED\\n");
      if (!${JSON.stringify(ignoresAbort)}) setTimeout(() => {
        process.stdout.write("COOPERATIVE_CLEANUP_FINISHED\\n");
        reject(init.signal.reason);
      }, 80);
    };
    if (init.signal.aborted) abort();
    else init.signal.addEventListener("abort", abort, { once: true });
  });
};
`);
  const argv = ["--import", preloader, cli, "--cwd", cwd, "--settings", join(root, "settings.json"),
    "--privacy", "ephemeral", "--context-window", "128000", "--task-mode", "analysis",
    ...(tty ? [] : ["--json"]), "Only reply without using tools."];
  const child = tty ? spawn("python3", ["-u", "-c", ptyBridge, process.execPath, ...argv], {
    cwd, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), DEECOO_HOME: join(root, "home"), DEEPSEEK_API_KEY: "synthetic",
      DEECOO_STREAM: "false", DEECOO_API_RETRIES: "1", DEECOO_TASK_TIMEOUT_MS: "12000" }, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(process.execPath, argv, { cwd, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), DEECOO_HOME: join(root, "home"), DEEPSEEK_API_KEY: "synthetic",
      DEECOO_STREAM: "false", DEECOO_API_RETRIES: "1", DEECOO_TASK_TIMEOUT_MS: "12000" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", closed = false;
  child.stdin.on("error", () => {});
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const outcome = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { closed = true; done({ code, signal }); });
  });
  const waitFor = async (text) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((stdout + stderr).includes(text)) return;
      assert.equal(closed, false, `CLI exited before ${text}: ${stdout}\n${stderr}`);
      await delay(10);
    }
    assert.fail(`CLI did not produce ${text}: ${stdout}\n${stderr}`);
  };
  const finish = async () => {
    let timer;
    try {
      const result = await Promise.race([outcome, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CLI did not exit: ${stdout}\n${stderr}`)), 5000);
      })]);
      assert.equal(result.signal, null, stdout + stderr);
      return { ...result, stdout, stderr };
    } finally { clearTimeout(timer); }
  };
  try { await waitFor("REQUEST_PENDING"); await run({ child, waitFor, finish }); }
  finally {
    // EOF alone cannot stop an ignoring provider. The PTY bridge's finally
    // cleans its Node process group on a fixture failure.
    if (!closed) child.kill(tty ? "SIGINT" : "SIGKILL");
    child.stdin.destroy();
    await outcome.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

test("N-5: real PTY raw Ctrl-C aborts the provider and awaits cooperative cleanup", ptyTestOptions, async () => {
  await cliFixture({ tty: true }, async ({ child, waitFor, finish }) => {
    await waitFor("raw=true");
    child.stdin.write("\x03");
    await waitFor("CANCEL_RECEIVED");
    const result = await finish();
    assert.equal(result.code, 130, result.stdout + result.stderr);
    assert.match(result.stdout, /COOPERATIVE_CLEANUP_FINISHED/);
    assert.doesNotMatch(result.stdout + result.stderr, /forced exit/);
  });
});

test("N-5: a second real raw Ctrl-C bounds an adapter that ignores cancellation", ptyTestOptions, async () => {
  await cliFixture({ tty: true, ignoresAbort: true }, async ({ child, waitFor, finish }) => {
    await waitFor("raw=true");
    child.stdin.write("\x03");
    await waitFor("CANCEL_RECEIVED");
    child.stdin.write("\x03");
    const result = await finish();
    assert.equal(result.code, 130, result.stdout + result.stderr);
    assert.match(result.stdout, /Second interrupt/);
  });
});

for (const [first, second, expected] of [["SIGINT", "SIGINT", 130], ["SIGTERM", "SIGTERM", 143], ["SIGINT", "SIGTERM", 143]]) {
  test(`N-5: ${first} then ${second} bounds an ignoring non-interactive provider`, async () => {
    await cliFixture({ ignoresAbort: true }, async ({ child, waitFor, finish }) => {
      child.kill(first);
      await waitFor("CANCEL_RECEIVED");
      child.kill(second);
      const result = await finish();
      assert.equal(result.code, expected, result.stdout + result.stderr);
      assert.match(result.stderr, /Second interrupt/);
    });
  });
}
