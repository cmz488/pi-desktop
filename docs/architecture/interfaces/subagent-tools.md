# 内置子代理管理工具契约

## 位置与职责

- `src/agent/managed-subagents.mjs`：`desk-subagents` Durable 扩展，同时声明后台委托／消息投递 task 和模型工具 `desk_subagent`。
- `src/agent/agent-workspace.mjs`：配置准入、owned 范围、安全投影与原生操作适配；HTTP 发起与模型发起共用准入，不另建任务存储或执行器。
- `src/agent/durable-resources.mjs`：每个 owned 子会话使用自己的 Pi 资源 scope；Durable 内置工具不会交给资源 Session 执行模型循环。

## 签名

模型工具 `desk_subagent`：

```js
{ action: "spawn", prompt, name?, requestId?, config? }
// config: { model?: {provider,modelId}, thinkingLevel?, instructions?, tools?, maxTurns? }
// -> { parentConversationId, taskId }
{ action: "message", taskId, message, mode?: "steer" | "followUp", requestId? }
// -> { taskId, conversationId, submissionId, mode }
{ action: "read", taskId }
// -> { task, children: [{id,messages,messagesTruncated,partial}], hasMoreChildren }
{ action: "result", taskId, offset?: number, length?: number }
// -> {taskId,answerEntryId,offset,text,totalUnits,nextOffset:number|null}
{ action: "list", includeTerminal?: boolean, limit?: number, before?: number }
// -> { parentConversationId, tasks, truncated, nextBefore:number|null }
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
- message 的 requestId 固定同一内容与模式，同 ID 换内容为冲突。已接受的消息在终态／重启后仍可取回原回执；新消息不能复活终态委托。投递作为原生 owned task 持久准入，取消调用者的等待不撤销已准入投递，显式中止委托仍级联中止投递。steer 在原生工具轮次边界投递，followUp 在当前运行结束后处理。旧版已投递消息沿原生 submission 去重，不能补写或重放工作。
- wait 的取消只撤销观察；abort 回执必须区分 marked 与 terminal，实际终态以原生 task 决定。
- 同一子代理结果的回答绑定 submission 已决定的不可变 answer，不从当前上下文猜最后助手回复。新回执同时返回 `answerUnits` 与 `answerTruncated`，完整回答使用 result 分段读取；旧回执没有编号时只沿原始 submission 查找。
- 子代理继承父会话当前有效的审批策略；默认 Host 的策略是 worker 范围的当前值，既有历史分支与旧位置的新分叉都不能恢复旧权限，其他 worker 不受影响。owned 后代的交互通过父会话原有交互 UI 展示，注明子会话来源；回答仍校验当前 owned 范围与原生 prompt ID。历史 fork 无权读取或回答源会话的交互。

## 顺序约束

1. 仅在用户要求委派时发起；共享项目目录的并行写入须由调用者隔离。
2. spawn 完成原生持久准入后返回 taskId；后续 message/read/result/wait/abort 固定该 taskId。
3. 新 message 必须在子会话已创建且委托未终结时发起；尚未就绪应稍后重试，不另建替代会话。
4. 获取工具 invocation 的句柄不能用于其结束后的分离后台回调；后台工作由持久 task 承担。

## 错误模式

- 参数或配置无效由原生工具验证或准入拒绝；不接受 cwd、shellEnv、shellPath、extensions 等资源环境覆盖。
- 每棵顶层会话的 owned 委托树最多 16 个非终态适配 task，最多嵌套 3 层；子会话不能绕过配额。先查同请求的既有回执，再检查新增配额；超限拒绝，不自建排队器。
- `config.maxTurns` 为 1–256 的整数，默认每个子会话累计 64 个模型回合。压缩和重启不重置已提交的回合（含中断产生的助手记录）；耗尽时在下一模型请求前走原生中止，委托返回带原因的 failed 回执。这是回合上限，不是 token／金额上限。
- 未知、越界与非子代理目标均返回不存在，不泄漏其他会话任务内容。
- 模型未配置、子会话尚未就绪或委托已终结时明确失败；不会偷偷重启或复活。
- 原生工具错误保留为工具错误结果，不伪装成功 JSON。
- JSON 回执超过 1 MiB 时明确报错「子代理结果过大，请缩小列表或在工作台查看记录」，不交给通用文本裁剪输出半截 JSON。可降低 list.limit 后重试。

## 性能特征

list 默认只列非终态，最多 20 项，可设为 1–50 项；显式 includeTerminal 才包含历史；将 `nextBefore` 传回 `before` 可继续读取更早记录。分页约束响应数量，查询仍扫描原生任务历史。result 默认从 offset=0 读取 12000 个 UTF-16 code unit，length 为 1–32000；nextOffset 为 null 表示读完，范围无效明确拒绝，尚未决定原生回答时明确拒绝读取。read 最多查看 20 个直接 owned 子会话、每会话最近 40 个 entry；消息文本每条最多 2000 个 UTF-16 code unit，消息总文本预算 32000，流式片段每会话最多 2000。裁剪字段同时报告单条裁剪和总预算省略，耗尽预算后不返回伪造的空文本消息；不改变原生转录与模型上下文。结构化回执通过公开 `ToolRegistration.outputLimits` 设置 1 MiB 原生传输上限，返回前检查完整 JSON 的 UTF-8 大小；这不是修改消息预算或关闭原生输出保护。

## 可执行证据

`test/subagent-tools.test.mjs` 通过真实默认 Host／worker 与本地 provider 让模型实际调用扩展工具，验证注册、后台创建、原生回答读取、steer／followUp 的原生轮次边界与不可变回答、子会话自身原生工具 scope、owned/fork 权限隔离、实时／历史列举、原生等待与中止、父回合取消等待不误中止后台委托、配置选择及请求幂等；另覆盖单条／总预算裁剪、中文长 JSON 不被通用裁剪破坏，以及大列表超限后缩小范围可读。`test/subagent-tool-fixture.mjs` 只在模型 provider 边界编排工具回合，不调用内部 handler。

`test/subagent-reliability.test.mjs` 覆盖继承审批、停机权限变更、父界面可见的子交互及 fork 拒绝、终态资源回收、历史不预热、回合预算跨重启不重置、整树并发与嵌套限制。消息终态重试与完整回答分页由 `test/subagent-tools.test.mjs` 的真实模型调用验证。
