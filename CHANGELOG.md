# 更新记录

## 0.1.8 — 2026-10-26

- 发给模型的结构化任务说明恢复为目标在前的字段顺序（`schemaVersion`、`goal`、`cwd`、`requestType`），`acceptance` 和 `requiredChecks` 放在最后；字段值不变。
- 终端中断回归测试只有在确实无法打开 PTY 时才跳过。

## 0.1.7 — 2026-10-26

- `deecoo --version` 在版本号后显示该版本的发布时间（本地时间，年月日时分秒），JSON 输出新增 `releasedAt`。发布时间写在 `package.json`，`npm version` 递增版本时自动写入。
- 合并代码审查各轮修复：Shell 分类与 git 加固、沙箱保护 `.git` 配置与钩子、项目 `.env` 不能改安全设置、`edit_file` 按字面替换、步数预算按每次运行计算并在交互模式询问、无进展自动停止、存储脱敏与审计哈希链、Eval 默认端到端执行等。详见 `claude-code-review.md`。
- CI 安装 ripgrep 并关闭 fail-fast；沙箱可读取标准 Node 安装目录（修复 macOS CI）。

## 0.1.1 — 2026-10-22

- 初始上下文按完整请求预留预算，保留强制指令，并覆盖子代理和 checkpoint 恢复。
- 修复 TTY 单次任务结束后未退出，以及暂停输入流后 Esc 无法取消的问题。
- 新增 `deecoo --version` / `-v`、结构化版本输出和启动栏版本标识。源码安装显示安装目录的 Git 提交号和未提交修改状态；无 Git 信息时显示包版本。

版本号以 `package.json` 为准，并同步锁文件。`npm link` 安装随源码更新；运行中的交互会话需重启以加载新代码。
