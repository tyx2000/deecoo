import { egressViolations } from "./egress.js";
import { isSensitivePath } from "./sensitivePaths.js";

const BLOCK_PATTERNS = [
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "destructive git reset" },
  { pattern: /\bgit\s+clean\s+-[^\s]*[fd][^\s]*/i, reason: "destructive git clean" },
  { pattern: /\b(sudo|su)\b/i, reason: "privilege escalation" },
  { pattern: /\b(dd|mkfs|diskutil)\b/i, reason: "disk/device mutation" },
  { pattern: /\bchmod\s+-R\s+777\b/i, reason: "broad unsafe permission change" },
  { pattern: /(curl|wget)[^|;&]*\|\s*(sh|bash|zsh)\b/i, reason: "downloaded script execution" },
  { pattern: /\b(read\s+-p|tail\s+-f|watch)\b/i, reason: "interactive or long-running command" },
];

// Sensitive paths a workspace command should never need to touch. Reading them is the classic
// credential-exfiltration step. These checks are defense in depth, not OS isolation.
const SENSITIVE_PATH_PATTERNS = [
  { pattern: /\/etc\/(shadow|sudoers)\b/i, reason: "system credential file access" },
  // The agent's own credential store and environment are prime exfiltration targets — the env
  // is scrubbed for child processes, but the on-disk settings file and /proc must be blocked too.
  { pattern: /\.deecoo\/settings\.json/i, reason: "agent credential store access" },
  { pattern: /\/proc\/\S*\/environ\b/i, reason: "process environment access" },
  { pattern: /\b(printenv|echo)\b[^|;&]*\$?\b\w*(API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DEEPSEEK|ANTHROPIC)\w*/i, reason: "secret environment variable read" },
  { pattern: /(^|[\s|;&])(printenv|env)\s*($|[|;&#])/i, reason: "full environment dump" },
];

// Network commands shaped like data exfiltration: uploading local files/data or opening raw
// sockets. Plain fetches stay at warn; sending data out is a hard block.
const EGRESS_PATTERNS = [
  { pattern: /\b(curl|wget)\b[^|;&]*(--data\b|--data-binary\b|--data-urlencode\b|\s-d\s|--post-file\b|--upload-file\b|\s-T\s|\s-F\s|--form\b)/i, reason: "network upload / data exfiltration" },
  { pattern: /\b(nc|ncat|netcat)\b/i, reason: "raw socket / netcat channel" },
];

const WARN_PATTERNS = [
  { pattern: /\b(npm|pnpm|yarn)\s+(install|i|add|ci)\b/i, reason: "dependency installation may run scripts or change lockfiles" },
  { pattern: /\b(git\s+commit|git\s+merge|git\s+rebase|git\s+push)\b/i, reason: "git history or remote mutation" },
  { pattern: /\b(rm|mv|cp|chmod|chown|tee)\b/i, reason: "filesystem mutation" },
  { pattern: /\b(curl|wget)\b/i, reason: "network access" },
  { pattern: />{1,2}(?!&)(?!\s*\/dev\/null\b)/, reason: "output redirection may write outside the workspace" },
];

// A repository controls its package scripts, build files, test-runner configs, and executables,
// so running any of them is running the repository author's code. These need explicit approval.
const PROJECT_CODE_REASON = "runs workspace-defined or package code";
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_READ_ONLY = new Set(["--version", "-v", "--help", "-h", "help", "ls", "list", "ll", "la", "view", "info", "show", "outdated", "why", "explain", "search", "ping", "root", "prefix", "bin", "whoami"]);
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx", "pipx"]);
const BUILD_TOOLS = new Set(["make", "gmake", "ninja", "cmake", "meson", "bazel", "buck", "gradle", "gradlew", "mvn", "mvnw", "ant", "sbt", "rake", "just", "task", "tox", "nox", "invoke"]);
const PROJECT_TOOLS = new Set(["jest", "vitest", "mocha", "ava", "tap", "playwright", "cypress", "karma", "pytest", "py.test", "rspec", "phpunit", "eslint", "tsx", "ts-node", "babel-node", "webpack", "vite", "rollup", "next", "nuxt", "astro", "nodemon"]);
const TOOLCHAIN_SUBCOMMANDS = {
  cargo: ["run", "test", "build", "bench", "check", "clippy", "install"],
  go: ["run", "test", "generate", "build", "install"],
  dotnet: ["run", "test", "build", "publish"],
  swift: ["run", "test", "build"],
  deno: ["run", "test", "task", "eval", "serve", "bench"],
  pip: ["install"], pip3: ["install"],
  uv: ["run", "sync", "pip", "tool"],
  poetry: ["run", "install", "build"],
  pipenv: ["run", "install", "sync"],
  bundle: ["exec", "install"],
  composer: ["run", "run-script", "install", "update", "exec", "test"],
  mix: ["test", "run", "compile"],
  gem: ["install", "build"],
  flutter: ["test", "run", "build"],
  dart: ["run", "test"],
};
const SCRIPT_INTERPRETERS = new Set(["node", "nodejs", "python", "python3", "ruby", "perl", "php", "rscript", "lua", "luajit", "groovy", "java", "osascript", "pwsh", "powershell"]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh"]);
const INFO_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h"]);
const SYSTEM_EXECUTABLE_PREFIXES = ["/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/", "/usr/local/bin/", "/opt/homebrew/bin/", "/usr/libexec/"];
// Commands that only run another command; classification looks through them.
const COMMAND_WRAPPERS = new Set(["env", "time", "nohup", "nice", "timeout", "command", "exec", "builtin", "xargs", "stdbuf", "caffeinate", "busybox"]);
const WRAPPER_VALUE_FLAGS = { nice: ["-n"], timeout: ["-s", "-k", "--signal", "--kill-after"], xargs: ["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a"], stdbuf: ["-i", "-o", "-e"] };
const MAX_NESTED_DEPTH = 4;

// Git subcommands that only read the repository and run no hooks. Every other subcommand may
// rewrite the worktree or history, contact a remote, or run a repository-configured program
// (aliases, `submodule foreach`, difftool/mergetool commands, checkout filters and hooks).
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "blame", "annotate", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe", "shortlog", "cat-file",
  "grep", "merge-base", "name-rev", "count-objects", "var", "check-ignore", "check-attr", "whatchanged", "show-ref", "for-each-ref", "version", "help"]);
const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--list-cmds"]);
// Global options that point git at another repository, config source, or helper directory: the
// repository whose configuration applies can no longer be checked before the command runs.
const GIT_UNCHECKABLE_OPTIONS = new Set(["--git-dir", "--work-tree", "--exec-path", "--config-env", "--super-prefix"]);
// Configuration that names a program for git to run. Supplied with `-c`, it needs approval.
const GIT_PROGRAM_CONFIG = /^(?:core\.(?:fsmonitor|hookspath|pager|editor|sshcommand|askpass|gitproxy|alternaterefscommand)|alias\..+|pager\..+|filter\..+\.(?:clean|smudge|process)|diff\.external|diff\..+\.(?:textconv|command)|merge\..+\.driver|gpg\.(?:.+\.)?program|credential\.(?:.+\.)?helper|sequence\.editor|uploadpack\.packobjectshook|include\.path|includeif\..+\.path|submodule\..+\.update|interactive\.difffilter|remote\..+\.(?:uploadpack|receivepack))$/i;
const GIT_PROGRAM_ENV = /(?:^|[\s;&|])(?:export\s+)?(?:GIT_[A-Z_]+|PAGER|EDITOR|VISUAL)=/;
const GIT_REASON = "git command may change the repository or run a repository-configured program";

// Programs whose ordinary options launch another program; the launched program is not visible to
// the rest of this classifier.
const PROGRAM_LAUNCHERS = new Set(["parallel", "script", "strace", "ltrace", "valgrind", "gdb", "lldb", "expect", "entr", "watchexec", "flock", "chroot", "unshare", "setsid",
  "runuser", "sg", "nsenter", "firejail", "systemd-run", "at", "batch", "crontab", "launchctl", "open", "xdg-open"]);
const LAUNCH_SUBCOMMANDS = { docker: ["run", "exec", "build", "compose", "buildx", "create", "start"], podman: ["run", "exec", "build", "compose", "create", "start"], nerdctl: ["run", "exec", "build", "compose"] };
const LAUNCH_OPTIONS = {
  tar: /^(?:--to-command|--checkpoint-action|--use-compress-program|--rsh-command|--info-script|--new-volume-script|-I|-F)(?:=|$)/,
  gtar: /^(?:--to-command|--checkpoint-action|--use-compress-program|--rsh-command|--info-script|--new-volume-script|-I|-F)(?:=|$)/,
  bsdtar: /^(?:--use-compress-program|-I)(?:=|$)/,
  zip: /^(?:-TT|--unzip-command)(?:=|$)/,
  man: /^(?:-P|--pager|-H|--html)(?:=|$)/,
  rsync: /^(?:-e|--rsh|--rsync-path)(?:=|$)/,
  scp: /^-S$/,
};
const LAUNCH_REASON = "can execute another program";

export function classifyShellCommand(command, { egressAllowlist } = {}) {
  return classifyShellText(normalizeShellCommand(command), { egressAllowlist }, 0);
}

function classifyShellText(text, { egressAllowlist }, depth) {
  // Shell payloads (`bash -c`, `eval`), command substitutions, and variable indirection hide
  // the command that actually runs. Classify each recovered payload and keep the strictest level.
  const payloads = nestedShellCommands(text);
  const nested = depth < MAX_NESTED_DEPTH ? payloads.map((payload) => classifyShellText(payload, { egressAllowlist }, depth + 1)) : [];
  const nestedReasons = (level) => nested.filter((result) => result.level === level).flatMap((result) => result.reasons);
  const disallowedHosts = egressViolations(text, egressAllowlist);
  const blocked = [
    ...detectBlockedShellTokens(text),
    ...detectInteractiveShellCommands(text),
    ...(shellTokens(text).some((token) => token.split(/[=:]/).some((path) => isSensitivePath(path.replace(/^[@<>]+/, "")))) ? ["sensitive path access"] : []),
    ...BLOCK_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason),
    ...SENSITIVE_PATH_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason),
    ...EGRESS_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason),
    ...(disallowedHosts.length ? ["network egress to non-allowlisted host: " + disallowedHosts.join(", ")] : []),
    ...nestedReasons("block"),
  ];
  if (blocked.length) {
    return {
      level: "block",
      reasons: [...new Set(blocked)],
      promptLabel: "Blocked shell command",
    };
  }
  const warned = [
    ...detectDynamicShellCode(text),
    ...(depth >= MAX_NESTED_DEPTH && payloads.length ? ["shell nesting too deep to classify"] : []),
    ...detectInlineCodeExecution(text),
    ...detectProjectCodeExecution(text),
    ...detectProgramLaunch(text),
    ...detectGitRisk(text),
    ...detectBackgroundExecution(text),
    ...WARN_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason),
    ...nestedReasons("warn"),
  ];
  if (warned.length) {
    return {
      level: "warn",
      reasons: [...new Set(warned)],
      promptLabel: "Risky shell command",
    };
  }
  return {
    level: "allow",
    reasons: [],
    promptLabel: "Shell command",
  };
}

export function normalizeShellCommand(command) {
  return String(command ?? "").trim();
}

const SECRET_ENV_PATTERN = /(^|_)(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH)($|_)/i;

// Remove secret-looking variables from the environment handed to a child shell process so an
// injected or careless command cannot read the agent's own credentials out of `env`.
export function sanitizeShellEnv(env = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_PATTERN.test(key)) continue;
    if (key.startsWith("DEEPSEEK_") || key.startsWith("OPENAI_") || key.startsWith("ANTHROPIC_")) continue;
    clean[key] = value;
  }
  return clean;
}

function detectBlockedShellTokens(command) {
  const reasons = [];
  for (const segment of shellCommandSegments(command)) {
    if (isRecursiveForceRm(segment)) {
      reasons.push("recursive delete command");
    }
    // Global options (`git -c x=y reset --hard`) must not hide the subcommand from the block list.
    const git = parseGitInvocation(effectiveCommand(segment));
    if (git?.subcommand === "reset" && git.args.includes("--hard")) reasons.push("destructive git reset");
    if (git?.subcommand === "clean" && git.args.some((token) => /^-[^-]*[fd]/.test(token) || token === "--force")) reasons.push("destructive git clean");
  }
  return reasons;
}

function shellCommandSegments(command) {
  const tokens = shellTokens(command);
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (isShellBoundary(token)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) segments.push(current);
  return segments;
}

function nestedShellCommands(command) {
  const payloads = [];
  for (const segment of shellCommandSegments(command)) {
    payloads.push(...unwrapCommand(segment).payloads);
    const [executable, ...args] = effectiveCommand(segment);
    const name = basenameCommand(executable);
    if (SHELL_INTERPRETERS.has(name)) {
      const payload = shellCommandPayload(args);
      if (payload !== undefined) payloads.push(payload);
    }
    if (name === "eval" && args.length) payloads.push(args.join(" "));
    if (name === "find") payloads.push(...findExecPayloads(args));
  }
  payloads.push(...commandSubstitutions(command));
  const expanded = expandAssignedVariables(command);
  if (expanded !== command) payloads.push(expanded);
  return payloads.filter((payload) => payload.trim());
}

// The script operand of `bash -c SCRIPT`, including combined flags such as `-lc` or `-ec`.
function shellCommandPayload(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(token)) { index += 1; continue; }
    if (!/^[-+]/.test(token) || token === "-" || token === "--") return undefined;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) return args[index + 1] ?? "";
  }
  return undefined;
}

// `$(...)`, backticks, and process substitution run before the outer command. Single quotes
// keep them literal; double quotes do not.
function commandSubstitutions(command) {
  const payloads = [];
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (char === "\\") { index += 1; continue; }
    if (char === "'" && !quote) { quote = "'"; continue; }
    if (char === "\"") { quote = quote ? "" : "\""; continue; }
    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      payloads.push(command.slice(index + 1, end < 0 ? command.length : end));
      index = end < 0 ? command.length : end;
      continue;
    }
    if (!["$", "<", ">"].includes(char) || command[index + 1] !== "(") continue;
    if (char === "$" && command[index + 2] === "(") { index += 2; continue; }
    let depth = 1;
    let end = index + 2;
    for (; end < command.length && depth; end += 1) {
      if (command[end] === "(") depth += 1;
      else if (command[end] === ")") depth -= 1;
    }
    payloads.push(command.slice(index + 2, depth ? end : end - 1));
    index = end - 1;
  }
  return payloads;
}

// Substitute variables assigned in the same command (`D=.ss; cat ~/${D}h/key`) so path checks
// see what the shell will actually open.
function expandAssignedVariables(command) {
  const values = new Map();
  for (const segment of shellCommandSegments(command)) {
    const tokens = ["export", "declare", "local", "readonly", "typeset"].includes(segment[0]) ? segment.slice(1) : segment;
    for (const token of tokens) {
      const match = token.match(/^([A-Za-z_]\w*)=(.*)$/s);
      if (!match) break;
      values.set(match[1], match[2]);
    }
  }
  if (!values.size) return command;
  return command.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (whole, braced, bare) => values.get(braced ?? bare) ?? whole);
}

function detectDynamicShellCode(command) {
  const reasons = [];
  if (shellCommandSegments(command).some((segment) => unwrapCommand(segment).uncertain)) reasons.push("unsupported command wrapper syntax");
  if (commandSubstitutions(command).length) reasons.push("dynamic command substitution");
  const expanded = expandAssignedVariables(command);
  if (shellTokens(expanded).some((token) => token.includes("/") && /\$(\{|[A-Za-z_])/.test(token))) reasons.push("unresolved variable in a path");
  return reasons;
}

function detectProjectCodeExecution(command) {
  return shellCommandSegments(command).some((segment) => runsProjectCode(effectiveCommand(segment))) ? [PROJECT_CODE_REASON] : [];
}

function runsProjectCode(tokens) {
  if (!tokens.length) return false;
  const [executable, ...args] = tokens;
  const name = basenameCommand(executable).toLowerCase();
  const infoOnly = args.length > 0 && args.every((token) => INFO_FLAGS.has(token));
  if (executable.includes("/") && !SYSTEM_EXECUTABLE_PREFIXES.some((prefix) => executable.startsWith(prefix))) return true;
  if (PACKAGE_MANAGERS.has(name)) return args.length ? !PACKAGE_READ_ONLY.has(args[0]) : name === "yarn";
  if (PACKAGE_RUNNERS.has(name)) return true;
  if (BUILD_TOOLS.has(name) || PROJECT_TOOLS.has(name)) return !infoOnly;
  if (TOOLCHAIN_SUBCOMMANDS[name]) return TOOLCHAIN_SUBCOMMANDS[name].includes(args.find((token) => !token.startsWith("-") && !token.startsWith("+")));
  if (SCRIPT_INTERPRETERS.has(name)) {
    // A bare interpreter is an interactive REPL, which the interactive check blocks.
    if (!args.length || infoOnly) return false;
    // `node --check` only parses, unless preload/eval flags make it run code first.
    const preloads = args.some((token) => /^(?:-r|--require|--import|--loader|--experimental-loader|-e|--eval|-p|--print)(?:=|$)/.test(token));
    return !(name.startsWith("node") && args.some((token) => token === "--check" || token === "-c") && !preloads);
  }
  if (SHELL_INTERPRETERS.has(name)) return shellCommandPayload(args) === undefined && args.some((token) => token === "-s" || !token.startsWith("-"));
  if (name === "source" || name === ".") return true;
  return /\.(sh|bash|zsh|py|rb|pl|js|mjs|cjs|ts)$/i.test(name);
}

// Skip leading assignments and wrappers (`env`, `timeout 5`, `xargs -n1`) to reach the command
// that runs.
function effectiveCommand(segment) {
  return unwrapCommand(segment).tokens;
}

function unwrapCommand(segment, depth = 0) {
  if (depth > MAX_NESTED_DEPTH) return { tokens: [], payloads: [], uncertain: true };
  let index = 0;
  const payloads = [];
  let uncertain = false;
  while (index < segment.length) {
    const token = segment[index];
    if (/^[A-Za-z_]\w*=/.test(token)) { index += 1; continue; }
    const name = basenameCommand(token);
    if (!COMMAND_WRAPPERS.has(name)) break;
    index += 1;
    if (name === "command" && /^-[vV]$/.test(segment[index] ?? "")) return { tokens: [], payloads, uncertain };
    while (index < segment.length && segment[index].startsWith("-")) {
      const flag = segment[index];
      index += 1;
      if (flag === "--") break;
      if (name === "env") {
        if (["--version", "--help"].includes(flag)) return { tokens: [], payloads, uncertain };
        const split = flag === "-S" || flag === "--split-string" ? segment[index++]
          : flag.startsWith("--split-string=") ? flag.slice("--split-string=".length)
            : flag.startsWith("-S") ? flag.slice(2) : undefined;
        if (split !== undefined) {
          // env's split-string grammar has additional escapes and variable expansion.
          // Only the shared literal subset can be reconstructed as shell words.
          // Anything else requires approval rather than silently becoming an empty command.
          if (!split.trim() || /[\\$#]/.test(split) || !balancedQuotes(split)) return { tokens: [], payloads, uncertain: true };
          payloads.push([split, ...segment.slice(index).map((word) => "'" + word.replaceAll("'", "'\\''") + "'")].join(" "));
          const nested = unwrapCommand([...shellTokens(split), ...segment.slice(index)], depth + 1);
          return { tokens: nested.tokens, payloads: [...payloads, ...nested.payloads], uncertain: uncertain || nested.uncertain };
        }
        if (["-S", "--split-string"].includes(flag)) return { tokens: [], payloads, uncertain: true };
        if (["-u", "--unset", "-C", "--chdir"].includes(flag)) { if (segment[index] === undefined) uncertain = true; index += 1; }
        else if (!["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(flag)
          && !/^(?:--(?:unset|chdir)=.+|-[uC].+)$/.test(flag)) uncertain = true;
        continue;
      }
      if (WRAPPER_VALUE_FLAGS[name]?.includes(flag)) index += 1;
    }
    if (name === "timeout" && index < segment.length) index += 1;
  }
  return { tokens: segment.slice(index), payloads, uncertain };
}

function balancedQuotes(text) {
  let quote = "";
  for (const char of text) {
    if (quote) { if (char === quote) quote = ""; }
    else if (char === "'" || char === '"') quote = char;
  }
  return !quote;
}

// `find … -exec CMD {} ;` runs CMD for every match; classify CMD like any other command.
function findExecPayloads(args) {
  const payloads = [];
  for (let index = 0; index < args.length; index += 1) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[index])) continue;
    const end = args.findIndex((token, position) => position > index && (token === ";" || token === "+"));
    const words = args.slice(index + 1, end < 0 ? args.length : end);
    if (words.length) payloads.push(words.map((word) => "'" + word.replaceAll("'", "'\\''") + "'").join(" "));
    index = end < 0 ? args.length : end;
  }
  return payloads;
}

function detectProgramLaunch(command) {
  return shellCommandSegments(command).some((segment) => launchesProgram(effectiveCommand(segment))) ? [LAUNCH_REASON] : [];
}

function launchesProgram(tokens) {
  if (!tokens.length) return false;
  const [executable, ...args] = tokens;
  const name = basenameCommand(executable).toLowerCase();
  if (PROGRAM_LAUNCHERS.has(name)) return !(args.length > 0 && args.every((token) => INFO_FLAGS.has(token)));
  if (LAUNCH_SUBCOMMANDS[name]) return LAUNCH_SUBCOMMANDS[name].includes(args.find((token) => !token.startsWith("-")));
  if (LAUNCH_OPTIONS[name]) return args.some((token) => LAUNCH_OPTIONS[name].test(token));
  if (/^[gmn]?awk$/.test(name)) return args.some((token) => /^(?:-f|--file)(?:=|$)/.test(token) || /\bsystem\s*\(|\||\bgetline\b/.test(token));
  if (name === "sed" || name === "gsed") return !args.includes("--sandbox") && sedRunsCommands(args);
  return false;
}

// GNU sed runs shell commands through the `e` command and the `e` flag of `s///`.
function sedRunsCommands(args) {
  const scripts = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (/^(?:-f|--file)(?:=|$)/.test(token)) return true;
    if (token === "-e" || token === "--expression") scripts.push(args[++index] ?? "");
    else if (token.startsWith("--expression=")) scripts.push(token.slice("--expression=".length));
  }
  if (!scripts.length) {
    const script = args.find((token) => !token.startsWith("-"));
    if (script !== undefined) scripts.push(script);
  }
  return scripts.some((script) => /(?:^|[;\n{}])\s*(?:\d+|\$|\/[^/]*\/)?\s*e(?:\s|;|$)/.test(script)
    || /s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpIiMm0-9]*e/.test(script));
}

// Splits `git [global options] <subcommand> [args]`. Returns undefined for anything but git.
function parseGitInvocation(tokens) {
  if (basenameCommand(tokens[0]).toLowerCase() !== "git") return undefined;
  const invocation = { configKeys: [], directories: [], uncheckable: false, subcommand: undefined, args: [] };
  let index = 1;
  for (; index < tokens.length && tokens[index].startsWith("-"); index += 1) {
    const [option, inline] = tokens[index].split(/=(.*)/s);
    const value = inline ?? (GIT_GLOBAL_VALUE_OPTIONS.has(option) ? tokens[++index] : undefined);
    if (option === "-c") invocation.configKeys.push(String(value ?? "").split("=")[0]);
    if (option === "-C") invocation.directories.push(value ?? ".");
    if (GIT_UNCHECKABLE_OPTIONS.has(option)) invocation.uncheckable = true;
  }
  invocation.subcommand = tokens[index];
  invocation.args = tokens.slice(index + 1);
  invocation.infoOnly = tokens.length > 1 && tokens.slice(1).every((token) => ["--version", "--help", "-h", "--html-path", "--man-path", "--info-path"].includes(token));
  return invocation;
}

function gitIsReadOnly({ subcommand, args, infoOnly }) {
  if (!subcommand) return infoOnly;
  const positional = args.filter((token) => !token.startsWith("-"));
  if (subcommand === "grep") return !args.some((token) => /^(?:-O|--open-files-in-pager)/.test(token));
  if (["diff", "log", "show", "whatchanged"].includes(subcommand)) return !args.includes("--ext-diff");
  if (GIT_READ_ONLY.has(subcommand)) return true;
  if (subcommand === "branch") return !positional.length && !args.some((token) => /^(?:-[dDmMcCuf]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))/.test(token));
  if (subcommand === "tag") return !positional.length || args.some((token) => token === "-l" || token === "--list");
  if (subcommand === "stash") return ["list", "show"].includes(positional[0]);
  if (subcommand === "worktree") return positional[0] === "list";
  if (subcommand === "remote") return !positional.length || positional[0] === "get-url";
  if (subcommand === "reflog") return !positional.length || positional[0] === "show";
  if (subcommand === "config") {
    if (["get", "list"].includes(positional[0])) return true;
    if (args.some((token) => /^(?:--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|--get-color|--get-colorbool)$/.test(token))) return true;
    return positional.length === 1 && !args.some((token) => /^(?:--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|-e|--edit)$/.test(token));
  }
  return false;
}

function detectGitRisk(command) {
  const reasons = [];
  for (const segment of shellCommandSegments(command)) {
    const git = parseGitInvocation(effectiveCommand(segment));
    if (!git) continue;
    if (git.configKeys.some((key) => GIT_PROGRAM_CONFIG.test(key))) reasons.push("git -c sets a program git would run");
    if (git.uncheckable) reasons.push("git is pointed at another repository or helper directory");
    if (!gitIsReadOnly(git)) reasons.push(GIT_REASON);
  }
  if (reasons.length === 0 && GIT_PROGRAM_ENV.test(command) && shellCommandSegments(command).some((segment) => parseGitInvocation(effectiveCommand(segment)))) {
    reasons.push("environment overrides a program git would run");
  }
  return reasons;
}

// The `-C` chain of every git invocation (empty for the command's own cwd), including git run
// inside shell payloads. The shell tool checks those repositories' configs before running.
export function gitInvocationDirectories(command, depth = 0) {
  const text = normalizeShellCommand(command);
  const chains = [];
  for (const segment of shellCommandSegments(text)) {
    const git = parseGitInvocation(effectiveCommand(segment));
    if (git) chains.push(git.directories);
  }
  if (depth < MAX_NESTED_DEPTH) for (const payload of nestedShellCommands(text)) chains.push(...gitInvocationDirectories(payload, depth + 1));
  return chains;
}

function detectInlineCodeExecution(command) {
  const reasons = [];
  for (const segment of shellCommandSegments(command).map(effectiveCommand)) {
    if (!segment.length) continue;
    const commandName = basenameCommand(segment[0]);
    if (!["node", "python", "python3", "ruby", "irb", "perl", "php"].includes(commandName)) continue;
    if (segment.slice(1).some((token) => token === "-e" || token === "-c" || token === "--eval")) {
      reasons.push("inline interpreter code execution");
    }
  }
  return reasons;
}

function detectBackgroundExecution(command) {
  return shellTokens(command).includes("&") ? ["backgrounded/detached process"] : [];
}

function detectInteractiveShellCommands(command) {
  const reasons = [];
  for (const segment of shellCommandSegments(command).map(effectiveCommand)) {
    if (!segment.length) continue;
    const commandName = basenameCommand(segment[0]);
    const args = segment.slice(1);
    if (["vim", "vi", "nvim", "nano", "emacs", "less", "more", "top", "htop", "ssh", "telnet", "ftp", "sftp", "mysql", "psql", "sqlite3", "redis-cli"].includes(commandName)) {
      reasons.push("interactive command");
    }
    if (["node", "python", "python3", "ruby", "irb"].includes(commandName) && (args.length === 0 || args.includes("-i") || args.includes("--interactive"))) {
      reasons.push("interactive repl command");
    }
    if (["bash", "zsh", "sh", "fish"].includes(commandName) && (args.length === 0 || args.includes("-i") || args.includes("--interactive"))) {
      reasons.push("interactive shell command");
    }
  }
  return reasons;
}

function shellTokens(command) {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      // A backslash-newline is a line continuation, not part of the word.
      if (char !== "\n") current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (quote === "'") current += char;
      else escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "\n") {
      // An unquoted newline separates commands exactly like `;`.
      pushCurrent();
      tokens.push(";");
      continue;
    }
    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      pushCurrent();
      tokens.push("&&");
      index += 1;
      continue;
    }
    if (char === "&") {
      const prevChar = command[index - 1];
      const nextChar = command[index + 1];
      if (prevChar === ">" || prevChar === "<" || nextChar === ">" || nextChar === "<") {
        // part of a redirection operator (2>&1, &>file, 0<&3) — not a background boundary
        current += char;
        continue;
      }
      pushCurrent();
      tokens.push("&");
      continue;
    }
    if (char === "|" && command[index + 1] === "|") {
      pushCurrent();
      tokens.push("||");
      index += 1;
      continue;
    }
    if (char === ";" || char === "|") {
      pushCurrent();
      tokens.push(char);
      continue;
    }
    current += char;
  }
  pushCurrent();
  return tokens;

  function pushCurrent() {
    if (!current) return;
    tokens.push(current);
    current = "";
  }
}

function isShellBoundary(token) {
  return token === ";" || token === "|" || token === "&&" || token === "||";
}

function isRecursiveForceRm(segment) {
  for (let index = 0; index < segment.length; index += 1) {
    if (!isRmCommand(segment[index])) continue;
    let recursive = false;
    let force = false;
    for (const token of segment.slice(index + 1)) {
      if (!token.startsWith("-") || token === "-") continue;
      if (token === "--recursive") recursive = true;
      if (token === "--force") force = true;
      if (!token.startsWith("--")) {
        recursive ||= /[rR]/.test(token);
        force ||= token.includes("f");
      }
    }
    if (recursive && force) return true;
  }
  return false;
}

function isRmCommand(token) {
  return token === "rm" || token.endsWith("/rm");
}

function basenameCommand(token) {
  return String(token ?? "").split("/").at(-1);
}
