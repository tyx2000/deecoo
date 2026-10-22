# DSH-REF-004：可追溯压缩与模型请求记录

日期：2026-10-22。本模块实施原评估的 DSH-REF-004，所有权为 `src/context/compaction.js`、`src/agent/loop.js`、`src/agent/state.js`、`test/compactionContracts.test.js`。root 负责 taskRunner/checkpoint/隐私投影与最终验收，journal 工作流负责事件序列、fold 和可选持久化；本文不把并行集成状态冒充最终全套通过。

## 参考、证据与决定

固定官方版本 [`deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)，[MIT LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)。实际读取本地缓存的 compaction 文档/index 和官方固定 SHA 的 region.ts；未执行或复制上游代码。

- [范围选择与工具配对边界](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/src/region.ts#L107)：保留 system head，用完整工具调用/结果组定义可替换边界。
- [压缩事务](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/src/region.ts#L159)、[收缩和稳定性验证](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/src/region.ts#L384)：派生摘要的来源和稳定条件显式记录；提交前复核其仍针对当前源，替换必须降低压力。
- [原始记录与模型 surface 分开](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/compaction.md)：替换影响投影，来源记录继续可追溯。

实施前 Deecoo 的压缩直接 splice messages，只保存 before/after 的数量和字符统计，没有来源 ID/hash 或旧摘要拒绝机制；某些短历史可被较大的状态摘要替换。此处是直接代码证据，未复位整个工作树执行旧版本。decision=adjusted；原有确定性摘要、工具配对、预算和未知副作用不重放继续使用，增补小型纯事务，不引入上游插件框架或额外模型调用。solution_fit=suited/executable/affordable yes，cost=medium；solution_reliability=high，有纯函数和真实 loop/checkpoint 的可区分回归；patch_scope=medium。

## 已实施合同

`contextState` 与 wire messages 分开，版本 1 包含 contextId、nextMessageSeq、liveMessageIds、transcript、compactions、protectedPrefixCount、sourceCompleteness。ID 不进入模型协议。transcript 为 append-only 的原始模型表面消息记录；压缩替换单独标记 `kind:"replacement"`，不会覆盖 `kind:"source"`。这是模型 transcript，不包含原始秘密 job 全字节或未进入模型消息的 canonical 工具值，后者仍由已有存储/效果合同管理。

`planContextCompaction()` 只创建 proposal，`applyContextCompaction()` 提交前复核完整当前 surface、选定 source IDs/hash、估计值、替换身份、policyVersion 及完整工具边界。proposal 包含 compactionId、sourceMessageIds、sourceHash、surfaceHash、policyVersion、beforeEstimate/afterEstimate、beforeTotalEstimate/afterTotalEstimate、replacement 和 replacementMessageId。估计使用既有保守 UTF-8 字节方法；replacement 对所替换 source span 和整个 surface 都严格减少，无法证明进展即拒绝，不用更大摘要换掉较小历史。

source 或 tail 变化、工具组不平衡、保护区、重复提交、伪造估计等均在任何 replacement 写入前拒绝。计划/提交阶段不捕获新消息；事实追加由独立 syncContextState 完成。恢复验证 ID 顺序/唯一性/next sequence、live 与归档一致、source hash、replacement 与事务一致，避免旧摘要替换新观察。未提供 contextState 的普通旧 checkpoint 只能捕获其现存 prefix，显式 `legacy-prefix-unavailable`；不会宣称被旧版本丢掉的源已找回。如果旧 checkpoint 有 role=system 的内部 `Run state summary...`，则以 `CONTEXT_LEGACY_SUMMARY_UNVERIFIABLE` 在模型调用前明确拒绝并指导开始新任务，保留旧 checkpoint 与工作区，不悄悄把旧观察继续当 system，也不伪造原始源迁移。首次模型调用前就中断、尚无 assistant 的旧 checkpoint，保护整个已有初始 prefix，防止只保护 system 而遗落原 user 任务。

实时压缩沿用确定性状态摘要与工作集。先尝试完整状态摘要，必要时用紧凑摘要；只提交有证据的缩小。摘要是经过注入投影、模式/具体秘密过滤和不可信 fencing 的 user data，不再把工具观察文字提升为 system 指令。初始保护 prefix 在恢复后仍沿用，旧摘要不会因为位于第一个 assistant 之前而被误当永久系统约束。

每次 dispatch 前捕获过滤后的请求 snapshot/hash 和 messageIds，prepared route 另有实际 requestFingerprint/route/effectiveConfig；未 prepared 的旧嵌入 client 也记录，但生效配置标 `unprepared-client`。loop 复用 root 的 projectModelRequest 白名单/文本过滤，不整体按秘密键名删 schema 对象，token_budget/password 参数 schema 和 thinking.budget_tokens 等合法结构保留；重复事件/持久化过滤保持同一净投影，具体秘密描述过滤。完成/失败各有匹配 attempt ID；失败不会制造成功 assistant 历史。内部 retry/admission 事件关联同一 attempt ID 和快照，不额外插入消息。成功 usage 为本响应 metadata；失败 error.usage 语义无法普遍证明为 delta，放 reportedUsage 且 usageKnown:false，不用于叠加计费。root 的绝对累计 usage 快照是权威。

`serializeRunState`、正常/预算/异常结果保存 contextState。真实 onCheckpoint Promise 在下一次 dispatch 前等待，便于 root 把对应 journal 水位和执行 snapshot 有序持久化。checkpoint 回调失败会保留当前 runSnapshot；若源本身被外部改坏导致快照同步失败，保留原错误、既有归档与明确 contextSnapshotError，不掩盖为成功恢复。

redacted 存储可能改变正文而旧 sourceHash 代表当时源。root 对过滤后投影加 privacyFiltered:true/sourceCompleteness:"filtered"；恢复保留旧 hash 作历史事实，不称可从净内容重建秘密原文。此标记不豁免 live/replacement/ID 一致性，之后新事务仍针对当前净内容重新计算并验证来源。standard/ephemeral 没有该存储过滤标记时必须验证历史 sourceHash。

## 定向验证与范围

第一轮新合同与既有 orchestration/processController/harnessExtension 119/119，追加恢复与秘密回归后 121/121；最终六文件定向 129/129（compaction 新合同15项；orchestration/processController/harnessExtension/checkpointIntegration/requestRouteIntegration）。`npm run check` 通过；最终一轮日志 `/private/tmp/deecoo-compaction-final-targeted.log`、`/private/tmp/deecoo-compaction-check.log`。旧短历史测试无需改变 fixture：紧凑 fallback 可证明缩小并保留 npm 失败、工作集内容；没有为了兼容而取消进展检查。

新测试覆盖稳定 ID、完整源保留、事务证明、源/tail 变化、保护边界、完整工具组、不缩小拒绝、保存源/替换/序号损坏、redacted 明示边界、用户数据 authority、秘密不重引入、prepared/legacy request 快照、失败 attempt、真实压力压缩、实际 checkpoint 继续和 durability 等待。未运行付费模型、LLM 摘要或上游程序。root 在全模块稳定后统一完整 check/test/E2E，不把本模块的定向绿灯当最终集成验收。

边界：只做确定性压缩；没有把任意 API 错误当窗口溢出进行自动重试。完整 source 会增长并受既有内存/存储上限约束，容量错误应明确报告，不静默丢弃历史。source hash 是一致性证明，不是抵抗同账号恶意篡改并重算所有 hash 的认证签名。未知副作用继续由原 checkpoint 规则处理，压缩不授予重放权限。
