const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ansiPattern = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;

function tokens(value) {
  const text = String(value ?? "");
  const result = [];
  let offset = 0;
  for (const match of text.matchAll(ansiPattern)) {
    for (const part of segmenter.segment(text.slice(offset, match.index))) result.push({ value: part.segment, start: offset + part.index });
    result.push({ value: match[0], start: match.index, ansi: true });
    offset = match.index + match[0].length;
  }
  for (const part of segmenter.segment(text.slice(offset))) result.push({ value: part.segment, start: offset + part.index });
  return result;
}

export function graphemeWidth(value) {
  if (/\p{Emoji_Presentation}/u.test(value) || /\u20e3/u.test(value)
    || /[\ufe0f\u200d]/u.test(value) && /\p{Extended_Pictographic}/u.test(value)) return 2;
  let width = 0;
  for (const char of value) {
    const point = char.codePointAt(0);
    if (point < 32 || point >= 0x7f && point < 0xa0 || /[\p{Mark}\p{Cf}]/u.test(char)) continue;
    width += point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a
      || point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f
      || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff
      || point >= 0xfe10 && point <= 0xfe19 || point >= 0xfe30 && point <= 0xfe6f
      || point >= 0xff00 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
      || point >= 0x1f300 && point <= 0x1faff || point >= 0x20000 && point <= 0x3fffd) ? 2 : 1;
  }
  return width;
}

function terminalColumns(value) { return Number.isSafeInteger(value) && value > 0 ? value : 120; }

// Rows are explicitly separated with CRLF by the renderer. A full final row
// gets an empty continuation row, so the caret never depends on delayed wrap.
export function layoutTerminalText(value, columns, cursorOffset = String(value ?? "").length) {
  columns = terminalColumns(columns);
  const text = String(value ?? "");
  const lines = [""];
  let row = 0, column = 0, cursor;
  const nextLine = () => { lines.push(""); row++; column = 0; };
  const position = () => column === columns ? { row: row + 1, column: 0 } : { row, column };
  for (const token of tokens(text)) {
    if (token.ansi) { lines[row] += token.value; continue; }
    if (token.value === "\n" || token.value === "\r\n" || token.value === "\r") {
      if (!cursor && cursorOffset <= token.start) cursor = position();
      nextLine();
      continue;
    }
    if (token.value === "\t") {
      if (!cursor && cursorOffset <= token.start) cursor = position();
      if (column === columns) nextLine();
      const spaces = 8 - column % 8;
      for (let index = 0; index < spaces; index++) {
        if (column === columns) nextLine();
        lines[row] += " "; column++;
      }
      continue;
    }
    const width = graphemeWidth(token.value);
    const displayedWidth = width > columns ? 1 : width;
    if (displayedWidth && column + displayedWidth > columns && column > 0) nextLine();
    if (!cursor && cursorOffset < token.start + token.value.length) cursor = position();
    // A two-cell glyph cannot be displayed in a one-column terminal.
    lines[row] += width > columns ? "�" : token.value;
    column += displayedWidth;
  }
  if (column === columns) nextLine();
  cursor ??= { row, column };
  return { lines, cursor, end: { row, column }, columns };
}

// menuFocus is the [start, end) range of menuLines holding the selected option.
export function layoutPromptFrame({ prompt, buffer, cursorIndex, columns, menuLines = [], menuFocus, rows } = {}) {
  const prefix = String(prompt ?? "");
  const body = String(buffer ?? "");
  const offset = prefix.length + [...body].slice(0, cursorIndex ?? [...body].length).join("").length;
  const base = layoutTerminalText(prefix + body, columns, offset);
  const height = Number.isSafeInteger(rows) && rows > 0 ? rows : Infinity;
  const physicalRows = (part) => part.length ? layoutTerminalText(part.join("\n") + "\n", base.columns).end.row : 0;
  let menuStart = 0, lines, viewportStart;
  for (;;) {
    const menu = menuLines.slice(menuStart);
    lines = menu.length ? [...base.lines, ...layoutTerminalText(menu.join("\n"), base.columns).lines] : base.lines;
    const menuReserve = menu.length && base.cursor.row === base.end.row
      ? Math.min(lines.length - base.lines.length, Math.floor(height / 3)) : 0;
    viewportStart = Math.max(0, base.cursor.row - height + 1 + menuReserve);
    // A menu taller than the rows below the caret drops lines above the
    // selected option until the selection reaches the bottom of the viewport.
    if (!menuFocus || menuStart >= menuFocus.start
      || base.lines.length + physicalRows(menuLines.slice(menuStart, menuFocus.end)) <= viewportStart + height) break;
    menuStart++;
  }
  const visible = lines.slice(viewportStart, viewportStart + height);
  if (viewportStart > 0 && visible.length) {
    // A viewport can begin inside a colored physical line. Replay only SGR
    // styling from hidden rows, never their text or cursor-control sequences.
    visible[0] = (lines.slice(0, viewportStart).join("").match(/\x1B\[[0-9;:]*m/g)?.join("") ?? "") + visible[0];
  }
  return { lines: visible,
    cursor: { row: base.cursor.row - viewportStart, column: base.cursor.column },
    viewportStart, columns: base.columns };
}

const verticalMove = (delta) => delta < 0 ? `\x1B[${-delta}A` : delta > 0 ? `\x1B[${delta}B` : "";

// Turns the displayed `previous` frame into `next`, starting from the caret of
// `previous` (or from the frame origin without one). Leading rows that did not
// change, such as the status header, are never rewritten, and changed rows are
// overwritten in place rather than cleared first, so typing does not flicker.
export function framePatch(previous, next) {
  const reuse = previous?.columns === next.columns;
  const oldLength = reuse ? previous.lines.length : 0;
  let first = 0;
  while (first < Math.min(oldLength, next.lines.length) && previous.lines[first] === next.lines[first]) first++;
  let row = reuse ? previous.cursor.row : 0, out = "";
  const moveTo = (target) => { out += verticalMove(target - row) + "\r"; row = target; };
  if (first < next.lines.length) {
    // A row beyond the old frame is reached by a newline from the row above it.
    if (first < oldLength) moveTo(first);
    else if (first > 0) { moveTo(first - 1); out += "\n"; }
    // Skipped rows still determine the SGR state that the first rewritten row starts in.
    const styles = next.lines.slice(0, first).join("").match(/\x1B\[[0-9;:]*m/g)?.join("") ?? "";
    out += styles + next.lines.slice(first).map((line) => "\x1B[K" + line).join("\r\n") + "\x1B[0m";
    row = next.lines.length - 1;
  }
  if (oldLength > next.lines.length) {
    if (first < next.lines.length) { out += "\r\n"; row++; } else moveTo(next.lines.length);
    out += "\x1B[J";
  }
  return out + verticalMove(next.cursor.row - row) + "\r" + (next.cursor.column > 0 ? `\x1B[${next.cursor.column}C` : "");
}

// The longest prefix (ANSI kept) that fits in `column` terminal cells.
export function prefixAtColumn(value, column) {
  let used = 0, prefix = "";
  for (const token of tokens(value)) {
    if (token.ansi) { prefix += token.value; continue; }
    const width = graphemeWidth(token.value);
    if (used + width > column) break;
    if (width && used === column) break;
    prefix += token.value; used += width;
  }
  return prefix;
}

export function reflowCursorRow(frame, columns) {
  if (!frame || frame.columns === terminalColumns(columns)) return frame?.cursor.row ?? 0;
  const prefix = [...frame.lines.slice(0, frame.cursor.row), prefixAtColumn(frame.lines[frame.cursor.row], frame.cursor.column)].join("\n");
  return layoutTerminalText(prefix, columns).end.row;
}

// Keep the editor's existing code-point offsets, but never split a displayed
// grapheme when moving or removing text (surrogates, accents, ZWJ emoji).
export function adjacentGraphemeIndex(value, index, direction) {
  const boundaries = [0];
  let offset = 0;
  for (const part of segmenter.segment(String(value ?? ""))) { offset += [...part.segment].length; boundaries.push(offset); }
  return direction < 0 ? boundaries.findLast((boundary) => boundary < index) ?? 0
    : boundaries.find((boundary) => boundary > index) ?? offset;
}
