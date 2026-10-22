import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSessionContext, createSessionStore, recordTurn } from "../src/session/store.js";

test("new sessions keep recent turns and complete history independent without deduplicating inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deecoo-session-contract-"));
  const previous = process.env.DEECOO_HOME;
  process.env.DEECOO_HOME = directory;
  try {
    const store = await createSessionStore("/synthetic-session-project");
    const source = [];
    const session = await store.createSession({ model: "mock", turns: source });
    assert.notEqual(session.turns, session.history);
    assert.notEqual(session.turns, source);
    await recordTurn(store, session, { user: "same legitimate input", assistant: "first", model: "mock" });
    assert.equal(session.turns.length, 1);
    assert.equal(session.history.length, 1);
    assert.equal(buildSessionContext(session).length, 2);
    for (let index = 1; index < 7; index += 1) {
      await recordTurn(store, session, { user: "same legitimate input", assistant: String(index), model: "mock" });
    }
    assert.equal(source.length, 0);
    assert.equal(session.history.length, 7);
    assert.equal(session.turns.length, 6);
    const restored = (await store.listSessions())[0];
    assert.equal(restored.history.length, 7);
    assert.equal(restored.turns.length, 6);
    await recordTurn(store, restored, { user: "same legitimate input", assistant: "after reload", model: "mock" });
    assert.equal(restored.history.length, 8);
  } finally {
    if (previous === undefined) delete process.env.DEECOO_HOME;
    else process.env.DEECOO_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded session summaries continue rolling while retaining explicit user constraints", async () => {
  const session = { turns: [], history: [], summary: "" };
  const store = { async save() {} };
  await recordTurn(store, session, { user: "Never modify production credentials.", assistant: "Acknowledged" });
  for (let index = 1; index < 30; index += 1) {
    await recordTurn(store, session, { user: "u" + index + "x".repeat(300), assistant: "a" + index + "y".repeat(500) });
  }
  const before = session.summary;
  await recordTurn(store, session, { user: "Constraint: NEW-CONSTRAINT-30", assistant: "Noted" });
  for (let index = 31; index < 40; index += 1) {
    await recordTurn(store, session, { user: "new-round-" + index, assistant: "new-answer-" + index });
    assert.ok(session.summary.length <= 6000);
  }
  assert.notEqual(session.summary, before);
  assert.match(session.summary, /Never modify production credentials/);
  assert.match(session.summary, /NEW-CONSTRAINT-30/);
  assert.ok(session.history.some((turn) => turn.user.includes("NEW-CONSTRAINT-30")));
  assert.ok(!session.turns.some((turn) => turn.user.includes("NEW-CONSTRAINT-30")));
  assert.match(JSON.stringify(buildSessionContext(session)), /NEW-CONSTRAINT-30/);
  assert.equal(session.history.length, 40);
});

test("legacy plain summaries survive migration into bounded rolling summary state", async () => {
  const session = { turns: [], history: [], summary: "Legacy project decision: use the existing database." };
  const store = { async save() {} };
  for (let index = 0; index < 8; index += 1) {
    await recordTurn(store, session, { user: "new input " + index, assistant: "answer " + index });
  }
  assert.match(session.summary, /Legacy project decision/);
  assert.match(session.summary, /new input 1/);
  assert.ok(session.summary.length <= 6000);
  const restored = JSON.parse(JSON.stringify(session));
  await recordTurn(store, restored, { user: "new input 8", assistant: "answer 8" });
  assert.match(restored.summary, /new input 2/);
  assert.equal((restored.summary.match(/Legacy project decision/g) ?? []).length, 1);
});

test("legacy summary migration recovers older explicit constraints from complete history", async () => {
  const history = Array.from({ length: 12 }, (_unused, index) => ({
    user: index === 4 ? "Never remove the legacy access controls." : "old input " + index,
    assistant: "old answer " + index,
  }));
  const session = {
    turns: history.slice(-6),
    history: [...history],
    summary: "old filler ".repeat(500) + "\nUser: Never remove the legacy access controls.",
  };
  await recordTurn({ async save() {} }, session, { user: "new input", assistant: "new answer" });
  assert.match(session.summary, /Never remove the legacy access controls/);
  assert.ok(!session.turns.some((turn) => turn.user.includes("legacy access")));
  assert.ok(session.summary.length <= 6000);
});

test("legacy summary-only migration reserves a bounded prefix when full history is unavailable", async () => {
  const session = {
    turns: [], history: [],
    summary: "Legacy prefix decision. " + "old filler ".repeat(500) + "legacy trailing context",
  };
  for (let index = 0; index < 7; index += 1) {
    await recordTurn({ async save() {} }, session, { user: "new input " + index, assistant: "new answer " + index });
  }
  assert.match(session.summary, /Legacy prefix decision/);
  assert.ok(!session.summary.includes("legacy trailing context"));
  assert.equal(session.summaryState.legacy.length, 1000);
  assert.ok(session.summary.length <= 6000);
});
