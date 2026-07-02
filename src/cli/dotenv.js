import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function loadDotEnvIfPresent(directory) {
  const path = resolve(directory, ".env");
  try {
    await access(path);
  } catch {
    return;
  }

  const content = await readFile(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!isSupportedDotEnvKey(key) || process.env[key] !== undefined) continue;
    process.env[key] = stripQuotes(rawValue.trim());
  }
}

function isSupportedDotEnvKey(key) {
  return key === "DEEPSEEK_API_KEY" || key.startsWith("DEECOO_");
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
