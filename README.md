# Deecoo

Deecoo 是一个本地 coding-agent harness，面向代码分析、修改、审查和验证任务。它将模型调用、工作区工具、权限控制、Shell 防护、自动验证、上下文压缩、Memory、Worker 调度和审计 Trace 组合成完整的编程任务闭环。

本文档是 Deecoo 的完整使用指南与配置参考。

## 核心能力

- 支持 DeepSeek、OpenAI 和 Anthropic，并按 provider 管理 key、模型和 API 地址。
- 提供交互会话和一次性任务两种工作方式。
- 支持文件读取、搜索、结构化补丁、Git 状态和受控 Shell 执行。
- 自动识别项目验证命令，在修改后运行测试、lint、typecheck、check 或 build。
- 记录 AgentState、checkpoint、验证状态、结构化输出和脱敏审计 Trace。
- 通过 session、project、long-term 三层 Memory 控制长任务上下文。
- 对复杂任务按 research、implement、verify 和独立风险审查拆分 Worker。

## 目录

- [核心能力](#核心能力)
- [运行要求与安装](#运行要求与安装)
- [快速开始](#快速开始)
- [模型平台配置](#模型平台配置)
- [配置文件结构](#配置文件结构)
- [配置来源与优先级](#配置来源与优先级)
- [环境变量参考](#环境变量参考)
- [命令行使用](#命令行使用)
- [交互会话](#交互会话)
- [文件和 Shell 权限](#文件和-shell-权限)
- [验证流程](#验证流程)
- [任务状态、上下文与 Memory](#任务状态上下文与-memory)
- [Worker 与多 Agent](#worker-与多-agent)
- [审计、输出与 Eval](#审计输出与-eval)
- [项目规则与上下文文件](#项目规则与上下文文件)
- [安全说明](#安全说明)
- [常见问题](#常见问题)
- [开发与验证](#开发与验证)
- [项目架构](#项目架构)
- [当前能力边界](#当前能力边界)

## 运行要求与安装

要求：

- Node.js 20 或更高版本
- npm
- DeepSeek、OpenAI 或 Anthropic 至少一个平台的 API key
- 需要读取或修改的本地项目目录

在 Deecoo 源码目录安装依赖并建立全局命令：

```bash
npm install
npm link
deecoo --help
```

不建立全局链接时，可以直接运行：

```bash
node ./bin/deecoo.js --help
```

## 快速开始

### 1. 配置模型平台

任选一个平台：

```bash
deecoo config -provider deepseek -key sk-...
deecoo config -provider openai -key sk-...
deecoo config -provider anthropic -key sk-ant-...
```

命令会把该平台设为当前平台。未配置 API key 时直接运行 `deecoo`，程序会以退出码 `1` 结束，并显示对应的配置命令。

### 2. 在项目目录启动

```bash
cd /path/to/project
deecoo
```

在交互提示符中输入任务，例如：

```text
修复登录重定向问题并运行相关测试
```

### 3. 直接运行单次任务

```bash
deecoo "审查当前项目的安全问题"
deecoo "修复失败的测试并验证"
deecoo --cwd /path/to/project "检查构建错误"
```

## 模型平台配置

### 支持的平台

| Provider | 默认 API 地址 | 默认模型 | API key 环境变量 | 协议 |
| --- | --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` | OpenAI-compatible Chat Completions |
| `openai` | `https://api.openai.com/v1` | `gpt-5.1` | `OPENAI_API_KEY` | OpenAI Chat Completions |
| `anthropic` | `https://api.anthropic.com` | `claude-sonnet-5` | `ANTHROPIC_API_KEY` | Anthropic Messages API |

DeepSeek 和 OpenAI 客户端支持普通响应、流式响应、模型列表和工具调用。Anthropic 客户端负责在内部消息格式与 Messages API 之间转换 system message、tool use、tool result、流式文本和流式工具参数。

### 配置 API key

标准格式：

```bash
deecoo config -provider <deepseek|openai|anthropic> -key <api-key>
```

同时设置模型：

```bash
deecoo config -provider openai -key sk-... --model gpt-5.1
deecoo config -provider anthropic -key sk-ant-... --model claude-sonnet-5
```

如果模型名称能够明确归属其他平台，命令会拒绝不一致的组合。例如 `-provider openai --model claude-sonnet-5` 会报错。

`-provider`、`-key` 也接受双横线形式：

```bash
deecoo config --provider deepseek --key sk-...
```

### 使用环境变量

临时使用环境变量而不写入 key：

```bash
export OPENAI_API_KEY="sk-..."
export DEECOO_PROVIDER="openai"
deecoo
```

将当前环境中的受支持变量写入设置：

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export DEECOO_MODEL="claude-sonnet-5"
deecoo config import-env
```

只导入一个平台 key 时，该平台会自动成为 `activeProvider`。同时导入多个 key 时，可以通过 `DEECOO_PROVIDER` 或可识别的 `DEECOO_MODEL` 指定当前平台。

### 使用项目 `.env`

Deecoo 会按顺序尝试读取：

1. 启动时的当前目录 `.env`
2. `--cwd` 指定目录的 `.env`
3. 没有 `--cwd` 时，`DEECOO_CWD` 指定目录的 `.env`

示例：

```dotenv
OPENAI_API_KEY=sk-...
DEECOO_PROVIDER=openai
DEECOO_MODEL=gpt-5.1
```

`.env` 只读取 provider key 和 `DEECOO_*` 变量，不会覆盖已经存在于进程环境或已加载设置中的同名变量。不要把包含真实 key 的 `.env` 提交到版本库。

### 使用间接 secret 引用

配置值支持 `env:` 和 `file:` 引用，启动时才解析实际 secret：

```bash
deecoo config -provider openai -key env:MY_OPENAI_KEY
deecoo config -provider anthropic -key file:/secure/path/anthropic-key
```

第一种方式要求启动 Deecoo 时存在 `MY_OPENAI_KEY`；第二种方式读取指定文件并去除首尾空白。引用无法解析时，请求会因缺少可用凭据而失败。

### 查看和初始化配置

```bash
deecoo config path
deecoo config init
deecoo config show
```

- `path`：显示实际设置文件路径。
- `init`：创建默认设置并导入当前环境中受支持的变量。
- `show`：显示当前平台、各平台模型、运行参数和权限；API key 会显示为 `********`。

## 配置文件结构

默认路径：

```text
~/.deecoo/settings.json
```

可以通过 `--settings` 或 `DEECOO_SETTINGS_PATH` 使用其他文件。传入目录时，Deecoo 使用该目录下的 `settings.json`。

schema v2 示例：

```json
{
  "schemaVersion": 2,
  "activeProvider": "deepseek",
  "providers": {
    "deepseek": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-v4-pro"
    },
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-5.1"
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "model": "claude-sonnet-5"
    }
  },
  "env": {
    "DEECOO_MAX_TOKENS": 4096,
    "DEECOO_TIMEOUT_MS": 120000,
    "DEECOO_API_RETRIES": 5,
    "DEECOO_PERMISSION_MODE": "ask-once",
    "DEECOO_THEME": "tokyo-night"
  },
  "permissions": {
    "shell": {
      "approvedCommands": [],
      "autoApproveAll": false
    }
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 当前设置结构版本，当前为 `2`。 |
| `activeProvider` | 没有被环境变量或模型覆盖时使用的平台。 |
| `providers.<name>.apiKey` | 平台 key，也可以是 `env:` 或 `file:` 引用。 |
| `providers.<name>.baseUrl` | 平台 API 根地址，不要以 `/` 结尾。 |
| `providers.<name>.model` | 该平台默认模型。 |
| `env` | 与平台无关的运行参数。 |
| `permissions.shell.approvedCommands` | 已永久批准的精确 Shell 命令。 |
| `permissions.shell.autoApproveAll` | 是否永久跳过所有 warn 级 Shell 授权。 |

设置文件写入后权限会调整为 `0600`。旧版 `env.DEEPSEEK_API_KEY`、`env.DEECOO_BASE_URL`、`env.DEECOO_MODEL` 仍可读取，并在下一次设置写入时迁移到 schema v2。

## 配置来源与优先级

平台选择逻辑：

```text
DEECOO_PROVIDER
> --model 可推断的平台
> DEECOO_MODEL 可推断的平台
> settings.activeProvider
> deepseek
```

选定平台后：

```text
API key: 平台环境变量 > settings.providers.<provider>.apiKey
模型:    --model > DEECOO_MODEL > provider 设置 > provider 默认值
地址:    DEECOO_BASE_URL > provider 设置 > provider 默认值
```

常规环境变量的加载关系是：已有 Shell 环境不会被 `.env` 覆盖；settings 中的运行参数先于 `.env` 生效。`--cwd`、`--model` 和 `--settings` 属于明确的命令行覆盖。主题通过 `/theme` 写入 settings 后，会作为后续启动主题。

可识别的模型前缀：

- `deepseek-*` -> DeepSeek
- `gpt-*`、`o1-*`、`o3-*`、`o4-*`、`o5-*`、`chatgpt-*`、`codex-*` -> OpenAI
- `claude-*` -> Anthropic

无法识别归属的自定义模型使用显式 `DEECOO_PROVIDER` 或当前 `activeProvider`。

## 环境变量参考

### Provider 与模型

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无 | DeepSeek API key，优先于设置文件。 |
| `OPENAI_API_KEY` | 无 | OpenAI API key，优先于设置文件。 |
| `ANTHROPIC_API_KEY` | 无 | Anthropic API key，优先于设置文件。 |
| `DEECOO_PROVIDER` | `activeProvider` 或 `deepseek` | 强制选择 `deepseek`、`openai` 或 `anthropic`。 |
| `DEECOO_MODEL` | provider 默认模型 | 本次运行使用的模型。 |
| `DEECOO_BASE_URL` | provider 默认地址 | 本次运行覆盖 API 根地址。 |
| `DEECOO_MAX_TOKENS` | `4096` | 单次模型响应 token 上限。非法或非正数回退到默认值。 |
| `DEECOO_REASONING_EFFORT` | 无 | DeepSeek/OpenAI 请求的 reasoning effort；值必须被目标模型支持。 |
| `DEECOO_THINKING` | 无 | DeepSeek 兼容请求的高级 thinking 配置；OpenAI 会移除该字段，Anthropic 适配器当前显式使用 disabled。 |
| `DEECOO_STREAM` | `true` | `0`、`false`、`no`、`off` 关闭流式输出。Review 任务会强制使用非流式响应以校验结构。 |

### 网络与重试

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEECOO_TIMEOUT_MS` | `120000` | 单次 provider 请求超时。 |
| `DEECOO_API_RETRIES` | `5` | provider 请求最大尝试次数，客户端内部最多限制为 5 次。 |
| `DEECOO_EGRESS_ALLOWLIST` | 无 | 逗号分隔的允许访问主机；设置后阻止访问列表外主机。 |

### Agent 预算

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEECOO_MAX_STEPS` | `150` | 主 Agent 循环最大步骤数。 |
| `DEECOO_TOKEN_BUDGET` | 关闭 | 整个任务累计 token 预算。 |
| `DEECOO_COST_BUDGET_USD` | 关闭 | 估算费用预算，单位 USD。 |
| `DEECOO_PRICE_PROMPT_PER_M` | 模型价格表或无 | 输入 token 自定义价格，USD/百万 token。 |
| `DEECOO_PRICE_COMPLETION_PER_M` | 模型价格表或无 | 输出 token 自定义价格，USD/百万 token。 |
| `DEECOO_TASK_TIMEOUT_MS` | 关闭 | 整个任务墙钟时间预算。 |
| `DEECOO_WORKER_TIMEOUT_MS` | 关闭 | 单个 Worker 的墙钟时间预算。 |

达到预算后任务会明确结束，并记录 `step_budget_exceeded`、`token_budget_exceeded`、`cost_budget_exceeded` 或 `task_deadline_exceeded`，不会无限等待。

### 路径、权限与界面

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEECOO_CWD` | 当前目录 | 默认工作区。`--cwd` 优先。 |
| `DEECOO_HOME` | `~/.deecoo` | 会话、Memory、审计和默认设置的存储根目录。 |
| `DEECOO_SETTINGS_PATH` | `~/.deecoo/settings.json` | 设置文件或设置目录。`--settings` 优先。 |
| `DEECOO_PERMISSION_MODE` | `ask-once` | 文件编辑权限模式。 |
| `DEECOO_THEME` | `tokyo-night` | 启动主题。 |

## 命令行使用

### 基本语法

```text
deecoo [options]
deecoo [options] <task>
deecoo <top-level-command>
deecoo config <config-command>
```

### 通用选项

| 选项 | 说明 |
| --- | --- |
| `--cwd <path>` | 指定工作区。 |
| `--settings <path>` | 指定设置文件或目录。 |
| `--model <model>` | 本次运行覆盖模型；可识别模型也会影响平台选择。 |
| `--yes`、`-y` | 自动批准需要确认的 Shell 命令，不批准文件写入。 |
| `--yes-files` | 允许脚本任务在工作区写文件。别名为 `--auto-approve-files`。 |
| `--help`、`-h` | 显示帮助。 |

### 常用任务示例

```bash
# 分析，不要求修改
deecoo "解释认证模块的工作流程"

# 修复并验证
deecoo "修复当前失败的测试，运行测试并总结改动"

# 指定项目和模型
deecoo --cwd /path/to/repo --model claude-sonnet-5 "审查最近的修改"

# 用于自动化的显式写权限
deecoo --yes --yes-files "完成任务并运行验证"
```

### 顶层命令

| 命令 | 说明 |
| --- | --- |
| `deecoo model` | 从当前 provider 获取模型列表并持久化选择。 |
| `deecoo resume` | 选择当前项目的历史会话；TTY 中随后进入该会话。 |
| `deecoo delete` | 选择并永久删除当前项目会话。 |
| `deecoo export` | 把所选会话导出为项目目录中的 Markdown 文件。 |
| `deecoo eval` | 使用最匹配的 eval case 评估最近一次审计。 |
| `deecoo permissions` | 选择本进程的文件编辑权限。 |
| `deecoo skills` | 从本地 Codex skill 目录加载一个 skill。 |
| `deecoo trace` | 查看最近审计、工具调用、文件和验证状态。 |
| `deecoo theme` | 选择并持久化终端主题。 |
| `deecoo usage` | 查询 DeepSeek balance；OpenAI/Anthropic 不支持兼容的 balance endpoint。 |

## 交互会话

不提供任务时进入交互会话：

```bash
deecoo
```

提示符第一行显示模型、项目和 Git 分支。输入 `/` 打开命令建议；方向键选择，Tab 补全，Enter 执行。空输入时使用上下方向键浏览输入历史。

| Slash 命令 | 说明 |
| --- | --- |
| `/new` | 创建新会话。 |
| `/resume` | 切换到当前项目的历史会话。 |
| `/fork` | 从当前会话某个 assistant answer 创建新会话。 |
| `/delete` | 删除会话。 |
| `/export` | 导出会话 Markdown。 |
| `/model` | 选择当前 provider 的模型。 |
| `/permissions` | 修改本进程文件权限模式。 |
| `/skills` | 为当前会话加载一个 Codex skill。 |
| `/trace` | 查看当前会话最近 Trace。 |
| `/eval` | 评估当前会话最近运行。 |
| `/theme` | 修改并持久化主题。 |
| `/usage` | 查询 provider balance 支持情况。 |
| `/help` | 显示命令。 |
| `/exit` | 退出。也接受 `exit`、`quit`、`q!`。 |

可选主题：

```text
tokyo-night
gruvbox
catppuccin
starship
neon-edge
mono-focus
```

任务执行期间只显示当前实际进入的阶段，不会在开始时打印整份通用 Plan。模型请求期间显示 Thinking 状态；工具开始、成功或失败会分别更新活动行。

## 文件和 Shell 权限

### 文件编辑权限

| 模式 | 行为 |
| --- | --- |
| `read-only` | 拒绝文件写入。 |
| `ask-every-edit` | 每次编辑前确认。 |
| `ask-once` | 每个任务第一次编辑确认，之后该任务内继续允许。默认值。 |
| `workspace-write` | 允许写入工作区内文件。 |

设置方式：

```bash
export DEECOO_PERMISSION_MODE=workspace-write
deecoo config import-env
```

也可以使用 `/permissions`。`--yes` 只影响 Shell；要自动批准文件写入必须显式使用 `--yes-files` 或 `workspace-write`。

### Shell 执行限制

`run_shell` 的默认约束：

- 默认超时 30 秒；工具调用可以为单个命令指定 `timeoutMs`。
- stdout 和 stderr 分别最多返回约 20KB，超出部分会标记截断。
- 交互式命令、交互 REPL、`watch`、`tail -f` 等会被阻止。
- 子进程环境会移除 secret、token、password 以及 provider 专用变量。
- 失败结果会提取包含 error、assert、文件行号和栈信息的高信号日志。

Shell 策略分为：

| 级别 | 行为 |
| --- | --- |
| `allow` | 直接执行，不提示。 |
| `warn` | 请求用户批准；例如安装依赖、网络访问、重定向、后台命令、解释器 one-liner。 |
| `block` | 始终拒绝；例如 `sudo`、`git reset --hard`、递归强制删除、下载后直接执行、敏感凭据读取或数据上传。 |

warn 级授权选项包括本次批准、拒绝、永久批准该精确命令、永久批准所有 warn 命令。永久授权写入 `settings.json`。清除所有 Shell 永久授权：

```bash
deecoo config reset-shell-approvals
```

即使启用 `--yes` 或 `autoApproveAll`，block 级命令仍然会被拒绝。

## 验证流程

Deecoo 不把“代码已写入”视为任务完成。对于 edit、debug、command 或明确要求测试的任务，会生成验证计划并在修改后执行适合项目的命令。

Node.js 项目会读取 `package.json` scripts，并按以下顺序识别：

1. `check`
2. `typecheck`
3. `lint`
4. `test`
5. `build`

同时通过 lockfile 识别 npm、pnpm、yarn 或 bun。例如：

```text
package.json scripts.test + pnpm-lock.yaml -> pnpm test
package.json scripts.lint + package-lock.json -> npm run lint
```

典型闭环：

```text
1. 运行已有验证命令
2. 读取失败摘要
3. 搜索失败函数或测试
4. 读取相关文件
5. 应用结构化补丁
6. 重新运行验证
7. 查看 git diff
8. 输出改动、验证结果和剩余风险
```

验证状态会区分未运行、失败、通过和 `failed-then-passed`。如果项目没有可识别命令，Agent 应读取项目文档或脚本后再决定验证方式，不能声称已验证。

## 任务状态、上下文与 Memory

### Agent 状态

每次运行维护结构化状态，包括：

- 原始任务和工作目录
- 当前 workflow phase
- 每一步模型响应、工具调用、结果、耗时和错误
- 已读取文件、已编辑文件、执行命令和观察结果
- token 使用、上下文压缩记录和进程重复检测统计
- 验证计划与验证状态

这些数据用于 Trace、恢复、上下文压缩、输出报告和 Eval。

### 上下文压缩

Deecoo 不会把完整历史无限追加到每个模型请求。会话上下文主要由以下内容组成：

1. 系统与项目规则
2. 项目索引和受限 workspace snapshot
3. 历史会话摘要
4. 最近 6 个会话 turn
5. 当前任务和当前工作集

较旧 turn 会压缩进最多约 6000 字符的本地摘要；单个近期 turn 进入上下文时也会限制长度。长任务运行期间还会压缩工具输出和历史步骤，同时保留关键文件工作集、失败原因和下一步。

### 三层 Memory

| 类型 | 范围 | 主要内容 | 存储位置 |
| --- | --- | --- | --- |
| Session memory | 单会话 | 摘要、近期 turns、artifacts、checkpoint | `~/.deecoo/sessions/<project-hash>/` |
| Project memory | 单项目 | facts、decisions、prior failures | 项目 session 目录的 `memory.json` |
| Long-term memory | 跨项目 | user preferences、facts、decisions | `~/.deecoo/long-term-memory.json` |

每类 Project/Long-term memory 最多保留 80 项并去重。Memory 条目记录 scope、kind、来源、置信度和可选过期时间。

### Checkpoint 与恢复

Agent 运行会写入版本化 checkpoint，包含消息历史、步骤和使用量。任务成功完成后 checkpoint 会清理；中断后可以由恢复流程继续。`/resume` 用于选择项目会话，不代表把所有原始历史重新发送给模型。

## Worker 与多 Agent

复杂任务可以由主 Agent 调度 Worker：

- `research`：只读研究和定位。
- `verify`：可读取并运行验证命令，不可写文件。
- `implement`：可在授权范围内编辑文件并验证。

主 Agent 使用 `agent` 创建有独立上下文的 Worker，使用 `send_message` 继续已有 Worker，使用 `task_stop` 停止不再需要的 Worker。彼此独立的只读或审查任务可以并行；可能发生重叠写入的实现任务保持串行。每个任务有 Worker 数量限制，Worker 也受共享 rate limiter、token、步骤和超时预算约束。

Review 类任务可以按正确性、安全、边界情况、架构、性能和测试等风险域拆分独立审查，再由主 Agent 汇总。普通简单任务不会强制创建多 Agent。

## 审计、输出与 Eval

### 本地文件位置

默认根目录为 `~/.deecoo`，可用 `DEECOO_HOME` 覆盖：

```text
~/.deecoo/
├── settings.json
├── long-term-memory.json
└── sessions/<project-hash>/
    ├── <session-id>.json
    ├── <session-id>.checkpoint.json
    ├── memory.json
    ├── audit/<session-id>/*.json
    └── outputs/<session-id>/*
```

每次运行可生成：

- 脱敏后的 audit JSON
- 结构化 run result JSON
- verification JSON
- review report JSON（Review 任务）
- Markdown 运行摘要

Audit 中的长文本最多保留约 40000 字符，并对 API key、Authorization、token、secret 和 password 字段进行脱敏。仍应把整个 `~/.deecoo` 视为本地敏感数据，不要公开上传。

### Trace

```bash
deecoo trace
```

或在会话中运行 `/trace`。输出包括任务类型、workflow、验证状态、Memory 摘要、文件读写、命令、最近工具调用、观察结果和可执行的 Eval 建议。

### Eval

```bash
npm run eval
npm run eval -- --case small-bugfix
npm run eval -- --case small-bugfix --run /path/to/audit.json
npm run eval -- --run /path/to/audit.json --suggest
npm run eval -- --run /path/to/audit.json --auto-case
deecoo eval
```

Eval case 位于 `eval/cases`，fixture 位于 `eval/fixtures`，报告写入 `eval/reports`。评分覆盖完成度、请求分类、必要/禁止工具、验证行为、最终输出和意外工具失败。

## 项目规则与上下文文件

Deecoo 按以下优先级读取项目规则：

```text
.deecoo.md > AGENTS.md > CLAUDE.md > README.md
```

建议在项目根目录创建 `.deecoo.md`：

```markdown
# Project Instructions

- Package manager: pnpm
- Run `pnpm lint` and `pnpm test` after edits
- Do not modify generated files
- Keep patches focused
```

启动时 Deecoo 还会维护：

```text
.deecoo/PROJECT.md
```

其中生成区域包含项目名、package scripts、目录和 Git 摘要。生成标记外可以保存人工说明；生成区域会刷新。通常应把 `.deecoo/` 加入项目的忽略规则。

Workspace snapshot 有明确边界：索引深度和文件数受限，并跳过 `.git`、`node_modules`、`dist`、`build`、`coverage`、`.next` 等重目录。

## 安全说明

- 设置文件可能包含明文 key，Deecoo 会将其权限设置为 `0600`。
- 推荐使用环境变量或 `file:` 引用降低明文 secret 出现在设置文件中的概率。
- API key 会从工具子进程环境中移除，并加入运行时 secret registry。
- 文件、Shell、Git diff 和 Worker 输出会作为不可信数据处理，检测到 prompt injection 时会隔离原文并只传递惰性投影。
- `.env`、`.git`、凭据目录和常见私钥路径受路径与 Shell 策略保护。
- egress allowlist 是附加限制，不是完整网络沙箱。
- `workspace-write` 和永久批准 Shell 命令会降低交互保护，应只在可信项目中使用。
- `config -key` 会让 key 暂时出现在当前进程命令行参数中；高敏感场景优先使用环境变量或 secret 文件引用。

## 常见问题

### 启动后提示没有 API key

```text
No API key configured for provider "openai".
Run: deecoo config -provider openai -key sk-...
```

执行提示中的命令，或设置对应环境变量。然后运行：

```bash
deecoo config show
```

确认 `activeProvider` 正确且对应 provider 的 `apiKey` 显示为 `********`。

### 配置了 key 但读取了错误平台

检查：

```bash
echo "$DEECOO_PROVIDER"
echo "$DEECOO_MODEL"
deecoo config show
```

`DEECOO_PROVIDER` 优先级最高。清除错误环境变量，或重新配置当前平台：

```bash
unset DEECOO_PROVIDER DEECOO_MODEL DEECOO_BASE_URL
deecoo config -provider anthropic -key file:/secure/path/key
```

### 模型和 provider 不匹配

配置时使用同一平台模型，或只配置 key 后通过 `/model` 获取平台返回的模型列表：

```bash
deecoo config -provider openai -key sk-...
deecoo model
```

### `/usage` 在 OpenAI 或 Anthropic 下失败

这是预期行为。当前 `/usage` 使用 DeepSeek 的 `/user/balance` 兼容端点；OpenAI 和 Anthropic 客户端不会伪造余额结果。

### Shell 命令超时或输出不完整

Shell 默认 30 秒，stdout/stderr 最多约 20KB。Agent 可以为合理的非交互命令增加 `timeoutMs`，但交互命令和 block 级危险命令不能通过提高超时绕过。

### 修改完成但验证失败

运行 `/trace` 或：

```bash
deecoo trace
```

查看最近验证命令、失败摘要和 edited files。要求 Agent 修复后重新运行同一验证命令，不要仅根据代码阅读判断成功。

### 任务长时间显示 Thinking

可能处于 provider 首 token 延迟、重试、Worker 执行或非流式 Review 请求。使用 `DEECOO_TIMEOUT_MS` 和 `DEECOO_TASK_TIMEOUT_MS` 设置明确上限；完成后通过 `/trace` 查看模型步骤、工具调用时长和错误。

### 重置本地开发数据

先确认当前根目录：

```bash
deecoo config path
echo "$DEECOO_HOME"
```

设置和会话是不同数据。`deecoo config reset-shell-approvals` 只清除 Shell 授权，不会删除 API key、会话、Memory 或审计。

## 开发与验证

在 Deecoo 源码目录中：

```bash
npm run check
npm test
npm run eval
```

- `npm run check` 对 CLI、源码、测试和 Eval JavaScript 执行语法检查。
- `npm test` 运行 Node.js test runner 下的完整测试套件。
- `npm run eval` 使用 fixture 对 harness 行为评分，不需要真实 provider 请求。

项目规则位于 `.deecoo.md`：代码修改后运行 `npm run check`，行为变化还需运行 `npm test`。`eval/reports` 是生成输出，除非明确要求，不应手工修改。

### 确定性回放

`createReplayClient` 和 `createReplayTools` 可以重放已记录的模型响应和工具结果，用于 golden transcript 回归测试。回放模式不访问 provider，也不执行真实文件或 Shell 副作用。

并发的进程内任务可以使用 `withIsolatedEnv` 和 `withIsolatedCwd` 隔离并恢复全局 `process.env` 与 cwd；共享 rate limiter 控制主 Agent 和 Worker 的 provider 并发。

## 项目架构

```text
bin/                  CLI 入口
src/agent/            Agent loop、prompt、任务协调和 Worker runtime
src/cli/              参数解析、终端交互和活动显示
src/commands/         顶层命令、Slash 命令和配置命令
src/config/           provider、settings、环境变量和 secret 解析
src/context/          项目索引、workspace snapshot 和上下文预算
src/harness/          task spec、workflow 和 AgentState contract
src/llm/              provider client、流式协议、限流和回放
src/memory/           project 与 long-term memory
src/observability/    审计 Trace 和脱敏
src/permissions/      文件权限、Shell policy 和网络出口约束
src/reporter/         review report 与结构化运行输出
src/session/          会话、checkpoint 和 artifact
src/tools/            文件、搜索、补丁、Git、Shell 和 Worker 工具
src/verification/     验证计划与验证状态
test/                 单元与集成测试
eval/                 Eval case、fixture、评分器和报告
```

`src/tools/runtime.js` 负责工具分发、任务级权限状态和 Worker 工具过滤。具体执行器位于 `src/tools/files.js`、`src/tools/search.js`、`src/tools/shell.js` 和 `src/tools/git.js`。工具 schema 与 Worker profile 位于 `src/tools/definitions.js`，路径边界与敏感路径检查位于 `src/tools/pathPolicy.js`。

## 当前能力边界

- Worker 在同一 Node.js 进程中运行，并非独立后台服务。
- OpenAI 当前通过 Chat Completions 协议调用，没有切换到 Responses API。
- `/usage` 只支持 DeepSeek 的兼容 balance endpoint。
- 终端 Markdown 支持标题、列表、链接、行内代码、代码块、diff 和对齐表格，但不是完整浏览器 Markdown/HTML 渲染器。
- provider 价格会变化；启用费用预算前应通过 `DEECOO_PRICE_PROMPT_PER_M` 和 `DEECOO_PRICE_COMPLETION_PER_M` 确认估算参数。
- 本地权限和 egress policy 是 coding-agent 防护层，不等同于操作系统级容器或网络沙箱。
