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
workspace.read(id?)        // async -> { agents: [摘要] }：每个会话的 agent 摘要（模型、用量、状态）
workspace.live(id?)        // async -> projectActive(id, { transcript: false })：流式期间的轻量视图
workspace.agent(id)        // async -> 该会话的 agent 配置（模型、思考级别、扩展、工具、cwd）
workspace.execute(command, input?)  // async -> 命令结果
workspace.transcript(id)   // async -> { entries, ... }：Pi 消息形状的投影
workspace.persistNative(id, entries, messages = [])  // 把原生回合写回 transcript
workspace.importNative(id, entries)                  // 导入原生树（归档恢复路径）
workspace.install(extension)                         // 运行期装入 Durable 扩展
workspace.subscribe(listener)                        // -> unsubscribe；变更通知
workspace.close()                                    // 释放 Harness、锁与资源
```

`execute` 的命令表：

| 命令        | 输入                   | 语义                                                  |
| ----------- | ---------------------- | ----------------------------------------------------- |
| `create`    | `{ patch, profile }`   | 新建会话；未指定扩展时用 registry 当前安装集          |
| `send`      | `{ id, message, ... }` | 提交一次 input；run 结束时回答作为 entry 落盘         |
| `abort`     | `{ id }`               | 中止当前 run，队列中的消息保留                        |
| `compact`   | `{ id, ... }`          | 触发压缩（插入 summary entry，原 entry 保留）         |
| `configure` | `{ id, patch }`        | 修改该会话的 agent 文档（模型／思考级别／扩展／工具） |
| `fork`      | `{ id, entryId }`      | 从某个 entry 分叉出**新的会话**，名称追加"· 分支"     |
| 其他        | —                      | `DeskError(404, "不支持的 Agent 操作")`               |

## 不变量

- **单 writer**：打开时用 `proper-lockfile` 独占 agent 目录（`stale: 10000`、`update: 2000` 心跳，`realpath: false`）；锁被抢占时 `compromised` 标记生效，并且在宿主就绪后会自动 `close()`。
- **`guard()` 前置**：`read`／`live`／`agent`／`execute`／`transcript`／`subscribe` 每次调用都先断言生命周期；`close()` 之后调用即抛 `DeskError(409, "Agent 宿主已关闭")`。
- **任务图在打开时读取**：`harness.taskGraph(context)` 提供在跑的任务与后台任务；`idle` 判定基于“该会话没有前台任务”。
- **提交先于显示**：任何可见状态都必须先经过 commit；`subscribe` 的监听者只看到已提交的变更。
- **`read` 与 `live` 的差别是契约的一部分**：`read` 是全量摘要（供快照），`live` 不带 transcript（供流式期间的增量视图，见 01 性能深化）。
- **每个会话一份 agent 文档**：模型、思考级别、扩展名、工具名、cwd 存在 Durable 文档里（不是进程内存），因此重启后一致。
- **`fork` 产生独立会话**：新会话有独立 `usage` 与独立 transcript；分叉后必须修复原生上下文（`repairNativeContext`），避免继承父会话的旧贡献。
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
