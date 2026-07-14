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

test("config parses provider and key options without treating them as an action", () => {
  const args = parseArgs(["config", "-provider", "anthropic", "-key", "sk-ant-test", "--model", "claude-sonnet-5"]);

  assert.equal(args.command, "config");
  assert.equal(args.configAction, undefined);
  assert.equal(args.provider, "anthropic");
  assert.equal(args.apiKey, "sk-ant-test");
  assert.equal(args.model, "claude-sonnet-5");
  assert.equal(args.task, "");
});

test("config provider options reject missing values", () => {
  assert.throws(() => parseArgs(["config", "-provider"]), /Missing value for -provider/);
  assert.throws(() => parseArgs(["config", "-key"]), /Missing value for -key/);
});
