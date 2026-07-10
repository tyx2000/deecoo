import { egressViolations } from "./egress.js";

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
// credential-exfiltration step, so treat any reference as a hard block (the shell is not
// sandboxed at the OS level, so this policy is the containment boundary).
const SENSITIVE_PATH_PATTERNS = [
  { pattern: /(^|[\s"'=:])(?:~?\/|\.\/|[\w./-]+\/)?\.env(?:\.[\w-]+)?\b/i, reason: "dotenv secret file access" },
  { pattern: /(^|[\s"'=:])(?:~?\/|\.\/|[\w./-]+\/)?\.envrc\b/i, reason: "dotenv shell config access" },
  { pattern: /(^|[\s"'=:])~?\/?\.ssh\b/i, reason: "SSH key/config access" },
  { pattern: /(^|[\s"'=:])~?\/?\.aws\b/i, reason: "AWS credential access" },
  { pattern: /(^|[\s"'=:])~?\/?\.gnupg\b/i, reason: "GPG key access" },
  { pattern: /\/etc\/(shadow|sudoers)\b/i, reason: "system credential file access" },
  { pattern: /\bid_(rsa|ed25519|ecdsa|dsa)\b/i, reason: "private key access" },
  { pattern: /(^|[\s"'=:])~?\/?\.(netrc|npmrc|pypirc|docker\/config\.json|kube\/config)\b/i, reason: "service credential file access" },
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

export function classifyShellCommand(command, { egressAllowlist } = {}) {
  const text = normalizeShellCommand(command);
  const disallowedHosts = egressViolations(text, egressAllowlist);
  const blocked = [
    ...detectBlockedShellTokens(text),
    ...detectInteractiveShellCommands(text),
    ...BLOCK_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason),
    ...SENSITIVE_PATH_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason),
    ...EGRESS_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason),
    ...(disallowedHosts.length ? ["network egress to non-allowlisted host: " + disallowedHosts.join(", ")] : []),
  ];
  if (blocked.length) {
    return {
      level: "block",
      reasons: [...new Set(blocked)],
      promptLabel: "Blocked shell command",
    };
  }
  const warned = [
    ...detectInlineCodeExecution(text),
    ...detectBackgroundExecution(text),
    ...WARN_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason),
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
  return String(command ?? "").trim().replace(/\s+/g, " ");
}

const SECRET_ENV_PATTERN = /(^|_)(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH)($|_)/i;

// Remove secret-looking variables from the environment handed to a child shell process so an
// injected or careless command cannot read the agent's own credentials out of `env`.
export function sanitizeShellEnv(env = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_PATTERN.test(key)) continue;
    if (key.startsWith("DEEPSEEK_") || key.startsWith("ANTHROPIC_")) continue;
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

function detectInlineCodeExecution(command) {
  const reasons = [];
  for (const segment of shellCommandSegments(command)) {
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
  for (const segment of shellCommandSegments(command)) {
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
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
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
