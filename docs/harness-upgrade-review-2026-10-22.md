# Harness 八项补强交付与自检

2026-10-22（上海时间）。实现对象为当前工作树，包含此前用户授权但未提交的改动；没有reset、丢弃或提交这些改动。HEAD仍为`50e809d8a286662d42e8d462b2c9772d9f2dd30d`。最后一次验证对应package/src/eval JS/test JS内容digest：`c2fc8e58e3f02d52f7509fbb2ceec30d33f1c1e3cd21f92532d76d322cd3a90c`（142文件，按相对路径排序，路径和内容以NUL分隔，排除eval/reports）。文档变更不在digest内。

## 八项交付

| 项目 | 当前实现与验收结论 |
|---|---|
| 1 执行与长作业 NEXT-001/003 | ExecutionBackend、独立supervisor、持久job/log、env/cwd、取消及清理确认已接入Shell和工具注册。普通及忽略TERM后代、中断后marker停止、重连/owner/nonce/资源及作用域回归通过。 |
| 2 结果验收 NEXT-002 | 结构化acceptance/requiredChecks逐项匹配目标、范围、等价路径和revision；no-change/partial/blocked；Review也不能绕过用户检查。实际错误、漏检查和假完成负例通过。 |
| 3 改动交付 NEXT-004 | 自动实际dirty基线，任务和Shell改动采样；文件/hunk接受、撤销、冲突保护、patch导出，CLI管理和task_diff。文本及二进制整体恢复验证通过；符号链接/特殊文件明确报告冲突，空目录不在文件基线。 |
| 4 Eval/CI NEXT-006 | 15类离线E2E及独立外置grader、负例任务成功与回归通过分开；真实provider显式预算入口和手动CI。离线CI配置已添加，未运行远端CI或付费模型。 |
| 5 系统隔离 NEXT-005 | 真实macOS Seatbelt文件/网络/后代边界及项目npm test实测通过；required失败闭合，auto/off实际状态可见。Linux bwrap实现及CI路径存在，本机没有Linux实测；平台/资源限制见下。 |
| 6 上下文 NEXT-007 | 窗口/输出/安全预留、分层保留、必需约束超预算失败、范围读取/内容hash/缓存失效、词法导航和指标；压缩保持完整工具调用组，裁切明确partial。 |
| 7 存储治理 NEXT-008 | session/checkpoint/memory/audit/artifact/output统一atomic/lock/recovery/schema；owner就绪、可选journal、TTL/容量/隐私及管理。跨进程、损坏、删除墓碑、旧schema和隐私回归通过。 |
| 8 扩展与机器接口 NEXT-009 | Registry统一schema/元数据/执行/协作超时，权限交集；JSON/JSONL非交互、本地管理无需APIkey，provider capabilities与run/task/worker/invocation关联。准备/排队/首文本token/执行/重试/限流/缓存/usage费用指标已接入。 |

## 独立审查及修复追踪

三个工作流交叉阅读真实实现，并使用合成临时工作区复现；以下均已修复及复测，未以实现者的说明替代证据。

| ID | 确认问题 | 最终处置与证据 |
|---|---|---|
| CTX-REV-001 | 扩展审批undefined仍执行 | 仅接受明确正向决定，注册分类不能绕过；新增真实runtime回归。 |
| CTX-REV-002 | 投影裁切后仍称完整 | content/数组裁切设置partial标志，保留executor原始证据；新增投影断言。 |
| CTX-REV-003 | 压缩prefix切开assistant/tool协议组 | 恢复时使用历史prefix边界，回退完整组并整组删除；新增无孤立tool_calls断言。 |
| CTX-REV-004 | 邻近hunk批量接受错误冲突 | 全部hunk先按原始snapshot验证定位，再逆序应用；三hunk中接受邻近子集/撤销其余回归。 |
| EXECREVIEW-001 | 真实模型Eval使用无沙箱自动批准 | provider路径required/deny，offline fixture可off；预算/配置合同测试。 |
| EXECREVIEW-002 | 多wrapper预算排队独立可超预留 | 同一ledger共享串行预留；并发budget回归。 |
| EXECREVIEW-003 | scoped check无法经真实工具产生 | run_shell/start_job支持安全cwd，审批前后校验及目录显示；真实runtime scoped-check通过。 |
| EXECREVIEW-004 | SIGTERM退出CLI后同步Shell仍运行 | SIGINT/SIGTERM连AbortSignal并等待清理，退出130/143；fake provider+忽略TERM后代marker回归通过。 |
| INTREVIEW-001 | Review绕过显式requiredChecks | 合并review schema与task acceptance验证；同一原复现现在failed/partial/missing，失败snapshot保留acceptance。 |
| INTREVIEW-002 | private恢复新建内存基线导致失败 | 同进程复用原changeSet；持久化目录从baseline排除且canonical realpath规范化；原中断恢复复现completed，undo恢复原内容。跨进程缺失内存基线明确拒绝。 |

另修复了Git合法path参数schema、research新增工具预期、macOS路径别名check scope、宿主NODE_TEST_CONTEXT/npm假pass、工作区chmod破坏job状态通道、ulimit文件块单位和基线自采样等集成问题。保留前轮SCOR/HARNESS修复；没有用放宽Eval工作区排除或绕过验收来恢复通过。

## 最终验证

- `npm run check`：通过，日志`/private/tmp/deecoo-upgrade-checked.log`。
- `npm test`：**388项，387通过，0失败，1跳过**；日志`/private/tmp/deecoo-upgrade-accepted.log`。跳过是外层沙箱不允许嵌套OS隔离场景。
- 单独实际macOS OS隔离：`node --test --test-name-pattern='OS sandbox blocks' test/executionBackend.test.js`，1/1通过；外层沙箱之外执行，合成外部secret读写、后代访问、localhost连接均拒绝，项目测试允许。
- Trace Eval：**4/4**；报告`/private/tmp/deecoo-upgrade-final-trace/2026-10-21T20-11-04-105Z-summary.json`。
- 离线E2E：**15/15 cases/trials**；报告`/private/tmp/deecoo-upgrade-final-e2e/2026-10-21T20-11-12-529Z-summary.json`。脚本token统计不是付费模型能力或费用估计。
- 未修改`eval/reports`，未安装新依赖，未使用额度重置券或购买额度。

## 能力边界与后续扩展

这些边界是显式交付契约，不称作已验证能力：macOS主动setsid逃离进程组无法保证清理；Linux后端未在本机实跑，Windows无OS后端；不提供cgroup聚合内存/CPU、按域名OS网络代理或PTY/stdin。required隔离不可用时拒绝运行。supervisor被强杀或机器重启不能安全接管未知PID，不重播副作用。

上下文估算是保守UTF8字节上界及预留，不是精确provider tokenizer；find_symbols/references为词法导航。provider capabilities是适配器声明和配置，未知模型窗口保守回退。费用按实际usage和配置单价计算，未知价格/usage不能称真实费用已知；未做付费模型基准。

扩展为可信本地代码，需要遵循AbortSignal，超时等待真实settlement；这不是恶意插件隔离。并发任务应各用独立ToolRuntime；共享workspace的未知写入worker仍串行。MCP/LSP/浏览器/IDE集成不在本次已实现能力之列。

redacted/ephemeral不持久保存可逆源基线，隐私作业日志放临时目录，任务结束停止本实例作业、确认后清理。跨进程无法恢复内存基线时明确报告CHANGE_BASELINE_UNAVAILABLE，可建立新任务基线；原编辑保留。普通模式的job可持续查询。恢复checkpoint不会自动重放未知副作用。

参考理念、精确commit/permalink及许可证见 [参考记录](harness-reference-notes-2026-10-22.md)；详细实现见 [执行](harness-execution-notes-2026-10-22.md)、[质量/CLI](harness-quality-notes-2026-10-22.md)、[上下文/存储](harness-state-notes-2026-10-22.md)。
