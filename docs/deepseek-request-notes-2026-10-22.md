# DSH-REF-003: route-bound model requests

Implemented on 2026-10-22 without executing reference code or calling a paid provider. This is a small adaptation of the request preparation boundary; it does not add a provider registry, hot reload, remote capability discovery, or external agents.

## Reference and adopted behavior

Reference commit: `deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317` (MIT).

- [PreparedLlmCall contract, lines 168–199](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L168-L199): resolved config and adapter generation belong to one call.
- [prepareCall implementation, lines 956–1013](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956-L1013): resolve metadata and defaults once, freeze detached snapshots, dispatch once through the captured registration. Deecoo captures the current outer client receiver and its methods, so spread-based rate and budget wrappers remain in the actual dispatch path.
- [Loop preparation and freezing, lines 600–612 and 676–705](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L600-L612), [request boundary rationale](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/README.md#L91-L95): use the prepared route for admission and keep cancellation live outside frozen data. Deecoo uses detached JSON requests and an out-of-band linked AbortSignal.

The implementation is original Deecoo code; no reference source was copied.

## Public contract

`createModelClient(config)` now exposes a synchronous method:

```js
const prepared = client.prepareRequest(request, { signal });
// Frozen: request, effectiveConfig, capabilities, routeIdentity,
// requestFingerprint. dispatch is single-use, including failed attempts.
await prepared.dispatch({ stream: false, signal, onContent, onRuntimeEvent });
```

The method must be called on the client that will dispatch, after budget/limiter wrapping. It deliberately captures `this.chatCompletion` / `this.chatCompletionStream`, not bound raw-provider methods. Both stream and nonstream dispatch therefore retain admission, usage accounting and budget cancellation. The request snapshot is independent of later caller message/schema/config mutations. Non-JSON values, conflicting output limits, invalid limits and explicitly unsupported controls fail before provider invocation.

`effectiveConfig.maxTokens` and `effectiveMaxTokens` report the actual internal output cap used by dispatch. `requestedMaxTokens` retains the requested value; `sources.maxTokens` identifies request/config/default/route-limit provenance. The selected adapter still translates the frozen internal request to its wire protocol (for example OpenAI `max_completion_tokens` and Anthropic messages). No provider adapter was changed for this work.

## Capability facts and defaults

Remote model feature support is `true`, `false`, or `"unknown"`; a provider name alone never declares every remote model supported. `capabilities.adapter` separately describes observed local adapter transport support; unrecognized adapters retain unknown transport flags and unspecified protocol. Current OpenAI conversion drops thinking, and current Anthropic conversion fixes thinking disabled and omits reasoning effort, so those enabled controls are explicitly rejected. Metadata cannot claim that an adapter can transmit fields which it currently discards.

Unknown remote reasoning/thinking retain compatibility pass-through where the adapter can carry them, with `unknown-compatible-pass-through` provenance. Explicit `false` for tools, streaming, reasoning or thinking is enforced before dispatch. Unknown support is not a claim that a remote endpoint accepts a field.

Precedence is configured `capabilityOverrides` (or legacy `capabilities`), then route-matching `modelMetadata`, then unknown/fallback. Metadata can be a direct record, keyed by model, or under `models[model]`; optional provider/model/protocol/baseUrl assertions must match the selected route. Supported fields include feature booleans, `contextWindow`, `minOutputTokens`, `maxOutputTokens` (metadata alias `maxTokens`) and `reasoningEffortValues`. Direct config `contextWindow`, `minOutputTokens` and `maxOutputTokens` take precedence. Example:

```js
{
  provider: "openai", model: "private-model", baseUrl: "https://model.example/v1",
  maxTokens: 4096,
  modelMetadata: { models: { "private-model": {
    contextWindow: 16384, minOutputTokens: 1, maxOutputTokens: 1024,
    capabilities: { toolCalling: true, streaming: false, reasoningEffort: false }
  } } }
}
```

The historical output default remains 4096, labeled `adapter-compatible-default`. An unknown context window uses 32768 with `conservative-fallback`, rather than asserting provider-wide 128000 support. This is an admission fallback, not a verified model capacity; smaller deployments should configure exact metadata. Output is capped by declared maximum and window minus one; context admission must additionally reserve instructions, tool schemas, framing and safety space using the effective cap.

## Route identity and resume policy

`routeIdentity` contains only provider, protocol, model, an endpoint SHA-256 digest, tool-schema SHA-256 digest, version and combined digest. Endpoints are normalized, with URL username/password, fragment and standard credential query keys removed before hashing. Noncredential query parameters such as deployment and api-version participate in the digest, so query-selected routes cannot silently change. Query values and raw URLs are never emitted by this identity API. Credential rotation does not alter the identity for recognized credential fields. Tool object-key ordering is canonical; schema contents and array order remain significant.

`checkpointIdentity({ cwd, model, tools, taskSpec, config, client })` produces `identityVersion: 2` whenever config/client is supplied. Storage metadata remains version 1 for the existing envelope. Route-aware validation rejects changed provider/protocol/model/endpoint/schema with `CHECKPOINT_ROUTE_IDENTITY_CHANGED`, including the same model name on another endpoint.

Existing checkpoints without route identity are rejected by route-aware callers with `CHECKPOINT_ROUTE_IDENTITY_MISSING`; users start a new task to establish a verifiable identity. No metadata is invented during migration. Route-aware saved checkpoints also reject legacy validation (`CHECKPOINT_ROUTE_IDENTITY_REQUIRED`). Existing embedding/helper callers omitting both config and client retain legacy four-field validation, which cannot attest to endpoint identity. The CLI/task runner uses the new route-aware path.

## Verification and integration status

- `test/requestPreparation.test.js`: 12 offline contracts cover unknown capabilities/provenance, metadata caps, immutability, unsupported preflight, compatibility defaults, one-shot dispatch, stream/nonstream shared budget and limiter enforcement, live cancellation, secret-free route identity, query route changes, tool-schema changes and explicit checkpoint legacy handling. Actual runtime schemas additionally prove that local rendering hooks and policy-hidden writers do not alter identity, while a newly advertised reader does.
- New contracts plus existing provider tests: 25/25 passed. `npm run check` passed; any subsequent refinement is checked again before handoff.
- One complete suite, launched during live multi-worker integration, returned 415 passed / 2 failed / 1 skipped (418 total). Failures: tiny-context error classification in `harnessExtensionContracts`, and the expected research tool list after adding output retrieval tools. These were sent to the integration owner; they do not establish final integration status. No duplicate complete suite was launched.
- Root owns taskRunner/loop event, context and checkpoint wiring. This worker reviews that integration independently after the module contract is complete; final full-suite and offline Eval results belong to the root handoff.

Independent root integration probe (`/private/tmp/deecoo-prepared-integration-review.mjs`, offline): a two-call task completed with both wire output caps reduced from 400 to 128, two prepared events and shared measured usage 4; route identity contained no synthetic basic-auth/query/API secrets. Cancellation during dispatch returned interrupted after one provider invocation. A 1KB output projection retained an immediately readable 128-byte output page under its original reference (706-byte projection). One compatibility issue was reported to the root owner: rateLimitClient advertised a stream method for clients implementing only chatCompletion, so stream-enabled fallback selected a nonexistent underlying method. Root fixed conditional stream advertisement; the original probe then completed with exactly one nonstream invocation.

Independent resume probe (`/private/tmp/deecoo-prepared-resume-review.mjs`, offline): a fresh runtime resumed successfully with changed local render functions and an additional policy-hidden writer. A newly visible reader failed before invocation with `CHECKPOINT_ROUTE_IDENTITY_CHANGED`; analysis-to-edit mode change failed on changed mayWrite. The probe also found that taskRunner's initial preparation ran before policy filtering, so final result/run-start route metadata had a different tool-schema hash from the actual checkpoint/loop request.

Root explicitly extended this worker's ownership to repair that ordering. Task contract derivation and task-policy application now precede planning preparation in taskRunner; context budget calculation, route-aware checkpoint validation, budget/limiter creation and actual dispatch retain their relative order. The original resume probe now reports identical checkpoint/result schema digests. New `test/requestRouteIntegration.test.js` checks run-start, every actual prepared request, wire tool declarations, checkpoint and completed result identity across fresh-runtime resume; local render changes and hidden writers remain compatible, visible tool additions and write-contract changes fail before another provider invocation. The integration group (`requestRouteIntegration`, `requestPreparation`, `deepseekIntegration`, `checkpointIntegration`, `harnessExtensionContracts`) passed 36/36. The original budget/cancellation/output probe also still passed after the ordering change. No full suite was repeated for this repair.

Limitations: metadata is operator-supplied rather than remotely verified; token estimation is conservative UTF-8 bytes rather than an exact tokenizer; one already admitted call can exceed a task usage limit by its measured completion; no automatic route hot swap or legacy checkpoint upgrade is attempted.
