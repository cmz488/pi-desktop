# 独立会话分支：设计与公开能力基线

**状态：独立会话实现已落地，本目标最终验收尚未完成。** 本文保留设计基线，现行接口以[独立会话契约](../architecture/interfaces/independent-sessions.md)为准；存量关系见[分支树](../architecture/interfaces/session-tree.md)。只替代新创建，不迁移已有数据。决策见 [ADR-0001](../adr/0001-independent-session-forks.md)。

## 位置与职责

- `src/control-plane/supervisor.mjs`：复用正常 `conversation.create` 的创建、启停和配置绑定，协调新会话初始化。
- `src/control-plane/server.mjs`：默认 Desktop 的分支创建入口统一交给 Host；保留认证、remote 裁剪和目标代际校验。
- `src/session/pi-session-storage.mjs`、`native-transcript-family.mjs`：在原生同步边界提供创建时快照；源句柄仍是源记录的唯一 writer。
- `src/agent/agent-workspace.mjs`：继续用现有公开导入适配及 Pi 的 canonical projection 恢复有效上下文，不重建模型循环或任务存储。
- `src/ui/workspace.js` 与既有会话／工作台模块：新条目进入左侧同级导航；旧分支仍可访问，退回入口保留。

上述职责已落地；最初能力实验与完整默认 Host 验收分开记录。

## 签名

### 默认 Desktop 命令设计

```js
// POST /api/workspace/command
{
  command: "conversation.fork",
  id,                 // 来源 Desktop Agent UUID
  generation,         // 来源存储代际，非负安全整数
  conversationId?,    // 来源 worker 内的数值会话 id；省略时解析当前会话
  entryId?,           // 保留原生精确位置；不能与 tail 检查点混用
  expectedEntryId?,   // tail 创建的可选位置检查点
}
```

新结果须明确区分外层 `agentId`、`generation` 和 worker 内 `sessionId`，不能把新的数值根 id 当成源 worker 的子分支。`createdFrom` 记录固定来源身份、代际和位置，只作追溯。最终字段及错误由实现阶段同步到生命周期接口契约。

默认 Desktop 的 `/agents/<id>/api/command` 中 `fork` 也须走同一协调路径，不留下消息菜单或工作台仍创建内部新分支的第二入口。`rewind` 继续由目标 worker 执行；不把原生字符串条目 id 当作 Durable 数值 id。独立 SDK／TUI 兼容宿主的低层原生 `fork` 能力不改成自行启动 Desktop 进程。

### 已验证的公开能力

- Pi SDK `SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id })`：新原生身份、完整原生记录。
- `SessionManager` 的公开初始 entries、`branch`、`buildSessionProjection`／`buildSessionContext`：由 SDK 决定活跃路径、压缩和上下文编辑。
- 正常 worker 的 `nativeSessionPath` 初始化和现有 `workspace.importNative`：新 SQLite／writer 导入记录，不复制源 SQLite。
- `GET /api/tree` 的数值映射及原有 `POST /api/command` 精确 `rewind`：能退回继承的历史位置，再提交并重启恢复。

不读取私有 Harness／SessionManager 字段，不从展示消息反推模型上下文。

## 不变量

1. 新会话是独立 Agent，使用正常新建的生命周期；没有额外常驻、空闲回收或调度策略。
2. 来源记录、有效上下文和必要配置在创建时确定；此后的源消息、退回、配置或任务变化不传播到副本，反向也不传播。
3. 原生快照必须处于一致的导出边界。不能用未同步的展示消息、截断 JSONL 或任意时刻重读的可变文件冒充固定快照。
4. 新建空会话也走正常初始化；原生文件尚未落盘不是丢弃已有有效贡献的理由。配置从合法的公开读模型取得。
5. 新会话拥有新原生身份、独立 worker、存储及唯一 writer。不复制运行 journal、在途任务或 owned 子代理；继承记录中的任务引用不得取得新存储内同号任务的管理权。
6. 必要配置包括当时的模型、thinking、instructions、工具选择及正常会话的人格／审批绑定；工作目录与资源权限沿对应项目的正常创建规则。不能借来源任意覆盖 cwd、shellEnv、扩展路径或权限。
7. 来源关系不是 Durable `parent` 或 `owner` 的替身。存量历史关系仍沿 `parent.conversationId`，任务权仍沿 `owner.conversationId`，两者不可混用。
8. 已有族内分支保持原路径与操作，不自动迁移或新增单分支归档／恢复；新会话按正常独立 Agent 管理。
9. 保留忙时的已提交快照创建，禁止忙时退回；取消 HTTP 等待、隐藏、断连或切页只撤观察，不停止源工作。
10. 认证、授权、TLS、沙箱、只读、路径隔离、generation、跨会话隔离与单 writer 不降低；remote `/api/command` 不因入口统一而放开。

## 顺序约束

1. 捕获来源 Agent、generation、会话与可选位置，校验权限、能力及实际 worker 代际。
2. 在源转录的同步边界捕获原生记录、活跃点与必要配置。精确位置用原生公开分支能力；UI tail 检查点过期时拒绝，不悄悄改成历史分叉。
3. 仅在初始化数据完整后让新会话接受工作；新文件／新目录不得覆盖已有原生身份或被其他 writer 占用的记录。初始化失败不能暴露一个丢失继承上下文的空白会话。
4. 新会话启动、配置绑定和失败处理复用正常创建路径；不另开执行循环。来源位置只追溯，不授予源任务权限。
5. 创建完成后刷新同级列表；只在原选择意图仍有效时切入结果，迟到响应不能抢走用户新选择。结果不确定时提示刷新确认，不把超时当作取消或失败终态。
6. 新会话的后续提交、退回与重启全部使用自己的 worker；源会话保持不变。

## 错误模式

实现阶段须以 `DeskError` 和中文消息统一到现行契约：

| 条件                                                   | 要求                                   |
| ------------------------------------------------------ | -------------------------------------- |
| 来源是 Pi 只读记录、已归档、不支持管理或 remote 被裁剪 | 403，不创建新 writer                   |
| generation 失效、tail 检查点改变、文件／writer 冲突    | 409，不改写来源或覆盖冲突              |
| 会话或精确位置不存在                                   | 404／422，保持当前目标                 |
| 无效身份、代际或位置类型                               | 422，不猜测或强制转换                  |
| 快照／启动失败                                         | 明确失败与恢复路径，不以空历史降级成功 |
| 等待超时或断连                                         | 不声称工作已中止；不自动重发创建       |

如果公开能力不能安全继承、退回或隔离任务，停止相关实现并报告证据与选项，不引入私有访问或自建上下文算法。

## 性能特征

- 独立 worker 的模块、资源会话与存储开销单独列为架构成本，不当作可删除的冗余保护。
- 原生记录分叉和首次导入随记录长度增长；不能只复制可见轮次或用界面窗口裁短真实上下文。
- 优化比较固定活跃会话数、worker 拓扑和消息负载；不以减少实际工作改善指标。
- 初始三轮测量、运行条件、采样局限与候选热点见[性能基线](session-redesign-performance.md)。目前没有宣称任何优化收益。

## 可执行证据

已实跑的能力基线：

```sh
NO_PROXY='127.0.0.1,localhost,::1,[::1]' PI_OFFLINE=1 \
  node --test test/native-session-inheritance.test.mjs
```

两项测试分别证明：新 worker 继承／精确退回／恢复且源消息与 JSONL 不变；压缩摘要、保留消息、上下文编辑与 custom 贡献出现在真实模型请求中，被压缩和替换的原文不再进入模型。它们不等于默认 Host 新分支功能验收。

实现阶段的真实 HTTP／Chromium 矩阵包括：正常创建共用生命周期、不同 pid／存储／原生身份、同级左侧条目、右键及工作台入口、忙时快照、在途工具与 owned 任务不转移、同号历史任务引用不越权、必要配置、空初始化、旧分支、重启、迟到响应、只读／remote／generation、原始输入与注入来源继承。最终必须新跑完整 12 项和本轮隔离行为反向，不能引用旧目标结果代替。
