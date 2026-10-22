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
