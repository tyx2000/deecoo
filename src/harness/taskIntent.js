// Intent is advisory task understanding; mayWrite is the capability contract consumed by tools.
// Keep negative instructions out of the positive edit detector.
const ENGLISH_WRITE_WORD = "(?:edit|modify|write|create|implement|update|change|refactor|build|add|fix|delete)";
// A hyphenated name ("the create-user endpoint", "add-on", "bug-fix") is not a request; "re-create" is.
const ENGLISH_WRITE_REQUEST = new RegExp(`(?<![\\w-])(?:re-)?${ENGLISH_WRITE_WORD}(?![\\w-])`, "i");
// A change named as a thing to inspect ("Review the fix", "explain why the build fails",
// "Review this: the bug fix landed") is the subject of the task, not a request to make one. Only
// a determiner after an inspection word or a clause start marks the noun; "Apply the fix" or
// "I need a fix" still ask for a change.
const INSPECTED_CHANGE = new RegExp(`(?:^|[.:;!?]\\s*|\\b(?:review|explain|analy[sz]e|inspect|examine|audit|evaluate|describe|summari[sz]e|discuss|assess|look\\s+at|about|of|in|on|at|from|after|before|behind|why|how|when|where|whether|if)\\s+)`
  + `(?:the|a|an|this|that|these|those|its|our|your|my|their|his|her)\\s+(?:[\\w-]+\\s+)?${ENGLISH_WRITE_WORD}(?:e?s)?(?![\\w-])`, "gim");
const INSPECTED_CHANGE_ZH = /(?:审查|评审|解释|说明|分析|检查|查看|看看|看一下)\s*(?:一下)?\s*(?:这个|这次|这些|此次|该|那个|上次|上一次|之前的|最近的|本次)\s*(?:修复|修改|改动|更改)/g;

export function inferTaskIntent(task, { mode } = {}) {
  const text = String(task ?? "").trim();
  // Paths, @mentions, code, and function names name things; the words inside them are not
  // requests. "Review @src/update.js" or "the create() function" must not read as an edit.
  const prose = withoutCodeReferences(text);
  const negativeWrite = /(?:不要|禁止|不得|无需|不必|勿|不允许|不要再|不需要)\s*(?:直接)?(?:修改|编辑|写入|写|创建|改动|更改|改造|搭建|接入|修复|实现|新增|删除)[^，,；;。\n]*/gi;
  const englishNegative = /\b(?:do\s+not|don't|never|without|no)\s+(?:make\s+)?(?:edit(?:ing|s)?|modif(?:y|ying)|writ(?:e|ing)|creat(?:e|ing)|updat(?:e|ing)|refactor(?:ing)?|build(?:ing)?|add(?:ing)?|chang(?:e|ing|es)|fix(?:ing|es)?|implement(?:ing)?|delet(?:e|ing))\b(?:(?!\.(?:\s|$)|\b(?:but|instead)\b|\band\s+(?:only\s+)?(?:fix|implement|edit|modify|create)\b)[^,;\n])*/gi;
  const negativeClauses = [...text.matchAll(negativeWrite), ...text.matchAll(englishNegative)].map((match) => match[0]);
  const writeRestrictions = [...new Map(negativeClauses.flatMap(scopedRestrictions).map((rule) => [JSON.stringify(rule), rule])).values()];
  const positiveText = prose.replace(negativeWrite, " ").replace(englishNegative, " ")
    .replace(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test|check)\b/gi, " ")
    .replace(INSPECTED_CHANGE, " ").replace(INSPECTED_CHANGE_ZH, " ");
  const positiveWrite = /(修改|编辑|新增|创建|实现|改造|搭建|接入|改动|更改|修复|删除)/i.test(positiveText)
    || ENGLISH_WRITE_REQUEST.test(positiveText)
    || (/(继续|完善)/.test(positiveText) && /(代码|实现|功能|文件|code|file|feature)/i.test(positiveText));
  const hardReadOnly = mode === "read-only" || /(?:只读|仅审查|只审查|仅分析|只分析|read[- ]only|review\s+only|only\s+review)/i.test(text);
  // "any test files" restricts a path class; "any files" restricts the task.
  // A restriction on another operation ("do not change permissions") must not
  // erase an explicit code-change goal and turn a denied edit into an analysis success.
  const explicitReadOnly = hardReadOnly || negativeClauses.some((clause) => !scopedRestrictions(clause).length && (!positiveWrite || globalFileNegative(clause)));
  const hasReview = /(review|审查|评审|风险|隐患)/i.test(prose);
  const hasAnalysis = /(解释|说明|分析|为什么|架构|方案|路径|是否合理|\bhow\b|\bwhy\b|explain|analy[sz]e|architecture)/i.test(prose);
  const hasDebug = /(报错|错误|失败|bug|debug|修复|\bfix\b|failed|error|crash|异常)/i.test(prose);
  const hasCommand = /(运行|执行|命令|测试|验证|\brun\b|\bcommand\b|\btest\b|\bcheck\b)/i.test(prose);
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

function withoutCodeReferences(text) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    // A reference never takes the sentence's closing punctuation with it, or "Do not edit a/b.md.
    // Fix c" would read as one negative clause.
    .replace(/(^|\s)@\S*[^\s.,;:!?，。；：！？]/g, "$1 ")
    // A file name in another script ("src/修复.js") once something separates it from the prose;
    // with nothing in between ("审查修复.js", "修改app.js") the boundary is unknowable, so only
    // the ASCII name below is removed and the words stay.
    .replace(/(?<=^|[\s/\\"'(（「，。；：、])(?:(?![A-Za-z])[\p{L}\p{N}_-])+(?:\.[\p{L}\p{N}_-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?![A-Za-z0-9_])/gu, " ")
    .replace(/(?:[\w.-]+\/)+(?:[\w.-]*[\w-])?/g, " ")
    .replace(/\b[\w-]+\.[A-Za-z]\w{0,7}\b/g, " ")
    .replace(/\b[A-Za-z_$][\w$]*\([^()\n]*\)/g, " ");
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
