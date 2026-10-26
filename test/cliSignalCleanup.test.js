import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createSessionStore } from "../src/session/store.js";
import { createExecutionBackend } from "../src/execution/backend.js";

const cli = new URL("../bin/deecoo.js", import.meta.url).pathname;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`actual non-interactive CLI ${signal} awaits descendant cleanup before exiting`, async () => {
    const root = await mkdtemp(join(tmpdir(), "deecoo-cli-signal-"));
    const cwd = join(root, "project"); await mkdir(cwd);
    const home = join(root, "home");
    let child, outcome;
    const store = await createSessionStore(cwd, { rootDir: home, autoPrune: false });
    const backend = createExecutionBackend({ cwd, stateDir: join(store.projectDir, "jobs"), sandboxPolicy: { mode: "off" } });
    try {
      const writer = "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('marker','x'),20);";
      await writeFile(join(cwd, "writer.cjs"), `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`);
      const preloader = join(root, "provider.mjs");
      await writeFile(preloader, `globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'run',type:'function',function:{name:'run_shell',arguments:JSON.stringify({command:'node writer.cjs',timeoutMs:10000})}}]}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200});\n`);
      child = spawn(process.execPath, ["--import", preloader, cli, "--cwd", cwd, "--settings", join(root, "settings.json"), "--json", "--yes", "--sandbox", "off", "Run node writer.cjs."], { cwd, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), DEECOO_HOME: home, DEEPSEEK_API_KEY: "synthetic", DEECOO_API_RETRIES: "1", DEECOO_STREAM: "false", DEECOO_TASK_TIMEOUT_MS: "12000" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
      outcome = new Promise((done) => child.once("close", (code, exitSignal) => done({ code, exitSignal })));
      const deadline = Date.now() + 5000;
      let started = false;
      while (Date.now() < deadline) {
        const value = await readFile(join(cwd, "marker"), "utf8").catch(() => "");
        if (value.length) { started = true; break; }
        await delay(25);
      }
      assert.equal(started, true, "The real shell descendant must be active before cancellation");
      child.kill(signal);
      const completed = await Promise.race([outcome, delay(7000).then(() => null)]);
      assert.ok(completed, "CLI must finish cleanup promptly"); assert.equal(completed.code, expectedCode, stderr + stdout); assert.equal(completed.exitSignal, null);
      const before = await readFile(join(cwd, "marker"), "utf8"); await delay(120);
      assert.equal(await readFile(join(cwd, "marker"), "utf8"), before, "No descendant writes after CLI exit");
      const result = JSON.parse(stdout.trim()); assert.equal(result.result.status, "interrupted"); assert.equal(stderr, "");
    } finally {
      // Stop every supervisor created by this synthetic fixture even after a failed assertion.
      for (const entry of await readdir(join(store.projectDir, "jobs"), { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        await backend.stopJob(entry.name).catch(() => {});
      }
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (outcome) await Promise.race([outcome, delay(1000)]);
      await rm(root, { recursive: true, force: true });
    }
  });
}
