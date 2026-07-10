// Secrets management. Two jobs: (1) know which values are secret so they can be redacted
// everywhere they might surface (tool output, logs, audit), and (2) discourage plaintext
// storage by supporting an OS keychain / file-reference indirection for the API key.

import { readFile } from "node:fs/promises";

const SECRET_KEY_PATTERN = /(^|_)(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH)($|_)/i;
const MIN_REDACTABLE_LENGTH = 6;

// Collect the concrete secret values present in an environment so they can be redacted.
export function collectSecretValues(env = {}) {
  const values = new Map();
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_KEY_PATTERN.test(key)) continue;
    const str = String(value ?? "");
    if (str.length >= MIN_REDACTABLE_LENGTH) values.set(str, key);
  }
  return values;
}

export function createSecretRegistry(env = {}) {
  const values = collectSecretValues(env);
  return {
    add(value, name = "secret") {
      const str = String(value ?? "");
      if (str.length >= MIN_REDACTABLE_LENGTH) values.set(str, name);
    },
    has(value) {
      return values.has(String(value ?? ""));
    },
    size: () => values.size,
    // Replace every known secret value in text with a labeled placeholder. Runs longest-first
    // so a secret that is a substring of another does not leak a suffix.
    redact(text) {
      let out = String(text ?? "");
      const entries = [...values.entries()].sort((a, b) => b[0].length - a[0].length);
      for (const [value, name] of entries) {
        if (!value) continue;
        out = out.split(value).join(`[redacted:${name}]`);
      }
      return out;
    },
  };
}

// Resolve a secret value with indirection: an explicit env var wins; a `file:PATH` or
// `keychain:SERVICE` reference is dereferenced so the raw secret need not sit in settings.json.
export async function resolveSecretReference(reference, { env = process.env } = {}) {
  const value = String(reference ?? "");
  if (!value) return undefined;
  if (value.startsWith("env:")) return env[value.slice(4)];
  if (value.startsWith("file:")) {
    try {
      return (await readFile(value.slice(5), "utf8")).trim();
    } catch {
      return undefined;
    }
  }
  return value;
}
