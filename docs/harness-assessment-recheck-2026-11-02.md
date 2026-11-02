# Harness 修改后复核（2026-11-02）

> 本文是实施前复核快照；后续授权修复已完成，11 个未关闭 ID 的当前结果见 [0.1.10 修复与验收](/Users/adib/Documents/Deecoo/docs/harness-fixes-verification-2026-11-02.md)。以下结论保留其基线含义。

对照报告：[2026-10-29 当前问题评估](/Users/adib/Documents/Deecoo/docs/current-harness-assessment-2026-10-29.md)。原报告快照 `af927b81354ce5dac576af1e9ec96ab315724588`（0.1.8）；本轮目标 `d0100c07526dfdf357d009ee0e128b3d4b5809b4`（package 版本 0.1.9，CHANGELOG 另有未发布条目）。

**结论：原报告的 14 个问题 ID，3 项可关闭、2 项部分修复、9 项仍存在。** 已有修改解决了实质问题，但尚不能宣称报告全部处理完成。本轮只读复核产品代码，新增本记录；没有修复代码、提交、推送或调用付费模型。

以下 `verification_result: failed` 表示当前实现没有通过该问题的关闭条件，定点探针成功复现了缺陷；不要与命令执行失败混淆。原报告中的历史证据保留其原快照含义。

## 尚未关闭的高优先级问题

### CTRL-001 — 审查授权仅部分修复，双引号标识符与并列对象仍被当作动作

- severity: P1；decision: accepted；outcome: partially-implemented；issue_evidence: confirmed。
- 已修：`Review @src/update.js`、`create()`、反引号代码、连字符名称等不再授予写权限；明确“修复并审查”等复合请求仍可写。
- 当前反例：`Review the "update" function in @src/api.js`。真实 `runTask`、workspace-write 模式下，`edit_file` 返回 `ok:true`，没有审批，源码从 `return 1` 改成 `return 2`。最终任务因 `task_contract_invalid` 失败，但越权修改已经保留；不能用最终失败视作授权保护有效。只把双引号改成反引号，同一编辑返回 `TASK_TOOL_BLOCKED`，文件不变。`Review the update and delete endpoints in @src/api.js` 的 intent 也仍判为可写（后一个例仅验证 intent）。
- 位置：[taskIntent.js:59](/Users/adib/Documents/Deecoo/src/harness/taskIntent.js:59) 只剔除了部分引用形态；[taskIntent.js:26](/Users/adib/Documents/Deecoo/src/harness/taskIntent.js:26) 将残留名称当成写动作。
- 建议：识别审查对象、引号标识符和并列名词，只有独立明确的修改指令才授予写能力；不要简单删除所有引号内容而误吞真正的修改请求。保留一个共同能力合同用于工具暴露、执行拦截和最终校验。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=双引号/单引号/反引号及并列对象的真实 runTask 均禁止写入，明确修改复合指令仍可完成。
- verification_result: failed，原命名路径反例已通过，新引用反例仍越权；[脚本](/private/tmp/deecoo-recheck-control-20261102.mjs)、[结果](/private/tmp/deecoo-recheck-control-20261102.json)。

### R2-P2-12 — stale writer 仍会复活旧轮并删除近期持久历史

- severity: P1，保留原报告根据实际数据丢失上调的级别；decision: accepted；outcome: not-implemented；issue_evidence: confirmed。
- 当前反例：25KB 上限，A 保存到 u34，B 持有 u0..u7 的旧副本后写入 LATEST-B。保存前 history 为 u28..u34；保存后变为 u1..u7,LATEST-B，recent 为 u3..u7,LATEST-B。最近七轮仍从持久 history 消失，旧轮复活。
- 位置：[store.js:351](/Users/adib/Documents/Deecoo/src/session/store.js:351) 仍按 current+incoming 去重后重建 turns；[store.js:279](/Users/adib/Documents/Deecoo/src/session/store.js:279) 的容量裁剪记录数量与约束，没有可拒绝旧轮的水位或墓碑。本轮 transcript 归档修改没有解决这一独立根因。
- 建议：稳定 turn 顺序与身份，持久记录裁剪水位/墓碑，再合并、压缩与裁剪；兼容旧 session，保留近期轮次与显式约束。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，涉及旧格式迁移；verification=交错 stale 保存后近期轮次存在、已裁剪旧轮不复活。
- verification_result: failed，重跑 [原 session 探针](/private/tmp/deecoo-audit-session-probe.mjs) 仍得到上述数据丢失。

## 其他仍存在的问题

### CTRL-002 — resume 后旧源码证据仍有效

- severity: P2；decision: accepted；outcome: not-implemented；issue_evidence: confirmed。
- 当前反例：真实 runTask 读取 `a + b` 后 maxSteps=1 停止；外部改为 `a - b`；恢复后模型只答最终结果，无工具调用。`Full review @a.js` 仍 completed、coverage.inspected；要求源码包含 `a + b` 的 no-change assertion 也 passed。唯一 read revision=0，resume 后 revision=1。
- 位置：[checkpoints.js:98](/Users/adib/Documents/Deecoo/src/harness/checkpoints.js:98)、[reviewReport.js:92](/Users/adib/Documents/Deecoo/src/reporter/reviewReport.js:92)、[acceptance.js:127](/Users/adib/Documents/Deecoo/src/harness/acceptance.js:127)。测试验证状态已失效，源码覆盖/源码断言没有使用同一 resume 新鲜度边界。
- 建议：coverage 与 source assertion 共用 resume freshness fence，只接受恢复后完整当前版本读取；历史仍可供模型参考，不应继续充当当前验收证据。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=外改后 final-only resume 不通过，重读后按当前内容决定。
- verification_result: failed；[本轮真实 runtime 探针](/private/tmp/deecoo-recheck-resume-20261102.mjs)。

### CUR-EDIT-001 — create 回滚仍删除并发编辑

- severity: P2；decision: accepted；outcome: not-implemented；issue_evidence: confirmed。
- 当前反例：patch-set 创建文件后，时序钩子模拟其他写者改为 `USER EDIT` 并取消；返回 `PATCH_SET_WRITE_FAILED`、`rolledBack:true`、`uncertainPaths:[]`，用户编辑所在文件却已删除。
- 位置：[files.js:717](/Users/adib/Documents/Deecoo/src/tools/files.js:717)。create 分支仍直接 unlink，未像 update 分支比较预期内容。
- 建议：绑定创建时身份与内容；不匹配时保留文件并报告部分回滚与不确定路径，相关 move 回滚也应采用同类保护。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=并发编辑保留且明确部分失败，未改文件正常回滚。
- verification_result: failed；本轮 residual 探针再次复现。

### R2-P2-JSON — JSON patch 仍静默损坏无关大整数

- severity: P2；decision: accepted；outcome: not-implemented；issue_evidence: confirmed。
- 当前反例：只 set `/enabled`，`counter:9007199254740993` 被写成 `9007199254740992`，工具返回成功。
- 位置：[files.js:956](/Users/adib/Documents/Deecoo/src/tools/files.js:956)、[files.js:976](/Users/adib/Documents/Deecoo/src/tools/files.js:976)，仍全文 JSON.parse/stringify。
- 建议：保留原始数值/文本跨度的编辑；短期至少检测不可保真数值并拒绝覆盖原文件。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=无关大整数逐字保持，或拒绝写入且原文件不变。
- verification_result: failed；本轮 residual 探针再次复现。

### R2-P2-8 — 文本 patch 仍统一混合 EOL

- severity: P2；decision: accepted；outcome: not-implemented；issue_evidence: confirmed。
- 当前反例：`one\r\ntwo\nthree\n` 只改第二行，CRLF 数由 1 变为 3；未修改行也改变。
- 位置：[files.js:1062](/Users/adib/Documents/Deecoo/src/tools/files.js:1062)、[files.js:1070](/Users/adib/Documents/Deecoo/src/tools/files.js:1070)。
- 建议：保留每行分隔符，对新插入行采用明确定义的局部规则。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=未修改行 EOL 不变，纯 LF/CRLF 和末尾换行兼容。
- verification_result: failed；本轮 residual 探针再次复现。

### R2-P2-2 — standing approval 仍不区分 cwd

- severity: P2；decision: accepted；outcome: not-implemented；issue_evidence: confirmed。
- 当前反例：根目录批准 `npm test` 后，`vendor/x` 同名命令复用审批；mock backend 记录 executions=2、distinctCwds=2、prompts=1。
- 位置：[shell.js:28](/Users/adib/Documents/Deecoo/src/tools/shell.js:28)、[shell.js:43](/Users/adib/Documents/Deecoo/src/tools/shell.js:43)，键仍只有规范化命令。
- 建议：绑定规范化真实 cwd+命令，保守迁移旧记录，明确展示审批作用域。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low/medium；verification=同 cwd 可复用、不同 cwd 再审批、路径别名一致。
- verification_result: failed；本轮 residual 探针再次复现，未实际执行 npm test 命令。

### R2-P2-3 — 项目 .env 仍能替换 settings 中的账号与路由

- severity: P2；decision: accepted；outcome: not-implemented；issue_evidence: confirmed。
- 当前反例：真实进程环境无对应 provider/key、用户 settings 选择 DeepSeek，项目 .env 填写 OpenAI 和合成仓库账号；loadConfig 得到 provider=openai、usesRepositoryAccount=true。未发送网络请求。
- 位置：[dotenv.js:7](/Users/adib/Documents/Deecoo/src/cli/dotenv.js:7)、[dotenv.js:31](/Users/adib/Documents/Deecoo/src/cli/dotenv.js:31)、[env.js:7](/Users/adib/Documents/Deecoo/src/config/env.js:7)。
- 建议：区分真实进程环境与项目配置来源，未信任项目不能静默切换账号/endpoint；保留明确授权项目 .env 的用法并显示来源。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，涉及配置兼容；verification=未信任项目不覆盖，明确授权项目配置仍可用。
- verification_result: failed；本轮 residual 探针再次复现。

### R2-P2-1 — 动态命令与 find 副作用仍分类为 allow

- severity: P2；decision: accepted；outcome: not-implemented；issue_evidence: confirmed（分类合同）。
- 当前反例：原报告的 brace command-position、ANSI-C quoting 形式和 `find . -delete` 三个分类例仍为 allow。仅送入分类器，未执行任何删除。
- 位置：[shellPolicy.js:133](/Users/adib/Documents/Deecoo/src/permissions/shellPolicy.js:133)、[shellPolicy.js:286](/Users/adib/Documents/Deecoo/src/permissions/shellPolicy.js:286)，调用方 [shell.js:39](/Users/adib/Documents/Deecoo/src/tools/shell.js:39) 将 allow 视为无需审批。
- 建议：无法可靠解析的动态命令位置至少 warn，补足工具副作用选项；OS sandbox 不能替代对可写工作区的审批。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=这些分类不再 allow，明确只读命令仍可用。
- verification_result: failed；本轮 residual 探针再次确认原分类行为。没有扩大到其他攻击探索。

### CTRL-004 — 普通文件持续写入已修，明确输出目标仍可能误停

- severity: P2；decision: accepted；outcome: partially-implemented；issue_evidence: confirmed。
- 已修：普通根目录文件连续追加计为进展；重复失败和只更新构建噪声的命令仍会停止，方向合理。
- 当前限定反例：非 Git 工作区，用户明确要求 `Append one x to dist/progress.txt ten times, one command per step.`，实际第 5 次后 no_progress，内容为 `xxxxx`。
- 位置：[workspaceFingerprint.js:14](/Users/adib/Documents/Deecoo/src/harness/workspaceFingerprint.js:14)、[workspaceFingerprint.js:49](/Users/adib/Documents/Deecoo/src/harness/workspaceFingerprint.js:49) 无条件排除常见输出目录；[loop.js:723](/Users/adib/Documents/Deecoo/src/agent/loop.js:723) 没有结合显式目标判断。
- 建议：让明确指定的输出/重复目标参与进展判定，保留构建产物噪声过滤。不应为此把所有构建重写都当成有效进展。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；verification=显式输出重复目标完成，普通失败循环及纯构建噪声仍停止。
- verification_result: failed，新增限定反例未通过；[脚本](/private/tmp/deecoo-recheck-control-20261102.mjs)、[结果](/private/tmp/deecoo-recheck-control-20261102.json)。

### CTRL-003 — inline Python 调用式源码仍被拒绝

- severity: P2；decision: accepted；outcome: not-implemented；issue_evidence: confirmed。
- 当前反例：`Review this:` 加 python fence、正文 `print(1 / 0)`，inlineSource=false 且缺源码证据；仅在引导语增加 code 则通过。纯 Build failed 日志反例仍正确拒绝。
- 位置：[reviewReport.js:139](/Users/adib/Documents/Deecoo/src/reporter/reviewReport.js:139)、[reviewReport.js:143](/Users/adib/Documents/Deecoo/src/reporter/reviewReport.js:143)。
- 建议：识别明确语言/源码形态与调用式片段，同时保留日志拒绝，不只靠引导语含 code。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；verification=Python/Ruby 调用及函数片段通过，日志仍拒绝。
- verification_result: failed；本轮 residual 探针再次复现。

上述七个未修改的 residual ID（CUR-EDIT-001、R2-P2-JSON、R2-P2-8、R2-P2-2、R2-P2-3、R2-P2-1、CTRL-003）的产品源码在两次快照间没有改动。[本轮共同探针](/private/tmp/deecoo-recheck-residual-20261102.mjs) 使用临时文件、mock backend 和合成配置，exit 0；这里的成功是缺陷复现成功。

## 可以关闭的三项

### QUALITY-001 — 独立 grader 已进入任务执行沙箱

- decision: already-fixed；outcome: implemented；verification_result: passed。
- [execution.js:106](/Users/adib/Documents/Deecoo/eval/execution.js:106) 创建沿用 task sandboxPolicy 的 ExecutionBackend；[execution.js:263](/Users/adib/Documents/Deecoo/eval/execution.js:263) 通过该后端执行 grader，获得沙箱、超时及进程树处理。正常返回的失败任务也沿用同一评分路径；任务抛出时不执行 grader，没有宿主 fallback。
- [benchmark.js:87](/Users/adib/Documents/Deecoo/eval/benchmark.js:87) 在任何 provider 调用前检查 required 沙箱；没有后端会明确拒绝。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，已落实；solution_reliability=high，对原缺陷有直接执行证据。
- 验证：宿主运行的 `R3-QUALITY-001` 确实执行并通过，没有 skip；正常行为检查与工作区外 marker 拒绝断言通过。严格 OS 沙箱文件/网络 gate 3/3。
- 局限：没有新增 grader 专属网络、失败任务或后代进程测试；统一后端调用有源码依据，不把其他 backend 测试伪称为这些路径的专属测试。

### R2-P1-6 — 健康长流不再被总请求时长中断，已输出后不重试

- decision: already-fixed；outcome: implemented；verification_result: passed。
- [retry.js:28](/Users/adib/Documents/Deecoo/src/llm/retry.js:28) 建立空闲计时器，delta 刷新并标记 emitted；[retry.js:42](/Users/adib/Documents/Deecoo/src/llm/retry.js:42) 在已输出/已取消时禁止重试。[deepseekClient.js:135](/Users/adib/Documents/Deecoo/src/llm/deepseekClient.js:135) 覆盖文本、reasoning、工具参数和工具头；Anthropic 同样接入 delta。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，已落实；solution_reliability=high。
- 验证：[streamIdleTimeout.test.js](/Users/adib/Documents/Deecoo/test/streamIdleTimeout.test.js) 的 27 项本轮全通过，涵盖持续生成超原超时时长、无首字节、真停流、工具头/参数/reasoning 后断流不重试、用户取消。全为合成流，无付费请求。
- 局限：没有重新做真实 provider 长时输出实验；这不影响对原协议状态/重试根因的定点验证。

### R2-P1-5 — transcript 不再重复塞入 checkpoint，容量耗尽有明确降级

- decision: already-fixed；outcome: implemented；verification_result: passed。
- [transcriptArchive.js:16](/Users/adib/Documents/Deecoo/src/storage/transcriptArchive.js:16) 封存原始消息及压缩 proof，文件读取内容按 digest 去重；[store.js:128](/Users/adib/Documents/Deecoo/src/session/store.js:128) 保存时归档、加载时 hydrate；checkpoint 保存活跃投影、尾部及引用。
- [checkpoints.js:34](/Users/adib/Documents/Deecoo/src/harness/checkpoints.js:34) 容量不足保留最后成功的 checkpoint，显式记录 degraded 与未保存进度，不再以容量错误中止业务任务；其他 I/O 错误仍抛出。旧内联格式兼容迁移，缺失/篡改 segment 不部分信任，ephemeral 不写盘。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium/high，已落实并保留兼容；solution_reliability=high，对原容量故障有直接集成证据。
- 验证：[transcriptGrowth.test.js](/Users/adib/Documents/Deecoo/test/transcriptGrowth.test.js) 7/7，通过40步多次压缩、小 cap、proof 恢复、旧 checkpoint 迁移、缺 segment、隐私/ephemeral 与容量降级测试。独立运行同组 7/7、0 skip。
- 局限：关闭的是原单文件 transcript 增长导致中止问题，不承诺无限持久化；分段仍受总容量/保留期约束。此项也不代表 CTRL-002 的源码新鲜度已修复。

## 原报告的完善建议

- README 两处 15 个场景已更正为 16，可关闭该小项。历史报告仍引用不存在的第十九节，尚未补齐当前状态入口；本记录提供逐 ID 的当前结论。
- 真实模型多次基准、费用/重试可观测性、安装 doctor、覆盖版本保护等，没有因本次几项修复就自动完成；本轮未做真实付费基准或安装测试。
- Linux 严格 sandbox CI 建议仍未落实：[harness-ci.yml:33](/Users/adib/Documents/Deecoo/.github/workflows/harness-ci.yml:33) 的 test:sandbox 仍限 macOS，确定性 Linux job 没有相同的安装/严格门禁。provider-benchmark 工作流另有 bubblewrap 安装，但不能代替每次 push/PR 的 gate。
- Windows 路径疑点仍为未证实，本轮未将其升级为确认问题。权限回调与控制字符展示等先前补强建议不在本轮实测关闭范围内。

## 本轮质量门禁与工作树

- 环境：macOS、Node v24.22.1；用户时区 Asia/Shanghai，复核日期 2026-11-02。未重跑 Linux/Windows 或 Node 20/22 矩阵。
- `npm run check`：exit 0。
- `npm test`：exit 0，681 total，680 pass，0 fail，1 skip。唯一 skip 为本机已有 OS 后端时不适用的“后端不可启动”分支；原生隔离另实跑。
- `npm run eval -- --no-report --fail-on-failed --json`：exit 0，16/16。
- `npm run eval:trace -- --no-report --fail-on-failed --json`：exit 0，4/4。
- `npm run test:sandbox`：exit 0，3/3，0 skip。
- 单元、E2E、严格 gate 在宿主运行以允许真实子 sandbox；check 与 trace 在默认权限执行。没有网络攻击、破坏性命令或付费模型调用。
- 快照：开始时仅原报告 `docs/current-harness-assessment-2026-10-29.md` 已 staged；保留原样。本轮新增本文件，没有其他仓库修改，也没有 commit/push。
- 覆盖：根据原报告逐项核对，并检查相关修复的调用链与反例；没有宣称全项目无遗漏。修复方案在授权、持久化及执行边界上的方向合理，主要问题是部分授权/进展输入仍漏判，以及其余已确认条目尚未实现。

日志：[check](/private/tmp/deecoo-recheck-20261102-check.log)、[unit](/private/tmp/deecoo-recheck-20261102-unit.log)、[E2E](/private/tmp/deecoo-recheck-20261102-e2e.log)、[trace](/private/tmp/deecoo-recheck-20261102-trace.log)、[sandbox](/private/tmp/deecoo-recheck-20261102-sandbox.log)。临时探针与日志不是长期归档；下一轮修复应将剩余反例转为仓库回归。

建议先完成 CTRL-001 与 R2-P2-12，再处理 CTRL-002、回滚/数据保真及配置审批；CTRL-004 与 CTRL-003 保留可执行反例。不能仅凭现有 680 项通过将 11 个未关闭 ID 一并标完成。
