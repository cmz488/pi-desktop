# 对话轮次 SVG 与 Host 任务管理

## 需求与边界

本轮从 `f026d3f4df4fa7500975d347ed815ebc501fc81e` 开始。用户确认：历史节点只允许退回，只有当前位置可创建分支；Host 需要全局监控、等待／取消，并能通过原生 SDK 发起子代理。执行仍由本会话承担，不使用开发子代理。

已有 `release/pi-desktop-extension-0.26.16.tgz` 改动保留，不纳入本轮提交；开工 SHA-256 为 `34a415295c9563888bde8f578974c516e2eddf64f9bd124cadbd0396f44cf5f1`。不修改 node_modules、外部安装包或真实会话。

## 已核对的原生接口

- Pi Durable **1.0.2**：README 的 Conversations／Forks、Abort and Subagents、Child Tasks 与 Task Graph；`dist/harness/types.d.ts` 和 `dist/types.d.ts`。`Conversation.fork(at, options)` 原生支持截至 at 的独立会话；Task 所有权、owned conversation、submission 的准入与幂等、任务调度、取消、检查点和恢复由 Durable 承担。
- Pi SDK **1.0.0**：SDK／sessions／session-format 文档与 sessions／session-runtime 示例；`SessionManager.branch()`、`createBranchedSession()`、`AgentSessionRuntime.fork()` 和 `AgentSession.navigateTree()` 的已安装源码。当前位置克隆对应保留当前上下文的 at 语义；选择非用户消息退回后从该条目继续。
- Desktop 的显示聚合不是上下文投影；实际上下文仍由 Pi `buildSessionProjection` 与 Durable 原生 fork／提交决定。没有重新实现活跃路径、压缩、执行循环或任务调度。

## 第一阶段：按轮次展示与当前位置分支

- 截图中的条目长链来自把所有原生消息／扩展记录直接作为行，并按原始深度缩进。改为 SVG 的轮次节点与有界连接轨道，工具／思考／扩展检查点不再占独立节点；选择后在详情区显示本轮与可用动作。
- 默认最近 10 轮，允许当前浏览器配置 1–200；不删除历史或裁剪模型上下文，退回后仍保留当前位置可见。折叠、滚动、选择和过期身份保护保留。
- 当前位置提供创建分支，历史只提供退回；消息菜单同步门控。底层精确 asOf API 保持原生能力，界面使用 `mode: "tail"` 与可选 `expectedEntryId`，位置变化返回 409，不偷换目标。
- `currentEntryId`／`idle` 是树读模型的追加字段。资源状态卡片没有 entry，不能遮住真实检查点：公开 HTTP 回归加入原生资源卡片后先见 null／21 断言失败，过滤无映射 UI 项后通过。
- Chromium 的 SVG／默认 10 轮断言先失败；修复后覆盖窗口配置、每轮多条工具／思考／扩展记录、整轮退回目标、历史无分支入口、当前位置命令检查点和键盘选择。原折叠、滚动、权限、迟到结果与资源清理断言保留。
- 布局回归通过实际尺寸定位：全局图标规则把 SVG 高度固定为 18 px；仅为轮次图覆盖为 auto 后原滚动断言恢复。未放宽该断言，诊断脚本与日志只在仓库外临时目录。
- 默认 Host／worker 浏览器确认：历史消息分支按钮禁用，先退回 Q1 再从当前位置分支；独立用量、原生身份与源内容不变，退回与分支不重放模型请求。Durable 允许忙碌时的快照分叉，保留该行为与 A/B/A 迟到结果保护，不无故把原生能力禁掉。
- 阶段验证：unit 354／354、check（91 个源文件）、format、实际解包的 npm 产物（180 个文件）、公开树 HTTP、默认分支浏览器、真实 Desktop 读面板、隔离读面板及扩展工作台浏览器通过；浅／深色 SVG 截图已在临时夹具中核对。隔离副本分别取消窗口限制、把工具／助手消息变成轮次、去掉过期检查点校验，三项均命中对应行为断言；还原后 SVG 与 API 回归恢复通过。

## 后续阶段

Host 全局任务监控及子代理发起尚在实现阶段；不能因第一阶段通过而宣称本轮全部完成。原生包没有一键式子代理服务，薄适配将组合原生 task／owned conversation／submission；不引入新的执行器。
