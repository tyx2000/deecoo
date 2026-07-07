const BLOCK_PATTERNS = [
  { pattern: /\brm\s+-[^\s]*r[^\s]*f[^\s]*(\s+|$)|\brm\s+-[^\s]*f[^\s]*r[^\s]*(\s+|$)/i, reason: "recursive delete command" },
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
  { pattern: /\b(mv|cp|chmod|chown)\b/i, reason: "filesystem mutation" },
  { pattern: /\b(curl|wget)\b/i, reason: "network access" },
];

export function classifyShellCommand(command) {
  const text = String(command ?? "");
  const blocked = BLOCK_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.reason);
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
