# Evaluation modes

`npm run eval -- --no-report` runs the existing **trace grader**. It scores an audit or a hand-authored trace fixture, including exact tool/classification expectations used to test specific branches. It does not execute the task and its score is not evidence that code works.

`npm run eval:e2e -- --trials 3 --no-report` executes the trusted scenarios in `eval/tasks`. Each trial creates a fresh temporary project, runs its `task` through the real `runTask`, agent/worker loop, permission runtime, file tools and shell, then independently grades the resulting files. Any failed case returns exit code 1. `--case add-patch`, `--cases-dir`, `--json` and `--keep-workspaces` are supported. The latter retains projects for inspection and reports their absolute paths; normal runs remove them.

The bundled offline provider emits deterministic model protocol turns. The three scenarios repair the same real bug through `edit_file`, `apply_patch` and an implementation Worker. They test harness integration, not model capability. They make no API requests. A versioned replay fixture is also supported via `execution.replay`; strict matching is the default. For a separately configured provider, import `executeEvalCase` / `executeEvalSuite` from `execution.js` and pass `clientFactory({caseDefinition, workspace, trial, config})`. The caller supplies credentials and explicitly chooses any paid provider; the CLI never creates one implicitly.

## Trusted case contract

Each case defines `id`, `task` and `execution`:

- `files`: initial project files, with relative paths and string contents.
- `allowedChanges`: exact paths or directory prefixes ending in `/`; `[]` requires no project file changes.
- `scripted`: `main` and optional `worker` arrays. Turns contain `{tool, arguments}`, `{tools: [...]}`, `{text}` or a provider-shaped `{response}`. Exhaustion is an execution failure.
- `checks.files`: final file assertions using `path` and `exists`, `equals`, `contains` or `absent`. Symlinks in any component are rejected.
- `checks.unchanged`: exact paths or directory prefixes whose independently sampled hashes/modes must remain unchanged.
- `checks.commands`: immutable verifier code, e.g. `{command: "node", args: ["--input-type=module", "-e", "import assert from 'node:assert/strict'; import {add} from './src/add.js'; assert.equal(add(-2, 3), 1)"]}`. These run using the absolute host Node executable, a minimal environment, bounded output and a timeout. Mutable project executables/test scripts cannot serve as independent verifiers. A verifier may import the implementation being assessed; its assertions stay outside the project in the trusted case definition.
- `config`: fixed model/run settings shared by all trials. `quiet` and non-streaming mode are enforced. Host Node test/npm option variables are removed during task execution so nested tests cannot silently skip.

The result requires a completed harness workflow and all independent checks to pass. Final prose, tool names and request classification do not establish the outcome. Hash snapshots are sampled before and after execution, before graders run, and included in JSON reports. The harness-generated `.deecoo/PROJECT.md` regular file and its `.deecoo/` directory container are instrumentation exclusions; other files, symlinks, empty directories and modes are checked. Snapshots limit entry count, total file bytes and depth. File differences describe persistent project state, not transient or out-of-workspace side effects.

These are authored, trusted local scenarios. Temporary projects isolate normal file edits from the checkout; they are **not an OS sandbox** for untrusted shell programs, packages, verifiers or provider adapters. Running adversarial model code requires a separate process/container execution backend. Do not load untrusted scenario JSON as executable verification code.

Reports distinguish case pass rate from trial success rate. They include model/configuration, real counted provider usage, total duration and nearest-rank p50/p95 trial duration (setup, execution, grading and cleanup). Scripted usage is synthetic provider metadata, not a model performance estimate. `costUsd` is `null` when model pricing is unknown; offline trials explicitly report `actualSpendUsd: 0`. No statistically meaningful model-quality claim follows from repeating a deterministic script.

## Replay fingerprints

Replay fingerprint version 2 hashes the complete JSON request, with sorted object keys and preserved array order. This covers assistant `tool_calls`, tool schemas, tool choice and sampling/token settings. Keys are prefixed `v2:`; strict replay never silently falls back to legacy hashes. Recording saves an immutable request snapshot and `fingerprintVersion: 2` alongside each response.

For older fixtures that retain their original full request, use `migrateReplayFixture(fixture)` from `src/llm/replay.js`. A legacy hash alone cannot reconstruct omitted fields: re-record those fixtures. Non-strict positional fallback remains an explicit compatibility option and preserves single-consumption behavior. Strict replay requests containing temporary workspace paths require fixtures authored for those paths or a configured adapter; the scripted provider avoids that issue for the bundled harness regressions.

## Required task checks and expanded regressions

The offline suite now includes cross-file behavior, Python called from JavaScript, review with a real finding and a clean review, conditional no-change, the wrong requested command, an omitted required check, missing dependencies, denied edits, visible-test tampering, pre-existing test failure, and interruption followed by real checkpoint resume. Run all cases with `npm run eval:e2e -- --no-report`. These are deterministic harness regressions; they do not measure model capability.

`execution.expectedRun` can assert the actual run `status`, `stoppedReason`, `verificationStatus`, `completionType`, a validation error substring, and independent review finding expectations. Rejection cases explicitly expect failure instead of rewarding success prose. `expectedCheckFailures` lists exact independent grader checks that must reject an authored cheating attempt. Such checks retain `observedPassed: false` and `expectedPassed: false`; `trial.taskPassed` remains false even when the rejection regression passes. Unexpected failures still fail the regression. `execution.resumeScripted` starts a second provider script using the first run's real saved checkpoint and verifies interrupted status, checkpoint use, and final completion.

Execution logs and session data live outside the candidate workspace. This preserves strict change-scope checks without hiding arbitrary files under a blanket `.deecoo/` exclusion. The execution backend uses `sandboxPolicy.mode: off` for trusted offline cases; independent graders and authored fixture commands are trusted code. Real provider benchmarks default to required OS containment and network denial, and fail closed when the sandbox is unavailable. `--sandbox off` or `--sandbox-network allow` separately opts into a less restrictive benchmark environment; `--allow-paid` alone never disables containment. Immutable graders remain trusted host code, so scenario definitions and adapters must be trusted.

## Explicit provider benchmark

`node eval/benchmark.js` never enables paid execution by default. A zero-request contract run is:

```sh
node eval/benchmark.js --offline --case cross-file-feature \
  --max-calls 30 --token-budget 500000 --cost-budget-usd 1 \
  --max-tokens 2048 --timeout-ms 30000
```

A real run requires `--allow-paid`, an explicit task-outcome `--case`, provider, exact model, HTTPS base URL, positive input/output prices, and every budget. For example, with the relevant provider credential already present:

```sh
node eval/benchmark.js --allow-paid --provider openai \
  --base-url https://api.openai.com/v1 --model MODEL_ID \
  --case cross-file-feature --trials 3 \
  --max-calls 30 --token-budget 500000 --cost-budget-usd 1 \
  --max-tokens 2048 --timeout-ms 120000 \
  --price-prompt-per-m INPUT_USD --price-completion-per-m OUTPUT_USD \
  --output /tmp/deecoo-provider-benchmark.json
```

Prices must conservatively cover the selected model and provider's token billing. The global client serializes calls, disables retries, reserves UTF-8 request bytes plus 4096 protocol tokens and the full output cap before dispatch, and refuses a request that cannot fit the remaining call/token/estimated-cost budget. Missing usage or a failed request stops further requests and reports cost as unknown. A provider that exceeds its declared token reservation is reported and stops subsequent calls; local admission is not a provider billing guarantee. The runner never writes `eval/reports` automatically.

JSON reports include every trial's independent outcome, success rate, measured cost and cost per successful task, actual spend of zero in offline mode, manual interventions (zero in this automatic approval workflow), separate automatic approval requests, latency, and failure categories. Attribution records the Git revision, SHA-256 of all relevant local source and prompt files (including uncommitted content), exact dataset and configuration hashes, runtime, platform, and architecture. Credentials never enter the report. Rejection and scripted recovery cases are excluded from real model benchmarks because they do not measure the same task outcome.

`.github/workflows/harness-ci.yml` runs syntax checks, unit/contracts and offline E2E on pushes and pull requests. `.github/workflows/provider-benchmark.yml` has only `workflow_dispatch`; it requires explicit model/pricing/budget inputs and an `OPENAI_API_KEY` secret in the `provider-benchmark` environment. There is no paid call on push or pull request. No real provider was invoked while implementing these contracts.
