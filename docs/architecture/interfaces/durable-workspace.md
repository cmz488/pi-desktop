# Durable workspace 契约

## 位置与职责

`src/agent/agent-workspace.mjs` 打开一个 Agent 的 Durable Harness（[官方概念](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)：Harness／conversation／entry／commit／document／task），并把"会话与任务"包成一个深 module 的 workspace 接口。它是 [边界规则 R1](../pi-boundary.md) 的执行者：Durable storage 是会话唯一真相。

Durable 的深度在这里体现：**先 commit 再显示**、每个 task 存 checkpoint、进程重启后续跑、每会话保存 agent 配置文档。

## 签名

```js
export async function openAgentWorkspace(options); // -> workspace

// options
{
  models,            // 必需；@earendil-works/pi-ai 的 models 注册表
  registry,          // 可选；默认 createRegistry()，内部会装入 CodingTools 或只读工具集
  readOnly,          // 可选；true 时只装 read 工具 + ReadOnlyWeb，不装完整 CodingTools
  storage,           // 可选；测试用内存 storage
  storagePath,       // 可选；SQLite 路径（默认在 agent 目录下）
  settings,          // 可选；Harness 设置
  env,               // 可选；NodeExecutionEnv 或只读环境
  extensions,        // 可选；预装扩展名
  initialize,        // 可选；async (workspace) => void，在返回前调用
  resume,            // 可选；!== false 时调用 harness.resume()（恢复未完成任务）
}
```

workspace 表面：

```js
workspace.read(id?)        // async -> { agents: [摘要], recovery, tasks, ... }：
                           //   agents 是每个会话的摘要（含 parent 分叉来源）；children 是被任务拥有的子会话；
                           //   tasks 是任务图（含 owner 与 waitingOn）；recovery 是本次打开时接管的待恢复任务
                           //   （无则 null）；tasks 是当前任务图
workspace.live(id?)        // async -> 流式期间的轻量视图；也可观察 owned 子会话，不授予写命令权限
workspace.agent(id)        // async -> 该会话的 agent 配置（模型、思考级别、扩展、工具、cwd）
workspace.execute(command, input?, { signal } = {})  // async -> 命令结果；signal 只供 wait 观察者
workspace.transcript(id)   // async -> { entries, ... }：Pi 消息形状的投影
workspace.persistNative(id, entries, messages = [])  // 把原生回合写回 transcript
workspace.importNative(id, entries)                  // 导入原生树（归档恢复路径）
workspace.install(extension)                         // 运行期装入 Durable 扩展
workspace.subscribe(listener)                        // -> unsubscribe；变更通知
workspace.close()                                    // 释放 Harness、锁与资源
```

`read()` 的 `recovery` 形状（追加字段，不影响既有消费方）：

```js
{
  resumedAt,    // 新宿主接管待恢复工作的时刻（ISO 8601）
  count,        // 接管的任务数
  outstanding,  // 其中仍未结束的任务数（恢复完成后归零）
  tasks: [{ id, kind, conversationId, background, statusAtOpen, status }],
}
```

`execute` 的命令表：

| 命令        | 输入                                  | 语义                                                                                     |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `create`    | `{ patch, profile }`                  | 新建会话；未指定扩展时用 registry 当前安装集                                             |
| `send`      | `{ id, message, ... }`                | 提交一次 input；run 结束时回答作为 entry 落盘                                            |
| `abort`     | `{ id }`                              | 中止当前 run，队列中的消息保留                                                           |
| `compact`   | `{ id, ... }`                         | 触发压缩（插入 summary entry，原 entry 保留）                                            |
| `configure` | `{ id, patch }`                       | 修改该会话的 agent 文档（模型／思考级别／扩展／工具）                                    |
| `fork`      | `{ id, entryId }`                     | 从某个 entry 分叉出**新的会话**，名称追加"· 分支"                                        |
| `rewind`    | `{ id, entryId, messages, origins? }` | 退回：追加 `desk.rewind` 头部标记，其 `model` 就是退回点之前的模型上下文；原条目全部保留 |
| `wait`      | `{ id, taskId? }`                     | 只观察指定任务终态或会话空闲；可选第三参数 signal 仅取消这次观察，不中止任务             |
| `cancel`    | `{ id, taskId?, background? }`        | 中止范围内任务，完整归属与后台语义见任务契约                                             |
| 其他        | —                                     | `DeskError(404, "不支持的 Agent 操作")`                                                  |

## 不变量

- **单 writer**：打开时用 `proper-lockfile` 独占 agent 目录（`stale: 10000`、`update: 2000` 心跳，`realpath: false`）；锁被抢占时 `compromised` 标记生效，并且在宿主就绪后会自动 `close()`。
- **`guard()` 前置**：`read`／`live`／`agent`／`execute`／`transcript`／`subscribe` 每次调用都先断言生命周期；`close()` 之后调用即抛 `DeskError(409, "Agent 宿主已关闭")`。
- **任务图在打开时读取**：`harness.taskGraph(context)` 提供在跑的任务与后台任务；`idle` 判定基于“该会话没有前台任务”。
- **提交先于显示**：任何可见状态都必须先经过 commit；`subscribe` 的监听者只看到已提交的变更。
- **`read` 与 `live` 的差别是契约的一部分**：`read` 是全量摘要（供快照），`live` 不带 transcript（供流式期间的增量视图，见 01 性能深化）。
- **每个会话一份 agent 文档**：模型、思考级别、扩展名、工具名、cwd 存在 Durable 文档里（不是进程内存），因此重启后一致。
- **恢复是追加式读模型**：打开时记录任务图里的待恢复任务（重启后运行中的任务显示为 `pending`），之后按当前任务图汇报每项是否结束。`recovery` 只在打开时任务图为空的情况下为 `null`；重启后即使待恢复任务已全部结束（`outstanding` 为 0）仍会报告 `count` 与 `resumedAt`，界面只在 `outstanding > 0` 时提示。它不改变 transcript，也不重发已提交且不依赖中断工作的条目。
- **`fork` 记录来源**：Durable 在会话记录里保存 `parent { conversationId, at }`，`read()` 的会话摘要把它作为 `parent` 带出，因此分支树在重启后仍能读出父子关系（界面读模型见 [分支树契约](session-tree.md)）。
- **`fork` 产生独立会话**：新会话有独立 `usage` 与独立 transcript；分叉后必须修复原生上下文（`repairNativeContext`），避免继承父会话的旧贡献。
- **`rewind` 只改上下文起点，不删历史**：`desk.rewind` 是头部标记（`head: "self"`），Durable 内核因此把模型上下文重建为该标记携带的消息（退回点之前的前缀），其后的条目不再进入上下文；原生日志的 leaf 移动由会话模块用 Pi 的 `branch()` 在同一文件里完成。前缀消息由 Host 用 Pi 自己的推导从原生日志取得，命令本身不自行推导上下文。
- **退回来源必须可对齐**：Host 从同一个 Pi 投影同时取得消息与 `origins: number[]`，按可见 `user`／`assistant`／`toolResult`／`custom` 顺序排列，不包含 UI 摘要和 system。来源必须是该会话的已知 entry；原点与标记原子提交，不能因数量不符就省略映射。直接调用方的简单旧调用仍兼容，不能对齐的复杂历史返回 409，不再伪装成标记来源。
- **模型与 UI 角色分离**：退回消息通过 Pi `convertToLlm` 写入 model；有摘要／custom 等原生角色时，原始贡献保存在同一标记的只读 UI 数据里，卡片与消息原点不会因规范化而丢失。
- **等待不拥有执行生命周期**：`execute("wait", input, { signal })` 把 signal 仅用于 Durable 的等待 Context；其他命令沿用原有上下文。取消观察不会 abort 任务，指定任务的所有权校验不变。HTTP 额外的租约／配额、前端续租与总预算见 [任务契约](task-graph.md)。
- **`readOnly` 只能减少能力，不能改变接口形状**：只读模式下 `read`、`live`、`execute` 仍可用，但工具集被裁剪为 `read` 与只读 web。

## 顺序约束

1. `openAgentWorkspace` → `options.initialize?.(workspace)` → `harness.resume()`（`options.resume !== false`）→ 返回。恢复发生在返回之前，调用者拿到的是已经决定是否续跑的 workspace。
2. 打开期间先修复每个会话的原生上下文（`repairNativeContext`），修复失败则 `close()` 并抛出，不留半开状态。
3. `close()` 必须在进程退出前调用；重复调用安全。
4. `fork` 之后必须等 `repairNativeContext(fork)` 完成才能读取该会话的 transcript。

## 错误模式

| 条件                                                                               | 结果                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `options.models` 缺失，或上游形状变化（`Harness.open`／`createRegistry` 不是函数） | `Error("Pi Durable 公开接口不兼容")`                               |
| 已有 writer 持有锁（`proper-lockfile` 报 `ELOCKED`）                               | `DeskError(409, "Agent 存储正在被另一个宿主占用")`，不降级为共享写 |
| `fork` 的 `entryId` 不是安全整数                                                   | `DeskError(422, "分叉位置无效")`                                   |
| 退回 `origins` 非数组或包含非法 id                                                 | `DeskError(422, "退回消息来源无效")`                               |
| 退回来源与可见消息数量不一致                                                       | `DeskError(409, "退回消息来源不一致，请重新读取会话")`             |
| 退回来源不属于该会话的已知条目                                                     | `DeskError(404, "退回消息来源不存在")`                             |
| 未知命令                                                                           | `DeskError(404, "不支持的 Agent 操作")`                            |
| 生命周期已结束（`close()` 后调用）                                                 | `guard()` 抛 `DeskError(409, "Agent 宿主已关闭")`                  |
| 会话 ID 不是非负安全整数                                                           | `DeskError(422, "Agent ID 无效")`                                  |
| 会话不存在或缺 `AgentProfile` 文档                                                 | `DeskError(404, "Agent 不存在")`                                   |
| 初始化／修复阶段抛错                                                               | 先 `close()` 再抛出，原始错误不被吞掉                              |

## 性能特征

- 会话状态在 SQLite；`read()` 会遍历所有会话并逐个取摘要，属"全量路径"，应被 revision／增量机制挡在热路径之外（见 `GET /api/revision`）。
- `live(id)` 刻意跳过 transcript 投影，是流式更新的低成本入口。
- 原生转换与 session 管理子模块按需加载（`loadPiMessages`／`loadPiSessionManager`），不进入启动关键路径。
- `fork` 需要复制 entry 区间并修复上下文，成本与分叉深度成正比。

## 可执行证据

- `test/agent-workspace.test.mjs`：打开、只读裁剪、命令表与 guard 行为。
- `test/durable-features.test.mjs`：会话、工具、权限、归档与重启语义。
- `npm run test:durable`、`npm run test:durable:recovery`（`test/durable-recovery-check.mjs`）。
- `test/durable-delta.test.mjs`：`read`／`live` 在流式期间的调用比例。
- 接口形状断言：`test/boundary-contracts.test.mjs` —— 重命名或删除本页列出的键、命令或深路径时该测试失败。
- 会话树与分叉来源：`test/durable-session-tree.test.mjs`；任务图与子会话：`test/durable-task-graph.test.mjs` —— 分叉（独立会话与独立用量）与退回（上下文重建到该点、被放弃的回合仍在存储与原生日志里、JSONL 的 parent id 与 active entry 一致）。
- 定点重启：`npm run test:durable:recovery`（`test/durable-recovery-check.mjs`）在回答生成与工具调用两种中断点分别 SIGKILL 宿主，断言恢复可见、回答只提交一次、已提交的生成不被重发、未安全重放的工具不重复执行。

- 多次退回来源：`test/durable-rewind-origins.test.mjs`（默认 Host／worker 的两次退回、Q1 再分叉、重启、原生 parent／leaf、压缩后续跑的真实请求）；`test/native-rewind-context.test.mjs`（批量贡献、编辑、压缩、custom 的 Pi 来源投影）；`test/agent-workspace.test.mjs`（参数拒绝不落部分标记、LLM 规范化与 UI 卡片保持）。`test:workspace:browser` 用消息右键完成同一 Q1/Q2/Q3 → 退回 Q2 → Q4 → 退回 Q4 → 分叉 Q1 流程。
