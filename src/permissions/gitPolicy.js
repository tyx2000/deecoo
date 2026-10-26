import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { sanitizeShellEnv } from "./shellPolicy.js";

const execFileAsync = promisify(execFile);
const BASE_ARGS = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", `core.hooksPath=${devNull}`];

// Git's read commands can execute repository-configured helpers. Disable the known helper
// entry points for these calls; this does not provide OS isolation from an untrusted repository.
export async function execReadOnlyGit(cwd, args, options = {}) {
  const execution = { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024, ...options,
    env: { ...sanitizeShellEnv(process.env), GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" } };
  let filterKeys = [];
  try {
    const { stdout } = await execFileAsync("git", [...BASE_ARGS, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], execution);
    filterKeys = stdout.split("\0").filter(Boolean);
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  const overrides = filterKeys.flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
  const command = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...args.slice(1)]
    : args[0] === "status" ? ["status", "--ignore-submodules=all", ...args.slice(1)] : args;
  return execFileAsync("git", [...BASE_ARGS, ...overrides, ...command], execution);
}

// Repository settings that make read-only git commands run a program: clean/smudge filters
// (status, diff), textconv and external diff drivers (diff, log -p, show), signature programs
// (log --show-signature), and includes, which can pull in any of these. Jobs already disable
// fsmonitor and pagers through their environment.
const READ_ONLY_PROGRAM_KEYS = /^(?:filter\..+\.(?:clean|smudge|process)|diff\.external|diff\..+\.(?:textconv|command)|gpg\.(?:.+\.)?program|include\.path|includeif\..+\.path)$/i;
const MAX_CONFIG_BYTES = 1024 * 1024;

export async function repositoryProgramConfigKeys(startDirectory) {
  const repository = await findGitDirectory(resolve(startDirectory));
  if (!repository) return [];
  const keys = [];
  for (const path of [join(repository.commonDir, "config"), join(repository.gitDir, "config.worktree")]) {
    const text = await readSmallFile(path);
    if (text !== undefined) keys.push(...configKeys(text).filter((key) => READ_ONLY_PROGRAM_KEYS.test(key)));
  }
  return [...new Set(keys)];
}

async function findGitDirectory(directory) {
  for (let current = directory; ; current = dirname(current)) {
    const marker = join(current, ".git");
    const info = await lstat(marker).catch(() => undefined);
    if (info?.isDirectory()) return { gitDir: marker, commonDir: await commonDirectory(marker) };
    if (info?.isFile()) {
      const pointer = (await readSmallFile(marker))?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      if (pointer) { const gitDir = resolve(current, pointer); return { gitDir, commonDir: await commonDirectory(gitDir) }; }
    }
    if (dirname(current) === current) return undefined;
  }
}

async function commonDirectory(gitDir) {
  const pointer = (await readSmallFile(join(gitDir, "commondir")))?.trim();
  return pointer ? resolve(gitDir, pointer) : gitDir;
}

async function readSmallFile(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_CONFIG_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return undefined; }
  finally { await handle?.close(); }
}

// Git config is INI-like: `[section "sub"]` or `[section.sub]` headers, then `key = value`.
function configKeys(text) {
  const keys = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/^\s+/, "");
    const header = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/);
    if (header) {
      section = (header[2] !== undefined ? `${header[1]}.${header[2]}` : header[1]).toLowerCase();
      line = line.slice(header[0].length).replace(/^\s+/, "");
    }
    const key = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|$|[;#])/)?.[1];
    if (key && section) keys.push(`${section}.${key.toLowerCase()}`);
  }
  return keys;
}
