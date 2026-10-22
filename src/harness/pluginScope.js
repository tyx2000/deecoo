import { randomUUID } from "node:crypto";

// A trusted plugin owns registrations and resource cleanup in one lifetime.
// Abort is cooperative: disposal waits for admitted work to actually settle.
export function createPluginScope({ id = randomUUID() } = {}) {
  if (typeof id !== "string" || !id.trim() || id.length > 200) throw new TypeError("A plugin scope requires a bounded nonempty id.");
  const controller = new AbortController();
  const active = new Set();
  const resources = new Set();
  const listenerErrors = [];
  let listenerErrorCount = 0;
  let state = "active";
  let disposing;
  const assertActive = () => { if (state !== "active") throw closed(); };
  const waitForIdle = async () => { while (active.size) await Promise.allSettled([...active]); };
  const recordListenerError = (error, event) => {
    listenerErrorCount++;
    if (listenerErrors.length < 100) listenerErrors.push(describe(error, String(event).slice(0, 200), "listener"));
  };
  const run = (callback, { signal } = {}) => {
    assertActive();
    if (typeof callback !== "function") throw new TypeError("Plugin scope work must be a function.");
    const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const work = Promise.resolve().then(() => {
      if (linked.aborted) throw linked.reason instanceof Error ? linked.reason : Object.assign(new Error("Plugin work cancelled before dispatch."), { code: "ABORT_ERR", name: "AbortError" });
      return callback({ signal: linked });
    });
    active.add(work);
    work.then(() => active.delete(work), () => active.delete(work));
    return work;
  };
  const own = (dispose, { label = "resource", deactivate } = {}) => {
    assertActive();
    if (typeof dispose !== "function" || deactivate !== undefined && typeof deactivate !== "function") throw new TypeError("A scope resource requires a disposer and an optional synchronous deactivator.");
    if (typeof label !== "string" || label.length > 200) throw new TypeError("A scope resource label must be bounded text.");
    const errors = [];
    let closing, completion;
    let resourceState = "active";
    const stop = (reason) => {
      if (closing) return closing;
      resourceState = "disposing";
      let complete;
      closing = new Promise((resolve) => { complete = resolve; });
      try {
        const work = deactivate?.(reason);
        if (disposing && work === disposing || completion && work === completion) throw Object.assign(new Error("A resource cannot await its own scope disposal during deactivation."), { code: "PLUGIN_CLEANUP_CYCLE" });
        Promise.resolve(work).then(complete, (error) => { errors.push(describe(error, label, "deactivate")); complete(); });
      } catch (error) { errors.push(describe(error, label, "deactivate")); complete(); }
      return closing;
    };
    const release = (reason) => {
      if (completion) return completion;
      let complete;
      completion = new Promise((resolve) => { complete = resolve; });
      const stopped = stop(reason);
      stopped.then(async () => {
        try {
          const work = dispose(reason);
          if (disposing && work === disposing || completion && work === completion) throw Object.assign(new Error("A resource cannot await its own scope disposal."), { code: "PLUGIN_CLEANUP_CYCLE" });
          const result = await work;
          if (result?.ok === false) {
            for (const error of result.errors?.length ? result.errors : [{ code: result.code, message: result.error ?? "The resource reported incomplete cleanup." }]) {
              errors.push(describe(error, label, "dispose"));
            }
          }
        } catch (error) { errors.push(describe(error, label, "dispose")); }
        resourceState = errors.length ? "dispose-failed" : "disposed";
        complete(Object.freeze({ ok: errors.length === 0, state: resourceState, label, errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))) }));
      });
      return completion;
    };
    const record = { stop, release };
    resources.add(record);
    return Object.freeze({ dispose: release, get state() { return resourceState; } });
  };
  const scope = {
    id,
    signal: controller.signal,
    assertActive,
    run,
    own,
    listen(target, event, listener, options) {
      assertActive();
      if (typeof listener !== "function") throw new TypeError("A scoped listener must be a function.");
      const emitter = typeof target?.on === "function" && typeof target?.off === "function";
      const eventTarget = typeof target?.addEventListener === "function" && typeof target?.removeEventListener === "function";
      if (!emitter && !eventTarget) throw new TypeError("A scoped listener requires an EventEmitter or EventTarget.");
      const calls = new Set();
      const wrapped = (...args) => {
        if (state !== "active") return;
        try {
          const work = run(() => listener.apply(target, args));
          calls.add(work);
          work.then(() => calls.delete(work), (error) => {
            calls.delete(work);
            if (!controller.signal.aborted || error !== controller.signal.reason) recordListenerError(error, event);
          });
        }
        catch (error) { recordListenerError(error, event); }
      };
      const remove = () => emitter ? target.off(event, wrapped) : target.removeEventListener(event, wrapped, options);
      if (emitter) target.on(event, wrapped); else target.addEventListener(event, wrapped, options);
      try { return own(async () => { while (calls.size) await Promise.allSettled([...calls]); }, { label: "listener:" + String(event).slice(0, 190), deactivate: remove }); }
      catch (error) { remove(); throw error; }
    },
    snapshot() { return Object.freeze({ id, state, activeCalls: active.size, resources: resources.size, listenerErrorCount,
      listenerErrors: Object.freeze(listenerErrors.map((error) => Object.freeze({ ...error }))) }); },
    dispose(reason = closed()) {
      if (disposing) return disposing;
      state = "disposing";
      let complete;
      disposing = new Promise((resolve) => { complete = resolve; });
      const owned = [...resources].reverse();
      // Stop every admission point synchronously before cancellation. Even an
      // asynchronous deactivator cannot admit new scope.run/listen work now.
      const closing = owned.map((resource) => resource.stop(reason));
      controller.abort(reason);
      Promise.resolve().then(async () => {
        await Promise.allSettled(closing);
        await waitForIdle();
        const errors = [];
        for (const resource of owned) errors.push(...(await resource.release(reason)).errors);
        resources.clear();
        state = errors.length ? "dispose-failed" : "disposed";
        complete(Object.freeze({ ok: errors.length === 0, id, state, listenerErrorCount,
          errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))),
          listenerErrors: Object.freeze(listenerErrors.map((error) => Object.freeze({ ...error }))) }));
      });
      return disposing;
    },
  };
  return Object.freeze(scope);
}

function closed() { return Object.assign(new Error("This plugin scope no longer accepts registrations or calls."), { code: "PLUGIN_SCOPE_DISPOSED", name: "AbortError" }); }
function describe(error, label, phase) {
  let code = "PLUGIN_CLEANUP_FAILED", message = "Unprintable plugin cleanup failure";
  try { code = String(error?.code ?? code).slice(0, 100); message = String(error?.message ?? error ?? "Unknown plugin cleanup failure").slice(0, 2000); } catch { /* hostile error accessors are diagnostic data */ }
  return { label, phase, code, message };
}
