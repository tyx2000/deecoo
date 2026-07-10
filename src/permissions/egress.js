// Network egress allowlist. When an allowlist is configured, any shell command that reaches
// out to a host not on it is blocked; with no allowlist, egress falls back to the classifier's
// default (fetch = warn, upload = block). Hosts match by exact name or parent-domain suffix.

const NETWORK_TOOLS = new Set(["curl", "wget", "http", "https", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "ftp", "telnet", "rsync"]);

const URL_RE = /\bhttps?:\/\/([^/\s"']+)/gi;
const HOST_ARG_RE = /(?:^|\s)(?:--?[a-z-]+\s+)?([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?=\s|$)/gi;

// Extract candidate network destination hosts from a command string.
export function extractNetworkTargets(command) {
  const text = String(command ?? "");
  const hosts = new Set();
  let match;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text))) {
    hosts.add(stripPort(match[1].toLowerCase()));
  }
  // Bare host:port forms for nc/ssh/etc. that have no scheme.
  if (usesNetworkTool(text)) {
    HOST_ARG_RE.lastIndex = 0;
    while ((match = HOST_ARG_RE.exec(text))) {
      const host = stripPort(match[1].toLowerCase());
      if (host && !host.endsWith(".js") && !host.endsWith(".ts") && !host.endsWith(".json")) hosts.add(host);
    }
  }
  return [...hosts];
}

export function usesNetworkTool(command) {
  const first = String(command ?? "").trim().split(/[\s|;&]+/);
  return first.some((token) => NETWORK_TOOLS.has(basename(token)));
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
