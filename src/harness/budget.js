import { estimateCostUsd } from "./cost.js";

// One ledger belongs to the whole task, including every worker. When a limit is
// enabled, model calls are serialized: actual provider usage is authoritative,
// and at most the one request already in flight can exceed the remaining budget.
export function createTaskBudget({ model, tokenBudget, costBudgetUsd, priceOverrides, usage: initialUsage } = {}) {
  const usage = normalizeUsage(initialUsage);
  const controller = new AbortController();
  let stopped;
  let tail = Promise.resolve();
  const limited = Boolean(tokenBudget || costBudgetUsd);

  const check = () => {
    if (stopped) return stopped;
    if (tokenBudget && usage.totalTokens >= tokenBudget) {
      stopped = {
        reason: "token_budget_exceeded", limit: tokenBudget, observed: usage.totalTokens,
        message: `Stopped after reaching the shared task token budget (${tokenBudget}; used ${usage.totalTokens}).`,
      };
    } else {
      const cost = costBudgetUsd ? estimateCostUsd(usage, model, priceOverrides) : 0;
      if (costBudgetUsd && cost >= costBudgetUsd) {
        stopped = {
          reason: "cost_budget_exceeded", limit: costBudgetUsd, observed: cost,
          message: `Stopped after reaching the shared task cost budget ($${costBudgetUsd}; estimated $${cost}).`,
        };
      }
    }
    if (stopped) controller.abort(budgetError(stopped));
    return stopped;
  };

  const ledger = {
    signal: controller.signal,
    snapshot: () => ({ ...usage }),
    stopped: check,
    record(value) {
      const next = normalizeUsage(value);
      usage.promptTokens += next.promptTokens;
      usage.completionTokens += next.completionTokens;
      usage.totalTokens += next.totalTokens;
      check();
    },
    run(fn, signal) {
      const execute = async () => {
        if (check()) throw budgetError(stopped);
        throwIfAborted(signal);
        const linked = linkSignals([signal, controller.signal]);
        try {
          const result = await fn(linked.signal);
          ledger.record(result?.usage);
          return result;
        } catch (error) {
          // Providers may attach the measured usage to a failed/partial request.
          if (error?.usage) ledger.record(error.usage);
          throw error;
        } finally {
          linked.dispose();
        }
      };
      const pending = limited ? tail.then(execute) : execute();
      if (limited) tail = pending.catch(() => {});
      return pending;
    },
  };
  check();
  return ledger;
}

export function budgetClient(client, budget) {
  if (!budget || client.taskBudget === budget) return client;
  if (client.taskBudget) throw new Error("A model client cannot belong to two task budgets.");
  const wrapped = {
    ...client,
    taskBudget: budget,
    chatCompletion(request, options = {}) {
      return budget.run((signal) => client.chatCompletion(request, { ...options, signal }), options.signal);
    },
  };
  if (typeof client.chatCompletionStream === "function") {
    wrapped.chatCompletionStream = (request, handlers = {}) =>
      budget.run((signal) => client.chatCompletionStream(request, { ...handlers, signal }), handlers.signal);
  }
  return wrapped;
}

export function linkSignals(signals) {
  const active = [...new Set(signals.filter(Boolean))];
  if (active.length < 2) return { signal: active[0], dispose() {} };
  const controller = new AbortController();
  const listeners = [];
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    listeners.push([signal, onAbort]);
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

function budgetError(budget) {
  const error = new Error(budget.message);
  error.code = budget.reason;
  error.budget = budget;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Task interrupted.");
}

function normalizeUsage(value = {}) {
  const number = (input) => Number.isFinite(Number(input)) && Number(input) >= 0 ? Number(input) : 0;
  const promptTokens = number(value?.promptTokens ?? value?.prompt_tokens);
  const completionTokens = number(value?.completionTokens ?? value?.completion_tokens);
  return { promptTokens, completionTokens, totalTokens: number(value?.totalTokens ?? value?.total_tokens ?? promptTokens + completionTokens) };
}
