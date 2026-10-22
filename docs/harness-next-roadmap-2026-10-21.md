# Harness 下一阶段完善路线

评估日期：2026-10-21。目标：`/Users/adib/Documents/Deecoo` 当前工作树；基线 HEAD 为 `50e809d8a286662d42e8d462b2c9772d9f2dd30d`，包含上一轮尚未提交的实现。源码快照沿用上一轮最终验收 `9a7cfd44ddb291a79aa6fa77120a088fecbbe7eb0d41304222144e9b78c4b039`。本轮未编辑产品代码，也未调用真实 provider。

当前已有基本任务闭环、权限交集、执行效果、版本失效、恢复及离线端到端回归。下一步应优先提升真实任务的执行和验收保证，再扩展生态。以下明确区分已确认缺陷和尚未实现的产品能力；上一轮 305 项回归通过不能代替本轮新增场景。

## 已确认、应优先修复

### NEXT-001 — Shell 取消后子孙进程可能继续产生副作用

- severity: P1
- status: open
- issue_evidence: confirmed；独立执行路径审查及 461 ms 合成临时工作区复现，取消返回后 grandchild 仍写 marker；复现创建的两个进程已清理。
- lane: errors
- scope: pre-existing（当前工作树）
- affected_files: [shell.js:49](/Users/adib/Documents/Deecoo/src/tools/shell.js:49)，runShell → child_process.exec。
- failure_scenario: 允许执行的命令启动后代，任务取消/超时通过 signal 终止直接进程，但未管理任务进程组及后代退出；工具已返回失败，后代仍继续运行。
- impact: 中断后仍可能写项目文件、持有端口和资源；用户无法把“已取消”视为副作用停止边界。
- reliable_solution: 在统一 ExecutionBackend 管理平台进程组/进程容器及身份；取消时 TERM、有限宽限期、KILL，并等待受管进程树退出后发布终态。对无法确认清理的状态单独报告，不误报 stopped。平台行为分开实现和测试。
- solution_fit: suited=yes（Shell 是集中入口）；executable=yes；affordable=yes；cost=medium/high（平台生命周期及异常测试）；verification=受管父进程、普通后代、忽略 TERM 后代均停止，取消返回后合成 marker 不再变化。
- verification_result: passed（复现证明缺陷，并非修复通过）；没有运行真实构建或外部命令服务。
- post_cor_candidate: yes，有集中根因和可执行验收。
- suggested_tests: 临时目录与自建短寿命进程树，取消/超时两条路径、强杀及进程身份复用保护；测试结束清理全部自建进程。

### NEXT-002 — 完成验收尚未表达用户要求的具体结果及检查充分性

- severity: P2
- status: open
- issue_evidence: confirmed；实际 TaskContract、验证状态及最终 validator 的纯函数复现。
- lane: code
- scope: pre-existing（当前工作树）；关联 HARNESS-001/010 的后续语义完善。
- affected_files: [taskSpec.js:18](/Users/adib/Documents/Deecoo/src/harness/taskSpec.js:18)、[finalValidation.js:37](/Users/adib/Documents/Deecoo/src/harness/finalValidation.js:37)、[verification/state.js:74](/Users/adib/Documents/Deecoo/src/verification/state.js:74)、[planner.js:18](/Users/adib/Documents/Deecoo/src/verification/planner.js:18)。
- failure_scenario: 请求 `Run npm test`，仅记录 `commandsRun=['pwd']` 仍通过最终 gate；明确要求 test 与 check 时，仅一项 check 新鲜通过也可完成；条件修复允许“已解决则无需修改”时，正向修复关键词仍可能强制要求编辑。
- impact: 一项检查通过无法证明全部需求完成，合理无修改结果可能被错误拒绝，任务仍需人工重新判断验收是否充分。
- reliable_solution: TaskContract 增加结构化 acceptance、requiredChecks、目标/范围及允许的完成类型（modified/no-change/partial/blocked）。每项检查有稳定 ID、目的、必需性、可接受执行路径和证据；按检查目标映射等价命令，并逐项验收。自然语言推导仅填充候选，显式配置及用户约束优先；no-change 必须有现状满足要求的证据。
- solution_fit: suited=yes（已有 taskSpec/planner/finalValidator 分层可扩展）；executable=yes；affordable=yes；cost=medium；verification=错误命令或漏必需检查失败、等价检查成功、已满足需求的合理 no-change 成功、真正失败不能用终稿文字覆盖。
- verification_result: passed（纯函数检查证明上述边界）；本轮没有重跑全套测试或宣称修复完成。
- post_cor_candidate: yes，需先确定 acceptance 数据结构，再增加真实 runTask 集成场景。
- suggested_tests: requested npm test / actual pwd；显式 test+check / 只 check；同一目标等价命令；条件修复 no-change；基线既有失败与本次引入失败分开报告。

## 产品能力路线

### NEXT-003 — 长作业与持久运行时

当前 Shell 仍是 exec 等待返回，默认 30 秒、内存输出缓冲；checkpoint 恢复的是 Agent 状态，没有作业服务。新增 start/status/read_output/stop 作业接口、持续日志与退出契约，持久化 job ID、进程身份和运行归属；模型调用期间、客户端断开后仍可查询。通过显式 TaskRuntimeContext 传 env/cwd/signal/budget/policy/backend，逐步移除全局 env 兼容层。

验收：多分钟构建不阻塞交互，超量日志不因 maxBuffer 失败，重连可查询，两个不同 env/cwd 的任务并发不串值；停止只操作身份匹配的进程。成本 medium/high，先与 NEXT-001 共用后端。

### NEXT-004 — 任务级改动交付、撤销与工作区隔离

当前原生文件工具有写前校验与局部回滚，Shell 只有保守的 revision 失效。补任务开始基线、文件哈希及变更归属、整体 diff、按文件/区块接受或撤销、导出 patch。撤销保留用户原有及之后的改动，冲突显式处理。验证 Worker 可先用独立工作区；并行实现后续采用文件所有权或 worktree。

验收：用户原有 dirty 内容不丢失；任务改动可单独审阅和撤销；外部漂移不覆盖；Shell 引入的持久变更也被记录。成本 medium/high；本地日常编程体验优先。

### NEXT-005 — 系统级文件、网络和资源边界

现有路径与命令策略是应用层约束，cwd 不是执行隔离。给 ExecutionBackend 定义可读/可写根、临时目录、网络范围、凭据及资源限制，按已支持的平台提供受限后端；沙箱不可用时明确能力状态。

验收：脚本内部访问外部合成文件及未许可网络也被阻止，后代继承相同边界；必要项目测试可运行。成本 high。若定位包括不可信仓库或无人值守，这项应提前到最高优先级。文件和网络需要同时考虑，[Anthropic 官方说明](https://www.anthropic.com/research/claude-code-sandboxing)。

### NEXT-006 — 多类型 Eval、真实 provider 基准及 CI

当前三项端到端 case 是同一 addition 修复的三条工具路径。先扩展跨文件功能、多语言、review 真/假阳性、合理 no-change、依赖失败、测试作弊、中断恢复和项目原有失败等场景。把发现的每类真实失败变成独立回归。然后用显式入口运行受预算约束的真实 provider：固定模型/配置/数据集/环境，报告完成率、每成功任务成本、人工介入、失败类别和时延。

确定性测试进入每次变更的 CI；真实模型基准单独运行，避免把随机波动当成确定性回归。验收按最终状态及独立断言，允许等价实现；结果可归因到 prompt/tool/config 版本。成本 medium；真实 provider 有明确可控费用。参照 [Agent Eval 的 task/trial/outcome 区分](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)。

### NEXT-007 — Token 感知的上下文与代码导航

当前 builder/live context 主要使用固定字符预算。补模型窗口与输出预留、分层 token 预算、按任务检索；支持按行/范围读文件、符号/引用导航及文件内容版本。先测大仓库准备耗时、上下文占用、缓存命中、压缩后的约束保留，再决定是否接入 LSP/其他索引。

验收：长文件可按范围完整检查，换小窗口模型也不溢出；跨文件定位正确，外部文件变化使相关缓存失效；压缩不丢关键验收和失败信息。成本 medium。

### NEXT-008 — 存储耐久性与数据治理

当前 checkpoint 已原子替换，但普通 session、memory、audit/output 尚未统一为同一存储契约。补原子写、锁/并发更新、schema 迁移、损坏恢复、任务所有权及可选工具前后事件日志。给历史、原始工具输出、Memory、artifact 提供保留期限、查看/删除、容量限制和隐私模式。

验收：中断写入、双进程写同一会话、旧 schema、损坏文件有可预期行为；删除会话能按明确范围清理关联工件；恢复不会跨任务重复执行副作用。成本 medium/high，先补存储底层再做 UI。

### NEXT-009 — 扩展契约、机器接口与可观测性

统一 ToolRegistry：schema、执行器、能力、超时、信任投影、effects 和版本一起注册；提供稳定 JSON/JSONL 事件与非交互模式，避免插件接入时修改多处 switch。Provider 显式声明工具调用、stream、上下文窗口、usage 和错误能力；增加兼容测试。按实际需求接 LSP、MCP、浏览器和 IDE。

记录 task/run/worker/tool 关联 ID、排队/准备/首 token/执行耗时、重试/限流/压缩/缓存及真实费用。验收：同任务可比较版本与模型，插件仍执行权限交集，机器调用方不依赖终端文案。成本 medium。复杂 Worker 并发优化应在基准证明收益后推进。

## 建议实施顺序

1. 先处理已确认的 NEXT-001、NEXT-002，并补独立回归。
2. 下一批实现 NEXT-003/004 和 NEXT-006 的离线数据集与 CI，形成“能跑长任务、能审阅撤销、能量化退化”的开发版本。
3. 按使用定位安排 NEXT-005，再实施上下文、存储和扩展契约。面向不可信项目时，NEXT-005 提前。

## 范围与验证限制

本轮选择性读取执行/取消、TaskContract、验证、Eval、上下文预算、存储、工具注册和 Worker 路径，并由两名独立代码审查 Agent 分别检查执行与质量契约。Node v24.21.0；项目 ESM、npm、声明 Node >=20。两个缺陷的复现与新增能力建议分别标注，没有把源码阅读当成通过实现验收，也没有重新宣称 305 项测试覆盖所有编程场景。本轮未修改产品源码、未安装依赖、未调用真实 provider、未写 eval/reports。
