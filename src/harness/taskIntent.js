// Intent is advisory task understanding; mayWrite is the capability contract consumed by tools.
// Keep negative instructions out of the positive edit detector.
export function inferTaskIntent(task, { mode } = {}) {
  const text = String(task ?? "").trim();
  const negativeWrite = /(?:不要|禁止|不得|无需|不必|勿|不允许|不要再|不需要)\s*(?:直接)?(?:修改|编辑|写入|写|创建|改动|更改|改造|搭建|接入|修复|实现|新增|删除)[^，,；;。\n]*/gi;
  const englishNegative = /\b(?:do\s+not|don't|never|without|no)\s+(?:make\s+)?(?:edit(?:ing|s)?|modif(?:y|ying)|writ(?:e|ing)|creat(?:e|ing)|updat(?:e|ing)|refactor(?:ing)?|build(?:ing)?|add(?:ing)?|chang(?:e|ing|es)|fix(?:ing|es)?|implement(?:ing)?|delet(?:e|ing))\b[^,;.\n]*/gi;
  const hadNegativeWrite = negativeWrite.test(text) || englishNegative.test(text);
  negativeWrite.lastIndex = 0;
  englishNegative.lastIndex = 0;
  const positiveText = text.replace(negativeWrite, " ").replace(englishNegative, " ")
    .replace(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test|check)\b/gi, " ");
  const positiveWrite = /(修改|编辑|新增|创建|实现|改造|搭建|接入|改动|更改|修复|删除)/i.test(positiveText)
    || /\b(?:edit|modify|write|create|implement|update|change|refactor|build|add|fix|delete)\b/i.test(positiveText)
    || (/(继续|完善)/.test(positiveText) && /(代码|实现|功能|文件|code|file|feature)/i.test(positiveText));
  const hardReadOnly = mode === "read-only" || /(?:只读|仅审查|只审查|仅分析|只分析|read[- ]only|review\s+only)/i.test(text)
    || /(?:不要|禁止|不得|勿)\s*(?:修改|编辑|写入|改动|更改|删除)\s*(?:任何|所有|全部)(?:代码|文件|内容)?/i.test(text);
  const explicitReadOnly = hardReadOnly || (hadNegativeWrite && !positiveWrite);
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
    requiresCodeChange: mayWrite && positiveWrite,
    allowsNoChange: /(?:already|if needed|if necessary|无需|不必|已(?:经)?(?:修复|解决|满足)|若已|如果已)/i.test(text),
  };
}
