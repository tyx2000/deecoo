import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyShellCommand } from "../src/permissions/shellPolicy.js";
import { createToolRuntime } from "../src/tools/runtime.js";

test("DS-CHECK-SEC-001 env split-string payloads retain project-code and nested-shell classification", () => {
  for (const command of ["env -S 'node payload.mjs'", 'env --split-string="node payload.mjs"', "env --split-string 'node payload.mjs'", "env -Snode payload.mjs", "env -i -u TEST -S 'node payload.mjs'", 'env -S \'env -S "node payload.mjs"\'']) {
    assert.equal(classifyShellCommand(command).level, "warn", command);
    assert.ok(classifyShellCommand(command).reasons.includes("runs workspace-defined or package code"), command);
  }
  assert.equal(classifyShellCommand('env -S \'sh -c "rm -rf /tmp/synthetic"\'').level, "block");
  assert.equal(classifyShellCommand('env -S \'sh -c "node payload.mjs"\'').level, "warn");
  for (const command of ["env -S 'node --version'", "env --split-string='node --version'", "env -i -S 'node --version'", "env -- node --version", "env -u TEST node --version", "env --version", "env --help"]) assert.equal(classifyShellCommand(command).level, "allow", command);
});

test("DS-CHECK-SEC-001 unsupported env syntax never degrades into an automatically approved empty command", () => {
  for (const command of ["env -S", "env --split-string", "env -S ''", "env -S 'node\\_payload.mjs'", "env -S '${COMMAND}'", "env -S '# ignored payload'", 'env -S \'node "payload.mjs\'', "env --unknown-wrapper-flag node --version"]) {
    assert.notEqual(classifyShellCommand(command).level, "allow", command);
  }
});

test("DS-CHECK-SEC-001 actual run_shell approval gates a harmless env -S payload", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deecoo-env-split-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "payload.mjs"), "import {writeFileSync} from 'node:fs'; writeFileSync('marker','EXECUTED');\n");
  const command = `env -S '${process.execPath} payload.mjs'`;
  let approvals = 0, dispatches = 0;
  // The integration contract here is approval, so use an in-process host adapter and
  // execute only this synthetic local payload after the policy has admitted it.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const executionBackend = { run: async ({ command, cwd }) => {
    dispatches++;
    const { stdout, stderr } = await exec("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } };
  const tools = createToolRuntime({ cwd: workspace, executionBackend, prompter: async () => { approvals++; return approvals === 1 ? "deny" : "approve"; } });
  assert.equal((await tools.execute("run_shell", { command })).ok, false);
  assert.equal(dispatches, 0);
  const result = await tools.execute("run_shell", { command });
  assert.equal(result.ok, true, result.error);
  assert.equal(approvals, 2);
  assert.equal(dispatches, 1);
  assert.equal(await readFile(join(workspace, "marker"), "utf8"), "EXECUTED");
});
