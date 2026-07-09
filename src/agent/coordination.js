export function analyzeTaskCoordination(task) {
  const requestType = classifyRequest(task);
  const basis = coordinationBasis(task, requestType);
  const riskDomains = selectRiskDomains(task, requestType);
  const phases = selectPhases(task, requestType, riskDomains);
  const splitTriggers = selectSplitTriggers(task, requestType, basis, riskDomains, phases);
  const plan = buildWorkerPlan({ task, requestType, basis, riskDomains, phases, splitTriggers });
  // Require a genuine structural signal (multiple requirements, risk domains, phases, or split
  // triggers) rather than raw length — a long but single-purpose task should not force a split,
  // since each worker carries fixed context-ingestion overhead.
  const complex =
    basis.length >= 2 ||
    riskDomains.length >= 2 ||
    phases.length >= 3 ||
    splitTriggers.length >= 2;

  return {
    requestType,
    complex,
    basis,
    splitTriggers,
    phases,
    riskDomains,
    parallel: complex ? plan.parallel : [],
    serial: complex ? plan.serial : [],
    verification: complex ? plan.verification : undefined,
    agents: complex ? [...plan.parallel, ...plan.serial, ...(plan.verification ? [plan.verification] : [])] : [],
  };
}

function classifyRequest(task) {
  const text = String(task ?? "").toLowerCase();
  if (/(报错|错误|失败|bug|debug|修复|fix|failed|error|crash|异常)/i.test(text)) return "debug";
  const hasEdit = /(修改|新增|实现|继续|完善|改造|搭建|接入|add|implement|update|change|refactor|build)/i.test(text);
  const hasReview = /(review|审查|评审|code review|风险|隐患)/i.test(text);
  if (hasReview && !hasEdit) return "review";
  if (/(修改|新增|实现|继续|完善|改造|搭建|接入|add|implement|update|change|refactor|build)/i.test(text)) {
    return "edit";
  }
  if (/(解释|说明|分析|为什么|架构|方案|路径|是否合理|how|why|explain|analy[sz]e|architecture)/i.test(text)) {
    return "analysis";
  }
  if (/(运行|执行|命令|run|command|测试|test|验证|check)/i.test(text)) return "command";
  return "general";
}

function coordinationBasis(task, requestType) {
  const text = String(task ?? "");
  const basis = [];
  const clauseCount = text.split(/[，,；;。.\n]+/).map((part) => part.trim()).filter(Boolean).length;
  if (clauseCount >= 3) basis.push("request contains multiple distinct requirements");
  if (text.length > 180) basis.push("request is long enough to benefit from staged coordination");
  if (/(修改|新增|实现|改造|接入|完善|edit|write|implement|refactor|build)/i.test(text)) {
    basis.push("task may require code changes");
  }
  if (/(验证|测试|运行|check|test|verify|run)/i.test(text)) {
    basis.push("task asks for validation or command execution");
  }
  if (/(架构|方案|路径|隐患|风险|architecture|risk|design)/i.test(text)) {
    basis.push("task includes architecture, risk, or design reasoning");
  }
  if (/(subagent|agent|并行|拆分|协调|parallel|worker)/i.test(text)) {
    basis.push("task explicitly mentions agent decomposition or parallel work");
  }
  if ((requestType === "edit" || requestType === "debug") && basis.length === 1) {
    basis.push("edit/debug work benefits from separate inspect, implement, and verify phases");
  }
  if (requestType === "review" && basis.length === 0) {
    basis.push("review work benefits from independent risk perspectives");
  }
  return [...new Set(basis)];
}

const RISK_DOMAIN_DEFINITIONS = [
  {
    name: "Correctness",
    reviewer: "Correctness Reviewer",
    goal: "find behavioral bugs, regressions, data-flow mistakes, and broken user workflows with file-level evidence",
    keywords: /(正确性|行为|回归|bug|错误|失败|correctness|regression|behavior|logic|data-flow|workflow)/i,
  },
  {
    name: "Security",
    reviewer: "Security Reviewer",
    goal: "check auth, authorization, injection, secret handling, path traversal, and unsafe command or file access risks",
    keywords: /(安全|权限|认证|鉴权|注入|secret|token|api[_ -]?key|path traversal|auth|authorization|permission|injection|xss|csrf|shell|command)/i,
  },
  {
    name: "Edge cases",
    reviewer: "Edge-case Reviewer",
    goal: "stress boundary inputs, missing states, concurrency/idempotency, error paths, and recovery behavior",
    keywords: /(边界|异常|并发|幂等|重试|null|empty|错误路径|edge|boundary|concurrency|idempotent|retry|race|orphan|malformed)/i,
  },
  {
    name: "Architecture",
    reviewer: "Architecture Reviewer",
    goal: "assess module boundaries, abstractions, coupling, public contracts, and long-term maintainability",
    keywords: /(架构|设计|模块|抽象|结构|维护|architecture|design|module|abstraction|coupling|maintainability|api contract)/i,
  },
  {
    name: "Performance",
    reviewer: "Performance Reviewer",
    goal: "look for avoidable latency, memory growth, repeated work, inefficient IO, and scaling bottlenecks",
    keywords: /(性能|慢|内存|缓存|延迟|吞吐|扩展|performance|slow|memory|cache|latency|throughput|scal|io)/i,
  },
  {
    name: "Tests",
    reviewer: "Test Reviewer",
    goal: "identify missing or weak tests, circular assertions, unverified behavior, and practical validation commands",
    keywords: /(测试|验证|覆盖|回归|test|verify|validation|coverage|regression)/i,
  },
];

function selectRiskDomains(task, requestType) {
  const text = String(task ?? "");
  const lower = text.toLowerCase();
  const explicit = RISK_DOMAIN_DEFINITIONS.filter((domain) => domain.keywords.test(text));
  const broadReview =
    requestType === "review" &&
    (/(全面|整体|项目|仓库|所有|全量|full|broad|complete|overall|project|repo|all risks|review this)/i.test(text) || explicit.length === 0);

  if (broadReview) {
    return RISK_DOMAIN_DEFINITIONS.map((domain) => domainToSelection(domain, "broad review should cover this risk domain"));
  }

  const selected = [...explicit];
  if ((requestType === "review" || requestType === "debug") && !selected.some((domain) => domain.name === "Correctness")) {
    selected.unshift(RISK_DOMAIN_DEFINITIONS[0]);
  }
  if ((requestType === "edit" || requestType === "debug") && !selected.some((domain) => domain.name === "Tests")) {
    selected.push(RISK_DOMAIN_DEFINITIONS.at(-1));
  }
  if (requestType === "analysis" && /(风险|隐患|risk|tradeoff|方案|架构|architecture)/i.test(lower)) {
    const architecture = RISK_DOMAIN_DEFINITIONS.find((domain) => domain.name === "Architecture");
    if (architecture && !selected.includes(architecture)) selected.push(architecture);
  }

  return uniqueByName(selected).map((domain) => domainToSelection(domain, "request contains matching risk signals"));
}

function selectPhases(task, requestType, riskDomains) {
  const text = String(task ?? "");
  const phases = [];
  if (["edit", "debug", "review", "analysis"].includes(requestType) || /(查|看|搜索|inspect|research|find|read)/i.test(text)) {
    phases.push({ name: "Research", reason: "inspect relevant context before deciding the next action" });
  }
  if (requestType !== "command") {
    phases.push({ name: "Synthesis", reason: "the main agent must combine findings into a concrete plan or answer" });
  }
  if (requestType === "edit" || (requestType === "debug" && /(修复|fix|修改|change|update)/i.test(text))) {
    phases.push({ name: "Implementation", reason: "the task may require scoped file changes" });
  }
  if (["edit", "debug", "command"].includes(requestType) || riskDomains.some((domain) => domain.name === "Tests")) {
    phases.push({ name: "Verification", reason: "prove behavior or command outcome rather than relying on code reading" });
  }
  if (requestType === "review" && riskDomains.length > 1) {
    phases.push({ name: "Risk Review", reason: "independent risk-domain review can reduce blind spots" });
  }
  return uniqueByName(phases);
}

function selectSplitTriggers(task, requestType, basis, riskDomains, phases) {
  const text = String(task ?? "");
  const triggers = [];
  const wantsLongOutput = /(详细|全面|所有|全量|完整|deep|complete|comprehensive|all files|entire)/i.test(text);
  if (text.length > 220 || wantsLongOutput) {
    triggers.push({
      name: "Context volume",
      reason: "single-agent context or final output may grow too large",
    });
  }
  if ((requestType === "edit" || requestType === "debug") && riskDomains.some((domain) => domain.name === "Security")) {
    triggers.push({
      name: "Safety separation",
      reason: "security review should stay independent from code modification",
    });
  }
  if (requestType === "review" && riskDomains.length > 1) {
    triggers.push({
      name: "Parallel review lanes",
      reason: "multiple risk domains can be checked independently",
    });
  }
  if (phases.some((phase) => phase.name === "Implementation") && phases.some((phase) => phase.name === "Verification")) {
    triggers.push({
      name: "Independent verification",
      reason: "tester should validate behavior without sharing implementation assumptions",
    });
  }
  if (requestType === "review" || (requestType === "edit" && /(审查|review|风险|risk)/i.test(text))) {
    triggers.push({
      name: "Anti-confirmation",
      reason: "independent reviewer reduces self-confirmation after planning or edits",
    });
  }
  if (basis.some((item) => /multiple distinct requirements/i.test(item))) {
    triggers.push({
      name: "Multi-part task",
      reason: "separate subtasks reduce context mixing and missed requirements",
    });
  }
  return uniqueByName(triggers);
}

function buildWorkerPlan({ requestType, basis, riskDomains, phases, splitTriggers }) {
  const parallel = [];
  const serial = [];
  let verification;

  if (requestType === "review") {
    for (const domain of riskDomains) {
      parallel.push({
        name: domain.reviewer,
        role: roleForRiskDomain(domain.name),
        mode: "research",
        goal: domain.goal,
        phase: "Risk Review",
        concurrency: "parallel",
        reason: domain.reason,
      });
    }
  } else if (requestType === "analysis") {
    if (riskDomains.some((domain) => domain.name === "Architecture")) {
      parallel.push({
        name: "Planner Agent",
        role: "planner",
        mode: "research",
        goal: "evaluate implementation paths, module boundaries, tradeoffs, and migration costs without editing files",
        phase: "Research",
        concurrency: "parallel",
        reason: "architecture questions benefit from isolated exploration before synthesis",
      });
    }
    if (basis.some((item) => /risk|风险|隐患/i.test(item))) {
      parallel.push({
        name: "Reviewer Agent",
        role: "reviewer",
        mode: "research",
        goal: "identify hidden assumptions, operational risks, and validation strategy",
        phase: "Research",
        concurrency: "parallel",
        reason: "risk analysis should be separated from solution framing",
      });
    }
  } else if (requestType === "command") {
    serial.push({
      name: "Command Runner",
      role: "tester",
      mode: "verify",
      goal: "execute the requested command or focused diagnostics and capture meaningful output",
      phase: "Verification",
      concurrency: "serial",
      reason: "commands mutate terminal state or consume shared output, so run deliberately",
    });
  } else {
    parallel.push({
      name: "Planner Agent",
      role: "planner",
      mode: "research",
      goal: "identify relevant files, existing patterns, constraints, and prior observations before edits",
      phase: "Research",
      concurrency: "parallel",
      reason: "research can often be isolated from implementation context",
    });
    if (phases.some((phase) => phase.name === "Implementation")) {
      serial.push({
        name: "Coder Agent",
        role: "coder",
        mode: "implement",
        goal: "apply minimal scoped changes consistent with existing project patterns",
        phase: "Implementation",
        concurrency: "serial",
        reason: "write-heavy work should avoid overlapping file edits",
      });
    }
    if (splitTriggers.some((trigger) => trigger.name === "Safety separation")) {
      parallel.push({
        name: "Security Agent",
        role: "security",
        mode: "research",
        goal: "independently inspect auth, command execution, path access, secret handling, and unsafe file operations",
        phase: "Risk Review",
        concurrency: "parallel",
        reason: "security review should not share the coder's implementation assumptions",
      });
    }
  }

  if (phases.some((phase) => phase.name === "Verification")) {
    verification = {
      name: "Tester Agent",
      role: "tester",
      mode: "verify",
      goal: "run or define focused validation and report failures, uncertainty, and residual risk",
      phase: "Verification",
      concurrency: "fresh-worker-or-main-check",
      freshWorker: true,
      reason: "verification should be independent from implementation assumptions when practical",
    };
  }

  return { parallel, serial, verification };
}

function roleForRiskDomain(name) {
  if (name === "Security") return "security";
  if (name === "Tests") return "tester";
  return "reviewer";
}

function domainToSelection(domain, reason) {
  return {
    name: domain.name,
    reviewer: domain.reviewer,
    goal: domain.goal,
    reason,
  };
}

function uniqueByName(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.name || seen.has(item.name)) continue;
    seen.add(item.name);
    result.push(item);
  }
  return result;
}
