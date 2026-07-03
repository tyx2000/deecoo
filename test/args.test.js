import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/cli/args.js";

test("--yes remains shell-only while --yes-files is explicit", () => {
  const shellOnly = parseArgs(["--yes", "update files"]);
  assert.equal(shellOnly.yes, true);
  assert.equal(shellOnly.yesFiles, false);

  const fileWrites = parseArgs(["--yes", "--yes-files", "update files"]);
  assert.equal(fileWrites.yes, true);
  assert.equal(fileWrites.yesFiles, true);
});

test("--auto-approve-files aliases --yes-files", () => {
  const args = parseArgs(["--auto-approve-files", "update files"]);

  assert.equal(args.yes, false);
  assert.equal(args.yesFiles, true);
});
