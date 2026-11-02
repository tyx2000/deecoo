# Deecoo 0.1.8 当前问题与完善顺序

> 历史快照：本文的 open 与复现结果保留当时含义。当前逐 ID 修复和验收见 [0.1.10 修复记录](/Users/adib/Documents/Deecoo/docs/harness-fixes-verification-2026-11-02.md)。

日期：2026-10-29（Asia/Shanghai）。目标：`af927b81354ce5dac576af1e9ec96ab315724588`，版本 0.1.8。开始审查时工作树干净。本轮只增加本报告，未修改产品代码、既有报告或测试。

当前应优先补强授权判断、评测执行边界、长任务持久化和数据保真。已有大量回归，旧问题也确实修复了，但全绿不能证明下面的遗漏路径正确。以下是选择性审查确认的开放项，不是对全项目无遗漏的承诺；历史报告未抽查的条目不能自动视为成立或已修复。

## 应先修改的五项

### QUALITY-001 — 独立 grader 绕过任务沙箱执行候选代码

- severity: P1；status: open；issue_evidence: confirmed；lane: code/security；scope: pre-existing。
- affected_files: [eval/execution.js:247](/Users/adib/Documents/Deecoo/eval/execution.js:247)、[runIndependentCommand:256](/Users/adib/Documents/Deecoo/eval/execution.js:256)、[benchmark.js:82](/Users/adib/Documents/Deecoo/eval/benchmark.js:82)。
- failure_scenario: 任务阶段配置 required/deny，模型仅通过文件工具写候选模块。评分时 `execFile` 在宿主启动 Node 并 import 该模块，不经过 ExecutionBackend。合成模块成功写出候选工作区以外的临时 marker；即使任务本身失败，grader 仍会执行。
- impact: provider benchmark 的隔离边界在评分阶段失效，模型生成代码获得宿主进程的文件与网络权限。未访问真实凭据，也未进行真实联网攻击。
- reliable_solution: 独立断言仍由 harness 控制，但执行必须使用相同的 required OS sandbox、deny 网络、受限目录和进程树清理；不能只隔离模型的 run_shell。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=候选模块的工作区外 marker 不得出现，正常独立行为检查仍通过。
- verification_result: passed，成功复现缺陷；[合成探针](/private/tmp/deecoo-audit-quality-probes.mjs) 中 `markerOutsideCandidate:"grader escaped"`，评分命令 passed。
- post_cor_candidate: yes；suggested_tests: 评分代码 import 候选模块的文件/网络限制、失败任务仍评分、取消及后代清理。

### CTRL-001 — 路径或函数名中的动作词被当成修改授权

- severity: P1；status: open；issue_evidence: confirmed；lane: code；scope: pre-existing。
- affected_files: [taskIntent.js:9](/Users/adib/Documents/Deecoo/src/harness/taskIntent.js:9)、[taskRunner.js:137](/Users/adib/Documents/Deecoo/src/agent/taskRunner.js:137)、[taskRunner.js:295](/Users/adib/Documents/Deecoo/src/agent/taskRunner.js:295)。
- failure_scenario: `Review @src/update.js` 被推断成 edit、mayWrite=true；`审查 @src/fix.js` 也获得写权限。真实 runTask、workspace-write 模式下，假模型将 1 改为 2，零次审批，最终 completed，没有结构化 review 报告也通过。仅把文件名改为 value.js，同一编辑被 TASK_TOOL_BLOCKED 拒绝。`Review the create() function...` 也会误判。
- impact: 用户仅要求审查，工具却授予修改能力并跳过 review 验证，甚至反过来要求必须修改代码。这是权限合同错误，不能仅调整提示词文案。
- reliable_solution: 在自然语言动作判断之前排除路径、标识符、引用代码中的动作词；保留明确“修复并审查”的复合请求。模式与执行权限应使用同一已验证合同。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=带 update/fix/create 等文件名与函数名的纯审查始终只读，真正修改请求仍可写。
- verification_result: passed，真实 runtime 正反例复现；无真实 provider。
- post_cor_candidate: yes；suggested_tests: 词法探针和实际 runTask 的能力、文件内容、review gate 三层断言。

### R2-P1-5 — checkpoint 保留全部 transcript，活跃上下文压缩后仍会超容量

- severity: P1；status: open；issue_evidence: confirmed；lane: code/storage；scope: pre-existing，沿用第二轮报告 ID。
- affected_files: [compaction.js:28](/Users/adib/Documents/Deecoo/src/context/compaction.js:28)、[compaction.js:78](/Users/adib/Documents/Deecoo/src/context/compaction.js:78)、[checkpoints.js:28](/Users/adib/Documents/Deecoo/src/harness/checkpoints.js:28)、[taskRunner.js:259](/Users/adib/Documents/Deecoo/src/agent/taskRunner.js:259)、[governance.js:11](/Users/adib/Documents/Deecoo/src/storage/governance.js:11)。
- failure_scenario: 原始消息与替换消息永久追加在 contextState，严格 checkpoint 每步复制保存全体，默认单文件 8MiB。真实压缩/写入组件探针中，13 次合成压缩后 live messages 仅 77B，transcript 已有 9,103,911B，strict writer 抛 STORAGE_CAPACITY。这里的 13 次是组件探针，不是声称真实任务必在第 13 步失败。
- impact: 受支持的长任务会因内部记录体积中止，压缩 provider 上下文并没有解决持久化容量。
- reliable_solution: 原始 transcript 追加存储，checkpoint 保存活跃投影、引用和证明；移除恢复时必丢弃的冗余观察副本。容量不足保留上次可恢复检查点并显式记录持久化降级，不能伪称已保存最新状态。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium/high，涉及恢复格式和隐私模式兼容；verification=大量压缩后继续运行、恢复及源证明仍成立。
- verification_result: passed，成功复现容量错误；[组件探针](/private/tmp/deecoo-audit-checkpoint-probe.mjs)。
- post_cor_candidate: yes；suggested_tests: 长任务、恢复、容量耗尽与恢复兼容迁移。

### R2-P1-6 — 正常持续生成的流被总时长超时中止，工具参数流还会重试

- severity: P1；status: open；issue_evidence: confirmed；lane: errors；scope: pre-existing。
- affected_files: [retry.js:24](/Users/adib/Documents/Deecoo/src/llm/retry.js:24)、[retry.js:32](/Users/adib/Documents/Deecoo/src/llm/retry.js:32)、[deepseekClient.js:58](/Users/adib/Documents/Deecoo/src/llm/deepseekClient.js:58)、[deepseekClient.js:139](/Users/adib/Documents/Deecoo/src/llm/deepseekClient.js:139)。
- failure_scenario: 请求计时器不因持续到达的 chunk 刷新；OpenAI/DeepSeek 兼容适配器仅文本 content 设置 emitted，工具参数和 reasoning 增量不设置。55ms 超时、每 10ms 正常生成的假工具流产生 10 次 progress、2 次 fetch，最终 Request timed out。
- impact: 健康长输出被中止并从头生成，增加等待和可能的重复计费。Anthropic 工具流已有单独 emitted 标记，不能笼统说所有适配器都重复。
- reliable_solution: 分离任务总期限与请求空闲超时；任何有效生成增量后禁止自动重放，真正停流才按合同中止。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=持续工具/reasoning 流不中途超时，停流会超时，已有输出不重试，取消有效。
- verification_result: passed，合成流复现；[探针](/private/tmp/deecoo-audit-quality-probes.mjs)，无付费请求。
- post_cor_candidate: yes；suggested_tests: 流式四类增量、请求无首字节、真实停流及取消。

### R2-P2-12 — stale writer 会复活旧历史并挤掉最近历史

- severity: P1（由原 P2 上调，依据是最近持久历史实际丢失）；status: open；issue_evidence: confirmed；lane: code/storage；scope: pre-existing。
- affected_files: [store.js:319](/Users/adib/Documents/Deecoo/src/session/store.js:319)、[store.js:327](/Users/adib/Documents/Deecoo/src/session/store.js:327)、[store.js:255](/Users/adib/Documents/Deecoo/src/session/store.js:255)。
- failure_scenario: 25KB 会话上限，A 保存至 u34，B 持有 u0..u7 旧副本再保存 LATEST-B。保存前 history=u28..u34、recent=u29..u34；保存后 history=u1..u7,LATEST-B、recent=u3..u7,LATEST-B。合并只是 current+incoming 去重，之后将顺序错误的尾部视作最近轮次并裁剪。
- impact: 不只是摘要变差，最近七轮从持久 history 消失，旧轮取代上下文。任务 owner 锁不能消除先持有旧副本、稍后再保存的情况。
- reliable_solution: 保存裁剪水位/墓碑，拒绝复活已裁剪轮次；按稳定创建序和 turn ID 合并，再计算 recent 与容量裁剪。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，需兼容旧 session；verification=stale writer 保存后最新轮次与约束仍保留，旧轮不复活。
- verification_result: passed；[会话探针](/private/tmp/deecoo-audit-session-probe.mjs)。
- post_cor_candidate: yes；suggested_tests: 顺序/交错 stale writer、容量裁剪、重复轮次及摘要约束。

## 随后应修复的正确性与权限问题

### CTRL-002 — resume 未使旧源码证据失效

- severity: P2；status: open；issue_evidence: confirmed；lane: code；scope: pre-existing。
- affected_files: [checkpoints.js:67](/Users/adib/Documents/Deecoo/src/harness/checkpoints.js:67)、[reviewReport.js:92](/Users/adib/Documents/Deecoo/src/reporter/reviewReport.js:92)、[acceptance.js:125](/Users/adib/Documents/Deecoo/src/harness/acceptance.js:125)。
- failure_scenario/impact: 真实 runTask 读 a.js 后停止，外部将 a+b 改成 a-b，恢复时假模型仅回答，不读文件。Full review @a.js 仍 completed/inspected；要求 a+b 的 no-change 源断言也 satisfied。测试验证的旧证据已正确失效，漏洞在源码读取证据，不能混为同一修复。
- reliable_solution: 恢复设置源码证据 freshness 栅栏，coverage 与 source assertions 均只接受栅栏之后完整同版本读取。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=外部改文件再恢复，旧 read 不得通过 gate，重读正确内容后恢复。
- verification_result: passed，两个真实 runTask 场景均复现；post_cor_candidate: yes。

### CUR-EDIT-001 — create 回滚会删除并发产生的新编辑

- severity: P2；status: open；issue_evidence: confirmed；lane: code；scope: pre-existing。
- affected_files: [files.js:717](/Users/adib/Documents/Deecoo/src/tools/files.js:717)、[secureFs.c:106](/Users/adib/Documents/Deecoo/src/tools/secureFs.c:106)。
- failure_scenario/impact: patch-set 创建 a.txt 后，另一写者把它改成 USER EDIT，此时取消。回滚只验证普通文件便 unlink，返回 rolledBack:true、uncertainPaths:[]，用户新编辑却被删除。用现有取消测试相同的读缓存时序钩子确定性复现；update 分支已有内容比较，create 分支没有。
- reliable_solution: create/move 回滚保留创建时身份与预期内容；发现文件已被其他写者修改时保留它，明确报回滚未完全完成及不确定路径。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=并发编辑在取消后仍存在，未改动文件仍正常回滚。
- verification_result: passed；[脚本](/private/tmp/deecoo-current-rollback-20261029.mjs)、[结果](/private/tmp/deecoo-current-rollback-20261029.json)；post_cor_candidate: yes。

### R2-P2-JSON / R2-P2-8 — 编辑会改坏无关数据或扩大格式改动

- severity: P2；status: open；issue_evidence: confirmed；lane: code；scope: pre-existing。
- affected_files: [files.js:956](/Users/adib/Documents/Deecoo/src/tools/files.js:956)、[files.js:976](/Users/adib/Documents/Deecoo/src/tools/files.js:976)、[files.js:1062](/Users/adib/Documents/Deecoo/src/tools/files.js:1062)。
- failure_scenario/impact: JSON 只 set /enabled，原 counter=9007199254740993 被静默写成 9007199254740992；混合换行文件只改一行，CRLF 数从 1 变 3。两项是不同根因，均违反无关内容保真；前者实际损失数值。
- reliable_solution: JSON 使用保留数值与原文跨度的编辑，短期至少拒绝不安全数值而不覆盖原文件；文本 patch 保留每行原换行符。同步让 change-size 看见这些真实改动。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=无关大整数逐字保持，未改动行 EOL 保持，正常 JSON/patch 继续通过。
- verification_result: passed；[本地探针](/private/tmp/deecoo-current-local-probes-20261029.mjs)、[结果](/private/tmp/deecoo-current-local-probes-20261029.json)；post_cor_candidate: yes，两个 ID 分别跟踪。

### R2-P2-2 — 命令永久批准忽略执行子目录

- severity: P2；status: open；issue_evidence: confirmed；lane: code/security；scope: pre-existing。
- affected_files: [shell.js:28](/Users/adib/Documents/Deecoo/src/tools/shell.js:28)、[shell.js:43](/Users/adib/Documents/Deecoo/src/tools/shell.js:43)。
- failure_scenario/impact: 在工作区根批准 npm test 后，vendor/x 中另一份 package.json 的 npm test 也自动获批。无害 mock backend 记录两个不同 cwd 的派发，却只提示一次。workspace 级隔离已有，但工作区内不同执行主体仍混用。
- reliable_solution: 审批键绑定规范化 cwd 与命令，旧记录迁移时保守处理；显示审批的来源与作用域。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low/medium；verification=相同 cwd 复用、不同 cwd 再审批、符号链接与路径别名一致。
- verification_result: passed，prompts=1/executions=2/distinctCwds=2；post_cor_candidate: yes。

### R2-P2-3 — 项目 .env 能替换用户选择的 provider 与账号

- severity: P2；status: open；issue_evidence: confirmed；lane: code/security；scope: pre-existing。
- affected_files: [dotenv.js:7](/Users/adib/Documents/Deecoo/src/cli/dotenv.js:7)、[dotenv.js:31](/Users/adib/Documents/Deecoo/src/cli/dotenv.js:31)、[env.js:7](/Users/adib/Documents/Deecoo/src/config/env.js:7)、[env.js:11](/Users/adib/Documents/Deecoo/src/config/env.js:11)。
- failure_scenario/impact: 用户凭据在 settings、进程环境没有对应 key 时，仓库 .env 设 provider 与 key，优先级会让 prompt 通过仓库指定账号发送。合成探针从用户设置的 DeepSeek 切到 .env 的 OpenAI 与合成仓库账号；没有发送真实请求，也不推断任意 provider 账号都可读取历史 prompt。
- reliable_solution: 区分真实进程环境与项目文件来源；账号/路由切换需有明确工作区信任策略，启动显示 provider、endpoint、凭据来源。保留显式选择项目 .env 的合法用法。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，涉及配置兼容；verification=未信任项目不能替换 settings 账号，显式信任可用。
- verification_result: passed，provider=openai/usesRepositoryAccount=true；post_cor_candidate: yes。

### R2-P2-1 — shell 展开与破坏性命令分类仍有盲点

- severity: P2；status: open；issue_evidence: confirmed（分类合同）；lane: code/security；scope: pre-existing。
- affected_files: [shellPolicy.js](/Users/adib/Documents/Deecoo/src/permissions/shellPolicy.js)、[shell.js:39](/Users/adib/Documents/Deecoo/src/tools/shell.js:39)。
- failure_scenario/impact: 命令位置的 brace/ANSI-C quoting 展开形式以及 find 的删除操作，当前分类探针仍返回 allow。此处只运行分类器，未执行任何删除。OS 沙箱不保护工作区内的合法写根，因此不能以启用了 sandbox 代替命令审批策略。
- reliable_solution: 不能可靠恢复的动态命令位置至少 warn，补齐已支持工具的副作用选项；逐步减少自制文本启发式的安全承诺。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=动态删除形式和副作用子命令不再自动 allow，明确的只读命令仍可用。
- verification_result: passed，三类分类结果 allow；post_cor_candidate: yes。

### CTRL-004 — 无进展检测误杀确有 shell 写入的任务

- severity: P2；status: open；issue_evidence: confirmed；lane: code；scope: pre-existing，是 STEPS 修复后的反例。
- affected_files: [loop.js:478](/Users/adib/Documents/Deecoo/src/agent/loop.js:478)、[loop.js:710](/Users/adib/Documents/Deecoo/src/agent/loop.js:710)、[loop.js:722](/Users/adib/Documents/Deecoo/src/agent/loop.js:722)。
- failure_scenario/impact: 用户明确要求分 10 次向 progress.txt 追加 x。真实 runtime/backend 第 5 次后返回 no_progress，文件只有 xxxxx。shell effect 只记 command，重复账本既不计文件变化，也不区分实际写入进展。
- reliable_solution: 结合受控工作区差异/版本及任务明确的重复目标判断；不能因命令和退出码一样便认定没有进展，也不能取消已有失败循环保护。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=真正重复失败会停止，实际持续写入或明确重复目标能完成。
- verification_result: passed，真实临时文件只有五个 x；post_cor_candidate: yes。

### CTRL-003 — 合法 inline Python review 被拒绝

- severity: P2；status: open；issue_evidence: confirmed；lane: code；scope: pre-existing。
- affected_files: [reviewReport.js:129](/Users/adib/Documents/Deecoo/src/reporter/reviewReport.js:129)。
- failure_scenario/impact: `Review this:` 加 python fence、正文 `print(1 / 0)`，inlineSource=false；只把引导语加上 code 就通过。用户没有可读文件时，模型重试也无法满足 gate。修复原 N-4 时过度收窄了合法来源形态。
- reliable_solution: 接受清楚的语言/源码声明与调用式代码，继续拒绝日志反例；来源识别与真实文件范围 gate 分开。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=Python/Ruby 调用、函数片段通过，单纯 Build failed 日志仍拒绝。
- verification_result: passed，正反引导语探针复现；post_cor_candidate: yes。

## 需要完善的能力，不应混写成已确认漏洞

1. **评测证据与评分独立性**：先修 QUALITY-001，再运行固定模型、固定配置、多次真实任务。报告成功率、真实断言满足率、误报/漏报、人工介入、重试、费用与延迟。现有 scripted 16/16 是 harness 管线验证，不能替代模型编程质量。恢复任务要能拒绝“忽略 checkpoint 后重新开始”的假恢复；压缩测试的存活标记必须只能来自被压缩区间，不能从保护前缀轻易满足。第二轮报告有相关发现，本轮未重跑所有变异验证。
2. **CI 安全门禁**：Linux job 安装并严格验证 bubblewrap；scoped shell 也进严格 gate；验证实际匹配用例数非零，防测试改名后空通过。本次 macOS strict 3/3 不能替代 Linux 验证。
3. **安装与 doctor**：发布前测试干净安装、Node/OS 组合、cc 与 ripgrep 缺失、原生缓存失效；增加一次性能力诊断与可操作错误。POSIX+cc、Windows 不安全写入拒绝和 Linux scoped shell 不可用已在代码/README 明示，属于需要完善的平台能力，不重复报安全漏洞。可评估预编译 helper，不能为了安装方便恢复不安全 fallback。
4. **权限一致性**：凭据/策略来源可见，审批转义控制字符；所有 prompter 回调只接受明确正向值。探针确认 shell 的自定义回调返回 undefined 仍会派发，但内置 CLI prompter 会归一成 deny/false，因此这里保留为嵌入 API 合同补强，不夸大为普通 CLI 取消必然执行命令。审批文本保留 ESC/CR 已证实，实际屏幕伪装效果本轮未做视觉验证。
5. **编辑与覆盖合同**：现有 write_file 的 expectedContent/expectedSha256 明确可选；建议默认整文件覆盖需要已读版本或显式无条件覆盖意图，但不能把既有可选 API 未经迁移直接说成实现违约。Review 普通文件名、@路径、行范围和整个项目请求应有统一范围合同与准确覆盖报告。
6. **存储和可观测性**：按层限额、追加 transcript、崩溃恢复、检查点/审计故障与业务结果分离；请求快照避免每步复制全部大请求。真实 usage、缓存 token、重试和估算价格分别呈现，未知花费不能写成零。
7. **一份当前开放问题台账**：原报告仍引用不存在的第十九节；README 两处仍写 15 个场景，当前为 16。旧“未跟踪文件可能漏提交”的担忧已过时：本次初始工作树干净，相关文件已跟踪。建议维护 ID、状态、修复 commit、反例测试与验收日期，历史报告只保留当时快照，避免连续追加互相矛盾的结论。

## 未证实或本轮未覆盖

- Windows 只读路径的 `..\\` 边界存在源码疑点（pathPolicy 主要比较 ../），需要 Windows 实机或隔离平台测试；未在 macOS 上伪称 Windows 文件越界已复现。
- 同权限外部进程随意迁移已打开目录、helper 开始后强制中断等边界须结合既定敌手模型，不把所有 POSIX/同权限并发限制都列成新漏洞。
- 未重新验证第二轮报告的全部 P2/P3、真实 provider 品质或所有原生平台；也未确认当前仍存在旧报告的 P0。

## Scope And Snapshot / 验证

- repository/revision: `/Users/adib/Documents/Deecoo`，`af927b81354ce5dac576af1e9ec96ab315724588`，0.1.8，审查开始时干净；报告创建之后仅本报告是新增文件。
- environment: macOS、Node v24.22.1。本轮未在 Node 20/22 或 Linux/Windows 重新执行整个矩阵。
- coverage: 授权与任务类型、恢复/验收/Review、编辑回滚与保真、配置/审批、LLM 重试、压缩/会话、评测 grader 与 CI。并行通道覆盖控制、质量与文件边界；文件边界通道末段中断，未把未完成的额外疑点当确认事实。
- `npm run check`：exit 0。
- `npm test`：exit 0，641 项，640 通过、0 失败、1 跳过；跳过项是后端不可用时 required fail-closed 分支，本机后端可用，真实隔离另有测试。
- `npm run eval -- --no-report --fail-on-failed --json`：exit 0，harness-e2e 16/16。
- `npm run eval:trace -- --no-report --fail-on-failed --json`：exit 0，trace-grader 4/4。
- `npm run test:sandbox`：exit 0，macOS 严格检查 3/3、0 跳过，包含文件/网络隔离和 Git 配置/钩子防护。
- 全套单元和 E2E、strict gate 在可启动真实子 sandbox 的宿主执行；检查和 trace 在默认权限执行。所有定点探针均用合成 client、mock backend 或临时文件；没有付费模型请求，也未运行破坏性命令。
- verification_result 的 passed 在各 finding 中代表“缺陷复现成功”，不代表已经修复。

日志：[单元测试](/private/tmp/deecoo-current-unit-20261029.log)、[E2E](/private/tmp/deecoo-current-e2e-20261029.json)、[trace](/private/tmp/deecoo-current-trace-20261029.json)、[严格沙箱](/private/tmp/deecoo-current-sandbox-20261029.log)、[检查](/private/tmp/deecoo-current-check-20261029.log)。临时探针和日志并非永久归档；实施时应将对应反例转为仓库回归测试。

建议顺序：先做 QUALITY-001 与 CTRL-001 两个边界修复，再做 checkpoint/会话/流式超时与恢复新鲜度，随后编辑保真/回滚、审批/配置和误停/误拒。真实 provider 基准在 grader 隔离修好后执行；不以增加审查轮数或测试数量替代这些可失败的合同。
