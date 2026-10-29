#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectSandbox } from "../src/execution/sandbox.js";
import { createModelClient } from "../src/llm/clientFactory.js";
import { estimateCostUsd } from "../src/harness/cost.js";
import { createScriptedEvalClient, executeEvalCase } from "./execution.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const positive = (value) => Number.isFinite(value) && value > 0;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function validateBenchmarkOptions(options = {}) {
  const offline = options.offline === true;
  if (!offline && options.allowPaid !== true) throw new Error("Real provider execution requires explicit --allow-paid; use --offline for zero API calls");
  if (!Number.isSafeInteger(options.trials ?? 1) || (options.trials ?? 1) < 1 || (options.trials ?? 1) > 100) throw new Error("trials must be between 1 and 100");
  for (const key of ["maxCalls", "tokenBudget", "costBudgetUsd", "maxTokens", "timeoutMs"]) if (!positive(options[key])) throw new Error(`Explicit positive ${key} is required`);
  if (!Number.isSafeInteger(options.maxCalls) || !Number.isSafeInteger(options.tokenBudget) || !Number.isSafeInteger(options.maxTokens)) throw new Error("Call and token limits must be integers");
  if (!offline) {
    if (!["openai", "anthropic", "deepseek"].includes(options.provider) || !options.model) throw new Error("Explicit supported provider and model are required");
    if (!positive(options.pricePromptPerM) || !positive(options.priceCompletionPerM)) throw new Error("Explicit positive input and output prices are required for a real cost bound");
    if (!options.baseUrl || new URL(options.baseUrl).protocol !== "https:") throw new Error("An explicit HTTPS provider base URL is required");
  }
  if (options.sandboxMode && !["off", "auto", "required"].includes(options.sandboxMode)) throw new Error("sandbox must be off, auto, or required");
  if (options.sandboxNetwork && !["deny", "allow"].includes(options.sandboxNetwork)) throw new Error("sandbox network must be deny or allow");
  return { ...options, offline, trials: options.trials ?? 1 };
}

// Admission reserves a conservative input-token upper bound (UTF-8 bytes plus
// protocol overhead) and the full output cap before dispatch. It never retries
// a paid request: missing usage or an exceeded reservation stops future calls.
export function createBenchmarkBudget(options) {
  let calls = 0, promptTokens = 0, completionTokens = 0, stopped;
  let tail = Promise.resolve();
  const snapshot = () => ({ calls, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
    costUsd: estimateCostUsd({ promptTokens, completionTokens }, options.model, options), stopped });
  return {
    snapshot,
    wrap(client) {
      return { ...client, chatCompletion(request, transport = {}) {
        const run = async () => {
          const maxOutput = Math.min(options.maxTokens, request.max_tokens ?? request.max_completion_tokens ?? options.maxTokens);
          const promptBound = Buffer.byteLength(JSON.stringify(request), "utf8") + 4096;
          const reservation = estimateCostUsd({ promptTokens: promptBound, completionTokens: maxOutput }, options.model, options);
          const now = snapshot();
          if (stopped || calls >= options.maxCalls || now.totalTokens + promptBound + maxOutput > options.tokenBudget || now.costUsd + reservation > options.costBudgetUsd) {
            stopped ??= "benchmark_budget_exhausted";
            throw Object.assign(new Error(stopped), { code: stopped });
          }
          calls += 1;
          const capped = { ...request, max_tokens: maxOutput };
          if (request.max_completion_tokens !== undefined) { delete capped.max_tokens; capped.max_completion_tokens = maxOutput; }
          let response;
          try { response = await client.chatCompletion(capped, transport); }
          catch (error) { stopped = "provider_request_failed_cost_unknown"; throw error; }
          const usage = response?.usage;
          const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokens);
          const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.completionTokens);
          if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
            stopped = "provider_usage_missing";
            throw Object.assign(new Error("Provider usage missing; stopped to avoid unmeasured spend"), { code: stopped });
          }
          promptTokens += input; completionTokens += output;
          if (input > promptBound || output > maxOutput) stopped = "provider_usage_exceeded_reservation";
          return response;
        };
        const promise = tail.then(run); tail = promise.catch(() => {}); return promise;
      } };
    },
  };
}

export async function runProviderBenchmark(cases, rawOptions, { clientFactory } = {}) {
  const options = validateBenchmarkOptions(rawOptions);
  if (!Array.isArray(cases) || !cases.length) throw new Error("Select at least one trusted benchmark case");
  if (!options.offline && cases.some((item) => item.execution.providerEligible === false || item.execution.expectedRun?.status === "failed" || item.execution.resumeScripted)) throw new Error("Real model benchmarks require task-outcome cases, excluding scripted rejection/recovery scenarios");
  const fixedConfig = { provider: options.offline ? "scripted" : options.provider, model: options.offline ? "scripted-eval" : options.model,
    maxTokens: options.maxTokens, taskTimeoutMs: options.timeoutMs, timeoutMs: options.timeoutMs, retryAttempts: 1,
    pricePromptPerM: options.offline ? 0 : options.pricePromptPerM, priceCompletionPerM: options.offline ? 0 : options.priceCompletionPerM,
    sandboxPolicy: { mode: options.offline ? "off" : options.sandboxMode ?? "required", network: options.sandboxNetwork ?? "deny" },
    stream: false, quiet: true };
  // Graders import model-written code inside this sandbox, so without it no trial can be graded;
  // refuse before the first paid request rather than after the budget is spent.
  if (fixedConfig.sandboxPolicy.mode === "required") {
    const sandbox = detectSandbox();
    if (!sandbox.available) throw Object.assign(new Error(`Required OS sandbox unavailable: ${sandbox.reason}. Install it, or choose --sandbox auto or off to run tasks and graders without it.`), { code: "SANDBOX_UNAVAILABLE" });
  }
  const budget = createBenchmarkBudget({ ...options, ...fixedConfig });
  const results = [];
  for (const definition of cases) {
    if (budget.snapshot().stopped) break;
    const candidate = structuredClone(definition);
    candidate.execution.config = { ...candidate.execution.config, ...fixedConfig };
    const result = await executeEvalCase(candidate, { trials: options.trials, clientFactory: async (context) => {
      const client = clientFactory ? await clientFactory(context) : options.offline ? createScriptedEvalClient(candidate.execution.scripted) : createModelClient({ ...fixedConfig, baseUrl: options.baseUrl, apiKey: options.apiKey });
      return budget.wrap(client);
    } });
    results.push(result);
  }
  const trials = results.flatMap((result) => result.trials.map((trial) => ({ ...trial, caseId: result.caseId })));
  const successful = trials.filter((trial) => trial.taskPassed);
  const measured = budget.snapshot();
  const unknownSpend = /cost_unknown|usage_missing/.test(measured.stopped ?? "");
  const failureCategories = {};
  for (const trial of trials.filter((trial) => !trial.taskPassed)) { const category = classifyBenchmarkFailure(trial); failureCategories[category] = (failureCategories[category] ?? 0) + 1; }
  const attribution = await benchmarkAttribution(cases, fixedConfig);
  return { schemaVersion: 1, evaluationKind: options.offline ? "offline-benchmark-contract" : "provider-benchmark", createdAt: new Date().toISOString(),
    attribution, config: fixedConfig,
    budget: { maxCalls: options.maxCalls, tokenBudget: options.tokenBudget, costBudgetUsd: options.costBudgetUsd, admission: "utf8-input-upper-bound-plus-4096-and-capped-output", ...measured },
    summary: { requestedTrials: cases.length * options.trials, executedTrials: trials.length, successfulTrials: successful.length, successRate: trials.length ? successful.length / trials.length : 0,
      measuredCostUsd: unknownSpend ? null : measured.costUsd, actualSpendUsd: options.offline ? 0 : unknownSpend ? null : measured.costUsd,
      costPerSuccessfulTaskUsd: successful.length && !unknownSpend ? measured.costUsd / successful.length : null,
      humanInterventions: trials.reduce((sum, trial) => sum + trial.humanInterventions, 0), automatedApprovalRequests: trials.reduce((sum, trial) => sum + trial.approvalRequests, 0),
      failureCategories, elapsedMs: trials.reduce((sum, trial) => sum + trial.elapsedMs, 0) }, results };
}

export function classifyBenchmarkFailure(trial) {
  const diagnostic = trial.diagnostics ?? {};
  const text = JSON.stringify([diagnostic.error, diagnostic.stoppedReason, diagnostic.validationErrors, diagnostic.verification]);
  if (/budget|reservation/.test(text)) return "budget";
  if (/missing_dependency|MODULE_NOT_FOUND|Cannot find module|not installed/i.test(text)) return "dependency";
  if (/permission|TASK_TOOL_BLOCKED|SHELL_COMMAND_BLOCKED/i.test(text)) return "permission";
  if (/provider|API error|usage_missing|Script exhausted/i.test(text)) return "provider";
  if (diagnostic.verification?.evidence?.some((item) => !item.ok)) return "verification";
  if (trial.checks?.some((check) => !check.passed && /change-scope|unchanged:/.test(check.name))) return "unexpected-change";
  if (trial.checks?.some((check) => !check.passed && check.name.startsWith("review-"))) return "review";
  if (diagnostic.acceptance?.satisfied === false) return "acceptance";
  return "outcome";
}

async function benchmarkAttribution(cases, config) {
  const paths = [];
  const walk = async (directory) => {
    for (const entry of await readdir(join(ROOT, directory), { withFileTypes: true })) {
      const path = directory + "/" + entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:js|md)$/.test(path)) paths.push(path);
    }
  };
  await walk("src"); paths.sort();
  const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, hash(await readFile(join(ROOT, path)))])));
  let revision = "unknown"; try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  return { gitRevision: revision, sourceHashes, harnessVersion: hash(JSON.stringify(sourceHashes)), datasetVersion: hash(JSON.stringify(cases)), configVersion: hash(JSON.stringify(config)),
    environment: { node: process.version, platform: process.platform, arch: process.arch }, approvalPolicy: "authored automatic approval; no interactive human assistance", grading: "independent final-state assertions" };
}

export async function benchmarkMain(argv = process.argv.slice(2)) {
  const options = { trials: 1 }; let casesDir = join(ROOT, "eval/tasks"), caseId, output;
  const names = { "--provider": "provider", "--model": "model", "--base-url": "baseUrl", "--max-calls": "maxCalls", "--token-budget": "tokenBudget", "--cost-budget-usd": "costBudgetUsd", "--max-tokens": "maxTokens", "--timeout-ms": "timeoutMs", "--price-prompt-per-m": "pricePromptPerM", "--price-completion-per-m": "priceCompletionPerM", "--trials": "trials", "--sandbox": "sandboxMode", "--sandbox-network": "sandboxNetwork" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--offline") options.offline = true;
    else if (arg === "--allow-paid") options.allowPaid = true;
    else if (arg === "--case") caseId = argv[++index];
    else if (arg === "--cases-dir") casesDir = resolve(argv[++index]);
    else if (arg === "--output") output = resolve(argv[++index]);
    else if (names[arg]) { const key = names[arg]; const value = argv[++index]; options[key] = ["provider", "model", "baseUrl", "sandboxMode", "sandboxNetwork"].includes(key) ? value : Number(value); }
    else throw new Error("Unknown benchmark option: " + arg);
  }
  validateBenchmarkOptions(options);
  if (!options.offline && !caseId) throw new Error("A real benchmark requires an explicit --case");
  if (!options.offline) {
    const keyName = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", deepseek: "DEEPSEEK_API_KEY" }[options.provider];
    options.apiKey = process.env[keyName];
    if (!options.apiKey) throw new Error("Missing provider credential: " + keyName);
  }
  const cases = [];
  for (const file of (await readdir(casesDir)).filter((name) => name.endsWith(".json")).sort()) {
    const definition = JSON.parse(await readFile(join(casesDir, file), "utf8"));
    if (!caseId || definition.id === caseId) cases.push(definition);
  }
  const report = await runProviderBenchmark(cases, options);
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.successfulTrials !== report.summary.executedTrials || report.summary.executedTrials !== report.summary.requestedTrials || report.budget.stopped) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) benchmarkMain().catch((error) => { console.error(error.message); process.exitCode = 1; });
