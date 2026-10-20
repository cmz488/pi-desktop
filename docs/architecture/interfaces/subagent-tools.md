# 内置子代理管理工具契约

## 位置与职责

- `src/agent/managed-subagents.mjs`：`desk-subagents` Durable 扩展，同时声明后台委托 task 和模型工具 `desk_subagent`。
- `src/agent/agent-workspace.mjs`：配置准入、owned 范围、安全投影与原生操作适配；HTTP 发起与模型发起共用准入，不另建任务存储或执行器。
- `src/agent/durable-resources.mjs`：每个 owned 子会话使用自己的 Pi 资源 scope；Durable 内置工具不会交给资源 Session 执行模型循环。

## 签名

模型工具 `desk_subagent`：

```js
{ action: "spawn", prompt, name?, requestId?, config? }
// config: { model?: {provider,modelId}, thinkingLevel?, instructions?, tools? }
// -> { parentConversationId, taskId }
{ action: "message", taskId, message, mode?: "steer" | "followUp", requestId? }
// -> { taskId, conversationId, submissionId, mode }
{ action: "read", taskId }
// -> { task, children: [{id,messages,messagesTruncated,partial}], hasMoreChildren }
{ action: "list", includeTerminal?: boolean, limit?: number }
// -> { parentConversationId, tasks, truncated }
{ action: "wait", taskId }
// -> { task }：原生终态，不把观察成功解释为执行成功
{ action: "abort", taskId }
// -> { abortStatus: "marked" | "terminal", task }
```

`task` 使用 [Host 任务契约](host-tasks.md) 的安全回执，不暴露任意 task 输入、checkpoint 或任意 result。`taskId` 是当前 worker 的 Durable task 数值 id，不是会话 id；调用会话身份取自原生工具 invocation，模型不能指定另一 Agent、generation 或父会话。

## 不变量

- 工具仅随可写 Desktop worker 的 `desk-subagents` 扩展提供；不是独立 CLI 子代理服务，也不额外创建 Desktop Agent／SQLite／writer。
- 只沿 `owner.conversationId` 管理当前调用会话及其 owned 后代；历史 fork 的 `parent` 不授予权限。非本适配 task 不可作为子代理目标。
- spawn 使用原生 background task，返回后不保持父会话忙碌；模型循环、调度、恢复、等待与中止由 Durable 拥有。
- spawn 重试沿用相同 requestId 和内容；同一 requestId 换内容为冲突。不提供时从原生工具 taskId 派生，恢复不重复创建。
- message 的 requestId 遵守原生 submission 的幂等语义，重试必须沿用同一内容；steer 在原生边界投递，不等于立即打断工具。followUp 在当前运行结束后处理。终态委托不可用 message 复活，需明确创建新委托。
- wait 的取消只撤销观察；abort 回执必须区分 marked 与 terminal，实际终态以原生 task 决定。
- 同一子代理结果的回答绑定 submission 已决定的不可变 answer，不从当前上下文猜最后助手回复。

## 顺序约束

1. 仅在用户要求委派时发起；共享项目目录的并行写入须由调用者隔离。
2. spawn 完成原生持久准入后返回 taskId；后续 message/read/wait/abort 固定该 taskId。
3. message 必须在子会话已创建且委托未终结时发起；尚未就绪应稍后重试，不另建替代会话。
4. 获取工具 invocation 的句柄不能用于其结束后的分离后台回调；后台工作由持久 task 承担。

## 错误模式

- 参数或配置无效由原生工具验证或准入拒绝；不接受 cwd、shellEnv、shellPath、extensions 等资源环境覆盖。
- 每父会话最多 16 个非终态适配 task；超限拒绝，不自建排队器。
- 未知、越界与非子代理目标均返回不存在，不泄漏其他会话任务内容。
- 模型未配置、子会话尚未就绪或委托已终结时明确失败；不会偷偷重启或复活。
- 原生工具错误保留为工具错误结果，不伪装成功 JSON。

## 性能特征

list 默认只列非终态，最多 20 项，可设为 1–50 项；显式 includeTerminal 才包含历史。read 最多查看 20 个直接 owned 子会话、每会话最近 40 个 entry；消息文本每条最多 2000 个 UTF-16 code unit，消息总文本预算 32000，流式片段每会话最多 2000。裁剪字段报告省略内容，不改变原生转录与模型上下文。

## 可执行证据

`test/subagent-tools.test.mjs` 通过真实默认 Host／worker 与本地 provider 让模型实际调用扩展工具，验证注册、后台创建、原生回答读取、steer 与子会话自身原生工具 scope、owned/fork 权限隔离、实时／历史列举、原生等待与中止、配置选择及请求幂等。`test/subagent-tool-fixture.mjs` 只在模型 provider 边界编排工具回合，不调用内部 handler。
