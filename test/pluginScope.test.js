import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createPluginScope } from "../src/harness/pluginScope.js";
import { createToolRegistry } from "../src/tools/registry.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const definition = (execute, extra = {}) => ({ mutates: false,
  schema: { type: "function", function: { name: "scope_fixture", parameters: { type: "object", properties: {}, additionalProperties: false } } }, execute, ...extra });

test("DSH-REF-005 cancelled admission never starts a queued scope callback or tool", async () => {
  let calls = 0;
  const scope = createPluginScope(), controller = new AbortController();
  controller.abort(Object.assign(new Error("parent cancelled"), { code: "ABORT_ERR" }));
  await assert.rejects(scope.run(() => { calls++; }, { signal: controller.signal }), { code: "ABORT_ERR" });
  const queued = scope.run(() => { calls++; }); const disposal = scope.dispose();
  await assert.rejects(queued, { code: "PLUGIN_SCOPE_DISPOSED" }); assert.equal((await disposal).ok, true); assert.equal(calls, 0);
  for (const queuedRemoval of [false, true]) {
    const owner = createPluginScope(), registry = createToolRegistry();
    registry.registerHandle(definition(async () => { calls++; return { ok: true }; }), { scope: owner });
    const invocation = registry.execute("scope_fixture", {}, queuedRemoval ? {} : { signal: controller.signal });
    const removing = queuedRemoval ? owner.dispose() : undefined;
    const result = await invocation;
    assert.equal(result.code, "ABORT_ERR"); assert.equal(result.executionState, "not-started"); assert.equal(calls, 0);
    if (removing) assert.equal((await removing).ok, true); else await owner.dispose();
  }
});

test("DSH-REF-005 scoped disposal closes admission synchronously and waits for settled calls before resources", async () => {
  const scope = createPluginScope({ id: "scope-a" }), registry = createToolRegistry();
  const admitted = deferred(), release = deferred(), teardown = deferred();
  const order = [];
  scope.own(async () => { order.push("connection-close"); await teardown.promise; order.push("connection-closed"); }, { label: "connection" });
  registry.registerHandle(definition(async (_args, { signal }) => {
    admitted.resolve(); signal.addEventListener("abort", () => order.push("cancel"), { once: true });
    await release.promise; order.push("settled"); return { ok: true, data: "finished" };
  }), { scope });
  const pending = registry.execute("scope_fixture", {}); await admitted.promise;
  const dispose = scope.dispose(); assert.equal(scope.dispose(), dispose);
  assert.equal(registry.schemas().length, 0); assert.equal(scope.signal.aborted, true);
  assert.throws(() => scope.run(() => {}), { code: "PLUGIN_SCOPE_DISPOSED" });
  assert.throws(() => registry.registerHandle(definition(async () => ({})), { scope }), { code: "PLUGIN_SCOPE_DISPOSED" });
  assert.equal((await registry.execute("scope_fixture", {})).code, "TOOL_NOT_FOUND");
  assert.deepEqual(order, ["cancel"]);
  let disposed = false; dispose.then(() => { disposed = true; });
  release.resolve(); const result = await pending;
  assert.equal(result.executionState, "executed"); assert.equal(result.data, "finished");
  await delay(0); assert.equal(disposed, false); assert.deepEqual(order, ["cancel", "settled", "connection-close"]);
  teardown.resolve(); assert.equal((await dispose).ok, true); assert.equal(scope.snapshot().state, "disposed");
  assert.deepEqual(order, ["cancel", "settled", "connection-close", "connection-closed"]);
});

test("DSH-REF-005 exact registration disposal cannot unregister a later same-name registration", async () => {
  const registry = createToolRegistry(), scope = createPluginScope();
  const admitted = deferred(), release = deferred();
  const first = registry.registerHandle(definition(async () => { admitted.resolve(); await release.promise; return { ok: true, data: 1 }; }, {
    toModelContent: (_args, value) => ({ old: value.data }),
  }), { scope });
  const pending = registry.execute(first.name, {}); await admitted.promise;
  const removing = first.dispose(); assert.equal(first.dispose(), removing);
  assert.equal(first.active, false); assert.equal(registry.get(first.name), undefined);
  const second = registry.registerHandle(definition(async () => ({ ok: true, data: 2 }), { toModelContent: (_args, value) => ({ current: value.data }) }));
  const secondResult = await registry.execute(second.name, {});
  assert.deepEqual(registry.project(secondResult), { current: 2 });
  release.resolve(); const old = await pending; await removing;
  assert.equal(old.data, 1); assert.equal(old.code, "ABORT_ERR");
  assert.equal(registry.project(old).code, "ABORT_ERR", "removed call retains authoritative cancellation rather than its private renderer");
  assert.equal((await scope.dispose()).ok, true);
  await first.dispose(); first.stop();
  assert.equal(registry.get(second.name).name, second.name);
  assert.equal((await registry.execute(second.name, {})).data, 2);
  await second.dispose();
});

test("DSH-REF-005 settled output keeps its captured renderer after scope removal", async () => {
  const registry = createToolRegistry(), scope = createPluginScope();
  registry.registerHandle(definition(async () => ({ ok: true, data: 42 }), { toModelContent: (_args, value) => ({ answer: value.data }) }), { scope });
  const canonical = await registry.execute("scope_fixture", {});
  await scope.dispose();
  registry.register(definition(async () => ({ ok: true, data: 99 }), { toModelContent: () => "replacement" }));
  assert.equal(canonical.ok, true); assert.deepEqual(registry.project(canonical), { answer: 42 });
});

test("DSH-REF-005 registration disposal shares completion even when an abort listener reenters it", async () => {
  const registry = createToolRegistry(), admitted = deferred(), release = deferred();
  let nested;
  const handle = registry.registerHandle(definition(async (_args, { signal }) => {
    signal.addEventListener("abort", () => { nested = handle.dispose(); }, { once: true });
    admitted.resolve(); await release.promise; return { ok: true };
  }));
  const pending = registry.execute(handle.name, {}); await admitted.promise;
  const removing = handle.dispose(); assert.equal(removing, nested); release.resolve();
  await pending; assert.equal((await removing).ok, true);
});

test("DSH-REF-005 scope cleanup is idempotent, inverse ordered and observable when a resource fails", async () => {
  const scope = createPluginScope(), order = [];
  scope.own(() => { order.push("first"); }, { label: "first" });
  scope.own(async () => { order.push("second"); throw Object.assign(new Error("synthetic close failure"), { code: "CLOSE_FAILED" }); }, { label: "second" });
  scope.own(() => { order.push("third"); return { ok: false, error: "still open" }; }, { label: "third" });
  const closing = scope.dispose(); assert.equal(scope.dispose(), closing);
  const report = await closing;
  assert.deepEqual(order, ["third", "second", "first"]); assert.equal(report.ok, false); assert.equal(report.state, "dispose-failed");
  assert.equal(report.errors.length, 2); assert.equal(report.errors[1].code, "CLOSE_FAILED"); assert.match(report.errors[0].message, /still open/);
  assert.equal(scope.snapshot().state, "dispose-failed"); assert.equal(await scope.dispose(), report);
  assert.throws(() => scope.own(() => {}), { code: "PLUGIN_SCOPE_DISPOSED" });
});

test("DSH-REF-005 all resources close after a deactivation failure and recursive callers share the same promise", async () => {
  const scope = createPluginScope(); let nested, closes = 0;
  scope.own(() => { closes++; }, { label: "broken-admission", deactivate: () => { nested = scope.dispose(); throw new Error("deactivation failed"); } });
  scope.own(() => { closes++; }, { label: "healthy" });
  const removing = scope.dispose(); assert.equal(nested, removing);
  const result = await removing;
  assert.equal(result.ok, false); assert.equal(result.errors[0].phase, "deactivate"); assert.equal(closes, 2);
});

test("DSH-REF-005 resource handles are exact and direct cleanup cycles fail visibly", async () => {
  const scope = createPluginScope(); let closes = 0;
  const first = scope.own(() => { closes++; }, { label: "same" });
  scope.own(() => { closes++; }, { label: "same" });
  assert.equal(first.dispose(), first.dispose()); await first.dispose();
  assert.equal(closes, 1); const report = await scope.dispose(); assert.equal(report.ok, true); assert.equal(closes, 2);
  const cyclic = createPluginScope(); cyclic.own(() => cyclic.dispose(), { label: "cycle" });
  const failed = await cyclic.dispose(); assert.equal(failed.ok, false); assert.equal(failed.errors[0].code, "PLUGIN_CLEANUP_CYCLE");
});

test("DSH-REF-005 listener lifetime is exact and admitted asynchronous listeners settle before teardown", async () => {
  const events = new EventEmitter(), scopeA = createPluginScope(), scopeB = createPluginScope();
  const entered = deferred(), release = deferred(); let callsA = 0, callsB = 0, closed = false;
  scopeA.listen(events, "data", async function (value) { assert.equal(this, events); callsA += value; entered.resolve(); await release.promise; });
  scopeB.listen(events, "data", () => { callsB++; });
  scopeA.own(() => { closed = true; });
  events.emit("data", 1); await entered.promise;
  const removing = scopeA.dispose(); assert.equal(events.listenerCount("data"), 1); events.emit("data", 5);
  await delay(0); assert.equal(callsA, 1); assert.equal(callsB, 2); assert.equal(closed, false);
  release.resolve(); assert.equal((await removing).ok, true); assert.equal(closed, true);
  events.emit("data", 1); await delay(0); assert.equal(callsA, 1); assert.equal(callsB, 3);
  await scopeB.dispose(); assert.equal(events.listenerCount("data"), 0);
});

test("DSH-REF-005 EventTarget listener failures are observed without an unhandled rejection", async () => {
  const target = new EventTarget(), scope = createPluginScope();
  scope.listen(target, "ping", async () => { throw Object.assign(new Error("listener diagnostic"), { code: "LISTENER_FAILED" }); });
  target.dispatchEvent(new Event("ping")); await delay(0);
  assert.equal(scope.snapshot().listenerErrors.length, 1); assert.equal(scope.snapshot().listenerErrors[0].code, "LISTENER_FAILED");
  for (let i = 0; i < 100; i++) target.dispatchEvent(new Event("ping"));
  await delay(0); assert.equal(scope.snapshot().listenerErrors.length, 100); assert.equal(scope.snapshot().listenerErrorCount, 101);
  const report = await scope.dispose(); assert.equal(report.ok, true); assert.equal(report.listenerErrors.length, 100); assert.equal(report.listenerErrorCount, 101);
  target.dispatchEvent(new Event("ping")); await delay(0); assert.equal(scope.snapshot().listenerErrorCount, 101);
});

test("DSH-REF-005 disposing one listener handle waits for its admitted callbacks without closing other listeners", async () => {
  const events = new EventEmitter(), scope = createPluginScope(), entered = deferred(), release = deferred();
  let other = 0, removed = false;
  const listener = scope.listen(events, "tick", async () => { entered.resolve(); await release.promise; });
  scope.listen(events, "tick", () => { other++; });
  events.emit("tick"); await entered.promise;
  const removing = listener.dispose(); removing.then(() => { removed = true; });
  events.emit("tick"); await delay(0); assert.equal(removed, false); assert.equal(other, 2); assert.equal(scope.snapshot().state, "active");
  release.resolve(); assert.equal((await removing).ok, true); assert.equal(events.listenerCount("tick"), 1);
  await scope.dispose();
});

test("DSH-REF-005 a tool timeout cannot let scope cleanup run ahead of an uncooperative settling handler", async () => {
  const scope = createPluginScope(), registry = createToolRegistry(), entered = deferred(), release = deferred();
  let closed = false;
  scope.own(() => { closed = true; });
  registry.registerHandle(definition(async () => { entered.resolve(); await release.promise; return { ok: true, wrote: true }; }, { timeoutMs: 10 }), { scope });
  const pending = registry.execute("scope_fixture", {}); await entered.promise; await delay(15);
  const removing = scope.dispose(); await delay(0); assert.equal(closed, false);
  release.resolve(); const result = await pending;
  assert.equal(result.code, "TOOL_TIMEOUT"); assert.equal(result.wrote, true); assert.equal((await removing).ok, true); assert.equal(closed, true);
});
