const BLOCK_PATTERNS = [
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "destructive git reset" },
  { pattern: /\bgit\s+clean\s+-[^\s]*[fd][^\s]*/i, reason: "destructive git clean" },
  { pattern: /\b(sudo|su)\b/i, reason: "privilege escalation" },
  { pattern: /\b(dd|mkfs|diskutil)\b/i, reason: "disk/device mutation" },
  { pattern: /\bchmod\s+-R\s+777\b/i, reason: "broad unsafe permission change" },
  { pattern: /(curl|wget)[^|;&]*\|\s*(sh|bash|zsh)\b/i, reason: "downloaded script execution" },
];

const WARN_PATTERNS = [
  { pattern: /\b(npm|pnpm|yarn)\s+install\b/i, reason: "dependency installation may run scripts or change lockfiles" },
  { pattern: /\b(git\s+commit|git\s+merge|git\s+rebase|git\s+push)\b/i, reason: "git history or remote mutation" },
  { pattern: /\b(rm|mv|cp|chmod|chown)\b/i, reason: "filesystem mutation" },
  { pattern: /\b(curl|wget)\b/i, reason: "network access" },
];

export function classifyShellCommand(command) {
  const text = normalizeShellCommand(command);
  const blocked = [
    ...detectBlockedShellTokens(text),
    ...BLOCK_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason),
  ];
  if (blocked.length) {
    return {
      level: "block",
      reasons: [...new Set(blocked)],
      promptLabel: "Blocked shell command",
    };
  }
  const warned = WARN_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason);
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
