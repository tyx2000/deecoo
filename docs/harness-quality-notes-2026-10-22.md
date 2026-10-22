# NEXT-002 / NEXT-006 implementation notes

Updated 2026-10-22. Owned changes: taskSpec/taskIntent/finalValidation, acceptance.js, verification, eval (excluding reports), new CI and focused tests. Existing user and parallel worker edits remain. No paid provider API was called.

## Task acceptance contract

`buildTaskSpec({task, cwd, coordination, activeSkills, mode, acceptance, requiredChecks})` emits schema v2 with `acceptance` and `requiredChecks`. Explicit arrays override command inference. Each check has stable `id`, `purpose`, `target`, `scope`, `required`, and `executionPaths:[{command,scope?}]`. CLI-equivalent npm test/run test forms share canonical identity. Matching preserves quoted whitespace, rejects shell chains and metadata/collection-only flags, does not equate built-in npm install with a project install script, and respects the execution scope. Project test/check candidates become required for ordinary implementation verification when there is no explicit override. Concrete user checks retain priority.

`evaluateTaskAcceptance({taskSpec,verificationPlan,verification,agentState,effects,completionType})` returns `{completionType,workResult,requestedCompletionType,status,satisfied,checks,requirements,sourceEvidence,errors}`. Completion types are modified/no-change/partial/blocked; `workResult` retains whether edits happened when required evidence makes the outcome partial or blocked. Every required target needs a fresh successful execution. Missing and failed requirements cannot be overridden by final prose. Actual failures retain baseline/pre-existing/introduced-or-unclassified attribution. Re-running an equivalent command can resolve the same target; another command cannot erase its failure.

Workspace revisions and validation revisions are separate: known verification commands share a validation revision, so test followed by check can satisfy both. File changes, uncertain writes, arbitrary commands, and resume invalidate previous checks. No-change on a conditional fix requires fresh complete source inspection and executed checks or a nonempty explicit file-content assertion. Partial/range/truncated reads do not prove complete source. An explicit noChangeRequiresSourceEvidence=false cannot disable this requirement for code-change tasks.

The root integrates `config.taskAcceptance` / `config.requiredChecks`, retains final-validator `.acceptance` in task results and audit, and emits raw source evidence only from the actual tool boundary. Models and Worker summary text cannot construct check success evidence. Runtime command effects carry cwd/scope and source reads carry complete-source/hash metadata.

## Evaluation and CI

15 authored offline cases now cover the original 3 tool paths plus cross-file behavior, Python called through JavaScript, true and clean reviews, justified no-change, wrong/omitted commands, dependency failure, permission denial, test tampering, existing failure, and actual interrupted checkpoint resume. Graders independently inspect final workspace hashes and run immutable assertions held outside the candidate workspace. Execution logs and recovery sessions are outside the candidate; no broad instrumentation exclusion was added.

Rejection cases assert expected real failed status; expectedCheckFailures identifies exact independent graders that must reject a scripted cheat. Reports retain observedPassed and taskPassed so a passing safety regression is not reported as a successful programming task.

`eval/benchmark.js` requires an explicit `--allow-paid` for a real provider, selected case, exact model/base URL, positive input/output prices, call/token/USD limits, output cap and timeout. Paid requests are serial, have no automatic retries, and reserve a conservative input bound plus capped output before admission. Missing usage or failed requests stop subsequent calls and mark spend unknown. Offline mode uses zero API requests; provider mode contract tests inject a local fake client. Attribution records Git revision, all src/prompt content hashes (including local edits), dataset/config hashes, Node/platform/arch, success rate, cost per successful task, manual versus automated approvals, latency, and failure category. Provider price correctness and an API's adherence to token reservations remain external assumptions, explicitly reported.

CI runs npm ci, npm run check, npm test and the 15-case offline E2E on push/pull request for Node 20/22. Real benchmark CI has only workflow_dispatch with explicit model/price/budget inputs and an environment secret. No paid evaluation runs automatically.

## Reference adoption and exact sources

These references were inspected as text; no reference repository code was executed or copied wholesale.

- pi commit `bd3c9b823762b7383954aa49e13ee350471015fe`: [agent-loop.ts, finalized tool outcome and toolResult construction](https://github.com/badlogic/pi-mono/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/agent/src/agent-loop.ts#L929-L953), and [finishTurn after actual tool results](https://github.com/badlogic/pi-mono/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/agent/src/agent-loop.ts#L274-L300). Adopted principle: completion decisions consume executor observations with tool identity/error status, after actual effects; assistant summaries are not tool evidence.
- Codex commit `a3b685331fc700bec554b2fe2a929a65f4fe1548`: [typed tool runtime contract](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/core/src/tools/registry.rs#L55-L120), and [durable terminal results and thread-scoped revisions](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/app-server/README.md#L35-L55). Adopted principle: identity, terminal tool outcome, and scoped revision are explicit data; a terminal assistant message alone cannot certify execution or freshness. These files do not claim to implement Deecoo acceptance semantics.
- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents), published 2026-01-09, fetched 2026-10-22. Adopted task/trial/grader/final-outcome distinction, immutable independent outcome assertions, separate deterministic regressions from provider capability benchmarking, and reproducible configuration/cost attribution. Repeating a scripted case is not a model-quality estimate.

## Verification and handoff

- New acceptance contracts: 10/10 passed, including natural-language targets, explicit equivalence recovery, stale/reused ID protection and uncertain mutation outcomes.
- Existing harness E2E plus new diversity and provider contract tests: 23/23 passed. Separate 15-case CLI E2E: 15/15 passed (`/private/tmp/deecoo-quality-e2e-verified.json`, not a tracked report).
- npm run check passed at that point.
- Whole-tree npm test during parallel work: 350 tests; 344 passed, 5 failed, 1 skipped. One E2E failure was fixed by explicitly removing host NODE_TEST_CONTEXT/npm option variables before constructing the injected backend; focused existing/new E2E then passed. Remaining root integration failures were reported: Git schema path, expanded research-tool list expectations, raw Worker shell verification, and always-all shell approval. Root owns their fixes and final whole-tree verification.
- CLI machine/management additions are complete in src/cli.js, cli/args.js, cli/management.js and config/env.js. Eight actual CLI tests cover no-key management, noninteractive/JSON/JSONL output, redaction, explicit acceptance, local job ownership/output, Memory, storage dry-run and dirty-baseline undo. Two additional CLI signal tests launch real TERM-ignoring descendants, deliver SIGINT/SIGTERM, assert exit 130/143 and prove the marker stops changing before CLI exit. SIGINT/SIGTERM listeners are removed after each run. No eval/reports files were edited.

## Final integration review and latest verification

Selected review target: taskRunner/loop/runtime-context/checkpoint integration at working-tree HEAD `50e809d8a286662d42e8d462b2c9772d9f2dd30d`, including substantial uncommitted parallel changes. Node v24.21.0, macOS, npm/ESM. S-COR was used for this selective independent review; source, focused synthetic reproduction and nearby callers were checked. Execution backend/platform enforcement and all other worker-owned modules were not re-audited exhaustively.

### INTREVIEW-001 — Review finalization bypassed required checks

- severity: P2
- status: fixed
- issue_evidence: confirmed; the original synthetic review read source and returned schema-valid clean findings with no npm test execution, yet completed.
- lane: code
- scope: current-diff
- affected_files: src/agent/taskRunner.js finalValidator selection; src/agent/loop.js failure snapshot; harness acceptance projection.
- failure_scenario: request Review src/value.js and run npm test; review-only validator certified report shape/source coverage without consuming requiredChecks. A repair followed by provider interruption also dropped the last calculated acceptance from the error snapshot.
- impact: a clean review could be presented as complete despite an unexecuted explicit check; failed results lost useful partial acceptance data.
- reliable_solution: root composed task acceptance and review validation, and retained acceptance in checkpoint/error/result serialization.
- solution_fit: suited=yes (existing validator interfaces); executable=yes; affordable=yes; cost=low/medium; verification=source read plus clean report without requested command must fail with acceptance partial/check missing.
- verification_result: passed; original `/private/tmp/deecoo-root-integration-review.mjs` rerun returned status failed, acceptance.satisfied=false, completionType=partial, and the missing required check.
- post_cor_candidate: implemented by root and independently rechecked.
- suggested_tests: covered by root harnessExtensionContracts review-check regression and the original reproduction.

### INTREVIEW-002 — Private in-memory change baseline was recreated on resume

- severity: P2
- status: fixed
- issue_evidence: confirmed; redacted task edited a synthetic file, interrupted and checkpointed; resuming with the same tools/store failed Missing or incompatible change set.
- lane: errors
- scope: current-diff
- affected_files: src/agent/taskRunner.js changeSet creation/resume; src/workspace/changes.js exclusion-root canonicalization.
- failure_scenario: checkpoint retained changeSetId while persist=false kept baseline in the prior object only; the new run constructed a fresh empty object and inspected it. A /var versus /private/var alias also prevented storage-root exclusion and polluted sampled changes.
- impact: same-process private task recovery failed; storage instrumentation could be misreported as task changes.
- reliable_solution: root reuses matching tools.getChangeSet in memory; unavailable private baselines report CHANGE_BASELINE_UNAVAILABLE while preserving edits; canonical root exclusions prevent storage instrumentation from entering the baseline.
- solution_fit: suited=yes (runtime already owns changeSet); executable=yes; affordable=yes; cost=low/medium; verification=interrupt/resume same tools and original dirty baseline, then undo must restore that baseline.
- verification_result: passed; the same original reproduction now resumes with status completed and no baseline error. Root added the full dirty-baseline/undo integration assertion.
- post_cor_candidate: implemented by root and independently rechecked.
- suggested_tests: same-process private resume, explicit cross-process unavailable-baseline result, and path aliases.

Independent execution-worker review also identified EXECREVIEW-001 (provider benchmarks inherited offline sandbox-off execution) and EXECREVIEW-002 (budget wrappers had separate request queues). Both were fixed in this worker's owned code: real benchmarks default to sandbox required/network deny unless separately overridden; all wrappers share one ledger queue. Seven provider contract tests pass, including cross-wrapper admission that sends only one of two over-budget concurrent requests. All provider calls in tests are local fakes; no paid API was invoked.

Latest complete CLI offline E2E run: 15/15 cases passed after external changeStateDir integration, with no broadened snapshot exclusion (`/private/tmp/deecoo-quality-final-e2e.json`). npm run check passed. A concurrent whole-tree run had 386 tests, 383 pass, 2 fail, 1 skip; its only failures were root's newly added INTREVIEW regressions while those fixes were still being edited. Both original reproductions were independently rechecked after the root fixes. Root owns the final whole-tree checks after that point; this worker stopped product-code edits as requested.

README now documents machine and local-management commands, all eight requested capability groups, explicit acceptance, sandbox defaults/degradation, backward-compatible configuration, private job-log cleanup, and the inability to reconnect to an in-memory source baseline after process exit. Standard job state is durable; redacted/ephemeral job state is temporary and cleaned on task exit, with cleanup failure visible.
