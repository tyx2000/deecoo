import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { compactCount, createStatusLine, formatDuration, formatStatusLine, pauseStatusLine } from "../src/terminal/statusLine.js";

const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
function fakeTerminal({ isTTY = true, rows = 10, columns = 40 } = {}) {
  const output = [];
  const stream = Object.assign(new EventEmitter(), { isTTY, rows, columns, write(text) { output.push(String(text)); return true; } });
  return { stream, output, take: () => output.splice(0).join("") };
}

test("STATUS-001 the status line shows phase, elapsed time and compact token counts", () => {
  assert.equal(plain(formatStatusLine({ frame: "⠋", phase: "Thinking", elapsedMs: 83000, usage: { promptTokens: 56332, completionTokens: 4717 } })),
    "⠋ Thinking · 1m 23s · ↑ 56k ↓ 4.7k tokens · esc to interrupt");
  assert.deepEqual([0, 9999, 83000, 3723000].map(formatDuration), ["0s", "9s", "1m 23s", "1h 02m"]);
  assert.deepEqual([0, 999, 1000, 4717, 56332, 2500000].map(compactCount), ["0", "999", "1k", "4.7k", "56k", "2.5M"]);
});

test("STATUS-001 the line is pinned below a scroll region and released on stop", () => {
  const { stream, take } = fakeTerminal();
  const original = stream.write;
  const line = createStatusLine({ stream, intervalMs: 60000, render: (frame) => `${frame} ${"x".repeat(80)}` }).start();
  const started = take();
  assert.ok(started.startsWith("\n\x1b7\x1b[1;9r\x1b8\x1b[1A"), JSON.stringify(started));
  assert.match(started, /\x1b7\x1b\[10;1H\x1b\[2K⠋ x{37}\x1b\[0m\x1b8$/, "drawn on the last row, never wider than columns - 1");
  stream.write("log\n");
  assert.equal(take(), "log\n", "other output passes through unchanged");
  line.stop();
  assert.equal(take(), "\x1b7\x1b[r\x1b[10;1H\x1b[2K\x1b8");
  assert.equal(stream.write, original);
});

test("STATUS-001 prompts pause the line and it returns only at the start of a line", () => {
  const { stream, take } = fakeTerminal();
  const line = createStatusLine({ stream, intervalMs: 60000, render: () => "status" }).start();
  take();
  const resume = pauseStatusLine();
  assert.match(take(), /\x1b\[r/, "pausing gives the prompt the whole screen");
  stream.write("Allow write_file? [y/N] ");
  resume();
  assert.equal(take(), "Allow write_file? [y/N] ", "never reserved while the caret is mid-line");
  stream.write("y\n");
  assert.match(take(), /^y\n\n\x1b7\x1b\[1;9r/);
  line.stop();
  assert.equal(pauseStatusLine()(), undefined, "pausing without an active line is harmless");
});

test("STATUS-001 non-terminals and tiny terminals never receive control sequences", () => {
  for (const options of [{ isTTY: false }, { rows: 3 }]) {
    const { stream, take } = fakeTerminal(options);
    const line = createStatusLine({ stream, intervalMs: 60000, render: () => "status" }).start();
    stream.write("output\n");
    line.stop();
    assert.equal(take(), "output\n");
  }
});
