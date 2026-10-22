# DSH-REF-004 事件投影与续接水位

日期：2026-10-22。本模块所有权为 `src/harness/events.js`、新增 `src/harness/runProjection.js`、`test/runProjection.test.js` 和本文。root负责taskRunner/checkpoint/session/privacy接入，另一个工作流负责loop/contextState/compaction。本模块没有重建另一个原始消息历史，没有执行上游代码或调用付费模型。

## 参考与采用边界

固定官方版本为 [`deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)，[MIT LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)。以下为实际读取的固定源码，不以第三方文章代替实现证据：

- [Session.create/fromRestore 与 constructor seed validation](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts#L573-L665)：重放和实时追加使用相同连续序号及JSON/状态校验，失败不能先改变已提交投影。Deecoo采用同一个纯fold语义和增量reducer，检验eventId、连续sequence和身份，验证后才推进水位。
- [SessionEvent/SurfaceIntent](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/types.ts#L450-L518)：有来源的消息替换与attempt/error等非消息事件分开。Deecoo的源transcript和live IDs由contextState保存；fold仅保留attempt状态、摘要、计数和最新compaction来源，不把失败attempt包装为成功assistant消息，也不从pending tool推导重放动作。
- [Agent失败/未完成stream写assistant/attempt](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L468-L509)、[request/header及request/context](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L637-L682)：保留失败请求诊断和实际请求配置/上下文来源。Deecoo采用model-attempt-start/end及过滤后的request快照，没有搬上游Session框架。

实现为本项目原创适配，没有复制上述源码。不是完整event-sourcing或远端恢复系统；未知普通事件仅作为不改变本投影的诊断记录保留，核心执行事实、工具效果和完整原消息仍归既有runtime/contextState。

## 公共接口及事件合同

```js
const events = createRunEventStream({
  runId, taskId, onEvent, persist, secretRegistry,
  resumeState, startSequence,
  includeSnapshots: true, maxEventBytes: 8 * 1024 * 1024,
});
await events.emit({type: 'model-attempt-start', attemptId, step,
  request, requestHash, routeIdentity, effectiveConfig});
await events.emit({type: 'model-attempt-end', attemptId, step,
  outcome: 'completed', usage}); // 或failed/interrupted
await events.emit({type: 'context-compacted', step, transaction, liveMessageIds});
await events.emit({type: 'usage-snapshot', usage}); // 累计绝对值
await events.flush();
const seed = events.checkpoint();
const projection = events.projection();
```

`emit`即时分配/验证sequence并更新compact投影，observer与persist进入同一个串行Promise队列。记录先分离、过滤、深冻结；异步observer拒绝可观测，仍继续持久化同一事件。observer不能修改将要持久化的对象。`flush`等待队列，兼容原有`{events,error}`，追加watermark、persistedWatermark、projectionComplete、requestSnapshotsComplete、journalComplete、rebuildable、gap/historyMissing/observerError。

`checkpoint()`返回version/runId/taskId/sequence、compact projection与连续持久水位/错误状态，不复制messages/tools/request正文。projection保存eventId→sequence+semantic hash索引、全部小型attempt身份/状态、pending invocation ID及计数；最多100000事件身份、10000attempt，达到限制明确记录诊断缺口，不静默丢去重索引。它不是可运行的副作用队列。`transcriptSource:'contextState'`始终明确原消息所有者。

纯`foldRun(events,{seed,runId,taskId})`与实时增量使用相同reducer。精确重复eventId/sequence/payload只应用一次；eventId重用于不同数据/位置、sequence缺口、身份变化、非法attempt终态及非有限JSON明确拒绝。persist适配器自行重打的at/sessionId不改变semantic hash。已声明snapshotOmitted的内存request正文也不进入持久semantic身份；其过滤后requestSnapshotHash仍保留。

实际usage分两类：`attemptUsage`是已测得单次delta的诊断累计；`usage`在run-end/usage-snapshot后以累计绝对值为权威，`usageSource`与`usageWatermark`表示来源/时点。已有model-call的usage绝不再加一次，聚合已含Worker时也不叠加attemptUsage。后续attempt delta不会暗中加到旧absolute snapshot；host可在检查点前补最新usage-snapshot。累计快照回退被拒绝。没有usage或明确usageKnown:false的失败/部分attempt标usageComplete:false；error.reportedUsage只在原事件中作不确定诊断，不参与计费累计。零个已测token不是“费用已知为零”。

## 隐私、完整性与恢复

request只接收本项目模型请求字段白名单：消息、tools、model和明确请求控制；headers/apiKey/任意client config不属于快照。统一具体secretRegistry与现有audit固定模式过滤后才计字节、计算requestSnapshotHash。原requestHash由loop提供，requestSnapshotHash标识本模块最终过滤快照，不伪装成未过滤wire正文hash。

`includeSnapshots:false`时observer仍可读取过滤后的内存request，持久副本删除request并明确snapshotOmitted。投影也按该持久副本计算覆盖，重放结果不会声称保留了私有正文。seed不含请求正文。persist未配置时无故障，但journalComplete/rebuildable为false；不能把只有一个compact checkpoint说成有完整请求历史。

单次persist失败时记录第一个gap，后续写入仍尝试但连续persistedWatermark停在失败前；不以末尾写成功覆盖旧缺口。事件非法/超出maxEventBytes也显式标gap，工具事实不会因此变成“未执行”。异步observer失败单独标observerError：可完整重建的持久记录不因界面失败而被误标丢失，但该故障仍在error中可见。

```js
const reconciled = reconcileRunJournal(saved.runJournal,
  storedEvents.filter(e => e.runId === runId), {runId, taskId});
const stream = createRunEventStream({...options, resumeState: reconciled});
```

reconcile先从checkpoint身份索引fold读取的同run记录（旧prefix重复与崩溃后新tail），推进诊断sequence，避免checkpoint为100而磁盘已到110时重新使用101。它只推进日志/诊断，不更新工作区effect或重发工具；checkpoint未知结果的原有检查规则继续适用。tail缺口、冲突或坏记录拒绝恢复该诊断投影。

如果磁盘prefix已被TTL/手动删除，seed可以继续compact诊断，但reconcile会按实际物理记录计算连续持久前缀，并给historyMissing，journalComplete/rebuildable为false。不能仅因为seed记得旧persistedWatermark而声称全文历史可恢复。root仍独立决定contextState能否继续及隐私持久化策略。rebuildable仅指本fold投影和保留的模型请求诊断；不代表凭journal能自动重建完整transcript/外部进程，也不保证未知副作用可重放。

## 验证

- `node --test test/runProjection.test.js test/harnessExtensionContracts.test.js`：首轮21/21，追加结构保真回归后 **22/22通过**，其中新增11项覆盖实时/纯fold一致、eventId去重与冲突、usage双计数防护、累计回退拒绝、失败/中断不成成功history、compaction来源、pending tool无重放指令、checkpoint+crash tail水位、prefix丢失、异步observer、持久gap、过滤/省略快照、错误预算和非法JSON。
- `npm run check`：通过。日志 `/private/tmp/deecoo-dsh-journal-tests.log`、`/private/tmp/deecoo-dsh-journal-check.log`。
- 初次定向中reconcile返回值被旧seed.sequence覆盖，真实断言观察到2而非3；已调整spread顺序并重跑，3→4的续接与完整fold一致。没有把第一次发现复现当作最终通过。
- 未跑完整`npm test`/E2E，遵守root统一稳定后验收的分工。没有修改session存储原语、付费请求或`eval/reports`。

后续独立接入复核：root lifecycle 的004相关6/6通过；standard+durable实际临时任务中，异步observer每次拒绝仍完整persist，已知秘密不进入记录，合法token_budget/password schema与thinking64保持，磁盘fold等于result.runJournal.projection。删除磁盘prefix后，resume继续且只新增1次模型请求，usage累计11，historyMissing.firstMissingSequence=1、journalComplete/rebuildable=false、sequence继续，不伪造完整来源。ephemeral+durable偏好最初被root错误地把no-op append算为persist成功，已补canPersist条件并实测persistedWatermark=0/无磁盘记录/不假报historyMissing。最终全套与边界以 [统一验收](deepseek-harness-lifecycle-review-2026-10-22.md) 为准。
