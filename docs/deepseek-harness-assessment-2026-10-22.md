# DeepSeek Harness 对 Deecoo 的借鉴评估

评估日期：2026-10-22。结论：值得借鉴其输出契约、可恢复的大输出、实际模型路由能力、可追溯压缩和资源生命周期；不建议把 Deecoo 整体迁移到 Cordis 或照搬“一切皆插件”的部署体系。

后续用户授权“继续”后，DSH-REF-001/002/003 已实施并回归，见 [首轮实施与自检](deepseek-harness-implementation-2026-10-22.md)；再次授权后，004/005 也已实施，见 [压缩与生命周期验收](deepseek-harness-lifecycle-review-2026-10-22.md)。本文以下保留研究时的原始证据与状态，不作为实施验收报告。

本轮为源码研究和改进建议，没有修改产品代码、安装或执行上游代码，也没有调用付费模型。只有下述输出丢失属于已复现的当前缺陷；其余为架构/能力机会，不把“上游有、本地没有”直接列作缺陷。

## 范围与固定版本

- 官方仓库：`deepseek-ai/deepseek-harness`，通过只读 `git ls-remote ... HEAD` 固定为 `687f282e8625c6b8d11ff58211a90524be2e4317`。GitHub API 匿名限流后改用固定 SHA 的 raw 源码读取，没有以第三方镜像作为代码依据。
- 上游[许可证](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)为 MIT；本轮仅借鉴设计，没有复制代码。将来复制代码应保留相应版权和许可文本；第三方依赖许可另行核对。
- 本地：`/Users/adib/Documents/Deecoo`，HEAD `50e809d8a286662d42e8d462b2c9772d9f2dd30d` 加既有未提交改动；package/src/eval JS/test JS 共142文件内容指纹 `c2fc8e58e3f02d52f7509fbb2ceec30d33f1c1e3cd21f92532d76d322cd3a90c`，与上一轮交付相同。HEAD本身不能标识这些改动。
- 实际覆盖：上游core/tools、scope、session、agent/agent-loop、LLM、spill、compaction、fs/subprocess/sandbox及部分preset/subagent源码；本地对应registry/runtime、loop/taskRunner、session/checkpoints/events、capabilities、files/execution、subagents/config。三个审查工作流分别检查执行/插件、状态/上下文和Agent/配置。
- Node v24.21.0，项目为npm/Node ESM。未重新运行完整测试：本轮不改产品行为；上一轮388项、Trace4/4、E2E15/15是历史基线，不是DeepSeek集成的验收结果。

## DSH-REF-001 — 优先补齐工具输出契约（确认的P2缺陷）

- severity: P2
- status: open
- issue_evidence: confirmed；实际调用本地 `createToolRegistry().execute()` 和 `compactToolResult()` 的无网络纯函数复现。
- lane: code
- scope: pre-existing，当前工作树的扩展路径，前轮没有覆盖这种返回形状。
- affected_files: [registry.js:21](/Users/adib/Documents/Deecoo/src/tools/registry.js:21)、[loop.js:674](/Users/adib/Documents/Deecoo/src/agent/loop.js:674)；运行路径为 `tools.execute → compactToolResult → tool message`。
- failure_scenario: 注册一个只读扩展，执行器返回 `{ok:true,data:{answer:42,source:'fixture'}}`；registry接受原样返回，但模型可见结果变为`{ok:true}`。新增工具要让自定义结果进入模型，仍需要修改中央字段白名单，抵消了注册器的扩展目标。明确返回`content`的旧工具不受这个特定复现影响。
- impact: 扩展执行成功但有效数据静默丢失；模型无法据此继续工作，容易重复调用或误解结果。
- reliable_solution: 为注册项增加可选`outputSchema`和纯函数`toModelContent(args,value)`，逐步将内置工具迁移到同一契约；没有自定义投影时提供有界JSON投影。执行后的canonical value与model content/UI metadata分开，统一校验JSON可序列化性和大小。effects/verification只消费执行事实，不从模型投影反推；投影继续经过不可信数据标记、秘密过滤和预算约束。不要为了保留data而无界透传全部对象。
- solution_fit: suited=yes，当前registry已是集中入口；executable=yes，可兼容现有结果形状；affordable=yes；cost=medium，需要迁移和兼容测试；verification=注册任意字段扩展后模型能取得声明的值；不合输出schema返回明确错误；渲染器不修改canonical事实；无需在loop添加该工具名称。
- verification_result: passed，证明当前缺陷，不代表修复通过。输出为 `{"raw":{"ok":true,"data":{"answer":42,"source":"fixture"}},"modelVisible":{"ok":true},"payloadLost":true}`。
- post_cor_candidate: yes；本轮用户仅要求评估，未实施。
- suggested_tests: 自定义JSON结果、字符串结果、非JSON/循环值、渲染异常、超量输出、秘密过滤以及effects不被投影覆盖。

具体参考：[ToolOutputDefinition/output.schema/render/meta](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L213)、[注册及输出检查](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1071)。其工具还区分pre/guard/around/post/result：Deecoo可以采用小型固定pipeline，但应保留权限与取消的强制检查，扩展钩子不能以“allow”覆盖硬拒绝；观测者只读，不能改变最终执行结果。无需先引入完整事件框架。

## DSH-REF-002 — 大输出应能恢复，而不只是裁切（近期，成本中）

上游[spill-policy:91](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/spill/spill-policy/src/index.ts#L91)先按token预算估计，保存完整输出，再提供头尾预览、遗漏计数、locator和读取提示；[spill-local](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/spill/spill-local/src/index.ts#L55)按session私有存储。程序用的canonical value不因展示裁切而改变。

Deecoo的[compactToolResult](/Users/adib/Documents/Deecoo/src/agent/loop.js:674)主要使用固定字符上限；Shell已经有[job日志与字节游标](/Users/adib/Documents/Deecoo/src/execution/backend.js:55)，这部分应复用。一般扩展、巨大diff和嵌套files结果没有统一可取回的输出引用。

建议增加轻量`ToolOutputStore`，返回`{preview,outputRef,totalBytes,truncated,retrievalHint}`，提供按字节/行读取和搜索。引用必须校验run/session归属，沿用TTL、容量、秘密过滤和隐私模式；不要向模型开放任意状态目录路径。redacted/ephemeral仅保存符合其承诺的过滤后或内存内容。上游存储失败会保留inline内容；Deecoo不应直接照搬这一降级，应继续遵守硬窗口预算，并明确报告无法保存/恢复。

验收：大输出中间位置仍可按引用取回；不能跨会话读取；过期有明确错误；非ASCII游标无重复/丢失；隐私结束后引用失效；小窗口不会因为spill失败而溢出。先做文本，暂不引入图片和代码模式。

## DSH-REF-003 — 能力和预算绑定实际provider/model请求（近期，成本低至中）

上游[LLM.prepareCall:956](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956)捕获实际adapter和模型元数据，冻结生效配置/能力，提供一次性dispatch，防止准备时查到的能力与调用时实际路由不一致。

本地[capabilities.js](/Users/adib/Documents/Deecoo/src/llm/capabilities.js:3)已有适配器声明及保守回退，但主要按provider推断；[checkpointIdentity](/Users/adib/Documents/Deecoo/src/harness/checkpoints.js:5)仅包含workspace/model/permission/mayWrite，没有provider、endpoint和工具schema身份。这是进一步改善多模型兼容与恢复诊断的机会，不等于已证明当前所有provider不兼容。

建议增加`prepareRequest()`，返回不可变`{routeIdentity,effectiveConfig,capabilities,capabilitySource,dispatch}`；上下文与费用预留使用真正生效的输出上限；未知能力保留unknown或有来源的fallback。checkpoint/audit记录provider、非秘密endpoint标识、协议和schema指纹；不记录认证值。恢复不匹配时提示具体差异。

验收：同名模型换endpoint后能识别不兼容恢复；不支持的thinking/reasoning在请求前明确处理；配置maxTokens与实际发送和预算一致；取消准备不会发送请求。无需引入上游HMR、模型目录UI或整个provider管理系统。

## DSH-REF-004 — 压缩有来源和进展证明；逐步补可重建的请求记录（中期，成本中；完整事件迁移高）

上游[session类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/types.ts)区分durable事实与model surface；[compaction region](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/src/region.ts#L160)记录源范围并检查稳定性，[收缩检查](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/src/region.ts#L392)拒绝更大的摘要；[overflow恢复](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/src/index.ts#L176)要求实际压缩进展，避免空转重试。

Deecoo已经保留任务约束、完整工具组、预算预留和未知结果不重放；[live compaction](/Users/adib/Documents/Deecoo/src/agent/loop.js:502)直接修改messages并记录统计，[events](/Users/adib/Documents/Deecoo/src/harness/events.js:10)主要是可选观测日志，[session](/Users/adib/Documents/Deecoo/src/session/store.js:168)另存turn/history。这些能力没有重复建设的必要，差距在于精确来源和统一重建。

先增加`{compactionId,sourceMessageIds,sourceHash,policyVersion,beforeEstimate,afterEstimate,replacement}`；验证真正缩小后再提交，源变化拒绝旧摘要。每次请求记录过滤后的模型可见messages/tools、effective config和内容hash；失败/重试attempt保留可诊断记录，但不伪造成成功历史。日志不包含API认证，隐私模式明确限制可重建程度。

再按需要引入纯`foldRun(events)`、连续seq和checkpoint水位。实时与恢复投影应相同，重复eventId不重复计费，原始transcript不因压缩消失；未知副作用永远不自动重放。先保留确定性摘要；LLM摘要与其额外费用可以后做。确认provider窗口溢出且内容减少时才允许有界恢复，不把所有API失败都当压缩触发器。

## DSH-REF-005 — 插件注册拥有作用域和释放责任（中期，成本中）

上游[scope.dispose](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/index.ts#L104)共享同一释放Promise并等异步teardown；[scope store](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/store.ts#L43)为注册返回精确、幂等的撤销行为。

本地[registerTool](/Users/adib/Documents/Deecoo/src/tools/registry.js:7)只返回名称，没有注销和作用域；job已有dispose，但不覆盖插件listener、timer或连接。当前受信静态注册并不因此自动成为缺陷；引入MCP、动态工具或长寿命多任务host后，这个差距才会直接影响隔离与泄漏。

建议小型`PluginScope`拥有tool/listener/resource disposer；注册返回registration handle，销毁只删除该次注册，不能误删后续同名替代项。任务结束先拒绝新调用，取消并等待已有调用settle，再释放连接；权限仍取user/task/worker交集。不要让动态卸载变成超时后遗留副作用。

验收：任务A注册不泄漏到B；重复dispose幂等；旧disposer不删除新注册；异步清理完成前不报告已卸载；失败清理可观测。无需先支持热更新或插件市场。

## DSH-REF-006 — 将来做远程/worktree时统一执行世界（条件采用，成本高）

上游[capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/capability-seams.md)区分Service Definition、Provider和Consumer；[filesystem接口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/fs/src/index.ts#L132)和subprocess共享执行世界及policy，远程读取、Shell、终端/LSP才不会各指向不同机器。

Deecoo[setRuntimeContext](/Users/adib/Documents/Deecoo/src/tools/runtime.js:74)可替换execution backend，但[files.js](/Users/adib/Documents/Deecoo/src/tools/files.js:3)仍直接访问宿主文件系统。当前只做本地CLI没有必要立即抽象所有I/O。出现SSH、容器或独立验证worktree需求时，再引入`ExecutionWorld {fs,subprocess,sandbox,policy,identity}`，分开host状态路径与process工作区路径，并用同一fake world运行契约测试。

验收：文件读写与Shell确在同一world；两个相同相对路径的world互不串用；sandbox write roots与file policy保持一致；断线不重放副作用。现有路径、秘密和TOCTOU防护不能因换Provider被削弱。

## 后续可选：Agent接口、配置快照与外部agent

可参考[Agent公开接口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/index.ts#L146)及[inbox消费](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/inbox.ts#L103)，将队列、send、stop、whenIdle与具体循环分开；已有runAgent和worker实现可以先包一层适配器，只有需要运行中steering/多前端时再做durable inbox。配置可借鉴[preset revision固定](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/preset/agent-preset-registry/src/index.ts#L86)，先提供经过秘密过滤的生效配置快照、来源和hash；命名preset可表达analysis/edit/review/CI，不能暗中扩大权限。无需为此搬Cordis bundle/YAML整配置替换、HMR或自修改插件树。

外部Codex/Claude Code worker适合作为后续可选benchmark backend。参考[Subagent capability合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/src/types.ts#L252)与[Codex provider明确的一次性边界](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent-codex/README.md#L73)。其最终文字不是Deecoo的effects、tests或真实usage；只有建立明确预算/取消/证据/continuation能力合同后才可进入正式任务。不能为了“接上外部agent”绕开当前验收、静默当作usage为零或重复产生写入。

## 不建议照搬及已有能力

- 不迁移整套“一切皆插件”：Deecoo当前更需要少数清晰接口和强制边界，整体框架迁移的配置/依赖/调试成本尚无收益证据。
- 不以两工具minimal模式替换现有验证与改动交付；可以在同一Eval上做工具集消融实验，测成功率、token、时延和错误分类后再判断冗余。
- 不把上游安全能力当已解决本地限制：其[fs-sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/fs-sandbox/src/index.ts#L7)明确读穿透且不是kernel边界；其[subprocess-local](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subprocess/subprocess-local/src/index.ts#L267)也明确Darwin没有persistent process-range owner。不能据此解决Mac主动setsid逃PGID，也不应替换本地更严格的敏感读取策略。
- 已有的持久jobs、取消清理确认、registry、schema输入检查、权限交集、原子存储、checkpoint、JSONL、token预留和结构化验收继续保留。重点补契约和可诊断性，而不是再建一套同功能服务。

建议顺序：先DSH-REF-001/002/003，形成“输出完整、取回可控、模型配置准确”的增量；再做004/005；006与Agent/外部backend按实际部署需求启动。上述建议尚未实施，也没有宣称会提高成功率的实测百分比。
