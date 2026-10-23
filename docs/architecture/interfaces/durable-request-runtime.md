# Durable 会话模型与请求运行时

## 位置与职责

`src/agent/durable-boundaries.mjs` 的 `ensureDurableRequests()` 在 Harness 创建／恢复前准备请求级 seam；`src/agent/durable-request-source.mjs` 是已核实 Durable 1.0.2 的兼容 implementation。它让 Pi 的会话模型目录、provider 和请求 hook 能被唯一的 Durable 模型执行调用，不创建另一执行循环。

## 签名

```js
await ensureDurableRequests();
// -> { apiVersion: 1, implementation: "native" | "patch" }
```

本入口包含 `ensureDurableBoundaries()` 的准备，并额外要求 `GenerationTask.definition.capabilities.requestRuntime === 1` 和 `CompactionTask.definition.capabilities.requestRuntime === 1`。未来 SDK 宣告完整的同一契约时使用原生实现；仅有提交后边界或仅 generation 支持不能冒充完整请求适配。这些 capability 是本项目提出的契约，不声称当前官方 SDK 已提供。

通过原生 `hook()` 注册：

```ts
// generation 与 compaction 均可注册；第一个非 undefined 的 Models 生效。
modelRuntime(api: HookApi, context: Context): Models | undefined;

// generation 的既有 beforeRequest 向后兼容，仅返回 messages 仍有效。
beforeRequest(
  request: { model: Model<Api>; messages: readonly Message[]; options: ModelsSimpleStreamOptions },
  api: HookApi,
  context: Context,
): {
  model?: Model<Api>;
  messages?: readonly Message[];
  options?: Partial<ModelsSimpleStreamOptions>;
} | undefined;
```

所有返回均可异步。`modelRuntime` 接收 Pi AI 的 `Models` interface，不是 provider 名称表或另一任务执行器。未提供 Models 时保持 SDK 默认集合。`beforeRequest` 的后续 handler 看到此前已修改的 model、messages 与 options；options 浅合并，函数形式的 provider callbacks 只用于当前请求。

## 不变量

- Models 仅在当前原生 phase 内选择，不写入检查点／memo；重启先重建同会话资源，再由原生调度恢复。
- generation 的准备、请求、重试、poll、取消及 compaction 使用各自 phase 选择的 Models；同名 provider 不要求跨会话共享实例。
- 模型、工具、任务、回执、用量和压缩仍由原生 Durable 拥有。返回的 Models 只提供该 interface 的目录与 transport 行为。
- `beforeRequest` 不能替换 Durable 的任务 signal 或持久 provider session ID；这两项在请求发出前重新绑定。
- classifier 使用真正发给模型的消息判定提供过的工具，仍只能执行当前原生 agent 已选择、注册的工具。请求变换不授予后端权限。
- request-local model 变更不直接改写会话配置；模型结果按实际 provider／model 记入原生用量。

## 顺序约束

1. `ensureDurableRequests()` 必须在首次创建／恢复 Harness 前等待完成。
2. 每个 phase 使用其原生 extension snapshot，按注册顺序解析 `modelRuntime`；不得在活跃任务中途安装补丁。
3. request 在原生上下文和持久请求身份准备完成后等待 `beforeRequest`，然后仍调用同一 SDK 的 streaming／classification helper。
4. 恢复前必须注册所属会话的 Models resolver；资源未就绪时 resolver 可等待，但必须遵守传入的取消 context。

## 错误模式

- 版本／摘要／检查点契约错误沿用[提交后边界契约](durable-boundaries.md)。原生 SDK 只宣告部分请求能力时 `DeskError(501)`，不盲目改写未知 SDK。
- `modelRuntime` 的异常向原生调度器传播，不能退回另一会话的 Models 发请求。取消不改为普通插件错误。
- `beforeRequest` 的普通 handler 异常继续遵守原生 HookRunner 的报告与后续 dispatch 语义；模型 transport／写入错误由原生任务处理。
- Models 必须满足完整 Pi AI interface；不提供未经声明的方法降级。

## 性能特征

每个 phase 解析一次所选 Models，不增加目录缓存、provider 全局合并或新的持久化写入。没有 resolver 时继续使用原 runtime；有 resolver 时仅代理当前 phase 的 Models 访问。请求 callbacks 不被序列化。

## 可执行证据

`node --test test/durable-request-runtime.test.mjs test/durable-boundaries.test.mjs` 覆盖并发会话同名 provider 隔离、请求 model／options、signal／session 身份、实际用量、原生 compaction、解析失败不退回、原生完整／部分能力选择，以及原有提交后边界回归。

这是 SDK seam 的验收，尚不代表 Pi provider hook 与生命周期的真实 Host 接入已完成。
