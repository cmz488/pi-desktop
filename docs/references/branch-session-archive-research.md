# 分支 JSONL 与独立归档能力调查

## 范围与版本

本次仅调查，不实现独立分支归档，不操作个人配置、真实会话或现有安装。受查功能源码为 `ac8fba07d40eeea108979e9733bd64f1004f90f3`，tree 为 `13b49060b36322fb6f58b0263051bcc9068b4270`；实验均使用临时默认 Desktop Host／worker、本地假模型和既有公开 HTTP。此次只追加研究文献，不改变运行时契约。

分别验证仓库依赖 Pi SDK `1.0.0`／Pi Durable `1.0.2`，以及只读链接已安装依赖的隔离源码副本 Pi SDK `1.3.0`／Pi Durable `1.0.4`。安装目录的 `pi-session-storage.mjs`、`family-archives.mjs` 与受查源码字节相同；这不是对真实安装实例或用户某条分支的现场验证。

## 结论

1. 含消息的历史分支已有独立 Pi JSONL 和稳定的原生 session ID，仍与根会话共用一个 worker／Durable SQLite／writer。缺少独立归档菜单不是因为分支未持久化。[转录族](../../src/session/native-transcript-family.mjs)、[默认 worker 接入](../../src/server/durable-server.mjs)
2. 默认目录为 `~/.pi/agent/sessions/`，不是仅单数 `session/`；项目同时兼容旧目录。已复现根文件在 `session/`、新分支在 `sessions/` 的混合布局，不能只查其中一个目录。[目录选择](../../src/session/pi-session-storage.mjs)
3. 现有 Agent 归档已经包含根与历史分支；独立分支归档尚未实现。底层文件归档 adapter 可以复用，但整族恢复策略、分支持久管理状态和转录导出生命周期都需要接入，不能只复制菜单或移动 JSONL。[族迁移](../../src/control-plane/family-archives.mjs)、旧工作区页的分支菜单（该页面已删除）

## 文件位置与生成时机

这里的分支指左侧 `fork` 创建的独立 Durable Conversation。同一会话 `rewind` 留下的旧路径仍在该会话自己的原生树／JSONL 中，并不是每个轮次节点或树内路径各有一个文件。[分叉与原生树同步](../../src/server/durable-server.mjs)、[原生 leaf 移动](../../src/session/pi-session-storage.mjs)

默认 `agentDir` 来自显式选项、`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`；默认 Desktop 数据目录为 `<agentDir>/desktop/workspace`。[Host 默认路径](../../src/control-plane/server.mjs)

```text
<agentDir>/sessions/--<编码后的工作目录>--/<timestamp>_<nativeSessionId>.jsonl
<agentDir>/session/--<编码后的工作目录>--/<timestamp>_<nativeSessionId>.jsonl  # 旧布局

<Desktop 数据目录>/agents/<Agent UUID>[/resume-<generation>]/native-sessions.json
```

`native-sessions.json` 的成员包含 `id`、`path`、`nativeSessionId`、名称与来源摘要，`path` 指向实际原生文件；它是归属清单，不是上下文数据库。旁边的 `branches/<conversationId>/native-session.json` 是单分支同步元数据目录，不能据此推断 JSONL 也放在那里。族成员只沿历史 `parent` 递归收集，不沿任务 `owner` 收集工具子会话。[原生转录族](../../src/session/native-transcript-family.mjs)、[代际与归属](../../src/control-plane/session-families.mjs)

`openNativeTranscript()` 使用 Pi `SessionManager` 投影转录；只有已经存在原生 `message` 条目时才保存 JSONL。尚未发消息的初始化空会话可以有已发布的原生身份／目标路径，但文件尚不存在。含继承消息的分支在创建后的转录同步中就会写文件，不必在分支再发一轮；仅继承用户消息、尚无助手回复的分支也已验证落盘。默认 worker 的 fork 成功返回前会等待族同步，流式观察及关闭还会继续同步已提交内容；这不等于每个流式 token 都独立落入 JSONL。[保存门槛与原子写入](../../src/session/pi-session-storage.mjs)、[命令同步](../../src/server/durable-server.mjs)

### 旧目录为何可能漏查

`sessionRoots()` 只有在旧 `session/` 存在、标准 `sessions/` 不存在时才选择旧目录；否则选择标准目录。`nativeSessionDirectory()` 为复用 Pi 的工作目录编码而调用 SDK `getDefaultSessionDir()`，后者会创建标准目录。于是首次选择旧目录后，下一次创建分支可能转而选择标准目录。

两套依赖均复现：根 JSONL 位于 `session/--tmp-…-project--/`，分支 JSONL 位于 `sessions/--tmp-…-project--/`。现有整族归档／恢复能够处理该混合布局，但本次未修正目录选择副作用，也未判定真实用户会话是否命中此条件。实际定位应以归属清单中的 `path` 为准。[目录 adapter](../../src/session/pi-session-storage.mjs)；上游一手实现为已安装 `@earendil-works/pi-coding-agent@1.3.0/dist/core/session-manager.js` 的 `getDefaultSessionDir()`。

## 现有归档框架的实际边界

`agent.archive` 的目标是外层 Desktop Agent；运行中返回 409，空闲但仍存在 worker 也不能归档。停止后，`createFamilyArchives()` 对根与已登记分支逐一调用 `openSessionArchives()`。后者先把完整原始 JSONL、摘要、原路径和阶段可靠保存到 Host 的 `session-archives.sqlite`，再迁移原文件；恢复保持原生 ID、验证内容并拒绝覆盖冲突。Durable SQLite 原位保留，不是把整个 Agent 目录打包迁出。[主管门禁](../../src/control-plane/supervisor.mjs)、[归档存储](../../src/session/pi-session-storage.mjs)、[族恢复](../../src/control-plane/family-archives.mjs)

隔离实验向 `agent.archive` 额外传入一个分支的 `conversationId`，结果仍是三个族成员全部归档；附加参数不会收窄这个 API 的目标。随后整族恢复的三份文件摘要与归档前完全一致，启动后的原生身份和路径也保持一致。

当前左侧分支菜单只提供创建分支；归档／恢复仍是 Agent 级入口。上轮为避免把进程级操作错误施加给分支而隔离了菜单，这留下的是独立分支管理的功能缺口。旧工作区页的菜单实现（该页面已删除）、[上轮边界](../history/sidebar-branch-ui.md)

### 为什么不能仅归档一个文件

两套依赖分别验证了以下两个不同后果：

- **只复用文件 adapter，使用隔离归档库**：运行中的 worker 即使空闲仍持有分支文件写锁，直接归档返回 409。停止后可以只保存并移除该分支文件，父文件保留；但分支仍在清单中，重新启动会从完整 Durable 历史再次导出 JSONL，原生 ID 不变。文件归档本身没有归档原生会话。[文件锁与导出](../../src/session/pi-session-storage.mjs)、[无独立归档过滤的族同步](../../src/session/native-transcript-family.mjs)
- **直接复用现有族内记录键和同一归档库**：在停止 Host、释放唯一写者后，仅归档 `${agentId}:branch:${nativeSessionId}`；重启 Host 时，现有恢复逻辑将其解释为未完成的整族归档，继续归档根文件并把整个 Agent 标记为已归档。必须区分迁移作用域，不能让独立分支意图混入整族恢复。[阶段推断](../../src/control-plane/family-archives.mjs)、[启动恢复](../../src/control-plane/supervisor.mjs)

本次核查的 Durable `Conversation`／`Harness` 公共接口没有可直接转发的 `archive`／`restore` 方法；`ConversationRecord` 只记录不可变身份、历史 `parent` 和任务 `owner`。可通过原生提交保存应用管理状态，但它不会自动替应用实现归档生命周期。依据两套已安装包的 `dist/harness/types.d.ts`、`dist/types.d.ts` 和 `README.md` 的 “Your Own State”／“Storage”，不推断其他版本也没有相关能力。

## 后续接入条件，而非本轮实现

可复用现有 JSONL 校验、锁、摘要、可靠保存、冲突保护与阶段恢复；无需另建上下文算法、执行器、worker 或复制 Durable 数据库。独立分支管理至少还需要：

- 独立命令／明确作用域，固定 `agentId + generation + conversationId`，核对当前代际、历史成员身份、原生 ID 与权限，不能冒用 `agent.archive`。
- 可持久恢复的分支归档状态和意图；转录导出器、发现器、导航与归档清单都识别该状态，防止重新导出、误注册或整族恢复误判。
- 继续要求停止所属 Agent、退出持有记录的 Pi TUI，不把空闲、隐藏、关闭观察或移走 JSONL 当作停止执行。若存在未结算任务，必须明确拒绝／处理策略，不能把归档当作隐式中止或暂停。[原生任务与恢复边界](../../CONTEXT.md)
- 保留 Durable 历史及 `parent` 关系，不物理删除仍被其他分支继承的会话；明确是否连同后代归档，以及整族恢复如何对待此前单独归档的成员。

上述是可行性约束，不是已授权或已实现的新 API。若继续实施，仍须先确定语义，再走 TDD、隔离反向验证和新的完整验收。

## 本轮验证与限制

- 两套依赖各完成 4 组临时实验：独立文件与整族归档、单文件重新导出、旧目录混用及跨目录归档恢复、族内单文件迁移被整族恢复补完。
- 既有 15 项专项通过：`desktop-branch-family.test.mjs`、`native-transcript-family.test.mjs`、`session-family-ownership.test.mjs`、`desktop-archive-liveness.test.mjs`，包含中断续完、冲突不覆盖和全部写锁释放。
- `npm run check`（94 个源码文件）、`npm run format:check`、默认分支 Chromium 专项及 `npm run package:check` 通过；实际解包 187 个文件，验证 Host、资源与文献链接。回执为 `verification-results.json`，源码／release 指纹保持不变的核对为 `post-verification.json`。
- 证据与诊断脚本：`/tmp/pi-branch-archive-investigation/`，两套结果分别为 `repo/results.json` 与 `installed-deps/results.json`；源码／脚本指纹及安装模块比较见 `source-evidence.json`。
- 探针最初将轻量目录省略的 `archived: false` 当成显式字段，并在异步 Host 恢复提交前立即读取结果；改为按真实 DTO 语义检查并等待有界恢复条件后，两套实验通过。未为这些探针问题修改产品代码，也不把早期失败计作产品反向验证。
- 本轮不是新功能的完整 12 项验收，不复用上轮结果声称独立分支归档已经通过。未读取真实会话正文、归档真实数据、安装、重启应用或写入两份既有 release 包。
