# ExecutionBackend 实现与验收记录

目标：NEXT-001、NEXT-003、NEXT-005。工作树基线为 `50e809d8a286662d42e8d462b2c9772d9f2dd30d` 加现有未提交修改；本文件不把单个平台的验收推广到其他平台，也不把进程组称为不可逃逸进程容器。

## 接口与已经实现的行为

入口为 `src/execution/backend.js` 的 `createExecutionBackend({cwd,stateDir,env,ownerId,sandboxPolicy,termGraceMs,killGraceMs})`，返回：

- `run({command,cwd?,env?,replaceEnv?,timeoutMs?,signal?,maxOutputBytes?})`：默认 30 秒，保留 `ok/stdout/stderr/*Truncated`，附加 `jobId/status/exitCode/signal/timedOut/treeCleanup/sandbox/cwd`。非零退出、超时、取消和清理未确认分别表达；保留真实退出码及信号。
- `startJob(...)`：默认不设时限，启动独立 detached supervisor，快速返回 job 快照。调用端退出不会结束 supervisor；另一个 backend 可用同一 cwd、stateDir、ownerId 重连。不是 PTY，不支持 stdin 或交互式 shell。
- `getJob(jobId)`：验证 ID、schema、workspace/owner；心跳过期区分 orphaned/unresponsive，不把无法确认的进程报告为已停止。损坏状态返回 `JOB_STATE_CORRUPT`，不推断 PID、不重播命令。
- `readOutput(jobId,{stream,offset,maxBytes})`：stdout/stderr 独立磁盘日志，按字节偏移读取，每次最多 1MiB，返回 nextOffset、totalBytes、text、base64；base64 可无损拼接跨 UTF-8 边界的块。5MiB 输出回归通过，没有 exec maxBuffer。
- `stopJob(jobId)`：重连端只写带私有 nonce 的请求，原 supervisor 验证 nonce 后负责 TERM → 宽限期 → KILL → 受管进程组退出确认。不会根据磁盘记录直接 kill 一个 PID；PID 创建身份不同会拒绝。身份查询受宿主限制时仍可走原 supervisor 的 nonce 握手。
- `dispose({stopRunning,removeState})`：只处理该 backend 实例创建的 IDs。仅在终态且清理确认后删除该 job 目录；无法确认时返回 `JOB_DISPOSE_INCOMPLETE` 并保留记录，不删除同目录中其他实例的 jobs。
- `capabilities()`：明确平台、沙箱实际探测结果、PGID 边界、脱组约束与资源粒度。

`runShell` 保留原 permission/approval/always 接口；`background:true` 经同一审批后启动作业。cwd 在提示前及审批后检查目录、敏感/排除路径、realpath 和工作区边界，审批显示实际目录。真实 runtime 回归证明 `cwd:packages/api` 会产生 `scope:packages/api`，可满足相同作用域的 required check。`permissionState.executionEnv` 以 `replaceEnv:true` 替换注入 backend 的旧环境，避免删除变量仍留在捕获环境中。并发 cwd/env 和跨任务旧 env 回归通过。

stdout/stderr 直接通过打开的文件描述符持续写盘；job/config/stop 的原子写复用统一 `storage/atomic.js`（私有文件、fsync、rename、目录 fsync）。config 中只保留清洗后的环境，退出后删除 config；标准日志和命令仍是原始持久记录，应服从调用方的数据保留/隐私策略。默认 stateDir 在私有临时目录的 workspace 哈希下，避免工作区 chmod/rm 破坏 supervisor 通道；需要跨系统临时目录清理持久化时须传受信任的长期 stateDir。正式会话和隐私模式目录由 root 集成提供。临时目录持久不代表机器重启后作业仍运行。

## 真正 OS 边界

`sandboxPolicy.mode` 为 off/auto/required。auto 在实际启动探测成功时启用；不可用时明确 `enforced:false` 及 reason；required 返回 `SANDBOX_UNAVAILABLE`，不降级执行。

- macOS：实际使用 `/usr/bin/sandbox-exec` Seatbelt profile。默认 deny；只读系统/当前 Node 安装/项目/显式 readRoots，写入仅 writeRoots 和独立 job 临时目录；状态目录及常见凭据路径显式 deny；HOME/TMP/XDG 指向 job 临时目录。默认 deny 网络，进程后代继承 profile。Mach 服务限于目录/用户查询，进程信息及 signal 限同一沙箱，sysctl 不允许读取其他进程的环境。支持的必要 OS 读权限不等于完整个人目录读取。
- Linux：实现 bubblewrap 后端、实际 user/network namespace 启动探测、空 mount namespace 的显式只读/可写 bind、凭据及状态遮罩、只读根、独立 PID namespace、die-with-parent 和 merged-/usr 别名。当前宿主是 Darwin，未运行 Linux 后端；须在有 bubblewrap 和 user namespace 的 Linux CI 执行同一个 OS fixture，不能据此标记 Linux 已验收。
- network 只支持 deny/allow。主机 allowlist 需要受控代理；没有把应用层 URL allowlist 称作 OS 主机级过滤。
- hard ulimit：cpuSeconds 和 openFiles 为每进程限制，fileSizeBytes 为每文件限制；Bash 文件块按 1024 字节向下取整。Linux maxProcesses 为每用户 RLIMIT_NPROC，不是每作业进程数。无聚合 CPU/内存/cgroup 配额；未知资源配置会拒绝，不假装生效。

## 验证

- `node --test test/executionBackend.test.js`：18 项，17 pass、1 OS 项因外层沙箱禁止嵌套 Seatbelt 而 skip；包含普通后代、忽略 TERM 的子孙、timeout、abort、停止后 marker 不再变化、重连、5MiB 日志、并发环境、nonce、owner/schema、资源限制、scope 和 dispose。
- `node --test test/executionBackend.test.js test/prompter.test.js` 最终定向一轮：28 项 27 pass、1 OS skip。原 `chmod 640 .` 审批回归已修复并通过。
- 通过受管审批，在外层沙箱之外运行 `node --test --test-name-pattern='OS sandbox blocks' test/executionBackend.test.js`：1/1 pass。它只使用合成临时文件及临时 localhost 服务；实际 Seatbelt 阻止脚本读取/覆盖外部 secret、阻止后代读取、阻止连接宿主 localhost 服务，同时允许项目写及合成 `npm test --silent`。所有自建进程和服务均清理。
- `npm run check` 已通过。一次集成中的 `npm test` 352 项出现 4 项失败：本模块 fileSize 单位问题及 prompter 状态目录问题已经修复；另外两项为 root 正在集成的新 schema 预期。最终全量 green 由 root 在稳定工作树重跑，本文件不以旧全量结果代替最终验收。

## 明确未完成及平台限制

macOS 取消管理的是新建 POSIX 进程组。普通和忽略 TERM 后代已验证；主动 setsid/另建进程组的恶意后代没有不可逃逸容器保证，`detachedEscapeContainment:false`。supervisor 被 SIGKILL、机器崩溃或不可达状态存储时不能重新安全接管未知 PID；会报告清理未确认。Windows 没有 OS 沙箱或作业对象实现。Linux 运行验收、聚合资源配额、受控域名代理、PTY/stdin，以及跨重启作业恢复均不应称作已经完成。

## 固定公开实现参考

仅借鉴下列架构理念，未运行外部仓库代码，未引入依赖，也没有整段移植源实现。

- Codex，commit `a3b685331fc700bec554b2fe2a929a65f4fe1548`，Apache-2.0：[unified_exec/mod.rs](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/core/src/unified_exec/mod.rs)、[process_manager.rs](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/core/src/unified_exec/process_manager.rs)。采用审批/沙箱与进程生命周期分层、稳定进程标识、输出与等待分离、终止确认理念。本项目额外使用独立磁盘 supervisor 以跨调用端生命周期；未采用 PTY、write_stdin 或内存 LRU session 管理。
- 同版本 Codex：[sandboxing/seatbelt.rs](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/sandboxing/src/seatbelt.rs)、[seatbelt_base_policy.sbpl](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)、[seatbelt_read_only_platform_defaults.sbpl](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/sandboxing/src/seatbelt_read_only_platform_defaults.sbpl)、[bwrap.rs](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/sandboxing/src/bwrap.rs)。采用 closed-by-default、子进程继承、same-sandbox 信号、显式系统读取及 user namespace 实际能力探测理念；本项目 required 模式不采用无沙箱重试，不把其他项目庞大平台策略直接复制为已验证兼容性。
- pi（原 badlogic/pi-mono 当前 earendil-works/pi），commit `bd3c9b823762b7383954aa49e13ee350471015fe`，MIT：[tools/bash.ts](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/tools/bash.ts)。采用 BashOperations 的 command/cwd/env/signal/输出契约、detached 启动、真实 exitCode/signal 及取消清理职责；未复制 UI renderer、extension 或超时默认策略。本项目将流式回调改为直接磁盘日志，并补持久 supervisor/nonce/确认退出。

## 额外独立复核交接

按 root 要求只读复核验收/Eval/benchmark，已向对应 owner 发送：EXECREVIEW-001（真实 provider benchmark 不应硬编码 sandbox off）、EXECREVIEW-002（同一预算 ledger 的多个 wrapper 必须共享在途串行/预留）、EXECREVIEW-003（scope 必须可经真实 cwd 工具路径产生）。001/002 已由验收 owner 修复并报告定向测试通过；003 已与 root 配合加 cwd、并在本文件 18 项中用真实 runtime 验证。付费 provider 未调用。详细最终集成证据由各 owner/root 的记录给出。

EXECREVIEW-004：CLI 外部 SIGTERM 未转成 task AbortSignal（`src/cli.js` 的 `installTaskInterrupt`，新增 detached supervisor 后暴露；severity=P1、issue_evidence=confirmed、lane=errors）。用 fake fetch provider 启动真实同步 run_shell，每 20ms 向合成 marker 追加；CLI 收到 SIGTERM 且已经 exit 后 160ms，marker 从 2 字节增长到 10 字节，证明同步命令仍在写。通过同一 backend 的 stopJob 清理确认 stopped，随后删除全部合成目录，无真实 API 调用。可靠修复是在 CLI 把 SIGINT/SIGTERM 转成 controller.abort，并等 runTask 的确认清理完成再退出，同时保持显式 start_job 持久语义；solution_fit: suited=yes, executable=yes, affordable=yes, cost=low；verification: CLI SIGTERM/忽略 TERM 子孙/停止后 marker 稳定、机器输出仍为合法 JSON；post_cor_candidate=yes。root 已在 owned CLI 接入 SIGINT/SIGTERM 与退出码143，此处仍只记录缺陷复现及源码确认；修复后的集成回归证据由 root 给出。
