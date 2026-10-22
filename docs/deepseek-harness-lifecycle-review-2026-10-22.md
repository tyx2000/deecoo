# DeepSeek 参考后续：压缩与插件生命周期验收

2026-10-22。状态：**IMPLEMENTED_AND_VERIFIED_WITH_DOCUMENTED_LIMITS**。用户在前三项交付后再次授权“继续”，本轮实施 DSH-REF-004/005，保留此前全部工作树改动。原八项和 DeepSeek 001/002/003 的历史验收分别见 [八项报告](harness-upgrade-review-2026-10-22.md) 与 [前三项报告](deepseek-harness-implementation-2026-10-22.md)。

没有迁移插件框架、复制或执行上游源码、安装依赖或调用付费模型。原始研究的 006 仍是出现 SSH/容器/独立 worktree 需求后的条件扩展，不在本轮实施；AgentHandle/durable inbox、外部 agent backend、preset/HMR 也没有新增。

## DSH-REF-004 — 可追溯压缩与续接诊断

- decision: adjusted；outcome: implemented；patch_scope: large，涉及消息/检查点合同和存储投影。
- issue_evidence: confirmed，实施前压缩直接替换工作 messages，仅有数量/字符统计，不能校验源或恢复被裁切的历史；部分短历史可能被更大摘要替换。此为当时真实代码证据，没有 reset 用户工作树来运行旧版本。
- solution_fit: suited/executable/affordable=yes，cost=medium；沿用确定性摘要、工具调用组和既有预算，不引入额外模型调用或整套 event-sourcing。solution_reliability=high，来源/提交/恢复与实际执行有定向证据。
- change: `contextState` 保存稳定消息 ID、追加式 source/replacement transcript、live IDs 与压缩事务；事务包含 sourceHash、策略版本、替换内容和前后估计，提交前复核完整 surface。必须严格缩小，不能拆工具调用/结果组，也不把观察摘要提升为 system 指令。源变化、重复提交、伪造进展和恢复不一致均拒绝。
- change: 每次模型 dispatch 有过滤后 request、message IDs、hash、route/effective config 和 attempt；重试关联同一调用，失败不制造成功消息。`projectModelRequest` 保留正常 schema 的 token/password 属性和 thinking 预算，剔除认证/transport 根字段，仅对文本做秘密过滤；过滤键碰撞保留两份数据。actual prepared fingerprint 与过滤后 snapshot hash 分开。
- change: `runJournal` seed 保存去重索引、诊断计数与水位，纯 `foldRun` 与实时 reducer 相同。精确重复不重复应用，冲突/序号缺口明确拒绝。累计 usage 快照是权威；attempt delta、不确定 reportedUsage 与 Worker 汇总不重复叠加。
- change: 每步等待事件队列和检查点写入后再开始下一次 dispatch。续接读取同 run 的磁盘尾部，推进诊断水位，避免重复使用旧序号；已记录的累计 usage 只能提高恢复预算用量。pending tool 只作诊断，不成为执行队列，未知副作用继续要求检查工作区。
- change: 主 Agent 与 Worker 各轮 source 保存到运行结果/检查点；完成后清检查点不会把 source 一起丢弃。Worker 模型输出共享主任务秘密规则。strict 检查点写失败会停止后续调用，保留失败 snapshot/诊断，不假装已有最新可恢复记录。
- verification_result: passed。压缩模块六文件129/129、journal及旧扩展22/22，root实际生命周期12/12，并通过下方统一全量/E2E。

固定参考均为官方 [`deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)，[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)：[compaction region:107/159/384](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/src/region.ts#L107) 的完整工具组、事务与稳定性；[session:573](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts#L573) 的连续投影和恢复；[agent attempt/request:468/637](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L468) 的非成功历史与请求边界。逐项理念、实现映射和测试见 [压缩笔记](deepseek-compaction-notes-2026-10-22.md)、[事件笔记](deepseek-journal-notes-2026-10-22.md)。均为原创适配，将来复制源码仍须保留相应许可。

## DSH-REF-005 — 作用域、注销与释放责任

- decision: adjusted；outcome: implemented；patch_scope: medium，新增嵌入式生命周期 API 与任务接入。
- issue_evidence: capability opportunity，原静态注册没有自动构成缺陷；加入动态/任务插件后，需要精确归属、阻止跨任务泄漏并等待真实清理。新生命周期集成中确认的边界见下方审查闭环。
- solution_fit: suited/executable/affordable=yes，cost=medium；保留 `registerTool()`/`register()` 的名称返回和静态宿主生命周期，增加可选 handle/scope。solution_reliability=high，有真实异步取消、替代注册、清理失败与跨任务证据。
- change: `createPluginScope` 统一 tool/listener/resource 归属。开始 dispose 同步关闭入口，取消并等待在途工作 settle，再逆序 await 资源；重复/重入共享同一 Promise，清理失败报告 `dispose-failed` 并继续尝试其他资源。排队但未真正开始的 callback 取消后不执行。
- change: registration handle 只移除自己那次注册，旧 handle 不删除后来同名的工具。已有 canonical/renderer 仍指向当时事实；runtime 捕获实际 dispatch entry 来记录 effects，注销不抹去已发生的 mutation。异步审批结束后若注册已换，返回 `TOOL_REGISTRATION_CHANGED/not-started`，不把旧审批给新 handler。
- change: 嵌入式 `config.setupPlugins(scope,{signal})` 在任务策略和路由准备前执行，每个 run/resume 重新建立；任务结果、changes capture、audit/output 之前 await 释放，outer finally 幂等兜底。清理失败使机器状态失败、验收 partial，setup 失败同样保存诊断，不记成功 history 或伪造检查点。
- verification_result: passed。scope/output/cancellation27/27；独立实际 lifecycle 6/6，原两个失败入口复现已关闭；下方统一全量/E2E通过。

同一固定 MIT 上游参考：[scope quiesce/dispose:115–145](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/index.ts#L115) 的异步释放完成边界及共享 Promise；[NamedEntries.insert:43](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/store.ts#L43) 的独立幂等撤销。没有引入 Cordis、插件市场、热更新或新的 allow 权限。详情及可调用 API 见 [作用域笔记](deepseek-scope-notes-2026-10-22.md)。

## 独立审查闭环

- LIFE-REV-001，confirmed → fixed-verified：setup 先注册失败 disposer 再抛错时，原 outer catch 仅返回失败，无 audit/output。现在先完成 cleanup/apply，再保存失败诊断；独立原复现均有2份 output、1份 audit、0模型调用和0虚构 checkpoint。
- LIFE-REV-002，confirmed → fixed-verified：已知秘密置于 Error.code 时，原 error.code/stoppedReason 未过滤。现在动态 code 先检查受限机器格式并用秘密过滤复核，变化即固定 `request_failed`；独立原复现返回和持久结果均无秘密。cleanup失败另用固定机器原因并保留其诊断。
- 隐私日志实证，confirmed → fixed-verified：ephemeral 即使 durableToolEvents=true，也不能把内部 no-op append 算成持久成功。persist/reconcile 都检查实际 canPersist；真实停机/恢复验证 persistedWatermark=0、journalComplete/rebuildable=false、无假 historyMissing。
- 请求结构实证，confirmed → fixed-verified：通用秘密键规则曾抹掉正常 token_budget/password schema 和 thinking.budget_tokens。现共享 request-aware 投影并使用有限数字白名单，重复过滤仍保留结构；具体秘密、认证根字段和过滤键碰撞均有回归。
- scope 排队取消、审批替代、注销后 effects、Worker source/秘密规则、异步 observer 拒绝、trace 字节限制、旧 source 权限和检查点失败均在定向或独立探针中验证。独立 journal 探针验证磁盘 fold 与实时投影一致、删前缀明确 historyMissing、seq继续、绝不重放工具。

## 隐私、兼容和能力边界

`contextState` 是已进入模型表面的原消息，不是原始含秘密 job 全字节或未展示的 executor canonical。source 会增长并受内存/文件/总容量约束；容量错误明确报告。来源 hash 是一致性证明，不能抵抗同账号修改文件并重算全部 hash。

standard 的完整持久 journal 保持显式 opt-in。默认内存 tracer 最多2000项/2MiB，丢弃有计数，结果说明本次 retainedTrace 是否完整。journal 超限/缺口、TTL删除前缀和 observer错误都可见；没有完整日志时不宣称可重建逐次请求。`rebuildable` 仅指本 fold 诊断与保留的请求快照，完整 transcript 的来源仍为 contextState。

redacted 的持久 journal、run-result 和 audit 省略逐次 request snapshot 正文；受既有隐私过滤的 source transcript 仍可保存，并标 `privacyFiltered/sourceCompleteness:filtered`，旧 sourceHash 保留为历史事实，不宣称能恢复秘密原文。ephemeral 没有磁盘日志/历史。普通旧 checkpoint 若没有 contextState，来源标记 legacy-prefix-unavailable；如果含旧内部 system 摘要则在0模型调用时明确拒绝并指导开始新任务，保留旧 checkpoint/工作区。没有假迁移已丢失的来源。

作用域只管理正确归属且协作取消的可信进程内工作，不能强制终止死循环、未登记 timer/进程或隐藏释放环；插件作者仍须正确 await。并发任务仍使用各自 ToolRuntime。权限交集、OS后端和未知副作用不重放未放宽。未实现 LLM 摘要、任意 API 错误自动压缩重试、MCP/LSP、外部 agent 执行或远程 world。

## 最终统一验收

产品稳定后运行，随后只补文档。Node **v24.22.1**；HEAD `50e809d8a286662d42e8d462b2c9772d9f2dd30d` 加现有未提交工作树。162文件 SHA-256 **`098ac3d516f09f97dc002dd762d69bbc789ddb90f7efe54415ba02c7a107f9a5`**，算法与前轮相同：package.json、src/eval/test的JS，排除eval/reports，按相对路径排序，路径与正文以NUL分隔；不含文档。

- `npm run check`：exit0；`/private/tmp/deecoo-dsh-next-final-check.log`。
- `npm test`：**511项、510通过、0失败、1跳过**，exit0；`/private/tmp/deecoo-dsh-next-final-tests.log`。唯一跳过为外层沙箱拒绝嵌套 sandbox-exec（sandbox_apply: Operation not permitted），不记为通过。
- Trace grader **4/4**，exit0；`/private/tmp/deecoo-dsh-next-trace/2026-10-22T07-19-54-422Z-summary.json`。
- 真实任务离线 E2E **15/15 cases、15/15 trials**，exit0；`/private/tmp/deecoo-dsh-next-e2e/2026-10-22T07-18-13-769Z-summary.json`。这是 harness 流程回归，不是付费模型成功率。
- 本轮新增50项合同/集成测试；root lifecycle12/12、独立scope6/6、独立journal6/6与实际探针通过。`git diff --check`通过，README与模块笔记已同步。

现有改动全部留在工作树，没有修改eval/reports、提交Git或使用额度购买/重置券。原八项自动续接任务保持PAUSED，不重复唤醒已完成工作。没有剩余已确认且未处置的本轮阻塞项。

### 用户授权提交前核对

用户随后明确授权完成后提交并推送。提交前162文件指纹与上述验收完全一致；暂存检查另发现并移除了 `src/tools/projection.js` 文件末尾的一行冗余空行，无行为变化。格式清理后的162文件指纹为 `2c4ef2e37d3ec03871579ec91757ff3c8db6512f1de1a3b6c404d35f4f27a8a8`；另行运行 `npm run check`，日志 `/private/tmp/deecoo-publish-check.log`。完整测试与E2E仍采用上述验收证据，没有将纯空白清理说成新的行为实现。实际提交/推送以Git记录为准，前文“未提交”为验收当时状态。
