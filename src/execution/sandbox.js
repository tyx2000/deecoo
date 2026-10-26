import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { sanitizeShellEnv } from "../permissions/shellPolicy.js";

const SYSTEM_ROOTS = process.platform === "darwin"
  ? ["/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/Library/Developer", "/Library/Frameworks", "/opt/homebrew", "/private/etc", "/dev", "/private/var/db/dyld"]
  : ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev"];
// macOS `/usr/bin/git` and friends are xcrun shims: they load libxcrun from the selected
// developer directory, check the Xcode license preference, and keep a lookup cache in the
// per-user temp directory. Without these reads the shim fails before the real tool starts.
const XCODE_SELECT_LINK = "/var/db/xcode_select_link";
const XCODE_LICENSE_PREFERENCE = "/Library/Preferences/com.apple.dt.Xcode.plist";
const XCRUN_CACHE_RULE = '(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db"))';
// A job may change the workspace but not the repository's own configuration. Git reads
// .git/config and runs .git/hooks later, outside any sandbox, whenever the user runs git there,
// so a write to these paths would turn one sandboxed command into code that runs unsandboxed.
// The .git entry itself is protected too, so it cannot be renamed away, edited, and moved back.
const GIT_PROTECTED_ENTRIES = ["config", "config.lock", "config.worktree", "hooks", "info", "modules"];
// Every job gets these in place of repository settings: an fsmonitor or pager configured by
// the repository must not run just because a command invoked git.
const GIT_HARDENING_ENV = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false", GIT_PAGER: "cat" };
const INJECT_ENV =/^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|POSIXLY_CORRECT|CDPATH|GLOBIGNORE|NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT|NODE_V8_COVERAGE|NODE_COMPILE_CACHE|NODE_REPL_.*|PYTHONPATH|PYTHONHOME|PERL5OPT|RUBYOPT|LD_.*|DYLD_.*|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GPG_AGENT_INFO)$/;
const CREDENTIAL_ENV = /(^|_)(ACCESS[_-]?KEY|CREDENTIALS|COOKIE|SESSION)($|_)/i;

export function executionEnv(source, tempDir) {
  const clean = sanitizeShellEnv(source);
  for (const key of Object.keys(clean)) {
    if (INJECT_ENV.test(key) || /^npm_config_(ignore_scripts|dry_run|if_present)$/i.test(key) || CREDENTIAL_ENV.test(key) || /^(AWS_|AZURE_|GOOGLE_|GCP_|GITHUB_|GH_)/.test(key) || clean[key] === undefined || clean[key] === null) delete clean[key];
    else clean[key] = String(clean[key]);
  }
  clean.PATH ||= "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  // Runtime caches and shell startup files belong to the job, not the real home.
  return { ...clean, ...GIT_HARDENING_ENV, HOME: tempDir, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir, XDG_CACHE_HOME: tempDir, XDG_CONFIG_HOME: tempDir };
}

export function normalizeSandboxPolicy(policy = {}, cwd, stateDir, tempDir) {
  if (typeof policy === "string") policy = { mode: policy };
  const mode = policy.mode ?? "auto";
  if (!["off", "auto", "required"].includes(mode)) throw new Error("sandbox mode must be off, auto, or required");
  const network = policy.network ?? "deny";
  if (!["deny", "allow"].includes(network)) throw new Error("sandbox network must be deny or allow (host allowlists require a proxy)");
  const canonical = (value) => { const path = resolve(value); try { return realpathSync(path); } catch { return path; } };
  const roots = (values) => [...new Set(values.map(canonical))];
  const home = homedir();
  const executableDirectory = dirname(process.execPath);
  const installation = dirname(executableDirectory);
  const runtimeRoot = basename(executableDirectory) === "bin" && /^(v?\d+\.\d+|node|runtime)/.test(basename(installation)) ? installation : executableDirectory;
  const credentialRoots = [...[".ssh", ".aws", ".gnupg", ".config/gcloud", ".azure", ".kube", ".deecoo", ".npmrc", ".netrc", ".pypirc", ".git-credentials", ".docker/config.json", ".cargo/credentials.toml", "Library/Keychains"].map((item) => resolve(home, item)), "/Library/Keychains", "/etc/shadow", "/etc/master.passwd", "/etc/ssh", "/etc/ssl/private", "/etc/pki/private"];
  const gitDirectories = roots(policy.writeRoots ?? [cwd]).map((root) => join(root, ".git"));
  return {
    mode, network,
    readRoots: roots([...SYSTEM_ROOTS.filter(existsSync), ...developerToolRoots(), runtimeRoot, cwd, tempDir, ...(policy.readRoots ?? []), ...(policy.writeRoots ?? [])]),
    writeRoots: roots(policy.writeRoots ?? [cwd]).concat(canonical(tempDir)),
    denyReadRoots: roots([stateDir, ...credentialRoots, ...(policy.denyReadRoots ?? [])]),
    denyWriteRoots: roots([stateDir, ...credentialRoots, ...gitDirectories.flatMap((gitDir) => GIT_PROTECTED_ENTRIES.map((entry) => join(gitDir, entry))), ...(policy.denyWriteRoots ?? [])]),
    denyWriteLiterals: gitDirectories,
    resources: validateResources(policy.resources ?? {}),
  };
}

export function developerToolRoots() {
  if (process.platform !== "darwin") return [];
  let developer;
  try { developer = realpathSync(XCODE_SELECT_LINK); } catch { return []; }
  // A full Xcode keeps the shim's libraries beside Developer (SharedFrameworks, Frameworks);
  // Command Line Tools under /Library/Developer is already a system root.
  const bundle = developer.match(/^(.+\.app\/Contents)\/Developer$/)?.[1];
  return [bundle ?? developer, XCODE_LICENSE_PREFERENCE].filter(existsSync);
}

function validateResources(resources) {
  const allowed = ["cpuSeconds", "fileSizeBytes", "openFiles", "maxProcesses"];
  for (const [key, value] of Object.entries(resources)) {
    if (!allowed.includes(key) || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid resource limit: ${key}`);
  }
  if (resources.maxProcesses && process.platform !== "linux") throw new Error("maxProcesses is only supported on Linux (per-user RLIMIT_NPROC)");
  return { ...resources };
}

const quote = (text) => JSON.stringify(String(text));
// #"..." is a regex literal, not a Scheme string: doubling its backslashes
// changes e.g. \. into a match for a backslash followed by any character.
const regexQuote = (pattern) => "#" + quote(pattern).replaceAll("\\\\", "\\");
export function seatbeltProfile(policy) {
  const rules = [
    "(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)",
    "(allow signal (target same-sandbox))", "(allow process-info* (target same-sandbox))",
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "kern.os") (sysctl-name "kern.version") (sysctl-name "machdep.cpu.brand_string") (sysctl-name "kern.argmax") (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.maxproc") (sysctl-name "kern.usrstack64") (sysctl-name "kern.secure_kernel") (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg"))',
    '(allow mach-lookup (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership"))',
    "(allow file-read-metadata)", '(allow file-read* (literal "/"))', '(allow file-write* (literal "/dev/null"))',
    XCRUN_CACHE_RULE,
  ];
  for (const path of policy.readRoots) rules.push(`(allow file-read* (subpath ${quote(path)}))`);
  for (const path of policy.writeRoots) rules.push(`(allow file-write* (subpath ${quote(path)}))`);
  for (const path of policy.denyReadRoots) rules.push(`(deny file-read* (subpath ${quote(path)}))`);
  for (const path of policy.denyWriteRoots) rules.push(`(deny file-write* (subpath ${quote(path)}))`);
  for (const path of policy.denyWriteLiterals ?? []) rules.push(`(deny file-write* (literal ${quote(path)}))`);
  for (const pattern of policy.denyWriteRegexes ?? []) rules.push(`(deny file-write* (regex ${regexQuote(pattern)}))`);
  for (const path of policy.denyUnlinkPaths ?? []) rules.push(`(deny file-write-unlink (literal ${quote(path)}))`);
  if (policy.denyHardLinks) rules.push("(deny file-link)");
  if (policy.network === "allow") rules.push("(allow network*)");
  return rules.join("\n");
}

export function detectSandbox() {
  if (process.platform === "darwin") {
    const executable = "/usr/bin/sandbox-exec";
    if (!existsSync(executable)) return { available: false, kind: "seatbelt", reason: "sandbox-exec is absent" };
    const result = spawnSync(executable, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 2000 });
    return { available: result.status === 0, kind: "seatbelt", executable, reason: result.status === 0 ? null : String(result.stderr || result.error?.message || `probe exited ${result.status}`).trim() };
  }
  if (process.platform === "linux") {
    const executable = ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync);
    if (!executable) return { available: false, kind: "bubblewrap", reason: "bubblewrap is absent" };
    const result = spawnSync(executable, ["--unshare-all", "--ro-bind", "/", "/", "--", "/usr/bin/true"], { encoding: "utf8", timeout: 2000 });
    return { available: result.status === 0, kind: "bubblewrap", executable, reason: result.status === 0 ? null : String(result.stderr || result.error?.message || `probe exited ${result.status}`).trim() };
  }
  return { available: false, kind: null, reason: `No OS sandbox backend for ${process.platform}` };
}

export function executionCommand({ command, cwd, policy, sandbox, shell = "/bin/bash" }) {
  if (policy.scopedWriteRestrictions?.length && (policy.mode === "off" || !sandbox.available || sandbox.kind !== "seatbelt")) throw Object.assign(new Error("This OS backend cannot enforce scoped task write restrictions."), { code: "TASK_SCOPED_SHELL_UNAVAILABLE" });
  if (policy.mode === "required" && !sandbox.available) {
    const error = new Error(`Required OS sandbox unavailable: ${sandbox.reason}`); error.code = "SANDBOX_UNAVAILABLE"; throw error;
  }
  const limits = [];
  const add = (flag, value) => { if (value !== undefined) limits.push(`ulimit -S -${flag} ${value} && ulimit -H -${flag} ${value}`); };
  add("t", policy.resources.cpuSeconds);
  // Bash uses 1024-byte units outside POSIX mode; round down to avoid exceeding
  // the requested cap. Smaller positive byte caps become a zero-file limit.
  add("f", policy.resources.fileSizeBytes === undefined ? undefined : Math.floor(policy.resources.fileSizeBytes / 1024));
  add("n", policy.resources.openFiles);
  add("u", policy.resources.maxProcesses);
  const shellArgs = ["--noprofile", "--norc", "-c", `${limits.length ? `${limits.join(" && ")} && ` : ""}exec /bin/bash --noprofile --norc -c "$1"`, "deecoo-exec", command];
  if (policy.mode === "off" || !sandbox.available) return { executable: shell, args: shellArgs, sandbox: { ...sandbox, enforced: false } };
  if (sandbox.kind === "seatbelt") return { executable: sandbox.executable, args: ["-p", seatbeltProfile(policy), shell, ...shellArgs], sandbox: { ...sandbox, enforced: true, ...(policy.scopedWriteRestrictions?.length ? { writeRestrictions: policy.scopedWriteRestrictions, scopeEvidence: policy.scopeEvidence } : {}) } };
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];
  if (policy.network === "allow") args.push("--share-net");
  // Start from an empty mount namespace; explicit roots are the only host reads.
  for (const path of policy.readRoots) args.push("--ro-bind", path, path);
  // Merged-/usr distributions expose these paths as aliases. Canonical policy
  // roots bind the targets; recreate the aliases without exposing more files.
  for (const path of ["/bin", "/sbin", "/lib", "/lib64"]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) args.push("--symlink", readlinkSync(path), path);
  }
  for (const path of policy.writeRoots) args.push("--bind", path, path);
  for (const path of policy.denyReadRoots) {
    if (!existsSync(path)) continue;
    // A credential path can be a directory or a file (.npmrc/.netrc).
    const directory = statSync(path).isDirectory();
    if (directory) args.push("--tmpfs", path, "--remount-ro", path);
    else args.push("--ro-bind", "/dev/null", path);
  }
  for (const path of policy.denyWriteRoots) if (existsSync(path) && !policy.denyReadRoots.includes(path)) args.push("--ro-bind", path, path);
  args.push("--proc", "/proc", "--dev", "/dev", "--remount-ro", "/", "--chdir", cwd, "--", shell, ...shellArgs);
  return { executable: sandbox.executable, args, sandbox: { ...sandbox, enforced: true } };
}
