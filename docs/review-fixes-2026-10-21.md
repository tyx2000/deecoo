# Deecoo 原十项缺陷修复记录

源审查快照：50e809d8a286662d42e8d462b2c9772d9f2dd30d。用户已授权修复全部原发现；本记录保持 SCOR-001～010 ID。

十项均经当前源码复核及前一轮离线复现确认。修复结果属于当前未提交工作树，不能只用 HEAD 代表。下列回归测试检查修复后的正确行为，原审查目录中的 repro 脚本仍断言旧缺陷，不应当成修复后的通过测试。

## SCOR-001 — 审计正文保留原密钥

- severity: P1
- decision: accepted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: 裸 sk- 密钥整值替换；带标签规则独立处理；审计入口接入 concrete secret registry，并在截断前脱敏。同时为长正文正则增加词边界，避免大量无标签字符引起重复回溯。
- affected_files: [src/observability/audit.js](/Users/adib/Documents/Deecoo/src/observability/audit.js)、[src/agent/taskRunner.js](/Users/adib/Documents/Deecoo/src/agent/taskRunner.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=[test/auditContracts.test.js](/Users/adib/Documents/Deecoo/test/auditContracts.test.js)：嵌套正文原值消失、普通文本保留、非标准凭据和跨截断边界不泄露。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: small
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/auditContracts.test.js](/Users/adib/Documents/Deecoo/test/auditContracts.test.js)：嵌套正文原值消失、普通文本保留、非标准凭据和跨截断边界不泄露。
- remaining_risk: 不会自动清洗历史审计或轮换真实凭据，本次没有读取或修改这些数据。

## SCOR-002 — 任务超时无法中止 Worker

- severity: P1
- decision: adjusted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: deadline 在任务入口创建；父、派发、Worker 局部和预算 signal 合成。取消贯穿授权等待、写前检查、Shell 批准持久化和终端提示；并行 Worker 收敛后才返回，多文件补丁取消使用已有回滚。
- affected_files: [src/agent/taskRunner.js](/Users/adib/Documents/Deecoo/src/agent/taskRunner.js)、[src/agent/loop.js](/Users/adib/Documents/Deecoo/src/agent/loop.js)、[src/agent/subagents/runtime.js](/Users/adib/Documents/Deecoo/src/agent/subagents/runtime.js)、[src/tools/runtime.js](/Users/adib/Documents/Deecoo/src/tools/runtime.js)、[src/tools/files.js](/Users/adib/Documents/Deecoo/src/tools/files.js)、[src/tools/shell.js](/Users/adib/Documents/Deecoo/src/tools/shell.js)、[src/cli/prompter.js](/Users/adib/Documents/Deecoo/src/cli/prompter.js)、[src/terminal/select.js](/Users/adib/Documents/Deecoo/src/terminal/select.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=[test/budgetIntegration.test.js](/Users/adib/Documents/Deecoo/test/budgetIntegration.test.js)、[test/workerCancellation.test.js](/Users/adib/Documents/Deecoo/test/workerCancellation.test.js)、[test/toolCancellationContracts.test.js](/Users/adib/Documents/Deecoo/test/toolCancellationContracts.test.js) 及新增授权取消测试：截止后不启动后续写入，正常授权仍可完成，取消的提示释放监听。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: medium
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/budgetIntegration.test.js](/Users/adib/Documents/Deecoo/test/budgetIntegration.test.js)、[test/workerCancellation.test.js](/Users/adib/Documents/Deecoo/test/workerCancellation.test.js)、[test/toolCancellationContracts.test.js](/Users/adib/Documents/Deecoo/test/toolCancellationContracts.test.js) 及新增授权取消测试：截止后不启动后续写入，正常授权仍可完成，取消的提示释放监听。
- remaining_risk: 已经提交给操作系统的文件 I/O 无法撤销；写入前检查取消，避免向单次 writeFile 注入中途 abort 导致半写。完整真实 TTY 交互还需实机验证。

## SCOR-003 — Worker 用量未纳入任务预算

- severity: P1
- decision: adjusted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: 父子共用任务级用量账本，汇总最终结果、AgentState 和 checkpoint；Worker 局部统计单独保留；部分失败响应的 usage 同样计数。启用总预算时串行发起模型请求，无预算保留并发，耗尽后广播停止；补齐 Worker 局部 token 环境配置。
- affected_files: [src/harness/budget.js](/Users/adib/Documents/Deecoo/src/harness/budget.js)、[src/agent/loop.js](/Users/adib/Documents/Deecoo/src/agent/loop.js)、[src/agent/subagents/runtime.js](/Users/adib/Documents/Deecoo/src/agent/subagents/runtime.js)、[src/agent/taskRunner.js](/Users/adib/Documents/Deecoo/src/agent/taskRunner.js)、[src/config/env.js](/Users/adib/Documents/Deecoo/src/config/env.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=[test/budget.test.js](/Users/adib/Documents/Deecoo/test/budget.test.js)、[test/budgetIntegration.test.js](/Users/adib/Documents/Deecoo/test/budgetIntegration.test.js)：5000 token 的 Worker 被计入总数，额度耗尽阻止后续请求/真实写入；续跑、并行、恢复、失败均无重复计量。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: medium
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/budget.test.js](/Users/adib/Documents/Deecoo/test/budget.test.js)、[test/budgetIntegration.test.js](/Users/adib/Documents/Deecoo/test/budgetIntegration.test.js)：5000 token 的 Worker 被计入总数，额度耗尽阻止后续请求/真实写入；续跑、并行、恢复、失败均无重复计量。
- remaining_risk: 最多一个已发请求可超额，属于客户端预算而非服务端扣费上限。缺失 provider usage 或未知价格时无法保证精确费用。

## SCOR-004 — CLI 失败仍退出 0

- severity: P2
- decision: accepted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: 保留完整任务结果和失败原因；单次 CLI 成功 0、失败 1、超时 124、中断 130。异常路径保留 usage 并写入失败 audit/output；仅成功清理 checkpoint，交互模式继续可用。
- affected_files: [src/agent/taskRunner.js](/Users/adib/Documents/Deecoo/src/agent/taskRunner.js)、[src/cli.js](/Users/adib/Documents/Deecoo/src/cli.js)、[src/cli/exitStatus.js](/Users/adib/Documents/Deecoo/src/cli/exitStatus.js)、[src/reporter/outputs.js](/Users/adib/Documents/Deecoo/src/reporter/outputs.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=[test/cliExitContracts.test.js](/Users/adib/Documents/Deecoo/test/cliExitContracts.test.js) 使用真实 CLI 子进程和本地 fetch mock，断言 provider 失败、成功及超时退出码；单测覆盖预算和中断映射。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: medium
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/cliExitContracts.test.js](/Users/adib/Documents/Deecoo/test/cliExitContracts.test.js) 使用真实 CLI 子进程和本地 fetch mock，断言 provider 失败、成功及超时退出码；单测覆盖预算和中断映射。
- remaining_risk: 异常路径的工具轨迹仍受现有 runAgent 错误出口能力限制；完整失败状态恢复列入后续设计评估。

## SCOR-005 — 新会话历史重复

- severity: P2
- decision: accepted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: 创建会话时分别复制 turns/history 数组；recordTurn 同时修复旧内存调用者的别名，不按内容去重合法重复输入。
- affected_files: [src/session/store.js](/Users/adib/Documents/Deecoo/src/session/store.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=[test/sessionContracts.test.js](/Users/adib/Documents/Deecoo/test/sessionContracts.test.js)：新建、连续 7 轮、压缩、读盘和继续录入均计数正确。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: small
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/sessionContracts.test.js](/Users/adib/Documents/Deecoo/test/sessionContracts.test.js)：新建、连续 7 轮、压缩、读盘和继续录入均计数正确。
- remaining_risk: 不自动删除已有磁盘历史的重复内容，避免误删合法重复交互。

## SCOR-006 — 流式提前 EOF 被标记成功

- severity: P2
- decision: accepted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: 两个 reader 必须收到有效结束原因及协议终止标记；工具 id/name/对象 JSON 不完整时拒绝返回。INCOMPLETE_RESPONSE 不静默重试，保留已收到 usage。
- affected_files: [src/llm/deepseekClient.js](/Users/adib/Documents/Deecoo/src/llm/deepseekClient.js)、[src/llm/anthropicClient.js](/Users/adib/Documents/Deecoo/src/llm/anthropicClient.js)、[src/llm/streamCompletion.js](/Users/adib/Documents/Deecoo/src/llm/streamCompletion.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=[test/streamCompletion.test.js](/Users/adib/Documents/Deecoo/test/streamCompletion.test.js)：空流、部分文本、未结束工具参数均失败；完整文本/工具流和既有 provider fixtures 继续通过。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: medium
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/streamCompletion.test.js](/Users/adib/Documents/Deecoo/test/streamCompletion.test.js)：空流、部分文本、未结束工具参数均失败；完整文本/工具流和既有 provider fixtures 继续通过。
- remaining_risk: Anthropic 沿用既有 malformed frame 容忍策略；finish_reason=length 的产品处理策略属于后续评估。未连接真实服务验证。

## SCOR-007 — 摘要达到上限后冻结

- severity: P2
- decision: adjusted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: 引入兼容的 summaryState v1：显式用户约束最多 1800 字符、旧摘要最多 1000 字符、剩余空间滚动存最近压缩轮次，最终摘要不超过 6000。首次迁移从完整 history 恢复已压缩轮次的显式约束。
- affected_files: [src/session/store.js](/Users/adib/Documents/Deecoo/src/session/store.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=[test/sessionContracts.test.js](/Users/adib/Documents/Deecoo/test/sessionContracts.test.js)：跨容量后摘要持续更新；新约束移出最近 6 轮仍在上下文；早期显式约束、旧格式迁移和历史完整性。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: small
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/sessionContracts.test.js](/Users/adib/Documents/Deecoo/test/sessionContracts.test.js)：跨容量后摘要持续更新；新约束移出最近 6 轮仍在上下文；早期显式约束、旧格式迁移和历史完整性。
- remaining_risk: 按标记规则识别约束，不等于语义理解；约束区超限按新近保留。只有旧摘要而无完整 history 时，只能保留有界旧摘要前缀。

## SCOR-008 — 审计 token 数值被脱敏为字符串

- severity: P2
- decision: accepted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: 区分已知 token 计数/预算键与凭据键；统计值及其数值类型保留，access_token、refreshToken、apiKey 等继续隐藏。
- affected_files: [src/observability/audit.js](/Users/adib/Documents/Deecoo/src/observability/audit.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=[test/auditContracts.test.js](/Users/adib/Documents/Deecoo/test/auditContracts.test.js)：混合对象中 usage/limits 原样往返、凭据全部脱敏。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: small
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/auditContracts.test.js](/Users/adib/Documents/Deecoo/test/auditContracts.test.js)：混合对象中 usage/limits 原样往返、凭据全部脱敏。
- remaining_risk: 新增统计键应按语义扩展统一规则，避免再次用宽泛 token 子串代表凭据类型。

## SCOR-009 — strict 回放错配与重复响应

- severity: P2
- decision: accepted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: 模型与工具回放共用 createReplayEntries 消费状态；每个 fingerprint/key 按录制顺序消费，严格错配立即拒绝，非严格只消费未用项，兼容并发乱序匹配。工具侧继续保留 REPLAY_MISS 返回契约。
- affected_files: [src/llm/replay.js](/Users/adib/Documents/Deecoo/src/llm/replay.js)、[src/tools/recordReplay.js](/Users/adib/Documents/Deecoo/src/tools/recordReplay.js)、[src/harness/replayEntries.js](/Users/adib/Documents/Deecoo/src/harness/replayEntries.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=[test/replayContracts.test.js](/Users/adib/Documents/Deecoo/test/replayContracts.test.js) 与 [test/toolReplayContracts.test.js](/Users/adib/Documents/Deecoo/test/toolReplayContracts.test.js)：A/B 顺序消费、耗尽拒绝、未知请求拒绝、非严格混合回退及乱序匹配。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: small
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/replayContracts.test.js](/Users/adib/Documents/Deecoo/test/replayContracts.test.js) 与 [test/toolReplayContracts.test.js](/Users/adib/Documents/Deecoo/test/toolReplayContracts.test.js)：A/B 顺序消费、耗尽拒绝、未知请求拒绝、非严格混合回退及乱序匹配。
- remaining_risk: 请求 fingerprint 尚未包含所有工具与采样字段，列入第二阶段评估；模型与工具重复消费问题均已修复。

## SCOR-010 — 搜索词误作 rg 选项并等待

- severity: P2
- decision: adjusted
- outcome: implemented
- issue_evidence: confirmed；源审查复现和当前调用路径均支持。
- change: 使用 -e query -- path，关闭 stdin；流式限制结果数和 1 MiB 输出，达到上限成功返回 truncated。30 秒 timeout，SIGTERM 后 250ms 强制结束；取消和 UTF-8 字节边界有独立处理。
- affected_files: [src/tools/search.js](/Users/adib/Documents/Deecoo/src/tools/search.js)
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=[test/searchContracts.test.js](/Users/adib/Documents/Deecoo/test/searchContracts.test.js)：前导减号、普通正则、无匹配、大输出、字节截断、活动取消及忽略 SIGTERM 的合成进程。
- solution_reliability: high，已有明确根因与正反向回归；已知兼容边界如下。
- patch_scope: small
- verification_result: passed（定向）；全量集成检查见文末。
- regression_protection: [test/searchContracts.test.js](/Users/adib/Documents/Deecoo/test/searchContracts.test.js)：前导减号、普通正则、无匹配、大输出、字节截断、活动取消及忽略 SIGTERM 的合成进程。
- remaining_risk: 字节上限可能返回最后一行的部分文本，明确标记 truncated；未引入全工作区无限搜索。

## 集成验证

npm run check 通过；npm test 253/253 通过（基线 184，新增 69 项）；npm run eval -- --no-report --fail-on-failed 4/4 通过、平均 100；git diff --check 通过。未安装新依赖、未访问真实 provider、未修改 eval/reports 或用户真实会话。

原 SCOR-001～010 均已实现，当前没有原报告项处于 deferred、blocked 或 partially-implemented。完整真人 TTY、真实 provider 和所有支持的 Node 版本仍未做集成验证。

修复之外的新设计缺口、模块取舍和优化路线见后续 harness 评估报告；它们与本记录的原十项缺陷分开追踪。

源码快照指纹（按 src/ 路径和文件内容排序后 SHA-256）：65decd3cf3196c5e28c31c0e8ac0814759c16f49f28454726307cd591d5e30f6。
