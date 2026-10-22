import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createToolRegistry } from "../src/tools/registry.js";
import { snapshotToolJson, TOOL_OUTPUT_LIMITS } from "../src/tools/outputContract.js";
import { compactToolResult } from "../src/agent/loop.js";

const definition = (execute, extra = {}) => ({ schema: { type: "function", function: { name: "fixture_output", description: "Fixture", parameters: { type: "object", properties: { value: { type: "integer" } }, additionalProperties: false } } }, mutates: false, execute, ...extra });
const answerSchema = { type: "object", properties: { ok: { const: true }, data: { type: "object", required: ["answer"], properties: { answer: { type: "integer" } }, additionalProperties: false } }, required: ["ok", "data"], additionalProperties: false };

test("DSH-REF-001 generic projection preserves extension data lost by legacy compaction", async () => {
  const registry = createToolRegistry();
  registry.register(definition(async () => ({ ok: true, data: { answer: 42 }, custom: ["extension"] })));
  const canonical = await registry.execute("fixture_output", {});
  assert.equal(compactToolResult("fixture_output", canonical).data, undefined, "legacy built-in projection is intentionally field-selective");
  assert.deepEqual(registry.project(canonical), { ok: true, data: { answer: 42 }, custom: ["extension"] });
  assert.equal(registry.presentation(canonical), undefined);
  assert.ok(Object.isFrozen(canonical.data));
});

test("string results retain compatibility; scalar, array and null results are explicit JSON values", async () => {
  for (const [raw, expected] of [["old text", { ok: true, content: "old text" }], [42, { ok: true, value: 42 }], [false, { ok: true, value: false }], [null, { ok: true, value: null }], [[1, { a: 2 }], { ok: true, value: [1, { a: 2 }] }]]) {
    const registry = createToolRegistry(); registry.register(definition(async () => raw));
    assert.deepEqual(await registry.execute("fixture_output", {}), expected);
  }
  const registry = createToolRegistry();
  registry.register(definition(async () => ({ ok: false, detail: undefined, nested: { missing: undefined, text: "kept" } })));
  const result = await registry.execute("fixture_output", {});
  assert.deepEqual(result, { ok: false, nested: { text: "kept" } });
});

test("outputSchema validates the normalized canonical shape and reports execution already occurred", async () => {
  let calls = 0, renders = 0;
  const registry = createToolRegistry();
  registry.register(definition(async () => { calls++; return { ok: true, data: { answer: "wrong type" } }; }, { outputSchema: answerSchema, toModelContent() { renders++; return "hide the invalid output"; } }));
  const result = await registry.execute("fixture_output", {});
  assert.equal(result.code, "TOOL_OUTPUT_SCHEMA_INVALID");
  assert.equal(result.executionState, "executed");
  assert.match(result.error, /value\.data\.answer/);
  assert.equal(calls, 1);
  assert.equal(registry.project(result).code, "TOOL_OUTPUT_SCHEMA_INVALID");
  assert.equal(renders, 0);
  const scalar = createToolRegistry();
  scalar.register(definition(async () => 42, { outputSchema: { type: "object", required: ["value"], properties: { value: { type: "integer" } } } }));
  assert.deepEqual(await scalar.execute("fixture_output", {}), { ok: true, value: 42 });
});

test("schema registration rejects unsupported keywords instead of pretending to enforce them", async () => {
  const registry = createToolRegistry();
  for (const schema of [{ type: "object", madeUp: true }, { $ref: "external" }, { type: "nonsense" }, { type: "array", items: [] }, { type: "object", required: [1] }, { type: "number", minimum: "1" }]) {
    assert.throws(() => registry.register(definition(async () => ({}), { outputSchema: schema })), { code: "TOOL_OUTPUT_SCHEMA_UNSUPPORTED" });
  }
  registry.register(definition(async () => ({ ok: true, data: { answer: 42 } }), { outputSchema: { ...answerSchema, title: "Answer", description: "Useful metadata", default: { ok: true, data: { answer: 1 } }, examples: [], $schema: "https://json-schema.org/draft/2020-12/schema" } }));
  assert.equal((await registry.execute("fixture_output", {})).data.answer, 42);
});

test("output schemas support nested unions, arrays, JSON equality and ordinary bounds", async () => {
  const registry = createToolRegistry();
  const schema = { type: "object", required: ["ok", "data"], properties: { ok: { const: true }, data: { anyOf: [{ type: "array", minItems: 2, maxItems: 3, uniqueItems: true, items: { allOf: [{ type: "integer", minimum: 1 }, { maximum: 5 }], not: { const: 4 } } }, { type: "string", minLength: 2, maxLength: 4, pattern: "^ok" }] } }, additionalProperties: false };
  registry.register(definition(async ({ value }) => ({ ok: true, data: value === 1 ? [1, 3] : value === 2 ? [1, 1] : value === 3 ? [4, 5] : "okay" }), { outputSchema: schema }));
  assert.equal((await registry.execute("fixture_output", { value: 1 })).ok, true);
  assert.equal((await registry.execute("fixture_output", { value: 2 })).code, "TOOL_OUTPUT_SCHEMA_INVALID");
  assert.equal((await registry.execute("fixture_output", { value: 3 })).code, "TOOL_OUTPUT_SCHEMA_INVALID");
  assert.equal((await registry.execute("fixture_output", {})).ok, true);
});

test("non-JSON outputs fail explicitly without invoking getters or losing executed identity", async () => {
  let getterCalls = 0;
  const cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, "secret", { enumerable: true, get() { getterCalls++; return 1; } });
  const sparse = []; sparse.length = 1;
  for (const raw of [undefined, { x: BigInt(1) }, { x() {} }, { x: Symbol("bad") }, { x: NaN }, { x: Infinity }, cycle, new Map(), new Date(), [undefined], sparse, accessor]) {
    const registry = createToolRegistry(); registry.register(definition(async () => raw));
    const result = await registry.execute("fixture_output", {});
    assert.equal(result.ok, false);
    assert.equal(result.code, "TOOL_OUTPUT_INVALID");
    assert.equal(result.executionState, "executed");
  }
  assert.equal(getterCalls, 0);
});

test("JSON output, depth, node and rendered metadata have explicit bounds", async () => {
  assert.equal(TOOL_OUTPUT_LIMITS.maxOutputBytes, 64 * 1024 * 1024);
  assert.equal(TOOL_OUTPUT_LIMITS.maxProjectionBytes, 64 * 1024 * 1024);
  const registry = createToolRegistry({ maxOutputBytes: 64 });
  registry.register(definition(async () => ({ content: "x".repeat(65) })));
  assert.equal((await registry.execute("fixture_output", {})).code, "TOOL_OUTPUT_TOO_LARGE");
  assert.throws(() => snapshotToolJson({ a: { b: 1 } }, { maxDepth: 1 }), { code: "TOOL_OUTPUT_TOO_LARGE" });
  assert.throws(() => snapshotToolJson([1, 2], { maxNodes: 2 }), { code: "TOOL_OUTPUT_TOO_LARGE" });
  assert.throws(() => createToolRegistry({ maxOutputBytes: Infinity }), /Invalid tool output limit/);
});

test("arguments, canonical value and renderer/version are captured before asynchronous completion", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const originalArgs = { value: 2 };
  const raw = { ok: true, data: { answer: 42 } };
  const item = definition(async (args) => { assert.ok(Object.isFrozen(args)); assert.throws(() => { args.value = 8; }, TypeError); await gate; return raw; }, {
    version: "first", outputSchema: answerSchema,
    toModelContent(args, value) { assert.ok(Object.isFrozen(value.data)); assert.throws(() => { value.data.answer = 99; }, TypeError); return { answer: value.data.answer, input: args.value }; },
  });
  const registry = createToolRegistry(); registry.register(item);
  const pending = registry.execute("fixture_output", originalArgs);
  originalArgs.value = 100; item.toModelContent = () => "replacement"; item.version = "second";
  release(); const canonical = await pending; raw.data.answer = -1;
  assert.deepEqual(registry.project(canonical), { answer: 42, input: 2 });
  assert.equal(canonical.data.answer, 42);
  assert.equal(registry.get("fixture_output").version, "first");
});

test("effects copies retain private projection capture while forged fields grant no projection hook", async () => {
  let renders = 0;
  const registry = createToolRegistry();
  registry.register(definition(async () => ({ ok: true, data: { answer: 42 } }), { outputSchema: answerSchema, toModelContent(args, value) { renders++; assert.equal(value.effects, undefined); return { answer: value.data.answer }; } }));
  const canonical = await registry.execute("fixture_output", {});
  const observed = registry.copyProjection(canonical, { ...canonical, effects: { events: [{ type: "executor-only" }] } });
  assert.deepEqual(registry.project(observed), { answer: 42 });
  assert.deepEqual(registry.project(canonical), { answer: 42 });
  assert.equal(renders, 1);
  const forged = { ok: true, data: { answer: 7 }, projectionCapture: { name: "fixture_output" } };
  assert.deepEqual(registry.project(forged), forged);
  assert.equal(renders, 1);
  const generic = createToolRegistry(); generic.register(definition(async () => ({ ok: true, data: { answer: 42 } })));
  const raw = await generic.execute("fixture_output", {});
  assert.deepEqual(generic.project(generic.copyProjection(raw, { ...raw, privateEffect: true })), raw);
});

test("renderer failures have explicit codes and never replace canonical execution facts", async () => {
  let executions = 0, renders = 0;
  const registry = createToolRegistry();
  registry.register(definition(async () => { executions++; return { ok: true, data: { answer: 42 } }; }, { toModelContent() { renders++; throw new Error("fixture renderer broke"); }, version: "v1" }));
  const canonical = await registry.execute("fixture_output", {});
  for (let i = 0; i < 2; i++) assert.throws(() => registry.project(canonical), { code: "TOOL_OUTPUT_RENDER_FAILED", executionState: "executed", toolVersion: "v1" });
  assert.deepEqual(canonical, { ok: true, data: { answer: 42 } });
  assert.equal(executions, 1); assert.equal(renders, 1);
});

test("renderer and presentation metadata are bounded JSON, host-only and independent", async () => {
  const registry = createToolRegistry({ maxProjectionBytes: 16, maxMetadataBytes: 16 });
  registry.register(definition(async () => ({ ok: true, data: { answer: 42 } }), { toModelContent: () => "x".repeat(20), presentationMeta: () => ({ huge: "x".repeat(20) }) }));
  const canonical = await registry.execute("fixture_output", {});
  assert.throws(() => registry.project(canonical), (error) => error.code === "TOOL_OUTPUT_RENDER_FAILED" && error.cause.code === "TOOL_OUTPUT_TOO_LARGE");
  assert.throws(() => registry.presentation(canonical), { code: "TOOL_OUTPUT_META_FAILED" });
  assert.equal(canonical.data.answer, 42);
  assert.equal(Object.hasOwn(registry.list()[0], "toModelContent"), false);
  assert.equal(Object.hasOwn(registry.list()[0], "presentationMeta"), false);
  assert.equal(Object.hasOwn(registry.schemas()[0].function, "outputSchema"), false);
  const okay = createToolRegistry(); okay.register(definition(async () => ({ ok: true }), { presentationMeta: (_args, value) => ({ kind: "card", okay: value.ok }) }));
  const result = await okay.execute("fixture_output", {});
  assert.deepEqual(okay.presentation(result), { kind: "card", okay: true });
  assert.deepEqual(okay.project(result), { ok: true });
  assert.ok(Object.isFrozen(okay.presentation(result)));
});

test("non-JSON and asynchronous renderers fail without unhandled rejections", async () => {
  for (const renderer of [() => undefined, () => BigInt(1), () => () => 1, () => Promise.reject(new Error("async renderer unsupported")), () => { throw null; }]) {
    const registry = createToolRegistry(); registry.register(definition(async () => ({ ok: true }), { toModelContent: renderer }));
    const result = await registry.execute("fixture_output", {});
    assert.throws(() => registry.project(result), { code: "TOOL_OUTPUT_RENDER_FAILED" });
  }
  await delay(0);
});

test("caller cancellation and timeout cannot be hidden by schema or renderer hooks", async () => {
  let settled = false, renders = 0;
  const registry = createToolRegistry();
  registry.register(definition(async (_args, { signal }) => { try { await delay(200, undefined, { signal }); } finally { settled = true; } }, { timeoutMs: 10, outputSchema: false, toModelContent() { renders++; return { ok: true }; }, presentationMeta() { renders++; return {}; } }));
  const result = await registry.execute("fixture_output", {});
  assert.equal(settled, true); assert.equal(result.code, "TOOL_TIMEOUT"); assert.equal(result.executionState, "executed");
  assert.equal(registry.project(result).code, "TOOL_TIMEOUT"); assert.equal(registry.presentation(result), undefined); assert.equal(renders, 0);
  const controller = new AbortController();
  const slow = createToolRegistry();
  slow.register(definition(async () => { await delay(20); return { ok: true }; }, { toModelContent: () => ({ ok: true }) }));
  const pending = slow.execute("fixture_output", {}, { signal: controller.signal }); controller.abort();
  assert.equal((await pending).code, "ABORT_ERR");
  let invoked = false;
  const early = createToolRegistry(); early.register(definition(async () => { invoked = true; return {}; }));
  assert.equal((await early.execute("fixture_output", {}, { signal: controller.signal })).executionState, "not-started");
  assert.equal(invoked, false);
});

test("new host errors added after effects copy override a successful private renderer", async () => {
  let renders = 0;
  const registry = createToolRegistry(); registry.register(definition(async () => ({ ok: true, data: { answer: 42 } }), { toModelContent() { renders++; return "success"; } }));
  const canonical = await registry.execute("fixture_output", {});
  const cancelled = registry.copyProjection(canonical, { ...canonical, ok: false, code: "ABORT_ERR", error: "host cancelled" });
  assert.equal(registry.project(cancelled).code, "ABORT_ERR");
  assert.equal(canonical.ok, true); assert.equal(renders, 0);
});
