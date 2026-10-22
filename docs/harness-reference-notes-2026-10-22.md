# Deecoo Harness 补强的公开实现参考

记录日期：2026-10-22；对应本次工作树，而非只对应 HEAD。这里记录实际阅读的源文件、借鉴的设计和落地位置。没有把项目首页、相似函数名或上轮测试通过当作借鉴/验收证据。本项目实现为独立编写，没有整段移植这些上游源码。

公开参考的版本固定为：

- **Codex**：`openai/codex@a3b685331fc700bec554b2fe2a929a65f4fe1548`；[Apache-2.0 LICENSE](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/LICENSE)、[NOTICE](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/NOTICE)。借鉴概念不改变本项目许可；若日后复制其代码，应保留相应许可证、版权及NOTICE要求。
- **pi**：原 `badlogic/pi-mono` 已重定向至 `earendil-works/pi`，固定 `bd3c9b823762b7383954aa49e13ee350471015fe`；[MIT LICENSE](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/LICENSE)。若日后复制源码，应保留版权和许可文本。

## 逐项参考与落地

| 本次范围 | 具体参考、理念及实现 | Deecoo 实际采用 | 保留差异与边界 |
|---|---|---|---|
| 进程与长作业 NEXT-001/003 | Codex [unified_exec/process_manager.rs](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/core/src/unified_exec/process_manager.rs)：进程ID、输出收集与进程终态分离；活跃执行可返回ID继续查询；输出关闭与父进程退出分开处理。pi [tools/bash.ts](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/tools/bash.ts)：执行操作抽象及取消。 | `src/execution/{backend,worker,processTree}.js`、`tools/shell.js`：独立supervisor、随机job ID及nonce、磁盘日志和字节游标、显式cwd/env、TERM→KILL→清理确认；`start_job/job_status/read_job_output/stop_job`统一权限入口。 | 没有声称复刻Codex PTY/远端exec server。macOS管理普通进程组，主动setsid逃离不保证清理；Linux bwrap使用PID namespace，本机未实测Linux。无确认的清理返回cleanup_unconfirmed。 |
| 验收 NEXT-002 | pi [agent-loop.ts](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/agent/src/agent-loop.ts)：真实工具结果进入循环后再决定回合结束。Codex [tools/registry.rs](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/core/src/tools/registry.rs)：类型化调用及结果边界。 | `harness/acceptance.js`、taskSpec/finalValidation、verification：逐检查ID/target/scope/执行路径/新鲜证据；modified/no-change/partial/blocked；no-change必须有源证据。 | 结构化acceptance是Deecoo新增策略，不称为上游现成实现。自然语言推断有限，显式contract覆盖推断；文字总结不能替代执行。 |
| 改动交付 NEXT-004 | Codex [app-server/README.md](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/app-server/README.md)：运行、线程与终态交付是独立数据。采用“执行结果可检查”的原则。 | `workspace/changes.js`：采样任务开始时实际dirty文件内容/权限/hash；整体、文件、hunk审阅与accept/undo；patch导出；外部漂移三方上下文检测。CLI `changes` 与只读 `task_diff`。 | 没有移植或宣称参考源码中的Git回滚算法。本实现独立；符号链接/特殊文件显示冲突并要求人工处理，文本支持hunk，二进制仅整体决定。空目录不在文件基线内。 |
| Eval与CI NEXT-006 | Anthropic [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)：task、trial、grader、最终outcome分离；检查最终工作区。 | `eval/execution.js`、tasks、benchmark、GitHub workflows：15类离线案例，断言放候选工作区之外；负面案例分别报告回归通过和实际任务成功；真实模型独立显式费用预算入口。 | 确定性脚本通过不等于真实模型能力；未调用付费provider，因此没有真实成功率或每成功任务费用实测。 |
| OS隔离 NEXT-005 | Codex [sandboxing/seatbelt.rs](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/sandboxing/src/seatbelt.rs)、[seatbelt_base_policy.sbpl](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)、[bwrap.rs](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/sandboxing/src/bwrap.rs)：将文件、网络和平台必要权限表达为真实OS策略。另参考[文件与网络隔离的组合说明](https://www.anthropic.com/research/claude-code-sandboxing)。 | `execution/sandbox.js`：macOS Seatbelt/Linux bwrap能力探测；required不可用则拒绝，auto明确返回实际enforced状态；可读/可写/禁止读取根、网络deny/allow和受支持ulimit。 | 策略自行编写。不是通用恶意代码隔离容器；macOS进程组脱离、per-process CPU/openFiles及per-user NPROC限制明示；没有cgroup聚合内存/CPU保证。Windows未提供隔离后端。 |
| 上下文 NEXT-007 | pi [tools/read.ts](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/tools/read.ts)、[truncate.ts](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/tools/truncate.ts)：按范围读取及明确裁切；[compaction.ts](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/compaction/compaction.ts)：为窗口/输出预留并保留有用历史。 | context/builder、files、navigation、loop：按窗口预留输出/安全空间；保守UTF8 byte token估算；按行读取及完整内容hash；外部变更失效；词法symbol/reference导航。压缩保留任务/验收规则和完整工具调用组。 | 不是精确provider tokenizer；词法导航没有类型语义/LSP完备性。必需内容放不下时明确失败，不能静默裁掉约束。 |
| 存储 NEXT-008 | pi [session-manager.ts](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/session-manager.ts)：版本化session与事件记录、持久化边界。 | storage/atomic、governance、session/checkpoints、memory、audit/reporter：同路径跨进程锁，fsync/rename、备份/损坏隔离、schema迁移、run owner、可选工具事件、删除墓碑、TTL/容量/隐私和Memory管理。 | 未移植pi的分支session树/全部事件格式；不把checkpoint恢复等同于副作用重放。redacted/ephemeral的可逆源基线只保留内存。 |
| 扩展/机器协议 NEXT-009 | pi [extensions/types.ts](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/extensions/types.ts)：工具schema/executor、context与生命周期事件；[docs/rpc.md](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/docs/rpc.md)：机器调用和事件流。Codex [tools/registry.rs](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/core/src/tools/registry.rs)：集中调度。 | tools/registry/runtime、runtimeContext/events、llm/capabilities、CLI：统一schema/版本/能力/执行器/协作超时，权限交集；JSON/JSONL非交互；run/task/worker/invocation IDs、时延/usage/费用及错误。 | 本地扩展是受信代码，其能力声明并非恶意插件隔离；必须遵循AbortSignal，超时等待其实际结束。不声称已经接入完整MCP、LSP、浏览器或IDE生态。 |

## 设计判断

没有单一公开的“harness工具认证标准”。本次以可验证的执行与终态、权限闭合、证据验收、可恢复与可审查的改动、受控数据和可重复评估作为工程准则。保留任务contract、执行effects、verification、最终acceptance四个层次：它们分别表达要求、事实、检查新鲜度及完成判断；消除重复权限表/散落dispatch，避免仅以增加流程或prompt提高可靠性的假设。

采用显式RuntimeContext传递任务环境，避免进程全局env交换；仍保留旧isolation辅助API供既有调用方兼容。真实provider能力元数据是适配器声明与配置，不是远端模型自动探测结果；未知模型使用保守窗口且可显式覆盖。

## 验证记录入口

[执行与平台限制](harness-execution-notes-2026-10-22.md)、[验收/Eval/CLI](harness-quality-notes-2026-10-22.md)、[实施进度与未完成项](harness-upgrade-progress-2026-10-22.md)。独立审查中发现的具体缺陷须保留ID和复测记录；最终统一检查以最后一次整树测试为准。
