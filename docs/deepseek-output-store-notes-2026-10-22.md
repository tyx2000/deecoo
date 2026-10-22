# DSH-REF-002 大输出存储实现记录

日期：2026-10-22。初始实现范围为 `src/storage/toolOutputs.js`、`test/toolOutputStore.test.js` 和本记录；后续授权 OUT-REV-004 增加 `src/tools/outputPage.js`、`test/outputPage.test.js`，并只在 `modelOutput.js` 增加其 import 和 read_output 分支。root 负责 runtime/loop/CLI、头尾预览和 Shell job 日志复用。没有修改已有 atomic/governance、运行上游程序、调用真实 provider 或写入 `eval/reports`。

## 公共接口

```js
const store = await createToolOutputStore({
  stateDir, // standard 必须提供专用的私有目录；隐私模式不访问它
  owner: { sessionId, runId },
  privacyMode: 'standard', // standard | redacted | ephemeral
  retentionDays: 90,
  maxBytes: 128 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  secretRegistry,
});

await store.save(text, { source });
// {outputRef, totalBytes, hash, expiresAt}

await store.read({outputRef, offset: 0, maxBytes: 16384});
await store.read({outputRef, startLine: 2, endLine: 5, maxBytes: 16384});
// {outputRef, text, base64, encoding, offset, nextOffset,
//  rangeStartOffset, rangeEndOffset, totalBytes, hash, expiresAt,
//  eof, truncated, rangeComplete, startLine?, endLine?, nextStartLine?}

await store.search({outputRef, query, maxResults: 50});
// {outputRef, query, matches:[{line,column,offset,matchBytes,
//  preview,previewStartColumn,previewTruncated}], truncated,totalBytes,hash}

store.addSecretRegistry(nextRegistry); // 同步；仅可信 host 可追加，不能移除既有过滤器
store.dispose(); // 同步、幂等；撤销本实例并清空本实例内存
```

- `outputRef` 是 192-bit 随机值的 `out_` 标识，不能传路径或文件名；成功结果与公开错误不含 stateDir 路径。完整正文为经过秘密过滤的文本，`hash` 是其 UTF-8 字节的 SHA-256，`totalBytes` 是净内容字节数。
- `source` 可以是工具名字符串，或仅含 `{tool,invocationId,workerId,step}` 的有界身份对象；未知字段明确拒绝，不能带 raw args、任意嵌套对象或路径。具体秘密也会从 source 身份字段中移除。
- 字节游标 0 起始；行范围 1 起始、闭区间，不能同时传 offset。读取单页 maxBytes 为 1..1MiB；调用方可以使用更小预算。超界参数拒绝而不悄悄改写。startLine 超过末尾返回空页/eof。
- 每页 `base64` 都能无损还原该段原始 UTF-8 字节。任意字节边界可能切开中文/emoji，此时 `text:null, encoding:'base64'`，不会用 U+FFFD 冒充完整字符。页恰好是完整 UTF-8 时才给 text；BOM 和 CRLF 也保留。
- 按行读取仍可能受 maxBytes 限制；使用返回的 nextOffset 继续，直至第一次返回的 rangeEndOffset，并把末页 maxBytes 限制为剩余字节。不能仅用 nextStartLine 跳过一条被页边界切开的行。
- eof 表示到达整个输出末尾；rangeComplete 表示本次选择的范围已读完。因此完整读取第 2..3 行可以 `rangeComplete:true,eof:false`。truncated 表示本次选择范围尚有剩余，并不是保存时正文被丢弃。
- search 是 `String.indexOf` 字面量、非重叠查找；不会编译用户正则。query 最多 4096 UTF-8 字节，maxResults 最多 500。offset 是字节位置，line/column 为 1 起始，column 使用 JS UTF-16 code unit。匹配预览不超过 300 code unit，并明确其起始列和裁切状态。

## 归属、秘密与生命周期

- record 内保存 sessionId/runId；读取和搜索必须与当前实例二者都一致。opaque ref 本身不能授予跨 session/run 访问。持久化恢复应由受信任的调用方使用 checkpoint 的原 owner 重建，不能由模型自行声明另一个 owner。
- standard 原子持久，另一个相同 owner 实例可重开；dispose 不删除持久记录，也不影响同目录其他实例。该实例 dispose 后任何 save/read/search 都明确 `OUTPUT_STORE_DISPOSED`。
- redacted/ephemeral 都只在本实例 Map 中存放过滤后正文，不创建或扫描 stateDir；dispose 后清空，另一个内存实例即使 owner 相同也不共享引用。root 可为同进程中断继续复用该实例，正式结束须 dispose。
- 保存先用现有 `redact(...,{secretRegistry,maxTextChars:Infinity})` 做具体凭据和固定模式过滤，再计字节/摘要，保留完整过滤后正文。之后 secretRegistry 若新增规则并会改变已存正文，旧引用拒绝 `OUTPUT_REDACTION_CHANGED`，避免回传现在已识别的秘密或暗改字节游标。
- 同进程恢复时 host 调用 `addSecretRegistry(registry)` 叠加新任务环境收集的规则；要求对象提供 redact 函数，并先检查实例仍有效。保留每个旧 registry 当时的方法及其后续 add 的活规则，重复加入同实例不能替换旧方法。dispose 清除本实例规则引用。新增规则令旧正文变化时，read/search 都整段拒绝，不能通过 base64 返回新认定的秘密。
- 本接口保留的是完整的**安全模型投影文本**；canonical executor 结果与效果证据由 registry/runtime 保留。摘要不等于原始秘密内容的 hash。

## 耐久性、TTL 与容量

- 复用 `storagePolicy` 的默认值/配置检查和 `storageInventory` 的实际文件字节统计；复用 `withFileLock`、`writeJsonFile`、`readJsonFile`、`removeStoredFile`。没有再建一套原子写实现。
- 新目录 0700、record 0600；已有 group/other 开放的专用目录/record 拒绝，不擅自 chmod 任意调用方路径。捕获并反复校验 stateDir 的 dev/ino/realpath，拒绝 root 被替换、最终符号链接或重定向。
- 每个输出是单个 immutable JSON record（正文与 owner/hash/TTL 一起写），使用现有 fsync+rename 原语且不产生 backup。中断 tmp 不是合法引用，仍计入容量。没有把两个文件的部分写入当作完整输出。
- malformed JSON、未来 schema、净字节数或 hash 不符明确 `OUTPUT_CORRUPT`；此处不把其他旧正文恢复到同一引用，也不静默返回空内容。已有通用 atomic 的可恢复 JSON 行为没有被修改。
- 同一个 standard stateDir 使用公共 `.tool-output-transaction` 锁，将过期回收、容量检查、写入放在同一事务内；独立 Node 进程也共享配额。maxBytes/maxFileBytes 均计 JSON 记录实际字节（含元数据和转义），不同于 totalBytes 的净正文大小。
- 容量不足只拒绝新 save（`OUTPUT_CAPACITY` / `OUTPUT_FILE_LIMIT`），不淘汰仍有效的其他引用，不无界回退 inline。非法/损坏记录和未知文件不会被自动当作可删内容，也消耗配额。
- 每条输出使用保存时的 expiresAt，而不是读取实例当前的 retentionDays。Infinity 对应 expiresAt:null；0 对应立即到期。过期但仍在盘上的读取报 `OUTPUT_EXPIRED`；下次保存可删除有效 schema 的过期记录以释放配额，回收后再读为 `OUTPUT_NOT_FOUND`。
- root 应默认把目录组织到 sessionId 子目录，便于既有项目治理保护活跃 owner 与清理选定会话；跨项目/全局治理不能把一个 store 的 dispose 当作删除全部持久输出。

## 上游参考及采用方式

固定官方 commit [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)，[MIT LICENSE，Copyright 2026 DeepSeek](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)。参考实际读取的本地镜像 `/private/tmp/deecoo-deepseek-reference-20261022/`：

- [`packages/spill/spill-policy/src/index.ts:91`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/spill/spill-policy/src/index.ts#L91)：保存完整文本后返回可恢复的头尾预览/遗漏计数/定位提示；canonical value 与展示副本分开。root 负责本项目预览策略，本模块负责完整安全文本和引用。
- [`packages/spill/spill-local/src/index.ts:55`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/spill/spill-local/src/index.ts#L55)：私有目录、session 归属、0600 输出与 retention。其 [`saveText:149`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/spill/spill-local/src/index.ts#L149) 返回路径 locator/read-grep 提示；本项目采用 opaque ref + 受控 read/search，不把状态路径开放给模型。
- 不复制上游代码、不引入 Cordis/插件运行时；独立复用 Deecoo 既有存储/秘密过滤。上游 spill 失败保留全部 inline 的行为没有照搬：本项目 save 明确失败，展示层仍须遵守硬窗口预算。

## 验证与接入复核

- 最新定向命令 `node --test test/outputPage.test.js test/toolOutputStore.test.js test/deepseekIntegration.test.js test/toolOutputContracts.test.js`：**60/60 通过**（outputPage 9、store 21、真实集成 16、registry contracts 14）。覆盖完整正文与秘密过滤、0600/0700、BOM/中文/emoji 逐字节重建、CRLF/行范围与 EOF、literal regex 字符串、多行匹配坐标、session/run 授权、路径/数值/metadata admission、同目录多实例及双进程配额、明确容量拒绝、TTL、两种隐私模式/dispose、损坏/hash/schema、中断 tmp、目录/链接替换和追加秘密规则。
- `npm run check` 通过。root 明确要求本轮仅定向测试、不重复全套 npm test；最终完整测试与离线 E2E 由 root 在集成稳定后统一执行。没有真实 provider 调用。
- OUT-REV-001/002/003 原复现已重跑通过：包含信任边界封套的预览在 16,000B cap 下为 15,998B；合成 sk 模式秘密在 preview 与存储正文中都移除；按行读取的 rangeEndOffset/rangeComplete/nextStartLine 在未缩短的页中保持一致。上述行为另有真实集成测试覆盖。
- OUT-REV-004 已实施：原缺陷是 1024B cap 下控制字符页的 JSON/信任封套超限，通用 spill 生成新的 outputRef 并丢失原 nextOffset/base64，首个读取页即无法前进。纯函数 `shrinkOutputPage(page,{cap,measure})` 对已经过滤的读取投影，按最终 loop transport 的实测大小缩短 base64 对应的原始字节；不访问 store、不递归 spill、不改变原 outputRef/offset。重算 nextOffset、eof、truncated、rangeComplete、encoding 和缩短后的 effectiveMaxBytes；缩短时删去无法保证正确的 endLine/nextStartLine，保留范围终点并让调用方精确按字节继续。读取页的 text/base64 不一致、非终点的空页、损坏 cursor/base64，或连 1B 页都不能放入时，返回有界 OUTPUT_PAGE_UNREADABLE，且没有 nextOffset/base64，不宣称已消费内容。连最小错误元数据也无法放入的异常预算会抛同 code 的明确 RangeError。
- UTF-8 页大小与最终 JSON 大小并非严格单调（无效边界没有 text），因此二分选择不保证最大填满，但每个选中页都实测符合 cap、至少前进 1B、base64 无损；不完整 UTF-8 返回 text:null，保留 BOM。9 项新回归含纯函数最小页/损坏/不撤销已过滤正文、真实 runtime→runAgent 最终 1024B 的控制字符、UTF-8/BOM、ASCII、可疑文本 quarantine 逐页重建，以及行范围首次收缩后到原 rangeEndOffset 的字节续读。metadata 无法装入时明确拒绝；没有未解决的静默停滞或窗口 fallback。
- OUT-REV-005 由 root 修复并在本轮定向命令复核通过：ephemeral/redacted 的 token budget 停机保留可恢复 checkpoint 所属的同进程 store，继续读取原引用后正式完成 dispose。恢复时新的环境秘密也追加到 store；旧引用明确 OUTPUT_REDACTION_CHANGED、无 base64，原工具不重复执行。更早的独立中断→恢复→完成复现也通过。跨进程不能恢复仅内存的隐私引用，仍属公开限制。
- 限制：仅 UTF-8 文本；没有任意路径浏览、图片、数据库事务、加密或 OS 级对抗同账号恶意进程的保证。TTL 清理是请求触发，硬磁盘配额/后台治理仍由 host 管理。未执行真实 provider 或上游程序。
