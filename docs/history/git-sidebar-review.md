> 历史验收记录：保留原始结论与环境信息，不代表当前版本全部行为。当前说明见 [文献入口](../README.md)。

# 0.11.0 · Git 右栏与 LSP 验收

## 需求与取舍

- 按用户三张 ZCode 截图，将 Git 管理从顶栏按钮／弹窗改成桌面常驻右栏工具卡。
- “审查”显示未暂存／已暂存来源、文件增删统计和单文件懒读 diff；与工具输出／提交页签切换。手机使用右抽屉，不挤压聊天。
- 用户确认先接 JS/TS 和 JSON 的已有语言服务器；手动点击分析，不自动安装、下载或改文件，不接 Rust/C++。
- 不更改 Pi 核心，不新增认证、模型调用或 Agent；不重启、reload、迁移真实宿主。

## 红色反馈与修复

`test/git-review.test.mjs` 用无关 17 MiB 未跟踪文件复现只读状态被写确认额度阻断（422）。读状态现用 numstat 和有界文本计数，大文件仍可显示；写确认只对本次 stage 选择做未跟踪内容指纹，同时保留全仓库状态／元数据、tracked diff、索引、配置与一次性确认。只读缓存戳与写确认指纹明确分开。

浏览器先复现 `#workspace-right #git-tool-card` 不存在、仍有顶栏 Git；现无 git-dialog，常驻卡可进入审查。缺 Git API 不发送 Git 请求，缺 LSP 不展示模拟诊断；静态浏览器逻辑仍位于旧宿主已能提供的 prototype.js。新初始化期间发现读取 UI 就绪需要等待刷新完成而不只是旧文件 DOM 存在，回归改用实际按钮 readiness，同步点不依赖额外延迟。父进程检查另发现 open 的异步读取／动态导入需要固定调用时目标；延迟 `/git stage` 读取并切换会话的浏览器回归在移除保护时真实得到 `1 !== 0`（误发一次准备请求），恢复前后目标检查后为零。

## LSP 实现与边界

固定本地程序＋--stdio，服务器从 PATH 发现，TypeScript 编译器从工作区或本包已有安装解析。真实 initialize/didOpen 与 push/pull 诊断，不执行编辑／修复／任意命令，不提供任意二进制路径或 URL。JSON schema IO 与 TS 自动类型获取关闭，TLS 不放宽。

只分析当前变更中的工作树 UTF-8 文件 ≤512 KiB；明确不是 staged 快照。目标 session/cwd、初始化、可信度和字节 SHA256 前后校验，焦点或文件变化返回 409。两路并发、20 秒期限、1 MiB frame、200 条诊断；完成或关闭时清理自己的语言服务器／Unix tsserver 子进程组。未返回完整诊断／超时不是成功；零诊断也不是编译或审查通过证明。

语言服务器是可信本地工具，不是操作系统沙箱。项目插件可能自行访问文件或执行代码；仅能保证本客户端不应用编辑、不调用模型、不提供下载通道和不安装依赖。Windows/macOS 子进程清理、Rust/C++、完整项目编译尚未验证。

## 验证

- Node：Git 大文件列表、numstat、选中暂存额度／同状态修改；固定 argv、确认有效期、共享锁、无关变更、符号链接和临时 bare 远端。
- LSP 协议：有界 framing、200 条截断、拒绝 applyEdit/schema/executeCommand、不完整报告、并发与关闭。
- 真实服务器：TypeScript Language Server 5.3.0＋已有 TypeScript 5.9.3，返回 2322；JSON 返回 516；文件字节未变，HTTP schema 探针请求为零。
- HTTP：错误目标、未信任、路径范围、语言范围与 native handoff；运行锁下允许只读分析，但焦点／文件变化丢弃结果。
- Chromium：常驻卡和非模态审查、旧 API 零请求、单份 diff 缓存、远端选择、写门禁、提交草稿与换会话隔离、延迟 slash Git 操作不改派目标、手动触发真实 TS/JSON 诊断，明暗对比 ≥4.5，320/360/390px 不溢出。
- 真 PTY／SDK／Electron 43＋Xvfb：命令注册、会话／thinking／Ask User／附件原生同步、new/reload 保持后端与 SSE、关闭前端不停止 Agent。

本环境完整验收通过：83 项 Node 测试（零失败、零跳过），Git 专项 8 项、LSP 专项 5 项，以及真实 TUI／Chromium／Electron 43＋Xvfb。

运行 `npm run check`、`npm test`、`npm run test:git`、`npm run test:lsp`、`npm run test:pi`、`npm run test:browser`、`npm run test:desktop`、`npm run format:check` 和 `git diff --check`。真实服务器不存在的其他环境会明确 skip 对应集成用例，不伪造其验证。

截图在忽略提交的 screenshots/git-review-light.png、git-review-dark.png；使用临时项目与实际语言服务器，不等于手机 OS／公共远端或生产运行验证。源码参考固定 ZCode 29628c9acdb81b703bbd4080c207a0e7ce5e276e，详见 SOURCES.md。

## 交付边界

仅更新本项目文件；未修改个人模型、凭据、配置、Pi 安装目录或当前真实服务。刷新前请保存普通输入与附件；页面刷新只加载 UI，LSP 与新的 Git 读取规则仍需要旧宿主在任务结束后经用户授权更新。
