> 目录整理前的完整资料快照；历史说明可能已被取代。当前文献见 [入口](../README.md)。

## 0.23.0 · Agent 共享 Chromium

直接依赖并调用 [pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native) 0.9.5（MIT）与 [agent-browser](https://github.com/vercel-labs/agent-browser) 0.38.1（Apache-2.0），版本固定于 package-lock.json；没有复制插件实现或修改个人全局安装。接口依据安装包入口、CLI 帮助与 [上游实时画面协议](https://agent-browser.dev/streaming)。读取官方 main 的 `cli/src/native/stream/{websocket,cdp_loop}.rs` 排查输入字段：缺省可选键盘字段在部分发布实现被发送为 null，适配层补齐 key/code/text。工具继续走 Pi 的公开注册、事件和审批接口。Desktop 将原生直接工具绑定到自己的 Chromium 会话，未开放插件的其他浏览器内核／Electron 启动工具。升级依赖时需要重新验证启动参数、会话与输入协议。

# 0.26.3 · npm 入口、Pi HTTP 代理与字号快捷键

- npm 公开清单来自 `package.json.files` 与 `bin`：`pi-desktop`／`pi-desk` 启动 Electron，`pi-web` 保留 Web Host；`--port` 继续由 `deskOptions` 解析并传递给 Host。`scripts/check-npm-package.mjs` 审核实际 `npm pack --dry-run --json` 文件清单，排除测试、参考源码和桌面本机数据。
- 代理设置复用已安装 Pi coding-agent `SettingsManager` 的全局 `httpProxy` 字段；`pi-sdk.mjs` 通过窄兼容 Adapter 调用 Pi `core/http-dispatcher.js` 的 `applyHttpProxySettings`／`configureHttpDispatcher`。保存路径和代理环境语义跟随 Pi 原生配置；未设置 TLS 忽略选项。
- 外观字号由 `prototype.js`／`prototype.css` 的浏览器偏好和 CSS token 驱动；快捷键回归在 `test/desktop-workspace-check.mjs` 中使用真实页面 iframe。

## 0.22.0 · 模型上拉菜单与自动 Tailscale 运行时

- DSH `packages/client/ui-model-selection/src/client/ModelSelect.tsx` / `ModelSelect.module.css`：参考触发按钮的当前模型／effort、上方二级菜单、按 provider 分组搜索、方向键与 Escape 的交互。`composer-model-picker.js` 为本项目独立 DOM 实现，数据和提交仍来自 Pi 原生目录、model 与 thinking API，没有复制 DSH 组件实现。
- Tailscale [用户态网络说明](https://tailscale.com/docs/concepts/userspace-networking)与[官方 CLI](https://tailscale.com/docs/reference/tailscale-cli)核对 `tailscaled --tun=userspace-networking`、独立 socket/state 和 `tailscale up --json --timeout`。优先复用健康系统服务；否则以应用用户启动独立 daemon，不使用 sudo、不改系统路由、不保存额外 auth key。账号登录和 Funnel 授权仍在官方网页完成。
- 普通公网验证的代理复用 [https-proxy-agent](https://github.com/TooTallNate/proxy-agents/tree/main/packages/https-proxy-agent) 与 [proxy-from-env](https://github.com/Rob--W/proxy-from-env)，保留目标／代理 TLS 验证与 NO_PROXY；Tailscale `*.ts.net` Funnel 探测强制直连。DNS 重试上限来自 [Funnel DNS 传播说明](https://tailscale.com/docs/features/tailscale-funnel#dns-propagation)。Linux tailscaled 直连设置与实网验证记录见 [remote-access-review.md](../history/remote-access-review.md)。
- 新运行时验证使用隔离 CLI/daemon 夹具；另外已实际启动安装的 tailscaled 用户态二进制，核对 NeedsLogin 与关闭清理，未登录或发布真实公网服务。

## 0.21.0 · 全局人格、插件全量更新与手机工作空间

- 安装的 Pi coding SDK 1.0.0 `dist/core/resource-loader.js` / `DefaultResourceLoaderOptions.agentsFilesOverride`：复用公开 `loadProjectContextFiles` 及原生 AGENTS.override.md／AGENTS.md／CLAUDE.md 优先级。人格文件保存和控制层身份独立实现，正文通过已有 configure.instructions seam 追加。
- Pi 1.0.0 `dist/package-manager-cli.js` 的 update 解析和执行：`--extensions` 调用 DefaultPackageManager.update(undefined)，`--extension <source>` 调用 update(source)。本项目直接使用该原生管理器，不运行另一个交互 CLI 或更新 Pi 本体；全量按钮使用无项目的全局资源上下文。
- 多进程远程访问复用本包已有网关、扫码脚本、QR Code、Cookie 和 SSE；Tailscale 前台隧道依据[官方 Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)与[官方 Funnel 设置文档](https://tailscale.com/docs/features/tailscale-funnel)。仅验证公开 HTTPS 网关后才生成 QR，没有额外隧道实现。

  0.20.0 工作区视图选项与目录树参考同一 DSH commit 的 `ui-workspace/src/client/rows/WorkspaceBrowser.tsx`（ViewOptionsMenu）与 `ui-workspace/src/client/tree.ts`（owningParentFolder）。右侧浏览器采用用户提供的 ChatGPT 标签／地址栏参考图；代码使用已安装 Electron 的公开 `WebContentsView`、`View.setBounds/setVisible`、`NavigationHistory` 和受限 contextBridge 接口，无外部网页 preload，未复制 ChatGPT 源码。测试由本机静态 HTTP 夹具验证真实导航。

  0.19.0 会话导航、输入区与权限：读取已下载 DSH commit `d743267388641bc76f17c45ce8b4c231aed1d32c` 的 `ui-workspace/rows/Rows.tsx`、`WorkspaceBrowser.tsx`、`ui-conversation/skeleton/InputBar.tsx`、`ui-permission-presets/PermissionRow.tsx` 与 `ui-primitives/src/icons/{index,shared-artwork}.tsx`。图标 SVG 适配在 `dsh-icons.mjs`，MIT 全文与归属见 `licenses/deepseek-harness-MIT.txt` 和 `NOTICE`；未执行上游 UI 应用。

权限实现依照安装的 Pi 1.0.0 `docs/extensions.md`、`docs/codemode.md`、`docs/mcp.md`、`docs/security.md` 和公开 ExtensionAPI。Pi 原生没有 Read Only/Workspace Write 预设，本项目维护三档确认策略，执行／嵌套调用／交互由 Pi 提供。`durable-resources` 将核心工具与额外 Durable 工具适配到同一原生工具链，未建立独立模型循环。原无项目工具白名单与 ExecutionEnv 限制继续生效。

# 源码参考与适配记录

## 0.15.0 · Tailscale Funnel 手机连接

仅接入 Tailscale Funnel，继续复用原页面和 SSE。CLI 参数、HTTPS／Funnel 授权与手机不需要 Tailscale 客户端的使用条件，依据 [官方 Funnel 文档](https://tailscale.com/docs/features/tailscale-funnel)和 [CLI 文档](https://tailscale.com/docs/reference/tailscale-cli/funnel)。只读核对官方 `serve_v2.go` 的前台临时配置与 `serve.go` 的 HTTP Host 保留行为，没有复制代码、调用全局 reset 或运行持久的后台 Funnel。

本包独立实现回环授权网关和扫码 Cookie 兑换；真实公网需完成电脑 Tailscale 设置。临时 CLI／本地 TLS 代理与 Chromium 的验证范围见 [remote-access-review.md](../history/remote-access-review.md)。

## 0.15.0 · Pi Durable

默认宿主使用 npm 官方 `@earendil-works/pi-durable@1.0.2`、`@earendil-works/pi-ai@1.0.2` 和 `@earendil-works/chord@1.0.2` 的公开导出，实际 npm `.d.ts`／实现为本轮契约依据；没有复制框架源码。

- [官方 Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)：Harness、Conversation、SQLite、Registry、NodeExecutionEnv、requestId、configure、fork、abort 与 close/resume。main 文档会变化，锁文件固定实际 1.0.2。
- npm `dist/harness/types.d.ts`／`view.d.ts`／`live.d.ts`／`agent.d.ts`／`types.d.ts`：`ToolExecutionApi.env` 是属性，分页使用 `next`，Agent 配置与 Document 可在同一 commit 更新，view／taskGraph 是 disposable state。
- Pi AI `models.d.ts`、`auth/types.d.ts`、`providers/all.d.ts`：公开 Models、builtinModels/createProvider/lazyApi、CredentialStore 的串行 OAuth 刷新和离线目录恢复。本包不导入 Pi 核心的私有认证实现。
- `proper-lockfile@4.1.2`：单 owner 文件 lease；SIGKILL 回归实际核对锁过期、任务恢复、安全工具重放及副作用工具不重放。

2026-10-04 继续核对本包原生 SDK 1.0.0 的 `agent-session-services.d.ts`、`agent-session.d.ts`、`model-runtime.d.ts`、`extensions/tool-search/tool.js` 与 `extensions/codemode`：公开资源加载、工具执行／hooks、MCP、Tool Search loadout、ModelRuntime 注入。模板 expander 与 scoped MCP credential backend 的内部兼容访问集中在 `pi-sdk.mjs`；Durable 核心只使用公开导出。Todo／Ask User 测试调用真实已安装 rpiv 插件。

复用原 prototype 页面、bridge 和既有 Git／设置／包模块，没有新增 UI 栈。原布局和兼容 TUI Adapter 的来源映射继续如下。本轮验收见 [durable-desktop-review.md](../history/durable-desktop-review.md)。

读取于 2026-10-01；固定 commit 与研究见 [reference-research.md](reference-research.md)、[layout-settings-research.md](layout-settings-research.md)。以下引用来自本次克隆后直接阅读的源码。

| Pi Desk 中的设计／实现                       | 主要源码参考                                                                                                                                                                                                                                                                                                                                                                                          | 适配说明                                                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 左侧导航、中央会话、默认关闭的按需预览区     | [Harness AppFrame](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-layout/src/client/AppFrame.tsx)、[布局样式](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-layout/src/client/AppFrame.module.css)                                                               | 默认 rightbarShown/rightbarTrack=false；右侧仅在主动预览时展开，设置为主页面；手机单列与抽屉。                                                                     |
| 插件列表、配置抽屉／弹窗、显式保存、配置来源 | [ZCode PluginsSection](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/PluginsSection.tsx)、[PluginConfigControls](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/PluginConfigControls.tsx)                                                                                          | 当前表单使用弹窗；管理用户与项目作用域、包资源过滤和显式覆盖。详情来自官方 pi.dev；未声明的配置接口不猜测。                                                        |
| 配置草稿、版本冲突、保留未显示字段           | [Harness form-model](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-primitives/src/settings-form/form-model.ts)、[ProviderEditor](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-settings-models/src/client/ProviderEditor.tsx)                                   | `config-store.mjs` 使用内容哈希作 revision、文件锁与原子替换；`prototype.js` 关闭表单放弃草稿，提交局部字段。不能直接采用 Harness 的 Cordis 文档运行时。           |
| 模型服务卡片：端点、API 格式、密钥、模型列表 | [ZCode ProviderCardSections](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx)、[providerPersonalSave](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/lib/providerPersonalSave.ts)                                                             | 保存到 pi 的 `models.json`，保留已有模型元数据、headers 和 compat。已有密钥只返回是否配置，空输入不覆盖。                                                          |
| 手机卡片、模型 chips、底部安全区域           | [Miyu styles.css](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/styles.css#L10185)、[settings-schema.js](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/settings-schema.js)                                                                                                                            | 保留卡片摘要与模型标签结构；响应式页面使用 `100dvh`、`safe-area-inset-bottom` 和输入焦点适配。                                                                     |
| SSE 序号回放、前后台恢复、快照补同步         | [Miyu app.js](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/app.js#L10389)、[事件去重](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/app.js#L10928)、[server.rs](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/crates/miyu-hosts/src/web/server.rs#L1040) | `bridge.mjs` 为 pi 事件加 epoch 与 seq，维护有限回放缓存；客户端普通刷新保留流，快照期间缓冲增量，前台恢复重连；过期游标请求快照。实现为 Node 而非复制 Rust 服务。 |
| Electron 隔离窗口、拦截外部导航              | [Harness main.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/main.ts#L206)、[backend-controller.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/backend-controller.ts)                                                                                         | `desktop.mjs` 采用隔离窗口设置与导航策略；后端由 extension 当前进程持有，桌面窗口不创建新 agent。                                                                  |
| Electron 工程依赖版本                        | [ZCode desktop package.json](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/package.json)                                                                                                                                                                                                                                                            | 开发壳沿用上游 Electron 41 系列并更新到 41.10.7 修复版本；保留锁文件。没有引入 ZCode 的遥测、账号或发行流程。                                                      |

## pi 与现有插件的接口依据

`/pi-goal-x` 的展示适配依据 [Pi 官方扩展目录说明](https://pi.dev/packages/pi-goal-x) 与 [上游源码](https://github.com/tmonk/pi-goal-x)，重点对应 goal v3 tool details、`pi-goal-event` 和 `pi-goal-audit-event`。适配只把这些已声明字段转成 Desktop view model，不加载或改写插件运行时。生命周期设计参考 [DeepSeek Harness Cordis 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.zh.md) 与 [生命周期和 effects 教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)；Desktop 仅借鉴注册/清理边界，没有引入 Cordis 到 Pi Agent。

Todo 专用页面、projection 与 Durable 状态存储已移除。以下旧版本条目仅记录先前实现的来源，不代表当前功能。

真实 extension 接口依据本机 `@earendil-works/pi-coding-agent` **0.99.2** 的 `docs/extensions.md`、`docs/models.md`、`docs/packages.md`、`dist/core/extensions/types.d.ts` 和 `dist/core/model-registry.d.ts`。已通过本机 pi 的真实加载测试。

`index.ts` 使用 `registerCommand`、`on`、`sendUserMessage`、`setModel` 和只读 `sessionManager`。没有使用伪造的 `startDesktop`、通用插件参数读写或第三方 agent 接口。提供商刷新用 `ctx.modelRegistry.refresh()`；完整入口为 web.mjs 的原生 SDK 宿主；RPC 用于隔离测试和兼容 TUI 入口验证。

RTK 的首个表单适配器在直接阅读本地 `agent/npm/node_modules/pi-rtk-optimizer/src/{constants,types,config-store}.ts` 后编写，只修改实际存在的 `guardWhenRtkMissing`、`showRewriteNotifications` 两个布尔字段；其他配置保持原样。它不是 pi 所有插件通用支持的约定。

## 复用范围与声明

实现重写为适配 pi 的小模块，未合并三个项目的 agent 运行时，未复制其品牌图标、字体、模型或整套业务模块。Electron 窗口设置的适配注明了 Harness 来源；上游许可证和 ZCode NOTICE 随附于 `licenses/`。研究引用与适配记录不表示三个上游项目参与维护或认可本项目。

## 0.2.0 的新增源码映射

| 实现                           | 上游来源与使用方式                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认布局、独立设置、可选侧面板 | [ZCode WorkspaceShellLayout](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/WorkspaceShellLayout.tsx)、[useAppPanels](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/hooks/useAppPanels.ts)、[SettingsPage](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/SettingsPage.tsx)，以及 DSH AppFrame/stores 的默认轨道状态 |
| 字号、间距、表面、手机抽屉     | [ZCode DESIGN.md](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/DESIGN.md)、packages/ui/src/styles.css 的 text-ui scale / Zai Light token；adapt 为 vanilla CSS                                                                                                                                                                                                                                                                                |
| 文件写入和表单保存             | [DSH config-editor](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/config-editor/README.md)、[live settings cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.md)、ZCode pluginConfigPatch.ts；adapt 为 pi JSON revision + sparse patch                                                                                                                   |
| 插件市场                       | ZCode PluginStorePage / pluginStoreListing 的 installed 与 catalog 分离；实际数据使用 [Pi 官方目录](https://pi.dev/packages) 对应 npm pi-package keyword，安装调用原生 DefaultPackageManager                                                                                                                                                                                                                                                                                    |

运行接口来自本包 peer @earendil-works/pi-coding-agent 0.99.2 的 docs/sdk.md/settings.md/configuration.md/models.md/packages.md，dist/core/{agent-session-runtime,agent-session-services,settings-manager,model-runtime,package-manager,trust-manager}.d.ts 与 examples/sdk/13-session-runtime.ts。

无头宿主的 bindExtensions、普通 UI 对话和原生 theme 参考 dist/modes/rpc/rpc-mode.js；CLI 进程级代理与超时设置复用 dist/core/http-dispatcher.js，按 dist/main.js 相同次序应用。SDK 的 builtin/name/replaceable 由 docs/sdk.md InlineExtension 段确认。主题改用公开 Theme 构造器；HTTP 模块集中在 pi-sdk.mjs 的可选适配，不因该内部模块移动阻止常规启动。

通用 pi.webConfig / pi-web.config.json 是本包提供的自声明契约，不宣称是 pi 或上游项目已有的统一插件协议。未声明的私有字段不会被猜测或泄漏。

## 0.3.0 的布局与交互映射

- 设置完整分类框架和一致的内容起点来自 [ZCode SettingsPage.tsx](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/SettingsPage.tsx) 与 [SettingsPageParts.tsx](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/SettingsPageParts.tsx)：独立设置导航、返回会话、同宽分组设置卡与两列 setting row。
- `/` 交互来自 [ZCode SlashCommandPlugin.tsx](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/SlashCommandPlugin.tsx) 的真实 CLI catalog + skill 分组、输入区上方覆盖层、方向键／Enter／Tab／Escape，以及 DSH [PopupSelectView.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-commands/src/client/PopupSelectView.tsx) / PopupSelectView.module.css 的锚定、滚动与选中项展示。
- 提供商摘要、认证状态、模型展开和编辑层次参考 DSH [ModelsSection.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-settings-models/src/client/ModelsSection.module.css)、CustomProviderCard.tsx 及 ZCode ProviderModelSettingsGroups.tsx 的分组与独立表单；数据仍使用 pi ModelRuntime。
- 系统／明暗主题、字号偏好及语义前景／逆色按钮遵循 [ZCode DESIGN.md](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/DESIGN.md) 与 DSH ui-theme/src/styles/base.css 的主题角色。实现补充自动对比度回归。
- pi 的命令数据与执行依据本机 0.99.2 dist/core/agent-session.js 的 getRegisteredCommands、promptTemplates、resourceLoader.getSkills、skill expansion 和 compact；不使用预置假技能目录。

## 0.4.0 · Pi 官网与原生 MCP

- [Pi 官网 Changelog](https://pi.dev/changelog)：实际读取 HTML/CSS，采用 #161d27 / #212730 蓝黑画布、#6a9fcc 蓝色与细网格、衬线标题和像素等宽标签。未使用官网商业字体文件。
- [Departure Mono](https://github.com/rektdeckard/departure-mono) 的 public/assets/DepartureMono-Regular.woff2、[Commit Mono](https://github.com/eigilnikolajsen/commit-mono) 的 src/fonts/fontlab/CommitMonoV143-400Regular.otf、[Source Serif 4](https://github.com/adobe-fonts/source-serif) 的 WOFF2/OTF/SourceSerif4Display-It.otf.woff2；保留对应 SIL OFL 文本。
- DSH 的 ui-chat/src/client/chat/ReasoningRow.tsx、AssistantMarkdown.tsx 与 ui-tool/src/client/tool/components/ToolRow.tsx：思考披露、调用参数／输出分区、错误状态；此处重新实现原生 DOM 渲染，不引入其 agent 运行时。
- 本机 Pi 0.99.2 docs/mcp.md、dist/extensions/mcp/{index,config,oauth}.js、dist/core/mcp-servers.js、dist/core/package-manager.js：原生配置合并、信任、命名空间、过滤规则、OAuth 交互与凭据作用域。MCP 连接由公开 createMcpExtension 工厂创建，管理操作由原生 /mcp 命令处理。
- 版本适配依照 SDK 包的公开 exports；仅 HTTP 调度与自定义目录的 MCP credential backend 留在 pi-sdk.mjs 的明确内部边界。不是 Pi 源码分叉。

## 0.5.0 · 紧凑回复、富文本与二维码

本轮重新读取固定 commit 的 [DSH AssistantMarkdown.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx) 与 [ReasoningRow.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-chat/src/client/chat/ReasoningRow.tsx)：工具头由分组层处理、过程／最终回复分开、思考默认折叠并显示首行摘要。保留 ZCode 的工作空间／独立设置布局，在本项目实现原生 DOM 轮次分组，不复制上游 React 运行时。

Pi 官网 [Changelog](https://pi.dev/changelog) 中的 pi-logo-mark SVG 提供像素标志的几何路径；使用截图要求的单色 currentColor 版本。认证范围使用本机 Pi 0.99.2 的 ModelRuntime.getProviderAuthStatus 公共方法，未使用内部 credential 字段。

富文本实现依赖 [Marked](https://github.com/markedjs/marked)、[DOMPurify](https://github.com/cure53/DOMPurify)、[KaTeX](https://katex.org/docs/security.html)，二维码使用 [node-qrcode](https://github.com/soldair/node-qrcode)。这些开源包通过锁文件安装；Marked／KaTeX／QR 为 MIT，DOMPurify 为 Apache-2.0 或 MPL-2.0 双许可证，许可证随附 licenses/。数学库禁用 trust，并在插入 HTML 前统一清理。二维码解码测试使用 [jsQR](https://github.com/cozmo/jsQR)（Apache-2.0），运行时不加载测试库。全部资源及字体本地提供。

## 0.7.0 · TUI 承载唯一后端，三端共享

本机 Pi 0.99.2 的 `dist/core/extensions/types.d.ts` 确认 `session_shutdown.reason`、`session_start`、`session_info_changed`、`thinking_level_select`、`session_tree` 与命令级 `newSession/switchSession/reload`；`dist/core/agent-session-runtime.js` 确认会话替换会销毁并重新绑定扩展上下文。因此 `tui-host.ts` 按进程持有 bridge，控制请求通过原生命令分发取得新鲜上下文，不调用私有 AgentSession 字段，不修改上游安装。

`dist/core/agent-session.js` 的 getSessionStats 和 `dist/core/usage-totals.js` 为只读 entries 用量投影的语义依据；回归与原生 RPC 的统计逐字段核对。`@earendil-works/pi-ai/compat` 的 getSupportedThinkingLevels 与原生会话使用同一公开函数。`dist/modes/interactive/interactive-mode.js` 和 docs/tui.md 确认远端模型修改需要通过公开 UI status 触发 footer 重新渲染；真实 PTY 检查显示，不只验证内存值。

Electron 壳继续沿用既有 DSH 隔离策略。`desktop-launcher.mjs` 只传本机服务 URL 与 desktop.mjs，不启动 Pi；真实 Electron 43 + Xvfb 和临时 profile 验证 Desktop／TUI 状态与生命周期。原生事件未覆盖的队列、usage 及工具清单变化使用仅在前端订阅时运行的轻量状态指纹检测，不重新实现 Agent 运行时。

## 0.8.0 · 同进程多会话管理与命令适配

`session-manager.mjs` 的 ID registry、活跃／历史分离、事件分流与单会话停止参考固定提交的 DSH agent/session manager、多会话测试和 ZCode session resident pool；准确源码路径与重新获取记录见 [session-concurrency-review.md](../history/session-concurrency-review.md)。读取了上游测试，但没有运行或复制上游运行时。

公开 `ctx.ui.custom`、OverlayHandle、Input、Focus/Theme、参数补全、session_before_switch 和 session_shutdown 依据本机 Pi docs/extensions.md、docs/tui.md、examples/extensions/overlay-qa-tests.ts、extensions/types.d.ts、pi-tui 的 Input 与真实 interactive-mode custom UI disposal 实现。托管会话使用 Pi SDK；原生 teardownCurrent 的 abort/dispose 语义决定 /new 不可被当成无损并行接口。

`sessions-command.mjs` 统一 TUI/HTTP 命令解析，SDK 的 getAllTools/setActiveToolsByName 用于保持父工具范围。冷恢复队列、浏览器会话草稿及迟到清理、输入 undo/kill-ring 隔离、旧 registry 升级提示是本项目的回归驱动修正。未修改上游安装、进程私有字段或 Native renderer。

## 0.9.0 · 独立过程、原生问卷／任务与附件

- 独立过程依据 [DSH ReasoningRow](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-chat/src/client/chat/ReasoningRow.tsx)、[ToolRow](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx)、[QuestionToolRow](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-tool/src/client/tool/components/QuestionToolRow.tsx)：逐条 disclosure、实际状态、参数／结果和问卷入口；本包取消整轮 process 聚合，不复制 React 运行时。
- 输入区任务来自 [DSH TodoPanel](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx) 的 input dock、空状态不占位及真实 projection 思路。数据契约是本机 `@juicesharp/rpiv-todo` 2.12.0 的 state/replay.ts、tool/response-envelope.ts 和真实 tool_execution_end，而不是 DSH 的任务 reducer。
- 附件呈现与发送所有权参考 [ZCode ContextAttachmentPill](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/composer/ContextAttachmentPill.tsx)、[useComposerAttachments](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/composer/useComposerAttachments.ts)：选择／预览／移除、ready 门禁、scope 隔离和成功只清冻结 ID。ZCode 支持的 PDF／远程 path／白板等能力不代表 Pi 支持，未移植其格式解析或 transfer 服务。
- Ask User 契约直接读取本机 `@juicesharp/rpiv-ask-user-question` 2.12.0 的 ask-user-question.ts、rpc-fallback.ts、tool/types.ts、tool/response-envelope.ts；只使用 ExtensionAPI 公开事件与 ui.custom callback，RPC 保留原生对话协议和明确数字答案限制。
- 附件依据 Pi 0.99.2 dist/cli/file-processor.js、公开 ImageContent／prompt.images／sendUserMessage 和 SDK exports 中的 detectSupportedImageMimeTypeFromFile、convertToPng、resizeImage、formatDimensionNote；pi-tui 的公开 getImageDimensions 在解码前限制像素。CLI 的二进制 UTF-8 读取不是 PDF／Word 语义解析能力。
- 来源、测试与平台限制汇总于 [interaction-context-review.md](../history/interaction-context-review.md)。没有运行上游 DSH／ZCode 测试；验收均为本包隔离回归。

## 0.10.0 · Codex 会话选择器、ZCode Git 与粘贴

Codex 固定提交 `47379efd5289cba801c5a66273064fbe3bf92f60`：

- [session_picker.rs](https://github.com/openai/codex/blob/47379efd5289cba801c5a66273064fbe3bf92f60/codex-rs/tui/src/app/session_picker.rs)：选择／取消时保持输入状态与当前视图的原则；本包不复制额外 app-server 启停。
- [resume_picker/layout.rs](https://github.com/openai/codex/blob/47379efd5289cba801c5a66273064fbe3bf92f60/codex-rs/tui/src/resume_picker/layout.rs)：标题、搜索、行列表和键盘 footer，优先给窄／短终端留列表空间。
- [dense_narrow snapshot](https://github.com/openai/codex/blob/47379efd5289cba801c5a66273064fbe3bf92f60/codex-rs/tui/src/snapshots/codex_tui__resume_picker__tests__resume_picker_dense_narrow.snap)：窄屏单行名称／更新时间，避免横排全部会话标签。

ZCode 固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`：

- [GitPane.tsx](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/GitPane.tsx)：变更来源分组、按文件展开和懒加载 diff、加载／空／错误状态。
- [GitActionMenu.tsx](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/GitActionMenu.tsx)：提交对话的说明、已暂存／未暂存预览和 mutationPending 门禁；本包不提供 AI 提交说明或自动包含未暂存文件。

这些只是呈现与交互参考；一次性确认／指纹／工作区与 argv 验证是本包自己的安全实现。剪贴板使用浏览器 ClipboardEvent.clipboardData 的 File API，字节继续沿用 Pi 原生附件能力；不从文字推断宿主文件。

## 0.10.1 · Git 文件卡与状态

继续读取上述 ZCode 固定提交 GitPane.tsx 的 selected source / expandedPath / revision generation / lazy diff / emptyStateCopy，GitActionMenu.tsx 的 mutationPending、提交说明与已暂存预览门禁，以及 [GitPaneChangeCard.tsx](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/GitPaneChangeCard.tsx) 的普通 aria-expanded 文件按钮和仅展开行挂载 diff。

本包用原生 HTML/CSS/JS 呈现：分组计数、独立提交卡、轻量原文本 diff、有界单份缓存和明确的空／错误／旧宿主状态。未复制其 React/Radix/DiffViewer 运行时、未引入虚拟列表或额外 Git 来源模式。原一次性确认和固定 argv 安全实现保持不变。

## 0.14.0 · 整栏隐藏与官方目录

- [pi.dev/packages](https://pi.dev/packages) 的真实表单、data-package-card、官方分页和[完整详情](https://pi.dev/packages/pi-subagents)：name/type/sort/page、四种类型、downloads/recent/name；筛选计数含 `(of 总目录)`。实际代理配置下只读核对规范 URL，省略冗余默认参数而不跟随跳转。MCP 仅为关键词；recent 标为最近发布。
- Pi 固定 [`4c6fb7cfe8c538a668726f6f8b3554098c39faee`](https://github.com/earendil-works/pi/blob/4c6fb7cfe8c538a668726f6f8b3554098c39faee/packages/coding-agent/src/core/package-manager.ts) 的公共 DefaultPackageManager，以及实装 0.99.2 CLI／1.0.0 SDK：getInstalledPath/checkForAvailableUpdates/installAndPersist/removeAndPersist/update(source)，原生固定版本／项目覆盖与 SettingsManager.flush 语义。未复制私有包管理器或改上游运行时；原生不返回远端版本，未报告不等于最新。
- 整栏隐藏／恢复继续使用本包原生 DOM 与现有 pi.dev token，区别于关闭页签；沿用前述按需侧栏交互参考，不引入上游工作台。
- 研究见 [package-catalog-research.md](package-catalog-research.md)，验收见 [package-sidebar-review.md](../history/package-sidebar-review.md)。实际 pi.dev HTML 只作为惰性解析的测试捕获，不执行脚本／安装示例；测试仍使用临时 SDK／PTY 与本地 npmCommand 夹具。

## 0.13.0 · VSCode SCM Graph 与 Todo 批次

只读核对 Microsoft VSCode 官方固定提交 `7f20cdad4f4ab923272e91e330a7701c52706fc7` 的 [scmHistory.ts](https://github.com/microsoft/vscode/blob/7f20cdad4f4ab923272e91e330a7701c52706fc7/src/vs/workbench/contrib/scm/browser/scmHistory.ts)：`toISCMHistoryItemViewModelArray` 的 input/output swimlanes、真实 parentIds 与 reference 排序；`renderSCMHistoryItemGraph` 的连线、HEAD／多父节点及引用配色。保留概念与紧凑单行呈现，独立实现 SVG 数值几何，不复制 VSCode 工作台／运行时，不改全局 pi.dev 主题，不伪造 incoming/outgoing 节点。

OmniRoute 检索不可达，独立检索给出官方路径，GitHub API 限流；最终用官方仓库只读 `git ls-remote` 固定 SHA 并读取完整 raw 源码。没有执行上游代码或更改服务。Todo 原生事实仍来自 rpiv-todo 的真实 details.tasks/nextId；本包只增加已完成显示批次退休。验收见 [todo-graph-review.md](../history/todo-graph-review.md)。

## 0.12.0 · 主题恢复、侧栏与 Git 契约

主题以本仓库 `52ea5f2:design/pi-desktop/prototype.css` 的 pi.dev 色板／字体／网格为依据，ZCode 只作为右栏与 Git 交互参考；不把其 styles.css 全局 token 移植成新主题。拖动验收使用 Chromium CDP 的真实鼠标事件、pointer capture 和方向键。

Git 语义以本机 Git 2.55.0 与临时仓库实测为准：checkout 只分支／提交，reset 仅 soft/mixed，正常 merge 保留冲突，tag 为本地轻量或注释标签；详见 `test/git-operations.test.mjs` 与原生命令／浏览器确认回归。未运行上游代码、公共远端或真实宿主更新。验收记录见 [git-operations-review.md](../history/git-operations-review.md)。

## 0.11.0 · 常驻 Git 工具卡、右栏审查与 LSP

继续只读核对 ZCode 固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`：

- [ConversationStatusPanel.tsx / GitStatusSection](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationStatusPanel.tsx)：变更数、增删、分支与提交／推送的常驻紧凑工具卡。
- [AnimatedSidePanePanel.tsx](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/AnimatedSidePanePanel.tsx)：审查和工具输出共用右栏，以及窄屏的独立入口。
- GitPane.tsx 与 GitPaneChangeCard.tsx：来源选择、单展开文件、路径与增删统计、懒读差异和空状态；[styles.css](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/styles.css)：中性色面、圆角和 Git 状态 token。

实现仍为本包 HTML/CSS/JS，未复制 React/Radix/DiffViewer/虚拟列表运行时。审查表示 Git 变更视图，不生成 AI 审查结论。

LSP 依据本机已有 TypeScript Language Server 5.3.0 的 README、初始化选项实现与真实响应，以及 vscode-langservers-extracted 的 json-language-server/jsonServer.js：`handledSchemaProtocols` 和 JSON 配置契约。按 Content-Length framing、initialize/initialized、didOpen、publishDiagnostics 与 textDocument/diagnostic 接入真实诊断，拒绝文件编辑／命令／schema 内容 IO。使用现有 TypeScript 5.9.3 作缺少工作区编译器时的验证回退；未安装依赖或修改上述服务源码。真实临时 `.ts` 的 2322 与 `.json` 的 516 报错已在 Node 和 Chromium 验证；schema 本地 HTTP 探针收到零请求。全部边界见 [git-sidebar-review.md](../history/git-sidebar-review.md)。

## 0.9.2 · 输入栏控件与思考切换

ZCode 同一固定提交的 [Button](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/button.tsx) secondary/outline 表面、边框与 aria-expanded 状态，以及 [ModelConfigSelect](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ModelConfigSelect.tsx)、[ThoughtLevelCycleControl](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx) 的紧凑圆角 trigger 与顶部主题弹层。这里按用户要求提高默认表面／边框区分度，不照搬 ghost 的透明默认态。只用现有 HTML/CSS/JS 实现，未复制上游 React/Radix 组件。

思考逻辑依据 Pi 0.99.2 的公开 getSupportedThinkingLevels／AgentSession.getAvailableThinkingLevels／ExtensionAPI.setThinkingLevel，以及 dist/core/agent-session.js 的 setter：更新 Agent state、追加 thinking_level_change 并发出事件，不 abort。验证使用本地模型 SSE 和隔离 PTY；真实 GPT-6.1 Sol 仅读取声明的等级与运行状态，不发送外部模型请求或修改当前真实等级。

## 0.6.0 · 同端口共享与手机恢复

继续沿用上表 Miyu 的序号回放与前后台恢复思路，结合本项目的真实浏览器复现修正：状态刷新曾关闭健康 SSE，导致手机频繁显示重连。`connection.mjs` 改为持续连接、快照期间缓冲增量、无限退避重试与前台补同步；回放继续使用 epoch／seq。

访问流程按用户要求简化为一个端口和普通网页 URL。二维码仅编码局域网地址，不承载权限或一次性凭据，电脑与手机共享同一 Pi 会话。手机状态栏保留 DSH 的紧凑表达，在本项目使用 CSS container query 明确分成两行，避免随机换行；浏览器回归覆盖 320／360／390px 和长 Git 分支。Pi 的配置冲突校验及原生会话运行限制仍由原有接口处理。

- 私有 HTTP 响应流式 gzip 与即时刷新：[Node.js zlib flushing](https://nodejs.org/api/zlib.html#flushing)。采用原生 zlib，未复制上游实现。

## 0.16.0 · 独立 Host 与多个 Pi Agent 进程

2026-10-11 从 GitHub 官方 codeload 下载 DeepSeek Harness master 源码归档；git clone 在本机代理下失败，下载后的 archive pax comment 确认 commit 为 `d743267388641bc76f17c45ce8b4c231aed1d32c`。完整参考源码位于 `.reference/deepseek-harness`（忽略提交），可复现来源记录在 [upstream-sources.json](upstream-sources.json)。此次没有安装 DSH 模型运行时，也没有把 Cordis 引入 Pi 执行链。

- [host-process.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/apps/desktop/src/host-process.ts)：参考独立 child、IPC ready、shutdown 与终止期限，实现在 `src/control-plane/process.mjs`。Electron 使用同一可执行文件配合 `ELECTRON_RUN_AS_NODE=1`。
- [backend-controller.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/apps/desktop/src/backend-controller.ts)：参考生命周期 owner、启动期间取消和失败清理；主管进程在 `supervisor.mjs` 管理每个 Pi Agent，不使用 DSH controller 类型或业务运行时。
- [main.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/apps/desktop/src/main.ts)、[Desktop README](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/apps/desktop/README.md)：继续采用隔离窗口与独立后端边界。MVP 采用同源 loopback HTTP 代理复用 Pi 页面；没有复制 DSH 的自定义协议、账号、打包和更新流程。
- [Pi Durable](https://earendil.com/posts/pi-durable/) 与本地 `@earendil-works/pi-durable@1.0.2`：实际运行 Harness、SQLite、任务恢复、CodingTools 与 NodeExecutionEnv。进程主管只管理生命周期，不实现持久化模型循环。
- 本地 `@earendil-works/pi-coding-agent@1.0.0/dist/core/resource-loader.d.ts`：使用其公开额外 extension、skill、prompt 路径及 `appendSystemPrompt`，项目配置与 Agent 配置由 Desktop 合并后传入原加载器。

## 0.17.0：无项目权限与官方品牌

- 官方颜色与标志：2026-10-11 读取 [pi.dev/style.css](https://pi.dev/style.css)、[logo-auto.svg](https://pi.dev/logo-auto.svg)。采用深蓝画布、浅色月石／纸色及三色几何标志（#F09082、#4D9ABF、#F1BE58），没有复制官网脚本或字体。
- Desktop 生命周期继续参考已下载 DeepSeek Harness 的 host-process.ts、backend-controller.ts、main.ts（版本见 upstream-sources.json）；会话创建、消息提交与恢复通过既有 Pi Durable 公开 Harness 接口实现。
- 只读权限依据本地 Pi Durable 1.0.2 ExecutionEnv、Registry、CodingTools 公开接口；Pi SDK DefaultResourceLoader 使用 noContextFiles/noExtensions 禁止无项目扩展执行和项目上下文注入。包安装／更新／卸载复用 Pi coding SDK 1.0.0 的公开 DefaultPackageManager，并通过 getInstalledPath 解析本地来源。

## 0.18.0：DSH 会话菜单与统计胶囊

- 已下载的同一 DSH commit：`apps/web/tests/expected/menu-material/session-menu.expected.md`（原生 menu/menuitem 的会话管理布局），以及 [StatsPills.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-chat/src/client/chat/StatsPills.tsx)（紧凑用量、点击明细、持久累计量及缓存输入侧分母）。仅参考交互和统计语义，以本项目的 Pi 进程启停和 Pi 原始计数实现，未复制 React／DSH 运行时。
- 本地 Pi Durable 1.0.2 `Conversation.context`／ContextView 与 `pi.usage` 文档；Pi AI 1.0.2 公开 `utils/estimate` 中的 calculateContextTokens、estimateMessageTokens。上下文遵循公开 head 语义，UI 不依赖框架私有字段或源码 deep import。

2026-10-12 会话与项目同步：复用 Pi 1.0.0 的公开 `SessionManager`、`getDefaultSessionDir`、`parseSessionEntries`、`buildSessionProjection` 和 `convertToLlm`，以及 Pi Durable 的公开 `Conversation.entries/commit` 进行 JSONL 展示、写回与上下文接管。`SessionManager.listAll(customDirectory)` 只扫描该目录，因此主管层枚举 cwd 子目录并有界调用，不依赖私有 Harness／SessionManager 字段。

侧栏延续已下载 DSH commit `d743267388641bc76f17c45ce8b4c231aed1d32c` 的 `packages/client/ui-workspace/src/client/rows/Rows.tsx`、`WorkspaceBrowser.tsx` 和 `client/tree.ts`：cwd 项目分组、最近更新排序、置顶／归档操作、默认隐藏归档，以及显示／仅显示归档选项。此次仅参考交互，未复制新的 DSH 代码。
