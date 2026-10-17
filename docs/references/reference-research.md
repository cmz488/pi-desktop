> 专题研究资料：以记录中的版本、提交和日期为准；当前行为见 [文献入口](../README.md)。

# Pi Desktop：三个参考项目的源码研究

研究日期：2026-10-01。范围：用户指定的 DeepSeek Harness 桌面端、ZCode 桌面端和 Miyu Agent Web 端。研究依据为实际克隆的源码，README 只用于定位；没有启动这三个应用，也没有验证其全部运行时行为。

本文区分“源码事实”和“用于 Pi 的设计建议”。三个项目的运行时、插件协议和配置格式各自独立；方案不把三个运行时直接融合，不把它们的业务配置写入 Pi。复用以架构、交互和少量明确许可的实现模式为主。

## 固定版本与源码位置

| 项目             | 本次读取 commit                            | 本地目录                                      | 根许可证                                                                                                     |
| ---------------- | ------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| DeepSeek Harness | `639ed015397290b3745d163aafe02ffee4aa3f84` | `/tmp/pi-desktop-references/deepseek-harness` | [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/LICENSE) |
| ZCode            | `29628c9acdb81b703bbd4080c207a0e7ce5e276e` | `/tmp/pi-desktop-references/ZCode`            | [Apache-2.0](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/LICENSE)         |
| Miyu Agent       | `31166e572ea20cd9a0e027781fb82cb8e5363dd7` | `/tmp/pi-desktop-references/miyu-agent`       | [MIT](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/LICENSE)     |

这些是研究时检出的版本，不宣称永远为最新版本。源码链接均固定到上述 commit。

## DeepSeek Harness：共享 Web 界面、独立桌面 Host、分层配置

**桌面确实有实际源码。** `apps/desktop/src/main.ts` 使用 Electron `BrowserWindow`，关闭 `nodeIntegration`，开启 `contextIsolation`、`sandbox` 和 `webSecurity`。桌面主进程建立 `DesktopBackendController` 和 `DesktopHostProcess`，等待 Host 就绪并认证本机 Web Host，然后连接 welcome backend。它提供了“桌面壳管理后端与系统能力，界面通过本机 Host 工作”的具体例子。[窗口实现](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/main.ts#L206)、[后端启动](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/main.ts#L442)

**Web 服务与界面分离。** Host 的 WebServer 配置允许 `127.0.0.1` 或 `0.0.0.0`，管理 HTTP 路由与 upgrade 路由；UI 位于 `packages/client`。`AppFrame` 采用侧栏、主区域和可选右栏，由 slot 提供内容，并通过 ResizeObserver 与拖拽更新布局。适合 Pi 桌面端采用“会话在中心，插件/服务管理是全局面板，详情按需打开”的结构。[WebServer](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/host/webserver/src/index.ts#L58)、[AppFrame](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-layout/src/client/AppFrame.tsx#L1)

**配置编辑不是任意整文件覆盖。** `ConfigFormSnapshot` 区分 base/user/effective value、revision、writable 及 host/memory 模式。`mutate` 将多个字段操作作为一个原子 namespace mutation，并带 revision fence；快速字段写入保序，被 Host 拒绝时读取权威状态。对于桌面与手机同时编辑 Pi 配置，这比客户端直接写 JSON 更可靠。[配置契约](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-settings/src/client/config-form-types.ts#L7)

**模型服务编辑使用局部 patch，并保护已配置密钥。** `ProviderEditor` 根据当前未保存的 endpoint/API/key 构造 probe 输入；保存时仅对可见字段构造 path operations，注释明确解释：客户端收到的脱敏 descriptor 不适合整体 replace，否则会丢失卡片未显示的字段。空的 key 输入表示没有提交新密钥。[模型服务 probe 与局部写入](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-settings-models/src/client/ProviderEditor.tsx#L228)

**插件列表区分配置启用与实际运行阶段。** `PluginInventoryEntry` 包含稳定 entryId、moduleName、enabled 与 `pending/loading/active/failed/unloading/null` 的 Fiber 状态；它们是 Harness 自身的 Cordis 概念，不能宣称 Pi 具有同样生命周期。适合借鉴“已安装、已启用、当前已加载、错误”分开显示。[插件 inventory 类型](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/host/plugin-inventory/src/types.ts#L4)

**连接具有明确恢复状态。** `ConnectionController` 提供 connected/disconnected/connecting、generation、指数退避、手动重连及网络离线暂停。`browser-auth.ts` 采用随机 launch token、HMAC 签名 cookie、恒定时间比较、HttpOnly/SameSite 属性。可以借鉴连接状态与会话认证思路；这本身不证明具备手机扫码配对、逐设备撤销或公网 TLS 配置。[连接恢复](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/connection/src/client/connection.ts#L42)、[浏览器认证](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/connection/src/browser-auth.ts#L52)

## ZCode：服务接口、传输适配、配置作用域与原子存储

**真实桌面在 `packages/desktop`。** `desktopHostProcess.ts` 通过 Electron `utilityProcess.fork` 启动 Host；`desktopWindowChrome.ts` 创建隔离窗口。不能仅因它具有独立 Host 就假定它默认在退出桌面后继续服务手机。[Host 启动](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopHostProcess.ts#L249)、[窗口配置](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopWindowChrome.ts#L571)

**共享服务契约支持不同 transport。** `RemoteServiceAccess` 从 `ChannelClient` 建立 File/Session/Provider/Plugin 等服务代理。桌面通过 `MessagePortProtocol`，WebSocket 通过 `SocketProtocol`，两者最终都创建同类服务访问对象。Pi 可以借鉴“一组 typed commands/events，多种客户端连接”的边界，不需要把 ZCode 的 RPC 实现整体搬入 Pi。[共享服务代理](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/client/src/remoteServiceAccess.ts#L46)、[MessagePort](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/client/src/messageport.ts#L25)、[WebSocket](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/client/src/websocket.ts#L62)

**有 HTTP/WebSocket 服务端实现。** `packages/server/src/http.ts` 使用 Node WebSocket 适配，支持 `/ws/host` 等端点、静态文件、可选 token middleware。源码表明 Web 访问能力存在，但不是完整的 Pi 手机配对产品，也不能据此宣称所有路由总是强制认证。[HTTP 服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/http.ts#L304)

**提供商配置采用锁、验证、原子写与 revision。** `PersonalProviderConfigRepository.update` 在文件锁内重新读取并提交；写前 encode/decode 校验，使用 `atomicWritePrivateTextFile`。文件损坏时保留原文件，以内存空 overlay 降级并上报，不擅自覆盖为空。这对管理用户现有 `models.json` 与 `settings.json` 很有价值。[更新和读取](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/provider-node/src/personal-provider-config-repository.ts#L70)、[校验、原子写、损坏保留](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/provider-node/src/personal-provider-config-repository.ts#L143)

**插件表单来自明确声明，并显示字段来源。** `PluginConfigControls` 遍历 `plugin.userConfig`，使用 option 类型、required、sensitive 和 scope 来源生成控件；支持清除当前作用域值以及恢复继承。Pi 并没有因此自动获得任意扩展的 schema，应为 Pi 扩展增加可选桌面配置 manifest，未知扩展仅显示管理信息或明确选择的原配置编辑入口。[插件表单与作用域](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/PluginConfigControls.tsx#L25)

**插件开关处理异步与竞态。** `setPluginEnabledOptimistically` 按 workspace/scope/plugin 标识当前请求，先展示期望状态，失败恢复前值；过期请求不修改当前工作区。Pi 产品应清楚标识“已保存，等待会话重载”，不能把界面开关直接当作 Pi 已经卸载某个执行中的扩展。[开关实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/store/pluginManagementStoreEnabled.ts#L24)

**模型页面采用列表与详情。** 服务管理使用导航列表和右侧详情面板，并有新增/刷新入口；窄屏导航缩小。这适合 Pi 的多 provider 管理，但无需移植其 Coding Plan 订阅、账号与企业权益业务。[布局实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/model-provider-section/SectionLayout.tsx#L53)

## Miyu Agent：手机 Web、SSE 回放、密钥三态修改

**架构是 Rust daemon 和静态 Web UI。** `web/app.js`、`web/settings.js`、`web/settings-schema.js` 是实际前端实现；Rust `web/server.rs` 创建 manager、actor、EventHub、QuestionBroker，并暴露 HTTP 路由。不是 Electron 桌面代码。启动实现当前默认绑定所有接口，并建立登录系统；Pi 方案应显式启用远控后再绑定，不能照搬默认开放局域网或内置 `miyu/miyu` 首次登录。[daemon 启动](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/crates/miyu-hosts/src/web/server.rs#L54)、[登录实现](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/crates/miyu-hosts/src/web/security.rs#L25)

**事件具有序号、回放窗口和 snapshot 降级。** `EventHub` 为事件提供 id、run_id、session_id，广播与缓冲共享 Arc；缓冲有数量和 4 MiB 字节水位限制。`subscribe_after` 在同一锁下建立直播订阅和历史 pending，避免两者衔接遗漏。请求位置过旧或超出当前范围时返回 `resync_required`。Pi broker 应有自己的 daemon epoch + 单调 sequence，不能直接把 Pi stdout delta 当作可恢复的跨设备协议。[EventHub](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/crates/miyu-hosts/src/runtime/events.rs#L39)、[订阅与 resync](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/crates/miyu-hosts/src/runtime/events.rs#L116)

**手机恢复连接有真实处理。** 前端使用 `/api/events?after=...` 的 EventSource，显示 online/connecting/offline；`visibilitychange` 仅在连接已经死亡时重连、补同步，避免每次切回前台重建长会话。[SSE 连接](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/app.js#L11090)、[手机回前台](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/app.js#L10390)

**手机布局考虑软键盘和安全区域。** 前端监听 `visualViewport.resize/scroll`，将 viewport 高度写入 `--app-height`；836px 以下侧栏变为抽屉，使用 safe-area-inset。Pi 的手机输入栏、确认卡片、设置抽屉应采用这些布局原则，并实测 Safari/Chrome 软键盘。[viewport 处理](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/app.js#L13845)、[响应式抽屉](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/styles.css#L7885)

**配置页有 schema 和密钥修改语义。** `settings-schema.js` 明确声明 toggle/number/text/select/secret/model-pool 等字段；`secretControl` 只展示是否已配置，新值单独暂存，空输入保留，clear 显式清空。后端请求把普通 config 与 secrets 分开，写入要求管理员、校验 candidate，并恢复不变的密钥；适合借鉴 keep/set/clear 协议，避免把星号占位当作真实 API key 保存。[schema](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/settings-schema.js#L1)、[密钥控件](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/web/settings.js#L736)、[配置写入 API](https://github.com/SHORiN-KiWATA/miyu-agent/blob/31166e572ea20cd9a0e027781fb82cb8e5363dd7/crates/miyu-hosts/src/web/config_api.rs#L12)

## 应用于 Pi 的具体建议

以下为本次研究推导的设计，不是三个项目已经提供的 Pi 能力。

1. **Pi 仍是唯一 agent runtime。** 建立 Pi RPC/SDK adapter，broker 负责会话索引、事件、配置事务和配对，桌面及手机都是客户端。Electron 的窗口关闭与 broker/会话生命周期独立设计。
2. **共享响应式 Web UI。** 桌面默认左侧会话、中间聊天，右侧详情按需出现；手机单列、会话抽屉、固定输入栏，配置页改为完整页面。借鉴 DeepSeek 的模块边界、ZCode 的列表/详情、Miyu 的移动视口处理。
3. **配置集中写。** broker 持有 Pi 文件写权限；写入带 expectedRevision，先验证，再同目录原子替换，保留未知字段，外部变更触发更新。客户端冲突时提示重读，不静默覆盖另一设备。
4. **扩展管理分清来源与生效。** 显示 package/extension/skill/prompt 的实际来源和 global/project scope；可选 manifest 提供 schema、secret 和 apply 策略；不推断所有扩展支持热卸载。
5. **提供商与密钥分开。** Provider 的协议、baseURL、模型列表与默认模型来自 Pi 真实接口；API key、环境变量引用、OAuth 状态各自显示。只返回已配置状态；更新用 keep/set/clear，probe 使用未保存草稿时清晰说明目标。
6. **远控在 broker 侧授权。** 一次性配对、逐设备可撤销授权、Origin 检查、HTTPS/WSS 或受信私网通道；手机连接断开不停止本机 agent。跨设备输入与审批使用 requestId 和版本，防止重复发送与重复响应。
7. **事件增量加 snapshot。** broker 提供序号回放、有限缓存、断线恢复、epoch 检查和 resync snapshot。当前 Pi JSONL 会话文件仍是历史依据，不把内存事件缓存当作永久历史数据库。

## 复用与验证边界

本次未复制上述项目的实现代码，没有运行安装脚本，没有更改 Pi 用户配置。将来如果复制代码或素材，需保留对应许可/版权，ZCode 还需核对 [NOTICE.md](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/NOTICE.md) 和 [第三方声明](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/THIRD-PARTY-NOTICES.md)，Miyu 的字体、模型和 vendor 资源也有各自 LICENSE。根许可证不等于所有素材许可证。

尚需 Pi 实现阶段验证：RPC 模式下现有扩展的兼容性、配置重新加载机制、OAuth 流程、不同平台 Electron 打包、手机软键盘与断线恢复、并行配置修改、跨设备审批重复提交。不能把参考项目运行时的能力当作 Pi 已支持的事实。
