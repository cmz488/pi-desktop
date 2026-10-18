# 分支树读模型契约（sessionTree）

## 位置与职责

- `src/agent/agent-workspace.mjs`：分叉时把来源写进会话文档（`forkOf`），`read()` 的会话摘要带出该字段。
- `src/session/pi-session-storage.mjs` 的 `tree()`：把 Pi 原生会话树投影成只读结构（父子、活跃路径、leaf、分支点）。
- `src/server/durable-server.mjs` 的 `sessionTree` 宿主实现 + `src/server/bridge.mjs` 的 `GET /api/tree`：把两者合成一个只读读模型。

读模型只描述结构；**创建分支与退回仍然走 `POST /api/command`**（`fork`／`rewind`），这里不做任何写入。

## 签名

```
GET /api/tree?id=<agentId>        // 也接受 sessionId；省略时用当前选中的 Agent
Host capability: sessionTree      // 未声明时返回 { supported: false }（HTTP 200）
```

返回（`supported: true` 时）：

```js
{
  sessionId,   // 本会话在 Durable 侧的 id（就是会话栏里的会话 id，字符串）
  name,
  forkOf,      // { conversationId, entryId } | null
  leaf,        // 原生 leaf 的条目 id，无原生转录时为 null
  native,      // { leafId, nodes: [...] } | null
  rewinds: [{ entryId, rewindTo }],
  branches: [{ id, name, forkOf, idle }],
}
```

`native.nodes[]` 每项：

```js
{
  (id,
    parentId,
    type,
    role,
    customType,
    label,
    rewindTo,
    active,
    leaf,
    branchPoint,
    children);
}
```

## 不变量

- **只读**：不改变任何会话状态；`/api/state`、`/api/events`、`/api/command` 的既有字段与语义不变（本任务只新增端点，`read()` 的 `agents[]` 追加 `forkOf`）。
- **每个分支都是独立会话**：`branches[].id` 就是会话栏里的会话 id；`forkOf` 来自会话文档，重启后仍可读，不依赖原生文件。
- **原生树按需可信**：`native` 只在宿主绑定的原生转录**属于该会话**时返回（默认多进程 Desktop 每个 Agent 一个 worker，因此都有）；否则为 `null`，此时 `leaf` 也为 `null`，界面只显示 Durable 侧信息。
- **活跃/放弃由 `active` 表达**：`active === true` 的节点在活跃路径上（leaf 必然在其中）；其余节点是被放弃的路径，仍保留在树里。
- **分支点**：`branchPoint` 表示该节点有多个子条目（退回会制造一个）。

## 顺序约束

1. 客户端先完成 `POST /api/command`（`fork`／`rewind`），再刷新本接口；本接口不触发写入，也不等待任务。
2. 宿主实现内部顺序：`workspace.read()`（刷新会话清单）→ `workspace.agent(id)`（404 表示会话不存在）→ 原生 `tree()`（仅当绑定到该会话）→ `workspace.transcript(id)`（取退回标记）。
3. 未声明能力的宿主必须在任何会话读取之前返回 `supported: false`，客户端据此隐藏分支树入口。

## 错误模式

| 条件                            | 结果                               |
| ------------------------------- | ---------------------------------- |
| 宿主未声明 `sessionTree`        | `{ supported: false }`（HTTP 200） |
| `id` 指向不存在的会话           | `DeskError(404, "Agent 不存在")`   |
| 既没有 `id`，宿主也没有任何会话 | `DeskError(422, "请选择 Agent")`   |
| `id` 不是数字                   | 解析为 `NaN` → 会话不存在（404）   |

## 性能特征

- 每次调用读一次 `workspace.read()`（全量摘要）与一次 `transcript(id)` 条目扫描；原生树来自内存中的 SessionManager，不读盘。
- 不是轮询端点：界面在 `state_changed` 或切换会话后按需拉取。
- 分支数量与原生条目数量线性相关；被放弃的路径同样会被列出（这是它的用途）。

## 可执行证据

- `test/durable-session-tree.test.mjs`：原生 parent 链与 leaf、分支点、被放弃路径不在活跃路径上、`rewinds` 记录退回目标、`branches` 列出全部分支且 `forkOf` 指向同一来源、无原生转录的会话返回 `native: null`。
- `test/bridge.test.mjs`：未声明能力的宿主返回 `supported: false`；声明后按 `id` 传参且只调用一次。
- `test/boundary-contracts.test.mjs`：Host capability 集包含 `sessionTree`（39 个键）。
