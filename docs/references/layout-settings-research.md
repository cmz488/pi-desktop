> 专题研究资料：以记录中的版本、提交和日期为准；当前行为见 [文献入口](../README.md)。

# 布局、设置与无头入口源码核对

核对日期：2026-10-01。以下针对已下载源码，不把参考项目的特有协议当成 pi 已有能力。

## 1. 默认布局：主会话优先，右面板按需出现

- ZCode 明确要求默认关闭右侧共享面板，只有主动查看时展开；底部终端也默认关闭。`packages/ui/src/hooks/useAppPanels.ts:189` 有对应说明和状态初始化。右面板支持浏览器、代码查看、Git、终端等独立标签，非固定状态栏。`WorkspaceShellLayout.tsx:423` 仅在主视图为 chat 且 isSidePaneOpen 时开启面板。源码：[useAppPanels](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/hooks/useAppPanels.ts)、[WorkspaceShellLayout](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/WorkspaceShellLayout.tsx)。
- ZCode 的文件树实际属于**左侧 WorkspaceSidebar**，`WorkspaceSidebar.tsx:1671` 按 fileTreeTarget 切换该侧栏；点击文件后，代码查看可进入按需右面板。设置由独立 `SettingsPage.tsx` 呈现，并非工作区右栏固定内容。源码：[WorkspaceSidebar](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/WorkspaceSidebar.tsx)、[SettingsPage](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/SettingsPage.tsx)。
- DSH 的布局根为 sidebar / main / rightbar 三个槽，但右轨道默认隐藏：`ui-layout/src/client/stores.ts:86` 初始化 rightbarShown=false / rightbarTrack=false；`AppFrame.tsx:46` 说明没有 occupant 要求轨道时宽度为零。实际右面板包 `ui-sidebar-right` 的 store 初始化为空，首次 session 读取 materialize collapsed empty column；展开才创建注册的默认页/guide，页面可被插件贡献，文档预览是一种真实 tab。源码：[AppFrame](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-layout/src/client/AppFrame.tsx)、[stores](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-layout/src/client/stores.ts)、[sidebar-right](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-sidebar-right/src/client/index.ts)。
- DSH 的 main panel 选择 Conversation 或全局面板，切换设置保持当前 Session；`ui-layout/src/client/stores.ts:16` 与 `AppFrame.tsx:39` 明确此语义。

**用于本项目的结论（设计取舍）：**默认保留左侧会话/工作区导航与主会话，删除固定的状态/能力/远程宣传栏。设置作为主视图的独立页面，右侧只在用户主动打开具体内容预览时出现。不能把右侧无条件替换成“工作区文件或设置”。

## 2. ZCode 官方 DESIGN.md 可直接映射的规则

已通过浏览器读取官方 [DESIGN.md](https://github.com/zai-org/ZCode/blob/main/DESIGN.md)，本地路径 `/tmp/pi-desktop-references/ZCode/DESIGN.md`。

- 产品是平静、紧凑、可操作的 AI 工作区；排版应服务长期阅读、键盘操作、桌面与 Web 一致性。
- 基本文字默认 14px，次级 12px；10px 仅小标签等弱信息。字号改变只改 `--ui-font-size`。移动端可编辑输入用固定 16px 防 iOS 缩放。
- 4px 间距基线；常用 8 / 12 / 16px。颜色采用背景/侧栏/卡片/弹层/输入的语义 token，品牌色仅少量强调。
- 普通容器 12px 圆角起步，控件 8px；输入主壳/弹窗可用 16px。避免营销式大留白、渐变与大面积品牌填色。
- wide Web 是 conversation、可选 bottom terminal、Side Pane 独立框架，4px 可拖动间隙；手机远控是单列和抽屉。来源：DESIGN.md 的 Workspace layout / Responsive Behavior。

## 3. 设置与写入语义

- ZCode 使用独立设置导航页与 scope 区分；插件已安装管理和市场数据分别建模。`PluginsSection.tsx` 使用 marketplaces / installedPlugins / configScope 及 capability projection，不能拿模拟卡片代替真实市场状态。[源码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/PluginsSection.tsx)。
- `settings/pluginConfigPatch.ts` 只写产生 draft 的字段，effective values 不能整份写回成为 scope override；null 是显式清除，敏感字段空白是不修改。[源码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/pluginConfigPatch.ts)。提供商 `lib/providerPersonalSave.ts` 保存稀疏 Personal Overlay，保留未编辑内容。[源码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/lib/providerPersonalSave.ts)。
- DSH `ui-primitives/src/settings-form/form-model.ts` 将编辑先暂存，显式 Save 才调用 revision-fenced mutation，invalid draft 阻止写入；secret 控件为空不写。`packages/boot/config-editor/README.md` 说明先验证完整 candidate、同步外部修改、与 profile/HMR 操作序列化、原子替换配置 override，并在失败后恢复旧文件。它写的是 DSH profile patch，不能把 YAML/profile 格式迁移到 pi JSON 配置。[form-model](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-primitives/src/settings-form/form-model.ts)、[config-editor](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/config-editor/README.md)。
- 官方线上 cookbook 确认 schema 字段、secret role、form.mutate(operations, expectedRevision)、主机验证与持久化的边界：[live configuration forms](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.md)。

## 4. 本机 pi 0.99.2 的真实能力

安装根目录：`/home/cmz488/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent`。该 package.json 版本为 0.99.2，公开 exports 和 dist 声明可作为实现依据。

### 无头与会话

`docs/sdk.md`：createAgentSession 不创建 TUI，默认发现工作目录资源、持久化会话、用户和项目配置、凭据。AgentSession 拥有会话、工具、模型、扩展运行时。

`examples/sdk/13-session-runtime.ts` 与 `dist/core/agent-session-runtime.d.ts`：createAgentSessionServices → createAgentSessionFromServices → createAgentSessionRuntime；runtime.newSession/switchSession/fork 会替换 session，必须重新 bindExtensions 和 subscribe；dispose 清理运行时。公开导出位于 `dist/index.d.ts:20`。

### `pi web` 不能通过 registerCommand 变成子命令

`dist/main.js:443` 依次处理 auth、package、config、mcp 命令，再把其余参数交给 parseArgs；没有自定义子命令注册。`ExtensionAPI.registerCommand` 是 TUI/RPC 斜杠命令；registerFlag 是自定义选项。上游原版 `pi web` 会把 web 当成提示文本，而非启动服务。

**可行且非破坏的实现选择：**本包提供 launcher，并提供用户自愿安装到 PATH 优先目录的轻量 `pi` wrapper；`web` 由 wrapper 分发无头宿主，其他参数原样 exec 解析到的原版 pi。安装器必须记住绝对原版路径、防递归、提供卸载恢复，不覆盖 `/home/cmz488/.npm-global/bin/pi` 或修改上游 node_modules。应在文档准确说明这是本 extension 包提供的启动适配器。单纯宣称原生 extension 支持 CLI 子命令不成立。

### 模型与认证

`dist/core/model-runtime.d.ts`：公开 ModelRuntime.create、getProviders/getModels/getAvailable、getProviderAuthStatus/listCredentials、refresh、login、logout。login(providerId, 'api_key' | 'oauth', { prompt, notify, signal }) 同时用于 API key 和 OAuth；AuthInteraction 的 prompt 有 text / secret / select / manual_code，notify 有 info / auth_url / device_code / progress。类型在 pi-ai `dist/auth/types.d.ts`。

ModelRuntime.login 使用 canonical credential store 存认证并同步可用模型；`setRuntimeApiKey` 是临时 override，不能当成持久 API key 配置。`listCredentials` 只有 providerId / type，没有 secret。自定义提供商 endpoint/model 在 models.json；内置提供商凭据在 auth.json，Web 必须分别处理。

### 原生包管理与市场

公开 DefaultPackageManager 构造参数为 cwd / agentDir / settingsManager；installAndPersist、removeAndPersist、update、listConfiguredPackages、resolve、setProgressCallback 可直接复用。资源路径包括 extensions / skills / prompts / themes，带 enabled 与 scope/source metadata。源码声明：`dist/core/package-manager.d.ts`；文档：`docs/packages.md`。

官方 [Pi package gallery](https://pi.dev/packages) 使用 npm 的 pi-package keyword 发现包。应使用真实 npm registry 搜索结果并让原生包管理器安装其 npm:source；不要复用 ZCode 市场协议或伪造固定 catalog。Pi 原生支持 npm/git/local，声明写入 user settings 或 --local project settings；项目资源先受 project trust 管理。

### 设置范围

`docs/settings.md` 是当前完整键表：模型和 thinking、steering/followUp、defaultTools/codemode、compaction/branchSummary、terminal/display、network/retry/proxy、shell、resources、telemetry/warnings。项目 override 用户配置，资源列表合并；cacheWarming/httpProxy/defaultProjectTrust 只能全局设置。

`dist/core/settings-manager.d.ts:204` 提供 getSettings/getGlobalSettings/getProjectSettings、isProjectTrusted、reload、flush 和专项 setter。settings.json 稀疏 mutation 后可 reload；涉及 session 生效的项目应调用 session 对应方法或明确要求重载。不能把 Web appearance 设置写到 pi 的 TUI theme 键而声称是 Web 主题。

## 5. 来源目录与版本

- ZCode 本地 `/tmp/pi-desktop-references/ZCode`，commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。
- DSH 本地 `/tmp/pi-desktop-references/deepseek-harness`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`，默认分支 **master**（不是 main）。
- Miyu 本地 `/tmp/pi-desktop-references/miyu-agent`，commit `31166e572ea20cd9a0e027781fb82cb8e5363dd7`。移动同步/重连来源保留既有 reference-research.md；本次不把 Miyu 作为桌面默认布局依据。
