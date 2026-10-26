// Intent is advisory task understanding; mayWrite is the capability contract consumed by tools.
// Keep negative instructions out of the positive edit detector.
export function inferTaskIntent(task, { mode } = {}) {
  const text = String(task ?? "").trim();
  const negativeWrite = /(?:不要|禁止|不得|无需|不必|勿|不允许|不要再|不需要)\s*(?:直接)?(?:修改|编辑|写入|写|创建|改动|更改|改造|搭建|接入|修复|实现|新增|删除)[^，,；;。\n]*/gi;
  const englishNegative = /\b(?:do\s+not|don't|never|without|no)\s+(?:make\s+)?(?:edit(?:ing|s)?|modif(?:y|ying)|writ(?:e|ing)|creat(?:e|ing)|updat(?:e|ing)|refactor(?:ing)?|build(?:ing)?|add(?:ing)?|chang(?:e|ing|es)|fix(?:ing|es)?|implement(?:ing)?|delet(?:e|ing))\b(?:(?!\.(?:\s|$)|\b(?:but|instead)\b|\band\s+(?:only\s+)?(?:fix|implement|edit|modify|create)\b)[^,;\n])*/gi;
  const negativeClauses = [...text.matchAll(negativeWrite), ...text.matchAll(englishNegative)].map((match) => match[0]);
  const writeRestrictions = [...new Map(negativeClauses.flatMap(scopedRestrictions).map((rule) => [JSON.stringify(rule), rule])).values()];
  const positiveText = text.replace(negativeWrite, " ").replace(englishNegative, " ")
    .replace(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test|check)\b/gi, " ");
  const positiveWrite = /(修改|编辑|新增|创建|实现|改造|搭建|接入|改动|更改|修复|删除)/i.test(positiveText)
    || /\b(?:edit|modify|write|create|implement|update|change|refactor|build|add|fix|delete)\b/i.test(positiveText)
    || (/(继续|完善)/.test(positiveText) && /(代码|实现|功能|文件|code|file|feature)/i.test(positiveText));
  const hardReadOnly = mode === "read-only" || /(?:只读|仅审查|只审查|仅分析|只分析|read[- ]only|review\s+only|only\s+review)/i.test(text);
  // "any test files" restricts a path class; "any files" restricts the task.
  // A restriction on another operation ("do not change permissions") must not
  // erase an explicit code-change goal and turn a denied edit into an analysis success.
  const explicitReadOnly = hardReadOnly || negativeClauses.some((clause) => !scopedRestrictions(clause).length && (!positiveWrite || globalFileNegative(clause)));
  const hasReview = /(review|审查|评审|风险|隐患)/i.test(text);
  const hasAnalysis = /(解释|说明|分析|为什么|架构|方案|路径|是否合理|\bhow\b|\bwhy\b|explain|analy[sz]e|architecture)/i.test(text);
  const hasDebug = /(报错|错误|失败|bug|debug|修复|\bfix\b|failed|error|crash|异常)/i.test(text);
  const hasCommand = /(运行|执行|命令|测试|验证|\brun\b|\bcommand\b|\btest\b|\bcheck\b)/i.test(text);
  let requestType;
  if (explicitReadOnly) requestType = hasReview ? "review" : "analysis";
  else if (positiveWrite) requestType = hasDebug ? "debug" : "edit";
  else if (hasReview) requestType = "review";
  else if (hasAnalysis) requestType = "analysis";
  else if (hasCommand) requestType = "command";
  else if (hasDebug) requestType = "debug";
  else requestType = "general";
  if (!explicitReadOnly && ["review", "analysis", "edit", "debug", "command", "general"].includes(mode)) requestType = mode;
  const mayWrite = !explicitReadOnly && (requestType === "edit" || (requestType === "debug" && positiveWrite) || requestType === "command");
  return {
    intent: mayWrite ? (positiveWrite ? "change" : "execute") : (["review", "analysis", "debug"].includes(requestType) ? "inspect" : "answer"),
    requestType,
    mayWrite,
    explicitReadOnly,
    writeRestrictions,
    requiresCodeChange: mayWrite && positiveWrite,
    allowsNoChange: /(?:already|if needed|if necessary|无需|不必|已(?:经)?(?:修复|解决|满足)|若已|如果已)/i.test(text),
  };
}

function globalFileNegative(clause) {
  return /(?:修改|编辑|写入|写|创建|改动|更改|修复|实现|新增|删除)\s*(?:任何|所有|全部)?(?:代码|文件|内容)?\s*$/.test(clause)
    || /\b(?:edit(?:ing|s)?|modif(?:y|ying)|writ(?:e|ing)|creat(?:e|ing)|updat(?:e|ing)|chang(?:e|ing|es)|fix(?:ing|es)?|implement(?:ing)?|delet(?:e|ing))\s+(?:(?:any|all|the)\s+)?(?:files?|code|anything|changes?)(?:\s+at\s+all)?\s*$/i.test(clause);
}

function scopedRestrictions(clause) {
  const rules = [];
  if (/(?:测试(?:文件|代码|目录)?|\b(?:test|tests|spec|specs|__tests__)\b)/i.test(clause)) rules.push({ kind: "tests" });
  if (/(?:生成(?:的)?文件|生成代码|\bgenerated\b)/i.test(clause)) rules.push({ kind: "generated" });
  const paths = [...clause.matchAll(/[`"']([^`"']+)[`"']|(?:@)?(\/?(?:[A-Za-z0-9_.-]+[\/\\])+[A-Za-z0-9_.*?-]*|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g)]
    .map((match) => match[1] ?? match[2])
    .map((path) => path.replaceAll("\\", "/").replace(/^@/, "").replace(/\/$/, ""))
    .filter((path) => path && !/[*?\0]/.test(path) && (!/\s/.test(path) || /[/.]/.test(path)));
  for (const path of paths) rules.push({ kind: "path", path });
  return rules;
}
