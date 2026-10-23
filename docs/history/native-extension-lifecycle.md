# 标准扩展生命周期衔接

## 重载上下文子阶段

这是阶段 07 的第一项独立修复；输入／消息／边界等完整生命周期验收仍在继续，不能把本页当作阶段 07 或整体目标完成。

阶段 06 的 `7d97c82` 已通过两个标准包的真实原生安装与对照，发现默认 Desktop 的 fresh runner 在 reload 后没有重新绑定：工具调用的 signal 存在，但标准 `ctx.signal` 缺失，`ctx.isIdle()` 也回到了资源会话自己的状态。另外，既有桥覆盖 context 方法时绕过了 SDK 的 stale guard，旧 context 能读取新回合状态甚至执行 abort。

修复保持既有资源 seam：

- Web 宿主用 Pi SDK 的 `reload({ beforeSessionStart })`，在新启动 handler 之前重绑 fresh runner。不重复 emit `session_start` 或再绑定一次扩展。
- 标准 command context 的 `reload()` 也使用同一宿主路径。
- 换会话与重载复用同一个私有展示重置入口，清理状态／streaming／在跑工具并释放旧 widget，防止已卸载扩展的旧状态继续可见。
- context 仍从 Pi 创建；桥只替换 Durable 的值，每次访问继续经过原生 guarded getter。没有修改 SDK／依赖、扩展加载器或执行循环。

## 可执行证据

`test/native-runtime-lifecycle.test.mjs` 在修改前实际失败：旧 `isIdle()` 没有抛出 stale-context 错误；真实重载的 `session_start.hasSignal` 为 false。修改后原断言保留并通过，还验证旧 abort 不调用 workspace、新 context 有 signal、标准命令再次重载无重复命令，以及卸载后状态消失。

测试使用真正的 SDK runner／context 与临时安装的标准包，不用复制的失效标志证明原生失效行为。阶段 06 的原生对照仍保持通过；该基线的历史观察表不改写为本次修复后的结果。

本子阶段验证：`npm test` **448／448**、`npm run check`（109 源文件）、两包独立 TypeScript 检查、本次文件格式／diff 检查、扩展工作台 Chromium 专项通过；真实解包 **221 文件／935 KiB**。既有 Goal、审批、会话与扩展 Node 回归保留。

当前调用契约见[资源会话](../architecture/interfaces/resource-session.md)，原始完整缺口见[兼容基线](../references/pi-extension-compatibility-baseline.md)。

## Durable SDK 提交后边界子阶段

在 `1.0.2` 上实际对照了两条公开路径：`onYield` 可以在原 run 内继续，但当时还没有已提交的助手 entry；提交后再投递能拿到真实 ID，却会留下已经结束的首次答案。不能把另一 submission 或临时内存 ID 当作严格等价的 `turn_end`。用户明确选择当前打补丁、未来 SDK 提供同一接口时自动采用原生能力。

补丁只扩展原生 `pi.generation` 的 definition，模型请求／工具循环和原有 helper 不另写一套。兼容入口先看 SDK 的版本化 capability；无原生接口时只接受 1.0.2 的已核实发布文件摘要。临时 Node loader 仅为这一个内存模块保留原 SDK 的依赖解析 parent，编译后立即撤销；依赖文件内容不变。原 token／definition 身份保留，注册表没有第二个 generation 种类。

新的 turn／settle 决策发生在提交后、结束原 run 前；返回 entry 通过原生 Tx 提交，继续交给原生 generation。v1 检查点经原生 migration 进入 v2，已进入 handler 的检查点恢复则明确失败，不猜测并重放未知副作用。原生 SDK 声明同一 v1 interface 和 migration 契约后优先使用它，不再变换源码；未声明接口的新版本不会被盲目打旧补丁。

`test/durable-boundaries.test.mjs` 的 16 项对照覆盖真实 entry、原 submission 内继续、无伪用户输入、turn／settle 顺序、工具与 terminate、错误／重试和分类变换、排队输入优先级、取消、v1 migration、真实 SQLite 关闭／恢复、已提交 partial、依赖摘要不变及原生／不匹配分支。接口和版本来源见[SDK 边界契约](../architecture/interfaces/durable-boundaries.md)。

整套验证曾在现有 Goal 确认夹具的首次 HTTP POST 出现一次 `UND_ERR_SOCKET`（连接被关闭）；保留 `/tmp/pi-plugins07-sdk-test.log` 的原始失败。单项、完整 Goal／功能文件随后通过，未修改断言；完整重跑通过，最终 `/tmp/pi-plugins07-sdk-test-final.log` 为 **464／464**。这不被记录为已经定位并修复了该瞬时连接问题。

本 SDK 子阶段另通过 `npm run check`（111 源文件）、本次文件格式／diff 检查和真实解包 **225 文件／943 KiB**。Electron 自带 Node **24.18.0** 的一次性 RunAsNode 进程也实际安装并返回 `apiVersion:1 / implementation:patch`，未启动或重启用户桌面端。

该子阶段提供 SDK seam；Pi 生命周期对新 hook 的消费仍在阶段 07 中继续，UI 通用适配和最终验收也尚未完成。

## SDK 边界审查修复

对 `ce9bcaa` 的只读审查实际复现了两项问题：`afterTurn.continue` 能绕过工具 `terminate` 并跳过终止候选的 `beforeSettle`；只注册另一种边界 hook 时，空步骤也被写入 `dispatched:true`，关闭后恢复会误判为未知副作用并失败。

修复保留真实 handler 的中断保护，只在当前步骤确有 handler 时提交分发标记；标记提交仍在 HookRunner 的异常捕获之外，不能将引擎写入错误当作普通插件异常吞掉。工具终止候选不能被 `afterTurn` 覆盖，仍由 `beforeSettle` 决定是否继续。

新增两项回归先在原实现失败，日志 `/tmp/pi-plugins07-review-fixes-red.log`。修改后 SDK 专项 **18／18**；真实 SQLite 分别验证缺失 turn／settle hook 的检查点关闭／恢复，已进入真实 handler 后不重放的旧断言保持。完整 `npm test` **466／466**、`npm run check`（111 源文件）及真实解包 **225 文件／943 KiB** 通过，日志为 `/tmp/pi-plugins07-review-fixes-{green,test,check,package}.log`。

## Durable 会话模型与请求 seam 子阶段

后续核实原生 `beforeRequest` 只能替换 messages，Harness 使用统一 Models；它不能直接承接每个 Pi 资源会话自己的 provider 注册与请求 callbacks。另一个独立缺口是空闲 custom 消息触发 run 时缺少无伪输入准入。用户已明确授权补齐这两类必要 SDK interface；本子阶段先交付请求运行时，不把后者记为已完成。

`modelRuntime` 在原生 generation／compaction phase 内选择当前会话的 Pi AI Models，不合并全局 provider、不创建 Harness 或另一模型循环。解析异常必须向调度器传播。既有 `beforeRequest` 增补 model／options，旧 messages 返回保持兼容；函数 callbacks 只活在当前请求，Durable 的取消 signal 和持久 session ID 不可被覆盖。无 resolver 时保持原模型集合与原生 helper。

新增请求专项的核心断言先在原实现失败，见 `/tmp/pi-plugins07-request-red.log`。请求 **6 项**和边界 **18 项**全部通过，并发同名 provider 走各自集合；原生 compaction、实际模型用量和完整／部分原生声明分支通过。完整 `npm test` **472／472**、`npm run check`（112 源文件）、真实解包 **227 文件／946 KiB** 通过，日志为 `/tmp/pi-plugins07-request-{green,test,check,package}.log`。

当前契约见[请求运行时](../architecture/interfaces/durable-request-runtime.md)。本子阶段当时尚未注册 Pi 资源 resolver／callbacks；完整生命周期仍待阶段 07 验收。

## Durable entry input 子阶段

已核实并补齐另一项获授权的缺口：原 `input` 只能附带用户正文，`write` 不启动 run。新 input 可直接携带 append-only entry，仍走原生 submission／inbox／generation；custom 的模型贡献与原始消息可以存在同一个真实 entry，不合成另一个 `pi.user`。steer／followUp／reject、排队取消、requestId 幂等和首次答案均沿用原生逻辑。

为使准入与所有边界共享该语义，兼容 installer 校验五个原生发布文件的摘要，通过临时内存 module graph 保留其相互依赖，随后立即撤销 loader。公开 Harness 和内建 task／doc 的 token／definition 身份保持；不创建第二个 Harness、writer 或调度器，不写依赖目录。`pi.inbox` 升为 v2 并迁移 v1 排队内容，generation 保持此前的 v2。

两项核心行为先在旧实现失败，见 `/tmp/pi-plugins07-entry-input-red.log`。新增 **8 项**专项通过；真实 SQLite 子进程先以未补丁 SDK 创建 v1 排队输入，再迁移、排队 entry、关闭并二次恢复，验证三个原生回执和无伪用户消息。完整 `npm test` **480／480**、`npm run check`（113 源文件）、真实解包 **229 文件／951 KiB** 通过；Electron Node **24.18.0** 的独立 RunAsNode 进程实际完成安装，未启动桌面 GUI。日志为 `/tmp/pi-plugins07-entry-input-{green,test,check,package}.log`。

当前契约见[entry 输入准入](../architecture/interfaces/durable-entry-inputs.md)。SDK seam 的交付不等于 Pi 生命周期或通用扩展验收完成。

## 标准 input 与空闲 custom 消息接入子阶段

真实 Host 的用户输入现在在模型准入前等待 Pi input handler，消费 transform／handled 和 images；注册命令仍先于 input，模板展开在其后，程序用户消息标明 extension 来源。普通 custom 消息不经过 input；空闲 triggerTurn 使用同一个 entry input 保存原始 custom 和模型贡献，不再额外投递伪用户正文。请求级 seam 同时提供已提交 entries，桥按真实来源识别 custom，不继续按正文猜身份。

新增两个核心断言先在旧实现失败，见 `/tmp/pi-plugins07-input-red.log`。真实原生安装包的三项 Host 对照通过，涵盖输入变换／消费、程序来源、模板顺序、images 改写及 custom 无伪消息启动。首次完整回归暴露既有技能包装被新路径改变；保留失败日志 `/tmp/pi-plugins07-input-test.log`，修复调用方以复用原公开展开入口，未删改技能原文／模型正文的原断言。SDK 显式请求展开的程序路径仍使用其原生技能包装。

原文／技能兼容与新 Host 专项共 **9 项**通过，最终完整 `npm test` **483／483**、check（113 源文件）、两包独立 TypeScript、扩展工作台／只读面板 Chromium 与真实解包 **229 文件／954 KiB** 通过，日志 `/tmp/pi-plugins07-input-{compat,green,test-final,check,browser,package}.log`。

阶段 07 的其他生命周期仍待后续分项验收，不能以这三项输入专项代替。

## System／context 与助手最终消息子阶段

原生 before-agent prompt options 现在交给 SDK 的 loadout／section helper；两阶段 context 使用 Pi Agent 已装配的 transform，保留 hidden declarations 与完整 force 投影。Durable 的请求给出真正 leading system，before-agent 返回的 custom 消息先提交再进入首次模型请求。单独的结构化 prompt 读取不包含 request-local force，避免在后续工具轮次中把临时覆盖记录进 canonical section。助手 message_end 由 SDK 验证同 role、规范化空内容并原位替换，修改后的消息才进入 Durable。

新标准包的三项 Host 断言先在原实现失败，见 `/tmp/pi-plugins07-context-hooks-red.log`；修改后 system override／结构化 section／两阶段 context、before-agent 消息、助手持久替换与后续请求通过，原生对照和加载／重载保持。完整 `npm test` **486／486**、check（113 源文件）、两包独立 TypeScript、真实解包 **229 文件／955 KiB** 通过，日志 `/tmp/pi-plugins07-context-hooks-{green,test,check,package}.log`。

阶段 07 的其余生命周期继续分项实现，不能以本节的 context／最终消息专项代替。

## Provider callback 与标准模型流子阶段

会话资源现在通过 generation／compaction 的 Models resolver 接入原生 Pi Models；只借用 SDK 请求 transport，资源 Agent 的主循环守卫和关闭的 cache warming 保持。headers、payload 修改、响应与 raw provider 事件由原 SDK 调度并等待；标准 assistant stream 传给同一 Durable 请求，message_end 仍在提交前应用 SDK 替换。请求的异步 signal scope 不覆盖工具自己的原生信号或旧 context guard。

五项新增真实 Host／SDK 测试覆盖 headers 与 payload 的实际作用、响应／raw stream、assistant 流顺序和单次开始／提交、取消、重载及资源 Agent 守卫；最初两项红测在 `/tmp/pi-plugins07-model-hooks-red.log`，与原生命周期回归共 **7 项** 通过。最终未插桩全套 **491／491**、check（114 源文件）、两包独立 TypeScript、扩展工作台／只读面板 Chromium、解包 **230 文件／958 KiB** 通过，日志 `/tmp/pi-plugins07-model-hooks-{green,test-final,check,browser,package}.log`。浏览器专项仍不是阶段 08 的两个普通扩展通用交互验收。

首次全套出现一次来源会话文件摘要断言失败，原日志 `/tmp/pi-plugins07-model-hooks-test.log` 保留。一次实际场景文件对照、六个并行隔离复现、带仅诊断文件差异的全套及移除诊断后的最终全套均未重现；未修改原断言，未将重跑表述成根因修复，临时插桩已删除。

阶段 07 的其他生命周期继续分项实现，不能以本节的模型流专项代替。

## 原生已提交边界与快照子阶段

Pi 的 turn／settle 现在消费同一 GenerationTask 已提交边界：先由既有原生转录导出器发布，再取真正的 Pi entry ID 与 Durable 来源映射。初始绑定在工具注册后、session_start 前载入同一 header；原生导入不再靠额外 reload 重放启动。owned／非历史族快照不进入族成员或导航。普通 JSONL 消息与 system 排除的兼容格式保持，文件检查与本 writer 的发布串行，外部 TUI 修改仍拒绝。

原 SDK 负责 handler 顺序、draft 校验和 preview；adapter 只把 private custom／custom_message／context_edit／compaction 转成原边界事务的 EntryDraft。原始记录保留，编辑影响模型上下文；压缩复用原生投影与 Durable head，null 自保留按 SDK 写成自身 ID。每个 handler 后重新完成消息准入并读取 inbox，后续 handler 能看到显式新输入。turn_start 元数据及初始消息顺序、agent_end／before_settle 顺序、turn 与 settle 两种继续保持，取消后的迟到决策不会产生新请求。

新增 **10 项**真实 Host 回归；最初三项与动态 pending preview 分别在 `/tmp/pi-plugins07-native-boundaries-red.log`、`/tmp/pi-plugins07-native-preview-red.log` 失败。无状态工具复现了另一真实责任错误：工具事务直接复制全部 custom，把 Desktop 检查点回灌进扩展状态，独立 MCP 场景累计到约 29 万条／72 MB。现工具与生命周期统一使用 stateEntries，原失败与最小无状态工具回归转绿，诊断插桩已删除；保留 `/tmp/pi-plugins07-native-{state-red,state-green,boundaries-growth}.log`。初始化导入早于工具注册、改变原 JSONL system 格式也由原断言拦住，均已修复而未删除断言。

最终 **501／501**、check（115 源文件）、两包独立 TypeScript、扩展工作台／只读面板 Chromium及解包 **231 文件**通过。日志 `/tmp/pi-plugins07-native-boundaries-{green,test-final,check,browser,package}.log`。中途一次并发全套出现浏览器工具请求 socket 关闭及 Host 已完成委托状态断言失败；定向两项和后续两次全套通过，未将重跑表述成根因修复，原 `/tmp/pi-plugins07-native-boundaries-test-current.log` 保留，Host 断言追加原生 outcome 作为失败证据。

阶段 07 的其余生命周期继续分项实现，不能以本节的已提交边界专项代替。

## 标准工具 pipeline 子阶段

资源工具不再手写 tool_call／tool_result 决策链：按 coding SDK 的依赖位置加载公开 pi-agent-core runToolCall，继续由 Pi 完成准备／验证、门禁、执行、等待 update、结果与图像规范化。adapter 在实际操作上衔接 start／update／end 和工具消息；完整字段和 structuredContent 保留在事件中，tool message_end 替换及 usage 在唯一 Durable ToolTask 提交前消费。工具 context 先获得已发布助手记录及真实操作信号，嵌套调用沿原 SDK 的 callable tools 和父 ID；旧 afterTools 不再重复投递 end。SDK accepting-updates fence 继续丢弃已经结束执行的迟到 update，不污染下一活动。

七项真实安装包／Host 测试覆盖有序增量与字段、block／throw、工具消息替换、usage、嵌套的实际结果和父身份、迟到 update。最初五项红测 `/tmp/pi-plugins07-tools-red.log` 保留。ESM-only core 的 loader 使用公开 package.json 与 import 导出，不修改依赖或依赖顶层提升；懒加载／契约覆盖此入口。独立 tsc 还拦住了夹具的 nested outcome／usage 字段错误，已按真实类型修复并加强结果断言；同时补齐请求准备异常 DTO 必需的 totalTokens，并增加单元断言。

最终完整 **509／509**、check、两包独立 TypeScript、扩展工作台／只读面板 Chromium、解包 **231 文件／965 KiB** 通过；日志 `/tmp/pi-plugins07-tools-{green,test-final,check,browser,package}.log`。

阶段 07 仍须完成用户／system／custom 消息修改、流取消收尾／partial、会话模型目录与动态配置、会话动作和忙时／nextTurn 投递；阶段 08／09 仍未交付。
