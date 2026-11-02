# Harness 0.1.10 修复与验收

日期：2026-11-02（Asia/Shanghai）。对照 [修改后复核报告](/Users/adib/Documents/Deecoo/docs/harness-assessment-recheck-2026-11-02.md)，基线 `d0100c07526dfdf357d009ee0e128b3d4b5809b4`，验收目标为基线之上的本轮 0.1.10 产品代码、测试与文档补丁。版本发布时间 `2026-11-02T12:54:12+08:00`；提交身份以 Git 及安装后的 `deecoo --version` 为准。

**11 个未关闭 ID 均已修复并通过对应反例/正例验收。** 前轮已关闭的 QUALITY-001、R2-P1-5、R2-P1-6 也通过本轮完整回归。此结论针对报告中的已确认问题，不表示安装 doctor、真实模型多次基准、Linux/Windows 能力矩阵等产品路线建议也已全部实施。

本轮保留了原始报告及其历史状态，在报告顶部增加当前结果入口。既有 staged 的 2026-10-29 报告纳入交付，没有丢弃既有改动。

## 按原 ID 验收

### CTRL-001 — 纯审查不能因名称中的动作词获得写权限

- decision: adjusted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- 修改 [taskIntent.js](/Users/adib/Documents/Deecoo/src/harness/taskIntent.js)：识别带引号的符号名、并列审查对象及中文引用对象；保留明确独立的修改指令、否定约束和显式任务模式。
- 原真实 runtime 反例 `Review the "update" function in @src/api.js` 现在返回 `TASK_TOOL_BLOCKED`，文件保持原样；并列 update/delete endpoints 也只读。明确 `Update the "fix" function`、修复并审查等仍可写；解释 how to apply 的请求保持原只读行为。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；solution_reliability=high，对报告命名形态有运行时及分类正反验证；patch_scope=small。
- regression_protection: [controlResidualFixes.test.js](/Users/adib/Documents/Deecoo/test/controlResidualFixes.test.js) 的新授权测试在修改前失败、修改后通过，既有 task intent/scoped 权限回归也通过。
- remaining_risk: 自然语言 intent 仍是确定性启发式，不宣称完整理解任意语义；用户可用 `--task-mode read-only` 明确约束。

### R2-P2-12 — stale session 写回不再复活已裁剪轮次

- decision: accepted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- 修改 [store.js](/Users/adib/Documents/Deecoo/src/session/store.js)：保存锁内分配稳定 turn sequence，持久化裁剪水位，合并后按稳定顺序构建 recent；兼容旧格式、相同内容的不同轮次、显式约束及 ephemeral。
- 原 25KB 探针从“u1..u7 复活、u28..u34 消失”变为近期 u29..u34 保留并追加 LATEST-B，`oldResurrected=false`。正常容量裁剪仍可删除最旧轮次，不能将其误称为数据永不裁剪。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，包含加法式旧格式迁移；solution_reliability=high；patch_scope=medium。
- regression_protection: [storageReviewFollowup.test.js](/Users/adib/Documents/Deecoo/test/storageReviewFollowup.test.js) 覆盖 stale 重复保存、裁剪水位、交错写回、重复合法轮次、约束与旧格式迁移；原探针前后结果及独立复核一致。
- remaining_risk: 旧版程序直接改写同一会话文件不受新版 save 合同保护；升级后应重启旧进程。

### CTRL-002 — 恢复任务使旧源码与 diff 证据失效

- decision: accepted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- [checkpoints.js](/Users/adib/Documents/Deecoo/src/harness/checkpoints.js) 记录 executor 创建的 `workspace-resumed` 边界；[sourceEvidence.js](/Users/adib/Documents/Deecoo/src/harness/sourceEvidence.js) 供 [acceptance.js](/Users/adib/Documents/Deecoo/src/harness/acceptance.js) 与 [reviewReport.js](/Users/adib/Documents/Deecoo/src/reporter/reviewReport.js) 共用。历史内容保留作上下文，不再充当当前源码证明；历史 agentState 也不能覆盖现代 effects 的当前内容。
- 外部把 a+b 改成 a-b 后，final-only resume 的 full review 和 a+b assertion 均失败；重读当前源码后 review 可通过，断言按实际内容决定，旧 diff 也失效。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；solution_reliability=high；patch_scope=medium。
- regression_protection: 原 runtime 探针已从错误 completed 变为 failed；storageReviewFollowup 同时覆盖 final-only、重读不匹配、重读匹配、旧副本覆盖和 diff 正反，transcript 归档/恢复回归通过。

### CUR-EDIT-001 — 回滚保留并发编辑并明确报告部分恢复

- decision: accepted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- [files.js](/Users/adib/Documents/Deecoo/src/tools/files.js)、[secureFs.js](/Users/adib/Documents/Deecoo/src/tools/secureFs.js)、[secureFs.c](/Users/adib/Documents/Deecoo/src/tools/secureFs.c) 记录创建/移动实际产生的 dev/ino，在 native 操作边界核验身份和预期内容再回滚。
- 原探针的 USER EDIT 保留，返回 `PATCH_SET_ROLLBACK_FAILED`、`rolledBack:false` 和不确定路径；同内容替换 inode、move 源路径被重建也保留外部文件。无漂移取消仍正常回滚。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；solution_reliability=high，对确定性漂移路径有实际 native 验证；patch_scope=medium。
- regression_protection: [editIntegrityFollowup.test.js](/Users/adib/Documents/Deecoo/test/editIntegrityFollowup.test.js) 的创建/移动、并发内容、替换 inode、源路径重建和正常回滚断言通过；既有 mutation/approval/cancellation 回归通过，C helper 实际编译通过。
- remaining_risk: POSIX 检查与最终目录操作不是针对同 UID 外部进程任意竞争的全局事务；没有扩大既有威胁模型或声称绝对并发隔离。

### R2-P2-JSON — 无关数字保留原精度

- decision: adjusted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- 新增 [losslessJson.js](/Users/adib/Documents/Deecoo/src/tools/losslessJson.js)，JSON-pointer 编辑中以内部数字表示保留原字面量，序列化时还原；不通过拒绝合法大整数编辑降低功能。
- 原 counter=9007199254740993 保留；小数、指数、极大/极小值、负零、数组内数字及普通字符串保持正确。数字仍是 scalar，不能通过 `/counter/source` 操作内部表示；无效 JSON 不被隐式“修复”。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；solution_reliability=high；patch_scope=small。
- regression_protection: editIntegrityFollowup 覆盖原触发、数字形态、标记碰撞、操作新字符串、内部表示不可穿透及无效输入不写文件；原探针由舍入变为逐字保留。
- remaining_risk: JSON patch 仍按既有合同输出格式化 JSON；本次保证未改数字的精度，不承诺整个 JSON 原文排版完全不变。

### R2-P2-8 — 混合换行按行保留

- decision: accepted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- [files.js](/Users/adib/Documents/Deecoo/src/tools/files.js) 中 hunk 同时移动每行 EOL，未修改行保留原分隔符，新插入行使用邻近分隔符并维持 EOF 换行合同。
- 原 one-CRLF/two-LF/three-LF 只改第二行后仍只有一个 CRLF；插入/删除、纯 LF/CRLF、无末尾换行、patch-set 路径均通过。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；solution_reliability=high；patch_scope=small。
- regression_protection: editIntegrityFollowup 中逐字输出断言及既有 structured patch 回归通过。

### R2-P2-2 — 精确命令批准绑定真实 cwd

- decision: accepted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- [shellApprovals.js](/Users/adib/Documents/Deecoo/src/permissions/shellApprovals.js)、[shell.js](/Users/adib/Documents/Deecoo/src/tools/shell.js)、[settings.js](/Users/adib/Documents/Deecoo/src/config/settings.js) 使用 cwd-v1 键；旧 command-only 记录保留但不自动生效。审批后再次核验工作区别名，换向则拒绝派发。
- 原两个 cwd 的 npm test 从仅一次审批变为分别审批；同一真实目录/普通别名可复用，持久化重载也保持该边界。明确“批准本项目全部 warn 命令”的广泛授权仍保留。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low/medium；solution_reliability=high；patch_scope=medium。
- regression_protection: [permissionResidualFixes.test.js](/Users/adib/Documents/Deecoo/test/permissionResidualFixes.test.js) 覆盖目录区别、重载、旧记录、别名及审批期间换向；原 shell/settings/prompter 回归通过。

### R2-P2-3 — 项目账号与路由必须显式信任

- decision: adjusted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- [dotenv.js](/Users/adib/Documents/Deecoo/src/cli/dotenv.js) 默认忽略项目 provider/model/key，并说明原因；`--trust-project-env` 或真实 Shell 的 `DEECOO_TRUST_PROJECT_ENV=1` 可明确选择。只加载选中工作区，项目不能自行开启信任，即使信任后也不能供应 endpoint、安全策略、存储或预算配置。
- [environmentSources.js](/Users/adib/Documents/Deecoo/src/config/environmentSources.js) 与 CLI 显示 provider、endpoint、凭据来源；不显示密钥，endpoint 去除 userinfo/query/fragment，settings 赋值正确标记来源。
- 原探针现在保持 settings 的 DeepSeek 和账号；显式信任正例可使用项目账号，已有真实进程值不被覆盖。README 与 help 已同步迁移方式。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium，包含显式配置迁移；solution_reliability=high；patch_scope=medium。
- regression_protection: permissionResidualFixes 覆盖默认拒绝、自授权拒绝、显式信任、选中目录、真实进程优先及 settings 来源正反；全程合成账号、没有网络请求。

### R2-P2-1 — 动态命令名和 find 副作用不再自动 allow

- decision: accepted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- [shellPolicy.js](/Users/adib/Documents/Deecoo/src/permissions/shellPolicy.js) 对 brace/ANSI-C/glob/变量等动态 executable 及 find/gfind 删除/写文件选项至少 warn。
- 原三个分类反例均从 allow 变为 warn，只读 find 正例仍 allow；没有执行危险字符串。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；solution_reliability=high，对报告分类形态有直接正反验证；patch_scope=small。
- regression_protection: permissionResidualFixes 及既有 wrapper、env split-string、敏感路径、shell policy 测试通过。
- remaining_risk: 分类器仍为保守启发式，不宣称完整解析所有 Bash 语法；OS 执行边界仍保留。

### CTRL-004 — 显式输出目标参与进展，构建噪声仍排除

- decision: adjusted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- [workspaceFingerprint.js](/Users/adib/Documents/Deecoo/src/harness/workspaceFingerprint.js) 从用户任务提取有界的明确路径，加入 fingerprint；[loop.js](/Users/adib/Documents/Deecoo/src/agent/loop.js) 接线。模型不能凭自己选择的命令把所有构建噪声加入进展。
- 原 dist/progress.txt 连续十次追加在普通及 Git-ignored 目录均完成；没有明确目标的重复失败/重写构建噪声仍停止。越界/工具目录不加入，超容量或无法判断的状态返回 unknown。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=medium；solution_reliability=high，对报告目标及原停止保护有集成验证；patch_scope=small。
- regression_protection: controlResidualFixes 的十次实际写入在修改前失败、修改后通过；reviewRound3 和 stepBudgetProgress 既有噪声/循环正反通过，独立路径边界探针通过。

### CTRL-003 — inline 调用和声明可作为源码

- decision: accepted；outcome: implemented；issue_evidence: confirmed；verification_result: passed。
- [reviewReport.js](/Users/adib/Documents/Deecoo/src/reporter/reviewReport.js) 接受调用式表达式与源码声明，不要求引导语必须含 code。
- 原 `Review this:` + Python `print(1 / 0)` 通过；Ruby 调用、return 片段和声明也可用；日志/输出主题、空 fence 及只有语言标签但无源码形态的 Build failed 仍拒绝。
- solution_fit: suited=yes；executable=yes；affordable=yes；cost=low；solution_reliability=high；patch_scope=small。
- regression_protection: storageReviewFollowup 与既有 reviewCoverage 的源码/日志正反通过。

## 完整验证与独立复核

- macOS、Node v24.22.1，未在本轮重跑 Linux/Windows 或 Node 20/22 矩阵。
- `npm run check`：exit 0。
- `npm test`：exit 0，711 total、710 pass、0 fail、1 skip。唯一 skip 是本机 OS 后端可用时不适用的 required-unavailable 分支；grader 的真实隔离测试实际执行通过。
- `npm run eval -- --no-report --fail-on-failed --json`：exit 0，16/16。
- `npm run eval:trace -- --no-report --fail-on-failed --json`：exit 0，4/4。
- `npm run test:sandbox`：exit 0，3/3、0 skip。单元、E2E 与严格 gate 在宿主运行以允许真正的子 sandbox。
- 30 项新增回归覆盖这 11 个 ID；相关旧合同回归一并通过。没有改 eval/reports、生成项目上下文或通过付费 provider 验证。
- 独立交叉复核：存储实现者只读检查控制/进展，编辑实现者检查权限/配置，权限实现者检查存储/恢复；root 检查所有实际 diff。发现的非必要新动作词导致解释请求可写，已移除并加入回归；来源显示的 settings 标记也已校正。复核结束无已确认的发布阻断项。
- 原生 helper 实际编译及既有父目录/取消/审批边界测试通过；没有将有限的确定性并发保护描述为全局事务。
- README、help、CHANGELOG 和 package/lock 版本同步为 0.1.10。安装使用既有 `npm link` 源码链接方式，无需新增构建链或 npm 发布。

日志：[check](/private/tmp/deecoo-release-20261102-check.log)、[unit](/private/tmp/deecoo-release-20261102-unit.log)、[E2E](/private/tmp/deecoo-release-20261102-e2e.log)、[trace](/private/tmp/deecoo-release-20261102-trace.log)、[sandbox](/private/tmp/deecoo-release-20261102-sandbox.log)。临时日志不是长期归档，长期回归证据为上述仓库测试。

本报告确认修复和复核结果；Git 推送与本机安装的实际提交号、版本及结果在交付消息中记录。历史报告的 open/failed 不应再被当作这一版本的当前状态。
