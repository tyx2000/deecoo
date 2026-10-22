# 本地 CLI / DeepSeek 连通性缺陷修复

基线：`d8a49ab4a4eb06a38ffba29922425fac43857543`。用户授权修复本地实测发现的两项问题，完成回归、独立审查、本地安装和 iTerm DeepSeek 复测，通过后提交推送。保留既有改动，不修改 `eval/reports`。

## CONTEXT-CLI-001：初始请求预算漏算固定开销

- issue_evidence：confirmed。基线在本仓库执行只读连通性任务、不覆盖窗口时，以 `CONTEXT_BUDGET_EXCEEDED` 退出且 provider 调用为零；32,768 回退窗口可用输入预算 30,592，初始完整请求保守估算 38,931。临时显式设置窗口后，真实 API 返回 `DEECOO_DEEPSEEK_OK`，实际输入 10,199 tokens。
- decision：adjusted。保留未知模型的保守窗口及 UTF-8 字节估算；修正完整请求的预算分配，而非只提高窗口或削弱检查。DeepSeek 官方声明的 1M 上下文曾作为诊断时的显式运行参数，不作为自定义路由可无条件继承的模型元数据。[官方说明](https://deepseek.com/en/news/v4-preview/)
- solution_fit：suited=yes，executable=yes，affordable=yes，cost=medium。系统提示、实际工具定义、原始任务及强制指令必须保留，可选快照、索引、历史等使用剩余预算；checkpoint 来源和保护前缀保持兼容。
- outcome：implemented。`initialContext.js` 共享系统提示/信任封装的构造；`builder.js` 为固定请求开销预留预算并公开分项指标；`taskRunner.js` 保留强制项目规则，裁剪可选内容；worker 只在首次实际请求时按自身提示和工具选择上下文。恢复任务先验证 checkpoint，再由 loop 检查实际保存的消息，保持原 transcript、contextId、消息 IDs 和保护前缀。
- solution_reliability：high；patch_scope：medium。6 项上下文回归覆盖 32K 首次调用、强制规则/skill 溢出拒绝、worker 连续两轮，以及磁盘规则/skill 增长后的真实 checkpoint 恢复。最终上下文相关定向 **58/58**；统一回归与实际模型结果见下文。

## CLI-EXIT-002：TTY 单次任务完成后输入流仍保持活动

- issue_evidence：confirmed。基线 iTerm 单次任务已打印成功响应，仍占用终端超过一分钟，需 Ctrl-C 才返回 shell。`createPrompter` 本身是惰性闭包；实际问题来自任务中断监听启用 keypress 后，结束时未恢复输入流状态。
- decision：accepted。按任务作用域恢复原输入流状态，不使用 `process.exit()` 强退；保留交互任务和批准提示的输入能力。
- solution_fit：suited=yes，executable=yes，affordable=yes，cost=low。完成、失败、取消均须释放本任务取得的终端输入资源。
- outcome：implemented。`installTaskInterrupt` 在取得输入前记录 `readableFlowing`，显式 `resume()` 确保已暂停且复用 decoder 的输入仍可接收 Esc，结束时撤销监听、恢复 raw 模式，并仅释放本任务取得的活动输入资源。
- solution_reliability：high；patch_scope：small。新增 7 项实际 CLI 子进程回归，保持 stdin 打开，仅替代 TTY 检测和 raw-mode 调用，不依赖 Python：成功、provider 失败、超时、Esc、暂停后 decoder 复用、文件批准、连续两轮交互再退出。相关定向 **32/32**；真实 iTerm PTY 验证两种模型均自然返回 shell。

## 独立自检与修补

- `SMOKE-REV-001`：fixed-verified。初版完整预算会对恢复时不会使用的新指令做检查，可能错误阻断有效 checkpoint。现只对恢复时的实际消息预算，新增两项恢复回归验证原消息和 IDs。
- `SMOKE-REV-002`：fixed-verified。复用 readline decoder 时仅添加监听不会自动恢复已暂停输入，导致 Esc 失效。现显式 `resume()`，新增 paused-decoder 取消回归。
- 新预算数字指标起初被通用 token-key 规则过滤。现只将 `estimatedContextTokens`、`reservedInputTokens`、`availableContextTokens` 的有限数值加入精确白名单；字符串和 Infinity 仍过滤，既有诊断回归已扩展验证。独立复核未发现秘密过滤放宽或剩余阻塞问题。
- 批准回归第一次得到的 mock 最终文本缺少文件交付说明，被真实验收器正确拒绝。只补齐 mock 对实际文件改动及未运行测试原因的说明；未放宽验收器、退出码或文件内容断言。

## 验收记录

状态：**IMPLEMENTED_AND_VERIFIED**。Node v24.22.1；最终 166 文件 SHA-256：`7c1cb225974992f6a313ea62cfd208167e033ee9c6c5020c8783807b991b313e`。范围为 `package.json`、`bin/deecoo.js`、`src`/`test`/`eval` 的 JS，排除 `eval/reports`，按相对路径排序，路径和内容以 NUL 分隔。不含本文档。

- 基线隔离副本：`/private/tmp/deecoo-cli-before-20261022.t5DhQC`，从原 HEAD 导出。新上下文回归在旧代码 **4 失败/2 通过**，修复后 6/6；TTY 回归旧代码 **6 失败/1 通过**，完成/失败/超时/批准等场景复现 stdin 挂起，另覆盖暂停 decoder 的取消缺陷，修复后 7/7。批准 mock 调整后另在旧代码重跑该单项，仍复现退出超时。日志：`deecoo-cli-context-before-20261022.log`、`deecoo-cli-tty-before-20261022.log`、`deecoo-cli-tty-approval-before-20261022.log`，均在 `/private/tmp`。
- `node --test test/initialContextBudget.test.js test/contextStorageGovernance.test.js test/compactionContracts.test.js test/requestRouteIntegration.test.js test/deepseekIntegration.test.js`：58/58；日志 `/private/tmp/deecoo-cli-context-after-20261022.log`。
- `node --test test/cliTtyLifecycle.test.js test/cliExitContracts.test.js test/cliSignalCleanup.test.js test/approvalCancellation.test.js test/prompter.test.js`：32/32；日志 `/private/tmp/deecoo-cli-tty-after-20261022.log`。
- 最终 `npm run check`：exit0；日志 `/private/tmp/deecoo-cli-fixes-check-20261022.log`。
- 最终 `npm test`：**524 项、523 通过、0 失败、1 条件跳过**，exit0；日志 `/private/tmp/deecoo-cli-fixes-tests-20261022.log`。此次允许实际 OS 验证，真实 macOS 文件/网络隔离测试通过；跳过的是“OS 后端不可用时 fail closed”场景，因为本机后端可用，不是外层沙箱限制。
- 最终 `npm run eval -- --no-report --fail-on-failed --json`：Trace **4/4**；`npm run eval:e2e -- --no-report --json`：E2E **15/15**；日志 `/private/tmp/deecoo-cli-fixes-trace-20261022.json`、`/private/tmp/deecoo-cli-fixes-e2e-20261022.log`。未修改 `eval/reports`。
- 重新本地安装：`npm link --offline --ignore-scripts --no-audit --no-fund`，exit0；全局命令指向当前仓库源码。

真实连通性测试均使用本仓库、现有凭据、只读模式、ephemeral 存储、最多 128 输出 token 和 45 秒任务期限，**不传 `--context-window`，也不更改保存的模型配置**。新非交互诊断显示实际回退窗口 32,768、完整请求估算 22,990，低于可用 30,592，并明确丢弃 1 项可选内容；没有工具调用或项目文件修改。

- 当前配置的 `deepseek-flash` 非交互：`completed`，返回 `DEECOO_DEEPSEEK_OK`，5,420 输入 + 9 输出 = **5,429 tokens**；日志 `/private/tmp/deecoo-cli-fixed-deepseek-smoke-20261022.json`。
- iTerm `deepseek-flash` 流式：同样成功，**914ms / 5,427 tokens**；AppleScript `is at shell prompt` 为 true，直接返回 shell；日志 `/private/tmp/deecoo-iterm-fixed-flash-output-20261022.txt`。
- iTerm 对上一轮使用的 `deepseek-v4-pro` 做本次命令级型号覆盖：同样成功，**2.1s / 5,530 tokens**，自然返回 shell；日志 `/private/tmp/deecoo-iterm-fixed-pro-output-20261022.txt`。

三次真实调用合计 16,386 tokens；日志不包含凭据值。当前 Flash 配置保持不变。所有验收完成后按用户授权提交推送，具体提交身份以 Git 记录为准。
