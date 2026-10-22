# Pi 资源会话与 native 桥契约

## 位置与职责

- `src/agent/durable-resources.mjs`：每个受管原生会话（含 owned 子代理）一个 Pi 资源会话宿主（经 `startWebSlot`），把 Pi 的工具、扩展、技能、MCP、交互、包管理与审批能力投影成一个**只读工具来源 + 动作入口**。
- `src/agent/native-runtime.mjs`：把 Durable 的回合镜像成 Pi 会话生命周期事件，并把 Pi 的消息入口委托给当前 Durable Agent。
- `src/server/web.mjs` 的 `startWebSlot(options)`：真正创建 Pi 资源会话的 adapter。

这是 [边界文档](../pi-boundary.md) 的 **seam B（能力 seam）**，也是 [边界规则 R2／R3](../pi-boundary.md) 的执行者。

## 签名

```js
export function createDurableResources({
  agentDir,            // 必需；Pi agent 目录（扩展、技能、MCP 配置所在地）
  onEvent = () => {},  // 可选；资源事件回调
  noExtensions = false,// 可选；不加载用户扩展（受限场景）
  readOnly = false,    // 可选；只读 Agent
  nativeResources = {},// 可选；宿主注入的原生资源实现
  durableTools = [],   // 可选；要暴露的 Durable 工具名
  approvalMode = "yolo", // 可选；必须通过 validateApprovalMode
  providers,           // 可选；模型 provider 注册表
  browser,             // 可选；是否装配 agent_browser 工具
}); // -> resources
```

resources 表面：

```js
resources.attach(workspace)                  // 绑定 workspace；预热顶层及仍需恢复的 owned 资源
resources.ensure(active)                     // async -> facade | undefined；active 为 workspace.read() 的 active
resources.normalizeExtensions(names)         // 过滤掉 desk-native:* 前缀
resources.selectTools(active, { defaults = false, newOnly = false })
                                             // async -> facade；把原生工具名写入会话 agent 文档
resources.reload(active)                     // async -> facade；重载扩展/包后重算默认工具集
resources.close()                            // 停止所有资源宿主，幂等
resources.cancelInteractions()               // 取消所有就绪宿主上的待答交互
resources.canWrite()                         // 所有就绪宿主都允许写入时为 true
resources.interactions.list(scope, owner)     // scope 是受信的 owned ID Set；子交互标注来源
resources.interactions.version(scope)         // 只读已就绪宿主的变更位，不启动历史资源
resources.interactions.reply(scope, input)    // 范围内按交互 ID 路由，再校验 prompt ID
```

facade（`Object.freeze`）：

```js
facade.read(); // { snapshot, commands, canWrite, projectTrusted, effectiveSettings }
facade.describe(catalog); // { tools: [...], extensions: [...] }，按 desk-native: scope 过滤
facade.execute(action, ...args);
```

`facade.execute` 的 action 表：

| action                                                                                                                         | 参数                               | 语义                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------- |
| `approvalMode`                                                                                                                 | `mode`                             | 修改审批模式（经 `validateApprovalMode`）                |
| `expandPrompt`                                                                                                                 | `message, {original?,requestId?}?` | 展开模板／技能；注册命令另保留只展示原文，不额外发起模型 |
| `packageAction`                                                                                                                | `input`                            | 包管理动作（自动带当前 `sessionId`）                     |
| `interactions.list` / `.reply` / `.version`                                                                                    | 同交互存储                         | 读取／回答／探测交互版本                                 |
| `settingsChanged`、`skillInventory`、`mcpRegistered`、`mcpTools`、`mcpAction`、`trustProject`、`packageRoot`、`packageUpdates` | `...args`                          | 转发给宿主 capability                                    |

native 桥：

```js
export function createNativeRuntime({ workspace, id, ready, syncTools, onError });
// -> { record, bind, flush, beforeRequest, afterResponse, afterTools, dispose }
```

## 不变量

- **owned 资源 scope 独立**：发起前绑定子会话自己的工具 scope，恢复时也先于 Harness resume 注册；不会为此创建第二个 worker／SQLite，也不借用父会话工具闭包。`attach` 在 workspace 显式声明 `spawnSubagent` 时注册其 owned preparer；具体契约见 [Host 任务](host-tasks.md)。
- **审批与交互**：默认 Desktop 的审批模式存在 worker 范围的 workspace 文档中，不随历史退回／分叉恢复旧值，owned 子代理继承有效策略；Host 显式启动策略先于恢复应用到 worker，不能被存量子会话覆盖。聚合交互只含当前 owned 范围，子会话条目带 `sourceConversationId` 和名称；历史 fork 无权代答。
- **资源回收**：委托终态且子会话工作已结束后，先完成原生结束事件及状态写回，再释放宿主和其工具 scope。若结束事件产生新工作则暂不释放；重启只预热活跃／待恢复 owned 会话，历史详情不装载 SDK 资源。异步维护失败通过通知保留错误上下文，不静默吞掉。
- **输入来源**：宿主在展开前捕获用户原文；原生程序发送标注为 automatic，注册命令的只展示记录与模型贡献分开。可靠关联、继承与兼容回退见[输入展示契约](input-presentation.md)。
- **资源会话不跑模型循环**：它只提供工具与交互；所有被接受的模型回合都由 Durable 拥有（源码注释：`The resource Session never runs a second model loop`）。
- **事件方向单向**：Durable 提交 → `record`／`beforeRequest`／`afterResponse`／`afterTools` → Pi 生命周期事件（`message_start`／`message_end`／`turn_end`／`tool_execution_end` 等）；Pi 事件不得反向驱动 Durable 状态。
- **`ensure(active)` 幂等且按会话缓存**：同一 `active.id` 在资源存活期间复用 facade；目录变化或资源已回收后，显式调用可按需重新创建。
- **`attach(workspace)` 先于任何 `ensure`**：没有 workspace 时无法读取 agent 文档，`ensure` 也不会得到完整 facade。
- **扩展名过滤**：写入会话文档的扩展名必须经 `normalizeExtensions`，`desk-native:*` 只保留当前 scope，避免跨 Agent 串用。
- **只读不改变形状**：`readOnly` 只影响工具选择（排除 `read`／`write`／`edit`／`bash` 的原生重装）与写入权限，不改变 facade 表面。
- **`canWrite()` 是聚合判断**：任一就绪宿主不允许写入即返回 `false`。

## 顺序约束

1. `attach(workspace)` → `ensure(active)`。
2. 新建或切换会话后调用 `selectTools(active, { defaults: true })`；只在需要补齐新工具时用 `newOnly: true`（它会在扩展缺失时提前返回）。
3. `reload(active)` 之后必须重新 `selectTools(..., { defaults: true, newOnly: true })`，否则新加载的工具不会进入会话 agent 文档。
4. `close()` 在 worker 停止路径上调用；之后任何 `ensure` 调用都不再返回宿主。
5. `nativeRuntime.bind(session)` 必须在 Pi 会话创建之后、首次 `beforeRequest` 之前调用（`bind` 会接管 `sendUserMessage`／`sendCustomMessage` 并包装 `createContext`）。

## 错误模式

| 条件                                                                 | 结果                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `approvalMode` 非法                                                  | `validateApprovalMode` 抛出 `DeskError`                                               |
| `expandPrompt` 给的 `/命令` 既不是命令、也不是模板、也不是已加载技能 | `DeskError(422, "未知 Pi 命令")`；技能名存在但未加载 → `DeskError(422, "技能未加载")` |
| `interactions.<method>` 不在 `list`／`reply`／`version` 内           | `DeskError(404, "资源交互操作无效")`                                                  |
| action 不在允许集合内                                                | `DeskError(404, "原生资源操作无效")`                                                  |
| 宿主 capability 缺失（例如 `mcpAction` 未声明）                      | `capabilities[action]?.(...)` 返回 `undefined`；调用方按 capability 声明处理          |

## 性能特征

- **每 Agent 一个资源宿主**，宿主创建包含 Pi 会话与扩展装载，成本高，因此按 `active.id` 缓存，终态 owned 宿主及时释放，`close()` 释放剩余宿主。
- `selectTools` 每次调用都会写一次会话 agent 文档（`configure`），属写路径；不要在热路径反复调用。
- `cancelInteractions()` 只遍历就绪宿主，未就绪宿主不产生成本。
- 资源宿主是 SDK 唯一需要完整命名空间的地方；启动关键路径不得等待它（见 [pi-sdk 适配层](pi-sdk-adapter.md)）。

## 可执行证据

- `test/durable-features.test.mjs`：工具可用性、权限门控、ask_user／MCP 交互、启动对话框与 `agent_browser` 注册。
- `test/subagent-reliability.test.mjs`：审批继承、停机权限变更、owned 交互、终态释放与历史不预热；浏览器工作台回归覆盖父界面批准／拒绝。
- `test/pi-permissions.test.mjs`：审批模式与权限钩子。
- `test/agent-browser.test.mjs`：`agent_browser` 工具经资源会话可用。
- `test/pi-sdk-lazy.test.mjs`：导入 worker 模块图不会加载 SDK 命名空间（资源会话按需创建）。
- 接口形状断言：`test/boundary-contracts.test.mjs` —— 重命名或删除本页列出的键、命令或深路径时该测试失败。
