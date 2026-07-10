// Network egress allowlist. When an allowlist is configured, any shell command that reaches
// out to a host not on it is blocked; with no allowlist, egress falls back to the classifier's
// default (fetch = warn, upload = block). Hosts match by exact name or parent-domain suffix.

const NETWORK_TOOLS = new Set(["curl", "wget", "http", "https", "httpie", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "ftp", "telnet", "rsync"]);
// Commands that reach the network via a subcommand (host may be a URL argument).
const NETWORK_COMMANDS = new Set(["git", "npm", "pnpm", "yarn", "pip", "pip3", "docker", "gh"]);

const URL_RE = /\bhttps?:\/\/([^/\s"']+)/gi;
const HOST_ARG_RE = /(?:^|\s)(?:--?[a-z-]+\s+)?([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?=\s|$)/gi;

// Extract candidate network destination hosts — ONLY from commands that actually reach the
// network, so a command that merely mentions a URL (echo, grep, a code comment) is not treated
// as egress.
export function extractNetworkTargets(command) {
  const text = String(command ?? "");
  if (!hasNetworkIntent(text)) return [];
  const hosts = new Set();
  let match;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text))) {
    hosts.add(stripPort(match[1].toLowerCase()));
  }
  if (usesNetworkTool(text)) {
    HOST_ARG_RE.lastIndex = 0;
    while ((match = HOST_ARG_RE.exec(text))) {
      const host = stripPort(match[1].toLowerCase());
      if (host && !/\.(js|ts|json|md|txt|py|go|rs|lock)$/i.test(host)) hosts.add(host);
    }
  }
  return [...hosts];
}

// The command word of each shell segment (the token in command position, after operators),
// which is what actually runs — so `curl` inside a quoted echo argument is not mistaken for a
// network command. Quotes are stripped so operators inside them do not split the command.
function commandWords(command) {
  const withoutQuotes = String(command ?? "").replace(/"[^"]*"|'[^']*'/g, " ");
  return withoutQuotes
    .split(/(?:\|\||&&|[;|&\n])/)
    .map((segment) => {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      // Skip leading env assignments (FOO=bar) to find the real command word of the segment.
      const cmd = tokens.find((token) => !/^\w+=/.test(token));
      return cmd ? basename(cmd) : undefined;
    })
    .filter(Boolean);
}

export function usesNetworkTool(command) {
  return commandWords(command).some((word) => NETWORK_TOOLS.has(word));
}

export function hasNetworkIntent(command) {
  return commandWords(command).some((word) => NETWORK_TOOLS.has(word) || NETWORK_COMMANDS.has(word));
}

export function parseEgressAllowlist(value) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isHostAllowed(host, allowlist) {
  const target = stripPort(String(host ?? "").toLowerCase());
  return allowlist.some((allowed) => target === allowed || target.endsWith("." + allowed));
}

// Returns the list of disallowed hosts a command would contact, given an allowlist. Empty when
// the command is fine (no network, or all hosts allowed).
export function egressViolations(command, allowlist) {
  if (!allowlist || allowlist.length === 0) return [];
  return extractNetworkTargets(command).filter((host) => !isHostAllowed(host, allowlist));
}

function stripPort(host) {
  return host.replace(/:\d+$/, "");
}

function basename(token) {
  return String(token ?? "").split("/").at(-1);
}
