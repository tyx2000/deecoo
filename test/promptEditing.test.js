import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// A small independent VT screen, not the production layout implementation.
// Models the cursor clamping and delayed autowrap that exposed this regression.
class Screen {
  constructor(columns, rows = 30) {
    this.columns = columns; this.rows = rows; this.row = 0; this.column = 0;
    this.pendingWrap = false; this.cells = Array.from({ length: rows }, () => Array(columns).fill(" "));
  }
  down() {
    if (++this.row >= this.rows) { this.cells.shift(); this.cells.push(Array(this.columns).fill(" ")); this.row = this.rows - 1; }
  }
  write(text) {
    for (let i = 0; i < text.length;) {
      if (text[i] === "\x1b") {
        const match = text.slice(i).match(/^\x1b\[([?\d;]*)([A-Za-z])/);
        assert.ok(match, "Unexpected terminal sequence: " + JSON.stringify(text.slice(i)));
        const [, raw, command] = match; const n = Number(raw || 1);
        if (command === "A") this.row = Math.max(0, this.row - n);
        else if (command === "B") this.row = Math.min(this.rows - 1, this.row + n);
        else if (command === "C") this.column = Math.min(this.columns - 1, this.column + n);
        else if (command === "D") this.column = Math.max(0, this.column - n);
        else if (command === "G") this.column = Math.min(this.columns - 1, Math.max(0, n - 1));
        else if (command === "H" || command === "f") {
          const [row = 1, column = 1] = raw.split(";").filter(Boolean).map(Number);
          this.row = Math.min(this.rows - 1, Math.max(0, row - 1)); this.column = Math.min(this.columns - 1, Math.max(0, column - 1));
        } else if (command === "J") {
          if (raw === "2" || raw === "3") this.cells.forEach((line) => line.fill(" "));
          else { this.cells[this.row].fill(" ", this.column); for (let r = this.row + 1; r < this.rows; r++) this.cells[r].fill(" "); }
        } else if (command === "K") this.cells[this.row].fill(" ", raw === "2" ? 0 : this.column);
        else assert.ok(command === "m" || raw.startsWith("?") && ["h", "l"].includes(command), "Unsupported cursor command " + match[0]);
        if (!["m", "h", "l"].includes(command)) this.pendingWrap = false;
        i += match[0].length; continue;
      }
      const char = [...graphemes.segment(text.slice(i))][0].segment; i += char.length;
      if (char === "\r") { this.column = 0; this.pendingWrap = false; continue; }
      if (char === "\n" || char === "\r\n") { this.down(); this.column = 0; this.pendingWrap = false; continue; }
      if (char === "\b") { this.column = Math.max(0, this.column - 1); this.pendingWrap = false; continue; }
      if (char === "\t") { this.column = Math.min(this.columns - 1, (Math.floor(this.column / 8) + 1) * 8); this.pendingWrap = false; continue; }
      if (/\p{Mark}/u.test(char) || char === "\u200d" || /[\u0000-\u001f\u007f]/u.test(char)) continue;
      const point = char.codePointAt(0);
      const width = point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xff60 || point >= 0x1f300 ? 2 : 1;
      if (this.pendingWrap || this.column + width > this.columns) { this.down(); this.column = 0; this.pendingWrap = false; }
      this.cells[this.row][this.column] = char;
      if (width === 2) this.cells[this.row][this.column + 1] = "";
      if (this.column + width === this.columns) { this.column = this.columns - 1; this.pendingWrap = true; }
      else this.column += width;
    }
  }
  lines() { return this.cells.map((line) => line.join("").trimEnd()); }
  cursor() { return { row: this.row, column: this.column }; }
}

async function promptFixture(action, { columns = 10, rows = 30, slashOptions = [], prompt = "\x1b[36mdeecoo\x1b[0m\n> " } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-prompt-screen-"));
  const script = join(directory, "prompt.mjs");
  await writeFile(script, `
import { readPromptLine } from ${JSON.stringify(new URL("../src/terminal/select.js", import.meta.url).href)};
import { setImmediate } from 'node:timers/promises';
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
process.stdin.isRaw = false;
process.stdin.setRawMode = (value) => { process.stdin.isRaw = value; };
process.stdout.write = (value) => { process.send({ type: 'output', text: String(value) }); return true; };
const controller = new AbortController();
process.on('message', async (message) => {
  if (message.type === 'start') {
    process.stdout.columns = message.columns; process.stdout.rows = message.rows;
    readPromptLine(message.prompt, message.slashOptions, { history: [], signal: controller.signal }).then((value) => process.send({ type: 'complete', value }));
  } else if (message.type === 'keypress') process.stdin.emit('keypress', message.str, message.key);
  else if (message.type === 'abort') controller.abort();
  await setImmediate();
  process.send({ type: 'ack', id: message.id });
});
`);
  const child = fork(script, [], { env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const screen = new Screen(columns, rows); const waiters = new Map();
  let sequence = 0, stderr = "", fatal;
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (text) => { stderr += text; });
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  child.on("message", (message) => {
    if (message.type === "output") { try { screen.write(message.text); } catch (error) { fatal = error; } }
    if (message.type === "complete") complete(message.value);
    if (message.type === "ack") waiters.get(message.id)?.();
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const send = async (message) => {
    const id = ++sequence; let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Prompt subprocess did not respond: " + stderr)), 3000);
        waiters.set(id, resolve); child.send({ ...message, id });
      });
      if (fatal) throw fatal;
    } finally { clearTimeout(timer); waiters.delete(id); }
  };
  try {
    await send({ type: "start", columns, rows, slashOptions, prompt });
    const press = (str, key = {}) => send({ type: "keypress", str, key });
    await action({ screen, press, pending });
  } finally {
    child.kill("SIGTERM"); await closed;
    await rm(directory, { recursive: true, force: true });
  }
}

test("INPUT-001 wrapped input and Backspace keep the caret and redraw anchored to the same frame", async () => promptFixture(async ({ screen, press }) => {
  await press("abcdefghijk");
  assert.deepEqual(screen.cursor(), { row: 2, column: 3 });
  assert.deepEqual(screen.lines().slice(0, 3), ["deecoo", "> abcdefgh", "ijk"]);
  await press("\x7f", { name: "backspace" });
  assert.deepEqual(screen.cursor(), { row: 2, column: 2 });
  assert.deepEqual(screen.lines().slice(0, 4), ["deecoo", "> abcdefgh", "ij", ""]);
  await press("", { name: "home" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 2 });
  await press("", { name: "delete" });
  assert.deepEqual(screen.lines().slice(0, 3), ["deecoo", "> bcdefghi", "j"]);
  await press("", { name: "end" });
  assert.deepEqual(screen.cursor(), { row: 2, column: 1 });
}));

test("INPUT-001 an exact-width line gives the caret a real next row and deletion removes it", async () => promptFixture(async ({ screen, press }) => {
  await press("abcdefgh");
  assert.deepEqual(screen.cursor(), { row: 2, column: 0 });
  assert.equal(screen.pendingWrap, false);
  await press("\x7f", { name: "backspace" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 9 });
  assert.deepEqual(screen.lines().slice(0, 3), ["deecoo", "> abcdefg", ""]);
  await press("", { name: "left" });
  await press("Z");
  assert.deepEqual(screen.cursor(), { row: 1, column: 9 });
  assert.deepEqual(screen.lines().slice(0, 3), ["deecoo", "> abcdefZg", ""]);
}));

test("INPUT-001 Chinese wide characters wrap and Backspace do not duplicate prompt rows", async () => promptFixture(async ({ screen, press }) => {
  await press("中文测试输入");
  assert.deepEqual(screen.cursor(), { row: 2, column: 4 });
  assert.deepEqual(screen.lines().slice(0, 3), ["deecoo", "> 中文测试", "输入"]);
  await press("\x7f", { name: "backspace" });
  await press("\x7f", { name: "backspace" });
  assert.deepEqual(screen.cursor(), { row: 2, column: 0 });
  await press("\x7f", { name: "backspace" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 8 });
  assert.deepEqual(screen.lines().slice(0, 3), ["deecoo", "> 中文测", ""]);
}));

test("INPUT-001 explicit buffer newlines and mid-buffer editing preserve the displayed rows", async () => promptFixture(async ({ screen, press, pending }) => {
  await press("ab\ncd");
  assert.deepEqual(screen.cursor(), { row: 2, column: 2 });
  await press("", { name: "left" });
  await press("\x7f", { name: "backspace" });
  assert.deepEqual(screen.lines().slice(0, 3), ["deecoo", "> ab", "d"]);
  assert.deepEqual(screen.cursor(), { row: 2, column: 0 });
  await press("\x7f", { name: "backspace" });
  assert.deepEqual(screen.lines().slice(0, 3), ["deecoo", "> abd", ""]);
  assert.deepEqual(screen.cursor(), { row: 1, column: 4 });
  await press("\r", { name: "return" });
  assert.equal(await pending, "abd");
}));

test("INPUT-001 wrapped completion menus disappear cleanly without moving the input anchor", async () => promptFixture(async ({ screen, press }) => {
  await press("/");
  assert.deepEqual(screen.cursor(), { row: 1, column: 3 });
  assert.ok(screen.lines().join("\n").includes("Inspect"));
  await press("", { name: "escape" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 2 });
  assert.deepEqual(screen.lines().slice(0, 4), ["deecoo", ">", "", ""]);
  assert.equal(screen.lines().filter((line) => line.includes("deecoo")).length, 1);
}, { columns: 12, slashOptions: [{ label: "Inspect the workspace and report findings", value: "/inspect" }] }));

test("INPUT-001 combining text and emoji are edited at visible character boundaries", async () => promptFixture(async ({ screen, press, pending }) => {
  await press("abcde👩‍💻e\u0301");
  assert.deepEqual(screen.cursor(), { row: 2, column: 0 });
  await press("\x7f", { name: "backspace" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 9 });
  await press("", { name: "left" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 7 });
  await press("", { name: "delete" });
  assert.deepEqual(screen.lines().slice(0, 3), ["deecoo", "> abcde", ""]);
  await press("\r", { name: "return" });
  assert.equal(await pending, "abcde");
}));

test("INPUT-001 tabs have a stable display width when no completion menu is active", async () => promptFixture(async ({ screen, press, pending }) => {
  await press("ab"); await press("\t", { name: "tab" }); await press("c");
  assert.deepEqual(screen.cursor(), { row: 1, column: 9 });
  await press("\x7f", { name: "backspace" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 8 });
  await press("\x7f", { name: "backspace" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 4 });
  await press("\r", { name: "return" });
  assert.equal(await pending, "ab");
}));

test("INPUT-001 input taller than the terminal keeps editing inside a visible viewport", async () => promptFixture(async ({ screen, press }) => {
  await press("a".repeat(80));
  assert.deepEqual(screen.cursor(), { row: 5, column: 2 });
  await press("", { name: "home" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 2 });
  await press("", { name: "delete" });
  await press("", { name: "end" });
  assert.deepEqual(screen.cursor(), { row: 5, column: 1 });
}, { columns: 10, rows: 6 }));

test("INPUT-001 a narrow completion menu keeps the selected command visible", async () => promptFixture(async ({ screen, press }) => {
  await press("/");
  for (let index = 0; index < 8; index++) await press("", { name: "down" });
  assert.ok(screen.lines().join("\n").includes("> CMD_08"), screen.lines().join("\n"));
  await press("", { name: "tab" });
  assert.ok(screen.lines().join("\n").includes("> /c08"));
  await press("", { name: "escape" });
  assert.deepEqual(screen.cursor(), { row: 1, column: 2 });
  assert.equal(screen.lines().filter((line) => line.includes("deecoo")).length, 1);
}, { columns: 20, rows: 10, slashOptions: Array.from({ length: 12 }, (_, index) => ({
  label: `CMD_${String(index).padStart(2, "0")} describes a longer command with details that wrap`, value: `/c${String(index).padStart(2, "0")}`,
})) }));
