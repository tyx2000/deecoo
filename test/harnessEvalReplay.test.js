import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecordingClient, createReplayClient, migrateReplayFixture, REPLAY_FINGERPRINT_VERSION, requestFingerprint } from "../src/llm/replay.js";

const request = () => ({ model: "offline", messages: [{ role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }] }], tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }], temperature: 0, max_tokens: 100 });

test("v2 fingerprint covers tools, assistant calls and sampling semantics", () => {
  const original = request();
  const fingerprint = requestFingerprint(original);
  assert.match(fingerprint, /^v2:[a-f0-9]{16}$/);
  for (const mutate of [
    (value) => { value.tools[0].function.parameters.properties = { path: { type: "string" } }; },
    (value) => { value.messages[0].tool_calls[0].function.arguments = '{"path":"b.js"}'; },
    (value) => { value.messages[0].tool_calls[0].function.name = "edit_file"; },
    (value) => { value.temperature = 1; },
    (value) => { value.max_tokens = 200; },
    (value) => { value.top_p = 0.5; },
    (value) => { value.seed = 42; },
    (value) => { value.tool_choice = "none"; },
  ]) {
    const modified = request();
    mutate(modified);
    assert.notEqual(requestFingerprint(modified), fingerprint);
  }
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(requestFingerprint(reordered), fingerprint);
});

test("recording snapshots the request before mutable agent messages change and can migrate", async () => {
  const input = request();
  const fixture = [];
  const response = { choices: [{ message: { role: "assistant", content: "done" } }] };
  const client = createRecordingClient({ async chatCompletion() { input.messages.push({ role: "user", content: "later" }); return response; } }, fixture);
  const before = requestFingerprint(input);
  await client.chatCompletion(input);
  assert.equal(fixture[0].fingerprint, before);
  assert.equal(fixture[0].fingerprintVersion, REPLAY_FINGERPRINT_VERSION);
  assert.equal(fixture[0].request.messages.length, 1);
  const migrated = migrateReplayFixture([{ ...fixture[0], fingerprint: "old" }]);
  assert.equal(migrated[0].fingerprint, before);
  assert.throws(() => migrateReplayFixture([{ fingerprint: "old", response }]), /re-record/);
  await assert.rejects(createReplayClient([{ fingerprint: "old", response }]).chatCompletion(request()), /migration/);
  assert.equal(await createReplayClient([{ fingerprint: "old", response }], { strict: false }).chatCompletion(request()), response);
});
