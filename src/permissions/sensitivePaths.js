export const SENSITIVE_BASENAMES = new Set([".env", ".envrc", ".netrc", ".npmrc", ".pypirc", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]);
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg"]);
const ENV_SAMPLE = /^\.env(?:\.[\w-]+)*\.(?:example|sample|template)$/i;

// rg applies these to every path component. Negations preserve tracked dotenv templates.
export const SENSITIVE_GLOBS = [
  "*",
  "!.env", "!.env.*", "!.envrc", "!.netrc", "!.npmrc", "!.pypirc",
  ".env.example", ".env.sample", ".env.template", ".env.*.example", ".env.*.sample", ".env.*.template",
  "!.ssh", "!.aws", "!.gnupg", "!id_rsa", "!id_ed25519", "!id_ecdsa", "!id_dsa",
  "!**/.docker/config.json", "!**/.kube/config", "!**/.deecoo/settings.json",
];

export function isSensitivePath(path) {
  const parts = String(path ?? "").replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.some((part, index) => {
    const name = part.toLowerCase();
    if (SENSITIVE_DIRECTORIES.has(name) || SENSITIVE_BASENAMES.has(name)) return true;
    if (name.startsWith(".env.") && !ENV_SAMPLE.test(name)) return true;
    const next = parts[index + 1]?.toLowerCase();
    return (name === ".docker" && next === "config.json") || (name === ".kube" && next === "config") || (name === ".deecoo" && next === "settings.json");
  });
}
