# 分支树读模型契约（sessionTree）

## 位置与职责

- `src/agent/agent-workspace.mjs`：`read()` 的会话摘要带出 Durable 会话记录的 `parent`（`{ conversationId, at }`）作为分叉来源，不在会话文档里另存副本。
- `src/session/pi-session-storage.mjs` 的 `tree()`：把 Pi 原生会话树投影成只读结构（父子、活跃路径、leaf、分支点）。
- `src/server/durable-server.mjs` 的 `sessionTree` 宿主实现 + `src/server/bridge.mjs` 的 `GET /api/tree`：把两者合成一个只读读模型。

读模型只描述结构；**创建分支与退回仍然走 `POST /api/command`**（`fork`／`rewind`），这里不做任何写入。

## 签名

```
GET /api/tree?id=<conversationId> // 也接受 sessionId；省略时用当前选中的 Agent
Host capability: sessionTree      // 未声明时返回 { supported: false }（HTTP 200）
```

默认 Desktop 的外层路由为 `/agents/<desktopAgentId>/api/tree`；查询参数是该 worker 内的数值会话 id，不是外层 Agent UUID。

返回（`supported: true` 时）：

```js
{
  sessionId,   // 本会话在 Durable 侧的 id（就是会话栏里的会话 id，字符串）
  name,
  currentEntryId, // number | null：当前活跃上下文最后一条有 Durable 映射的消息
  idle,          // boolean：该会话是否空闲；不等于整个 worker 会话族空闲
  forkOf,      // { conversationId, entryId } | null
  leaf,        // 原生 leaf 的条目 id，无原生转录时为 null
  native,      // { leafId, nodes: [...] } | null
  rewinds: [{ entryId, rewindTo }], // entryId: number（Durable 标记）；rewindTo: number | null（目标）
  branches: [{ id, name, forkOf, idle }],
}
```

`native.nodes[]` 每项：

```js
{
  id,           // string：Pi 原生条目 id
  parentId,     // string | null：Pi 原生父条目 id
  type,
  role,
  customType,
  label,
  preview,      // string | null：合并文本段后的预览，最多 80 个 UTF-16 代码单元
  entryId,      // number | null：对应的 Durable entry id，未映射时为 null
  rewindTo,     // number | null：Desktop 退回标记的 Durable 目标；没有该数据为 null
  active,       // 是否在当前活跃路径上
  leaf,         // 是否是当前叶子
  branchPoint,  // 是否有多个子节点
  children,     // 子节点数量
}
```

## 不变量

- **只读**：不改变任何会话状态；`/api/state`、`/api/events`、`/api/command` 的既有字段与语义不变；`read()` 的会话 `parent` 在本接口映射为 `forkOf`。
- **每个分支都是独立会话**：`branches[].id` 就是会话栏里的会话 id；`forkOf` 来自 Durable 的会话记录 `parent`，重启后仍可读，不依赖原生文件。
- **原生树按需可信**：`native` 只在宿主绑定的原生转录**属于该会话**时返回（默认 worker 的根与历史分支各自绑定转录）；否则为 `null`，此时 `leaf` 也为 `null`，界面只显示 Durable 侧信息。未启用会话族的单进程／注入 workspace 模式仍只绑定最初的会话。
- **活跃/放弃由 `active` 表达**：`active === true` 的节点在活跃路径上（leaf 必然在其中）；其余节点是被放弃的路径，仍保留在树里。
- **两类条目身份不可混用**：`native.nodes[].id`／`parentId`／`leafId` 是原生字符串 id；节点 `entryId`、退回 `rewindTo` 和 `rewinds[].entryId` 是 Durable 数值 id。未建立 Durable 映射时 `entryId` 为 null，不能拿原生 id 发命令。`preview` 是展示文本，不是节点身份；空文本和非消息节点返回 null。
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
| `id` 不是非负安全整数           | `DeskError(422, "Agent ID 无效")`  |

## 会话清单与命令模式

会话栏与分支树面板共用两份宿主读模型：

- `GET /api/sessions`（capability `sessions`）的每行：`{ id, name, cwd, running, native }`。`native` 表示该会话已绑定原生 Pi 记录，界面据此启用／禁用「退回分支」；`id` 就是 Durable 侧的会话 id。
- 会话相关的命令都走 `POST /api/command`，并允许界面只给模式、由宿主解析目标：
  - `fork`：`{ id, mode: "tail", expectedEntryId? }` = 按当前活跃上下文的最后一条消息分叉（会话栏「创建分支」）。可选 `expectedEntryId` 是界面捕获的位置；类型无效返回 422，当前位置已变化返回 409。资源状态卡片没有 Durable entry，不参与位置选择。保留精确 `entryId` 的原生 asOf 适配，不改变 SDK 的底层分叉能力。
  - `rewind`：`{ id, mode: "last-user" }` = 退回最后一条用户消息（会话栏「退回分支」）；也接受精确的 `entryId`。
    目标解析始终取**活跃上下文**里的消息，因此被放弃的路径不会被选中；没有可用的目标时返回 `DeskError(422)`。

## 界面使用方式（扩展工作台内置页）

- 面板是**只读读模型的视图**：数据来自本接口，创建分支与退回通过 `POST /api/command` 完成，与会话栏、消息菜单同一条命令路径。
- 使用 SVG 展示对话轮次，而非逐条原生日志：一次用户提问、后续思考／工具调用与最终答复聚合成一个节点。`round-tree-view.js` 只做展示聚合，不改变 SDK 的 parent／leaf 或模型上下文。
- 默认显示最近 10 轮，面板可设为 1–200 轮并保存在当前浏览器偏好中；这是显示与选择窗口，不删除原始记录，也不缩短模型上下文。退回较早位置时，窗口仍包含当前位置。
- 固定宽度节点与有界分支轨道避免按原生日志深度无限右移；历史路径用虚线与文字区分，不只依赖颜色。支持键盘选择、折叠／展开与选择详情。
- **只有当前位置显示创建分支入口**；历史节点只显示退回，退回目标为所选轮次最后的已提交消息。退回后可从新的当前位置创建分支。消息右键菜单同样禁用历史分叉；当前位置动作携带检查点，过期时不悄悄创建历史分支。只读时禁用管理，忙碌时禁用退回；当前位置分支沿用 Durable 的快照分叉，不停止源会话。
- 折叠、选择与目标保存在面板模块而非 DOM，同一身份补刷保留滚动和阅读状态；读取按 1.5 秒节流并合并补刷。
- 从会话栏进入可查看另一个会话，面板明确目标并提供「跟随当前会话」。未建立 Durable 映射时仅展示，不把原生字符串 id 当命令目标。

## 默认 worker 的会话族

一个 Desktop Agent 继续独占一个 worker 和 SQLite。`singleAgent: true` 表示禁止在 worker 内任意新建 Desktop Agent，不再禁止其已有会话的历史分叉。每个分支仍使用 Durable 原生 `fork`、`parent` 与独立 usage；分支不会创建第二个 writer。

`src/session/native-transcript-family.mjs` 的接口：

- `openNativeTranscriptFamily({ workspace, agentDir, directory, owner, agents, branches, resumePath?, pathHint? })` 返回 `sync(agents?)`、`get(id)`、`check()`、幂等 `close()` 与根 `metadata`。根元数据兼容原来的 `path`／`nativeSessionId`／`digest`，追加 `family`；分支模式只绑定根的历史后代，不绑定工具拥有的子会话。`sync` 串行执行，工作量随族成员及其转录长度增长，不调度新任务。
- `nativeBranchIdentity(owner, id)` 给出稳定、独立的原生身份；重启不重新分配，且不与根复用同一个原生 id。
- `readNativeTranscriptFamily(directory)` 返回原子发布的清单 `{ version: 1, root, members: [{ id, path, nativeSessionId, name?, forkOf? }] }`，文件名为 `native-sessions.json`；`name` 与 `forkOf: { conversationId, entryId } | null` 是原生记录的导航摘要；旧清单可省略，缺少成员的较旧读取不会清空已绑定分支的摘要。旧宿主无清单返回 `null`，损坏／重复成员或新增摘要类型无效返回 409。
- 原生 `pi-desktop-family` 条目的 `{ owner, conversationId }` 是只读互操作归属，供发现器处理文件与清单之间的发布窗口。清单和标记都不是第二份会话真相；分支与上下文始终以 Durable 为准。
- 同步失败向调用者抛出；关闭会尝试释放全部转录锁，不能因一个分支失败就留下其他分支的 writer。

Host 的整族忙闲、归档恢复及单文件接管限制见 [生命周期契约](lifecycle.md)。

## 退回上下文与来源

`openNativeTranscript` 句柄追加同步只读方法 `rewindContext(entryId)`，返回 `{ messages, origins: number[] } | undefined`；消息使用 Pi 的 `buildSessionProjection` 推导，并从同一投影的 `sourceEntry` 关联 Durable 原点。目标未导出时为 `undefined`，不能识别来源时为 409。旧 `rewindMessages(entryId)` 仍返回消息列表。

`origins` 仅对应可见的 user／assistant／toolResult／custom 贡献，不把摘要或 system 计入索引。一次 Durable 贡献导出多条原生消息时，它们共享该贡献的 entry id。HTTP `rewind` 输入不变；Host 自行取得消息和来源，不能信任客户端伪造的上下文。提交参数与原生角色的规范化见 [Durable workspace 契约](durable-workspace.md)。

## 性能特征

- 每次调用读取 workspace 摘要、会话转录与当前活跃消息位置；原生树来自内存中的 SessionManager，不读盘。轮次窗口限制 SVG 展示规模，不改变原生树返回契约。
- 不是轮询端点：界面在 `state_changed` 或切换会话后按需拉取。
- 分支数量与原生条目数量线性相关；被放弃的路径同样会被列出（这是它的用途）。

## 可执行证据

- `test/durable-session-tree.test.mjs`：原生 parent 链与 leaf、分支点、被放弃路径不在活跃路径上、`rewinds` 记录退回目标、`branches` 列出全部分支且 `forkOf` 指向同一来源、无原生转录的会话返回 `native: null`；另断言数值 entry／rewind 目标、80 代码单元预览、无映射 null 与无效 id 的 422。
- `test/bridge.test.mjs`：未声明能力的宿主返回 `supported: false`；声明后按 `id` 传参且只调用一次。
- `test/boundary-contracts.test.mjs`：Host capability 集包含 `sessionTree`（40 个键）。

默认模式的补充证据：`test/desktop-branch-family.test.mjs`（真实 Host／worker／runtime、独立用量、根与分支转录、整族忙闲与重启／迁移恢复）、`test/session-family-ownership.test.mjs`（发现不创建 Pi 替身），以及 `test/desktop-branch-family-browser-check.mjs`（会话栏与树节点分叉、浏览器内零用量、源不变、随后切换）。后者纳入 `test:workspace:browser`。

多次退回的来源、重启与再次分叉见 `test/durable-rewind-origins.test.mjs`；原生编辑／压缩／批量贡献的来源投影见 `test/native-rewind-context.test.mjs`。默认浏览器验收也覆盖两次退回后从可见 Q1 分叉，不能带入 Q2/Q4；外层左侧工作区显示同一 worker 的分支按钮，内外会话切换同步，刷新后仍可进入；右键和 Shift+F10 从按钮的固定会话当前位置创建新会话，不偷用 iframe 的当前选择。分支菜单不提供外层 Agent 的进程归档、人格或重命名操作。

入口与管理按钮门控、读取生命周期见 [会话只读面板契约](read-panels.md)。`capabilities.sessionTree` 显式来自 Host；unsupported 时内置页及会话栏的分支树入口一起隐藏。只读仅展示，远程不放宽既有分支命令裁剪。
