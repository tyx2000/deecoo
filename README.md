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
- [机器接口与本地管理](#机器接口与本地管理)
- [本轮八项完善](#本轮八项完善)
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
- 模型任务需要 DeepSeek、OpenAI 或 Anthropic 至少一个平台的 API key；本地管理命令无需 key
- 需要读取或修改的本地项目目录

在 Deecoo 源码目录安装依赖并建立全局命令：

```bash
npm install
npm link
deecoo --version
deecoo --help
```

不建立全局链接时，可以直接运行：

```bash
node ./bin/deecoo.js --help
```

用 `deecoo --version`（或 `-v`）查看安装版本；`deecoo --json --version` 提供结构化版本信息，无需配置 API key。源码安装还会显示安装目录的 Git 提交号，未提交修改显示 `dirty`；独立包没有 Git 信息时只显示包版本。启动栏也显示同一版本标识。

`npm link` 指向本地源码，新启动的命令会使用当前代码；已运行的交互会话需要退出后重新打开才能加载更新。发布修复时递增补丁版本（本次 `0.1.1`），新增兼容功能递增次版本，并同步 `package.json` 与锁文件。版本改动见 [更新记录](CHANGELOG.md)。

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
      "approvals": [],
      "autoApprovals": [],
      "legacy": { "approvedCommands": [], "autoApproveAll": false }
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
| `permissions.shell.approvals` | 版本化的精确命令授权，默认绑定规范化项目路径。 |
| `permissions.shell.autoApprovals` | 版本化的 warn 级自动批准范围，默认仅当前项目。 |
| `permissions.shell.legacy` | 旧版未限定范围的记录，只保留供迁移查看，不再生效。 |

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
| `DEECOO_TOKEN_BUDGET` | 关闭 | 整个任务累计 token 预算，包含主 Agent 和所有 Worker。 |
| `DEECOO_WORKER_TOKEN_BUDGET` | 关闭 | 每次 Worker 执行的局部 token 上限，仍受任务总预算约束。 |
| `DEECOO_COST_BUDGET_USD` | 关闭 | 估算费用预算，单位 USD。 |
| `DEECOO_PRICE_PROMPT_PER_M` | 模型价格表或无 | 输入 token 自定义价格，USD/百万 token。 |
| `DEECOO_PRICE_COMPLETION_PER_M` | 模型价格表或无 | 输出 token 自定义价格，USD/百万 token。 |
| `DEECOO_TASK_TIMEOUT_MS` | 关闭 | 整个任务墙钟时间预算。 |
| `DEECOO_WORKER_TIMEOUT_MS` | 关闭 | 单个 Worker 的墙钟时间预算。 |

达到预算后任务会明确结束，并记录 `step_budget_exceeded`、`token_budget_exceeded`、`cost_budget_exceeded` 或 `task_deadline_exceeded`。任务超时会传递给全部 Worker，阻止后续模型请求和工具调用。

启用任务 token 或费用预算时，父子模型请求共享实际用量账本并串行执行，最多允许当前已发出的单次请求超额；未启用总预算时保留并发。费用限制依赖 provider 返回的 usage 和已知单价，不等同于服务端扣费上限。

### 路径、权限与界面

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEECOO_CWD` | 当前目录 | 默认工作区。`--cwd` 优先。 |
| `DEECOO_HOME` | `~/.deecoo` | 会话、Memory、审计和默认设置的存储根目录。 |
| `DEECOO_SETTINGS_PATH` | `~/.deecoo/settings.json` | 设置文件或设置目录。`--settings` 优先。 |
| `DEECOO_PERMISSION_MODE` | `ask-once` | 文件编辑权限模式。 |
| `DEECOO_THEME` | `tokyo-night` | 启动主题。 |
| `DEECOO_CONTEXT_WINDOW` | provider 能力或 128000 | 上下文 token 窗口；超出不可压缩必需项时明确失败。 |
| `DEECOO_OUTPUT_RESERVE` | `DEECOO_MAX_TOKENS` | 为输出预留的 token 数，允许 0。 |
| `DEECOO_SANDBOX` | `auto` | Shell OS 后端：off、auto、required。 |
| `DEECOO_SANDBOX_NETWORK` | `deny` | 沙箱网络 deny 或 allow；不提供域名级过滤。 |
| `DEECOO_PRIVACY_MODE` | `standard` | standard、redacted、ephemeral。 |
| `DEECOO_RETENTION_DAYS` | `90` | 项目存储保留天数，允许 0。 |
| `DEECOO_STORAGE_MAX_BYTES` | `134217728` | 项目持久存储容量上限。 |
| `DEECOO_DURABLE_TOOL_EVENTS` | `false` | 保存版本化工具前后事件日志。 |

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
| `--task-mode <mode>` | 显式选择 edit/debug/review/analysis/command/read-only；用户明确的只读约束仍优先。 |
| `--yes`、`-y` | 自动批准需要确认的 Shell 命令，不批准文件写入。 |
| `--yes-files` | 允许脚本任务在工作区写文件。别名为 `--auto-approve-files`。 |
| `--json` / `--jsonl` | 安静的结构化结果；JSONL 还输出运行事件，隐含非交互模式。 |
| `--non-interactive` | 禁止等待用户输入；默认输出 JSON，未授权的确认请求直接拒绝。 |
| `--sandbox off\|auto\|required` | 选择 OS 执行边界，`--sandbox-network deny\|allow` 选择网络策略。 |
| `--acceptance <file>` | 读取显式 JSON 验收合同。 |
| `--context-window N` / `--output-reserve N` | 覆盖上下文窗口及输出预留。 |
| `--privacy standard\|redacted\|ephemeral` | 选择历史与日志持久化策略。 |
| `--retention-days N` / `--storage-max-bytes N` | 覆盖项目保留期限与容量；`--durable-tool-events` 保存工具事件。 |
| `--` | 后续参数按原样作为任务或本地命令位置参数处理。 |
| `--help`、`-h` | 显示帮助。 |
| `--version`、`-v` | 显示安装版本及可用的源码提交号；支持 JSON 输出，无需 API key。 |

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

单次任务成功退出码为 `0`，失败或预算耗尽为 `1`，任务超时为 `124`，主动中断或 SIGINT 为 `130`，SIGTERM 清理完成后为 `143`。交互会话中的单次任务失败会显示错误，随后仍可继续输入。流式响应提前结束时返回 `INCOMPLETE_RESPONSE`，已输出内容保留，任务不会被标记为成功。

### 顶层命令

| 命令 | 说明 |
| --- | --- |
| `deecoo model` | 从当前 provider 获取模型列表并持久化选择。 |
| `deecoo resume` | 选择当前项目的历史会话；TTY 中随后进入该会话。 |
| `deecoo continue` | 从本项目最近的 checkpoint 继续中断任务。 |
| `deecoo delete` | 选择并永久删除当前项目会话。 |
| `deecoo export` | 把所选会话导出为项目目录中的 Markdown 文件。 |
| `deecoo eval` | 使用最匹配的 eval case 评估最近一次审计。 |
| `deecoo permissions` | 选择本进程的文件编辑权限。 |
| `deecoo skills` | 从本地 Codex skill 目录加载一个 skill。 |
| `deecoo trace` | 查看最近审计、工具调用、文件和验证状态。 |
| `deecoo theme` | 选择并持久化终端主题。 |
| `deecoo usage` | 查询 DeepSeek balance；OpenAI/Anthropic 不支持兼容的 balance endpoint。 |

## 机器接口与本地管理

```bash
deecoo --json --non-interactive --yes-files "修复 src/add.js 并运行 npm test"
deecoo --jsonl --sandbox required --sandbox-network deny "分析当前实现"
deecoo --json -- "解释文档中的 --help 参数"
deecoo --json continue --session SESSION_ID
```

机器模式不显示启动横幅、ANSI 活动行或交互菜单。单次任务输出一个带 `schemaVersion: 1`、`type: result` 的 JSON；JSONL 在它之前输出带 run/task ID、事件 ID、序号的 `type: event` 记录。启动和参数错误输出 `type: error`；退出码与普通单次任务相同。输出包含实际验收、验证和变更摘要，并使用运行时 secret registry 脱敏。`--yes` 与 `--yes-files` 仍分别控制 Shell 和文件授权。非交互恢复必须指定 session；需要选择菜单的旧命令保留在交互模式。

以下命令只访问当前项目的本地状态，不需要 provider key，也不发模型请求：

```bash
deecoo --json jobs capabilities
deecoo --json jobs status JOB_ID
deecoo --json jobs output JOB_ID --stream stdout --offset 0 --max-bytes 20480
deecoo --json jobs stop JOB_ID

deecoo --json memory list --scope all --include-expired
deecoo --json memory edit MEMORY_ID --scope project --text "修正后的项目事实" --expires-at none
deecoo --json memory delete MEMORY_ID --scope project
deecoo --json memory prune --scope all

deecoo --json storage status
deecoo --json storage prune --dry-run
deecoo --json storage prune

deecoo --json changes list
deecoo --json changes show CHANGE_ID --path src/add.js
deecoo --json changes accept CHANGE_ID --path src/add.js --hunk HUNK_ID
deecoo --json changes undo CHANGE_ID --path src/add.js
deecoo --json changes export CHANGE_ID --output ./task.patch
```

本地管理结果使用 `kind: management-result`，包含 command、action、ok 和 result。`storage status`、Memory list 和 changes show 不触发自动存储清理；prune 是显式清理，支持 dry-run。Memory 的 all 范围用于 list/prune，edit/delete 必须选择 project 或 global。任务变更按实际 dirty 基线计算，undo 保留用户原有内容，遇到重叠漂移返回冲突。导出文件以独占创建方式写入，已有文件不会被覆盖。

显式验收文件可以直接包含 acceptance 字段，或使用以下包装形式：

```json
{
  "acceptance": {
    "allowedCompletionTypes": ["modified", "no-change", "partial", "blocked"],
    "targetPaths": ["src/add.js"],
    "requirements": []
  },
  "requiredChecks": [
    {"id": "unit", "target": "project tests", "scope": ".", "required": true,
      "executionPaths": [{"command": "npm test"}, {"command": "npm run test"}]},
    {"id": "syntax", "command": "npm run check"}
  ]
}
```

通过 `--acceptance ./acceptance.json` 使用。必需检查逐项对应实际执行效果；单跑 check 不能满足 test。条件修复的 no-change 需要完整源码检查，以及真实检查结果或非空 file-content 断言。失败不能用最终文字覆盖；未完成项分别报告 partial 或 blocked。

## 本轮八项完善

1. **取消与超时**：Shell 使用受管进程组；停止后等待 TERM/KILL 清理确认，无法确认时明确报告。持久 PID 不直接作为重新连接后的发信号依据。
2. **任务验收**：结构化目标、范围、必需检查和等价路径，绑定真实工具效果及验证版本，区分 modified、no-change、partial、blocked。
3. **长作业**：`run_shell` 可后台启动，返回 job ID；支持 status、按字节读取磁盘日志和 stop。普通命令仍默认 30 秒，单次返回约 20KB，完整输出可继续读取。
4. **变更交付**：任务开始采样工作区实际基线，输出整体 diff，支持按文件或 hunk 接受、撤销和导出 patch。冲突显式返回，普通二进制文件支持无漂移时整体恢复；hunk 和 patch 仅适用于文本，符号链接变更单独报告。
5. **系统边界**：macOS Seatbelt、Linux bubblewrap 后端提供文件和网络限制；required 不可用时拒绝执行，auto 在返回能力信息中明确降级。off、允许网络和附加可写根需要显式配置。
6. **Eval 与 CI**：15 个离线真实执行场景覆盖跨文件、多语言、review/no-change、权限、失败、作弊和恢复；push/PR 跑确定性检查，真实 provider 基准必须单独显式触发并提供费用预算。
7. **上下文与导航**：按模型窗口预留输出并分层分配 token 预算，支持范围读取、文件版本、词法符号与引用导航。范围读取不能假装完整源码，词法导航不等于编译器/LSP 语义分析。
8. **存储治理**：原子写入、并发锁、版本迁移、损坏备份恢复、任务所有权及可选工具事件；Memory 可查看/编辑/删除/过期清理，项目存储可查看和按期限/容量清理。

standard 保留正常历史；redacted 对持久历史脱敏，并把包含源码基线的变更集仅留内存；ephemeral 不持久保存会话、审计、Memory、artifact 或源码基线。这两种模式的任务内 job 日志使用临时目录，在任务退出后清理；运行期间日志仍会暂存在本机磁盘。内存中的源码基线不能在进程退出后重连恢复，不能将此模式解释为“没有任何临时磁盘写入”。

旧版 provider 设置、环境变量、普通交互用法和会话读取继续兼容。新增配置可通过环境变量或 CLI 使用；旧 schema 会在受支持的存储入口迁移，损坏记录保留可诊断副本。OS 后端和工具权限是分开的约束：启用 workspace-write 或自动批准不会绕过 required 沙箱；沙箱也不保证任意依赖、编译器或网络服务在限制下都能运行。

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
| `/continue` | 使用当前会话 checkpoint 继续中断任务。 |
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
| `read-only` | 拒绝文件写入与任意 Shell 命令；安全 Git/文件检查仍可用。 |
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

warn 级授权选项包括本次批准、拒绝、永久批准该精确命令、永久批准本项目所有 warn 命令。永久授权写入 `settings.json`，匹配规范化项目路径、完整命令（保留引号内空白）和策略版本。旧未限定范围的授权进入 `legacy`，需要在目标项目重新批准；显式全局范围只可通过配置 API 的 `scope: "global"` 设置，CLI 默认创建项目授权。清除所有新旧 Shell 永久授权：

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

较旧 turn 会压缩进最多 6000 字符的本地滚动摘要，持续纳入新内容。摘要为明确标记的用户约束保留最多 1800 字符（如“必须”“不要”“Constraint:”）；该提取仅按语法规则识别，约束区满后淘汰最旧项，完整 history 不删除。单个近期 turn 进入上下文时也会限制长度。长任务运行期间还会压缩工具输出和历史步骤，同时保留关键文件工作集、失败原因和下一步。

### 三层 Memory

| 类型 | 范围 | 主要内容 | 存储位置 |
| --- | --- | --- | --- |
| Session memory | 单会话 | 摘要、近期 turns、artifacts、checkpoint | `~/.deecoo/sessions/<project-hash>/` |
| Project memory | 单项目 | facts、decisions、prior failures | 项目 session 目录的 `memory.json` |
| Long-term memory | 跨项目 | user preferences、facts、decisions | `~/.deecoo/long-term-memory.json` |

每类 Project/Long-term memory 最多保留 80 项并去重。Memory 条目记录 scope、kind、来源、置信度和可选过期时间。

### Checkpoint 与恢复

Agent 运行会按队列原子写入版本化 checkpoint，包含 run ID、消息、步骤、使用量、可信执行效果和验证状态。任务成功后先等待写入结束再清理。`/continue` 或 `deecoo continue` 继续中断任务，校验项目真实路径、模型和权限，保留累计预算；若预算已耗尽，需要先提高对应上限。恢复会使旧验证和可复用观察失效，要求检查当前文件；结果未知的工具调用会标记为中断，不自动重放。`/resume` 只切换会话。

模型路由身份还包含 provider、协议、endpoint 摘要和当前任务可见工具 schema。切换 endpoint 或工具合同后明确拒绝恢复；只改本地渲染函数或增加被任务策略隐藏的工具不影响身份。缺少路由身份的旧 checkpoint 不能在 CLI 中继续，需要开始新任务。

### 可追溯压缩与请求诊断

上下文压缩保存稳定消息 ID、来源 hash、策略版本、替换内容和压缩前后估计。提交前再次校验来源及完整工具调用组，只有确实缩小时才替换模型消息；原始模型 transcript 保存在 `contextState`，Worker 各轮来源保存在 `workerContexts`。摘要以不可信 user 数据进入模型，保持初始系统/任务约束。它们随检查点、运行结果和审计保存，受既有容量、保留期和隐私策略约束，容量失败明确报告。

每次 dispatch 有过滤后的 messages/tools/生效配置快照、hash 和 attempt 状态；失败或重试不制造成功消息。`runJournal` 保存事件去重索引、计数和水位，`foldRun` 可重建诊断投影。检查点等待对应事件落定，恢复会接续磁盘中较新的日志尾部，不重复计费或重放工具。原始 transcript 由 `contextState` 管理，事件投影不替代它。

完整持久日志沿用 `durableToolEvents` 显式配置；关闭时仍有有界内存诊断，不宣称有完整磁盘历史。redacted 持久日志/报告省略逐次请求快照正文，ephemeral 不写磁盘日志；过滤后的来源标明不能精确重建秘密原文。诊断包含 `journalComplete`、`requestSnapshotsComplete`、`historyMissing`、丢弃计数及错误；追踪 ring 默认最多 2000 项和 2MiB。旧检查点若只有无法验证来源的内部 system 摘要，会明确要求开始新任务，保留工作区和旧文件。详见 [压缩说明](docs/deepseek-compaction-notes-2026-10-22.md) 和 [事件说明](docs/deepseek-journal-notes-2026-10-22.md)。

### 工具输出与大结果

嵌入式调用 `createToolRuntime().registerTool()` 可声明 `outputSchema`、`toModelContent(args, value)` 和 `presentationMeta(args, value)`。执行结果是不可变 JSON 快照；模型投影和 UI 元数据独立，渲染失败会明确报告，已经发生的副作用仍由执行事实记录。未提供渲染器的扩展保留任意 JSON 字段，不需要修改中央字段白名单。输出 schema 支持的子集和限制见 [输出契约说明](docs/deepseek-output-contract-notes-2026-10-22.md)。

超过模型输出预算时，保存完整的过滤后 JSON 投影，并返回头尾预览、`outputRef`、字节数、摘要和读取提示。`read_output` 支持字节游标或行范围，`search_output` 使用字面量搜索；引用绑定当前 session/run，不能传文件路径。按行分页也应按 `nextOffset` 继续到 `rangeEndOffset`，避免跳过被页边界切开的行。`read_output.base64` 保留存储文本的精确字节，UTF-8 字符被切开时 `text:null`；预算计入信任标记和最终 JSON 转义。

standard 模式沿用 TTL/容量和私有原子存储；redacted/ephemeral 模式只在内存保留，任务完成后撤销引用，同进程可续接的检查点（含预算停机）保留引用。恢复时叠加新的秘密规则，规则使旧正文不再安全时明确拒绝该引用。存储失败返回有界错误，明确工具已经执行，不能把缺少输出当作重放副作用的理由。Shell 复用已有 job 日志：模型看到的 `read_job_output` 是过滤后的文本，标记 `filtered:true,lossless:false`，省略原始 base64，保留原始字节游标。跨页拆开的凭据可能无法通过单页模式识别，job 原始日志仍应按敏感数据保护。完整接口及边界见 [存储说明](docs/deepseek-output-store-notes-2026-10-22.md)。

### 插件作用域与任务释放

嵌入 API 可用 `tools.createPluginScope({id})` 创建作用域，`scope.registerTool(definition)` 返回精确 registration handle，`scope.own(disposer)` 归属资源，`scope.listen()` 归属监听器。`dispose()` 先关闭入口、取消调用并等待真实结束，再逆序等待异步资源清理；重复调用共享同一 Promise，旧 handle 不删除后来同名的工具。清理报告包含失败原因，不把 Promise resolve 当作卸载成功。

任务插件使用 `config.setupPlugins(scope, {signal})`，可异步初始化；每次运行或继续任务都重新 setup，并在任务结果落盘前自动释放。清理失败会使任务明确失败，setup 失败也保存诊断，且不虚构成功消息或检查点。普通 `registerTool()` 仍为宿主静态注册。插件权限继续与用户/任务/Worker 权限取交集，审批期间被替换的注册需重新调用，不继承旧审批。这是可信进程内 API，插件须遵循取消并正确归属后台工作；没有新增 CLI 插件加载器、热更新或恶意插件隔离。详见 [作用域说明](docs/deepseek-scope-notes-2026-10-22.md)。

### 嵌入式模型请求

`createModelClient(config).prepareRequest(request, {signal})` 冻结实际请求、生效配置、能力来源和路由身份，`dispatch()` 只能使用一次；在预算和限流包装后准备请求，两者仍在真实调用路径中。上下文预算以实际生效的输出上限预留空间。未知模型窗口使用标明来源的 32768 fallback，远端能力保持 `unknown`；可通过嵌入配置 `modelMetadata` / `capabilityOverrides` 提供准确数据。明确不支持的控制在 API 调用前拒绝，元数据不会让本地 adapter 支持其无法传输的字段。这些是嵌入 API，尚无单独的 CLI 元数据管理命令。详见 [请求合同说明](docs/deepseek-request-notes-2026-10-22.md)。

## Worker 与多 Agent

复杂任务可以由主 Agent 调度 Worker：

- `research`：只读研究和定位。
- `verify`：可读取；仅父任务和用户权限允许写入时开放 Shell。没有直接编辑工具，但命令可以产生副作用。
- `implement`：可在授权范围内编辑文件并验证。

主 Agent 使用 `agent` 创建有独立上下文的 Worker，使用 `send_message` 继续已有 Worker，使用 `task_stop` 停止不再需要的 Worker。research Worker 可以并行；共享工作区的 implement/verify Worker 按队列串行，排队期间也可取消。所有工具都执行用户、任务与 Worker 权限的交集。每个任务有 Worker 数量限制，Worker 也受共享 rate limiter、token、步骤和超时预算约束。

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
    ├── tool-outputs/<session-id>/*.json
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

上述命令运行 trace grader：读取 `eval/cases` 和 `eval/fixtures` 或审计记录，检查分类、工具和报告契约；分数不代表真实编码结果。

```bash
npm run eval:e2e -- --trials 3 --no-report
```

端到端回归在独立临时项目执行真实任务、文件工具、命令及 Worker，用不可改的断言检查最终文件、行为和变更范围，失败返回非零。保留 edit_file、apply_patch、Worker 三条修复路径，并扩展为 15 个多类型场景；离线 provider 用于验证 harness，未测量真实模型能力。两种模式均可输出 JSON；开发检查使用 `--no-report` 避免生成 `eval/reports`。详见 [Eval 使用说明](eval/README.md)。

## 项目规则与上下文文件

Deecoo 按以下优先级读取项目规则：

```text
.deecoo.md > AGENTS.md > CLAUDE.md
```

README、package、Git 摘要、历史摘要、Memory 和技能产物均带来源作为不可信参考数据注入。只有明确的规则文件进入系统指令。

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
npm run eval -- --no-report
npm run eval:e2e -- --trials 3 --no-report
```

- `npm run check` 对 CLI、源码、测试和 Eval JavaScript 执行语法检查。
- `npm test` 运行 Node.js test runner 下的完整测试套件。
- `npm run eval -- --no-report` 检查固定 trace 契约；`npm run eval:e2e -- --trials 3 --no-report` 独立检查真实临时项目结果，均不调用真实 provider。

项目规则位于 `.deecoo.md`：代码修改后运行 `npm run check`，行为变化还需运行 `npm test`。`eval/reports` 是生成输出，除非明确要求，不应手工修改。

### 确定性回放

`createReplayClient` 和 `createReplayTools` 可以重放已记录的模型响应和工具结果，用于 golden transcript 回归测试。回放模式不访问 provider，也不执行真实文件或 Shell 副作用。

任务通过显式 RuntimeContext 传递 cwd、env、signal、预算和 backend，不修改全局 process.env；旧的 withIsolatedEnv/withIsolatedCwd 仍保留为兼容工具。共享 rate limiter 控制主 Agent 和 Worker 的 provider 并发。

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
- 应用层权限与 egress policy 不代替 OS 执行边界；需要强制限制时使用 `--sandbox required` 并检查 jobs capabilities。macOS/Linux 后端能力不同，无法保证所有运行时和依赖都兼容。
