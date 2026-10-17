> 历史验收记录：保留原始结论与环境信息，不代表当前版本全部行为。当前说明见 [文献入口](../README.md)。

# 0.15.0 · 复用原 Pi Desktop 的 Durable 验收

## 交付

默认 `npm run desktop`／`pi-desk` 由 Electron 持有 Durable Harness，`npm run web`／`pi-web`／`pi web` 使用同一宿主。继续使用原 `prototype.html/css/js`、`createDeskBridge`、聊天、设置、插件市场、Git 右栏与手机布局；只新增 Agent 配置和目录选择。移除先前新增的 `desk.html`／`desk.css`／`desk-ui.mjs`。显式本机 URL 与原 TUI `/desk` 保留附加模式。

任意可访问目录中创建多个 Agent，配置独立模型、思考等级、工具、Durable 扩展、Shell、环境与额外指令。普通消息、模型生成、工具调度、排队／引导、停止、压缩与恢复均使用 Harness。SQLite 保存对话、任务、requestId 与 Documents，一个存储只允许一个 owner。配置 revision 与运行任务在同一提交线上检查，view 读取后 dispose。

原生资源 Adapter 复用现有 `startWebSlot` 的资源加载、ExtensionAPI、MCP、Codemode、Tool Search、技能、模板、包管理和交互；使用本包内嵌的 SDK，不要求全局 Pi CLI。SDK 只持有 in-memory 的资源上下文，禁止模型请求，普通聊天不会送入第二个 Agent loop。Codemode 的核心工具调用使用当前 Durable ExecutionEnv。Tool Search 的真实 loadout 变化写回 Durable。原生工具没有 replay 契约，崩溃后不会自动重放。

原 Todo 插件的实际快照与 custom entries 存入 conversation-scoped Document，支持嵌套调用、重开与分叉。Ask User 和插件启动交互复用既有 UI；初始化时 HTTP 保持可访问，生成等待资源就绪。退出前取消 UI 等待，再关闭 Harness 和资源运行时。

完整 Git 管理、手动 LSP、附件、设置、包市场、认证与二维码沿用既有模块及确认机制。提供商与新增认证写入 Desktop 目录，读取原 Pi 配置，不回填秘密。全局运行策略重载到 Harness，项目资源设置仍由原生加载器处理。

每个 HTTP 请求用 AsyncLocalStorage 捕获目标 Agent，没有全局显示 focus；前端立即切换草稿，后台完成与迟到响应不清空其他 Agent 的草稿。MCP 延迟注册与默认工具同步按资源宿主串行处理，手动工具子集在重载与重开后保持。

## 实际验证

- `npm test`：129 项全部通过，无失败或跳过，包含新增的手机远程连接回归。
- `test:durable`：15 项通过。真实 MemoryStorage／SQLite 验证并发、cwd 隔离、请求去重、配置冲突、文件读写、Shell 环境、Registry 替换、分叉、重开、第二 owner 拒绝、秘密脱敏、同源 HTTP、SSE、IPv6 和真实模型请求代理。
- 新增真实插件验收：Todo 和 Codemode 嵌套更新／恢复、Ask User 回复、实际 stdio MCP、Tool Search 加载 deferred 工具并调用、附件、原生设置、二维码、临时 Git 预览／确认／提交与提供商登录。另验证新建 Agent 的环境／工具子集、重载／重开、等待 Ask User 时关闭，以及插件初始化交互。
- `test:durable:browser`：Chromium 使用原页面创建两个项目 Agent，验证独立草稿、后台流式完成、配置表单和 320／360／390px 布局；额外验证空正文 `fetch failed` 显示及后续正常回答。截图：`/tmp/pi-durable-desk-desktop.png`。
- `test:durable:desktop`：Electron 43 + Xvfb 的真实 managed 窗口、隔离 preload、目录选择能力、SQLite、关闭后 HTTP 结束与再次恢复同一 Agent。
- `test:durable:recovery`：真实子进程 SIGKILL 后，lease 过期再开同一 SQLite；safe 工具从一次变两次，unsafe 工具仍为一次，中断结果进入对话，生成继续完成。
- `test:pi`／`test:browser`／`test:desktop`：原 TUI、PTY、多会话、原生模型与思考、Ask User、附件、设置、MCP、包市场、Git 与 Electron 附加生命周期回归通过。
- `check`／`format:check`／`git diff --check` 通过。

模型使用官方本地 faux provider 或原测试的本机 SSE；认证、项目、资源配置和仓库使用临时夹具。没有调用真实外部模型、操作真实远端、推送或发布；没有重启、reload 或迁移现有真实 TUI／手机服务。

## 2026-10-04 · 用户消息无回答修复

实际运行的 Agent 已记录用户消息，但模型请求均以空正文的 `fetch failed` 结束。Durable 新宿主漏掉原 Pi 的网络初始化，未把代理和超时配置接入模型请求；原页面还会过滤掉没有正文的失败回答。修复在 Harness 启动前复用内嵌 SDK 的 dispatcher，并将请求错误和中断状态投影到原聊天界面。

先建立本地 HTTP CONNECT 代理和 SSE 模型夹具：修复前代理收到零请求且回答失败，修复后真实 Pi AI／Durable 调用得到 `proxy answer`。同一回归也在 Electron 43 + Xvfb 下通过，运行命令为 `PI_DESK_NETWORK_ELECTRON=/usr/bin/electron43 node --test test/durable-network.test.mjs`。浏览器回归先复现错误被隐藏，再验证错误提示和下一次回答。外部连通性只用无认证 HEAD 探针：初始化前连接超时，初始化后模型端点返回 HTTP 405；未发送真实聊天请求。当前已运行的宿主需重开加载修复，既有记录保留。

网络依据为内嵌 SDK 的 `core/http-dispatcher.js`、Pi AI 提供商实现，以及 [Electron net 文档](https://www.electronjs.org/docs/latest/api/net/)和 [Undici EnvHttpProxyAgent 文档](https://github.com/nodejs/undici/blob/main/docs/docs/api/EnvHttpProxyAgent.md)。Chromium 页面与 Node 模型请求使用不同网络入口，桌面渲染日志不能代表模型请求状态。

## 兼容范围

Pi Durable 是实验框架，当前依赖范围 `~1.0.2`，原生 SDK 1.0.0；升级通过集中 Adapter 和契约门禁验证，不能保证未知破坏性版本自动兼容。旧 CLI JSONL 不自动迁移到 SQLite；TUI 附加模式继续使用原存储。第三方自定义 TUI 控件以及依赖原生模型循环的 hooks 没有通用 Durable 适配。

Durable 的 compaction/retry 等运行策略目前是 Harness 级；项目资源设置不等同于项目级 Harness 策略。TUI 显示、终端主题与缓存预热仍属于原生 Pi 设置，资源 Adapter 不请求模型预热。

NodeExecutionEnv 是本机权限，不是 OS 沙箱。Shell 环境可能含秘密，存入 SQLite；清单仅显示变量名。实际 OAuth 外部登录、macOS／Windows 与真实手机未实机验证，手机验收为 Chromium 宽度模拟。
