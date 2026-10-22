# Harness 八项完整补强：执行进度

用户授权：修复上一轮提出的全部八项，并参考当前公开 pi、Codex 等实现；记录具体理念、源实现和项目落地。允许本会话定时续接，直至全部实现、验证、自检完成。不得自行缩减范围、购买额度或使用重置券。保留已有未提交更改，禁止改 eval/reports。

## 自动续接

- 本会话 heartbeat automation ID：`deecoo-harness`，ACTIVE，每小时 :45 唤醒，状态不变静默。
- 2026-10-22 00:57 上海时间读取额度：五小时已用84%，重置 2026-10-22 03:43:47；周已用36%，重置 2026-10-27 16:34:34。
- 额度恢复后从本文件和当前工作树续接；完成全部验收才暂停 automation。检查是否有活跃执行，避免重复派发。
- 当前状态：IMPLEMENTING，尚未完成。本文件是进度而非验收报告。

## 稳定范围映射

1. 进程树取消/长任务：NEXT-001、NEXT-003；ExecutionBackend、持久jobs与日志、明确退出状态、显式env/cwd。
2. 结果验收：NEXT-002；结构化acceptance/requiredChecks、等价命令、no-change/partial/blocked与证据。
3. 任务改动交付：NEXT-004；基线、整体/逐文件/区块diff、接受/撤销、patch导出、保留用户dirty和后续改动。
4. Eval与CI：NEXT-006；多任务/语言/失败恢复场景、真实provider显式预算入口与版本化结果、自动CI。
5. OS执行隔离：NEXT-005；实际文件/网络/资源边界，支持平台明确；能力探测失败必须fail closed，不把guard称沙箱。
6. 上下文：NEXT-007；模型token/输出预留、按行读取、符号/引用导航、内容版本失效与指标。
7. 持久化与数据治理：NEXT-008；统一原子/并发/迁移/损坏恢复、事件日志、保留期/容量/隐私及Memory管理。
8. 扩展与观测：NEXT-009；ToolRegistry、JSONL/非交互、provider capabilities/compat、关联IDs与时序费用指标。

## 基线与约束

- HEAD 50e809d8a286662d42e8d462b2c9772d9f2dd30d + 前轮大量未提交更改；禁止 reset/revert 他人编辑。
- 上轮源树digest 9a7cfd44ddb291a79aa6fa77120a088fecbbe7eb0d41304222144e9b78c4b039。
- 上轮305/305 tests、check、trace4/4、E2E9/9通过；新增实现须重新验证。
- npm、Node ESM >=20，当前Node24；小patch、check、behavior变动npm test。
- 不调用真实付费模型，除非显式授权使用其凭据和费用范围；本次实现可控入口、离线验证入口契约。

## 当前分工/状态

- /root/upgrade_execution：执行/隔离，owned src/execution/**, tools/shell.js，执行notes。
- /root/upgrade_acceptance_eval：验收/Eval，owned taskSpec/taskIntent/finalValidation、verification、eval、CI，质量notes。
- /root/upgrade_context_storage：上下文/存储，owned context/session/memory/observability、checkpoints、storage、tools/files读取版本部分，状态notes。
- root负责整体集成、改动交付、工具注册/机器接口及引用记录。

## 引用采集

已打开官方OpenAI shell文档、GitHub openai/codex 和pi仓库。原 badlogic/pi-mono 当前重定向 earendil-works/pi。临时引用目录 `/private/tmp/deecoo-harness-references-20261022`；精确commit元数据采集进行中。最终 docs/harness-reference-notes-2026-10-22.md 必须逐项记录具体文件、commit permalink、理念、采用/未采用、对应实现和许可证，不能只链接项目首页。

## 下一步

1. 获取固定版本参考源码，拆分三条互不覆盖的实施工作流。
2. root建立任务变更交付与统一注册/机器事件入口。
3. 每条工作流完成后记录测试和剩余项；集成、扩大Eval、独立自检。
4. 任务中断时续接本文件，勿把部分完成误标全完成。

固定参考版本：Codex a3b685331fc700bec554b2fe2a929a65f4fe1548；pi bd3c9b823762b7383954aa49e13ee350471015fe（earendil-works/pi，原仓库跳转）。自动续接创建成功，首次额度恢复后的候选运行时间03:45（上海时间），仅有实际恢复/进展时通知。

## 2026-10-22 续接实现记录（仍在实施，非最终验收）

额度03:48恢复；本轮已完成三条工作流的主要模块，正在根集成与独立交叉审查。当前工作树保留所有前轮更改，无提交/reset，未写eval/reports或调用付费provider。

- 执行：src/execution/backend/processTree/sandbox/worker + tools/shell.js，独立supervisor、持久job ID及磁盘输出、TERM/KILL/确认清理、显式env与替换。实际macOS Seatbelt外部合成文件读取/写入/后代/localhost网络拒绝，项目npm test可运行；CPU/file-size实测通过。普通组后代受管，macOS setsid逃离进程组的清理不保证，能力明确报告；Linuxbwrap有PID namespace但本机未实测。
- 验收/Eval：acceptance.js、逐项requiredChecks/范围/等价执行路径/源证据/no-change；15个E2E已15/15。真实provider benchmark有显式付费开关+金额/请求/token/时间预算，仅验证离线合同；CI离线/手动付费分开。quality notes记录具体参考。
- 上下文/存储：保守UTF8 token估算（非精确tokenizer），输出/安全预留、按行读取及整文件hash、词法symbols/references；统一atomic/fsync/lock/schema/recovery、session owner/tool journal、memory TTL/CRUD及retention/privacy。新14场景通过、原37相关场景通过；reporter/artifacts管理正在补齐。
- root任务改动：src/workspace/changes.js、6个撤销测试通过（dirty基线、后续不重叠/重叠、逐hunk、恢复、新建删除、CRLF、状态符号链接）；state index/list已补。自动taskRunner开始/结束capture已接，resume复用changeSetId；redacted/ephemeral模式仅内存保存可逆源内容。二进制/符号链接暂只报告冲突，不可假称自动undo支持。
- root工具/观测：registry统一schema/metadata/执行器、权限交集、协作超时、扩展mutation保守失效；start/status/output/stop、task_diff、导航工具已注册。runtimeContext取代runTask全局env覆盖，events关联run/task/worker/invocation；主loop按窗口检查且保留任务约束，acceptance进入result。主集成相关34项已通过，完整套件待新一轮。
- 已修集成回归：git_diff合法path参数schema、macOS /var与/private别名导致check范围错配、nested node测试继承NODE_TEST_CONTEXT、chmod workspace影响job控制通道、ulimit文件块单位。
- 当前分工：acceptance worker继续src/cli.js/args.js/config/env.js及新management机器入口；context/storage worker完成reporter后独立复核root模块；execution worker完成notes后独立复核acceptance/Eval/benchmark。

### 必须继续的剩余工作

1. 完成CLI JSON/JSONL/非交互、sandbox/acceptance/context配置与jobs/changes/memory/storage离线管理；root补registry/events/runtimeContext/provider capabilities集成测试。
2. root完成changes二进制整体撤销边界、恢复和并发/隐私限制自检；主taskRunner失败清理/owner事件先后需交叉审查。
3. 整理 docs/harness-reference-notes-2026-10-22.md：固定commit逐文件permalink、实际借鉴/落地、许可证、未采用与局限。三个worker notes合并引用。
4. 重跑npm run check、npm test、trace Eval、15case E2E、独立自检并修复发现的问题；最终报告逐八项结果，不将未验证平台、付费基准或词法导航说成全面验证。
5. 全部验收前自动化保持ACTIVE；真正完成后暂停自动化并报告。新的heartbeat若仍有活跃同任务不重复启动。

## 最终验收（2026-10-22 上海时间）

状态：IMPLEMENTED_AND_VERIFIED_WITH_DOCUMENTED_PLATFORM_LIMITS。本轮约定的八项工程补强已落地；388 tests / 387pass / 0fail / 1外层沙箱skip，check通过，实际Mac OS隔离1/1、trace4/4、E2E15/15。独立交叉审查CTX-REV001..004、EXECREVIEW001..004、INTREVIEW001..002全部修复并复现复测。最终src/package/eval/test digest c2fc8e58e3f02d52f7509fbb2ceec30d33f1c1e3cd21f92532d76d322cd3a90c。

最终交付与限制：docs/harness-upgrade-review-2026-10-22.md。固定引用：docs/harness-reference-notes-2026-10-22.md；各worker notes为补充证据。实际付费模型、Linux运行验收、Mac主动setsid不可逃逸清理、聚合资源配额、符号链接自动undo等没有宣称完成；属于显式能力边界，见交付报告。前文实施中的剩余清单是历史记录，以本段和最终报告为准。

自动化按用户授权将在本次完成后暂停，避免再次重复执行；现有更改全部留在工作树，不替用户commit。

自动续接收尾已完成：deecoo-harness经automation_update更新，随后读取automation.toml验证status="PAUSED"；没有购买额度或使用重置券。

## 后续 DeepSeek Harness 借鉴（2026-10-22）

用户要求检查 DeepSeek Harness 后又授权“继续”。参考固定官方 `deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`（MIT），只实施评估优先项 DSH-REF-001/002/003：输出合同、可恢复大输出、实际路由准备。其余 004/005/006 仍为后续/条件建议。实施记录：`docs/deepseek-harness-implementation-2026-10-22.md`；模块 notes 为补充证据。原八项已完成状态不变。

收尾中：root 完成 registry/runtime/loop/taskRunner/reporter 集成、扩展任意字段真实模型循环、头尾预览/分页/秘密过滤/同进程私有恢复及文档。全量已到447 tests /446pass/0fail/1skip，Trace4/4、E2E15/15，但之后独立审查发现 OUT-REV-004（控制字符读取页被再次spill）与 OUT-REV-005（预算checkpoint的私有store被误dispose），正在补修及复跑，不能用前述计数宣称本轮已验收。

当前分工：upgrade_context_storage 实施纯 outputPage 收缩及 modelOutput read_output 分支，叠加同进程恢复新增secretRegistry；root负责taskRunner按checkpoint owner保留私有store、resume时加入新secretRegistry与集成测试、最终全套/文档。代码稳定后root统一 `npm run check`、`npm test`、Trace/E2E至/private/tmp，独立复核通过再完成。当前Node/npm路径 `/Users/adib/.nvm/versions/node/v24.22.1/bin`（shell原PATH缺失），以env PATH前置；之前24.21.0基线不冒充最新运行。自动化仍PAUSED，额度工具允许普通usage，不使用重置券/购买额度。

### DeepSeek 后续最终验收

DSH-REF-001/002/003：**IMPLEMENTED_AND_VERIFIED_WITH_DOCUMENTED_LIMITS**。OUT-REV-001..005及信任包装预算、编码副本、新秘密规则、数组形状、非流式兼容、策略后路由身份和审计数字/来源标签问题均修复并复测。新增输出读取页始终保留原引用与精确字节游标，不递归spill；私有checkpoint预算停机可以同进程继续，正式完成后撤销引用。

产品稳定后最终check exit0；461 tests /460pass /0fail /1外层OS沙箱skip；Trace4/4、离线E2E15/15，exit均0。独立定向输出/存储60/60及请求/恢复/审计探针均通过。154文件内容digest `69a04cdb3d3fa09d39a434c204447220d2dbfe356c42b037a39f9eeed3f39548`，Node v24.22.1；生成报告留在/private/tmp，未改eval/reports或提交Git。详见 `docs/deepseek-harness-implementation-2026-10-22.md` 的精确命令、日志与报告路径。

004/005仍是后续建议，006为条件采用，不在此次已完成范围。原八项补强自动化经读取配置确认仍PAUSED，不重复唤醒；没有购买额度、使用重置券。前文“收尾中”为过程记录，以本节及实施报告为最终状态。

## DeepSeek 004/005 后续最终验收

用户再次授权“继续”后，DSH-REF-004可追溯压缩/请求诊断/事件续接、DSH-REF-005插件作用域/精确注销/异步清理均已实施。状态：**IMPLEMENTED_AND_VERIFIED_WITH_DOCUMENTED_LIMITS**。原始model transcript与派生投影分开，事务严格缩小并检查源；checkpoint等待事件水位/持久化，崩溃journal尾部只恢复诊断不重放效果；task setupPlugins自动释放，清理失败状态和持久报告一致。旧system摘要无可验证源时明确拒绝，私有投影/有界日志覆盖清楚声明。

独立审查 LIFE-REV-001（setup cleanup失败无持久诊断）、LIFE-REV-002（secret Error.code泄漏）、ephemeral no-op日志假持久、request schema被通用secret-key过滤破坏等均已修复复测。首轮510tests基线在最终修复后统一重跑：**511 tests /510pass /0fail /1外层OS沙箱skip**，check exit0，Trace4/4、真实任务离线E2E15/15，均exit0。root lifecycle12/12，scope独立6/6、journal独立6/6及实际探针通过；未用跳过/放宽验收隐藏失败。

最终Node v24.22.1；162文件内容digest `098ac3d516f09f97dc002dd762d69bbc789ddb90f7efe54415ba02c7a107f9a5`，HEAD仍50e809d8a286662d42e8d462b2c9772d9f2dd30d加保留的工作树改动。详细参考固定commit/permalink/MIT、接口、测试报告路径和能力边界：`docs/deepseek-harness-lifecycle-review-2026-10-22.md`。没有修改eval/reports、提交Git、安装依赖、调用付费模型或购买/重置额度；原八项续接自动化仍PAUSED。

前文004/005“后续建议”是历史状态，以本节为准。006远程执行世界、AgentHandle/durable inbox/preset/外部agent等仍是条件扩展，未把其研究建议计作实现。当前没有需继续的已授权本轮工作。
