// Keep the source spelling of numbers that the model did not replace. Parsing
// through JS Number would round large integers (and normalize -0/exponents)
// before an unrelated JSON-pointer operation could even see them.
const JSON_TOKEN = /"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

class PreservedNumber {
  constructor(source) { this.source = source; }
}

export const isPreservedJsonNumber = (value) => value instanceof PreservedNumber;

export function parseLosslessJson(source) {
  // Validate before token replacement: otherwise an invalid numeric object key
  // such as {1:2} could become a valid quoted key in the intermediate text.
  JSON.parse(source);
  const strings = [...source.matchAll(JSON_TOKEN)].filter(([token]) => token.startsWith('"')).map(([token]) => JSON.parse(token));
  let prefix = "__deecoo_json_number_";
  while (strings.some((value) => value.includes(prefix))) prefix += "_";
  const numbers = new Map();
  const encoded = source.replace(JSON_TOKEN, (token) => {
    if (token.startsWith('"')) return token;
    const key = prefix + numbers.size;
    numbers.set(key, token);
    return JSON.stringify(key);
  });
  return JSON.parse(encoded, (_key, value) => typeof value === "string" && numbers.has(value) ? new PreservedNumber(numbers.get(value)) : value);
}

export function stringifyLosslessJson(value) {
  // Choose markers absent from every existing string/key, including values in
  // new operations. Only our internal number objects can introduce them.
  const plain = JSON.stringify(value);
  let prefix = "__deecoo_raw_number_";
  while (plain.includes(prefix)) prefix += "_";
  const numbers = new Map();
  const encoded = JSON.stringify(value, (_key, current) => {
    if (!isPreservedJsonNumber(current)) return current;
    const key = prefix + numbers.size;
    numbers.set(key, current.source);
    return key;
  }, 2);
  return encoded.replace(/"(?:\\[\s\S]|[^"\\])*"/g, (token) => numbers.get(JSON.parse(token)) ?? token);
}
