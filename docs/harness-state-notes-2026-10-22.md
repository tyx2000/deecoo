# NEXT-007/008 实现与续接记录

日期：2026-10-22。工作树 `/Users/adib/Documents/Deecoo`，Node v24.21.0、ESM、npm。基线是现有未提交实现及先前的 305 项回归；本记录不把 HEAD 当成当前未提交源码的快照。没有调用真实 provider、安装依赖或写入 `eval/reports`。

## 已接入的上下文与导航

- `src/context/builder.js`：`buildContextBudget({contextWindow,outputReserve,safetyReserve,tokenBudget,layers})` 从窗口扣除输出和安全预留；`buildBudgetedContext(items,options)` 返回 `{messages,metrics}`。分层先分别保留，再按优先级借用剩余额度。`contextItem(message,priority,{layer,required})` 的必需内容若超预算抛出 `CONTEXT_BUDGET_EXCEEDED`，不截断规则或数据的信任封套。显式旧 `budget` 参数仍按字符计算以兼容旧调用；生产集成应传模型窗口。
- `estimateTokens`、`estimateMessageTokens`、`measureContextMessages` 是保守 UTF-8 字节估计，**不是精确 tokenizer**。统计包含 `exactTokenizer:false`、窗口、预留、各层用量、保留/丢弃条数和准备耗时。provider 的非文本/framing 开销仍需要安全预留，未用真实模型证明精确占用或吞吐。
- `src/tools/files.js` 的 `readWorkspaceFile` 支持 `startLine/endLine`（1 起始、闭区间），或互斥的 `offset/limit`（0 起始行偏移、行数），保留 `maxBytes`（默认 20,000、上限 100,000）。返回 `startLine/endLine/nextStartLine/totalLines/totalBytes/rangeComplete`。显式范围即使完整返回，也始终 `sourceComplete:false`；只有未裁切的整文件读取为 `true`。
- `contentHash/version` 为完整实际文件字节的 SHA-256。拒绝非 UTF-8 文本；打开 regular file 时使用 `O_NOFOLLOW`，读取后核对身份/大小/mtime。每次缓存命中前仍安全重读并 hash 验证，因此外部同长度修改不会复用旧观察；缓存节约的是处理开销，不宣称免除磁盘读取。`getFileReadMetrics(state)` 返回 reads/cacheHits/cacheMisses/invalidations/bytesRead。
- `src/context/navigation.js`：`createCodeNavigator(cwd,{maxFiles=2000,maxFileBytes=2MiB})` 提供 `symbols({query,directory,maxResults})`、`references({symbol,directory,maxResults,includeDeclarations})`、`metrics()`、`clear()`；工具适配导出 `findWorkspaceSymbols(workspace,getRealWorkspace,args,state)` / `findWorkspaceReferences(...)`。结果有 path/line/column/hash/version；明确 `navigationMode:'lexical-not-language-server'` 和 `confidence:'lexical'`。这不是语义 LSP，可能包含注释/字符串中的同名引用；有歧义时保留候选，不猜测绑定。
- 导航每次扫描重新发现文件并校验内容 hash，缓存按文件失效，删除也清除记录；敏感/排除路径及符号链接边界复用既有 `createContextFileAccess`。最大 16 层、文件数/文件大小限制明确报告 truncated。
- session 滚动摘要保留显式 requirement/constraint/禁止等用户行；另保留有界的失败、未解决、验收和必需检查行。全文历史仍为权威来源，不把关键词提取声称为语义摘要。

root 负责的实际调用：taskRunner 使用模型窗口构建上下文并记录 metrics；loop 把 tools schema 计入输入估计、压缩后仍超限则在 provider 调用前明确失败；runtime/schema 暴露 `find_symbols` / `find_references` 及读取范围。集成状态应以 root 最终测试为准。

## 已接入的存储契约

`src/storage/atomic.js` 的公共 API：

```js
withFileLock(path, asyncAction, {timeoutMs, pollMs, orphanGraceMs})
atomicWriteFile(path, content, {backup=true, mode=0o600, maxBytes=Infinity})
readStoredFile(path, {encoding='utf8'})
readJsonFile(path, {fallback, migrate, validate, recover=true, onRecovery})
writeJsonFile(path, value, options)
updateJsonFile(path, updater, options) // updater 返回 undefined 表示 no-op
removeStoredFile(path, {backups=true})
appendJsonEvent(path, event, {maxBytes})
readJsonEvents(path)
```

- JSON API 内部已持锁，**不要在同一 path 的外层再次 withFileLock**；组合事务使用另一把 `path+'.operation'` 锁。进程内队列与跨进程 mkdir 独占锁共用；锁记录 PID/随机 token。只有确认 PID 不存在才回收，活进程不会仅因年龄被抢锁；PID 重用可能导致安全的超时，而不会强删活锁。回收者之间另串行重检，避免删掉新持有者的锁。
- 临时文件 `O_EXCL|O_NOFOLLOW`、0600、文件 fsync、rename、父目录 fsync；备份是上一个有效版本。JSON 语法损坏先隔离 `.corrupt-*`，再从 `.bak` 恢复，否则返回显式 fallback；未来/不支持 schema 抛 `STORAGE_SCHEMA`，不误当成语法损坏。恢复备份意味着可能退回上一次提交，不保证恢复损坏前的最新内容。`onRecovery` 可给管理入口提供恢复通知。
- 最终读取文件以 no-follow handle 固定；这是本地受管存储的协作锁，不宣称能抵御拥有同一用户权限并不断替换所有父目录的恶意进程。
- JSONL journal 只忽略无法解析的最后残缺记录；中间损坏明确 `STORAGE_CORRUPT`。完整但无末尾换行的记录会保留。追加使用锁内原子替换，并有文件容量限制；它是有界耐久事件日志，不是数据库 WAL 或 exactly-once 执行协议。

已改真实调用点：`session/store.js`、`session/artifacts.js`、`memory/projectMemory.js`、`observability/audit.js`、`reporter/outputs.js`；checkpoint 经 session store 使用同一原语。execution agent 也决定用 `atomicWriteFile(...,{backup:false})` 保存 job 状态。workspace change-set 由 root 接此 API。

## Session、所有权及恢复

`createSessionStore(cwd, options)` 可选 `rootDir`、`privacyMode`、`retentionDays`、`maxBytes`、`maxFileBytes`、`durableToolEvents`、`secretRegistry`、`autoPrune:false`（管理查询不触发启动清理）。默认项目容量 128MiB、单记录 8MiB、保留 90 天。默认创建 store 时执行项目清理。

新增方法：`loadSession(id)`、`claimTaskOwner(id,{runId,taskId})`、`assertTaskOwner(id,runId)`、`releaseTaskOwner(id,runId)`、`appendToolEvent(id,event)`、`readToolEvents(id)`、`inventory()`、`prune({dryRun,now})`。

- Session schema 1/无版本可投影迁移到 schema 2；保存后有 revision。陈旧 revision 保存会按 turn UUID 和 artifact ID 合并完整历史，避免两个进程追加互相覆盖；相同用户输入是合法的独立 turn，不按文本去重。
- `deleteSession(id,{associated:true})` 默认清除选定 session、checkpoint、owner、journal、artifacts、audit、output(s)、备份、损坏隔离及中断临时文件；保留项目/global Memory。只保存无正文的删除墓碑，防旧内存对象随后 save 复活。`associated:false` 仅删除 session/checkpoint/owner。
- session 关联删除**不包含共享项目 change-set、独立后台 job、全局 Memory**。这几类数据不在 session 子目录，需管理入口显式选择对应 scope；不能把删除一个 session 宣称为删除全部项目数据。
- `createCheckpointWriter` 新增 `ready()`，返回原始 owner claim promise；root 必须在执行工具前 await，冲突拒绝必须传播。writer 的 `flush/clear` 在 finally 只释放自己的 runId。root 已知：baseline/setup 异常也应位于受控生命周期中，避免 claim 后漏 finally。
- checkpoint 恢复不重放待定工具副作用；没有完成结果的调用仍标 `INTERRUPTED_OUTCOME_UNKNOWN`，模型需检查当前工作区。可选工具事件 journal 提供前/后/执行归属证据，但不把日志缺失当成“未执行”。

## 数据治理与管理 API

`src/storage/governance.js` 提供 `storagePolicy`、`canPersist`、`storageInventory`、`pruneStorage(root,policy,{dryRun,now})`。库存/清理不遍历符号链接，按 mtime 过期及总容量从旧到新淘汰；包含 backup、corrupt、崩溃遗留 tmp。持有文件锁或活跃 session owner 的记录跳过，所以活跃事务期间总量可暂时超过限制；释放后可再执行 prune。容量限制不是 OS 硬磁盘配额。

- `standard` 保存普通 session；audit/output/artifact/journal/Memory 做秘密过滤。
- `redacted` 另外对 session/checkpoint 做秘密过滤；它仍会保留正常对话与源码，不是匿名化。运行中应把完整 secretRegistry 设在 store 上，尤其是没有固定 key 前缀的凭据。
- `ephemeral` 用内存 session/checkpoint/Memory，不创建其持久化记录；audit、durable output、artifact/journal 保存跳过。root 的 change-set persist 也应由隐私选项控制。已有磁盘数据不因切换模式被自动删除。

Memory API（`src/memory/projectMemory.js`）：

```js
listMemory(store, {scope:'project'|'global'|'all', includeExpired:false, kind, now})
editMemory(store, {id, scope:'project', text, expiresAt /* ISO 或 null */, confidence})
updateMemory // editMemory 的别名
deleteMemory(store, {id, scope:'project'})
pruneMemory(store, {scope:'all', now})
```

项目/global 文件各自锁内 read-modify-write；schema 2 给旧条目稳定 ID，限制每类 80 条、单条 4,000 字符。显式 expiresAt 控制到期；到期项不进入上下文但可查看/编辑/删除/批量清理。global Memory 的 TTL 由其条目和管理接口控制，不属于项目目录文件 retention。

Artifact API：`listSkillArtifacts(store,session)`、`readSkillArtifact(store,session,id)`、`deleteSkillArtifact(store,session,id)`；索引分配受锁，artifact tombstones 防陈旧 session save 复活已删除索引。

Output API：`listRunOutputs(store,session)`、`readRunOutput(store,session,fileName)`、`deleteRunOutput(store,session,fileName)`。audit/output 文件名增加 UUID，避免同毫秒覆盖；完整 output/artifact 只过滤秘密且遵守 maxFileBytes，不使用 audit 的 40k 文本截断。`redact` 可传 `maxTextChars:Infinity`。

## 上游参考与采用方式

以下均阅读固定 commit 的本地源码镜像，重新实现本项目契约，没有复制上游代码段或引入上游运行时。

- pi 固定 commit [`bd3c9b823762b7383954aa49e13ee350471015fe`](https://github.com/earendil-works/pi/commit/bd3c9b823762b7383954aa49e13ee350471015fe)，MIT，版权 Mario Zechner；[LICENSE](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/LICENSE)。
- pi [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/session-manager.ts#L627)：JSONL session entries、版本迁移、context projection、末尾记录修复。采用“完整历史与压缩投影分开、记录有版本、异常尾部可恢复”的思路；本项目保留 JSON session 并新增可选 JSONL 事件，不冒充兼容 pi session 格式。
- pi [`core/compaction/compaction.ts`](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/compaction/compaction.ts#L267)：模型窗口减 reserve、近期内容保留及估计。采用窗口/输出预留和分层保留；本项目独立使用更保守的字节估计，未声称采用其 tokenizer。
- pi [`core/tools/read.ts`](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/tools/read.ts#L14) 与 [`core/tools/truncate.ts`](https://github.com/earendil-works/pi/blob/bd3c9b823762b7383954aa49e13ee350471015fe/packages/coding-agent/src/core/tools/truncate.ts#L78)：范围读取和字节/行数截断。采用明确范围、可继续读取和 UTF-8 安全裁切。注意 pi offset 是 1 起始，本项目 offset 明确为 0 起始，不能混用。
- Codex 固定 commit [`a3b685331fc700bec554b2fe2a929a65f4fe1548`](https://github.com/openai/codex/commit/a3b685331fc700bec554b2fe2a929a65f4fe1548)，Apache-2.0；[LICENSE](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/LICENSE) 与 [NOTICE](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/NOTICE)。
- Codex [`codex-rs/app-server/README.md` local rollout compression](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/app-server/README.md#L268)：冷文件、writer/maintenance locks 以及“请求已接收不等于已完成”；[historical rollout replay/migration](https://github.com/openai/codex/blob/a3b685331fc700bec554b2fe2a929a65f4fe1548/codex-rs/app-server/README.md#L449)。采用活动 writer 保护、旧版本读取及恢复不重复副作用的边界。本地已获取的是这些真实文档；先前猜测的 rollout Rust 路径返回 404，未引用不存在的文件，亦未声称已审阅该 Rust 存储实现。

上游镜像路径：`/private/tmp/deecoo-harness-references-20261022/{pi,codex}/`，同级 `*-commit.json` 保存来源。引用均是固定 commit permalink，不依赖浮动分支。

## 验证与待完成项

- 新增 `test/contextStorageGovernance.test.js`：20/20 通过。覆盖小窗口/分层必需上下文、千行文件范围/偏移/full hash、外部同长度变更、缓存安全复核、跨文件导航、两个独立 Node 进程更新同一 JSON/session、旧 schema、损坏/backup、死锁owner回收与活锁拒绝、ready owner冲突、JSONL尾部、Memory CRUD/TTL、隐私/retention、完整秘密过滤 output、artifact并发与删除、会话关联清理与禁止复活。
- 相关 session/checkpoint/trust/取消回滚和新增测试组合：59/59 通过（当时新增为19项；之后新增 legacy 重复 turn 保护，25项 session+storage 组合通过）。未放宽既有文件写入安全或 rollback。
- `npm run check` 已通过。一次集成中的完整 `npm test` 得到 351 项：345 pass、5 fail、1 sandbox平台skip；5 项位置已交 root：execution hard CPU/file-size、eval 实际失败状态、Git 特殊路径 schema、研究工具精确列表、always-all shell。该结果发生在 root 集成修复中，**不是最终全套验收结果**；最终需 root 再跑并记录。
- 没有真实 provider 或生产大仓库基准；没有 LSP/语义跨语言解析；未验证 Windows 文件系统/锁/目录 fsync 行为；没有数据库级多文件事务、加密存储或 exactly-once 副作用保证。活动数据临时超容量、global Memory、jobs/change-set 关联范围须在管理入口说明。
- 集成复核向 root 提交 CTX-REV-001..004：extension 未明确授权仍执行、投影裁切却保留 sourceComplete、resume prefix 切断 tool 组、相邻多 hunk 批量接受误报冲突。root 已修复；独立重跑四个原复现：undefined 审批被拒且 executor 未运行、裁切投影标 partial、压缩不留悬空 tool calls、相邻多 hunk accept 成功。它们只证明这四个复现已修复，不构成穷尽审查。


### 当前集成复验补记

`npm run check` 再次通过；`npm test` 当前 **382 项，381 passed、0 failed、1 skipped**，耗时约 11.3 秒。平台 skip 是受宿主限制不能执行的 `sandbox-exec` OS 隔离测试；没有把 skip 写成通过。完整日志位于 `/private/tmp/deecoo-context-storage-final-tests.log`。这一结果是 root 并行集成后的当前工作树，后续再改行为应按影响补验。
