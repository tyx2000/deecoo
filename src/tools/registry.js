// Trusted local tool registration keeps advertisement, dispatch and policy metadata
// together. A tool name never grants a capability; the runtime intersects it with
// the user/task/worker policy before executing the registered handler.
import { canonicalToolValue, outputLimits, outputSchemaErrors, prepareOutputSchema, snapshotToolJson, ToolOutputContractError } from "./outputContract.js";
import { randomUUID } from "node:crypto";

const HOST_OUTCOME_CODES = new Set(["ABORT_ERR", "TOOL_TIMEOUT", "TOOL_INVALID_ARGUMENTS", "TOOL_READ_ONLY", "TASK_TOOL_BLOCKED", "WORKER_TOOL_BLOCKED", "TOOL_APPROVAL_DENIED", "SHELL_COMMAND_BLOCKED", "SHELL_CWD_BLOCKED", "SANDBOX_UNAVAILABLE", "JOB_CLEANUP_UNCONFIRMED", "PLUGIN_SCOPE_DISPOSED", "TOOL_UNREGISTERED"]);
const isObject = (value) => value !== null && (typeof value === "object" || typeof value === "function");
const hostOutcome = (value) => value?.ok === false && (HOST_OUTCOME_CODES.has(value.code) || String(value.code ?? "").startsWith("TOOL_OUTPUT_"));
const errorMessage = (error) => { try { return String(error?.message ?? error).slice(0, 4000); } catch { return "Unprintable tool contract failure"; } };

export function createToolRegistry(options = {}) {
  const entries = new Map();
  const captures = new WeakMap();
  const registrations = new WeakMap();
  const limits = outputLimits(options);
  const snapshot = (value, maxBytes, label) => snapshotToolJson(value, { ...limits, maxBytes, label });
  const outputError = (error, executionState) => Object.freeze({ ok: false, code: error instanceof ToolOutputContractError ? error.code : "TOOL_OUTPUT_INVALID", error: errorMessage(error), executionState });
  const bind = (canonical, capture) => { captures.set(canonical, { ...capture, canonical }); return canonical; };
  const projectStage = (result, metadata) => {
    const capture = isObject(result) ? captures.get(result) : undefined;
    if (hostOutcome(result)) return metadata ? undefined : snapshot(result, limits.maxProjectionBytes, "host tool outcome");
    if (!capture) return metadata ? undefined : snapshot(result, limits.maxProjectionBytes, "tool projection");
    if (capture.forceGeneric) return metadata ? undefined : capture.canonical;
    const cache = metadata ? "metadata" : "projection";
    if (capture[cache]) {
      if (capture[cache].error) throw capture[cache].error;
      return capture[cache].value;
    }
    const renderer = metadata ? capture.presentationMeta : capture.toModelContent;
    if (!renderer) return metadata ? undefined : capture.canonical;
    try {
      const value = renderer(capture.args, capture.canonical);
      if (value instanceof Promise) value.catch(() => {});
      const projected = metadata && value === undefined ? undefined : snapshot(value, metadata ? limits.maxMetadataBytes : limits.maxProjectionBytes, metadata ? "tool presentation metadata" : "tool model projection");
      capture[cache] = { value: projected };
      return projected;
    } catch (cause) {
      const error = new ToolOutputContractError(metadata ? "TOOL_OUTPUT_META_FAILED" : "TOOL_OUTPUT_RENDER_FAILED", `Tool ${capture.name} ${metadata ? "presentationMeta" : "toModelContent"} failed: ${errorMessage(cause)}`, { executionState: "executed", tool: capture.name, toolVersion: capture.version, cause });
      capture[cache] = { error };
      throw error;
    }
  };
  const registerHandle = (definition, { scope } = {}) => {
      if (scope !== undefined) {
        if (!scope || typeof scope.assertActive !== "function" || typeof scope.run !== "function" || typeof scope.own !== "function") throw new TypeError("A tool scope must provide admission, work tracking and resource ownership.");
        scope.assertActive();
      }
      const name = definition.schema?.function?.name;
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name ?? "") || typeof definition.execute !== "function") throw new Error("A tool requires a valid function schema and executor");
      if (entries.has(name)) throw new Error("Tool already registered: " + name);
      if (typeof definition.mutates !== "boolean") throw new Error("Tool must declare mutates: " + name);
      if (definition.timeoutMs !== undefined && (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs <= 0)) throw new Error("Tool timeoutMs must be a positive integer");
      for (const hook of ["toModelContent", "presentationMeta"]) {
        if (definition[hook] !== undefined && typeof definition[hook] !== "function") throw new ToolOutputContractError("TOOL_OUTPUT_HOOK_INVALID", hook + " must be a synchronous pure function");
      }
      const entry = { version: "1", category: "extension", workerModes: [], requiresApproval: false,
        outputTrust: "untrusted-data", ...definition, schema: structuredClone(definition.schema), outputSchema: prepareOutputSchema(definition.outputSchema), name };
      Object.freeze(entry);
      const registration = { registrationId: randomUUID(), entry, scope, controller: new AbortController(), active: true, calls: new Set() };
      const stop = (reason = Object.assign(new Error("This tool registration has been removed."), { code: "TOOL_UNREGISTERED", name: "AbortError" })) => {
        if (!registration.active) return;
        registration.active = false;
        if (entries.get(name) === entry) entries.delete(name);
        registration.controller.abort(reason);
      };
      let disposing;
      const dispose = (reason) => {
        if (disposing) return disposing;
        let complete;
        disposing = new Promise((resolve) => { complete = resolve; });
        stop(reason);
        Promise.resolve().then(async () => {
          while (registration.calls.size) await Promise.allSettled([...registration.calls]);
          complete(Object.freeze({ ok: true, state: "disposed", name, registrationId: registration.registrationId, errors: Object.freeze([]) }));
        });
        return disposing;
      };
      entries.set(name, entry);
      registrations.set(entry, registration);
      try { scope?.own(dispose, { label: "tool:" + name, deactivate: stop }); }
      catch (error) { stop(); throw error; }
      return Object.freeze({ name, registrationId: registration.registrationId, stop, dispose,
        get active() { return registration.active; } });
  };
  return {
    register(definition) { return registerHandle(definition).name; },
    registerHandle,
    get: (name) => entries.get(name),
    list: () => [...entries.values()].map(({ execute, toModelContent, presentationMeta, schema, ...entry }) => ({ ...entry, schema: structuredClone(schema) })),
    schemas: (predicate = () => true) => [...entries.values()].filter(predicate).map((entry) => structuredClone(entry.schema)),
    project: (result) => projectStage(result, false),
    presentation: (result) => projectStage(result, true),
    copyProjection(from, to) {
      if (isObject(from) && isObject(to) && captures.has(from)) captures.set(to, captures.get(from));
      return to;
    },
    async execute(name, args, options) {
      const entry = entries.get(name);
      if (!entry) return { ok: false, code: "TOOL_NOT_FOUND", error: "Unknown tool: " + name };
      const registration = registrations.get(entry);
      let work, invoked = false;
      const invoke = ({ signal }) => { invoked = true; return executeEntry(entry, args, { ...options, signal }); };
      const signal = options?.signal ? AbortSignal.any([options.signal, registration.controller.signal]) : registration.controller.signal;
      try { work = registration.scope ? registration.scope.run(invoke, { signal }) : invoke({ signal }); }
      catch (error) {
        if (error.code !== "PLUGIN_SCOPE_DISPOSED") throw error;
        return { ok: false, code: error.code, error: error.message, executionState: "not-started" };
      }
      registration.calls.add(work);
      try { return await work; }
      catch (error) {
        if (invoked || !signal.aborted) throw error;
        return { ok: false, code: "ABORT_ERR", error: "Tool call cancelled before dispatch.", executionState: "not-started" };
      }
      finally { registration.calls.delete(work); }
    },
  };

  async function executeEntry(entry, args, options) {
      const name = entry.name;
      const capture = { name, version: String(entry.version), toModelContent: entry.toModelContent, presentationMeta: entry.presentationMeta };
      let frozenArgs;
      try { frozenArgs = snapshot(args, limits.maxArgumentBytes, "tool arguments"); }
      catch (error) { return { ok: false, code: "TOOL_INVALID_ARGUMENTS", error: error.message, executionState: "not-started" }; }
      const errors = validateToolArguments(frozenArgs, entry.schema.function.parameters);
      if (errors.length) return { ok: false, code: "TOOL_INVALID_ARGUMENTS", error: errors.join("; ") };
      const controller = new AbortController();
      const timer = entry.timeoutMs ? setTimeout(() => controller.abort(Object.assign(new Error("Tool timeout exceeded"), { code: "TOOL_TIMEOUT" })), entry.timeoutMs) : undefined;
      const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      try {
        if (signal.aborted) return { ok: false, code: "ABORT_ERR", error: "Tool call cancelled before dispatch.", executionState: "not-started" };
        // Trusted in-process extensions must honor signal. Await settlement so a
        // timed-out handler cannot continue side effects behind a reported end.
        let result;
        try { result = await entry.execute(frozenArgs, { ...options, signal }); }
        catch (error) { if (!signal.aborted) throw error; }
        if (signal.aborted) {
          let safeResult;
          try { safeResult = snapshot(canonicalToolValue(result), limits.maxOutputBytes, "tool output"); } catch { /* host cancellation remains authoritative even for invalid output */ }
          const timedOut = controller.signal.aborted && signal.reason === controller.signal.reason;
          const failure = { ok: false, code: timedOut ? "TOOL_TIMEOUT" : "ABORT_ERR", error: timedOut ? "Tool timeout exceeded; handler has settled." : "Tool call cancelled; handler has settled.", executionState: "executed" };
          let canonical;
          try { canonical = snapshot({ ...safeResult, ...failure }, limits.maxOutputBytes, "cancelled tool outcome"); }
          catch { canonical = Object.freeze(failure); }
          return bind(canonical, { ...capture, args: frozenArgs, forceGeneric: true });
        }
        try {
          const canonical = snapshot(canonicalToolValue(result), limits.maxOutputBytes, "tool output");
          const violations = hostOutcome(canonical) ? [] : outputSchemaErrors(canonical, entry.outputSchema);
          if (violations.length) throw new ToolOutputContractError("TOOL_OUTPUT_SCHEMA_INVALID", violations.join("; "));
          return bind(canonical, { ...capture, args: frozenArgs, forceGeneric: hostOutcome(canonical) });
        } catch (error) {
          return bind(outputError(error, "executed"), { ...capture, args: frozenArgs, forceGeneric: true });
        }
      } finally { clearTimeout(timer); }
  }
}

export function validateToolArguments(value, schema = {}, path = "arguments") {
  if (schema.anyOf) {
    if (schema.anyOf.some((candidate) => validateToolArguments(value, candidate, path).length === 0)) return [];
    return [path + " does not match any supported shape"];
  }
  const errors = [];
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some((allowed) => allowed === type || allowed === "integer" && Number.isSafeInteger(value))) return [path + " must be " + schema.type];
  if (schema.enum && !schema.enum.includes(value)) errors.push(path + " has an unsupported value");
  if (typeof value === "number" && (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) errors.push(path + " is outside its supported range");
  if (type === "object") {
    for (const key of schema.required ?? []) if (value[key] === undefined) errors.push(path + "." + key + " is required");
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validateToolArguments(child, schema.properties[key], path + "." + key));
      else if (schema.additionalProperties === false) errors.push(path + "." + key + " is not supported");
    }
  }
  if (type === "array" && schema.items) value.forEach((child, index) => errors.push(...validateToolArguments(child, schema.items, path + "[" + index + "]")));
  return errors;
}
