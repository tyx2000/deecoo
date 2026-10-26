# deepseek-code-review.md 独立复核

> 本文是修复前的独立复核快照；以下 open 和缺陷复现 passed 保留历史含义。用户随后已授权实施，最新逐项修复和验收记录见 [原报告第十九节](/Users/adib/Documents/Deecoo/deepseek-code-review.md#十九post-cor-实施与批注跟进2026-10-22)。

日期：2026-10-22（Asia/Shanghai）。审查对象是原报告及其第十五至十八节，结论绑定本次工作树，不能直接套用到历史版本。

结论：**原报告发现了一批真实问题，第十五节的大部分勘误与修复有依据，但“全部确认问题已修复”仍过强；第十六至十八节又混入了环境误归因、未证实缺陷和不适当的修复建议。不能整体照单实施。** 本轮确认 9 项产品残留或局部契约问题，详见下文；没有确认当前存在原报告所概括的 5 个 P0。优先处理工作区越界写入、项目代码执行审批绕过和任务意图误判。

本轮只增加这份复核报告，未修改既有产品代码、测试、配置或原审查报告，未提交推送。所有安全探针使用临时目录与合成数据，未调用真实付费模型。

## 当前仍存在的问题

下列 `verification_result: passed` 表示**成功复现缺陷**，不表示缺陷已修复。原条目 ID 保留；同名 O-* 按原报告章节区分。

### DS-CHECK-SEC-002 — 创建文件仍可通过替换父目录越过工作区边界（关联 E-1）

- severity: P1
- status: open
- issue_evidence: confirmed；安全临时 fixture 确定性复现。
- lane: code/security
- scope: pre-existing，当前写入补强未覆盖父目录。
- affected_files: [files.js:771](/Users/adib/Documents/Deecoo/src/tools/files.js:771)、[files.js:784](/Users/adib/Documents/Deecoo/src/tools/files.js:784)、[files.js:811](/Users/adib/Documents/Deecoo/src/tools/files.js:811)、[writeWorkspaceText:503](/Users/adib/Documents/Deecoo/src/tools/files.js:503)。
- failure_scenario: 攻击者能修改工作区目录。在创建 `parent/result.txt` 的审批等待期间，把已检查的普通 `parent` 移走，换成指向工作区外临时目录的符号链接。审批后执行创建，返回 `ok:true`，实际外部 `result.txt` 内容为 `ESCAPED`。
- impact: 进程内文件工具突破工作区写入边界。叶子文件的 `O_NOFOLLOW` 不约束父目录；shell 的 seatbelt 不覆盖这条进程内路径。
- reliable_solution: 审批后和创建目录后重新验证父链，先封住已复现的审批窗口；若要承诺抗并发 TOCTOU，需要目录描述符锚定的相对打开或等效 OS 边界。单次重新 `lstat` 仍不能根除竞态。相关 create/patch/move 路径应共享同一安全原语。
- solution_fit: suited=yes；executable=最低补强 yes、完整目录约束 conditional（需要平台实现）；affordable=yes；cost=medium，涉及统一文件创建边界和竞态回归；verification=审批回调替换父目录后必须拒绝，外部文件不得出现。
- verification_result: passed；`verify-policies.mjs` 实际调用 `writeWorkspaceFile`，仅在临时根下写出工作区外 marker。
- post_cor_candidate: yes，先落实可复现窗口的拒绝，再明确完整抗竞态合同。
- suggested_tests: 审批中父目录替换、叶子 symlink、正常新建三组；不能只断言用了 `O_NOFOLLOW`。

### DS-CHECK-SEC-001 — `env -S` 的执行载荷被跳过，项目代码仍自动获批（关联 P0-1/P0-2）

- severity: P1
- status: open
- issue_evidence: confirmed；分类探针加真实无害执行。
- lane: code/security
- scope: pre-existing，当前 wrapper 分类补强未闭合。
- affected_files: [shellPolicy.js:72](/Users/adib/Documents/Deecoo/src/permissions/shellPolicy.js:72)、[effectiveCommand:282](/Users/adib/Documents/Deecoo/src/permissions/shellPolicy.js:282)、[shell.js:37](/Users/adib/Documents/Deecoo/src/tools/shell.js:37)。
- failure_scenario: `classifyShellCommand("env -S 'node payload.mjs'")` 返回 `allow`。`-S` 的执行字符串被当成普通选项值跳过，得不到实际命令；随后安全等级回落到 allow，shell 工具自动批准。临时目录内 `/usr/bin/env -S "node payload.mjs"` 实际运行 JS 并写出 marker。
- impact: 仓库定义的代码绕过应有的 warn/审批。实际危害仍受当前 OS sandbox 和用户权限约束，不等于无条件突破所有系统隔离。
- reliable_solution: 解析并递归分类 `env -S/--split-string`；不能可靠还原的 wrapper 至少 warn，不应因空命令判 allow。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=该命令至少 warn，真实 `runShell` 必须走审批，明确的版本查询仍按已定义策略处理。
- verification_result: passed；策略 allow，真实无害载荷 exit 0、marker=yes。
- post_cor_candidate: yes。
- suggested_tests: 短/长选项、带引号 split-string、未知 wrapper 参数，以及真实审批回调调用次数。

### N-1 — 局部禁止修改被提升为全任务只读

- severity: P1
- status: open
- issue_evidence: confirmed；直接调用意图推断和实际 task policy。
- lane: code
- scope: pre-existing，已在 HEAD 中存在，不是本轮未提交修复新引入。
- affected_files: [taskIntent.js:15](/Users/adib/Documents/Deecoo/src/harness/taskIntent.js:15)、[taskPolicy.js:6](/Users/adib/Documents/Deecoo/src/permissions/taskPolicy.js:6)、[taskRunner.js:136](/Users/adib/Documents/Deecoo/src/agent/taskRunner.js:136)。
- failure_scenario: `不要修改任何测试文件，只修复 src/agent 的 bug` 被判 `requestType:analysis / mayWrite:false / explicitReadOnly:true`；构造真实 task policy 后，对 `src/agent/loop.js` 的 `write_file` 返回 `TASK_TOOL_BLOCKED`。原报告直接传 intent 时出现 `TOOL_READ_ONLY`，是同一根因的另一条拒绝路径。
- impact: 明确要求修改业务代码的合法任务无法完成；模型声称纠正派生 spec 也无法改变执行层权限。
- reliable_solution: 区分全局只读与路径范围否定；将禁止测试/生成文件等约束传入路径级写入策略，保留其他路径的正向编辑授权。只删除 hardReadOnly 规则会丢失禁止改测试的保护。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，需贯通意图、路径策略和各种文件写工具；verification=允许修改 src，禁止 test/生成文件，全局只读仍拒绝所有写操作。
- verification_result: passed；三个正反例与工具策略均已运行。
- post_cor_candidate: yes。
- suggested_tests: 中文局部否定+正向修改、英文等价表达、纯只读，以及 E2E 篡改测试文件必须失败。

### N-5 — 取消存在两条缺口：raw mode 的 Ctrl-C 按键未接线，第二次信号无升级

- severity: P2
- status: open
- issue_evidence: confirmed；真实 CLI 的 PTY 与非交互子进程分别复现。
- lane: errors
- scope: pre-existing。
- affected_files: [cli.js:344](/Users/adib/Documents/Deecoo/src/cli.js:344)、[cli.js:359](/Users/adib/Documents/Deecoo/src/cli.js:359)、[cli.js:361](/Users/adib/Documents/Deecoo/src/cli.js:361)。
- failure_scenario: 任务运行时设置 raw mode，但 keypress 只处理 Esc。真实 PTY 写入 Ctrl-C 字节后，合成 provider 的 AbortSignal 没有触发；外部发送 SIGINT 才触发。另一个有意忽略 AbortSignal 的合成适配器，在两次外部 SIGINT 后仍存活，最终由探针 SIGKILL 清理。
- impact: Ctrl-C 按键不能按用户预期取消运行任务；对不响应取消的异步适配器没有第二次信号的退出通道。正常 shell 后代清理测试通过，不能把所有取消都描述成失效。
- reliable_solution: 将 raw keypress 的 Ctrl-C 接到相同取消入口，首次取消等待清理；再次明确中断时升级退出，必要时带有界清理看门狗和退出码。纯同步阻塞 JS 无法及时运行任何此类回调，不应声称加 `process.exit` 分支能解决这种情况。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low/medium，需兼顾退出与后代清理；verification=真实 PTY Ctrl-C 触发 signal，协作适配器清理完成，忽略取消的异步适配器第二次中断可退出。
- verification_result: passed；PTY `rawModeAtRequest:true / ctrlCKeyAborted:false / externalSIGINTAborted:true`；非交互 `aliveAfterSecond:true`。
- post_cor_candidate: yes。
- suggested_tests: raw Ctrl-C、Esc、第一次 SIGINT/SIGTERM 的清理、第二次信号升级；保留现有后代不再写入的断言。

### N-4 — Review 的最低证据门槛无法兑现明确的完整范围审查

- severity: P2
- status: open
- issue_evidence: confirmed；coverage 和实际 final validator 均已调用。
- lane: code
- scope: pre-existing。
- affected_files: [reviewReport.js:39](/Users/adib/Documents/Deecoo/src/reporter/reviewReport.js:39)、[reviewCoverage:64](/Users/adib/Documents/Deecoo/src/reporter/reviewReport.js:64)。
- failure_scenario: 请求 `完整审查 @a.js 的所有代码`，只有该文件的 truncated read，仍得到 `errors:[]` 且 final validator `ok:true`。没有任何文件证据、只提供 `text` fence 中的 `Build failed yesterday`，也可被视为 source evidence，通过空 findings 的门槛。
- impact: 缺少可验证来源或未覆盖用户明确范围时，仍能完成结构化 review。普通抽样审查允许 partial 不一定有错，问题是没有区分用户请求范围与实际覆盖能力。
- reliable_solution: 让覆盖策略区分完整文件、指定片段、diff 与抽样；来源和范围要可核对。不能仅把所有 `partialFiles` 无条件塞进 errors：本轮证明“先部分读、后全文读”仍永久留在 partialFiles，且范围阅读本来就可能满足片段审查。也不应通过语言白名单一概排除合法 YAML、配置或 diff 审查。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，需要先定义覆盖合同并合并同版本阅读范围；verification=明确完整范围未覆盖时拒绝，补全读取后放行，合法片段/配置审查放行，无源证据日志拒绝。
- verification_result: passed；上述 partial、log-only 两种 final validator 均返回 true；补全读取后 partial 标记仍不消失。
- post_cor_candidate: yes，需按范围合同实现，原报告的一刀切修法不适合直接采用。
- suggested_tests: 全文/片段/diff/配置/日志五类来源，以及部分读后补全的恢复。

### C-2 — 完整压缩摘要仍丢失较早失败诊断

- severity: P2
- status: open
- issue_evidence: confirmed；同一历史、两个预算的对照探针。
- lane: code
- scope: pre-existing，§十五只修了 compact fallback。
- affected_files: [loop.js:621](/Users/adib/Documents/Deecoo/src/agent/loop.js:621)、[compactionSummaryBodies:641](/Users/adib/Documents/Deecoo/src/agent/loop.js:641)、[state.js:112](/Users/adib/Documents/Deecoo/src/agent/state.js:112)。
- failure_scenario: 一次 `npm test` 失败后又有 12 次读取。`maxChars:2500` 时先接受的完整摘要为 1018 字符，已无失败诊断标记；`maxChars:1000` 时 592 字符的精简摘要反而保留该标记。agent state 本身在两次探针中均仍保存失败。
- impact: 原始消息被压缩后，模型可能缺少修复所需诊断，导致重复检查或停滞。验证状态机仍保留失败，未证明可因此错误通过验收。
- reliable_solution: 两种候选摘要共用有界失败块，保留命令、状态和诊断片段；不应无限保留全部 stderr。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=同一历史强制 full/compact 两种候选，都包含失败诊断。
- verification_result: passed；full `retainedFailure:false`、compact `true`。
- post_cor_candidate: yes。
- suggested_tests: 失败后出现多次成功读取，两种预算、再次压缩后仍保留必需诊断。

### DS-CHECK-RETRY-001 — 内部 429 重试没有及时触发共享冷却（关联 §六 O-3）

- severity: P2
- status: open
- issue_evidence: confirmed；无网络的双 caller 探针。
- lane: errors
- scope: pre-existing，合并重试后的残留。
- affected_files: [retry.js:24](/Users/adib/Documents/Deecoo/src/llm/retry.js:24)、[rateLimiter.js:45](/Users/adib/Documents/Deecoo/src/llm/rateLimiter.js:45)、[rateLimitClient:67](/Users/adib/Documents/Deecoo/src/llm/rateLimiter.js:67)。
- failure_scenario: 第一个请求内部收到 429、Retry-After=100ms，进入 withRetries 的等待。外层 limiter 只在最终异常外抛时获知 429，因此此刻 `cooldownUntil:0`，第二个 caller 直接派发。记录顺序是 first→second→first。
- impact: 单请求遵守 Retry-After，但多个 worker 不共享该次冷却，仍可能继续触发限流。
- reliable_solution: 在每次尝试收到 429 时通知共享 limiter，而不是只依赖最终 catch；流式/非流式路径保持一致。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=第一 caller 收到 429 后，新 caller 在共享冷却期内不能派发。
- verification_result: passed；合成响应复现，未真实请求 provider。
- post_cor_candidate: yes。
- suggested_tests: 并发两个 caller、内部重试成功、重试耗尽、取消等待四种情况。

### DS-CHECK-COST-001 — 单边价格覆盖被视为完整定价（关联 P1-1）

- severity: P2
- status: open
- issue_evidence: confirmed；计价与预算 ledger 探针。真实超支影响有条件：缺失一侧实际收费，而不是用户有意指定免费。
- lane: code
- scope: pre-existing。
- affected_files: [cost.js:15](/Users/adib/Documents/Deecoo/src/harness/cost.js:15)、[cost.js:25](/Users/adib/Documents/Deecoo/src/harness/cost.js:25)、[taskRunner.js:291](/Users/adib/Documents/Deecoo/src/agent/taskRunner.js:291)。
- failure_scenario: 未知模型只设置 `pricePromptPerM:1`，`isModelPriceKnown` 就返回 true，completion 价格自动补 0；100 万 completion tokens 估价 0，0.01 USD 预算不停止。
- impact: 遗漏价格与明确免费没有区分，成本保护可能少计。普通“无任何定价”的模型已被 COST_BUDGET_UNPRICED 拦截，不能说整项修复无效。
- reliable_solution: 未知模型开启成本预算时要求两侧价格明确提供，允许显式 0；已知模型部分覆盖时保留另一侧内置价格。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=未知模型漏一侧拒绝、两侧显式定价放行、显式免费和已知价格覆盖保持清晰。
- verification_result: passed；合成 token ledger 记录后 estimated=0、stopped=null，无真实花费。
- post_cor_candidate: yes，实施时明确“缺失”与“免费”的配置合同。
- suggested_tests: 两种单边覆盖、显式双零、完整价格、已知模型单边覆盖。

### N-2 — 兼容数组投影未统一 sourceComplete 契约

- severity: P3
- status: open
- issue_evidence: confirmed；直接 helper 与实际 runtime 的对照探针。
- lane: code
- scope: pre-existing，局限于兼容/自定义调用路径，正常 CLI 影响未被证明。
- affected_files: [projection.js:41](/Users/adib/Documents/Deecoo/src/tools/projection.js:41)、[runtime.js:284](/Users/adib/Documents/Deecoo/src/tools/runtime.js:284)、[modelOutput.js:30](/Users/adib/Documents/Deecoo/src/tools/modelOutput.js:30)。
- failure_scenario: 默认 helper 将 85 条 matches 裁成 80 条并置 truncated，但输入 sourceComplete=true 时保留 true，输入省略时字段仍缺失。两种结果可同时成立，§十八的省略字段探针并未推翻§十六的显式 true 探针。
- impact: 兼容投影消费者可能遇到矛盾字段；不能由此认定正常 CLI 去重/Review 门禁失效。真实 runtime 使用 truncate:false，85 条搜索仍投影 85 条；60KB read 超最终字节预算时，由统一输出层返回 sourceComplete=false、truncated=true 和 outputRef。
- reliable_solution: helper 发生数组截断时同步置 sourceComplete=false；保留 runtime 原有按字节 spill 行为。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=已有 true/省略两种输入均变 false，正常 runtime 输出合同不变。
- verification_result: passed；两种 helper 输入和真实 runtime 搜索/长文件路径均已验证。
- post_cor_candidate: yes。
- suggested_tests: helper 字段一致性，加正常 runtime 超字节预算后的可检索输出断言。

## 原始条目逐组结论

以下“已修复”仅指条目描述的路径，不表示所有输入空间已被穷尽验证。

- **P0-1**：原始自动执行项目代码问题真实；常见命令已改 warn，但 SEC-001 表明仍未闭合。其常规风险宜按 P1 评估，不能仅凭存在 allow 等级就称 P0。
- **P0-2/P0-3**：底层隐藏载荷问题真实，但原文示例严重失真。对 `7f1eb39` 的纯分类探针，三个 bash 示例分别是 warn/block/block，命令替换和变量两个示例为 warn/block，并非全 allow。§十五勘误正确；换用的真实绕过例子基线是 allow、当前是 warn/block。
- **P0-4**：原问题真实，当前白名单修复成立。12 个影响权限、网络、endpoint、预算、价格、HOME/CWD 的项目 .env 变量全部被忽略并有 notice。
- **P0-5**：旧 Xcode profile 确实阻断 Apple git；当前 fresh seatbelt 已修复。见下一节对阶段归因的纠正。
- **P1-1**：未定价模型且显式成本预算的普通路径已修复，模型派发前拒绝；单边覆盖残留见 COST-001。
- **P1-2 / M-1**：原始存盘凭据和按 token 标识符过度脱敏问题有旧源码依据；当前 standard 模式按值脱敏及代码/数值指标保留已落实。它不能识别所有未知、任意形状的秘密；例如未注册短值 `apiKey:"abc"` 在按值保存路径仍可能保留。
- **P1-3**：常见长会话按容量裁剪旧 history，并保留约束；recordTurn 失败不再直接推翻已完成任务。最近几轮本身超容量仍可能持久化失败，不能宣称所有容量错误消失。
- **P1-4**：npm eval 入口现在带 --execute，默认执行当前 16 个本地 scripted E2E。原“reports 被 Git 跟踪”不成立，该目录已 gitignore；--no-report 可避免写入。
- **P1-5**：off-by-one 原判断错误，step 从 1 开始；重复观察已有连续四步 no_progress 停止。该机制不是对所有语义停滞的通用检测。
- **C-1**：前一次压缩摘要中的引用已重新收集，二次压缩回归通过；仍是最后 8 个引用的有界保留，不是无限历史引用承诺。
- **C-2**：部分修复，完整摘要残留已确认，见上。
- **C-3/C-4**：原结论不足。估计器实际按 UTF-8 字节计算，不能从 MAX_LIVE_MESSAGE_CHARS 推出中文严重低估；无 assistant 的初始前缀没有可安全压缩的执行历史，不是已证明的 resume 缺陷。
- **H-1/H-2**：正常 journal 真追加、损坏中间行跳过统计已经实现。原“一次半写永久丢全部事件”夸大，旧实现本已容忍不完整末行；容量上限仍存在。
- **H-3/H-4**：workflow/acceptance 的恢复元数据已重置；恢复总会使验证失效，原“沿用陈旧通过结论”的后果不成立。缺少精确 workspace baseline 比较仍是能力边界，不能说已具备此能力。
- **H-5/H-6**：原推测不成立。resume 保留 runId/taskId；别的 run 的引用被拒绝属于 owner 边界。并发合并先合并权威 history 再重建 summary，不是仅保留 1000 字 legacy summary。
- **E-1**：叶子 nofollow 补强真实，但父目录问题仍在，见 SEC-002。
- **E-2**：range 已进入签名，范围读取不再替代完整 pin；已修。仅见到 ALREADY_AVAILABLE 不足以证明范围读取死锁。
- **E-3/E-4**：兼容 helper 的 continuation/数组类型问题已改进；原报告未追到正常 runtime 的 truncate:false 和最终 outputRef spill，扩大了实际影响。N-2 是另一个较小契约残留。
- **E-5**：eval 已支持 required change-size，当前 8 个任务设上限；这不是所有产品编辑都强制达到全局最小改动的证明。
- **V-1**：scripted 不能证明真实模型能力，这个边界判断正确；provider benchmark、providerEligible 消费和手动 provider CI 早已存在，“没有 provider 评测实现”错误。没有提交 reports 也不能证明没有运行，因为目录被忽略。
- **V-2**：grader 改版前后均分变化，不能证明相同输入下评分不稳定；真实模型质量和跨版本可比性仍需版本化数据与实测，不由 scripted 100 分保证。
- **V-3/V-5/V-6**：已改为按位置/证据/严重度匹配而非强制自定义 finding ID；恢复后才执行修复；五类场景补齐独立断言。原 V-6 也不等于完全没有场景约束，旧 summary.failed 已消费各 grader。
- **V-4**：仅部分补齐 E2E 范围，新增压缩任务实测压缩 5 次；流式、限流等仍未全部变成对应 E2E。相关单元/集成测试存在，不能称完全没覆盖。
- **§六 O-1/O-5/O-6**：没有证实逐行重复 500 token、多个完成裁决相互矛盾或所有 expected 护栏未接线。静态协作协议和动态任务元数据职责不同；E2E 刻意不用 trace 的工具选择期待卡住合法等价方案，真实护栏是 execution.checks/expectedRun。模块行数本身不能证明过度设计。
- **§六 O-2/O-3/O-4**：S-COR 已条件注入；重试已抽公共实现但共享冷却残留见 RETRY-001；schema 指纹缓存和请求指纹去重已经实现。无负载测量不能把必要的请求复制/冻结直接认定性能缺陷，也不能把缓存优化理解成零复制。
- **M-2**：已增加哈希链，能发现部分局部改写；§十五明确“哈希链、不是签名”正确。同权限攻击者仍可重写整链和 head，它不是外部可信的合规防篡改证明。
- **M-3**：未证实。durable supervisor 在 CLI 退出后继续存在是设计；通过 nonce/stop 文件仍可控制，普通 run 有超时。supervisor 自身死亡或跨平台逃逸后代未做真实崩溃验证，不列已修，也不列确认漏洞。

## 阶段审查结论哪些正确

### 第十五节：大多数勘误正确，完整关闭问题的措辞过强

对 shell 示例、step 起点、UTF-8 估算、providerEligible、末行容错、恢复验证失效和通用/动态协作提示的更正，均有代码或探针支持。存储、resume、eval 入口、重试抽取等实现也确实存在。但 C-2、E-1、项目代码审批、完整定价及共享冷却仍有上文残留，不能只因对应 REVIEW-* 测试变绿就称该问题输入空间已完全覆盖。

### 第十六至十八节：N-1/N-4/N-5 有依据，N-2 需降级，N-3 未达到缺陷证据门槛

- N-1 真正会阻断授权编辑；属于已在 earlier harness 改动中存在的问题，不能归因到本轮复核新增代码。
- N-4 的证据/范围薄弱真实，但不能据此推翻 INTREVIEW-001 的“Review 必须完成显式 requiredChecks”修复。`taskRunner.js:295-303` 仍合并 review 与 task acceptance 两个验证器；它们是不同合同。
- N-5 的二次信号残留真实，且本轮补出了 raw Ctrl-C 按键的问题；这不推翻首次信号能清理 shell 后代的已通过回归。
- N-2 的 helper 字段不一致真实，建议 P3；§十八的无字段输入和§十六的显式 true 输入不构成互相证伪。
- N-3 未证实。workspaceRevision 记录所有命令，validationRevision 不让已识别的检查互相作废。实际生产 reset 在新任务开头，resume 随后恢复 ledger 并创建/重建验证状态；没有找到“独立 reset+复用旧验证”的产品入口。探针中 workspaceRevision=3、validationRevision=1 时两个检查正确 fresh；resume 后两者=4、旧检查均 stale，编辑后也 stale。不能仅凭数值不同判明确缺陷，更不能直接把两者改成 Math.max。

### P0-5 与 D-2：新建 Deecoo 沙箱修复有效，外层沙箱不能作为反证

同一宿主、同一临时工作区、相同显式 `/usr/bin/git --version && /usr/bin/git init -q . && /usr/bin/git rev-parse --git-dir`，内部均 enforced=true：

- 读取 HEAD 7f1eb39 的旧 sandbox 模块生成新 seatbelt：exit 1，复现 libxcrun sandbox blocked open。
- 读取当前工作树模块生成新 seatbelt：exit 0，输出 Apple Git 2.54.0 和 .git，stderr 为空。

此对照未使用 Homebrew 替代 Apple git。默认 Codex 外层受限进程的 sandbox_apply EPERM 只说明该父层不允许再次启用 seatbelt。工作区修改不能改变既有父层限制；“只要还有外层限制，所以产品新配置修复未生效”是错误归因。仅从 open 被拒也不能断定必然是旧进程 profile，还可能是多层限制叠加。

禁止嵌套时跳过新 sandbox 测试是合理 capability 处理，不能说“唯一可复现环境永远测不到”；宿主能启动新子 sandbox，且本轮已经验证。**真正的覆盖缺口是 deterministic CI 只有 Ubuntu，没有 macOS 宿主 job**。建议增加 macOS 严格 gate、明确 skip 原因，不要为了消除 skip 放宽网络/文件隔离。

### 第十八节其他需要更正的结论

- **18.12 脱敏归因**：当前直接探针保留 token 指标与源码，撤回“这些输入被 audit 过度脱敏”合理；但它不能证明历史会话掩码必来自宿主。不同 registry、输入形态、预先脱敏或历史文件尚未排除。应写“本次未确认项目缺陷，掩码来源未定位”。原始 M-1 的旧源码缺陷与后续 O-1 的当前归因应分开。
- **18.13 git 失败伪装 clean**：不适用于现有 git_status/git_diff 实现。execFile 非零会 reject，工具 catch 返回 ok:false；临时 fake-git exit 72/stderr 的探针验证了这点。CLI 分支展示为空不等于宣布 clean。shell 管道可能隐藏前段退出码是另一条路径，不能移植为工具函数漏洞。
- **18.14 测试运行器**：挑选可用 git 并保留 node --test 的参数/退出码，是合理的测试环境适配；它不修产品的 shell，也不能单凭它变绿证明沙箱已修。`test-*` 脚本误被默认发现的风险是真实教训，但改名解除自发现不等于发现了新的产品漏洞。
- **§十七/十八 O-2**：README 的“本次 0.1.1”措辞陈旧，包是 0.1.6，宜改为示例或当前版本。这是文档 P3，不证明当前安装版本检测失效。
- **§十七/十八 O-3**：eval:e2e 是已记录且现有 CI 仍使用的兼容别名，保留不构成缺陷；不能为了“无冗余”直接删除入口。
- **§十七/十八 O-4/O-5**：字符串断言只能保护 npm 脚本参数，覆盖弱但并非无效；还有真实 CLI execute/trace 回归。应补对应范围/门禁行为断言，而不是由“只查字符串”推断产品行为错误。
- **D-1/R-1/R-2**：不同版本、不同外层限制及 PATH 下的测试数字应各自绑定快照与命令，不应相互替换。旧的 388 项历史验收不因新增到 578 项自动失效；未标环境的同轮冲突记录则需要补充。按 ID 逐项对账合理，但把别名、设计边界、未复验推测与确认产品缺陷合成“12 条中 9 条”不可靠。
- **不跑 eval 的理由**：§十六/十八称需付费、长跑且必写 reports，不符合现有实现。普通 eval 是本地 scripted，支持 --no-report，本轮完整运行成功。真实 provider benchmark 才需另行明确预算，二者不可混为一谈。

## Scope And Snapshot

- repository: `/Users/adib/Documents/Deecoo`。
- revision/base: `7f1eb3946aefde5df6ae211bfa0d95f6e2f9c4e1`（main，包版本 0.1.6），加本轮开始前已有未提交改动；不是只审 HEAD。
- working-tree fingerprint: 复核报告创建前，对 git 已跟踪及未忽略未跟踪文件共 244 项，按路径排序的 `[path, sha256(contents)]` 数组再作 SHA-256，结果 `11800abc9e7ff2dd9744eb7140fa9a8baf3e462b58ec37177aad6f975e500630`。清单保存在 `/private/tmp/deecoo-recheck-snapshot-20261022.json`。本报告本身不参与该输入指纹。
- context: macOS、Node v24.22.1、npm、ESM；未在本轮重跑 Node 20/22 或 Windows/Linux 矩阵。
- inspected: 原报告原始 P0/P1、C/H/E/V/O/M 条目及§十五至十八新增 N/D/R；核对相关调用链、测试和新鲜沙箱；三条独立只读通道分别复核安全、状态/存储、eval/循环，主审复核任务意图、Review 与 CLI 信号并整合证据。
- limitations: 没有真实 provider 模型质量验收，没有全平台异常崩溃回收测试，没有把历史进程的已加载 profile 当成可重新获得的现场。现有确定性测试全绿不能排除本文已用探针确认的遗漏路径。

## 验证记录与复现入口

全部测试在日志记录真实退出码，未通过 tail 等管道把前段失败伪装成功。完整单元测试和 E2E 使用可启动新 sandbox 的宿主权限，内部 Deecoo 隔离测试仍真实启用。

- `npm run check`：exit 0。
- `npm test`：exit 0，578 项，577 通过，0 失败，1 跳过。唯一跳过是“OS backend 不可启动时 required fail-closed”场景，原因是本次 OS backend 可用；实际 OS 隔离与 Apple git seatbelt 用例均通过。
- `npm run eval -- --no-report --fail-on-failed --json`：exit 0，harness-e2e 16/16；compaction 任务发生 5 次压缩，interruption-resume 从 interrupted checkpoint 恢复后完成修复。
- `npm run eval:trace -- --no-report --fail-on-failed --json`：exit 0，trace-grader 4/4。
- `git diff --check`：exit 2，指出既有未提交改动中 `src/llm/anthropicClient.js:340`、`src/llm/deepseekClient.js:182` 的末尾空行。244 项原始文件指纹逐项复核均未改变，本轮未顺手格式化这些文件。
- 定点探针：策略、外部临时写入、成本 ledger、真实 runtime 投影、revision/resume、压缩候选、共享冷却、真实 CLI PTY/外部信号均执行；其成功断言部分专门用于证明缺陷存在。

可重跑脚本（均为本机临时证据，长期保存应连同报告归档；不假定 /private/tmp 永久存在）：

- [主审 N-1/N-4/N-5 与快照探针](/private/tmp/deecoo-review-verification-20261022.mjs)，[JSON 结果](/private/tmp/deecoo-recheck-probes-20261022.json)。
- [真实 PTY Ctrl-C 探针](/private/tmp/deecoo-recheck-tty-20261022.py)，[JSON 结果](/private/tmp/deecoo-recheck-tty-20261022.json)。
- [安全/计价/旧新分类/工具 git 错误探针](/private/tmp/deecoo-review-security-20261022/verify-policies.mjs)，[结果](/private/tmp/deecoo-review-security-20261022/policies.jsonl)。
- [新建 sandbox 对照脚本](/private/tmp/deecoo-review-security-20261022/verify-sandbox.mjs)，[fresh 宿主结果](/private/tmp/deecoo-review-security-20261022/sandbox-fresh-escalated.jsonl)，[外层限制结果](/private/tmp/deecoo-review-security-20261022/sandbox-default.jsonl)。
- [状态/实际投影/压缩对照探针](/private/tmp/deecoo-state-review-probe-20261022.mjs)，[结果](/private/tmp/deecoo-state-review-probe-20261022.log)。
- [共享限流探针](/private/tmp/deecoo-review-retry-probe.mjs)，[执行记录](/private/tmp/deecoo-review-retry-probe.log)。
- [完整单元测试日志](/private/tmp/deecoo-recheck-unit-20261022.log)、[E2E 输出](/private/tmp/deecoo-recheck-e2e-20261022.json)、[trace 输出](/private/tmp/deecoo-recheck-trace-20261022.json)、[语法检查日志](/private/tmp/deecoo-recheck-syntax-20261022.log)。

建议实施顺序：SEC-002、SEC-001、N-1；随后 N-5、N-4、C-2、RETRY-001、COST-001；最后 N-2、macOS CI 与文档措辞。M-3、真实模型质量和其他未复现边界继续列为未证实/未验收，不能悄悄改成已修复。
