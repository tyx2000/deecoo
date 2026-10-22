# DeepSeek Harness 借鉴实施与自检

日期：2026-10-22。范围：在用户“继续”的授权下实施评估建议中的 DSH-REF-001、002、003，沿用原八项补强及权限/验收边界。没有迁移 Cordis，没有复制上游代码、执行上游程序、安装依赖或调用付费模型；既有未提交更改全部保留。

## 参考与决策

固定官方版本：[`deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)，[MIT 许可证](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)。公开源码已按固定 SHA 阅读，原始研究保存在 [评估](deepseek-harness-assessment-2026-10-22.md)，下表为本轮实际采用内容。实现为原创适配；将来复制代码仍需保留上游版权/许可。

| ID / 状态 | 参考理念与具体实现 | Deecoo 落地与调整 |
| --- | --- | --- |
| DSH-REF-001 / implemented-and-verified | [ToolOutputDefinition 的 schema/render/meta](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L213)、[注册/校验流程](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1071)：执行事实、模型内容和 UI 呈现分开 | `registry/outputContract` 提供可选 outputSchema、纯同步 toModelContent、presentationMeta；捕获不可变参数和 canonical JSON，验证序列化/大小/schema。runtime 复制投影关联，effects 仍只消费执行事实。未配置 renderer 的扩展保留任意 JSON 字段。内置工具使用兼容字段投影，不再先裁切正文。 |
| DSH-REF-002 / implemented-and-verified | [spill-policy](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/spill/spill-policy/src/index.ts#L91)、[spill-local](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/spill/spill-local/src/index.ts#L55)：先留完整输出，再提供预览与恢复位置 | `ToolOutputStore` 保存完整过滤后 JSON 投影，私有原子存储、hash/TTL/容量、session+run 归属；read_output 字节/行分页与 search_output 字面量搜索。使用 opaque ref，模型不能传状态路径。预算含最终 JSON 转义、信任标记、隔离和脱敏；存储失败返回有界已执行错误，不无界 inline 回退。Shell 复用原 job 日志。 |
| DSH-REF-003 / implemented-and-verified | [prepareCall](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956)、[实际 loop 准备边界](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L600)：能力/生效配置与本次 dispatch 绑定 | `prepareRequest` 冻结 request/effectiveConfig/capabilities/routeIdentity，单次 dispatch 保留实时取消和外层预算/限流。准备在任务权限过滤后进行；context reserve 使用实际输出上限。checkpoint 与结果/事件绑定相同 endpoint、协议和可见工具 schema。 |

原复现 `{ok:true,data:{answer:42}} → {ok:true}` 已通过真实 agent loop 回归：`data.answer` 保留，字符串仍作为不可信数据处理，无需给该扩展增加中央字段。输出 schema 校验只使用明确支持的子集，不能宣称实现完整 JSON Schema；超界或校验失败报告 `executionState:"executed"`，不假装工具未执行。presentationMeta 当前供嵌入式调用，不自动新增终端 UI。

大输出的完整性指过滤后模型投影，不是含秘密的原始字节。standard 引用可按原 owner 持久重开，默认放在 session 子目录，删除会话包含其输出；redacted/ephemeral 只在内存，完成后撤销，同进程可续接 checkpoint（含预算停机）可以复用。恢复时叠加新的秘密规则，不移除旧规则；若旧正文已不安全，拒绝旧引用而不改变其原始游标。私有模式跨进程没有完整输出恢复保证。保存失败、容量满、秘密规则变化、引用过期和 owner 不符均有明确错误。字节页以 base64 表示精确存储字节，切开 UTF-8 时 text:null；行分页用 nextOffset 继续到 rangeEndOffset，不能直接跳到 nextStartLine。控制字符导致转义放大时缩小同一引用的本页字节数，不把读页再次转存；最低页也无法适配时明确返回不可读取错误，不虚报消费。

read_job_output 的 host canonical API 保留原日志字节；模型投影移除原始 base64，以免绕过文字脱敏，并给出 filtered:true/lossless:false 和原日志游标。原始 job 日志仍需按敏感数据管理；单页过滤无法保证识别分布在两页的凭据。read_output 的 base64 来自已整体过滤的存储正文，因此保留。没有把模型文本的长度冒充原始 job 的字节位置。

能力元数据是受信调用者配置，不是远程探测结果。未知 feature 为 unknown；未知窗口为标明来源的 32768 fallback，操作者可通过 modelMetadata/capabilityOverrides 配置。adapter 无法传输的控制不能被 metadata 宣称支持。Token 估计仍是保守字节估计，并非精确 tokenizer。准备快照是调用时的合同，没有动态热切换。route-aware 路径明确拒绝缺少身份的旧 checkpoint 并指引开始新任务，不伪造迁移身份。provider/endpoint 明文认证不进入路由报告；路由相关非秘密 query 仅参与 hash。

## 独立审查与修复闭环

三个独立工作流分别负责输出合同、存储、请求，并交叉审查 root 集成。下述均有运行复现或对应回归，不以“测试发现失败”充当“修复已通过”。

| 审查项 | 原始证据 | 修复及验证 |
| --- | --- | --- |
| OUT-REV-001 | 引号转义后，16000B 预览封套变为 30676B | 按最终序列化大小二分选预览；逃逸字符和 1024B frame 回归通过。 |
| OUT-REV-002 | preview 与 store 过滤不同，合成 sk 凭据只从存储中移除 | 先统一过滤，再计量/保存/预览；inline、spill、秘密键名、冲突键和最终 code 均补回归。 |
| OUT-REV-003 | read_output 行范围的 rangeEndOffset/rangeComplete/nextStartLine 被兼容投影丢弃 | 保留游标元数据并用真实工具回归。 |
| OUT-REV-004 | 1KB transport 下控制字符页被再次spill，丢失原引用的nextOffset/base64 | 纯分页适配器按最终measure收缩同页，重新计算字节游标与UTF-8状态；不递归spill。子审查发现由base64重建text可能撤销既有脱敏，现先检查二者一致，否则明确拒绝。 |
| OUT-REV-005 | ephemeral/redacted预算停机有可恢复checkpoint，却dispose了其输出store | 清理改为检查实际checkpoint owner；真实budget→continue→read_output→完成回归，最终才dispose。恢复叠加新秘密规则的回归明确拒绝不再安全的旧引用。 |
| 信任包装预算 | 2000 个短字符串在包装前仅 8020B，包装后约 207KB | 准备函数接收纯 transport measure，计入最终信任标记、隔离和脱敏；试算不写 quarantine。真实循环在 1024B 下仍返回引用、可找回中间值。独立原复现得到 1022B。 |
| 原始编码副本 | read_job_output 的文本已脱敏，base64 仍可还原秘密 | 模型投影删除原编码副本、标记非无损，host canonical 与原游标保留。独立原复现通过。 |
| 请求包装兼容 | 仅实现非流式客户端被 rate wrapper 错误声明支持 stream | 条件声明 stream 方法；实际 task+prepared dispatch+预算回归，非流式只调用一次。 |
| 路由元数据错位 | taskRunner 计划准备早于策略过滤；checkpoint 与 completed result 的工具 schema hash 不同 | taskSpec/policy 前移；独立真实恢复验证 run-start、wire、prepared、checkpoint、completed identity 相同。渲染函数/隐藏 writer 可改变，可见 reader/写权限改变则调用前拒绝。 |
| 数组呈现形状 | 渲染器数组根被逐字段信任包装改成对象 | string 使用 content，array/scalar/null 使用 value 封套，保留原 JSON 值；实际 loop 回归。 |
| 审计诊断字段 | 新增 maxOutputTokens 等数字字段会被宽泛 token 键规则误脱敏；仅按键名豁免又会放过任意字符串 | 只允许有限数字；sources 下仅保留明确来源标签，任意字符串/Infinity仍过滤。结构化结果、audit保留 routeIdentity/effectiveConfig。独立复测 requested=400、effective=128、来源和usage均可见。 |

原始引用研究后没有放宽任何权限：registry 仍为可信本地扩展，不能通过 renderer/observer 把主机取消/权限拒绝改成成功；observer 抛错只记诊断，不抹去已完成的 effects。只读与 Worker 权限继续取交集。没有声称同步冻结对象能把恶意进程内插件变成安全沙箱。

## 验证

新增测试包括输出契约、持久/内存输出存储、真实 runtime→loop 模型消息、限流/预算包装、实际路由 checkpoint 恢复和报告脱敏；无需真实 API。

历史基线 388 项不能作为本轮通过数；集成过程中两项已知失败（tiny-window 的 reserve fallback 和 research 工具列表）均已修复。`npm run check`、完整 `npm test`、Trace grader、15 场景离线 E2E 由 root 统一复跑。Eval 报告写 `/private/tmp`，没有改 `eval/reports`。离线脚本证明 harness 流程，不是模型成功率或付费性能基准。

原八项补强的 OS/平台限制仍以 [前轮验收](harness-upgrade-review-2026-10-22.md) 为准。本轮没有宣称 Linux 实机验收、Mac 主动 setsid 全面清理、完整 tokenizer、全量远端模型能力探测或凭据隔离已解决。

### 最终验收记录

状态：**IMPLEMENTED_AND_VERIFIED_WITH_DOCUMENTED_LIMITS**，仅对应 DSH-REF-001/002/003。全部已确认的本轮集成问题已经修复、回归和独立复测，没有剩余已确认的阻塞项。产品文件稳定后统一执行，后续只补文档。

- 本地 HEAD：`50e809d8a286662d42e8d462b2c9772d9f2dd30d` 加保留的未提交内容；Node **v24.22.1**。原shell PATH缺少npm，以本机已有nvm运行时路径前置执行，没有安装运行时/依赖。
- 154 文件内容 SHA-256：`69a04cdb3d3fa09d39a434c204447220d2dbfe356c42b037a39f9eeed3f39548`。算法与前轮相同：package.json、src/eval/test下JS，排除eval/reports，按相对路径排序，路径与正文以NUL分隔；文档不参与。
- `npm run check`：exit 0；`/private/tmp/deecoo-dsh-final-check.log`。
- `npm test`：**461 项，460 通过，0 失败，1 跳过**，exit 0；`/private/tmp/deecoo-dsh-final-tests.log`。跳过为外层沙箱不允许嵌套 `sandbox-exec`（sandbox_apply: Operation not permitted）；本轮不把它说成通过，前轮独立 macOS 实测仍为历史证据。
- Trace grader：**4/4**，exit 0；`/private/tmp/deecoo-dsh-final-trace/2026-10-22T02-33-59-250Z-summary.json`。
- 离线真实任务 E2E：**15/15 cases、15/15 trials**，exit 0；`/private/tmp/deecoo-dsh-final-e2e/2026-10-22T02-34-15-649Z-summary.json`。这些是独立文件/行为grader的流程回归，不是付费模型评测。
- 独立窄复测：输出/存储60/60；请求原prepare/resume探针、审计原漏洞、数字及provenance均通过。`git diff --check` exit 0。没有改 `eval/reports` 或创建 Git commit。

主要代码：`src/tools/{registry,outputContract,projection,modelOutput,outputPage,runtime}.js`、`src/storage/toolOutputs.js`、`src/llm/{capabilities,prepareRequest,clientFactory,rateLimiter}.js`、`src/agent/{loop,taskRunner}.js`、`src/harness/{checkpoints,contentTrust}.js`、`src/reporter/outputs.js`、`src/observability/audit.js`。接口/测试细节分别见 [输出契约](deepseek-output-contract-notes-2026-10-22.md)、[存储与分页](deepseek-output-store-notes-2026-10-22.md)、[请求准备](deepseek-request-notes-2026-10-22.md)，README已同步。

## 后续范围

DSH-REF-004（可追溯压缩/统一重建）和 005（动态插件作用域释放）仍为后续建议，未在这次实现。006（统一执行世界）在引入 SSH/容器/独立 worktree 时采用；AgentHandle、durable inbox、配置 preset 和外部 agent backend 也没有新增。本轮只完成已选择的 001/002/003，不把研究建议全部标成修复完成。原额度自动续接任务保持 PAUSED；未购买额度、使用重置券或改用户订阅。

后续状态：用户再次授权后，004/005 已实施并独立复核，最新验收见 [压缩与生命周期报告](deepseek-harness-lifecycle-review-2026-10-22.md)。本段之前为首轮交付的历史状态。
