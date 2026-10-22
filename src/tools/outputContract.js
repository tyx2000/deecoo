// Canonical tool values are bounded JSON, independent of model/UI projections.
// Trusted renderers get detached frozen inputs and never own execution facts.
export const TOOL_OUTPUT_LIMITS = Object.freeze({
  maxOutputBytes: 64 * 1024 * 1024,
  maxProjectionBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 1024 * 1024,
  maxArgumentBytes: 8 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 1_000_000,
});

export class ToolOutputContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ToolOutputContractError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function outputLimits(options = {}) {
  const result = { ...TOOL_OUTPUT_LIMITS };
  for (const key of Object.keys(result)) {
    if (options[key] === undefined) continue;
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > TOOL_OUTPUT_LIMITS[key]) throw new TypeError(`Invalid tool output limit: ${key}`);
    result[key] = options[key];
  }
  return Object.freeze(result);
}

// Object undefined properties follow JSON wire semantics and are omitted. Other
// lossy values, sparse arrays, accessors and custom prototypes are rejected.
export function snapshotToolJson(value, { maxBytes = TOOL_OUTPUT_LIMITS.maxOutputBytes, maxDepth = TOOL_OUTPUT_LIMITS.maxDepth, maxNodes = TOOL_OUTPUT_LIMITS.maxNodes, label = "tool output" } = {}) {
  let bytes = 0, nodes = 0;
  const ancestors = new Set();
  const invalid = (path, reason) => { throw new ToolOutputContractError("TOOL_OUTPUT_INVALID", `${label} at ${path}: ${reason}`); };
  const charge = (amount) => {
    bytes += amount;
    if (bytes > maxBytes) throw new ToolOutputContractError("TOOL_OUTPUT_TOO_LARGE", `${label} exceeds ${maxBytes} JSON bytes`);
  };
  const walk = (input, depth, path) => {
    if (++nodes > maxNodes || depth > maxDepth) throw new ToolOutputContractError("TOOL_OUTPUT_TOO_LARGE", `${label} exceeds its depth or node limit`);
    if (input === null || typeof input === "boolean" || typeof input === "string" || typeof input === "number") {
      if (typeof input === "number" && !Number.isFinite(input)) invalid(path, "non-finite number is not JSON");
      const json = JSON.stringify(input);
      charge(Buffer.byteLength(json, "utf8"));
      return Object.is(input, -0) ? 0 : input;
    }
    if (typeof input !== "object") invalid(path, `${typeof input} is not JSON`);
    if (ancestors.has(input)) invalid(path, "circular reference");
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid(path, "only plain JSON objects and arrays are supported");
    ancestors.add(input);
    try {
      charge(2);
      if (array) {
        const keys = Reflect.ownKeys(input);
        if (keys.length !== input.length + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length))) invalid(path, "sparse arrays or non-index array properties are not JSON");
        const copy = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid(`${path}[${index}]`, "array accessors are not supported");
          if (index) charge(1);
          copy.push(walk(descriptor.value, depth + 1, `${path}[${index}]`));
        }
        return Object.freeze(copy);
      }
      const copy = {};
      let count = 0;
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string") invalid(path, "symbol keys are not JSON");
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid(path, "accessors and non-enumerable properties are not JSON");
        if (descriptor.value === undefined) continue;
        if (count++) charge(1);
        charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
        Object.defineProperty(copy, key, { value: walk(descriptor.value, depth + 1, `${path}.${key}`), enumerable: true, writable: true, configurable: true });
      }
      return Object.freeze(copy);
    } finally { ancestors.delete(input); }
  };
  return walk(value, 0, "$");
}

export function canonicalToolValue(returned) {
  if (returned === undefined) throw new ToolOutputContractError("TOOL_OUTPUT_INVALID", "Tool body returned undefined instead of a JSON result");
  if (typeof returned === "string") return { ok: true, content: returned };
  if (returned === null || typeof returned !== "object" || Array.isArray(returned)) return { ok: true, value: returned };
  return returned;
}

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "allOf", "not", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties"]);

// Unsupported validation keywords fail at registration rather than silently
// accepting outputs that were never checked against the declared contract.
export function prepareOutputSchema(candidate) {
  if (candidate === undefined) return undefined;
  let schema;
  try { schema = snapshotToolJson(candidate, { maxBytes: 256 * 1024, label: "outputSchema" }); }
  catch (error) { throw new ToolOutputContractError("TOOL_OUTPUT_SCHEMA_UNSUPPORTED", error.message); }
  const reject = (path, reason) => { throw new ToolOutputContractError("TOOL_OUTPUT_SCHEMA_UNSUPPORTED", `outputSchema ${path}: ${reason}`); };
  const visit = (node, path) => {
    if (typeof node === "boolean") return;
    if (!node || typeof node !== "object" || Array.isArray(node)) reject(path, "must be an object or boolean schema");
    for (const [key, value] of Object.entries(node)) {
      if (ANNOTATIONS.has(key)) continue;
      if (!KEYWORDS.has(key)) reject(path, "unsupported keyword " + key);
      if (key === "type" && !(typeof value === "string" ? TYPES.has(value) : Array.isArray(value) && value.length && value.every((item) => TYPES.has(item)))) reject(path, "invalid type");
      if (key === "properties") {
        if (!value || typeof value !== "object" || Array.isArray(value)) reject(path, "properties must be an object");
        for (const [name, child] of Object.entries(value)) visit(child, `${path}.properties.${name}`);
      }
      if (["items", "additionalProperties", "not"].includes(key)) visit(value, `${path}.${key}`);
      if (["anyOf", "oneOf", "allOf"].includes(key)) {
        if (!Array.isArray(value) || !value.length) reject(path, key + " must be a nonempty schema array");
        value.forEach((child, index) => visit(child, `${path}.${key}[${index}]`));
      }
      if (key === "required" && (!Array.isArray(value) || value.some((item) => typeof item !== "string") || new Set(value).size !== value.length)) reject(path, "required must contain unique string names");
      if (key === "enum" && (!Array.isArray(value) || !value.length)) reject(path, "enum must be a nonempty JSON array");
      if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].includes(key) && (typeof value !== "number" || key === "multipleOf" && value <= 0)) reject(path, "invalid numeric constraint " + key);
      if (/^(?:min|max)(?:Length|Items|Properties)$/.test(key) && (!Number.isSafeInteger(value) || value < 0)) reject(path, "invalid size constraint " + key);
      if (key === "uniqueItems" && typeof value !== "boolean") reject(path, "uniqueItems must be boolean");
      if (key === "pattern") {
        if (typeof value !== "string") reject(path, "pattern must be a string");
        try { new RegExp(value, "u"); } catch { reject(path, "invalid pattern"); }
      }
    }
  };
  visit(schema, "$");
  return schema;
}

const equalJson = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalJson(a[key], b[key]));
};
const jsonKey = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value)
  ? "[" + value.map(jsonKey).join(",") + "]"
  : "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + jsonKey(value[key])).join(",") + "}";

export function outputSchemaErrors(value, schema, path = "value") {
  if (schema === undefined || schema === true) return [];
  if (schema === false) return [path + " is forbidden by outputSchema"];
  const errors = [];
  const add = (message) => { if (errors.length < 40) errors.push(path + " " + message); };
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const matchesType = (expected) => expected === type || expected === "integer" && Number.isInteger(value);
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matchesType)) return [path + " must be " + JSON.stringify(schema.type)];
  if (schema.enum && !schema.enum.some((candidate) => equalJson(value, candidate))) add("is not an enum value");
  if (Object.hasOwn(schema, "const") && !equalJson(value, schema.const)) add("does not match const");
  if (schema.anyOf && !schema.anyOf.some((branch) => outputSchemaErrors(value, branch, path).length === 0)) add("does not match anyOf");
  if (schema.oneOf && schema.oneOf.filter((branch) => outputSchemaErrors(value, branch, path).length === 0).length !== 1) add("must match exactly one oneOf branch");
  if (schema.allOf && schema.allOf.some((branch) => outputSchemaErrors(value, branch, path).length)) add("does not match allOf");
  if (schema.not !== undefined && outputSchemaErrors(value, schema.not, path).length === 0) add("matches a forbidden schema");
  if (type === "object") {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) add("requires " + key);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...outputSchemaErrors(child, schema.properties[key], path + "." + key));
      else if (schema.additionalProperties === false) add("has an unsupported property " + key);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errors.push(...outputSchemaErrors(child, schema.additionalProperties, path + "." + key));
      if (errors.length >= 40) break;
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) add("has too few properties");
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) add("has too many properties");
  }
  if (type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) add("has too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add("has too many items");
    if (schema.items !== undefined) for (let index = 0; index < value.length && errors.length < 40; index++) errors.push(...outputSchemaErrors(value[index], schema.items, `${path}[${index}]`));
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const key = jsonKey(item);
        if (seen.has(key)) { add("has duplicate items"); break; }
        seen.add(key);
      }
    }
  }
  if (type === "string") {
    let length = 0;
    if (schema.minLength !== undefined || schema.maxLength !== undefined) for (const character of value) { void character; length++; }
    if (schema.minLength !== undefined && length < schema.minLength) add("is shorter than minLength");
    if (schema.maxLength !== undefined && length > schema.maxLength) add("is longer than maxLength");
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) add("does not match pattern");
  }
  if (type === "number") {
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) add("is outside its numeric bounds");
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) add("is not a multipleOf value");
  }
  return errors.slice(0, 40);
}
