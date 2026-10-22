import assert from "node:assert/strict";
import { test } from "node:test";
import { createReplayClient, requestFingerprint } from "../src/llm/replay.js";

const request = (content) => ({ model: "test", messages: [{ role: "user", content }] });
const response = (content) => ({ choices: [{ message: { role: "assistant", content } }] });
const entry = (input, output) => ({ fingerprint: requestFingerprint(input), response: response(output) });
const text = (result) => result.choices[0].message.content;

test("SCOR-009 strict replay consumes repeated fingerprints in recorded order", async () => {
  const input = request("same request");
  const replay = createReplayClient([entry(input, "first"), entry(input, "second")]);
  assert.equal(text(await replay.chatCompletion(input)), "first");
  assert.equal(text(await replay.chatCompletion(input)), "second");
  await assert.rejects(replay.chatCompletion(input), /No replay fixture/);
});

test("SCOR-009 strict replay rejects unknown fingerprints without consuming valid entries", async () => {
  const input = request("known");
  const replay = createReplayClient([entry(input, "known answer")]);
  await assert.rejects(replay.chatCompletion(request("unknown")), /No replay fixture/);
  assert.equal(text(await replay.chatCompletion(input)), "known answer");
});

test("SCOR-009 non-strict fallback consumes only unused entries", async () => {
  const first = request("first");
  const second = request("second");
  const replay = createReplayClient([entry(first, "first answer"), entry(second, "second answer")], { strict: false });
  assert.equal(text(await replay.chatCompletion(first)), "first answer");
  assert.equal(text(await replay.chatCompletion(request("unknown"))), "second answer");
  assert.equal(text(await replay.chatCompletion(second)), "");
});

test("SCOR-009 fallback consumption also removes the fingerprint match", async () => {
  const first = request("first");
  const second = request("second");
  const replay = createReplayClient([entry(first, "first answer"), entry(second, "second answer")], { strict: false });
  assert.equal(text(await replay.chatCompletion(request("unknown"))), "first answer");
  assert.equal(text(await replay.chatCompletion(first)), "second answer");
  assert.equal(text(await replay.chatCompletion(second)), "");
});

test("SCOR-009 concurrent out-of-order replay matches each request once", async () => {
  const first = request("first");
  const second = request("second");
  const replay = createReplayClient([entry(first, "first answer"), entry(second, "second answer")]);
  const values = await Promise.all([replay.chatCompletion(second), replay.chatCompletion(first)]);
  assert.deepEqual(values.map(text), ["second answer", "first answer"]);
  await assert.rejects(replay.chatCompletion(second), /No replay fixture/);
});

test("SCOR-009 replay streaming uses the same consumption contract", async () => {
  const input = request("same request");
  const replay = createReplayClient([entry(input, "first"), entry(input, "second")]);
  const deltas = [];
  await replay.chatCompletionStream(input, { onContent: (delta) => deltas.push(delta) });
  await replay.chatCompletionStream(input, { onContent: (delta) => deltas.push(delta) });
  assert.deepEqual(deltas, ["first", "second"]);
  await assert.rejects(replay.chatCompletionStream(input), /No replay fixture/);
});
