> 目录整理前的完整资料快照；历史说明可能已被取代。当前文献见 [入口](../README.md)。

# Pi Desktop · 0.26.3

默认入口现在是多项目、多进程工作空间。Electron 管理独立 Host；Host 管理多个项目的 Pi Agent 进程，每个 Agent 使用独立 Pi Durable Harness，执行日志使用 SQLite，活跃会话同步保存在 Pi 原生 JSONL 目录。桌面与 Web 共用控制层和原聊天／设置界面，无需先启动 TUI。DeepSeek Harness 官方 Desktop 源码已下载到 `.reference/deepseek-harness`，参考版本记录在 [upstream-sources.json](../references/upstream-sources.json)。

活跃对话使用 Pi 的 `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`，Desktop 新建的记录可由原生 Pi 读取；存在 `session/` 的安装也会被发现。会话树按 Pi 的 `cwd` 合并项目，支持最近更新、置顶、搜索及归档筛选。归档先将完整 JSONL（含分支、工具状态与用量）可靠写入 Desktop 数据目录中的 `session-archives.sqlite`，默认隐藏；归档成功后移除原 JSONL，Pi TUI 的会话列表也会隐藏该记录；归档查看只读取 SQLite。恢复将完整记录原子写回原目录／文件名，保持 Pi session ID 不变，原路径已有不同记录时拒绝覆盖。Desktop 进程仍在运行（即使空闲）或检测到 Pi TUI 占用时不允许归档，必须先手动停止／退出。

「在 Desktop 中继续」通过 Pi SDK 解析原上下文，并交给既有 Durable 执行链；新消息回写同一个 Pi JSONL，原 session ID 保持不变。Linux 进程检查、Desktop 写锁及文件指纹拒绝已检测到的并发写入；Pi TUI 不遵守 Desktop 写锁，接管后不要在另一 TUI 中继续同一文件。外部修改时可停止 Desktop 进程，再用「接管 Pi 最新记录」导入最新分支；旧执行日志保留在 Agent 的先前 SQLite 目录中。

远程按需传输：导航只获取项目／会话／人格索引，编辑人格时才获取 AGENTS.md 正文。只连接当前选择的会话；默认读取最近 50 条消息，较早记录点击加载，思考与工具结果展开时才获取正文。模型、插件、Skills、MCP、设置和浏览器内容在打开对应菜单／面板时读取。手机右侧文件栏只读取当前目录的名称索引，点击文件后 Host 才返回该文件预览，不递归上传整个项目。JSON／静态资源优先 Brotli，兼容 gzip；未变化的 GET 返回 304，私有响应仅暂存于页面的有界内存中，不进入共享缓存或本地持久存储。SSE 保留即时 gzip 刷新与 TLS 证书校验。

## 最小实现：多项目与独立 Agent 进程

```bash
# 从仓库生成可安装的 npm tarball（prepack 会先执行源码检查）
npm pack
# 安装这个 tarball；默认命令打开 Electron Desktop
npm install --global ./pi-desktop-extension-0.26.3.tgz
pi-desktop --port 4318

# 保留纯 Web 服务入口；--port 指定 HTTP 服务端口
pi-web --port 4319
```

从源码开发时运行 `npm ci`，再执行 `npm start -- --cwd /你的项目 --port 4318`。`npm start`、`pi-desktop` 和兼容别名 `pi-desk` 默认启动 Desktop；`pi-web`／`npm run web -- --port PORT` 只启动 Web 服务。Desktop 仍可通过 `--port` 固定本机 Web Host 端口，未指定时由系统分配可用端口。

网络代理在「设置 → Pi 配置 → 网络 → HTTP 代理」配置，必须填写完整 URL（例如 `http://127.0.0.1:7897`）。该字段使用 Pi `SettingsManager` 的全局 `httpProxy`，保存到 `~/.pi/agent/settings.json`（自定义 `--agent-dir` 时使用对应目录）；Pi 原生 dispatcher 只在 `HTTP_PROXY`／`HTTPS_PROXY` 未设置时采用该值，因此已有环境变量优先。各 Agent 进程需重启后读取新配置，HTTPS 证书校验保持开启。

Node ≥24.21。Electron 安装脚本会下载运行文件；已有系统 Electron 可通过 `PI_DESK_ELECTRON` 指定。当前机器已验证 `/usr/bin/electron43`，Pi Durable 1.0.2 与 Pi coding SDK 1.0.0。

手机断线恢复优先按事件游标续接；回前台或切换网络会取消旧的状态读取，立即尝试恢复。状态读取／建连各有 8 秒超时，SSE 心跳静默 35 秒会重建连接，失败重试从约 250 毫秒递增至最多约 4 秒（带小幅抖动）。独立状态请求失败不会拆掉健康的事件流；授权失效会明确提示重新扫码，不继续无限重试。手机草稿保留，消息差距或 Host epoch 变化时才重同步。此客户端更新只需刷新手机页面，不需重启 Host 或重新扫码。

扫码凭据只在登录成功后从链接中移除；连接中切换桌面／手机预览并重载可继续配对。已授权的手机重新打开扫码页会复用 Cookie，保留选中的会话，不重复占用设备名额。重复扫码或切换预览不轮换二维码；显式撤销／刷新二维码、重启 Host 或连接故障仍撤销旧授权。

远程入口使用严格 HTTPS 校验；tailscaled、Pi Desktop 启动的 Tailscale CLI／用户态守护进程与 `*.ts.net` Funnel 公网探测均清除代理环境变量并直连。普通公网 HTTPS 请求仍遵循 `HTTPS_PROXY`／`https_proxy`／`NO_PROXY`。首次 Funnel 公共 DNS 更新可能需要最多 10 分钟，验证期间可取消且不显示二维码。Linux 上可先执行 `bash scripts/configure-tailscale-proxy.sh --check` 验证控制面和最近 DERP 区域的直连 HTTPS，再由用户在自己的终端运行 `bash scripts/configure-tailscale-proxy.sh` 清除 tailscaled 的代理环境变量并重启该服务。该脚本需管理员授权，只调整 tailscaled，不添加 CA 或关闭证书校验；详情见 [远程连接验收记录](remote-access-review.md)。

1. 打开 Desktop 即进入无项目对话；点击 Pi 标志返回默认对话，点击「新会话」创建并启动另一个独立会话。无需选择项目。
2. 左下角设置统一管理 Pi Desktop 全局配置。插件／扩展、Skills 与模板由 Pi 原生资源加载器读取，不再提供项目／会话的自定义注入配置。Pi 原生项目资源与 AGENTS.md 的发现规则继续生效。
3. 「设置 → 人格与提示词」编辑全局 `~/.pi/agent/AGENTS.md`（使用 `--agent-dir` 时对应该目录）。保存前检查全部 Agent 空闲，保存后重载运行中的原生资源。可选人格保存在 `workspace/personalities/<UUID>/AGENTS.md`，输入框上方选择后通过 Durable `configure.instructions` 追加；JSON 清单只保存名字和身份，旧提示词文本兼容读取，编辑后写入 Markdown。外部编辑受内容 revision 保护，Pi 的 AGENTS.override.md 优先级保持不变。
4. 左侧添加项目，点击项目旁 `＋` 创建并启动 Agent。切换保留后台进程、事件流和草稿；聊天「停止」取消任务，右键「停止进程」关闭 Agent，「重启进程」打开同一 SQLite。关闭 Desktop 清理 Host 和 Agent，重开恢复期望运行的进程；单个进程崩溃不影响其他 Agent。
5. 插件管理器保留单个更新，并新增「全量更新」，复用 Pi `DefaultPackageManager.update()`，相当于 `pi update --extensions`；`pi update --extension <source>` 为单个更新。全量按钮更新用户范围声明，遵循固定版本；不更新 Pi 本体、不解除固定版本、不自动重载插件。确认绑定原生清单和已安装版本，写入期间禁止各 Agent 新任务或并发配置变更。
6. 「设置 → 远程连接」开启 Tailscale Funnel。进入远程连接页会自动准备 Tailscale：优先复用系统服务，否则启动独立的用户态 tailscaled 并在 Desktop 存活期间维护。电脑安装 Tailscale 后，首次完成账号登录及 HTTPS／Funnel 授权即可显示二维码；手机只需浏览器扫码，无需安装 Tailscale 或连接相同 Wi-Fi。手机进入电脑选中的会话，并能在同一多项目工作空间切换、操作 Agent。公网入口验证成功才生成二维码；停止或撤销连接立即使旧二维码、Cookie 和 SSE 失效。远程客户端不能管理发布或获取二维码密钥。

设置视图会自动收起项目侧栏，返回会话后恢复手动收起状态。品牌右侧的侧栏图标取代 LOCAL，可收起导航；收起后从聊天顶栏恢复。工作区的视图按钮提供 DSH 同样的三组选择：工作区／目录树／全部会话，自定义／最近更新顺序，以及隐藏／显示／仅显示归档。自定义顺序通过会话右键的上移、下移调整。Desktop 添加工作区直接调用 Electron 系统文件夹选择器，取消不修改清单；Web 仍通过项目目录表单绑定服务端工作区。

右侧是通用工作区浏览器：新标签页、网址／搜索、网页、文件、改动和工具输出。Desktop 与 Web 共用由 `pi-agent-browser-native@0.9.5` 驱动的 Chromium 页面；每个 Agent 使用独立浏览器会话和 profile，Agent 的 `agent_browser` 工具与右侧标签、画面、鼠标键盘操作指向同一页面。实时画面经现有鉴权 HTTP 入口传输，手机也能查看与接管，CDP 与上游 WebSocket 只留在本机。保留证书校验与 Pi 的三档审批，停止 Agent 时关闭浏览器。Linux 自动使用系统 Chromium，可通过 `PI_DESK_CHROMIUM` 指定；其他平台可运行 `npx agent-browser install` 安装 Chromium。添加项目会打开系统文件夹选择器；Linux Web 入口需要 Zenity 或 KDialog，手机端提示在电脑选择。项目文件预览只接受当前 Agent 根目录中的相对路径，拒绝越界与外部符号链接，目录限 500 项、文本限 512 KiB、图片限 2 MiB；HTML 作为文本显示。无项目会话可通过本地文件选择器预览文件。Git 工作树、提交、历史和管理集中在改动标签中，沿用既有确认与执行模块。输入框单行时保持紧凑，随内容增长至 120px；切换侧栏、设置或标签不重建聊天 iframe。

侧栏采用 DSH 的文件夹与会话导航，提供搜索、最近五项／展开其余、置顶、重命名和可恢复归档；项目与会话通过右键或 `⋯` 管理，设置保持在左下角。SVG 图标直接适配 DSH 源码，保留 Pi 配色与标志，许可证见 [NOTICE](../../NOTICE)。

输入区上方选择项目与系统提示词。选择项目会创建该范围的独立会话，复制草稿与已读附件，原会话及历史保留；「添加系统提示词」创建可复用配置，追加到 Pi 原生系统提示词，通过 Durable `configure.instructions` 应用。底部 `＋` 复用原附件校验；模型按钮直接显示当前模型与思考强度，点击在输入框上方展开 DSH 两级菜单，支持提供商分组、模型搜索、方向键与 Escape；切换沿用 Pi 原生 API，不弹出设置窗口。

权限选择提供「全部请求确认」「高风险请求确认」「YOLO」，新 Desktop 会话默认高风险确认。策略作为 Pi 原生扩展使用 `tool_call` 和 `ctx.ui.confirm`，覆盖 Codemode 嵌套调用与 MCP。高风险模式默认放行常规读写和开发命令，对 `rm`、`rmdir`、`git clean`、强制重置、文件系统格式化及明确标记为破坏性的扩展工具请求确认；普通文件写入不会反复打断工作。拒绝、关闭确认或停止任务均不批准调用；每次批准仅对本次调用有效。权限等级在会话清单持久保存，运行中不可更改；YOLO 不扩大无项目会话的只读工具范围。原单进程兼容入口可通过 `approvalMode` 显式开启策略。

输入框下方显示上下文占用／容量、会话累计 Token、费用和缓存命中率。点击用量胶囊展开输入、输出、缓存读取和缓存写入明细；数据来自 Pi Durable 持久账本，切换或重启不清零。上下文与累计用量分开，压缩后未收到新响应时显示待确认，新增消息的估算以 `≈` 标明。

无项目会话使用独立上下文目录，不读取项目根目录的 AGENTS.md，也不加载第三方扩展代码。模型仅可调用 `read`、`web_search` 和 `web_fetch`：可通过绝对路径读取项目外的文件，默认不允许写入、修改、删除或 Shell。权限同时由 Registry 工具清单和只读 ExecutionEnv 限制，不能通过 Agent 配置开启编辑工具或变更 cwd；应用保存会话和用户显式操作插件配置仍可写入其数据目录。这是应用工具权限边界，未引入 OS 沙箱。

网页搜索使用 DuckDuckGo，网页读取使用有超时和大小限制的 HTTP GET。它们沿用 Pi HTTP dispatcher 和代理设置；网络、站点限流或验证码会影响搜索可用性，网页内容仅作为不可信资料。界面采用 [pi.dev](https://pi.dev) 的画布／表面配色与官方三色 SVG 标志，顶栏可切换明暗主题。

「插件」页可从 npm、Git 或本地来源安装，检查更新、更新、启用、停用和卸载，保留原生资源过滤。修改后点击「重载并应用」；其他运行中的项目 Agent 也需要分别重载。无项目会话提供用户范围的插件管理，第三方工具只在项目 Agent 中运行。修复了本地插件来源保存为相对路径后的更新／卸载解析。

默认数据在 `~/.pi/agent/desktop/workspace/`，也可用 `--data-dir` 指定：

```text
workspace.json                  # 项目、Agent、人格元数据与期望启停状态
personalities/<UUID>/AGENTS.md   # 可选人格提示词
agents/<Agent UUID>/agents.sqlite # 每个 Agent 独立的对话、任务与工具状态
agents/<Agent UUID>/context/     # 无项目会话上下文（不绑定项目根目录）
agents/<Agent UUID>/models.json  # 该 Agent 的模型配置（继承 Pi 配置）
agents/<Agent UUID>/auth.json    # 该 Agent 新增的认证（继承 Pi 认证）
```

这是本地开发 MVP：尚未制作安装包、自动升级或插件私有配置的通用协议；多进程模式监听本机，通过 Tailscale 鉴权网关远程访问。原生包安装、启停和资源过滤继续使用 Pi 管理器；用户范围的资源设置会被多个 Agent 读取，修改后需要重载对应 Agent。旧项目／Agent 注入字段保留在历史清单中，但不再追加到运行时；资源路径请使用全局 Pi 设置。多个 Agent 进程并不是 OS 沙箱或独立 npm 环境；第三方依赖 Pi 原生模型循环的 hooks 仍需专门适配。旧 `desktop/agents.sqlite` 不自动迁移，可继续从下述单宿主入口访问。

验证：`npm run check`、`npm test`、`npm run test:workspace:browser`、`npm run test:workspace:desktop`。架构和职责见 [DESIGN.md](design-evolution.md)。

## 原单宿主 Durable 模式（兼容入口）

```bash
cd /home/cmz488/.pi/design/pi-desktop
npm ci --include=dev --ignore-scripts
npm run desktop -- --single-process
# 指定初始项目、隔离存储、加载 Durable 扩展
npm run desktop -- --single-process --cwd /你的项目 --data-dir /你的数据目录 --extension ./examples/desk-extension.mjs
# 原页面也可以通过浏览器和手机连接
npm run web -- --single-process --host 0.0.0.0 --port 4318
```

提供 `pi-desk`／`pi-web` 入口；已有 PATH 适配器的 `pi web` 进入工作空间，更新适配器用 `npm run install:launcher`。单宿主模式默认回环地址和随机端口；远程连接页面使用 Tailscale Funnel 生成公网 HTTPS 二维码。手动 HTTPS 支持 `--tls-cert PATH --tls-key PATH`，手动监听／TLS 参数需要 `--single-process`；默认多项目入口使用设置中的 Funnel 网关。

点击“新会话”选择任意可访问目录；每个 Agent 是独立 Conversation，可以配置目录、模型、思考等级、工具、扩展、额外指令、Shell 和环境变量。多个 Agent 并行运行，切换页面不停止后台工作；每个客户端独立选择 Agent，输入草稿按 Agent 保留。创建时提供的工具范围与环境会保存，重载不会重新开启已手动取消的工具。

原有功能接入同一个界面：完整 Git 审查／提交／历史与引用管理、手动 LSP 诊断、附件、设置保存／重载、技能／提示模板、包市场与原生包管理、MCP、Codemode、Tool Search，以及配置中已加载的 Ask User 扩展。Git 写操作继续使用原来的预览与一次性确认；Ask User 复用原来的交互控件。插件会话展示通过统一适配接口投影 Pi 自定义消息和工具结果。

普通消息、生成、排队／引导、停止、压缩和恢复只由 Durable 调度。原 Pi coding SDK 仅作为资源 Adapter，复用扩展加载、工具、MCP、包管理与 UI 交互，不运行第二个模型循环。Durable 是运行依赖；宿主提供的 `pi-ai`／`pi-coding-agent` 声明为 `peerDependencies: "*"`，固定版本的独立 Desktop SDK 放在开发依赖中。仓库启动请安装开发依赖，默认模式使用这些 SDK，不要求全局 Pi 安装。原生插件没有 Durable replay 契约，其工具不会在崩溃后自动重放；新工具可以使用 `defineTool`／`defineExtension` 明确声明 replay。见 [示例扩展](../../examples/desk-extension.mjs)。

Durable 宿主启动时也应用 Pi 的 HTTP dispatcher，读取全局 `httpProxy`、`HTTP_PROXY`／`HTTPS_PROXY`（含小写）、`NO_PROXY` 和 HTTP 空闲超时。网络启动项修改后关闭并重开 Desktop。模型请求失败或中断会在聊天记录中显示原因，包括没有正文的失败回答；不会只留下用户消息。

数据默认在 `~/.pi/agent/desktop/`：`agents.sqlite` 保存对话、任务、requestId、Agent 配置、环境和工具状态；Desktop 的 `models.json`／`auth.json`／`model-cache.json` 保存提供商与认证。托管 Tailscale 使用独立的 `tailscale/` 私有 socket 和持久状态；停止远程共享保留 daemon，Desktop 退出关闭其拥有的 daemon，不关闭已有系统服务。异常退出最多尝试三次进程恢复，恢复期间二维码撤销，需重新开启并扫码。读取已有 Pi 认证和模型配置，新增认证／提供商写入 Desktop 文件，表单不回填秘密；密钥支持直接值与完整 `$NAME`／`${NAME}` 引用，不执行 `!command`。原来的全局／项目资源设置、包与 MCP 配置继续由原生模块管理，只有界面显式保存／操作才修改。

原页面设置中的全局 compaction、retry、transport、steeringMode、followUpMode 在重载后应用于 Durable Harness；项目资源设置交给各目录的原生资源加载器。Durable 目前只有 Harness 级运行策略，项目级 compaction/retry 不覆盖它；终端主题、TUI 显示和缓存预热属于原 Pi 设置，资源 Adapter 不进行模型预热。默认工作空间会发现 CLI JSONL 历史并按 cwd 分组；查看历史不启动模型。在 Linux 上退出该项目的 Pi TUI 后，可从会话右键菜单或历史页点击「在 Desktop 中继续」，接管原 JSONL 的当前分支和压缩上下文。第三方自定义 TUI 控件和依赖原生模型循环的 hooks 没有通用 Durable 适配。

关闭网页不停止宿主。Linux/Windows 关闭最后一个独立 Desktop 窗口时保存并关闭 Harness；macOS 退出应用时关闭。重开同一 SQLite 会恢复未完成任务。“停止”只取消所选 Agent 的前台工作，后台任务遵循 Durable ownership。一个存储只允许一个宿主，崩溃后的文件锁约十秒过期；本机 ExecutionEnv 使用各自 cwd，但不是 OS 沙箱。

Pi Durable 是实验框架，当前依赖范围 `~1.0.2`，原生资源 SDK 为 1.0.0；lockfile 固定实际版本。升级通过集中 Adapter 和契约测试验证，不承诺未知破坏性版本自动兼容。设计见 [DESIGN.md](design-evolution.md)，验收见 [durable-desktop-review.md](durable-desktop-review.md)。会话同步、原生资源、草稿与包管理的后续重构见 [architecture-improvements-review.md](architecture-improvements-review.md)。

## TUI 三端共享（兼容模式）

以下章节说明原生 TUI 的附加模式；页面与默认 Durable Desktop 共用，TUI 的生命周期和 JSONL 存储独立。`npm run desktop -- http://127.0.0.1:端口/` 附加该宿主，关闭窗口不结束 TUI Agent；独立 SDK 兼容入口是 `npm run web:legacy -- --cwd /你的项目`。

**TUI、Desktop、手机 Web 都是前端；Pi-Agent 是唯一后端。** 按当前取舍，原生 TUI 与 Pi-Agent 位于同一 Pi 进程，后端生命周期随 TUI；Desktop 和手机通过该进程内的 extension bridge 连接同一个会话管理器，不会另建后端进程。管理器保留原生会话，并按需创建同进程的独立 SDK 会话；不是每个前端或会话启动一个 Pi CLI。

```bash
cd /你的项目
pi -e /home/cmz488/.pi/design/pi-desktop/index.ts
```

然后在 TUI 输入 `/desk`：启动共享 Web 服务并打开 Electron Desktop。已安装本扩展时可直接启动 `pi` 后执行 `/desk`。没有 Electron 时明确提示，Web 服务仍保留；也可使用 `/desk web` 只启动 Web，通过“设置 → 远程连接”的二维码连接手机。默认一个端口，监听 `0.0.0.0:4318`；指定固定地址可使用 `env PI_DESK_HOST=0.0.0.0 PI_DESK_PORT=4318 pi -e /绝对路径/index.ts`。

- 三端共用当前会话 ID、消息／工具流、运行状态、模型、思考强度、名称、上下文与累计用量；任一端操作后以 Pi 原生状态为准。
- 管理器新建／切换不会替换正在运行的旧会话；原生新建／切换和 `/reload` 只重绑原生 slot，保留其他 SDK 会话、bridge、端口、SSE epoch 与当前 Desktop。
- `/desk stop` 仅关闭前端连接服务，不结束 TUI／Agent；关闭 Desktop 或手机网页也不结束任务。退出 TUI 时后端和 Web 服务一起关闭。
- 草稿、主题、滚动与折叠状态是各前端本地状态，不作为 Pi-Agent 会话状态广播。
- TUI 模式的原生登录／项目信任仍在 TUI 操作；新版宿主的原生包管理可在 Desktop/Web 确认调用。Web 也可管理当前会话、模型、思考、名称、配置保存与重载。第三方自定义 TUI 控件没有通用 Web 渲染器。

**不要同时启动另一个 `pi web` 并把它当作同一 TUI 的远端。** 以下独立 SDK 入口保留兼容，它创建自己的后端，不附加到已运行的 TUI。迁移旧 Web 会话时，先等待任务结束并停止旧宿主，再在 TUI 恢复历史会话并执行 `/desk`；不能让两个宿主同时写同一会话文件。

### 当前 TUI 找不到 `/desk` 时

安装 `pi web` 的 PATH 启动适配器**不会自动注册 TUI 扩展**。如果启动没有 `-e index.ts`，且用户／项目的扩展或包配置未包含本包，当前 TUI 就没有 `/desk` 和 `/sessions`。

在另一个终端注册本地包（此命令会在用户设置中添加一项 package，不修改 Pi 原版）：

```bash
pi install /home/cmz488/.pi/design/pi-desktop
```

等待当前 TUI 任务结束，再执行 `/reload`，然后 `/desk web` 仅启动网页服务，或 `/desk` 打开 Electron Desktop。只执行 `/reload` 不能加载一个从未注册的包。不想修改用户设置时，下一次启动使用上面的 `pi -e /绝对路径/index.ts` 临时加载。

## `/sessions` 并行会话管理

注册后在 TUI 执行以下命令。除 help 外，管理器也会启动共享 Web 服务，沿用 `/desk web` 的监听配置。

```text
/sessions                 打开可搜索会话选择器
/sessions new             新建 B，A 继续后台执行
/sessions list            列出当前工作区的活动与历史会话
/sessions use ID           切换／恢复；/sessions ID 是兼容简写
/sessions stop [ID]        停止指定活动会话，省略 ID 停止当前
/sessions help             帮助（不会启动服务）
```

ID 可用唯一的至少 8 位前缀。UUIDv7 的前 8 位常相同，建议复制界面显示的 18 位前缀或完整 ID；有歧义会拒绝，不会猜测目标。活动会话直接复用实例；同时恢复同一历史会话只打开一个 JSONL writer。原生恢复接口若试图再次打开已经托管的会话，会被取消，请改用 `/sessions use ID`。

默认选择器参考 Codex：逐行展示名称、活动／历史状态与更新时间；输入名称或 ID 搜索，↑↓ 选择、Enter 进入，Esc 返回，搜索文本不进入会话草稿或模型。窄终端保留完整的逐行选择能力，不把所有会话挤在一条页头中。选择后进入已有聊天管理界面；Ctrl+N 新建，Tab 直接切换活动会话并进入聊天。

管理界面内输入消息直接发送到选中会话，支持 `/new`、`/list`、`/use ID`、`/stop [ID]`、`/help`、`/exit`，也可输入完整 `/sessions ...`。快捷键：Ctrl+N 新建、Tab 切换活动会话、Ctrl+C 停止当前、PageUp/PageDown 滚动、Esc 返回原生会话。退出界面只把三端显示焦点对齐原生 slot，后台任务不停止。各会话输入草稿独立，关闭／重开界面保留；秘密交互不存入草稿，切换时清理输入撤销历史。

Web `/sessions` 或 `/sessions list` 打开会话选择器，new/use/stop/help 参数通过管理器处理，不进入模型上下文。正文与工具增量按 session ID 分流，侧栏仍更新后台状态；前端请求携带目标 ID，迟到操作返回 409，而不是误操作新焦点。浏览器草稿按会话隔离，旧请求完成不会清空新会话草稿。

**边界：原生聊天区的 `/new` 仍是 Pi 的替换操作。** 并行新建必须用 `/sessions new`、管理界面 Ctrl+N 或 Web 新建按钮。本插件不接管 Pi 核心或原生编辑器。托管会话从本机配置加载模型与扩展，新建继承可用的父模型、思考等级和工具范围，不额外开启父会话未启用的工具；仅通过临时 `-e` 加载的第三方工具未必能在子会话重现，请把需要复用的扩展配置为包。未加载工具会提示，不会偷偷扩大工具集合。高级原生 TUI 控件仍在原生界面使用。

首次注册可 `/reload` 加载。**已有进程中的旧版管理器或服务模块不会被新版代码无损替换**；更新宿主代码时等待所有真实任务结束，再重启原宿主进程。新版界面在检测到旧服务时拒绝不支持的命令。本轮未替你重启或迁移正在使用的手机服务。

## `/git` 三端 Git 管理

本包自动加载独立扩展模块 `git.ts`，不修改 Pi 核心；也可单独用 `pi -e /绝对路径/git.ts` 加载原生命令。TUI `/git` 显示当前会话工作区状态；`/sessions` 聊天区支持相同命令，确认交互属于目标 slot，不会作为提示词发送给模型。Desktop/Web 不再使用顶栏 Git 按钮或 Git 弹窗：右栏常驻工具卡显示分支、变更数量与增删统计。点击“审查”或“变更”切到右栏变更列表，选择未暂存／已暂存来源并逐文件展开 diff；“提交”页签处理已暂存变更，“历史”页签显示 VSCode 风格提交图表：真实父提交轨道、分叉／合并／汇合连线、HEAD 空心节点，以及单行标题、作者和分支／远端／tag 标签（每页 30 项）。默认自动选择当前 HEAD，也可选择全部已有分支与标签；悬停可看完整 SHA／日期／引用，点击显示完整提交与补丁；“管理”提供 merge／checkout／soft-mixed reset／本地 tag。更多菜单仍可进入历史与远端同步。`/git` 也进入右栏，写操作仍使用独立确认框。输入框下方不显示 Git 分支。浅深主题保持 pi.dev 色板与字体；手机用顶部工作区工具入口打开右侧抽屉，不挤压聊天。差异使用原文本预览，不在浏览器同步比较整份文件；只缓存当前一份差异，仓库状态变化或刷新时失效。

```text
/git status
/git diff a file.txt
/git stage a file.txt
/git unstage a file.txt
/git commit 提交说明
/git branches
/git switch 已有本地分支
/git log [页码]
/git show 提交SHA或引用
/git merge 已有分支或提交
/git checkout 已有分支或提交
/git checkout -b 新分支 [起点]
/git checkout --detach 提交
/git reset soft 目标
/git reset mixed 目标
/git tags
/git tag 名称 [目标]
/git tag annotate 名称 目标 注释文字
/git tag -d 名称
/git fetch [远端]
/git pull [远端]
/git push [远端]
/git help
```

文件参数的剩余文字是一个文件名（可以有空格），不使用 shell 引号解析。提交只包含已经暂存的文件，并在确认里完整列出；不自动 `add .`。分支切换与 pull 要求干净工作区，pull 只允许快进；没有 force push、硬重置、清理、自动 stash、自动冲突解决、远端新增／URL 输入或分支删除。pull/push 优先使用当前分支配置的 upstream；选择其他远端或没有 upstream 时使用同名远端分支，完整目标 ref 显示在确认中。

目标引用限 HEAD、已有本地分支／tag（同名时使用完整 refs/heads/ 或 refs/tags/ 引用）、唯一提交 SHA；不接受任意 Git 修订表达式或 URL。新建分支、detached checkout 与 merge 均要求干净工作区，不恢复文件或丢弃改动。reset 必须在本地分支上，soft 保留索引与工作树，mixed 取消暂存但保留工作树；确认显示解析后的 SHA、当前分支、已暂存及工作区变更，不提供 hard。tag 可创建轻量／注释标签、列出和删除本地标签，不覆盖已有 tag、不自动推送；分支和 tag 变化也使旧确认失效。

图表不自动 fetch，也不伪造 incoming/outgoing 节点。分页从同一拓扑前缀计算轨道，读取中 HEAD／引用变化会返回 409 要求刷新；每次仍受 4 MiB Git 输出和超时限制，超过 128 条并行轨道明确报错而不是画假的简化关系。gitGraph 缺失时保留已有列表，不假造父提交或图表。

旧宿主缺少 gitExtended 时不发送新命令；已有原始历史仍可读取，不伪造可点击的提交详情。旧宿主没有 Git API 时，右栏仍显示工具卡与审查入口，显示已有分支信息与升级说明，不调用不存在的接口，也不把未读取的变更当成干净工作区。前端刷新只能更新面板，完整管理仍须任务结束后经用户确认更新宿主；没有自动重启入口。读取失败在面板内显示，刷新可重试。会话切换会清除旧工作区列表／差异，提交说明草稿按会话隔离；同一仓库的刷新／历史读取保留所选分支和远端。

Git 需要已信任项目，避免仓库过滤器在无许可下执行。写操作还要求全部托管任务／配置操作空闲，面板根据服务端可写提示禁用操作（服务端仍再次验证）；读取 diff／历史不因任务运行而禁用。提交还需要已暂存文件和非空说明；每次先预览，再确认一次性、60 秒内有效的操作。确认绑定 session、工作区、HEAD、索引／工作树字节及 Git 配置指纹，变化须重新预览；同仓库三端共用写锁，期间新消息被拒绝并保留草稿。未完成的变基／拣选等先在终端处理；本包 merge 遇到冲突会保留现场和明确状态，不自动解决／中止。解决文件后，可显式 `/git stage 文件` 再 `/git commit 说明` 完成合并；还有未合并索引时提交被拒绝。此时 reset／checkout／其他写操作仍禁止。使用已有凭据助手／SSH 配置，本包不提供密码输入，并关闭 Git 终端认证提示、不放宽主机验证；需要交互登录时在终端完成后重试。仓库 hooks、filters、签名程序和凭据助手仍属于正常 Git 语义，可能具有自己的交互行为，确认会明确提示。

远端操作最长 90 秒，界面显示执行状态。已开始的操作绑定原工作区，切换前端会话不把操作改派到新会话，也不意味着操作被取消。读输出最多 4 MiB、本次暂存所选未跟踪文件的字节指纹总额度 16 MiB、单个未跟踪文本预览 512 KiB；不读取符号链接目标。写锁和指纹不等于跨进程事务锁，其他终端／工具仍可能并发操作 Git。外部认证、公共远端、真实手机剪贴板尚未验证；测试只使用临时仓库和本地 bare 远端。

### 手动 LSP 诊断（JS/TS 与 JSON）

审查中展开文件后点击“分析当前文件”。已有 `typescript-language-server`／`vscode-json-language-server` 必须在宿主 PATH；不自动安装、下载或启动分析。TypeScript 优先解析工作区已有编译器，找不到时使用本包可解析的已有 TypeScript；仍缺失则明确报错。JSON／JSONC 关闭外部 schema 读取，TS 关闭自动类型获取。当前不接 Rust/C++。

分析仅对当前工作树 UTF-8 文件（≤512 KiB），不读取已暂存快照；即使显示的是 staged diff，诊断也明确标注工作树来源。只返回语言服务器真实诊断、行列与错误码，不调用模型，不执行修复、编辑或命令。每个共享 bridge 最多两个并发分析、20 秒超时、最多 200 条诊断；完成／关闭时清理所启动的语言服务器，Unix 同时清理其 tsserver 子进程。目标会话／工作区或文件字节变化会丢弃结果。缺少服务器、旧宿主或超时不伪装成检查通过。

只读是客户端协议与操作边界，不是操作系统沙箱：可信语言服务器、项目配置及插件可能自行执行代码／访问其他文件，因此仍要求项目信任。没有诊断不等于完整审查、构建或编译通过。只读 Git 列表使用 numstat 与有界文本统计，大未跟踪文件仍可列出，不再因无关文件超过 16 MiB 阻断面板；大文件／二进制的行数显示未知，不伪装为零。

## 独立 Web 兼容入口（无 TUI）

要求 Node ≥ 24.21，pi ≥ 0.99.2（本轮验证 CLI/PTY 0.99.2 与 SDK 1.0.0）。`pi.extensions = ["./index.ts"]` 仍是本包的扩展入口；无头入口使用同一 Pi SDK 会话管理器，子会话加载配置中的扩展，但排除本包宿主入口，避免递归创建管理器。

```bash
cd /home/cmz488/.pi/design/pi-desktop
npm ci --ignore-scripts
npm run install:launcher
npm run web:legacy -- --cwd /你的项目目录
```

打开兼容命令输出的本机链接。无需进入 TUI，也无需 `/desk`。`npm run web:legacy --` 默认使用当前工作目录，监听 `0.0.0.0:4318`，电脑通过 `127.0.0.1:4318` 访问，手机通过电脑的局域网 IP 访问同一端口，已占用时自动选择后续空闲端口。显式 `--port` 则严格使用指定端口。

pi 0.99.2 没有自定义 CLI 子命令接口，因此 `pi web` 由本包的轻量 PATH 启动适配器实现：安装到 `~/.local/bin/pi`，其他参数原样交给原版 pi。原版可执行文件和上游安装目录保持原样。当前环境已将此目录置于 PATH 前部；在已有 Bash 会话可执行 `hash -r`。安装器拒绝覆盖其他程序，`npm run uninstall:launcher` 可移除本包适配器。`PI_WEB_BIN_DIR` 可指定目录，`PI_WEB_NATIVE_PI` 可指定原版绝对路径。

无需适配器也可运行：

```bash
npm run web:legacy -- --cwd /你的项目目录
```

npm 安装后的 `pi-web` 与 PATH 适配器的 `pi web` 均使用新的 Durable 模式。PATH 适配器支持 Linux/macOS；各平台的旧 SDK 模式请使用 `npm run web:legacy --`。

## 网页配置

| 页面       | 已实现能力                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 会话       | pi 真实消息／工具输出、流式响应、模型与思考强度、停止、引导／排队、新建／切换当前工作区会话、按需输出预览                         |
| Pi 配置    | 用户／项目范围，模型默认值、思考、工具、压缩、资源路径、网络重试、Shell、终端显示等原生配置字段；搜索、草稿、显式保存和删除覆盖值 |
| 模型提供商 | 已保存认证的提供商与用户自定义服务，自定义端点／API 格式／模型 ID／密钥；选择模型、设置默认；原生 API Key 与 OAuth 交互、退出认证 |
| 已安装插件 | 用户／项目包和本地扩展、实际已安装版本、原生更新提示；资源过滤、启停、更新／移除、声明式配置表单                                  |
| 插件市场   | pi.dev 官方刷新／搜索／四类型筛选／排序／分页、完整文字介绍；原生包管理安装 npm／Git／本地来源                                    |
| 远程连接   | 同端口局域网扫码、地址选择、电脑与手机共享操作、断线重试、事件回放和快照恢复                                                      |

设置草稿仅在保存时提交。JSON 修改采用内容 revision、局部 patch、文件锁、临时文件与原子替换，保留未编辑字段；其他窗口修改后，旧 revision 保存会被拒绝。

设置“保存”与“应用”分开。网页重载复用原生 `session.reload()`，保留 Web 服务与当前会话；默认模型／默认思考用于新会话，工具重载规则沿用 pi；HTTP 代理、会话存储目录等进程启动项需要重启。代理环境变量优先于设置，启动使用 pi 自己的 HTTP dispatcher。

项目信任复用 pi 的 ProjectTrustStore。已有项目资源未受信任时，先使用用户配置；可在 Pi 配置页审阅并信任当前项目。

提供商管理和模型选择仅展示保存的 `/login` 凭据、运行时显式认证及 `models.json` 密钥服务，不展示整个 store，也不因机器环境变量存在而列出其他内置服务。未登录服务从“添加提供商”选择，调用同一原生登录流程。用户新建的自定义配置可保留在列表中继续编辑。

内置提供商登录调用 `ModelRuntime.login()`，凭据由 pi 写入 `auth.json`；自定义服务写入 `models.json`。列表和表单不回填已有密钥、header 或 OAuth token。新密钥可用 `$NAME` / `${NAME}` 环境插值，留空保留已有值。Web 表单不新增 `!command` 密钥，已有配置保持原样。刷新模型不会发送聊天请求。

### 官方目录与原生更新提示

目录只展示 pi.dev 的真实数据，不另建注册表。支持 extension／skill／theme／prompt、月下载量／最近发布／A-Z 排序及官方分页；“最近发布”不冒充最后更新时间。MCP 入口明确为关键词搜索，不编造独立官方类型。刷新重新读取上游，记录抓取时间；失败不冒充新数据。

介绍显示官方元数据、Pi manifest 和完整 README 文字，不沿用聊天预览的 60,000 字符截断；超过 4 MiB 整页明确报错并提供原始页面。作者 HTML 被清理，脚本／本地操作属性不能生效，不自动加载图片／视频；媒体可在原始页面查看。官网收录不代表安全审核。

已安装版本来自 Pi `getInstalledPath()` 对应的 manifest，而不是源字符串。首次打开插件管理且全部任务空闲时检查一次，也可点击“检查更新”；可用提示和筛选来自公共 `checkForAvailableUpdates()`，不另造 semver 引擎。原生接口不返回远端版本号，部分来源／固定版本／离线或网络失败不报告更新，因此“未报告”不等于“已是最新”。

安装、移除和更新只通过原生 `installAndPersist()`／`removeAndPersist()`／`update(source)`；全部任务空闲、项目可信、原目标／配置和已安装版本未变后明确确认。`update(source)` 按原生来源匹配，可能涉及用户与受信任项目的相同声明，遵守固定版本和覆盖规则；不会自动安装、更新或 reload。磁盘安装版本变化不代表运行中的扩展已重载。旧宿主无能力时禁用并说明，不请求不存在的接口；旧 `/api/marketplace` 仅为旧前端保留明确标注 npm 的兼容摘要，新界面使用官方接口。

接口依据见 [package-catalog-research.md](../references/package-catalog-research.md)，验收见 [package-sidebar-review.md](package-sidebar-review.md)。本轮不重启真实服务；新后端须所有任务结束、草稿／附件保存后经授权加载，刷新页面不等于更新宿主。

## 命令、技能与外观

对话输入 `/` 时，在输入区上方展开按组显示的命令菜单，来自当前 pi 加载的扩展命令、skills 和提示模板。支持输入过滤、上下键、Tab 填入、Enter 选择和 Esc 关闭。技能／模板填入后可继续写参数，再发送给原生 `session.prompt()` 展开；扩展命令同样由 pi 执行。

Web 对 TUI 自带入口提供对应页面：`/settings`、`/model`、`/models`、`/login`、`/logout`、`/new`、`/resume`、`/sessions`、`/session`、`/copy`、`/skills`、`/mcp`、`/help`。`/compact [要求]` 调用原生 `session.compact()`，`/reload` 重载当前宿主资源，`/name 名称` 调用原生命名；这些管理命令不会作为聊天内容送给模型。所有已打开网页都可以操作当前会话。

Pi 配置按模型与思考、会话与工具、上下文与压缩、网络与重试、资源与 Shell、终端与显示分类；搜索可跨分类，切换分类保留草稿。技能页面通过原生 PackageManager 枚举已启用与已禁用资源，包括包内技能；开关写入对应作用域的原生过滤规则。禁用后重载，将从模型可用技能和 `/skill:` 菜单移除；不会删除技能文件。插件也可在已安装插件页面启停。提供商默认展示端点、认证状态和模型数量，点击“查看模型”展开，已配置服务排在前面。

默认使用 Pi 官网的蓝黑底色、细网格、薄边框与蓝色强调。Departure Mono／Commit Mono 为官网使用的开源等宽字体；标题使用 Source Serif 4 衬线替代字体，已安装的 Plantin MT Pro 可优先使用。字体本地提供，合计约 259 KiB，不依赖外部字体服务；许可证在 licenses/。外观页保留跟随系统、浅色／深色和 14／15／16 px 字号。

输入区仅保留模型、思考等级、＋ 上下文入口以及停止／发送按钮；不提供输入文字的“预览”切换，附件预览与工具输出面板仍保留。按钮参考 ZCode 的紧凑圆角控件，用独立背景、可辨识边框和展开／悬停态区分输入背景；＋ 按钮保留“添加上下文”的无障碍名称与格式提示。

思考强度使用页面内的主题菜单，支持方向键、Enter、Esc 和触摸，只显示当前模型实际支持的等级，窄屏弹层不会越出左右边界。新版宿主允许任务运行中调用 Pi 公开 setter 调整会话所选等级，不停止 Agent、不改变已经发出的请求；模型／共享配置写入仍保留运行锁。只有一个等级的模型禁用切换并提示原因；宿主初始化／重载／配置操作期间仍禁止。旧宿主没有 thinkingEditable 能力时保持原先安全限制，提示等任务结束后更新宿主，不假装运行中请求已经成功。输入框下方统一显示运行状态、上下文占用、原生会话累计 Token、模型价格计算的费用、缓存读取占比与输入方式。宽屏为一行；窄屏按固定两行排列：第一行为状态／上下文／Token，第二行为费用／缓存／输入方式，Git 分支移入右栏；缓存读取占比 = cacheRead / (input + cacheRead + cacheWrite)，无输入用量时显示 —，不代表服务端请求命中率。费用是 Pi 计算值，并非账户账单。

对话保留提供商实际返回的 thinking 文本，使用 DSH 的可折叠思考／工具行方式展示；支持思考动画、调用参数、实时部分输出、成功／失败结果及 codemode 嵌套调用。不会生成或推断隐藏思考内容。减少动画的系统偏好会关闭旋转效果。连续助手消息按用户轮次共享一个 Pi 标志，但不再收进整轮执行过程：思考、每次工具调用及中间行为按原生顺序逐条显示，默认独立折叠，最终答复正常显示。摘要包含类型／工具／状态；展开保留原生提供的完整文字、参数与输出，不截断为 60,000 字符，不推断隐藏思考。

消息与思考使用 Marked 渲染 Markdown（标题、列表、代码围栏、表格、引用、链接），DOMPurify 清理输出，原始 HTML 作为文本显示。KaTeX 支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`，禁止可信宏与外部资源指令，并限制宏展开次数与尺寸。输入工具栏的“预览”显示 Markdown／公式，发送给 Pi 的仍是原文。库与数学字体从本地提供，不依赖 CDN。品牌和回复标志采用 Pi 官网 SVG 的单色像素图形。

更新代码后，已启动的旧 SDK Web 宿主需要停止并重新运行 `npm run web:legacy --`，以加载新的 SDK 命令处理；网页刷新加载新界面。如果已有重要任务，请等待完成后再重启。

## Ask User 与上下文附件

Web、Electron Desktop 和手机使用同一页面、协议与 Pi 会话：

- **Ask User**：已适配实际安装的 `@juicesharp/rpiv-ask-user-question` 2.12.0。等待问卷时，选项框原位替换普通输入区（不在输入框上方叠放），显示选项、说明和预览；回答或取消后恢复原草稿，支持多选、Custom option、提交及取消。TUI 原生问卷和网页共用一次性结果入口；任一端回答／取消后，其他端同步退出等待，迟到／重复答案被拒绝。断线重连或刷新重新读取待答问卷；认证和其他普通对话仍走原有弹窗。
- **上下文**：点击“＋”（添加上下文）选择本机文件，或在输入框粘贴浏览器提供的文件／截图，预览、移除后随普通消息提交；支持 UTF-8 文本／代码和 PNG、JPEG、GIF、WebP、BMP（转 PNG）。SVG 作为文本而非图片。服务端用 Pi 公开图片检测、转换和缩放能力校验真实字节；图片还须当前模型支持，且未被 Pi 设置禁用。PDF／Word／其他二进制文档没有原生解析器，本包明确拒绝，需先转换。
- 粘贴复用同一读取、配额和校验逻辑；混合的纯文本仍插入原位置，只有文字／HTML／文件路径时不拦截浏览器默认粘贴，不从宿主读取粘贴的路径。不依赖仅 HTTPS 可用的主动 Clipboard API；从文件管理器复制文件能否产生 File，由操作系统／浏览器决定，本轮不接入 Electron 原生文件剪贴板。
- 每会话最多 8 个附件、合计 4 MiB；单个文本最多 512 KiB，图片最多 3200 万像素；浏览器全部附件草稿合计最多 16 MiB。未发送附件仅在该窗口内存中，按会话隔离；断线重连保留，刷新／关闭页面不保留。读取或提交失败不清除草稿，成功只移除本次发送的附件。附件不支持附加到斜杠命令，不提供任意宿主路径读取接口。

平台限制：SDK／独立 Web 会话复用插件的 RPC 顺序对话，单选的 Custom option 要先选中再输入；RPC 多选中的纯数字自定义答案会被原生插件当成选项，界面明确提示添加文字说明。TUI 原生问卷没有这一限制。详细来源、验收记录与未验证范围见 [interaction-context-review.md](interaction-context-review.md)。

## 原生 MCP 服务

“设置 → MCP 服务”支持添加／编辑 stdio 和 Streamable HTTP 服务、用户／项目范围、启停、移除、工具暴露（codemode / deferred / direct / hidden）、超时、单个工具暴露、环境变量、请求头、OAuth 参数与提供商认证。现有扩展注册的服务也会显示，可创建用户配置覆盖。保存写入原生 `mcp.json`，使用 revision 校验、文件锁与原子替换，保留未知字段；保存后点击重载应用。

连接、工具与资源发现、OAuth、重新连接和退出认证均使用 Pi 内置 `createMcpExtension()`，没有另建 MCP 客户端。连接状态直接调用原生 `/mcp`，避免由工具数量猜测连接状态。登录链接与回调 URL 输入经网页交互窗口处理，凭据写入原生 `mcp-auth.json`；不会把授权 URL 广播到对话。环境变量、请求头与 OAuth secret 不回填，空值保留已有对应值，删除键可移除。提供商认证仅允许用户配置及 HTTPS／回环端点，未信任项目的 MCP 不会加载。

## Pi 更新兼容

仍以 `pi.extensions = ["./index.ts"]` 安装；不修改 Pi 的代码或二进制。兼容启动器把原版命令位置传给 Web，兼容模式从该安装包的公开导出入口加载 SDK；默认 Durable 模式使用本包内嵌 SDK。普通启动优先使用 Pi 原生配置加载器；SDK 公开接口缺失时明确报错。

原基线实测 CLI/PTY Pi 0.99.2；本轮依赖同步后使用全局 Pi 1.0.0 与独立 SDK 1.0.0；MCP 凭据测试按版本使用旧 URL 键或 1.0 的 name+URL 键。测试还模拟公开入口移动，不等于实测尚未发布的版本。内部 HTTP dispatcher 保留集中适配：原生兼容入口在接口移动时回退并提示；Durable 宿主依赖锁定的内嵌 SDK，初始化失败时明确报错，避免悄悄忽略代理；`--agent-dir` 的 MCP 凭据后端因 Pi 尚未公开导出而保留集中适配，目录自定义场景需要对应版本支持。上游发生破坏性 API 改动时需更新本扩展。

## 插件配置表单

pi 的第三方扩展没有统一的私有配置格式。当前提供 RTK Optimizer 的源码适配，以及可由插件声明的通用表单：在插件目录放置 `pi-web.config.json`，或在 package.json 的 `pi.webConfig` 写入同样对象。

```json
{
  "file": "config.json",
  "fields": [
    {
      "key": "notifications.enabled",
      "label": "完成通知",
      "type": "boolean",
      "default": true
    },
    { "key": "endpoint", "label": "服务地址", "type": "string" },
    { "key": "token", "label": "访问凭据", "type": "string", "secret": true }
  ]
}
```

`file` 相对插件根目录，不能越过目录或通过软链接访问外部；字段支持 boolean/string/number/enum 和嵌套 key。敏感字段只返回配置状态，空输入保留原值。未知字段不改写。没有声明表单的插件仍可管理包、资源过滤和启停，私有参数需对应插件的适配器。

## 插件会话展示适配

Pi 继续负责扩展加载、工具执行、权限和会话 JSONL。Desktop 的 `extension-adapters.mjs` module 集中处理消息匹配、卡片规范、摘要、展示位置和去重。时间线与页面不识别插件 ID，也不处理 Goal 私有字段。

简单扩展在工具结果或自定义消息的 `details.piDesktop` 声明 v1 卡片，无需注册 UI 代码：

```json
{
  "piDesktop": {
    "version": 1,
    "label": "构建",
    "title": "发布检查",
    "status": "进行中",
    "body": "已通过编译，正在检查产物。",
    "progress": { "value": 1, "total": 2 },
    "items": [{ "label": "编译", "status": "已完成" }],
    "metrics": ["12 秒"],
    "detailsLabel": "查看检查项",
    "presentation": { "mode": "state", "key": "my-extension/build" }
  }
}
```

省略 `presentation` 时，卡片随原消息保留；`mode: state` 时按 Agent 会话、adapter ID 和 `key` 仅展示最新状态，位于会话末尾，工具内保留摘要。`key` 必须以扩展名区分，防止通用卡片之间重名。切换会话不会沿用其他 Agent 的卡片；流式重绘从当前已加载分支选取状态，展开项保持展开。`detailsLabel` 可选，声明后将正文和条目放入折叠详情。文本作为纯文本转义，不接收 HTML。条目最多 40 个、嵌套深度最多 4、指标最多 8 个；进度约束到有效区间，未支持的版本回退到原消息。

复杂展示继续兼容 `register({ id, version, project, render })`。`project(message)` 返回视图；`render(view, context)` 返回 HTML，原有单参数 renderer 可继续使用。module 的 `summary(view)` 负责工具摘要，`layout(messages, {sessionId})` 负责普通消息与状态卡片分流；页面只消费结果。通用卡片和 Goal 共用同一 renderer，新增插件优先使用上述 schema。

注册返回幂等 disposer；可选 `onRegister()` 返回清理函数、`onSessionChanged(next, previous)` 接收会话变化，注销或 `dispose()` 时调用 `onDispose()`。清理绑定每次注册的独立身份，同 ID 重注册后旧 disposer 无效；清理抛错不阻止其他注册释放。当前内置 adapter 都是纯投影，会话通知不会停止其他 Agent；本轮不引入命令调度或动态插件代码加载。

内置 `/pi-goal-x` 仅匹配其五个目标工具返回的 `details.version: 3` 目标快照，以及 `pi-goal-event`／`pi-goal-audit-event` 自定义消息，转成上述通用卡片。目标快照为状态卡片，事件随消息保留；目标生命周期、验收、调度和 JSONL 由 Pi 管理。已运行 Host 返回的旧 Goal 视图也在 module 内转换。

接口结构参考 DeepSeek Harness 的 Cordis 生命周期：模块进入、切换与释放时清理自己注册的副作用；Desktop 仍保留 Pi 扩展 API 与原生任务链，不把 Cordis 运行时引入 Agent。新增专用适配前优先使用通用卡片 schema；确有复杂交互时才注册对应 projector/renderer。

## 手机扫码远程连接

只接入 **Tailscale Funnel**。电脑需安装支持现代 Serve／Funnel CLI 的 Tailscale（≥1.52）、启动并登录，首次使用授权 MagicDNS、HTTPS 和 Funnel；手机不必安装 Tailscale，也不必与电脑在同一网络。首次设置依据 [Tailscale 官方说明](https://tailscale.com/docs/features/tailscale-funnel)。Linux 首次准备可使用：

```bash
sudo systemctl enable --now tailscaled
sudo tailscale up
sudo tailscale set --operator="$USER"
```

最后一步允许当前桌面用户管理连接，Desktop 不需要以 root 运行；依据 [Linux operator 权限说明](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission)。

然后启动 `npm run desktop`，打开“远程连接”，点击“开启远程连接”。首次 Funnel／HTTPS 授权如需浏览器操作，页面显示授权链接；授权完成后会显示“验证公网连接”，确认 HTTPS 请求到达当前网关才显示二维码；失败会显示网络／TLS 原因。手机扫描即自动授权并打开当前 Agent。两端共享消息、工具进度、设置和 Agent 清单，仍使用原 SSE 实时通道。公网地址首次启用时可能等待 DNS 生效。

二维码包含仅在浏览器中读取的 fragment 连接密钥。手机自动兑换为 HttpOnly／Secure／SameSite Cookie 并从地址栏移除密钥，不需要输入账号或验证码；会话有效期 12 小时。二维码允许操作此 Pi 工作区，仅在电脑页面展示；手机不能开启隧道或生成新二维码。“撤销连接并更新二维码”使旧二维码和手机会话立即失效；“停止共享”同时撤销授权和关闭本次 Funnel。已有 Agent 任务继续运行。

Funnel 仅转发带授权检查的本机网关；Desktop 本来的监听地址保持不变。使用前台 CLI，自动避开已占用的 8443／10000／443，不使用 `--bg` 或全局 `reset`，退出 Desktop 会清理本次共享。自定义 CLI 路径可设置 `PI_DESK_TAILSCALE`。`npm run web` 和已有 TUI 宿主的同一连接页面也可以开启此功能。

测试使用临时 CLI 和本地 HTTPS 反向代理代替外部 Tailscale：验证真实二维码解码、浏览器自动授权、选中 Agent、手机流式回答、刷新保留认证、访问撤销和原桌面回归。真实 tailnet、公网 DNS 与手机蜂窝网络仍需在完成电脑登录后实测，不能把本地夹具通过视为公网已开通。细节见 [remote-access-review.md](remote-access-review.md)。

## 手机局域网连接（兼容入口）

```bash
npm run web:legacy -- --cwd /你的项目
```

默认只启动一个 HTTP 服务，监听 `0.0.0.0:4318`（默认端口占用时自动选择后续空闲端口）。终端直接打印手机二维码；“设置 → 远程连接”也展示同一个网页地址与二维码，多网卡时可选择地址。电脑和手机连接同一局域网后，扫码即可操作同一 Pi 会话，双方同时查看、发送和调整设置，无需 Web 登录、配对、Cookie、JWT、CSRF 或控制权切换。二维码地址无令牌、无兑换流程、无有效期，直到服务停止或地址变化。

需要固定端口可运行 `npm run web:legacy -- --port 4318`；仅本机监听使用 `npm run web:legacy -- --host 127.0.0.1`。`--no-qr` 仅省略终端二维码，不改变服务监听范围。关闭任一浏览器不会结束任务。

浏览器连接使用 SSE 的 epoch／seq 回放。普通状态刷新保持事件连接；连续生成事件合并为定期刷新，不再反复推迟显示；断网持续退避重试，返回前台重新读取快照，保留当前输入草稿。手机视口随浏览器地址栏与键盘调整，连接状态区分已连接、重连中和网络离线。

实际 Web 服务的静态脚本／样式支持 gzip 和 ETag 条件请求；浏览器保留资源，但每次使用前重新校验，文件更新后立即返回新版。会话 JSON 同样按浏览器能力协商 gzip（小于 1 KiB 的响应通常保留原文），仍为 `no-store`，不缓存会话内容。SSE 使用流式 gzip，每个完整事件立即刷新压缩流，浏览器自动解压，心跳、顺序回放和重连继续可用。压缩由服务端统一处理，Funnel 网关透传，避免重复编码。0.6.0 优化基线的页面脚本／样式传输量从 935,815 B 降到 235,277 B（不含字体与会话快照），不是手机端加载时间的实测结论。本轮长会话测试通过授权网关将约 204 KB 降至约 1.7 KB；重复测试文本的压缩率不代表所有真实会话。复现方法与限制见 [performance-check.md](performance-check.md)。

可选 HTTPS 使用同一个端口：

```bash
npm run web:legacy -- --cwd /你的项目 --host 0.0.0.0 --port 4318 \
  --tls-cert /绝对路径/cert.pem --tls-key /绝对路径/key.pem
```

HTTPS 证书需匹配访问地址。跨网络访问使用上面的 Tailscale Funnel；离线 PWA 尚未实现。局域网兼容入口的测试覆盖真实二维码 PNG 解码、同端口 HTTP／HTTPS 多客户端操作与 SSE 同步、断网恢复和手机布局。

## 可选桌面窗口

```bash
npm rebuild electron
npm run desktop -- '兼容宿主输出的本机链接'
```

直接打开命令输出的本机链接；手机和桌面窗口共享同一会话。

Electron 仅连接现有服务，窗口关闭不结束 pi。固定 Electron 41.10.7；可用 `PI_DESK_ELECTRON` 指向系统版本。当前 Linux 的系统 Electron 43.7.5 已验证窗口启动，macOS/Windows 安装包尚未打包。

三端共享模式中，TUI 的 `/desk` 直接打开 Desktop 并附加当前后端；`/desk web` 不打开窗口。独立 `web:legacy` 模式可通过上述带 URL 的 `npm run desktop` 连接其现有后端，但它不包含 TUI，也不自动连接另一 Pi 进程。

## 预览与验证

```bash
npm run dev                # http://127.0.0.1:4317；仅模拟数据
npm run check
npm test
npm run test:pi            # 原生 RPC 核对 + Linux script PTY 的真实 TUI
npm run test:desktop       # Linux electron43 + Xvfb 的真实 Desktop/TUI 同步
npm run test:browser       # 需要 /usr/bin/chromium；临时真实 SDK 会话
npm run test:sessions      # 管理器、输入隔离、历史恢复及真实并行 PTY
npm run test:commands      # 未加载、显式 -e、配置包三种命令发现路径
npm run test:ask           # 真实 Ask User 插件：SDK + TUI 交互
npm run test:context       # 图片／文本校验 + SDK + TUI 上下文
npm run test:git           # 临时仓库、本地远端、确认与权限保护
npm run test:lsp           # 只读协议、生命周期、真实 JS/TS/JSON 诊断（已有服务器）
npm run format:check
```

Ask User 集成测试需要本机安装对应真实插件（当前验证 2.12.0），只加载插件源码到临时宿主；其他安装位置可设置绝对路径 `PI_DESK_ASK_PLUGIN`。测试使用临时 agent／项目目录，不调用外部聊天模型，不修改个人配置；原生 Agent 循环检查仅使用本地模型服务夹具。`test:pi` 的 TUI 检查需要 Linux `script`；`test:desktop` 另需 `/usr/bin/electron43` 和 `xvfb-run`，使用虚拟显示和临时 Electron 配置。真实 TUI 核对远端模型／思考在原生 footer 中更新、会话替换与重载保持同一后端、前端关闭不结束任务及 TUI 退出关闭服务。浏览器检查覆盖明暗主题文字／按钮对比度（至少 4.5:1）、`/` 菜单与原生扩展命令、跨分类草稿、桌面 1440×1000 与手机 320／360／390 px 的固定两行状态栏、长分支省略、断网重连与草稿保留、配置持久化、原生认证、插件表单、秘密字段不回填、会话切换和按需预览；另验证技能禁用／恢复、原生 MCP 添加与工具发现、思考／工具结果展示、主题菜单和 SDK 更新解析；截图位于忽略提交的 `screenshots/`。

认证、普通 select/confirm/input/editor 交互可在无头 Web 中完成。第三方扩展的自定义 TUI 组件没有通用 Web 渲染器；会话展示可使用 `piDesktop` 卡片契约，复杂展示再实现适配器。OAuth 流程使用原生提供商实现，外部账号的完整授权需要真实账号验证。外部编辑器不遵守本包文件锁时，最后校验至 rename 之间仍有很小的竞态窗口。

开源设置保留 MIT、上游许可／NOTICE、源码引用、锁文件、格式化与独立测试命令。仓库尚未发布，`private: true` 防止误发布。

界面保留 Pi 配色与标志，减少网格装饰、压低边框重量，并提供 120–160ms 的菜单、设置页和按钮过渡。系统启用减少动态效果时关闭动画；手机保留实际模型名称，省略思考强度副标题以控制宽度。
