# Durable 已提交生成边界接口

## 位置与职责

Pi 的 `turn_end` 需要已记录的消息 ID，而 `continue` 必须在原 run 结束前裁决。当前 `@earendil-works/pi-durable@1.0.2` 的 `onYield` 在助手 entry 提交之前运行；提交后另行 `submit()` 则会留下已经结束的首次答案，不能冒充原生边界。

用户已明确选择：当前先给 Durable 打补丁，后续 SDK 提供同一接口时自动采用原生实现。这里是这个兼容 seam，不是第二套模型循环或扩展执行器。

## 签名与顺序约束

```js
await ensureDurableBoundaries();
// -> { apiVersion: 1, implementation: "native" | "patch" }
```

位置：`src/agent/durable-boundaries.mjs`；调用者必须在进程内首次创建／恢复 Harness 前等待完成，不能在活跃任务中途安装。`openAgentWorkspace()` 已在打开时装配。进程内幂等，同一 Promise 不会重复安装。

选择顺序：

1. SDK 的 `GenerationTask.definition.capabilities.committedBoundary === 1`，且 generation version 至少为 2、提供 migration：直接使用原生实现，不变换源码、不覆盖其 phase。
2. 否则仅对已核实的 **1.0.2** 和 `generation.js` 摘要应用仓库随包交付的补丁。
3. 其他版本／不同内容明确报 `DeskError(501)`，不猜测接口，不下载或升级依赖，不改 `node_modules`。

“自动采用”依赖 SDK 宣告并实现下述 **同一 v1 契约**，不是假定任意未来版本都兼容。升级后仍须运行本页的语义测试，不能只以 capability 字段存在代替验证。此字段是本次补丁提出的接口契约，不声称当前官方 SDK 已提供。

## Hook interface（v1）

仍通过原生 `hook(GenerationTask, hooks)` 注册，按所选 extension／phase snapshot 调用；没有新任务种类。

```ts
interface CommittedBoundaryEvent {
  assistant: EntryId;
  results: readonly EntryId[];
  outcome: "completed" | "error" | "aborted";
  automatic: boolean;
}
interface CommittedBoundaryResult {
  entries?: readonly EntryDraft[];
  continue?: boolean;
}
// 所有回调均可异步；api 与 context 沿用原生 HookApi／Chord Context。
afterTurn(event, api, context): CommittedBoundaryResult | undefined;
beforeSettle(event, api, context): CommittedBoundaryResult | undefined;
afterPartial(message, api, context): void;
```

- `afterTurn`：普通回答已提交；工具回合则在助手和全批工具结果提交后运行。`assistant`、`results` 可通过原生已提交读取 interface 解析，不使用预分配或猜测的 ID。
- `beforeSettle`：没有自动工具后继、重试、恢复或选中的排队输入时，在结束原 run 前等待决策。工具终止候选也经过该边界；用户取消不能被迟到 `continue` 重新启动。
- `afterPartial`：节流后的 partial 已提交才调用；stream 收尾会等待在途回调，返回值不修改消息。它不承诺保留每个 provider token 的原始粒度。
- `automatic`：已有工具后继、重试／恢复或旧 `onYield` continuation 将继续，不代表新建了另一执行循环。
- `entries`：原生 Durable entry draft，在决策提交中追加。当前会话作用域、entry／edit 验证继续由原生 Tx 执行；边界不授予跨会话写入权限。
- `continue:true`：调用方须给出可运行的上下文。没有选中排队输入／reset 时，交给原生下一 generation，**原 submission 保持未结束**，最终答案才归入首次回执；不伪造用户消息。`afterTurn` 不能覆盖工具的 `terminate`；该终止候选仍交给 `beforeSettle` 单独裁决。
- 旧 `onYield` 的字符串 continuation、队列优先级、reset／handoff、工具控制及模型重试／压缩仍沿用原生裁决。选中的排队输入不因新 hook 被吞掉；已经结束的首次答案不会被后续 submission 改写。
- handler 的普通异常仍由原生 HookRunner 报告；取消沿原生 signal／abort 传播。`entries` 的提交错误不会被当作成功。

## 检查点与恢复

补丁只扩展唯一内建 `pi.generation`，definition version 从 1 变为 **2**，保留原有 prepare／request／retry／poll／tools phase 与模型／工具 helper。v1 检查点采用原生 migration 进入 v2，不重建任务或队列。

新增 `committedBoundary` phase：记录已提交 assistant／结果 ID、turn／settle 步骤和分发标记。实际有该步骤的 handler 时，进入前先提交 `dispatched:true`；空 hook 不写入此标记，其检查点可以正常恢复。进程或宿主在已分发 handler 期间中断，恢复时不能判断副作用是否执行过，因此**明确失败并要求显式继续，不重新调用 handler 或模型**。不宣称通用扩展副作用具有 exactly-once 契约。

未来 SDK 宣告 v1 能力时，也必须能接管此 v2 检查点／migration 契约，才可以无损恢复已有任务。未宣告能力的新版不会被当前补丁无条件改写。

## 不变量

原 `GenerationTask` token／definition 的身份保留，registry 内仍只有唯一 `pi.generation`。模型请求、工具、重试、压缩、用量与调度仍由同一 SDK 承担；没有新增 Harness、worker、SQLite writer 或自定义任务执行器。补丁不是权限入口，也不进入浏览器资产或执行插件浏览器代码。

## 版本与交付边界

来源：npm `@earendil-works/pi-durable@1.0.2`，`gitHead` 为 `cd32f7725fdbddbaecdff5b1e68491563394e0ca`；实际发布文件摘要：

```text
76e00ccac9f54fd61d0bffc1bfb8adb97ad462b428874a5100928f82e7ff1c94
```

npm 元数据与固定提交的 MIT 许可已核对；版权和许可保留在 `NOTICE`／`licenses/pi-durable-MIT.txt`。

## 错误模式

- 未宣告接口的未知 SDK 版本、已知版本摘要不匹配、原生声明缺少 migration：`DeskError(501)`，不继续初始化模型执行。
- 变换锚点不唯一／不存在：抛错，不猜测源码位置。其他文件系统／模块加载错误原样传播。
- 边界 callback 中断后的恢复：原生 task／submission 明确失败，不重放未知副作用；不会把失败回执改成成功。
- handler 的异常／取消与 entry 提交错误：遵循上文和原生 HookRunner／Tx 语义。

## 性能特征

兼容安装每进程一次，已知版本会读取并编译生成模块；后续复用同一 Promise。实际有新边界 hook 时增加持久化边界 phase／分发标记提交；没有新 hook 的路径保留原生决策。partial 继续使用原生节流，不改为每 token 写盘。不得为省去这些等待而把决策 hook 改成广播。

## 可执行证据

`node --test test/durable-boundaries.test.mjs` 验证：

- 已提交 ID、同一 submission 内 continuation、不制造用户输入、首次答案不变。
- turn／settle 顺序，工具结果和 terminate 候选；`afterTurn` 不绕过工具终止；原 `onYield` 与排队输入优先级。
- 取消期间迟到的 continuation 不产生模型后继；原生重试及 message 分类修改不重复回调。
- v1 migration；真实 SQLite 已进入边界检查点的关闭／恢复不重放未知副作用；未注册 turn／settle hook 时的中断恢复不会误判副作用。
- 安装前后依赖文件摘要不变；不匹配内容明确拒绝；模拟原生 capability 时跳过补丁。最后一项只证明选择分支，真实新版的完整语义仍需本套测试。

本页交付的是 SDK seam。Pi 生命周期消费这些返回值的完整集成及 UI 回退仍须阶段 07／08 验收，不能只以补丁测试通过完成整体目标。
