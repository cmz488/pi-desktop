# 项目与 Agent 生命周期契约

## 位置与职责

- `src/control-plane/supervisor.mjs`：Host 侧的项目／Agent 目录、启动与停止、归档与恢复、只读历史视图。
- `src/control-plane/server.mjs`：把 supervisor 与 Host interface 接到 HTTP 路由。
- `src/control-plane/pi-sessions.mjs`：Pi 会话文件的扫描与投影（Host 只读视图）。
- `src/config/config-store.mjs`：目录文档（catalog）的读写、revision 与 `DeskError`。

对应 [边界规则 R4](../pi-boundary.md)：**Host 不接触 Durable 内部**——supervisor 只做生命周期与路由，会话语义都在 worker 内。

## 签名

```js
export function createSupervisor(store, options); // -> supervisor

supervisor.shared(run)              // 串行化一段跨 Agent 的宿主操作
supervisor.noteActivity(id, {metadataOnly = false} = {}) // 同步原生会话导航；仅普通模式更新活动时间
supervisor.revision()               // async -> { catalog, workspace }：轻量变更探测
supervisor.read()                   // async -> 目录 + 每 Agent 状态（含会话文件 stat）
supervisor.execute(command, input?) // async -> 命令结果（下表）
supervisor.target(id)               // 单个 Agent 的写目标（含当前状态与路径）
supervisor.openTarget(id)           // async -> 只读历史的 URL（按需打开，带 LRU）
supervisor.restore()                // async -> 在任何 worker 启动前完成归档／恢复意图
supervisor.close()                  // async -> 关闭所有历史视图、会话与归档
supervisor.monitorTasks({signal} = {})       // async -> 全 Host 原生任务聚合，不启动进程
supervisor.manageTask(input, {signal} = {})  // async -> 固定 Agent/generation/scope 的原生命令
supervisor.taskDetail(input, {signal} = {})  // async -> 原生回执与子会话预览

// store（config-store）
readDocument(path);                       // async -> { data, revision }
mutateDocument(path, expectedRevision, mutate); // async -> 变更结果；先取锁再写
class DeskError extends Error { status }
```

`execute` 的命令表：

| 命令                                                                      | 说明             |
| ------------------------------------------------------------------------- | ---------------- |
| `project.save`、`project.rename`、`project.remove`                        | 项目目录维护     |
| `agent.save`、`agent.rename`、`agent.policy`、`agent.prompt`、`agent.pin` | Agent 目录维护   |
| `agent.archive`、`agent.restore`、`agent.resume`                          | 归档／恢复／续跑 |
| `conversation.create`、`conversation.fork`、`prompt.save`                 | 会话与提示词     |

`conversation.fork` 输入 `{ id: desktopAgentId, generation, conversationId? }`，只在本地受管、非只读且运行中的 worker 上执行。省略 `conversationId` 指向该 Agent 的根会话；指定时必须是它的受管历史会话。它薄转发现有 `fork { mode: "tail" }`，创建继承目标当前位置的新会话，不新建 Desktop Agent／SQLite／worker，不重放模型；忙碌快照仍可分叉。返回原生命令的 `{ id, sessionId, ... }`。缺少或非法 generation／会话 id 为 422，代际过期或进程未运行为 409，无权限或远程入口为 403，不存在的会话为 404。实际进程转发再次检查 generation；整次原生 RPC 预算 12 秒，超时为 503，提示刷新确认是否已提交，不把超时解释为中止任务。

`read()` 与 `GET /api/workspace?view=index` 的每个 Agent 追加 `rootConversationId?: number`、`branches: [{ id, name, forkOf: { conversationId, entryId } }]`，并在 index 保留 `generation`。它们是当前代际的导航投影，来自 worker 发布的清单，不暴露内部文件路径，不承载上下文或权限；旧清单升级前可为空。停止、重启、归档不把分支伪装成另一个 Agent。客户端选择按 Agent／generation 存在 sessionStorage；停止的历史分支必须先启动原 worker，再进入原数值会话，不能把根的单文件只读历史冒充为该分支。

## 不变量

- **追加型操作不参与 revision 冲突**：`conversation.create`、`agent.save`、`project.save`、`prompt.save` 在 `input.id` 为空时自动丢弃 `input.revision`（后台扫描或活动时间戳不能让新增表单失败）；**已有行的修改仍必须带 revision**。
- **`revision()` 与 `read()` 的成本不同**：`revision()` 只读目录文档 + 内存中的进程状态，**不做每 Agent 的会话文件 stat**；`read()` 会做。轮询路径必须先问 `revision()`。
- **历史视图按 LRU 限制为 8 个**：新视图打开时关闭最旧的；被淘汰或会话变更时，等待中的视图句柄判为失效（`DeskError(409, "会话视图已关闭，请重试")`）。
- **归档先于启动**：`restore()` 必须在任何 worker 启动前完成 durable 归档／恢复意图，避免两个 writer 竞争同一 Pi 会话。
- **未启动的 Agent 不允许读取**：`agent.source !== "pi"`、未归档且缺少原生会话文件时抛 `DeskError(409, "请先启动 Agent")`；记录已丢失抛 `DeskError(404, "Pi 会话记录已不存在")`。
- **写目标唯一**：所有跨 `await` 的写入必须经 `host.target()`／`supervisor.target(id)` 校验，路由不复制 409 规则。
- **任务管理不占配置串行队列**：全 Host 等待只观察原生工作，断连不 abort task；实际进程 generation 再次校验，不把旧库同号 task 转发给新库。接口与错误见 [Host 任务契约](host-tasks.md)。
- **catalog 是只读快照 + revision**：`store.read()` 返回 `{ revision, projects, agents }`；写入走 `mutateDocument` 的锁 + revision 栅栏。
- **一个 Desktop Agent 一个 writer**：默认 worker 承载该 Agent 的会话族，历史分支是同一 Harness 内独立的 Durable 会话。根保留 `agents/<id>` 下的元数据，分支在该目录的 `branches/<conversationId>` 下各自保存转录元数据；重启后原生身份与路径不变。单进程／注入 workspace 模式仍只绑定最初的会话。

## 顺序约束

1. `restore()` → 目录发现（`discover()`，扫描 Pi 会话并 `reconcilePiSessions`）→ 启动 worker → 提供路由。
2. 写操作顺序：`readDocument` 取 `revision` → 用户提交时带上该 revision → `mutateDocument` 校验 → 成功后才更新本地视图。
3. `openTarget(id)` 的开销包含统计与打开；同一 id 的并发请求复用同一个 promise，失败时清理句柄再抛出。
4. `close()` 必须在宿主退出时调用：先关闭历史视图，再关会话与归档。

## 错误模式

| 条件                                              | 结果                                                   |
| ------------------------------------------------- | ------------------------------------------------------ |
| 配置文件不是 JSON 对象                            | `DeskError(422, "配置文件必须是 JSON 对象")`           |
| `mutateDocument` 未收到 `expectedRevision` 字符串 | `DeskError(422, "缺少配置版本，请重新读取")`           |
| 已有锁文件 `<path>.pi-desk-lock`                  | `DeskError(409, "另一项配置修改正在进行，请稍后重试")` |
| `input.revision` 与当前 catalog revision 不一致   | `DeskError(409, ...)`（由命令层抛出）                  |
| 未启动的 Agent 被读取                             | `DeskError(409, "请先启动 Agent")`                     |
| 原生会话记录已被移走                              | `DeskError(404, "Pi 会话记录已不存在")`                |
| 历史视图在等待期间被关闭                          | `DeskError(409, "会话视图已关闭，请重试")`             |
| 归档／恢复进行中收到冲突写                        | `DeskError(409, ...)`（`archivePending` 等状态）       |

## 性能特征

- **`revision()` 是轮询入口**：省掉每 Agent 的会话文件 stat；客户端的交互／MCP／工作区轮询先探它（见 04 性能深化）。
- **历史视图上限 8**：同时打开的只读历史不会线性增长；淘汰是 LRU。
- **原生导航按变化发布**：成功的 worker `/api/command` 同步会话族元数据，但观察类命令不更新时间戳；无清单变化时不重写 catalog。`/api/prompt` 仍更新活动时间。
- **锁是文件级 O_EXCL**（`wx`，0600）加临时文件 rename，避免部分写入。
- 归档／恢复是**冷路径**：只在启动、归档或恢复时发生，不在请求热路径上。

## 可执行证据

- `test/desktop-sidebar-fork.test.mjs`：跨项目同号会话、当前位置继承、忙碌快照、只读／远程／停止／代际门禁、停止和 Host 重启后的导航保留，以及 SIGSTOP worker 的有界超时。
- `test/desktop-control-plane.test.mjs`：目录发现、命令表与目标校验（`npm run test:workspace`）。
- `test/desktop-process-recovery.test.mjs`：进程重启与恢复意图先于启动完成。
- `test/desktop-pi-sessions.test.mjs`：Pi 会话扫描与投影。
- `test/session-manager.test.mjs`、`test/sessions-command.test.mjs`（`npm run test:sessions`）。
- `test/config-store.test.mjs`：revision 栅栏与锁冲突。
- `test/remote-lazy.test.mjs`：`revision()` 作为轮询入口的形状。
- 会话树退回与分叉：`test/durable-session-tree.test.mjs`（会话与 JSONL）、`npm run test:durable:browser`（消息右键菜单）。
- 接口形状断言：`test/boundary-contracts.test.mjs` —— 重命名或删除本页列出的键、命令或深路径时该测试失败。

## 会话族的生命周期

- `src/control-plane/session-families.mjs` 只消费 worker 的原生清单与文件标记；`mergeNativeSessions(before?, next?)` 合并已验证的归属列表并保持 id／path／nativeSessionId 唯一，HTTP 工作区不额外暴露分支文件路径。发现器不会把同族 JSONL 另列为 Pi 只读 Agent；旧单文件 worker 的清单可以缺省。
- `GET /api/agent` 的追加字段 `familyIdle` 用于整族配置门禁；所有实时任务结束前，共享人格、Agent 运行配置与权限调整不能误用根会话的空闲状态。未被引用的新提示词追加仍保留原有语义。
- Host 的 Agent 停止／重启作用于整个 worker；聊天内的等待／取消仍只作用于选中会话及其 owned 后代，不跨历史分支。
- `src/control-plane/family-archives.mjs` 在现有 `openSessionArchives` adapter 上组合迁移。根沿用原归档 key，分支使用独立 key；先保存 `archiveIntent: "archive" | "restore"` 和 `archivePending`，每个文件保留原有摘要、锁、不可覆盖发布和阶段恢复，整族完成后才清除门禁。启动前恢复未完成的整族意图，不能只恢复根就启动 worker。
- 一份文件冲突时不覆盖文件，整个 Agent 保持 pending；归档未完成先重试归档，恢复未完成先重试恢复。迁移错误在工作区可见，不能通过反向操作清掉半完成状态。
- 多分支族不支持用 `agent.resume` 把单份 TUI JSONL 接管成新数据库，返回 409，避免丢弃其余分支；原有单会话接管不变。会话族正常使用 stop/start/restart 及整族 archive/restore，Durable SQLite 始终保留。

可执行证据：`test/desktop-branch-family.test.mjs` 覆盖独立转录、整族忙闲、三会话重启／归档恢复、归档中途锁冲突后重启完成、恢复不覆盖冲突分支且重启可续迁移、首次文件尚未移动就失败的意图恢复；`test/session-family-ownership.test.mjs` 覆盖清单、发布窗口、generation 与原生身份校验；`test/native-transcript-family.test.mjs` 覆盖同进程关闭失败时释放所有写锁；`test:workspace:browser` 包含真实默认 worker 的两处分叉入口。
