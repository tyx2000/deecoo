import assert from "node:assert/strict";
import { test } from "node:test";
import { formatActivityBlock, formatActivityStart } from "../src/cli/activity.js";
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

test("activity blocks explain why a reused observation was served", () => {
  setTheme("mono-focus");
  const block = visible(formatActivityBlock({
    name: "read_file",
    args: { path: "src/a.js" },
    result: {
      ok: true,
      code: "ALREADY_AVAILABLE",
      priorStep: 4,
      reason: "duplicate_idempotent_success",
      content: "const a = 1;\n",
      activity: { kind: "process-guard", label: "Reused observation", target: "src/a.js" },
    },
  }));

  assert.match(block, /why: reused earlier result from step 4 · duplicate idempotent success/);
});

test("activity blocks explain why a repeated failure was blocked", () => {
  setTheme("mono-focus");
  const block = visible(formatActivityBlock({
    name: "search_text",
    args: { query: "missing" },
    result: {
      ok: false,
      code: "DUPLICATE_FAILURE_LOOP",
      reason: "duplicate_failure_loop",
      error: "Repeated the same failing tool call.",
    },
  }));

  assert.match(block, /why: blocked repeated identical failure/);
});

test("activity blocks omit the why line for an ordinary execution", () => {
  setTheme("mono-focus");
  const block = visible(formatActivityBlock({
    name: "read_file",
    args: { path: "src/a.js" },
    result: { ok: true, content: "const a = 1;\n", activity: { kind: "read_file", label: "Read a file", target: "src/a.js" } },
    decision: { action: "allow", reasons: [] },
  }));

  assert.doesNotMatch(block, /why:/);
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

test("activity start blocks make long-running worker dispatch visible", () => {
  setTheme("mono-focus");
  const block = visible(formatActivityStart({
    name: "agent",
    args: { description: "Security Reviewer", mode: "research" },
    decision: { action: "allow", reasons: ["parallel_worker_dispatch"] },
  }));

  assert.match(block, /^○ Starting Agent\(Security Reviewer\)/);
  assert.match(block, /why: executed · parallel worker dispatch/);
});

test("activity blocks label missing file arguments explicitly", () => {
  setTheme("mono-focus");
  const block = visible(formatActivityBlock({
    name: "write_file",
    args: {},
    result: { ok: false, code: "INVALID_TOOL_ARGUMENTS", error: "Tool arguments were incomplete or invalid JSON." },
  }));

  assert.match(block, /^● Write\(<invalid arguments>\) failed/);
  assert.match(block, /Tool arguments were incomplete or invalid JSON/);
});
