// Deterministic record/replay for the model client. Wrap a real client to capture every
// request/response pair to a fixture, or replay a fixture with no network so the full agent
// loop can be exercised deterministically in tests and regression runs.

import { createHash } from "node:crypto";

export function requestFingerprint(request) {
  const shape = {
    model: request?.model,
    messages: (request?.messages ?? []).map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      tool_call_id: message.tool_call_id,
    })),
    tool_choice: request?.tool_choice,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

export function createRecordingClient(client, fixture = []) {
  return {
    ...client,
    async chatCompletion(request, options) {
      const response = await client.chatCompletion(request, options);
      fixture.push({ fingerprint: requestFingerprint(request), response });
      return response;
    },
    async chatCompletionStream(request, handlers) {
      const response = await client.chatCompletionStream(request, handlers);
      fixture.push({ fingerprint: requestFingerprint(request), response });
      return response;
    },
    fixture,
  };
}

export function createReplayClient(fixture = [], { strict = true } = {}) {
  const byFingerprint = new Map();
  const queue = [...fixture];
  for (const entry of fixture) {
    if (entry?.fingerprint && !byFingerprint.has(entry.fingerprint)) byFingerprint.set(entry.fingerprint, entry.response);
  }

  const resolve = (request) => {
    const fingerprint = requestFingerprint(request);
    if (byFingerprint.has(fingerprint)) return byFingerprint.get(fingerprint);
    if (queue.length) return queue.shift().response;
    if (strict) throw new Error("No replay fixture for request " + fingerprint);
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
