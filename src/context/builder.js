const DEFAULT_CONTEXT_BUDGET = 120000;

export function buildContextMessages(items, { budget = DEFAULT_CONTEXT_BUDGET } = {}) {
  const sorted = [...items]
    .filter((item) => item?.message)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const messages = [];
  let used = 0;
  for (const item of sorted) {
    const message = normalizeMessage(item.message);
    const size = message.content.length;
    if (used + size > budget && messages.length > 0) continue;
    messages.push(message);
    used += size;
  }
  return messages;
}

export function contextItem(message, priority) {
  return { message, priority };
}

function normalizeMessage(message) {
  return {
    role: message.role ?? "system",
    content: String(message.content ?? ""),
  };
}
