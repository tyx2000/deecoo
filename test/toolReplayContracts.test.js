import assert from "node:assert/strict";
import { test } from "node:test";
import { createReplayTools, toolCallKey } from "../src/tools/recordReplay.js";

const read = { path: "sample.txt" };
const key = toolCallKey("read_file", read);

test("SCOR-009 repeated tool calls consume changing observations in recorded order", async () => {
  const tools = createReplayTools([
    { key, result: { ok: true, content: "before" } },
    { key, result: { ok: true, content: "after" } },
  ]);
  assert.equal((await tools.execute("read_file", read)).content, "before");
  assert.equal((await tools.execute("read_file", read)).content, "after");
  assert.equal((await tools.execute("read_file", read)).code, "REPLAY_MISS");
});

test("SCOR-009 tool strict miss does not consume a later matching recording", async () => {
  const tools = createReplayTools([{ key, result: { ok: true, content: "expected" } }]);
  assert.equal((await tools.execute("read_file", { path: "unknown.txt" })).code, "REPLAY_MISS");
  assert.equal((await tools.execute("read_file", read)).content, "expected");
});

test("SCOR-009 non-strict tool fallback only consumes unmatched remaining entries", async () => {
  const other = toolCallKey("git_status", {});
  const tools = createReplayTools([
    { key, result: { ok: true, content: "first" } },
    { key: other, result: { ok: true, status: "second" } },
  ], { strict: false });
  assert.equal((await tools.execute("read_file", read)).content, "first");
  assert.equal((await tools.execute("read_file", { path: "unknown.txt" })).status, "second");
  assert.deepEqual(await tools.execute("git_status", {}), { ok: true });
});

test("SCOR-009 tools support out-of-order keys and leave source fixtures unchanged", async () => {
  const other = toolCallKey("git_status", {});
  const fixture = [
    { key, result: { ok: true, content: "first" } },
    { key: other, result: { ok: true, status: "second" } },
  ];
  const tools = createReplayTools(fixture);
  const observed = await Promise.all([tools.execute("git_status", {}), tools.execute("read_file", read)]);
  assert.equal(observed[0].status, "second");
  assert.equal(observed[1].content, "first");
  assert.equal(fixture[0].consumed, undefined);
});
