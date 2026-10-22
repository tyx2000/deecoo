import assert from "node:assert/strict";
import { test } from "node:test";
import { adjacentGraphemeIndex, graphemeWidth, layoutPromptFrame, layoutTerminalText, reflowCursorRow } from "../src/terminal/promptLayout.js";

test("prompt layout normalizes a full physical row and positions interior edits by row and column", () => {
  const frame = layoutPromptFrame({ prompt: "header\n> ", buffer: "abcdefgh", cursorIndex: 8, columns: 10 });
  assert.deepEqual(frame.lines, ["header", "> abcdefgh", ""]);
  assert.deepEqual(frame.cursor, { row: 2, column: 0 });
  assert.deepEqual(layoutPromptFrame({ prompt: "header\n> ", buffer: "abcdefghijkl", cursorIndex: 10, columns: 10 }).cursor, { row: 2, column: 2 });
  assert.deepEqual(layoutPromptFrame({ prompt: "header\n> ", buffer: "abcdefg", cursorIndex: 7, columns: 10 }).lines, ["header", "> abcdefg"]);
});

test("ANSI, CJK, combining accents and joined emoji use visible terminal cells", () => {
  const frame = layoutPromptFrame({ prompt: "\x1b[31m> \x1b[0m", buffer: "中文👩‍💻é", columns: 10 });
  assert.deepEqual(frame.cursor, { row: 0, column: 9 });
  assert.equal(frame.lines.length, 1);
  assert.equal(graphemeWidth("👩‍💻"), 2);
  assert.equal(graphemeWidth("🇨🇳"), 2);
  assert.equal(graphemeWidth("é"), 1);
  const wrappedWide = layoutPromptFrame({ prompt: "> ", buffer: "abcdefg中", cursorIndex: 7, columns: 10 });
  assert.deepEqual(wrappedWide.lines, ["> abcdefg", "中"]);
  assert.deepEqual(wrappedWide.cursor, { row: 1, column: 0 }, "a caret before the wrapped wide glyph must share its physical row");
});

test("explicit buffer newlines and wrapped menu descriptions contribute physical rows", () => {
  const frame = layoutPromptFrame({ prompt: "header\n> ", buffer: "abc\ndef", cursorIndex: 5, columns: 10,
    menuLines: ["> long-menu-description", "  second"] });
  assert.deepEqual(frame.lines, ["header", "> abc", "def", "> long-men", "u-descript", "ion", "  second"]);
  assert.deepEqual(frame.cursor, { row: 2, column: 1 });
  assert.deepEqual(layoutTerminalText("1234567890\nnext", 10).lines, ["1234567890", "next"]);
});

test("a prompt taller than the terminal keeps the caret in a bounded viewport", () => {
  const frame = layoutPromptFrame({ prompt: "header\n> ", buffer: "x".repeat(70), cursorIndex: 70, columns: 10, rows: 4 });
  assert.equal(frame.lines.length, 4);
  assert.deepEqual(frame.cursor, { row: 3, column: 2 });
  assert.equal(frame.viewportStart, 5);
  const start = layoutPromptFrame({ prompt: "header\n> ", buffer: "x".repeat(70), cursorIndex: 0, columns: 10, rows: 4 });
  assert.deepEqual(start.cursor, { row: 1, column: 2 });
  assert.equal(start.viewportStart, 0);
});

test("a menu taller than the viewport scrolls to keep the selected option visible", () => {
  const menuLines = Array.from({ length: 6 }, (_, index) => `  option-${index}-wraps`);
  menuLines[4] = "> option-4-wraps";
  const frame = layoutPromptFrame({ prompt: "header\n> ", buffer: "/", columns: 10, rows: 6, menuLines, menuFocus: { start: 4, end: 5 } });
  assert.equal(frame.lines.length, 6);
  assert.deepEqual(frame.cursor, { row: 1, column: 3 });
  assert.deepEqual(frame.lines.slice(-2), ["> option-4", "-wraps"]);
  const first = layoutPromptFrame({ prompt: "header\n> ", buffer: "/", columns: 10, rows: 6, menuLines, menuFocus: { start: 0, end: 1 } });
  assert.deepEqual(first.lines.slice(2, 4), ["  option-0", "-wraps"], "options that already fit are not scrolled");
});

test("resize origin follows each prior hard row, including wide glyph boundaries", () => {
  const frame = layoutPromptFrame({ prompt: "> ", buffer: "abcdefghijklmnopqr", columns: 10 });
  assert.deepEqual(frame.lines, ["> abcdefgh", "ijklmnopqr", ""]);
  assert.equal(reflowCursorRow(frame, 20), 2, "widening does not join rows previously emitted with CRLF");
  assert.equal(reflowCursorRow(frame, 6), 4);
  const wide = layoutPromptFrame({ prompt: "> ", buffer: "中文中文", columns: 10 });
  assert.equal(reflowCursorRow(wide, 5), 3);
});

test("editing boundaries keep surrogate pairs, accents and joined emoji intact", () => {
  const text = "a👩‍💻é中";
  assert.equal(adjacentGraphemeIndex(text, 4, -1), 1);
  assert.equal(adjacentGraphemeIndex(text, 1, 1), 4);
  assert.equal(adjacentGraphemeIndex(text, 6, -1), 4);
  assert.equal(adjacentGraphemeIndex(text, 4, 1), 6);
  assert.equal(adjacentGraphemeIndex(text, 0, -1), 0);
  assert.equal(adjacentGraphemeIndex(text, 7, 1), 7);
});
