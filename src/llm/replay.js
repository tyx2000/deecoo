// Deterministic record/replay for the model client. Wrap a real client to capture every
// request/response pair to a fixture, or replay a fixture with no network so the full agent
// loop can be exercised deterministically in tests and regression runs.

import { createHash } from "node:crypto";
import { createReplayEntries } from "../harness/replayEntries.js";

export const REPLAY_FINGERPRINT_VERSION = 2;

// Hash the complete JSON request body, including tool definitions, assistant tool
// calls and sampling parameters. Sorting object keys avoids serialization-order
// differences; arrays retain their semantic order. The prefix makes old fixtures
// fail explicitly rather than silently matching an incomplete v1 request shape.
export function requestFingerprint(request) {
  const shape = { version: REPLAY_FINGERPRINT_VERSION, request: canonicalJson(request ?? {}) };
  return "v2:" + createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

// Migration requires the original request. A v1 hash alone cannot recover fields
// that were omitted from it, so callers must re-record such fixtures.
export function migrateReplayFixture(fixture) {
  return fixture.map((entry) => {
    if (!entry.request) throw new Error("Replay fixture migration requires each original request; re-record this fixture.");
    return { ...entry, fingerprintVersion: REPLAY_FINGERPRINT_VERSION, fingerprint: requestFingerprint(entry.request) };
  });
}

export function createRecordingClient(client, fixture = []) {
  return {
    ...client,
    async chatCompletion(request, options) {
      const recorded = canonicalJson(request);
      const response = await client.chatCompletion(request, options);
      fixture.push({ fingerprintVersion: REPLAY_FINGERPRINT_VERSION, fingerprint: requestFingerprint(recorded), request: recorded, response });
      return response;
    },
    async chatCompletionStream(request, handlers) {
      const recorded = canonicalJson(request);
      const response = await client.chatCompletionStream(request, handlers);
      fixture.push({ fingerprintVersion: REPLAY_FINGERPRINT_VERSION, fingerprint: requestFingerprint(recorded), request: recorded, response });
      return response;
    },
    fixture,
  };
}

export function createReplayClient(fixture = [], { strict = true } = {}) {
  const entries = createReplayEntries(fixture, "fingerprint");

  const resolve = (request) => {
    const fingerprint = requestFingerprint(request);
    const match = entries.take(fingerprint, { fallback: !strict });
    if (match) return match.response;
    if (strict) throw new Error("No replay fixture for request " + fingerprint + "; v1 fixtures require migration with original requests or re-recording.");
    return { choices: [{ message: { role: "assistant", content: "" } }] };
  };

  return {
    async chatCompletion(request) {
      return resolve(request);
    },
    async chatCompletionStream(request, handlers = {}) {
      const response = resolve(request);
      const content = response?.choices?.[0]?.message?.content;
      if (content && handlers.onContent) handlers.onContent(content);
      return response;
    },
    async listModels() {
      return { data: [] };
    },
  };
}
