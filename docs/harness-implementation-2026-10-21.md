# Harness 改进实施与自检

日期：2026-10-21。对象：HEAD `50e809d8a286662d42e8d462b2c9772d9f2dd30d` 上的当前未提交工作树。原 SCOR-001～010 修复保留；本次落实 [Harness 评估方案](harness-assessment-2026-10-21.md)，随后进行独立交叉审查、真实临时工作区复现和回归。

## 方案逐项交付

以下 `implemented` 表示对应的最小工程方案已落地并验证，不代表 OS 安全认证或真实模型质量基准。

| ID | 结论 | 实现与验证依据 |
| --- | --- | --- |
| HARNESS-001 | accepted / implemented | 普通命令与验证证据分离；成功、失败、重跑记录绑定工作区 revision，编辑及结果不确定的写入使验证失效。pwd、help/version、dry-run、仅收集测试等不算验证；失败不得通过终稿说明洗成成功。最终 gate 消费真实状态，跳过须说明原因。 |
| HARNESS-002 | accepted / implemented | 保留并标明 trace grader；新增真实临时项目执行、独立最终文件/行为断言、不可变 grader、变更范围与测试完整性检查、trials、配置/用量/时延/费用及非零失败退出。edit_file、apply_patch、Worker 三条路径均实际执行。 |
| HARNESS-003 | accepted / implemented | 工具执行器产生有 ID 的 effects，父子共用 revision；父 AgentState、验证及缓存消费相同效果，按 ID 去重。Worker 自报 JSON 不能充当执行证据；取消后已完成的写入仍保留。 |
| HARNESS-004 | accepted / implemented（最小串行方案） | 共享工作区的 implement/verify Worker 使用可取消的 FIFO 写入队列，research 可并行；同一个 Worker 不允许重入。未实现基于文件所有权的并行写入或独立 worktree 后端。 |
| HARNESS-005 | accepted / implemented | 用户权限、TaskContract 和 Worker profile 取交集，schema 工具及 Worker 参数和执行入口一致。普通 review/analysis 的只读能力同样强制；只读禁止任意 Shell 和实现委派，自动批准不能越过能力边界。 |
| HARNESS-006 | accepted / implemented | 永久批准匹配 canonical workspace、精确命令和策略 v2，保留引号内空白。旧 unscoped grants 保留在 legacy 但不生效；CLI 默认只创建项目授权，显式 API 可设置 global。 |
| HARNESS-007 | accepted / implemented | list/read/search/write 和 Git diff 共用敏感路径判断；dotenv 变体、嵌套凭据目录及服务配置受保护，样例模板可读。搜索先枚举尊重 ignore 的候选，再过滤敏感路径，避免正向 glob 重开忽略文件。 |
| HARNESS-008 | accepted / implemented | 项目参考数据、会话摘要、Memory、artifact 统一用带来源/范围/信任信息的 user 数据封装；仅明确规则文件保留 system。递归隔离工具数组、错误及 activity 文本；保留 Memory provenance/TTL，并修正 provider 的系统消息顺序。 |
| HARNESS-009 | accepted / implemented | 每任务写队列、store 顺序化和同目录原子替换；结束先 flush 再 clear，失败/预算停止亦保存最终快照。新增 `/continue` / `deecoo continue`，检查项目/模型/权限，保留累计步骤和用量；未知工具结果不自动重放，恢复使观察及验证过期。 |
| HARNESS-010 | accepted / implemented | 一个意图推导入口分离 intent/mayWrite/requiresCodeChange，否定优先；支持 `--task-mode` 显式路由，仍服从明确只读约束。“继续”继承上一用户任务能力；完成校验不再另猜编辑关键词。 |
| HARNESS-011 | accepted / implemented | Review 除 JSON schema 还检查实际 read/diff 或用户内联源码证据，文件名列表与模型宣称不算覆盖。显式目标未读不能完成，截断阅读显示 partial；覆盖不被解释成全项目无缺陷。 |

## 做减法与保留的边界

- 复用已经采集的 project index，格式化函数也接受已采集 snapshot；不再重复注入 PROJECT.md 的生成区。
- 保留 propose/apply 分工、批准后重读、hash/预期内容复核和 patch set 回滚，这些用于防止竞态。
- 保留 workflow、AgentState、tracer 的各自用途，在同一执行结果边界更新其投影，并共享 effects；没有引入大型事件框架。
- 模型/工具 replay 共用消费规则；fingerprint v2 覆盖完整请求，包括 tools、assistant tool_calls 和采样参数。旧 hash 缺少原请求时需要重录。
- 环境兼容层改用公平读写门：空覆盖彼此并行，任何环境/cwd 修改与其他调用互斥。尚未全面改成显式环境对象传递。

## 实施后的独立自检

自检对发现的问题实际复现并补修，而非只跑语法检查。

| 自检项 | 原因与处理 | 验证 |
| --- | --- | --- |
| SELF-001：help 被当验证 | `npm test --help` 退出 0 但不执行测试；排除明确不执行检查的选项与命令插值。 | 真实错误实现 + help 复现；9 类非执行模式回归。 |
| SELF-002：回滚失败保留旧通过状态 | patch set 部分写入后回滚失败，原 effects 丢失；新增 workspace-uncertain、revision 失效、清缓存和待检查路径，失败不计为成功编辑。 | 真实只读文件/回滚失败复现；效果、验证与最终 gate 回归。 |
| SELF-003：预算终止漏 checkpoint | 首次模型调用耗尽预算走普通返回，不经异常快照；所有非 completed 返回保存最终快照。 | 真实 runTask/store 首次 10 tokens 停止，再恢复至 13 tokens 并清理。 |
| SELF-004：quiet 的错误输出泄漏 | 持久化失败兜底 stderr 未受 quiet 控制；统一抑制并保留结构化状态。 | provider 与输出持久化同时失败仍无 stderr。 |
| SELF-005：Worker 参数广告过宽 | 只读 schema 仍列 implement；现在 mode/legacy 参数与描述一起投影有效权限。 | schema + 直接调用交叉断言。 |
| SELF-006：搜索覆盖 ignore | 正向 `*` 会覆盖 `.gitignore`；改为候选枚举及共享谓词过滤。 | 临时 Git 项目的被忽略 sentinel 不出现，安全 dotenv 样例可查。 |
| SELF-007：只读 Git 执行配置程序 | external diff、textconv、fsmonitor、filter 可在只读检查中执行；统一禁用这些入口、hooks/可选锁和子模块检查。 | 合成 helper 写 marker 的真实 Git 复现；status/diff/snapshot/review scope 均验证未执行。 |
| SELF-008：Git diff 泄漏敏感内容 | 安全文件 API 被绕过；按安全文件名候选与 literal pathspec 生成 diff。 | staged/worktree 敏感 sentinel 不出现，特殊 pathspec 和嵌套工作区回归。 |
| SELF-009：自动上下文跨越软链 | 上下文采集及 PROJECT 自动刷新绕过工具路径策略；复用路径校验、拒绝软链并安全原子写。 | 临时外部合成秘密/写入目标、目录与文件软链及正常生成回归。 |
| SELF-010：Worker 系统指令顺序 | 数据在前导致 Anthropic 将后置 system 降为普通消息；系统段统一前置。 | provider 与 Worker 指令顺序检查。 |
| SELF-011：空环境覆盖观察到他人变量 | 空覆盖绕过互斥；读写门同时保持空覆盖并行和环境修改独占。 | 既有并发测试与混合覆盖回归。 |

另补充了命令任务必须有实际执行证据或明确受阻原因，以及同回合工具决策只计数一次的修复。预算/取消集成夹具原先用“analyze project”请求却派发写入 Worker，已将夹具改为明确创建文件的授权任务；没有放宽只读策略来适配旧夹具。

## 验证记录

最终结果见本文件末尾的验收记录。所有回归使用临时目录、合成凭据/marker 与离线 provider；未调用真实模型 API，未修改 `eval/reports`，未安装新依赖。

## 后续能力与实际限制

- 当前适用于可信本地项目、用户可监督的 coding harness。临时 Eval 项目与命令 guard 均不构成 OS 文件/网络/进程沙箱；运行不可信项目或无人值守执行需要独立执行后端。
- 验证命令识别与自然语言意图仍是受约束的启发式；真实最终行为由独立 Eval 断言补充。数据封装不能证明模型对所有提示注入均免疫。
- 已实现运行时共享 revision 及恢复后失效；未提供外部任意进程修改文件的持续监控或文件级内容版本系统。
- 真实 provider 多模型质量/成本基准、大型仓库准备性能、断电耐久性、完整 TTY 和所有 Node 版本仍未实测。重复确定性 trial 验证回归稳定性，不是模型成功率统计。
- worktree/容器隔离、文件作用域并行写入、全面显式 env 传递及性能基准属于后续架构能力；本次没有为这些能力建立虚假的兼容实现。

## 最终验收记录

- `npm run check`：通过。
- `npm test`：**305/305**，0 failed、0 skipped；相对原修复阶段 253 项新增 52 项。
- `npm run eval -- --no-report --fail-on-failed`：trace grader **4/4**。
- `npm run eval:e2e -- --trials 3 --no-report`：真实工具执行 **3/3 case、9/9 trial**；离线合成 usage 84 tokens，实际 API 花费 0。
- 本轮同时验收的端到端延迟：p50 257 ms，p95 584 ms，包含临时项目准备与独立评分，不能据此推断真实模型延迟或与旧版的加速比例。
- `git diff --check`：通过。未修改 `eval/reports`。
- 源码快照 SHA-256（排序后的 src 路径及内容）：`9a7cfd44ddb291a79aa6fa77120a088fecbbe7eb0d41304222144e9b78c4b039`。

自检范围内没有保留未修复的已确认缺陷；以上后续能力及未实测范围仍成立。所有实现保留在当前工作树，未创建提交或推送。
