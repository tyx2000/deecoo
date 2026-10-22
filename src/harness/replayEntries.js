// Model and tool replay share one consumption contract. Keys can complete out
// of order, while repeated identical calls consume their recordings in order.
export function createReplayEntries(fixture, keyField) {
  const entries = fixture.map((entry) => ({ ...entry, consumed: false }));
  const byKey = new Map();
  for (const entry of entries) {
    const key = entry[keyField];
    if (!key) continue;
    const matches = byKey.get(key) ?? [];
    matches.push(entry);
    byKey.set(key, matches);
  }
  return {
    take(key, { fallback = false } = {}) {
      const matches = byKey.get(key);
      while (matches?.[0]?.consumed) matches.shift();
      const match = matches?.shift();
      if (match) {
        match.consumed = true;
        return match;
      }
      if (!fallback) return undefined;
      while (entries[0]?.consumed) entries.shift();
      const next = entries.shift();
      if (next) next.consumed = true;
      return next;
    },
  };
}
