import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { parseArgs } from "../src/cli/args.js";

const exec = promisify(execFile);
const cli = new URL("../bin/deecoo.js", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const envFor = (root, extra = {}) => ({ PATH: process.env.PATH, DEECOO_HOME: join(root, "home"), ...extra });
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "deecoo-version-"));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function installVersionFixture(root) {
  await mkdir(join(root, "src"), { recursive: true });
  await copyFile(new URL("../src/version.js", import.meta.url), join(root, "src", "version.js"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "deecoo-fixture", version: "9.8.7", type: "module" }));
  await writeFile(join(root, "inspect.mjs"), 'import { getVersionInfo } from "./src/version.js"; console.log(JSON.stringify(await getVersionInfo()));\n');
}
async function commitFixture(root) {
  await exec("git", ["-C", root, "init", "-q"]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "-c", "user.name=Deecoo Test", "-c", "user.email=deecoo@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
}
const inspect = async (root, cwd, env) => JSON.parse((await exec(process.execPath, [join(root, "inspect.mjs")], { cwd, env, timeout: 8000 })).stdout);

test("version flags have aliases and respect the literal task delimiter", () => {
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["-v"]).version, true);
  const literal = parseArgs(["--", "--version"]);
  assert.equal(literal.version, false);
  assert.equal(literal.task, "--version");
});

test("actual version CLI is offline, ignores settings/workspace setup, and supports machine output", async () => fixture(async (root) => {
  const settings = join(root, "invalid-settings.json");
  await writeFile(settings, "not valid JSON");
  await writeFile(join(root, ".env"), "DEECOO_PROVIDER=not-a-provider\n");
  const preloader = join(root, "no-network.mjs");
  await writeFile(preloader, 'globalThis.fetch = () => { throw new Error("Version must not access the network"); };\n');
  for (const flags of [["--version"], ["-v"], ["--json", "--version"], ["--jsonl", "--version"], ["--non-interactive", "--version"]]) {
    const result = await exec(process.execPath, ["--import", preloader, cli, "--settings", settings, "--cwd", join(root, "does-not-exist"), ...flags],
      { cwd: root, env: envFor(root), timeout: 8000 });
    assert.equal(result.stderr, "");
    if (flags.length === 1) assert.ok(result.stdout.startsWith(manifest.name + " " + manifest.version));
    else {
      const lines = result.stdout.trim().split("\n");
      assert.equal(lines.length, 1);
      const info = JSON.parse(lines[0]);
      assert.equal(info.schemaVersion, 1); assert.equal(info.type, "version");
      assert.equal(info.name, manifest.name); assert.equal(info.version, manifest.version);
    }
  }
  await assert.rejects(stat(join(root, "home")), { code: "ENOENT" });
  await assert.rejects(stat(join(root, ".deecoo")), { code: "ENOENT" });
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.version, manifest.version); assert.equal(lock.packages[""].version, manifest.version);
}));

test("a packaged install inside another Git repository does not inherit the parent revision", async () => fixture(async (root) => {
  await writeFile(join(root, "parent.txt"), "Unrelated workspace\n");
  await commitFixture(root);
  const installed = join(root, "node_modules", "deecoo");
  await installVersionFixture(installed);
  const info = await inspect(installed, root, envFor(root, { GIT_DIR: join(root, ".git"), GIT_WORK_TREE: root }));
  assert.deepEqual(info, { name: "deecoo-fixture", version: "9.8.7", releasedAt: null, revision: null, dirty: null });
}));

test("source identity belongs to the installation, detects edits, and tolerates missing Git", async () => fixture(async (root) => {
  const installed = join(root, "installation");
  const workspace = join(root, "workspace");
  await installVersionFixture(installed);
  await commitFixture(installed);
  await mkdir(workspace);
  await writeFile(join(workspace, "other.txt"), "Other checkout\n");
  await commitFixture(workspace);
  const expected = (await exec("git", ["-C", installed, "rev-parse", "--short=12", "HEAD"])).stdout.trim();
  const env = envFor(root, { GIT_DIR: join(workspace, ".git"), GIT_COMMON_DIR: join(workspace, ".git"), GIT_WORK_TREE: workspace });
  const info = await inspect(installed, workspace, env);
  assert.equal(info.version, "9.8.7"); assert.equal(info.revision, expected); assert.equal(info.dirty, false);
  await writeFile(join(installed, "untracked-change.txt"), "Local changes\n");
  assert.equal((await inspect(installed, workspace, env)).dirty, true);
  const withoutGit = await inspect(installed, workspace, envFor(root, { PATH: join(root, "no-git") }));
  assert.deepEqual(withoutGit, { name: "deecoo-fixture", version: "9.8.7", releasedAt: null, revision: null, dirty: null });
}));

test("version output follows the version with its release time to the second, also for packaged installs", async () => fixture(async (root) => {
  const installed = join(root, "node_modules", "deecoo");
  await installVersionFixture(installed);
  const manifestPath = join(installed, "package.json");
  await writeFile(manifestPath, JSON.stringify({ name: "deecoo-fixture", version: "9.8.7", type: "module", releasedAt: "2026-10-26T10:58:29+08:00" }));
  await writeFile(join(installed, "format.mjs"), 'import { formatVersion, getVersionInfo } from "./src/version.js"; console.log(formatVersion(await getVersionInfo()));\n');
  const run = async (file, timezone) => (await exec(process.execPath, [join(installed, file)], { cwd: root, env: envFor(root, { TZ: timezone }), timeout: 8000 })).stdout.trim();
  assert.equal(JSON.parse(await run("inspect.mjs", "Asia/Shanghai")).releasedAt, "2026-10-26T10:58:29+08:00");
  assert.equal(await run("format.mjs", "Asia/Shanghai"), "9.8.7 2026-10-26 10:58:29");
  assert.equal(await run("format.mjs", "UTC"), "9.8.7 2026-10-26 02:58:29", "shown in the viewer's local time");
  await writeFile(manifestPath, JSON.stringify({ name: "deecoo-fixture", version: "9.8.7", type: "module", releasedAt: "yesterday" }));
  assert.equal(await run("format.mjs", "UTC"), "9.8.7");
  // The shipped manifest always carries a release time for its version.
  assert.match(manifest.releasedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(manifest.scripts.version, "node ./scripts/stamp-release.mjs");
}));

test("the release stamp script records the current time with its offset and keeps the version", async () => fixture(async (root) => {
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(new URL("../scripts/stamp-release.mjs", import.meta.url), join(root, "scripts", "stamp-release.mjs"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "deecoo-fixture", version: "1.0.0", type: "module", scripts: { version: "node ./scripts/stamp-release.mjs" } }, null, 2));
  const before = Date.now() - 1000;
  await exec(process.execPath, [join(root, "scripts", "stamp-release.mjs")], { cwd: root, env: envFor(root), timeout: 8000 });
  const stamped = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(stamped.version, "1.0.0");
  assert.match(stamped.releasedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.ok(Date.parse(stamped.releasedAt) >= before && Date.parse(stamped.releasedAt) <= Date.now() + 1000);
}));

