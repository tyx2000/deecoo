# Deecoo Harness 第二轮审查报告

> 审查对象：`/Users/adib/Documents/Deecoo` 当前工作树（`main@7f1eb39`，0.1.6，另有约 54 个已修改文件和 19 个未跟踪文件尚未提交，包含前几轮的全部修复）。
> 审查视角：与 [deepseek-code-review.md](deepseek-code-review.md) 相同，以 coding-agent harness 使用者/维护者的角度，审查安全、权限、Edit 正确性、Eval 有效性、循环效率与过度设计、上下文压缩、历史存储与恢复。
> 审查方式：4 条独立只读审查通道并行取证（① 安全/权限/沙箱 ② 上下文/历史/恢复 ③ Eval 与测试有效性 ④ 循环/LLM 客户端/编辑正确性/中断），每条通道都先核对既往条目是否真正关闭，再找新问题；主审随后逐条回到源码复核，最高危的结论亲自复现。所有探针都在 scratchpad 的临时目录中运行，使用合成数据和假 client，没有调用真实模型，也没有修改仓库文件（本报告除外）。
> 日期：2026-10-23。
>
> **状态（2026-10-26 更新）**：R2-P0-1、R2-P1-1、R2-P1-2、R2-P1-3、R2-P1-4、R2-P2-9 已修复；R2-P2-1 部分修复（git 写法已关闭）。详见第九节。其余条目仍未修复。

## 证据标注约定

| 标记 | 含义 |
| --- | --- |
| `[主审复现]` | 主审亲自运行探针并复现缺陷 |
| `[主审核码]` | 主审读源码确认缺陷路径存在；复现来自通道 |
| `[通道复现]` | 通道复现，主审未逐行复核 |
| `[推测]` | 未复现，仅根据代码推断 |

## 基线

| 检查 | 结果 |
| --- | --- |
| `npm run check` | exit 0 |
| `npm test`（`scripts/run-tests.mjs`） | 625 个测试，624 通过，1 个跳过（OS sandbox 可用时按设计跳过），0 失败 |
| `npm run eval -- --no-report` | Harness E2E 16/16 |
| `npm run eval:trace -- --no-report` | 4/4 |

测试全绿，但下文 P0 与多数 P1 都是现有测试覆盖不到的真实缺陷：绿灯只说明已知契约没有回退。

---

## 一、结论摘要

前几轮的修复大部分是真的：`bash -c`/命令替换、`.env` 降级、沙箱内 git、`env -S`、父目录替换越界、局部禁改被提升为只读、重试合并与共享冷却、read_file 区间去重、journal 真追加、resume 状态失效等，通道都给出了"已修复"的证据。但这一轮的结论有三点：

1. **沙箱可以被一条 allow 级命令持久化逃逸。** 沙箱把整个工作区（含 `.git/`）设为可写，而 `git config …` 被判为 allow、无需审批。沙箱内写入的 `core.fsmonitor` 会在用户下一次普通 `git status` 时以用户的全部权限运行。主审已端到端复现。
2. **Shell 分类器仍是"枚举危险命令"的 fail-open 模型。** 新增的"项目代码"清单覆盖了常见入口，但还有大量能执行任意程序的 allow 路径（`git` 读取仓库配置、`node --check --require`、`awk system()`、`find -exec`、`sed e`、`git -c alias`），破坏性命令也能用 `git -c x=y reset --hard`、`r{m,}`、`$'\x72m'` 等写法降为 allow。
3. **数据正确性有静默损坏。** `edit_file` 会把替换文本里的 `$$`、`$&` 当作替换模式，返回 `ok:true` 却写坏文件。非流式响应被截断的工具调用会一直循环到 150 步。长任务的检查点无界增长，约 136 步时直接以 `STORAGE_CAPACITY` 中止任务。

另外，上一轮由主审做的部分修复存在缺口，本报告如实列出：history 裁剪后的并发合并会复活已裁剪轮次（CH2-4）；新加的压缩 E2E 任务的两个检查是空检查（CH3-3）；`no_progress` 停机会被任何 `run_shell` 或截断的工具参数绕过（CH4-2、CH4-4）。

| 级别 | 数量 | 主题 |
| --- | --- | --- |
| P0 | 1 | 沙箱内 `git config` 持久化到沙箱外执行（已修复） |
| P1 | 6 | run_shell git 运行仓库配置、可执行任意程序的 allow 命令、`edit_file` 的 `$` 损坏、非流式截断工具调用死循环、检查点无界增长中止任务、请求超时按总时长计并重复计费（前三项已修复） |
| P2 | 21 | 分类器降级与破坏性命令、审批键忽略 cwd、`.env` 换 provider、提示框注入、glob 绕过敏感路径、沙箱静默降级、预算越界丢弃最终答复、CRLF/JSON 改写、`write_file` 无保护覆盖、压缩吞掉未读结果、ref 选取错误、合并复活历史、压缩每步触发、脱敏漏网、审计保存未保护、Eval 四个空检查/错误检查 |
| P3 | 18 | 见第五节 |

---

## 二、既往条目复核

| 条目 | 当前状态 | 证据 |
| --- | --- | --- |
| P0-1 运行项目代码自动批准 | 部分修复 | 常见入口已为 warn（shellPolicy.js:258-280），但见 R2-P0-1、R2-P1-1、R2-P1-2 |
| P0-2 `bash -c` 载荷 | 已修复 | 递归分类，shellPolicy.js:170-197 |
| P0-3 命令替换/变量间接 | 已修复（原形态） | 残余写法见 R2-P2-1 |
| P0-4 `.env` 降级安全配置 | 已修复 | dotenv.js 白名单；残余见 R2-P2-3 |
| P0-5 沙箱内 xcrun git | 已修复 | sandbox.js:13-15,53-61；seatbelt 下 `/usr/bin/git status` 成功 |
| E-1 写入跟随符号链接 | 已修复 | secureFs.c 自根 fd 逐级 `O_NOFOLLOW`；叶子 symlink → ELOOP，硬链接 → EINVAL |
| DS-CHECK-SEC-001 `env -S` | 已修复 | `[主审复现]` 现为 warn |
| DS-CHECK-SEC-002 审批期间替换父目录 | 已修复 | 审批后重检（files.js:516 → pathPolicy.js:59），helper 直接调用也拒绝 |
| N-1 局部禁改变全任务只读 | 已修复 | taskIntent.js:9-19，"修 src、别动测试"得到 `[{kind:"tests"}]` |
| N-2 数组投影 sourceComplete | 已修复 | projection.js:41-45 |
| N-4 Review 完整范围证据门槛 | 部分修复 | 只有 `@path` 写法生效；"完整审查 a.js"在截断读取下仍判通过（reviewReport.js:69-85） |
| N-5 Ctrl-C 与第二次信号 | 已修复 | taskInterrupt.js:18-29,40；回归测试 5/5。行为副作用见 R2-P3-4 |
| P1-1 未定价模型的成本预算 | 部分修复 | CLI 拒绝启动；直接调用嵌入 API `runAgent` 时仍按 0 计价（loop.js:185） |
| DS-CHECK-COST-001 单边价格 | 已修复 | cost.js:22-25 |
| P1-2 会话/检查点明文 | 部分修复 | 按值脱敏已生效，但 JSON 转义字符串与常见令牌形态漏网，见 R2-P2-14 |
| P1-3 history 无界 | 已修复（主路径） | 裁剪不丢活跃轮次；新缺陷见 R2-P2-12；检查点另有无界问题见 R2-P1-5 |
| P1-4 eval 默认 trace | 已修复 | `npm run eval` = `--execute`；对应测试只匹配字符串（弱） |
| P1-5 无不收敛硬停 | 部分修复 | `no_progress` 存在，但被 `run_shell` 与截断参数绕过，见 R2-P1-4、R2-P2-9 |
| O-2 S-COR 污染通用 prompt | 已修复 | prompt.js:14-16 |
| O-3 重试重复/Retry-After | 已修复 | retry.js:13-43，Retry-After 上限 30s |
| DS-CHECK-RETRY-001 429 共享冷却 | 已修复 | rateLimiter.js:105-114；探针显示第二个调用方等待冷却 |
| O-4 每请求哈希 schema | 已修复 | prepareRequest.js:8-18,97-99 |
| E-2 read_file 区间去重 | 已修复 | processController.js:666-673,763-766 |
| E-3 截断读取无 nextStartLine | 已修复（有边界） | 单行超过上限时无法续读，见 R2-P3-7 |
| E-4 数组字符串哨兵 | 已修复 | projection.js:34-45 |
| E-5 改动规模 | 部分修复 | `change-size` 存在，但忽略换行风格改写（R2-P3-12），无"能失败"的单测 |
| C-1 二次压缩丢 ref | 部分修复 | 二次压缩能继承；但 ref 取自错误区间，见 R2-P2-11 |
| C-2 压缩摘要丢失败诊断 | 已修复 | loop.js:647-651，两个摘要变体都带失败块 |
| C-4 resume 早期禁用压缩 | 无法复现 | `protectedPrefixCount` 随 contextState 保存 |
| H-1 journal 整文件重写 | 已修复 | atomic.js:125-143，同 inode、前缀不变 |
| H-2 一行损坏全部不可读 | 部分修复 | 读取跳过并计数；但水位线之后的缺口仍使 resume 失败，见 R2-P3-9 |
| H-3 resume 保留旧阶段 | 已修复 | checkpoints.js:76-78 |
| H-4 无工作区基线 | 仍缺（已缓解） | resume 无条件作废验证 |
| H-5 runId 连续性 | 无法复现 | runId/taskId 从检查点元数据恢复 |
| H-6 并发合并摘要 | 摘要已修复 | 但合并会复活已裁剪轮次，见 R2-P2-12 |
| M-1 脱敏抹掉标识符 | 已修复 | audit.js:149,153-158 |
| M-2 审计防篡改 | 部分修复 | 并发写入下哈希链可验证；崩溃窗口导致永久误报，见 R2-P3-10。删除最旧记录不被发现（无外部锚点，设计边界） |
| V-1 全部脚本轨迹 | 仍是（接受的限制） | provider benchmark 只能手动触发 |
| V-3 review 判分绑定 id | 部分修复 | id 不再必需，但格式脆弱、实质盲区，见 R2-P2-19 |
| V-4 无压缩 E2E | 部分修复 | 新任务的两个检查是空检查，见 R2-P2-18 |
| V-5 interruption-resume 平凡 | 部分修复 | 判分无法区分"真恢复"和"重新开始"，见 R2-P2-16 |
| V-6 多样性任务无断言 | 已修复 | evalDiversity.test.js:19-35 |
| 原报告 §七"write_file 需要 expectedContent 才能覆盖" | **原结论有误** | `validateWriteExpectations` 在未提供期望时直接通过（files.js:848），见 R2-P2-10 |

---

## 三、P0

### R2-P0-1 沙箱内一条 allow 命令即可让任意程序在沙箱外运行 `[主审复现]` — 已修复，见第九节

- 位置：sandbox.js:46（`writeRoots` 为整个 cwd，含 `.git/`）；shellPolicy.js:35（git 只对 `commit|merge|rebase|push` 给出 warn）。
- 缺陷：`git config core.fsmonitor <path>`（以及 `core.hooksPath`、`alias.*`、`core.sshCommand`、`core.pager`）被判为 allow，seatbelt 也允许写 `.git/config`。写入的配置会在用户之后自己运行任何 git 命令时生效，而那时没有沙箱。
- 复现：在临时仓库里通过 `createToolRuntime().execute("run_shell", { command: "git config core.fsmonitor <repo>/hook.sh" })` 执行，结果为 `{"ok":true,"prompts":0,"sandbox":{"kind":"seatbelt","enforced":true},"level":"allow"}`。`.git/config` 中出现了 `fsmonitor = …/hook.sh`。随后在沙箱外执行普通 `git status`，仓库外的 marker 文件被写入（`ran`）。
- 后果：提示注入（README、issue、测试输出）只需诱导模型执行一条无需审批的 `git config`，就能在用户终端里以完整的 home 和网络权限执行任意程序。所有沙箱与凭据隔离都因此失效。
- 修复：沙箱把 `<cwd>/.git/config`、`.git/hooks`、`.git/info`、`.gitmodules` 加入只读（seatbelt 的 `denyWriteRoots`，bwrap 的 ro-bind）；把 `git config` 的写操作和带 `hooksPath/fsmonitor/alias/sshCommand/pager` 的 `git -c` 至少判为 warn。回归测试：沙箱内 `git config core.fsmonitor x` 必须被拒或需审批。

---

## 四、P1

### R2-P1-1 `run_shell` 里的 git 会运行仓库配置的程序，且无需审批 `[主审复现：分类为 allow]` — 已修复，见第九节

- 位置：shellPolicy.js:44-67（没有针对 git 的处理）。gitPolicy.js 只加固了内置的 git 工具。
- 缺陷：`git status`、`git diff`、`git log` 都是 allow，而普通 git 会运行仓库配置的 `core.fsmonitor`、clean/smudge 过滤器、pager 和 diff 驱动。
- 场景：仓库以 tarball/zip 形式带着 `.git/config` 交付，或者先经过 R2-P0-1 被植入配置。模型第一次 `git status` 就会执行该程序。沙箱可用时它在沙箱内运行；沙箱不可用时（`auto` 模式静默降级，见 R2-P2-6）拥有完整权限。
- 修复：run_shell 中的 git 统一注入 `-c core.fsmonitor=false -c core.hooksPath=/dev/null`、过滤器中和与 `--no-ext-diff --no-textconv`（可经 `GIT_CONFIG_COUNT` 注入）；做不到时把 git 归为项目代码。

### R2-P1-2 能执行任意程序的工具被当作无害命令 `[主审复现：分类为 allow]` — 已修复，见第九节

- 位置：shellPolicy.js:266-279。
- allow 列表中的执行路径：`node --check --require ./pre.cjs p.js`（第 275 行只要看到 `--check` 就返回 false）、`awk 'BEGIN{system(...)}'`、`find … -exec node p.js \;`、`sed` 的 `e` 命令、`tar --to-command`、`git -c alias.x='!…'`、`git submodule foreach`、`git difftool -x`。
- 复现（通道）：`node --check --require ./pre.cjs p.js` 在 `prompted:false` 下执行了 marker 脚本，awk 形态同样如此。
- 修复：把这些可执行程序或参数归为项目代码（warn）。node 只有在不带 `--require/-r/--import/--loader/-e/-p` 时，`--check` 才算安全。

### R2-P1-3 `edit_file` 把替换文本中的 `$` 当作替换模式，静默写坏文件 `[主审复现]` — 已修复，见第九节

- 位置：files.js:147、171、221，`String.prototype.replace(search, replace)`。
- 复现：Makefile 中的 `echo PID` 替换为 `echo $$PPID`，返回 `ok:true`，文件实际写成 `echo $PPID`。通道还复现了 `IFS=$'\n'` 中的 `$'` 把文件其余部分拼进了中间。
- 后果：Makefile、shell 脚本、正则、模板中的 `$` 被悄悄改写，增删行统计看起来正常。这是一个返回成功、却产出错误代码的编辑工具。
- 修复：`replace(search, () => replace)`，或者用 `indexOf` 切片。补充 `$$`、`$&`、`` $` ``、`$'` 的回归测试。

### R2-P1-4 非流式响应中被截断的工具调用会循环到 `maxSteps` `[主审核码]` — 已修复，见第九节

- 位置：deepseekClient.js:10-15 与 166-182（非流式直接返回 JSON，不调用 `assertCompleteToolCalls`）；loop.js:389-398（`INVALID_TOOL_ARGUMENTS`）、687-689（这种结果不计入 no_progress）。
- 场景：`--json`/`--non-interactive` 运行和 review 都走非流式。一次很长的 `write_file` 因输出上限被截断，参数变成非法 JSON，模型重试同样的长调用，每步都消耗满 `max_tokens`。流式路径对同样的情况会给出明确错误（streamCompletion.js:17-19）。
- 复现（通道）：`{"stoppedReason":"step_budget_exceeded","modelRequests":20,"toolExecutions":0,"completionTokens":81920}`。
- 修复：非流式响应同样检查 `finish_reason:"length"` 并调用 `assertCompleteToolCalls`；连续出现的 `INVALID_TOOL_ARGUMENTS` 计入 no_progress。

### R2-P1-5 检查点随步数无界增长，长任务约在 136 步时以 `STORAGE_CAPACITY` 中止 `[主审复现]`

- 位置：compaction.js:28,78（`contextState.transcript` 永久保留每一条原始消息和每一份压缩替换）；checkpoints.js:24-31（每步写入）；taskRunner.js:258-259（`strict: true`，写失败即抛出）；store.js:129（8 MiB 上限）。
- 复现：通道探针用真实的 `runAgent`，每步读取 3 个 10 KB 文件、128K 窗口。主审重跑结果：`runAgent threw at step 136 code: STORAGE_CAPACITY … last persisted checkpoint step: 135`。第 135 步时，transcript 占 4.65 MiB，processController observations 占 2.24 MiB（后者在 resume 时本就会被丢弃）。
- 后果：长任务不是因为预算，而是因为检查点存储失败而中止。workerContexts 和 runJournal 还会让检查点更大。
- 修复：检查点只保存活跃消息、压缩证明和哈希，原始记录移到追加式侧文件；不再持久化 processController observations；容量不足时降级保存检查点而不是中止任务。

### R2-P1-6 请求超时按总时长计算，长输出被反复杀掉并重新计费 `[主审核码]`

- 位置：retry.js:24-28（每次尝试一个固定定时器）；deepseekClient.js:56-62（只有 `content` 增量会标记 `emitted`，工具调用和推理增量都不会）。
- 场景：默认超时 120s、5 次尝试、输出上限可达 32768 token。一个健康但写长工具调用的流在 120s 处被杀掉并从头重试，约 10 分钟、5 次计费生成后才失败。非流式响应只要超过 120s 就一定失败。
- 复现（通道）：每 100ms 一个 chunk、持续约 1.1s、超时设为 400ms，结果 `{"error":"Request timed out.","attempts":3,"fetches":3}`。
- 修复：改为每收到一个 chunk 就重置的空闲计时器，或按 `max_tokens` 放大超时；收到任何增量（包括工具调用和推理）后都不再重试。

---

## 五、P2 与 P3

### P2：安全与权限

| ID | 标记 | 位置 | 缺陷与场景 | 修复 |
| --- | --- | --- | --- | --- |
| R2-P2-1 | `[主审复现：分类]` **部分修复** | shellPolicy.js:5、376-453、478 | `git -c x=y reset --hard`、`r{m,} -rf build`、`$'\x72m' -rf build` 从 block 降为 allow；`find . -delete`、`git checkout -- .`、`git restore .`、`git stash drop`、`git branch -D` 都是 allow。沙箱不保护工作区本身 | 先解析 git 全局选项再匹配子命令；命令位置出现 `$'` 或未加引号的 `{a,b}` 至少判 warn；补齐这些破坏性子命令 |
| R2-P2-2 | `[主审核码]` | shell.js:27、41；settings.js:98-113 | "永久批准该命令"只以命令字符串为键，忽略 cwd：在根目录批准 `npm test` 后，`cwd: "vendor/x"` 下的 `npm test`（另一份 package.json）也会自动执行 | 审批键加入规范化后的相对 cwd |
| R2-P2-3 | `[主审核码]` | dotenv.js:7-11；env.js:7-11 | 项目 `.env` 仍可设置 `DEECOO_PROVIDER` 和 provider key，环境中的 key 优先于用户 settings 中的 key，于是所有 prompt 和工作区内容都被发往仓库作者的账号 | settings 已配置 key 时忽略项目 `.env` 的 provider 设置，或需要显式同意；至少在启动时提示 key 的来源 |
| R2-P2-4 | `[通道复现]`（透传已证；屏幕伪装为推测） | shell.js:45、119-125；select.js:39 | 审批提示直接输出命令中的 ESC/CR，命令尾部的注释可以重绘成一条看似无害的命令 | 所有审批提示转义 C0/C1 控制字符 |
| R2-P2-5 | `[主审复现：分类]` | sensitivePaths.js:14-23；sandbox.js:42、45 | `cat .e?v`、`cat ~/.a?s/credentials` 为 allow。沙箱拒绝读取 home 中的凭据目录，但不拒绝工作区的 `.env`，其中的秘密会进入发给模型的工具输出 | 能展开成敏感文件名的 glob 至少判 warn；把 `<cwd>/.env*`（样例除外）加入 `denyReadRoots` |
| R2-P2-6 | `[主审核码]` | sandbox.js:126；env.js:31 | `auto` 模式下没有沙箱（Linux 无 bwrap、Windows、嵌套 seatbelt）时静默无隔离运行，只在单条结果里标记 `enforced:false`；此时 `scp`/`rsync` 为 allow，`curl -dx`、`--json @f` 等上传只给 warn | 启动时提示沙箱未生效；非交互运行考虑默认 `required` |

### P2：编辑与循环

| ID | 标记 | 位置 | 缺陷与场景 | 修复 |
| --- | --- | --- | --- | --- |
| R2-P2-7 | `[主审核码]` | loop.js:279-285 | 越过 token/成本预算的那次响应如果是最终答复，答复会被丢弃，任务标为失败（探针：`answerRetained:false`） | 先保存消息；若没有工具调用，返回答复并标记超预算 |
| R2-P2-8 | `[主审核码]` | files.js:1062、1070 | 文件中只要有一处 CRLF，`apply_patch` 就把所有行改成 CRLF；`countLineChanges` 按 `\r?\n` 拆分，统计里看不出这些改动（探针：CRLF 行数 1 → 5） | 记录每行原本的换行符，未改动的行原样写回 |
| R2-P2-9 | `[主审核码]` **已修复** | effects.js:34-40；processController.js:102-112、170-210 | 每次执行 `run_shell`（无论成败）都会提升工作区版本并清空全部观察，于是 shell 去重和失败循环检测在真实运行时中是死代码；反复运行同一个失败的 `npm test` 会跑满 150 步（探针：`duplicatesBlocked:0`） | 为失败的命令单独维护重复账本，以"命令 + 最后一次文件改动版本"为键 |
| R2-P2-10 | `[主审核码]` | files.js:786-815、848 | `write_file` 在未提供 `expectedContent/expectedSha256` 时可以覆盖从未读过的文件（原报告 §七的正面结论有误）；模型基于被隔离过的视图（`[withheld: …]`）整文件重写时，会把占位符写进源码 | 覆盖已存在文件时要求期望值，或要求当前哈希有读缓存命中 |
| R2-P2-JSON | `[主审核码]` | files.js:956、976 | `apply_json_patch` 重新序列化整个文档：缩进和换行被改写，超过安全整数的值被改（`1234567890123456789` → `…800`） | 做保留原文跨度的修改，或遇到不安全整数时拒绝，并保留原缩进和换行 |

### P2：上下文与存储

| ID | 标记 | 位置 | 缺陷与场景 | 修复 |
| --- | --- | --- | --- | --- |
| R2-P2-11 | `[主审核码]` | loop.js:608、663-679 | 输出 ref 取自 `messages.slice(safePrefixCount)`，包含被保留的尾部，然后只保留最后 8 个。尾部自己可见的 ref 会挤掉被压缩区间里的 ref，一次压缩后大输出就再也取不回（探针：`OLDREF still reachable: false`） | 只从被压缩区间 `slice(start, end)` 收集，或改为状态级累加器 |
| R2-P2-12 | `[通道复现]` **上轮主审修复引入** | store.js:321-335、255 | `mergeSession` 把旧写者未裁剪的副本并回来：已裁剪的轮次被追加在新轮次之后，"最近上下文"变成远古轮次（探针：`u7…u19,a0…a5,u0…u3,b0`） | 合并时丢弃早于当前裁剪点的轮次，并按 `at` 排序 |
| R2-P2-13 | `[通道复现]` | loop.js:601-630、439 | 当最新一组工具结果单独就超出剩余预算时，压缩会把模型尚未看到的结果也替换掉。模型只看到摘要，再次请求时被判为 ALREADY_AVAILABLE，最后以 `no_progress` 停止 | 不压缩模型尚未消费的最后一组结果，改为溢出到 outputRef 或按剩余空间裁剪；做不到时明确报 CONTEXT_BUDGET_EXCEEDED |
| R2-P2-CMP | `[通道复现]` | loop.js:601、621 | 压缩停在第一个满足条件的候选位置，没有回落目标，接近上限后几乎每步都压缩（150 步内 147 次），既破坏 provider 前缀缓存，也加剧 R2-P1-5 | 加滞回：一次压到预算的约 60-70% |
| R2-P2-14 | `[主审复现]` | audit.js:27、145、154-157 | JSON 转义字符串里的 `DB_PASSWORD=…`、`API_TOKEN=…` 不会被脱敏（值中含 `\n` 就被字符集拒绝）；git remote URL 中的 `ghp_…` 和单独出现的 AKIA 也不会被脱敏。这些值会以明文写入检查点、审计和 journal | 先解码 JSON 字符串（如工具调用参数）再脱敏；已知令牌前缀、PEM 私钥、URL 凭据在任何位置都应匹配 |
| R2-P2-15 | `[推测]` | taskRunner.js:397、451；audit.js:51 | 成功路径上的 `saveRunAudit` 没有保护：审计体超过上限时抛出的 STORAGE_CAPACITY 会进入 catch，已完成的任务被报告为失败，recordTurn 被跳过，检查点也不清理 | 像 recordTurn 一样包住，并限制审计中 contextState 的大小 |

### P2：Eval 有效性

| ID | 标记 | 位置 | 缺陷与场景 | 修复 |
| --- | --- | --- | --- | --- |
| R2-P2-16 | `[主审核码]` | eval/execution.js:101、109 | `checkpointUsed: Boolean(checkpoint)` 只说明检查点存在。通道把 `runTask` 改成忽略 `resumeCheckpoint` 后，interruption-resume 仍然通过。另外检查也接受 `failed`，与 README 不符 | 断言恢复后的轨迹包含中断前的调用（或 runId 连续），并要求 `interrupted` |
| R2-P2-17 | `[主审核码]` | test-tampering-rejected.json；execution.js:116-120、188 | `completion` 不在预期失败列表里：harness 如果主动拦下篡改，这个用例反而失败（通道把任务改成"Do not modify test files."后三个检查都失败）。16 个任务全部推断出 `writeRestrictions: []`，eval 后端又强制 `sandboxPolicy: off`，N-1 的作用域保护在 E2E 中零覆盖 | "harness 拦截"和"判分拒绝"都算通过；增加一个在 seatbelt 后端上运行的作用域限制任务 |
| R2-P2-18 | `[主审核码]` **上轮主审新增任务的缺陷** | context-compaction-survival.json；execution.js:195-197 | ① 目标存活的检查文本 "Change only src/add.js." 同时出现在受保护前缀的 "Structured task spec" 系统消息里，因此无论如何都通过；② `source="context-compaction"` 检查与 `minCompactions` 是同一信号；③ 把日志全部换成 5 字节也会压缩，压力来自工具 schema（15,177 token）而不是日志 | 在压缩前的某一轮植入唯一标记或失败诊断，断言它出现在压缩块内；按实测基线设定窗口大小 |
| R2-P2-19 | `[通道复现]` | execution.js:207-214；两个 review 任务 | 同一个正确发现写成 `src/value.js`、`src/value.js:1-1`、`./src/value.js:1`、`quantity+price` 或严重级 P1 时判失败；错误诊断（"只是风格问题"）只要引用了那一行就判通过；只读 package.json、不读目标文件的 review 也通过 | 规范化路径和行范围，按 token 或正则匹配证据，允许一组严重级，任务中加入 `@src/value.js` 并断言目标文件被读取 |

### P3

| ID | 标记 | 位置 | 内容 |
| --- | --- | --- | --- |
| R2-P3-1 | `[推测]` | sandbox.js:15 | xcrun 缓存规则的正则没有尾锚，授予对真实用户临时目录下 `…/T/xcrun_db*` 的读写，沙箱外的 xcrun 之后会信任这些文件，存在缓存投毒的可能。应加 `$` 只匹配精确文件，或给任务单独的 `DARWIN_USER_TEMP_DIR` |
| R2-P3-2 | `[主审复现]` | writeRestrictions.js:92；taskPolicy.js:13 | `tests` 限制的 seatbelt 正则过度拒绝：`tests2`、`contest`、`testing`、`latest.js`、`specimen`、`src/attestation.js`、`src/protest.md` 被沙箱拒绝，JS 策略却允许（fail-closed 的功能缺陷，疑似 seatbelt 方言不支持 `(?:`/`[._-]` 的写法） |
| R2-P3-3 | `[通道复现]` | loop.js:421-426 | 同一步中串行工具先于 worker 调度执行，但结果按模型给出的顺序写入记录，模型会误以为测试是在 worker 修改之后运行的 |
| R2-P3-4 | `[通道复现]` | taskInterrupt.js:40；cli.js:313-314 | 交互式 REPL 中执行任务时按 Ctrl-C 会以 130 退出整个会话，只有 Esc 能回到提示符，文档没有说明 |
| R2-P3-5 | `[推测]` | anthropicClient.js:49-52 | 始终发送顶层 `cache_control` 和 `thinking:{type:"disabled"}`，通过 baseUrl 接入的兼容网关可能以不重试的 400 拒绝；请求快照记录的是 OpenAI 形态，而不是实际发送的请求体 |
| R2-P3-6 | `[主审核码]` | cost.js:27-33 | 成本估算忽略缓存价格（DeepSeek 缓存命中、Anthropic 缓存读 0.1×/写 1.25×），成本预算会偏早触发 |
| R2-P3-7 | `[通道复现]` | files.js:1132；projection.js:53-57 | 单行超过 `maxBytes` 时 `nextStartLine == startLine`，这一行的剩余部分永远读不到；投影辅助函数在首行超过 30000 字符时会跳过未读部分 |
| R2-P3-8 | `[通道复现]` | loop.js:234-238 | 每步都发出完整的请求快照：128KB 的记录跑 60 步产生 7.9MB 快照，在 `--jsonl` 下打印，开启持久事件时也会落盘 |
| R2-P3-9 | `[通道复现]` | runProjection.js:40、65-68；taskRunner.js:204-206 | journal 在检查点水位线之后出现缺口时 `foldRun` 抛出 `RUN_EVENT_SEQUENCE_GAP`，该调用不在 try 中，这个 run 之后的每次 resume 都会失败 |
| R2-P3-10 | `[通道复现]` | audit.js:51-52、68、72 | 审计记录和链头分两次写入，中间崩溃后会永久报告 `head-mismatch`/`chain-gap`，没有修复路径 |
| R2-P3-11 | `[通道复现]` | projectMemory.js:184-196、243-257 | "验证失败"记忆没有过期时间，之后的通过也不会覆盖它，会被注入到以后每个任务中 |
| R2-P3-12 | `[通道复现]` | textDiff.js:53；execution.js:226 | `change-size` 忽略换行风格和末尾换行的改写：整文件改成 CRLF 加上修复只计 2 行 |
| R2-P3-13 | `[通道复现]` | execution.js:197、337-364 | `contextIncludes` 写成字符串时会逐字符检查而通过；`minCompactions`、`findings` 都没有类型校验 |
| R2-P3-14 | `[通道复现]` | execution.js:116-120 | 预期失败的翻转把任何失败都当成拒绝，包括验证器自身崩溃（import 不存在的文件也通过） |
| R2-P3-15 | `[通道复现]` | verify-sandbox.mjs:10-13；scopedShellSandbox.test.js:28-31；harness-ci.yml | 严格沙箱门禁在测试名漂移时会以 0 个实际测试通过；作用域 shell 测试不在门禁内；CI 没有安装 bwrap，Linux 沙箱从未被测试过，而 provider-benchmark.yml 依赖 `mode: required` |
| R2-P3-16 | `[通道复现]` | execution.js:88、94-95 | E2E 不封闭：宿主设置 `DEECOO_PRIVACY_MODE=ephemeral` 时 interruption-resume 失败；PATH 上 Node 12 在前时 add-edit 失败（嵌套的 `npm test` 用的是 PATH 上的 node） |
| R2-P3-17 | `[通道复现]` | execution.js:197、200 | 检查失败时 detail 仍然写着 "…matched…"/"…retained…" |
| R2-P3-18 | `[主审核码]` | 文档与提交状态 | README.md:485、742 写的是 15 个场景（实为 16）；原报告与复核文档引用了不存在的"第十九节"；run-tests.mjs:7 的注释重复了已被推翻的"git status 看起来没有改动"的说法；已跟踪的 package.json 和 CI 依赖未跟踪文件（`scripts/`、`secureFs.*`、8 个测试文件、新 eval 任务），部分提交会让 CI 失败 |

---

## 六、测试覆盖缺口

以下断言当前不存在，每条都对应上文的真实缺陷：

| 缺口 | 对应 |
| --- | --- |
| 沙箱内写 `.git/config` 必须被拒，或 `git config` 需要审批 | R2-P0-1（已补） |
| run_shell 的 git 不运行 fsmonitor/过滤器/驱动 | R2-P1-1（已补） |
| `node --check --require`、`awk system`、`find -exec`、`git -c alias` 需要审批 | R2-P1-2（已补） |
| `edit_file`/`propose_patch` 对 `$$ $& $' $\`` 原样写入 | R2-P1-3（已补） |
| 非流式 `finish_reason:"length"` 的工具调用明确失败，而不是循环 | R2-P1-4（已补） |
| 150 步以上的长任务检查点保持有界，不中止任务 | R2-P1-5 |
| 持续输出的流不因总时长超时被重试 | R2-P1-6 |
| 审批键区分 cwd | R2-P2-2 |
| 越过预算的最终答复被保留 | R2-P2-7 |
| 混合换行风格的文件在 patch 后保持原样 | R2-P2-8 |
| 重复失败的 `npm test` 触发 no_progress | R2-P2-9（已补） |
| 被压缩区间的 ref 在压缩后仍可取回 | R2-P2-11 |
| 裁剪后的并发合并不复活旧轮次 | R2-P2-12 |
| JSON 转义的凭据被脱敏 | R2-P2-14 |
| "恢复时忽略检查点"会让 interruption-resume 失败 | R2-P2-16 |
| 压缩任务的存活标记只可能来自被压缩的轮次 | R2-P2-18 |

---

## 七、修复优先级

### 第一批（安全，建议一起做）
1. ~~R2-P0-1 与 R2-P1-1：沙箱把 `.git` 的配置/钩子设为只读，run_shell 中的 git 统一加固。~~ 已完成
2. R2-P1-2、R2-P2-1：补齐可执行程序的工具与参数、破坏性写法，git 先解析全局选项。R2-P1-2 和 git 部分已完成；剩余 `r{m,}`、`$'\x72m'`、`find -delete`
3. R2-P2-5、R2-P2-6：glob 敏感路径、工作区 `.env` 拒读、沙箱未生效时的提示。
4. R2-P2-2、R2-P2-3、R2-P2-4：审批键加入 cwd、`.env` 的 provider 设置、提示框转义。

### 第二批（数据正确性）
5. ~~R2-P1-3 `edit_file` 的 `$`（一行修复，收益最高）。~~ 已完成
6. ~~R2-P1-4、R2-P2-9：截断参数和重复失败的 shell 计入 no_progress。~~ 已完成
7. R2-P1-5、R2-P2-CMP：检查点有界化、压缩滞回。
8. R2-P2-7、R2-P2-8、R2-P2-10、R2-P2-JSON：编辑工具的原样性与覆盖保护。
9. R2-P2-11、R2-P2-12、R2-P2-13、R2-P2-14、R2-P2-15。

### 第三批（可信度）
10. R2-P1-6：空闲超时，收到任何增量后不再重试。
11. R2-P2-16 至 R2-P2-19：修正 Eval 的空检查与错误检查，增加作用域限制的 E2E 任务。
12. 第五节的 P3 和文档同步；提交前确认未跟踪文件全部纳入。

---

## 八、本次审查的局限

- Linux（bubblewrap）沙箱路径只做了代码阅读，没有在 Linux 上运行。
- R2-P2-4 的屏幕伪装、R2-P3-1 的缓存投毒、R2-P3-5 的网关兼容性、R2-P2-15 的审计容量都没有复现（R2-P3-1 会触及真实的用户临时目录，因此有意不做）。
- 没有调用真实模型。所有循环类结论都使用假 client，代表 harness 行为，不代表模型能力。
- 通道复现的条目中，主审只复核了源码路径；标为 `[通道复现]` 的条目，探针脚本保留在 `/private/tmp/claude-501/-Users-adib-Documents-Deecoo/46b1d40c-b982-4071-9f58-164a364c5ae7/scratchpad/ch1` 至 `ch4`（会话级临时目录）。
- 审查期间工作树仍有其他会话的未提交改动，结论绑定 2026-10-23 审查时的磁盘状态。

### 主审亲自执行的验证

| 项目 | 结果 |
| --- | --- |
| `npm run check` / `npm test` / `npm run eval` / `eval:trace` | 0 / 625 个测试 0 失败 / 16/16 / 4/4 |
| R2-P0-1 端到端 | 沙箱内 0 次审批写入 `core.fsmonitor`，沙箱外 `git status` 触发 marker |
| 分类器批量探针（14 条命令） | 13 条为 allow；只有 `env -S` 为 warn |
| R2-P1-3 | `echo $$PPID` 写成 `echo $PPID`，返回 `ok:true` |
| R2-P1-5 | 第 136 步 `STORAGE_CAPACITY`，最后持久化的检查点为第 135 步 |
| R2-P2-14 | JSON 转义的 `DB_PASSWORD`、remote URL 中的 `ghp_`、AKIA 均未被脱敏 |
| R2-P3-2 | 7 个普通文件名被 seatbelt 拒绝，JS 策略允许 |

*报告生成时间：2026-10-23 · 审查基线：`main@7f1eb39` 加审查时的工作树 · 审查阶段只新增本文件，未修改源码、测试或既有报告；第九节的修复修改了源码、测试与 README*

---

## 九、修复记录（2026-10-23）

按用户指示修复了 R2-P0-1、R2-P1-1、R2-P1-2、R2-P1-3，均有回归测试（`test/reviewRound2Fixes.test.js`）。

| 条目 | 修复 | 回归测试 |
| --- | --- | --- |
| R2-P0-1 | 沙箱把 `.git/config`、`config.lock`、`config.worktree`、`hooks`、`info`、`modules` 设为只读，并拒绝写 `.git` 目录项本身（防止"改名—修改—改回"）。seatbelt 实测：`git config`、写钩子、`mv .git` 都被拒；提交、建分支、`git status` 和普通写入正常。代价：沙箱内不能 `git init` 或修改仓库配置。bwrap 只能只读挂载已存在的路径（未在 Linux 上实测） | 策略单测；真实 seatbelt 测试已加入 `npm run test:sandbox` 严格门禁 |
| R2-P1-1 | 分类器先解析 git 全局选项：只有只读子命令和查看形式为 allow；其余子命令、带程序键的 `-c`、`--git-dir/--work-tree/--exec-path`、`GIT_*`/`PAGER` 覆盖需要审批；`git -c … reset --hard`、`git -C … clean -f` 恢复为 block。运行前检查目标仓库（含 `-C` 和 `bash -c` 中的 git）配置里的过滤器、textconv、外部 diff、签名程序与 include，有则改为需要审批。所有 job 的环境注入 `core.fsmonitor=false` 和 `GIT_PAGER=cat` | 分类单测；运行时测试：过滤器仓库需要审批，关闭沙箱时 fsmonitor 也不会运行 |
| R2-P1-2 | `find -exec/-execdir/-ok` 的载荷递归分类；`awk` 的 `system()`/管道/`-f`、`sed` 的 `e` 命令/`s///e`/`-f`、`tar --to-command`/`-I` 等、`zip -TT`、`man -P`、`rsync -e`、`scp -S`、`docker`/`podman` 的 `run`、`exec`、`build`、`parallel`、`crontab`、`launchctl`、`open` 等至少为 warn；`node --check` 带 `--require/--import/--loader/-e/-p` 时视为执行代码；`busybox` 作为包装命令展开 | 正反两组分类单测 |
| R2-P2-1（部分） | 由 R2-P1-1 的 git 解析一并关闭：`git -c x=y reset --hard`、`git -C a clean -f` 恢复为 block，`git checkout -- .`、`git restore .`、`git stash drop`、`git branch -D` 需要审批。仍未处理：`r{m,} -rf`、`$'\x72m' -rf`、`find . -delete` 仍为 allow | R2-P1-1 的分类单测 |
| R2-P1-3 | `edit_file`（预览与写入）和 `propose_patch` 改为按字面替换 | `$$`、`$'`、`` $` ``、`$&`、`$1` 五种写法逐一校验文件内容和补丁 |

以上改动都在本地工作树中，尚未提交或推送。

验证（2026-10-26 在当前工作树上重跑）：`npm run check` exit 0；`npm test` 631 个测试，630 通过，1 跳过（OS sandbox 可用时按设计跳过），0 失败；`npm run test:sandbox` 3/3；`npm run eval` 16/16；`npm run eval:trace` 4/4。第五节其余条目尚未修复。

### 9.2 步数上限与不收敛停机（2026-10-26）

| 条目 | 修复 | 回归测试 |
| --- | --- | --- |
| 步数上限（新） | 步数预算从本次运行开始计算：此前恢复会沿用绝对步数，任务在上限处停下后，`/continue` 会 0 次调用就再次停止（已用探针复现）。交互式终端中到达上限时询问是否再继续同样步数；非交互和非 TTY 运行仍然硬性停止。停止提示改为说明可以 `/continue` | `test/stepBudgetProgress.test.js` STEPS-001、STEPS-002 |
| R2-P1-4 | DeepSeek/OpenAI 兼容和 Anthropic 的非流式响应与流式一样，在执行工具前拒绝被截断的工具调用（Anthropic 以 `max_tokens` 停止原因判定）；参数无法使用的调用计为不收敛 | STEPS-004、STEPS-006 |
| R2-P2-9 | 不收敛判定改为结果账本：同一调用（含 cwd）在没有文件改动的情况下得到与上次相同的结果即视为重复，shell 以退出状态为结果。反复运行同一个失败命令，或与未改动文件的重读交替，都会在 4 步后以 `no_progress` 停止；每次改文件之后的重跑仍算进展 | STEPS-003、STEPS-005 |

