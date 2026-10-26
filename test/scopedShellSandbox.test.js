import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExecutionBackend } from "../src/execution/backend.js";
import { compileWriteRestrictions } from "../src/execution/writeRestrictions.js";
import { executionCommand } from "../src/execution/sandbox.js";
import { buildTaskToolPolicy } from "../src/permissions/taskPolicy.js";
import { inferTaskIntent } from "../src/harness/taskIntent.js";
import { createToolRuntime } from "../src/tools/runtime.js";

const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
const node = (code) => `${quote(process.execPath)} -e ${quote(code)}`;
const restrictions = [{ kind: "tests" }, { kind: "generated" }, { kind: "path", path: "docs/locked.md" }];
async function fixture(t, sandboxPolicy = { mode: "required" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deecoo-scoped-os-")));
  const cwd = join(root, "workspace");
  const stateDir = join(root, "jobs");
  for (const directory of ["src/nested", "tests", "generated", "docs"]) await mkdir(join(cwd, directory), { recursive: true });
  const files = { "src/main.js": "BEFORE", "src/nested/test-value.js": "PROTECTED", "tests/unit.js": "PROTECTED", "test.js": "import assert from 'node:assert/strict'; assert.equal(1+1,2);\n", "generated/result.js": "PROTECTED", "docs/locked.md": "PROTECTED" };
  for (const [path, content] of Object.entries(files)) await writeFile(join(cwd, path), content);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test.js" } }));
  const backend = createExecutionBackend({ cwd, stateDir, sandboxPolicy });
  t.after(async () => { await backend.dispose({ stopRunning: true, removeState: true }); await rm(root, { recursive: true, force: true }); });
  return { cwd, backend, files };
}
function available(t, backend) {
  if (!backend.capabilities().scopedWriteRestrictions) { t.skip(backend.capabilities().sandbox.reason ?? "Scoped shell enforcement requires available macOS seatbelt"); return false; }
  return true;
}
async function unchanged(cwd, files) { for (const [path, content] of Object.entries(files)) if (path !== "src/main.js") assert.equal(await readFile(join(cwd, path), "utf8"), content, path); }

test("N-1 scoped backend refuses off, unavailable, and unsupported OS modes before dispatch", async (t) => {
  const { backend } = await fixture(t, { mode: "off" });
  assert.equal(backend.capabilities().scopedWriteRestrictions, false);
  await assert.rejects(backend.run({ command: "printf MUST_NOT_RUN", writeRestrictions: restrictions }), { code: "TASK_SCOPED_SHELL_UNAVAILABLE" });
  const policy = { mode: "auto", scopedWriteRestrictions: restrictions, resources: {} };
  for (const sandbox of [{ available: false, kind: "seatbelt" }, { available: true, kind: "bubblewrap" }]) assert.throws(() => executionCommand({ command: "printf MUST_NOT_RUN", cwd: "/tmp", policy, sandbox }), { code: "TASK_SCOPED_SHELL_UNAVAILABLE" });
});

test("N-1 scope scan detects pre-existing hardlink aliases and bounded/incomplete inspection fails closed", async (t) => {
  const { cwd } = await fixture(t);
  await link(join(cwd, "tests/unit.js"), join(cwd, "src/alias.js"));
  await assert.rejects(compileWriteRestrictions(cwd, restrictions), { code: "TASK_SCOPED_HARDLINK_UNSAFE" });
  await assert.rejects(compileWriteRestrictions(cwd, restrictions, { maxPaths: 1 }), { code: "TASK_SCOPED_SCAN_LIMIT" });
  await assert.rejects(compileWriteRestrictions(cwd, [{ kind: "unknown" }]), { code: "TASK_SCOPED_RESTRICTIONS_INVALID" });
});

test("N-1 real scoped shell can edit src and run npm test while protected code remains unchanged", async (t) => {
  const { cwd, backend, files } = await fixture(t);
  if (!available(t, backend)) return;
  const tools = createToolRuntime({ cwd, executionBackend: backend, permissionMode: "workspace-write", prompter: async () => "approve" });
  tools.setTaskToolPolicy(buildTaskToolPolicy(inferTaskIntent("不要修改任何测试文件，不要修改生成文件，不要修改 docs/locked.md，只修复 src 的 bug")));
  const edited = await tools.execute("run_shell", { command: node("require('node:fs').writeFileSync('src/main.js','FIXED')") });
  assert.equal(edited.ok, true, edited.stderr || edited.error);
  assert.equal(edited.sandbox.enforced, true);
  assert.deepEqual(edited.sandbox.writeRestrictions, restrictions);
  assert.equal(await readFile(join(cwd, "src/main.js"), "utf8"), "FIXED");
  const checked = await tools.execute("run_shell", { command: "npm test" });
  assert.equal(checked.ok, true, checked.stderr || checked.error);
  assert.match(checked.stdout, /pass 1/);
  await unchanged(cwd, files);
});

test("N-1 real scoped shell rejects existing/new protected names, generated names, and renames", async (t) => {
  const { cwd, backend, files } = await fixture(t);
  if (!available(t, backend)) return;
  for (const path of ["tests/unit.js", "src/nested/test-value.js", "test.js", "spec.js", "src/new_test.go", "src/NewTest.java", "generated/result.js", "src/model.generated.js", "docs/locked.md", "TESTS/new.js", "test\\escape.js"]) {
    const result = await backend.run({ command: node(`require('node:fs').writeFileSync(${JSON.stringify(path)},'ESCAPED')`), writeRestrictions: restrictions });
    assert.equal(result.ok, false, path);
    assert.equal(result.sandbox.enforced, true, path);
    assert.doesNotMatch(result.stderr, /error while parsing|syntax error/i, path);
  }
  const moved = await backend.run({ command: node("require('node:fs').renameSync('tests/unit.js','src/renamed.js')"), writeRestrictions: restrictions });
  assert.equal(moved.ok, false);
  await unchanged(cwd, files);
});

test("N-1 real scoped shell cannot rename an ordinary protected ancestor but can mutate src files", async (t) => {
  const { cwd, backend, files } = await fixture(t);
  if (!available(t, backend)) return;
  const attempt = await backend.run({ command: node("const f=require('node:fs');f.renameSync('src','moved');f.writeFileSync('moved/nested/test-value.js','ESCAPED')"), writeRestrictions: restrictions });
  assert.equal(attempt.ok, false, attempt.stderr);
  await unchanged(cwd, files);
  const safe = await backend.run({ command: node("const f=require('node:fs');f.writeFileSync('src/new.js','SAFE');f.renameSync('src/new.js','src/renamed.js')"), writeRestrictions: restrictions });
  assert.equal(safe.ok, true, safe.stderr);
  assert.equal(await readFile(join(cwd, "src/renamed.js"), "utf8"), "SAFE");
});

test("N-1 real scoped shell blocks new hardlinks and rejects aliases that predate sandbox startup", async (t) => {
  const { cwd, backend, files } = await fixture(t);
  if (!available(t, backend)) return;
  const attempt = await backend.run({ command: node("const f=require('node:fs');f.linkSync('tests/unit.js','src/link.js');f.writeFileSync('src/link.js','ESCAPED')"), writeRestrictions: restrictions });
  assert.equal(attempt.ok, false);
  await unchanged(cwd, files);
  await link(join(cwd, "tests/unit.js"), join(cwd, "src/existing-link.js"));
  await assert.rejects(backend.run({ command: node("require('node:fs').writeFileSync('src/existing-link.js','ESCAPED')"), writeRestrictions: restrictions }), { code: "TASK_SCOPED_HARDLINK_UNSAFE" });
  await unchanged(cwd, files);
});

test("N-1 real scoped shell protects symlink aliases and canonical explicit paths", async (t) => {
  const { cwd, backend, files } = await fixture(t);
  if (!available(t, backend)) return;
  await symlink(join(cwd, "tests"), join(cwd, "alias"));
  const attempt = await backend.run({ command: node("require('node:fs').writeFileSync('alias/unit.js','ESCAPED')"), writeRestrictions: restrictions });
  assert.equal(attempt.ok, false);
  await symlink(join(cwd, "docs"), join(cwd, "docs-link"));
  const explicit = await backend.run({ command: node("require('node:fs').writeFileSync('docs/locked.md','ESCAPED')"), writeRestrictions: [{ kind: "path", path: "docs-link/locked.md" }] });
  assert.equal(explicit.ok, false);
  await unchanged(cwd, files);
});

test("N-1 explicit scoped paths with regex punctuation are safely protected and the same profile allows src edits", async (t) => {
  const { cwd, backend } = await fixture(t);
  if (!available(t, backend)) return;
  const path = 'docs/locked[odd] (v1)."q".md';
  await writeFile(join(cwd, path), "PROTECTED");
  const writeRestrictions = [{ kind: "path", path }];
  const safe = await backend.run({ command: node("require('node:fs').writeFileSync('src/main.js','SAFE')"), writeRestrictions });
  assert.equal(safe.ok, true, safe.stderr || safe.error);
  const blocked = await backend.run({ command: node(`require('node:fs').writeFileSync(${JSON.stringify(path)},'ESCAPED')`), writeRestrictions });
  assert.equal(blocked.ok, false, blocked.stderr);
  assert.equal(await readFile(join(cwd, path), "utf8"), "PROTECTED");
});
