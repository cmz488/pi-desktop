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

## 第二阶段：原生子代理与全 Host 窗口

- 原生包没有一键式子代理服务；适配用 `defineTask` 的检查点、原子 owned conversation、固定 requestId 的 submission 组成一次委托，调度、模型／工具循环、取消和恢复仍由 Durable 承担。父会话获得 background task 回执，不自动再调用父模型。幂等回执保留在原生 task，不另建内存任务库或队列。
- 每个 Desktop Agent 仍复用自己的 worker／SQLite／writer。受管 owned 子会话只进入 `children`，资源会话按自己的原生 scope 绑定，不能使用父会话的工具闭包；启动恢复先注册已有子 scope。
- Host 增加聚合／详情／管理入口，目标为外层 Agent UUID、存储 generation、内层会话和 task。实际进程转发处再次绑定 generation，避免 catalog 校验与 resume 之间把旧库同号 task 发给新库。管理仅沿原生 owner，不把历史 parent 当权限。
- 读取不启动停止的 worker；单 worker 超时保留局部失败和其他 worker 的原生视图，不把未知状态显示为已完成。只读能力显式裁剪，远程全 Host／worker 请求拒绝，不放宽生产远程 `/api/command`。
- Desktop 增加全 Host 模态窗口：发起表单、按 worker／原生 owner scope 的任务与工具、持久回执和子会话预览。复用既有任务面板与加载器，因此取消确认、等待租约／5 分钟总期限、迟到检查和资源回收只有一套行为；关闭或隐藏只撤销观察，不停止工作。
- 真实恢复测试先失败：子代理运行中重开后父 worker 退出。只在临时夹具观察启动 IPC，得到“请等待 Agent 空闲后修改运行配置”；原因是前台 idle 为真不代表后台／owned 工作结束。启动配置门禁加入原生任务图检查后，同一 task／子会话／submission 恢复，原生 SDK 扩展工具在子 scope 里运行；转录只有一条 user 和一条 toolResult，被中断的生成重发一次，工具后续生成只触发一次。不是存储锁或模型根因，也不是旧 E3 的历史因果证明。
- 真实 Chromium 使用两个 SQLite 的同号 task（均为 #9）：表单选中 B 后取消 A 仍只命中 A，取消等待与关闭均保留 B 的原生工作；结果区读取 completed 回执，readonly Agent 不可发起。初版快速 close／reopen 会借用旧等待：浏览器 close 事件异步到来，而回调观察到新窗口 open。保留同一脚本轮次的反例，重开前先使旧代失效后通过。聚合更新也曾丢键盘焦点，新增真实 worker 使读模型变化后命中断言，再按固定 scope／操作恢复焦点。未把这些产品问题改成延时夹具绕过。
- 新窗口共享任务样式经统一资产清单发布；不引入依赖、工具执行器或额外数据库。详情的消息／工具预算只约束显示预览，不改变原生记录与模型上下文。
- 直接复核发现：任务图 ETag 不随 `pi.live` 片段变化，旧代码只在图变化时拉详情，导致运行中的输出停更。加入两段受控真实 SSE，证明图完全相同而第二段已在原生状态中；界面先红，再在每次读取完成后刷新所选详情，保持单在途与身份检查后通过。390px 窄屏边界和双主题稳定帧也已验证。
- 反向验证先暴露了覆盖缺口：普通 `read` 可由 CodingTools 同名工具兜底，移除恢复注册仍过。改用临时项目中只有 Pi SDK 扩展提供的 `owned_probe`，缺少创建时绑定或恢复注册均命中行为断言；不把旧的不敏感断言计入证据。
- 隔离副本只复制 Git 管理及本轮新增源码，不带运行数据、release 或依赖副本；依赖仅链接复用且未修改。14 项有效反向分别覆盖持久幂等、owned 读模型、原生 background、创建／恢复资源 scope、两层 generation、Host 断连归还原生 32 观察配额、启动恢复门禁、unanswered 不伪作成功、快速重开、图未变的过程更新、键盘焦点、远程拒绝与接口形状。均命中 `AssertionError`，不是语法／启动／纯超时；还原后全部 6 条真实 HTTP 与完整 Chromium 流程通过。
- 阶段证据：`test/host-task-management.test.mjs`、`test/host-tasks-browser-check.mjs`；仓库外 `/tmp/pi-round-host-check/host-*.log` 与 `host-sensitivity.json` 保存红绿、恢复诊断和反向结果。阶段 unit 为 360／360、check 为 94 个源文件、format 与真实解包的 npm 产物（185 个文件）通过；最终全量仍须以当前代码重新执行，不能用旧 `f026d3f` 的通过替代。
- 主会话直接分轴复核：Standards 检查中文顶部契约、具名预算、统一资产、原生资源归属、无新依赖及用户产物保护；Spec 对照默认 10 轮 SVG／当前位置策略与全 Host 发起／监控／管理，复核 owner／历史 parent 分离、固定代际、只读／远程门禁和真实中止／终态。未使用开发或审查子代理。

## 完整回归中的 SVG 夹具适配

`39d2ca8` 上前七项完整命令通过，第八项 `test:durable:browser` 在旧 `.is-abandoned` 查询失败。实际 DOM 测量为三个 SVG `g` 轮次：draft A 是当前位置，失败请求与恢复提问均仍显示为 `data-active:false`。缺的是旧 DOM 属性，不是历史路径；旧 `data-leaf`、HTML `.click()` 与“退回后条目行数必变”也不再描述轮次界面。

只更新 `test/durable-browser-check.mjs` 的展示与输入适配，没有改产品 JS／CSS 或屏蔽历史断言：断言具体的已放弃恢复轮次仍在、唯一当前位置与可见标记、SVG 折叠及滚动保持；历史轮次无分支按钮，选中后退回移动当前位置但不删除轮次。任务等待／两步中止／后台取消／跨 Agent 语义全部保留。修正后专项通过；隔离副本抹掉 inactive 标记、重新给历史轮次 fork 动作，分别命中行为断言，还原后完整专项恢复通过。该两项反向另存 `durable-svg-sensitivity.json`；不把原失败日志算作完整通过。
