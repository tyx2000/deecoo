const sources = new WeakMap();

// Keep provenance outside the environment itself so child processes cannot inherit it and a
// project file cannot claim to be trusted by setting another environment variable.
export function recordEnvironmentSource(env, key, source) {
  const entries = sources.get(env) ?? new Map();
  entries.set(key, { value: env[key], source });
  sources.set(env, entries);
}

export function environmentSource(env, key) {
  const entry = sources.get(env)?.get(key);
  return entry && entry.value === env[key] ? entry.source : "process environment";
}
