# 独立会话创建契约

## 位置与职责

- `src/control-plane/supervisor.mjs`：正常创建与继承创建共用 `createConversation`、`start`、配置绑定和恢复路径。
- `src/control-plane/server.mjs`：默认 Desktop 的两类创建入口汇合；worker 初始化快照不直接暴露给浏览器。
- `src/session/pi-session-storage.mjs`：原生句柄的 `forkSnapshot` 与失败回执的 `readForkSnapshot`；不复制 SQLite、任务或执行循环。
- `src/server/durable-server.mjs`、`src/agent/agent-workspace.mjs`：正常 worker 导入原生树，首次资源 Session 取得继承的扩展状态。
- `src/ui/workspace.js`、聊天及分支面板：同级导航、固定创建来源与异步选择意图。

## 签名

```js
// POST /api/workspace/command
{
  command: "conversation.fork",
  id, generation,        // 来源 Desktop Agent UUID、非负存储代际
  conversationId?,       // 来源 worker 数值会话；省略取根
  mode?,                 // UI 使用 "tail"
  entryId?,              // 精确历史位置；mode=tail 时不作为 asOf
  expectedEntryId?,      // tail 的可选检查点，不与精确 entryId 混用
}
// -> { agentId: 新 Desktop UUID, generation: 0, sessionId: 新 worker 的数值根 id 字符串 }
```

默认 Desktop 的 `POST /agents/<id>/api/command` 中 `fork` 同样进入上述创建路径；请求的数值 `id`、`sessionId` 与 URL 目标必须一致，URL `generation` 仍校验目录与实际进程。旧 URL 省略 generation 时沿用当前代际兼容；全 Host 任务接口不因此放宽必填代际。

新目录行的 `createdFrom` 是 `{agentId,generation,conversationId,entryId,nativeSessionId}`，只作追溯；`entryId` 在空来源时为 null。它不是 `parent` 或 `owner`，新根的 `forkOf` 为 null。

worker 初始化通道：

```js
// 仅 Host 直连自己的 worker；浏览器 /agents/... 代理一律拒绝此路径
POST /api/fork-source?sessionId=<来源会话>
{ id, nativeId, entryId?, expectedEntryId? }
// -> { path, nativeSessionId, createdFrom, name }

transcript.forkSnapshot({nativeId,entryId?,expectedEntryId?})
readForkSnapshot(nativeId,cwd,agentDir,source)
// -> {path,nativeSessionId,createdFrom}；source 为保留的初始化来源身份和可选位置
```

精确位置决定活跃上下文，配置取创建时公开会话摘要中的当前设置；模型、thinking、instructions、工具选择和 `nativeDefaults` 随初始化恢复。人格／审批绑定来自源 Agent，后续仍按正常会话规则处理共享人格与全局资源更新，不另造冻结配置策略。

## 不变量

- 每个新会话有自己的 Agent、worker、SQLite、原生身份和唯一 writer，直接加入原工作区同级列表。存量族内分支不迁移，原生低层 `fork` 及精确位置能力保持兼容。
- 复制 SDK 公开原生 entries，并由 SDK 的 leaf／projection／context edit／压缩语义决定上下文；不从 UI 文本重建，不复制任务 journal。
- tail 检查点是已提交消息的位置标识，不是模型上下文内容本身；其后的 context edit 等原生状态也随快照保留。历史原文可以仍在展示中，已省略贡献不能因此重新进入模型。
- 转录同步与快照捕获串行；快照的目标文件完整发布、不覆盖既有文件。无消息的原生初始化也能复制；已发布空快照会持久记录导入检查点，不能在重启时覆盖目标后续配置。
- 新资源 Session 在首次启动钩子前获得继承的 custom 状态。初始化摘要必须与随后导入的原生文件一致；启动钩子追加的状态不能被较早快照覆盖。
- 来源只追溯，不转移在途任务或 owned 子代理。新 worker 的实时图和终态历史只读取自己的原生范围；继承文本中的任务号不授予源权限。
- remote、只读、路径隔离、请求目标、generation 和单 writer 门禁不降低。忙时可复制已提交快照，退回沿用原有忙闲限制。

## 顺序约束

1. Host 固定来源身份、代际和会话并校验能力；新目标先保留唯一原生身份，发现器不会把发布中的副本注册成 Pi 替身。
2. worker 在同步队列内捕获原生记录及配置；错误检查点拒绝，不把 stale tail 改成历史位置。
3. 完整文件先可靠发布，再启动正常 worker。正常工厂不接受一个缺失继承记录的空白降级。
4. 确定的 4xx 初始化拒绝撤销未启动条目；网络／5xx 不确定回执保留身份与错误。随后普通 `agent.start` 只查找并核对同一已发布快照，不能重取更新后的源上下文；没有完整文件时保持 409。
5. 新会话提交、退回、停止和重启仅操作自己的 worker。正常资源／人格绑定规则不变。
6. 浏览器创建开始时捕获选择 epoch；完成后刷新列表，只有来源 frame、generation、请求身份和最后导航意图仍匹配才切入结果。隐藏、切页、关闭等待不取消已提交创建。

## 错误模式

| 条件                                                    | 结果                                          |
| ------------------------------------------------------- | --------------------------------------------- |
| 只读、归档、非受管来源、remote 创建或直接请求初始化快照 | 403                                           |
| 无效会话／代际／位置／新原生身份、混用精确位置与检查点  | 422                                           |
| 来源会话不存在                                          | 404                                           |
| generation、当前位置、初始化摘要或文件来源冲突          | 409，不覆盖或猜测                             |
| 原生记录超过 64 MiB                                     | 413，不截断成功                               |
| 初始化结果尚未确认／快照不存在                          | 保留错误，启动返回 409，不使用空上下文        |
| 原生 RPC 超过 12 秒                                     | 503，提示刷新确认结果；不冒充已取消或中止任务 |

## 性能特征

- 快照的复制、序列化和首次导入与原生记录长度相关，64 MiB 上限不变；展示轮次窗口不裁短复制内容。
- 独立 worker 的常驻模块和资源 Session 是架构成本，单列测量，不通过停工作回收或合并 writer 隐藏成本。
- Native 初始化状态只在创建时预置；普通重启不重复导入或重新执行继承创建。
- 非 fork 的 worker 命令仍转发原命令，保持 768 KiB 边界；prompt 与事件流继续按原路径传输。

## 可执行证据

- `test/desktop-independent-fork.test.mjs`：新 worker、源不变、停止源与重启、两入口、拒绝后无空行、丢失回执、忙时工具上下文配对／任务隔离、精确位置与配置、空初始化、原生资源状态与单次启动钩子、context edit 的历史／模型分离。
- `test/desktop-sidebar-fork.test.mjs`：跨项目同号会话、代际／只读／remote、初始化路径裁剪、请求目标与有界超时。
- `test/desktop-branch-family-browser-check.mjs`：真实默认 Host 左侧／内层／工作台创建、同级导航与焦点、退回、多次退回后的来源、存量分支、重载、源停止与迟到回执。
- `test/desktop-branch-family.test.mjs`、`test/desktop-sidebar-navigation-browser-check.mjs`：由公开低层接口仅布置存量记录，原归档、恢复、选择竞态及权限断言不弱化。
- `test/native-session-inheritance.test.mjs`：SDK 公开能力对照；上述专项不替代本目标最终完整 12 项和隔离行为反向。
