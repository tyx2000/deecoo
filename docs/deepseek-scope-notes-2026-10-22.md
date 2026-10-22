# DSH-REF-005 插件作用域与精确释放

2026-10-22。原评估把动态插件生命周期列为能力机会，没有把静态工具注册本身说成已确认缺陷。用户随后授权继续实施；本轮决定为 adjusted，outcome 为 implemented（下述模块合同），root 负责 runtime/taskRunner 入口及最终集成验收。工作树包含前轮授权的未提交改动，全部保留。

## 参考与采用边界

固定官方 [`deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)，[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)。实际阅读本地固定 SHA 镜像，没有执行上游源码或引入依赖；本模块是原创适配，没有复制上游代码。

- [core/scope:115 的 quiesceFiber](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/index.ts#L115) 等待异步 teardown；[createScope:137–145](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/index.ts#L137) 缓存并共享 disposal Promise。Deecoo 采用同一完成边界，并在释放前关闭注册/调用 admission、协作取消并等待真实 settlement。
- [scope/store.ts:43 的 NamedEntries.insert](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/store.ts#L43) 返回独立、幂等撤销函数。Deecoo 使用 registration identity 与 entry 对象相等检查，旧 handle 不能删除之后的同名注册；进行中的调用保留旧 entry 和 renderer 快照。
- 不引入 Cordis、作用域继承/路由 carrier、依赖注入或插件市场；保留 runtime 的权限交集、输出合同、取消和真实 effects 记录。scope 不提供新的 allow 权限。

## 模块接口

```js
import { createPluginScope } from '../src/harness/pluginScope.js';

const scope = createPluginScope({ id: 'task-plugin-identity' });
scope.own(() => connection.close(), { label: 'connection' });
scope.listen(emitter, 'notification', async (value) => consume(value));

const result = await scope.run(async ({ signal }) => {
  // 可信插件遵循这个实时 signal；scope 等待此 Promise 真正 settle。
  return operation({ signal });
});

const handle = registry.registerHandle(definition, { scope });
// handle: {name, registrationId, active, stop(reason?), dispose(reason?)}
// registry.register(definition) 继续返回名称，保持原兼容行为。

const cleanup = await scope.dispose();
// {ok, id, state: 'disposed' | 'dispose-failed', errors, listenerErrors}
```

- `scope.run` 在 admission 关闭时同步抛 `PLUGIN_SCOPE_DISPOSED`，否则返回已追踪 Promise。真正 dispatch callback 前再次检查 linked signal；预先取消或同tick开始dispose的排队调用不运行callback。它给 callback 传 `{signal}`；未追踪的后台工作不自动归属 scope。
- `own(disposer,{label,deactivate})` 接管该 disposer，返回拥有共享 Promise 的 `{dispose,state}`。所有已归属 deactivator 先执行，随后 scope.signal abort，等待 scope.run 的已有调用 settle，再按反向注册顺序 await disposer。默认 disposer 可以同步或异步。
- `deactivate` 用于同步隐藏入口/移除 listener；即使返回 Promise，scope 也会等待其结果并记录失败。它不能等待自己的 scope disposal；直接依赖环明确 `PLUGIN_CLEANUP_CYCLE`。任意隐藏的异步环或永不 settle 的插件仍由可信插件作者负责，scope 不虚报完成。
- `scope.dispose()` 和同一资源/registration handle 的 `dispose()` 包括同步重入在内始终返回同一个 Promise。失败也保留同一失败报告，不自动重复有副作用的 teardown。
- scope/listener/registration 在开始 disposal 时拒绝新操作。`own` 只能在 active 时接管资源；插件应在 setup 中先登记资源再开放调用，异步新获得资源若未能转交 owner，调用方须在 finally 释放。
- `listen` 支持 Node EventEmitter 和 DOM EventTarget，精确移除本次包装，不误卸其他 scope 的同事件 listener；单独销毁 listener handle 也等待其已接纳 callback settle。被接纳的异步 listener 使用 scope.run 跟踪；异常消费并记录为 listenerErrors（最多100条、总数由listenerErrorCount报告），避免 unhandled rejection和诊断无限增长；正常 scope 取消不记作 listener 错误。listener 观察错误与资源清理失败分别报告，不把前者冒充卸载失败。
- registry.scope 关联只在私有 WeakMap 中保存，不进入 advertisement/schema/route fingerprint。`registerHandle` 注销只删相同 entry；旧调用已捕获原 executor、版本、schema、参数和 renderer，之后同名注册不会替换这些事实。
- 作用域关闭的在途工具接收 linked AbortSignal。registry 等到 handler settle，再返回带 `executionState:'executed'` 的取消/超时结果；已返回的 canonical 结果不会因为之后 dispose 而改变，旧 renderer 仍能读取该已完成结果。副作用由 runtime ledger 消费，不从投影反推。
- 资源 disposer 抛错、deactivator 失败或明确返回 `{ok:false}` 都产生 `dispose-failed` 与有界诊断，并继续尝试其他资源。报告不会仅因函数 Promise resolve 就称卸载成功。`snapshot()` 提供 state、activeCalls、归属记录数和 listenerErrors。

这是可信进程内插件生命周期管理，不是恶意代码沙箱：插件必须遵循 signal，所有返回/派生工作必须正确 await；无法强制终止死循环、未归属 timer、第三方进程或任意自行保存的宿主引用。开始 disposal 后不提供热更新、资源重试或回滚注册操作。

## 验证与自检

- `node --test test/pluginScope.test.js test/toolOutputContracts.test.js test/toolCancellationContracts.test.js`：**27/27 通过**（新 scope 合同12项、输出合同14项、旧取消合同1项）；日志 `/private/tmp/deecoo-dsh-plugin-scope-tests.log`。
- 新合同覆盖实际 AbortSignal、非协作 handler settlement、异步连接关闭、同步 admission 拒绝、重复/重入共享 Promise、旧 disposer/新同名注册、已完成 canonical renderer、失败清理仍尝试其他资源、错误状态、直接释放环、EventEmitter/EventTarget、异步 listener 异常与 registry timeout。
- solution_fit：suited=yes，executable=yes，affordable=yes，cost=medium；以现有 registry 与 runtime 生命周期为接缝，不迁移整体框架。solution_reliability=high，模块合同有真实异步运行证据；进程内非协作代码限制明确。patch_scope=medium，新增小模块、扩展 registry 可选 handle API。
- 最终 `npm run check`、root 的 task A→B 隔离、任务成功/失败 cleanup 和全量/E2E验收由 root 统一完成；本笔记不把模块定向测试当成最终产品集成结论。

## 对 root 生命周期接入的独立有限复核

`node --test --test-name-pattern='DSH-REF-005' test/deepseekLifecycleIntegration.test.js`：5/5 通过，日志 `/private/tmp/deecoo-dsh-scope-integration-review.log`。真实验证了任务A注册不会进入B、异步连接关闭前不返回、setup异常移除已注册资源且已知秘密message被过滤、运行后的cleanup失败在返回和持久报告中一致、注销后仍记录已发生mutation，以及异步审批不能授权替代注册。额外微任务顺序探针确认执行前取消不产生虚假workspace revision，已开始执行后取消保留workspace-uncertain；runtime已按捕获的dispatch entry记录effects。

另提交两个直接复现，root负责修复，不在本模块擅改集成文件：

- LIFE-REV-001（confirmed，fixed-verified）：原复现为standard store/session下，setup先登记一个会失败的disposer，再抛setup错误，返回failed/PLUGIN_DISPOSE_INCOMPLETE但outputs与audit均空。root现于outer catch先cleanup/apply，设置store.secretRegistry并校验task owner后保存失败audit/outputs。独立重跑原setup+cleanup双失败：failed/PLUGIN_DISPOSE_INCOMPLETE，2份outputs、1份audit，返回/持久结果pluginCleanup均false，provider调用0次，checkpoint不存在，没有伪造可恢复或成功history。
- LIFE-REV-002（confirmed，fixed-verified）：原复现为env中的PLUGIN_SECRET同时作为setup Error.code，返回stoppedReason和error.code出现秘密原文。root现把动态code规范为受限machine code，若known/pattern过滤会改变则使用request_failed固定fallback。独立重跑原已知秘密code：返回和持久结果均无秘密，stoppedReason/error.code为request_failed，2份outputs、1份audit，provider调用0次，checkpoint不存在。

修复后独立定向 `node --test --test-name-pattern='DSH-REF-005' test/deepseekLifecycleIntegration.test.js` **6/6通过**；原两个manual复现也通过上述断言。没有进一步改产品代码、扩大审查或运行全套；root仍负责最终统一验收。
