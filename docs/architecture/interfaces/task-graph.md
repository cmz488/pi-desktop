# 任务图与子会话读模型契约（tasks）

## 位置与职责

- `src/agent/agent-workspace.mjs`：`read()` 返回 `tasks`（任务图投影：所有权、等待关系、后台标记）、`children`（被任务拥有的子会话）与 `live`（会话视图，用于取在跑工具）。
- `src/server/durable-server.mjs` 的 `tasks` 宿主实现 + `src/server/bridge.mjs` 的 `GET /api/tasks`：把两者合成一个只读读模型。
- `src/shared/conversation-scope.mjs`：`ownedConversationIds(id, records) -> Set<number>`，统一读模型与命令的会话归属范围；输入是已经验证的会话 id 和 Durable 会话记录，不访问或修改任务状态。

读模型只描述状态；**取消、等待等操作走 `/api/command`**（见下），这里不做任何写入。

## 签名

```
GET /api/tasks?id=<agentId>     // 也接受 sessionId；省略时用当前选中的 Agent
Host capability: tasks          // 未声明时返回 { supported: false }（HTTP 200）
```

返回（`supported: true` 时）：

```js
{
  sessionId,     // 请求的会话 id（字符串）
  tasks: [{
    id,            // 任务 id（不透明值，比较时按字符串归一）
    conversationId,
    kind,          // pi.generation / pi.tool / 扩展任务
    status,        // pending / running / waiting / completing
    background,    // 后台任务：不阻塞它所属的会话
    owner,         // 拥有它的任务 id；由会话自己拥有时为 null
    waitingOn,     // 正在等待的任务 id 列表
  }],
  conversations: [{ id, name, parent, owner: { conversationId, taskId }, idle }],
  tools: [{ conversationId, callId, name, status }],
}
```

## 不变量

- **只读**：不改变任何会话或任务状态；新增端点与字段，既有端点语义不变。
- **范围属于请求会话**：只包含请求会话及沿 `owner.conversationId` 递归拥有的后代；历史分叉的 `parent` 不产生任务管理权，其他顶层会话或独立分支不可混入。读模型与管理命令使用同一规则。
- **任务图只列活着的任务**：任务随创建它的提交出现、随进入终态离开；没有实时任务时 `tasks` 为空数组。会话空闲时仍可能有后台任务；**子会话仍然可见**（子会话是会话记录，不是任务）。
- **`owner` 是任务 id，不是对象**：`null` 表示该任务由它自己的会话拥有（`pi.generation` 通常如此）；扩展派生的任务（`pi.tool`、子代理任务）指向创建它的任务。
- **子会话 = 被任务拥有的会话**：`conversations[].owner { conversationId, taskId }` 指向创建它的任务与会话；`parent` 是历史分叉来源（与分支树同一份记录）。
- **在跑工具按需取**：`tools` 只为**范围内当前有实时任务**的会话读一次轻量会话视图（包括 owned 子会话），`status !== "done"` 的工具才列出；没有任务的会话不产生这次读取。轻量视图支持子会话不表示它获得独立 Agent 的写命令入口。
- 会话 id 与任务 id 都是不透明值，界面不得假设它们的表示形式。

## 顺序约束

1. 宿主实现顺序：`workspace.read()`（刷新任务图与子会话）→ 校验请求会话并计算其 owned 范围 → 对范围内每个有实时任务的会话读一次 `workspace.live()`（取在跑工具）。
2. 操作顺序（取消／等待）由命令端点负责：先 `POST /api/command`，再刷新本接口；本接口不等待任务结束。
3. 未声明能力的宿主必须在任何读取之前返回 `supported: false`。

## 错误模式

| 条件                          | 结果                               |
| ----------------------------- | ---------------------------------- |
| 宿主未声明 `tasks`            | `{ supported: false }`（HTTP 200） |
| 没有 `id`，宿主也没有任何会话 | `DeskError(422, "请选择 Agent")`   |
| `id` 不是非负安全整数         | `DeskError(422, "Agent ID 无效")`  |
| `id` 不存在                   | `DeskError(404, "Agent 不存在")`   |

## 管理操作（命令语义）

任务管理走 `POST /api/command`，与分支操作共用同一条命令路径：

| 命令     | 输入                       | 语义                                                                                       |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `wait`   | `{ id }`                   | 等该会话空闲（只观察，不改任务）                                                           |
| `wait`   | `{ id, taskId }`           | 等指定任务结束；任务不存在返回 `DeskError(404)`                                            |
| `cancel` | `{ id, taskId }`           | 中止单个任务；Durable 会等被中止的任务结算，因此调用方应预期它在被中止的工作真正放开后返回 |
| `cancel` | `{ id, background: true }` | 只中止任务图里带 `background` 标记的任务，**不等前台工作**；返回值列出被中止的任务 id      |
| `cancel` | `{ id }`                   | 中止该会话当前的工作，等它空闲                                                             |

- 指定 `taskId` 的等待与取消先校验它所属的会话是否在请求范围内；未知或越界任务统一返回 `DeskError(404, "任务不存在")`，不泄露其他会话的任务信息。非负安全整数以外的任务 id 返回 `DeskError(422, "任务 id 无效")`。
- 后台取消只处理范围内带后台标记的任务，返回实际中止的任务 id；空范围立即返回空数组，不能中止其他会话或独立分支。

权限与裁剪规则：

- **只读宿主**：`wait`／`cancel` 是写操作，返回 `DeskError(403, "只读会话不提供任务管理操作")`；其他命令（发送、中止、压缩、配置）不受影响。
- **远程客户端**：取消或等待**自己的**任务属于允许的远程动作（与“远程不允许改配置”的裁剪规则一致），不作为禁止项；远程的路径裁剪仍照常生效。
- **界面确认**：面板里的取消动作需要两步确认（第一次点击进入待确认状态，第二次才发出命令），等待不需要确认。
- **后台任务**：`background: true` 的任务是会话拥有的任务，被排除在普通空闲等待与会话中止之外（会话可以在它运行时保持空闲）；面板顶部的「取消后台任务」按钮只在存在后台任务时出现，同样需要两步确认。夹具 `test/background-fixture.mjs` 用 `tx.createTask(..., { background: true })` 造出真实后台任务，API 测试与浏览器回归都基于它。

## 性能特征

- 除公共请求上下文读取外，宿主实现再调用一次 `workspace.read()`（含会话记录扫描与子会话的文档读取），校验请求会话后，按记录数线性计算 owned 范围；每个范围内有实时任务的会话读一次轻量视图。owned 子会话的视图可能额外扫描记录以验证它仍存在；工具列表不会为每个历史会话读取转录。
- 不是轮询端点：界面在 `state_changed` 或打开面板时拉取。

## 可执行证据

- `test/durable-task-scope.test.mjs`：两个独立会话各有两层 owned 后代及真实后台任务；验证只显示本家族的任务/工具/子会话、单任务与后台取消的归属、越界与无效 id 的拒绝、等待 owned 后代的终态、远程与只读门控、请求目标 409，以及历史分叉不产生任务所有权。
- `test/durable-task-graph.test.mjs`：真实的子代理夹具（任务拥有的子会话）——断言空闲会话任务图为空而子会话仍在、子会话的 `owner` 边、挂起工具出现在 `tools`、`pi.tool` 的 `owner` 指向它的 `pi.generation`、`waitingOn` 关系与 `background` 标记。
- `test/boundary-contracts.test.mjs`：Host capability 集包含 `tasks`（40 个键）。
- `test/bridge.test.mjs`：能力未声明时的回退形状（与 `/api/tree` 同一模式）。
- 真实后台任务：同一测试断言后台任务在会话空闲时仍存活（`background: true`、`owner: null`），`cancel { background: true }` 返回它取消的任务 id 并让它离开任务图；`test/durable-browser-check.mjs` 在面板上造出同一个后台任务，断言「后台」标记与「取消后台任务」按钮的两步确认，随后任务图清空。
- 管理操作：同一测试断言按任务 id 取消后任务图清空且子会话不产生孤儿、`wait` 在回答提交后才返回、`wait` 未知任务返回 404、只读宿主对 `cancel` 返回 403、后台取消不打断前台运行。
