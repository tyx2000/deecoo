import assert from "node:assert/strict";
import { test } from "node:test";
import { formatActivityBlock } from "../src/cli/activity.js";
import { setTheme } from "../src/terminal/theme.js";

const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

function visible(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

test("activity blocks render command output in a tree structure", () => {
  setTheme("mono-focus");
  const block = visible(formatActivityBlock({
    name: "run_shell",
    args: { command: "git status --short" },
    result: {
      ok: true,
      stdout: " M src/example.js\n",
      stderr: "",
      activity: { kind: "command", label: "Ran command", target: "git status --short" },
    },
  }));

  assert.match(block, /^● Bash\(git status --short\)/);
  assert.match(block, /\n  └ M src\/example\.js$/);
});

test("activity blocks make no-output commands explicit", () => {
  setTheme("mono-focus");
  const block = visible(formatActivityBlock({
    name: "run_shell",
    args: { command: "git diff HEAD" },
    result: {
      ok: true,
      stdout: "",
      stderr: "",
      activity: { kind: "command", label: "Ran command", target: "git diff HEAD" },
    },
  }));

  assert.match(block, /^● Bash\(git diff HEAD\)/);
  assert.match(block, /\n  └ \(No output\)$/);
});

test("activity blocks include concise failure details", () => {
  setTheme("mono-focus");
  const block = visible(formatActivityBlock({
    name: "read_file",
    args: { path: "missing.js" },
    result: {
      ok: false,
      error: "file not found: missing.js",
    },
  }));

  assert.match(block, /^● Read\(missing\.js\) failed/);
  assert.match(block, /\n  └ file not found: missing\.js$/);
});
