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
