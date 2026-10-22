# DSH-REF-001：工具规范输出与模型投影

日期：2026-10-22。本次只实现已授权的工具输出契约，未迁移 capability service、通用 hook pipeline 或 scope 框架，未执行上游代码或调用付费 API。

## 已实现的接口

`createToolRegistry(options)` 的 `register(definition)` 在原有声明上支持：

- `outputSchema`：可选的规范输出 JSON Schema。注册时检查支持范围，执行结束后校验。
- `toModelContent(args, canonicalValue)`：可选的同步纯模型投影，返回 JSON 值或字符串。
- `presentationMeta(args, canonicalValue)`：可选的同步纯展示元数据投影，返回 JSON 值或 `undefined`。

`execute()` 返回已脱离工具原对象的深冻结规范结果。对象结果保持原有字段；字符串兼容旧形状 `{ ok: true, content }`；数字、布尔值、数组和 `null` 规范为 `{ ok: true, value }`。**`outputSchema` 校验的是这个规范化后的完整形状**。不声明 renderer 的扩展默认投影完整规范 JSON，`data.answer` 等扩展字段不会进入中央白名单后丢失。内置工具可由 runtime 注册兼容的旧展示 renderer。

`project(result)` 延后生成模型投影，`presentation(result)` 独立生成展示元数据。两者对同一执行最多调用一次各自的 hook，结果和异常均缓存。renderer 只能看到该次调用捕获的原始规范值与冻结入参，不能看到 runtime 后加的私有效果字段。冻结保证不能修改事实；纯度仍是受信本地扩展的协作契约，无法阻止 hook 经闭包执行其他副作用。

`copyProjection(from, to)` 返回 `to`，将捕获的原规范值、入参、renderer、版本和缓存关联到 runtime 的 spread 结果。关联仅存于私有 `WeakMap`，自造对象字段不能取得投影身份。runtime 应先记录真实 effects，再 copy；模型投影不参与 effects、权限或验证证据。后加的取消、超时、权限及输出契约错误优先展示当前 host 状态，跳过自定义 hook。

## 边界与错误

默认规范输出与模型投影各最多 64 MiB JSON UTF-8 字节；入参最多 8 MiB；展示元数据最多 1 MiB；深度最多 64；节点数最多 1,000,000。registry options 可降低这些限制，不能增大或设为无限。Schema 最多 256 KiB。模型实际 inline/spill 预算由 runtime 的另一层输出处理负责，64 MiB 不是上下文预算。

规范化只接受普通 JSON 对象/数组及有限数值。对象的 `undefined` 属性按 JSON 线格式省略，`-0` 变为 `0`；顶层/数组的 `undefined`、稀疏数组、循环、BigInt、函数、Symbol、非有限数字、自定义原型、访问器和非 JSON 自有属性明确失败。快照不调用 getter。捕获输入和输出后，不再引用工具可变对象。

支持的 schema 验证子集：boolean schema、`type`（含 union/integer）、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`、`anyOf`、`oneOf`、`allOf`、`not`、数值上下限/`multipleOf`、字符串长度/`pattern`、数组长度/`uniqueItems`、对象属性数。`$schema`、`$id`、`title`、`description`、`default`、`examples`、`deprecated`、`readOnly`、`writeOnly` 作为注解允许但不影响校验；`$ref` 等其余关键字注册时拒绝。此实现不是完整 JSON Schema 引擎。

新错误代码包括 `TOOL_OUTPUT_INVALID`、`TOOL_OUTPUT_TOO_LARGE`、`TOOL_OUTPUT_SCHEMA_INVALID`、`TOOL_OUTPUT_SCHEMA_UNSUPPORTED`、`TOOL_OUTPUT_HOOK_INVALID`、`TOOL_OUTPUT_RENDER_FAILED`、`TOOL_OUTPUT_META_FAILED`。发生在执行之后的无效结果保留 `executionState: "executed"`；renderer 异常抛出带该状态的明确错误，不改写已成功的规范值，也不暗示工具未执行。runtime 负责捕获投影异常并将规范 fallback 经过秘密过滤、信任处理和预算/引用处理后展示，避免重做已经发生的副作用。

调用方取消与 registry 超时均等候工具 handler settle 后报告，并覆盖扩展自报的成功。受信同进程 handler 必须响应 signal；registry 无法强制终止不合作的 JavaScript。OS 进程终止属于现有 execution backend。

## 参考与采用范围

官方仓库 `deepseek-ai/deepseek-harness`，固定 commit `687f282e8625c6b8d11ff58211a90524be2e4317`，许可证 MIT：

- [`ToolOutputDefinition` 与受信工具执行约束，tools/src/index.ts:213-237](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L213-L237)。借鉴规范 value/schema/render/meta 的职责划分。
- [注册期输出契约检查，tools/src/index.ts:1071-1079](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1071-L1079)。采用注册期拒绝不可验证 schema 的思路，但 Deecoo 的输出声明保持可选，兼容旧工具。
- [私有规范身份、快照、校验和纯投影，tools/src/index.ts:1830-1869](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1830-L1869)。采用私有 WeakMap 身份及规范事实与展示分离；Deecoo 进一步推迟投影至真实 effects 记录之后。
- [MIT 许可证](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)。本地实现按现有 Node ESM registry 编写，未引入上游依赖或运行时。

## 验证

- `node --test test/toolOutputContracts.test.js test/harnessExtensionContracts.test.js`：25/25 通过（14 个新输出契约测试及 11 个已有扩展契约测试）。
- `npm run check`：通过。
- 新测试覆盖旧字段丢失的 before/after、字符串/标量兼容、schema 子集及拒绝策略、不可序列化值、输出/深度/节点限制、快照冻结、异步捕获、私有身份传播、渲染异常/缓存、metadata 限制和取消/超时不可被 hook 隐藏。
- runtime/loop 的真实 agent 集成、秘密过滤、spill 存储、TTL/所有者与最终全套 `npm test` 由根任务集成验证；本模块的短测不等同于这些整链验证。
