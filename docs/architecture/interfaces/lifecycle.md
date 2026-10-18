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
supervisor.noteActivity(id)         // 记录活动时间（不触发全局 revision）
supervisor.revision()               // async -> { catalog, workspace }：轻量变更探测
supervisor.read()                   // async -> 目录 + 每 Agent 状态（含会话文件 stat）
supervisor.execute(command, input?) // async -> 命令结果（下表）
supervisor.target(id)               // 单个 Agent 的写目标（含当前状态与路径）
supervisor.openTarget(id)           // async -> 只读历史的 URL（按需打开，带 LRU）
supervisor.restore()                // async -> 在任何 worker 启动前完成归档／恢复意图
supervisor.close()                  // async -> 关闭所有历史视图、会话与归档

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
| `conversation.create`、`prompt.save`                                      | 会话与提示词     |

## 不变量

- **追加型操作不参与 revision 冲突**：`conversation.create`、`agent.save`、`project.save`、`prompt.save` 在 `input.id` 为空时自动丢弃 `input.revision`（后台扫描或活动时间戳不能让新增表单失败）；**已有行的修改仍必须带 revision**。
- **`revision()` 与 `read()` 的成本不同**：`revision()` 只读目录文档 + 内存中的进程状态，**不做每 Agent 的会话文件 stat**；`read()` 会做。轮询路径必须先问 `revision()`。
- **历史视图按 LRU 限制为 8 个**：新视图打开时关闭最旧的；被淘汰或会话变更时，等待中的视图句柄判为失效（`DeskError(409, "会话视图已关闭，请重试")`）。
- **归档先于启动**：`restore()` 必须在任何 worker 启动前完成 durable 归档／恢复意图，避免两个 writer 竞争同一 Pi 会话。
- **未启动的 Agent 不允许读取**：`agent.source !== "pi"`、未归档且缺少原生会话文件时抛 `DeskError(409, "请先启动 Agent")`；记录已丢失抛 `DeskError(404, "Pi 会话记录已不存在")`。
- **写目标唯一**：所有跨 `await` 的写入必须经 `host.target()`／`supervisor.target(id)` 校验，路由不复制 409 规则。
- **catalog 是只读快照 + revision**：`store.read()` 返回 `{ revision, projects, agents }`；写入走 `mutateDocument` 的锁 + revision 栅栏。
- **原生转录绑定在宿主启动时接管的 Agent 上**：默认多进程 Desktop 每个 Agent 一个 worker，因此每个 Agent 有各自的 `agents/<id>` 目录与 `native-session.json`；注入 workspace 或 `--single-process` 宿主只绑定启动时的那个 Agent，其他会话没有原生 JSONL（退回因此返回 409，分叉不受影响）。

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
- **`noteActivity` 不写全局 revision**：活动时间戳不引起所有客户端重取目录。
- **锁是文件级 O_EXCL**（`wx`，0600）加临时文件 rename，避免部分写入。
- 归档／恢复是**冷路径**：只在启动、归档或恢复时发生，不在请求热路径上。

## 可执行证据

- `test/desktop-control-plane.test.mjs`：目录发现、命令表与目标校验（`npm run test:workspace`）。
- `test/desktop-process-recovery.test.mjs`：进程重启与恢复意图先于启动完成。
- `test/desktop-pi-sessions.test.mjs`：Pi 会话扫描与投影。
- `test/session-manager.test.mjs`、`test/sessions-command.test.mjs`（`npm run test:sessions`）。
- `test/config-store.test.mjs`：revision 栅栏与锁冲突。
- `test/remote-lazy.test.mjs`：`revision()` 作为轮询入口的形状。
- 会话树退回与分叉：`test/durable-session-tree.test.mjs`（会话与 JSONL）、`npm run test:durable:browser`（消息右键菜单）。
- 接口形状断言：`test/boundary-contracts.test.mjs` —— 重命名或删除本页列出的键、命令或深路径时该测试失败。
