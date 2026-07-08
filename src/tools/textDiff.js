export function countOccurrences(text, search) {
  if (search.length === 0) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = text.indexOf(search, index);
    if (next === -1) return count;
    count += 1;
    index = next + search.length;
  }
}

export function countLineChanges(original, next) {
  const before = diffLines(original);
  const after = diffLines(next);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const removed = before.slice(start, beforeEnd + 1);
  const added = after.slice(start, afterEnd + 1);
  if (removed.length === 0 || added.length === 0) {
    return { additions: added.length, deletions: removed.length };
  }

  const unchangedInside = lcsLength(removed, added);
  return {
    additions: added.length - unchangedInside,
    deletions: removed.length - unchangedInside,
  };
}

export function unifiedDiff(original, next, path) {
  const before = diffLines(original);
  const after = diffLines(next);
  const file = String(path ?? "file");
  if (original === next) {
    return [`--- a/${file}`, `+++ b/${file}`].join("\n");
  }

  const hunks = buildDiffHunks(before, after);
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    ...hunks,
  ].join("\n");
}

function buildDiffHunks(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const contextBeforeStart = Math.max(0, start - 3);
  const removed = beforeEnd >= start ? before.slice(start, beforeEnd + 1) : [];
  const added = afterEnd >= start ? after.slice(start, afterEnd + 1) : [];
  const trailingStart = beforeEnd >= start ? beforeEnd + 1 : start;
  const trailingContext = before.slice(trailingStart, Math.min(before.length, trailingStart + 3));
  const leadingContext = before.slice(contextBeforeStart, start);
  const oldStart = contextBeforeStart + 1;
  const oldCount = leadingContext.length + removed.length + trailingContext.length;
  const newStart = contextBeforeStart + 1;
  const newCount = leadingContext.length + added.length + trailingContext.length;

  return [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...leadingContext.map((line) => " " + line),
    ...removed.map((line) => "-" + line),
    ...added.map((line) => "+" + line),
    ...trailingContext.map((line) => " " + line),
  ];
}

function lcsLength(before, after) {
  const cellCount = before.length * after.length;
  if (cellCount > 1_000_000) return 0;
  let previous = new Array(after.length + 1).fill(0);
  let current = new Array(after.length + 1).fill(0);

  for (let i = 1; i <= before.length; i += 1) {
    for (let j = 1; j <= after.length; j += 1) {
      current[j] = before[i - 1] === after[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }

  return previous[after.length];
}

function diffLines(value) {
  const text = String(value ?? "");
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
