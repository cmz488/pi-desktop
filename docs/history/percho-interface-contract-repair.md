# Percho 前后端接口逐项对照与修复

本次以实际 `shared/ipc-channels.ts`、React／手机端消费者和 Host HTTP 适配器为依据，核对 122 个 invoke 方法、17 个订阅。下表记录接口声明和后端归属，不将“路由存在”当作每种业务状态都已端到端通过。

## 已修复差异

| 消费路径 | 差异 | 修复与证据 |
| --- | --- | --- |
| 添加项目 | 消费者调用不存在的 `validateDirectory` | 使用实际 `validateProjectDirectory`；真实浏览器覆盖无效目录报错与有效目录保存，且不创建 worker |
| 方法清单 | 旧表把文档示例 `domain:action` 计作接口 | 移除虚构项，逐条对照当前 122 个实际方法的名称、通道、作用域与操作类型 |
| 订阅 | 多个通道名、Provider／MCP／频道订阅的环境作用域与实际定义不同；分发器把方法名当通道 | 按实际订阅表对齐；通过显式环境 API 验证 Provider 登录订阅的真实通道 |
| 能力判断 | SSH 检查使用不存在的 `remote:getStatus` | 使用 `remote:status`；能力参数绑定实际通道字面量类型 |
| 删除 Provider | 前端传 `providerId`，后端适配读取 `id` | 转为原生 `id`，回传原生 revision；真实 Host 创建／删除验证 |
| 编辑 Provider | 端点编辑丢弃随表单提交的密钥，未配置的内置项被拒绝 | 允许实际目录中的内置项；自定义服务按原有配置提交，内置凭据走 SDK 原生登录接口 |
| 内置 Provider 端点 | 空串恢复默认被 URL 验证拒绝；无自定义模型的端点覆写未进入 SDK 运行态 | 允许内置端点恢复默认；在原 SDK Provider 上投影模型端点，保留其认证、OAuth、动态目录和请求方法；测试实际 SDK 模型地址、默认恢复与未知字段保留 |
| 模型目录 | 无凭据内置项缺少模型／API／端点信息；覆盖内置项缺少标记；环境凭据未标为已配置 | 补齐 SDK 目录与覆盖元数据，复用 SDK 可用性结果，避免把环境认证误显示为未配置 |
| 持续检查 | 项目检查未编译 React／手机前端，方法拼写错误能进入打包 | `npm run check` 纳入 `typecheck:ui`；使用 Vite 类型、Bundler 解析与 ES2023，修正 bridge 回调、附件及消息联合类型 |

## Invoke 全表

当前声明已接入 64 项，明确不支持 58 项。SSH、内置更新器、Percho UI 插件及其他缺少原生等价能力的接口仍按支持表报告不可用，保持原有支持范围。

| 方法 | 通道 | 作用域／操作 | 后端或不可用原因 |
| --- | --- | --- | --- |
| `createSession` | `session:create` | environment／mutation | 已接入：`/api/workspace/command` |
| `listSessions` | `session:list` | environment／read | 已接入：`/api/sessions` |
| `getQuota` | `session:getQuota` | environment／read | 不支持：我们没有 provider 套餐额度服务 |
| `setModel` | `session:setModel` | environment／mutation | 已接入：`/api/model` |
| `listAllSessions` | `session:listAll` | environment／read | 已接入：`/api/sessions` |
| `openSession` | `session:open` | environment／mutation | 已接入：`/api/workspace/command` |
| `closeSession` | `session:close` | environment／mutation | 已接入：`/api/workspace/command` |
| `deleteSession` | `session:delete` | environment／mutation | 已接入：`/api/workspace/command` |
| `prompt` | `session:prompt` | environment／mutation | 已接入：`/api/prompt` |
| `retryLastFailedTurn` | `session:retryLastFailedTurn` | environment／mutation | 不支持：我们走 Durable 的 generation 重试；Pi SDK 未提供该公开入口 |
| `abort` | `session:abort` | environment／mutation | 已接入：`/api/abort` |
| `setThinkingLevel` | `session:setThinkingLevel` | environment／mutation | 已接入：`/api/thinking` |
| `getPendingInteractions` | `session:getPendingInteractions` | environment／read | 已接入：`/api/interactions` |
| `getLoadedSessions` | `session:getLoaded` | environment／read | 已接入：`/api/state` |
| `getSessionBaseline` | `session:getBaseline` | environment／read | 不支持：Percho 的 baseline 是它自己的消息投影；我们的等价物是 /api/state 与 /api/message-detail |
| `getSessionMessages` | `session:getMessages` | environment／read | 已接入：`/api/state` |
| `markSessionHistoryReady` | `session:historyReady` | environment／mutation | 不支持：我们的会话装载以 HTTP 快照为单位，没有 Percho 的 history-ready ACK 协议 |
| `getTodos` | `session:getTodos` | environment／read | 不支持：todo 以工具结果进入转录，没有独立读取接口 |
| `compact` | `session:compact` | environment／mutation | 已接入：`/api/prompt` |
| `getStats` | `session:stats` | environment／read | 已接入：`/api/state` |
| `getContextUsage` | `session:getContextUsage` | environment／read | 已接入：`/api/state` |
| `clearQueue` | `session:clearQueue` | environment／mutation | 不支持：队列由 Durable 拥有，没有公开清空入口 |
| `getFollowUpMessages` | `session:getFollowUpMessages` | environment／read | 不支持：队列由 Durable 拥有，没有公开读取入口 |
| `listSlashCommands` | `session:listSlashCommands` | environment／read | 已接入：`/api/commands` |
| `listSlashCommandsForCwd` | `session:listSlashCommandsForCwd` | environment／read | 已接入：`/api/commands` |
| `setSessionName` | `session:setName` | environment／mutation | 已接入：`/api/workspace/command` |
| `exportSession` | `session:export` | environment／mutation | 已接入：`/api/session-export` |
| `forkSession` | `session:fork` | environment／mutation | 已接入：`/api/workspace/command` |
| `recallMessage` | `session:recall` | environment／mutation | 已接入：`/api/command` |
| `getLoadedResources` | `session:getLoadedResources` | environment／read | 已接入：`/api/state` |
| `getChannelSubscriptionSessionIds` | `session:getChannelSubscriptionSessionIds` | environment／read | 不支持：我们没有频道订阅模型 |
| `getChannelSubscriptions` | `session:getChannelSubscriptions` | environment／read | 不支持：我们没有频道订阅模型 |
| `listModels` | `models:list` | environment／read | 已接入：`/api/providers` |
| `listProjectFiles` | `project:listFiles` | environment／read | 已接入：`/api/files` |
| `ensureProjectTrust` | `project:ensureTrust` | environment／mutation | 已接入：`/api/project-trust` |
| `searchCatalog` | `packages:searchCatalog` | environment／read | 已接入：`/api/package-catalog` |
| `installPackage` | `packages:install` | environment／mutation | 已接入：`/api/package` |
| `removePackage` | `packages:remove` | environment／mutation | 已接入：`/api/package` |
| `listConfiguredPackages` | `packages:listConfigured` | environment／read | 已接入：`/api/plugins` |
| `mcpConfigList` | `mcp:configList` | environment／read | 已接入：`/api/mcp` |
| `mcpConfigUpsert` | `mcp:configUpsert` | environment／mutation | 已接入：`/api/mcp` |
| `mcpConfigReload` | `mcp:configReload` | environment／mutation | 已接入：`/api/reload` |
| `mcpConfigRemove` | `mcp:configRemove` | environment／mutation | 已接入：`/api/mcp` |
| `lanGetStatus` | `lan:getStatus` | desktop／mutation | 已接入：`/api/lan` |
| `lanSetEnabled` | `lan:setEnabled` | desktop／mutation | 已接入：`/api/lan` |
| `lanSetRemoteControl` | `lan:setRemoteControl` | desktop／mutation | 已接入：`/api/lan` |
| `respondExtensionDialog` | `extension-dialog:respond` | environment／mutation | 已接入：`/api/interaction-reply` |
| `listProviders` | `settings:listProviders` | environment／read | 已接入：`/api/providers` |
| `saveApiKey` | `settings:saveApiKey` | environment／mutation | 已接入：`/api/provider` |
| `removeCredential` | `settings:removeCredential` | environment／mutation | 已接入：`/api/auth-logout` |
| `addCustomProvider` | `settings:addCustomProvider` | environment／mutation | 已接入：`/api/provider` |
| `updateCustomProvider` | `settings:updateCustomProvider` | environment／mutation | 已接入：`/api/provider` |
| `removeCustomProvider` | `settings:removeCustomProvider` | environment／mutation | 已接入：`/api/provider-remove` |
| `setProviderBaseUrl` | `settings:setProviderBaseUrl` | environment／mutation | 已接入：`/api/provider` |
| `testProvider` | `settings:testProvider` | environment／mutation | 不支持：宿主没有模型连通性测试；刷新目录不能代替测试 |
| `getModelPrefs` | `settings:getModelPrefs` | environment／read | 不支持：我们没有独立的模型可见性偏好存储 |
| `setModelHidden` | `settings:setModelHidden` | environment／mutation | 不支持：我们没有独立的模型可见性偏好存储 |
| `setModelsHidden` | `settings:setModelsHidden` | environment／mutation | 不支持：我们没有独立的模型可见性偏好存储 |
| `setProviderModelsHidden` | `settings:setProviderModelsHidden` | environment／mutation | 不支持：我们没有独立的模型可见性偏好存储 |
| `setSubagentModel` | `settings:setSubagentModel` | environment／mutation | 不支持：子代理模型选择随 workspace configure，没有独立通道 |
| `setSubagentThinking` | `settings:setSubagentThinking` | environment／mutation | 不支持：子代理思考等级随 workspace configure |
| `setSubagentPreferBuiltin` | `settings:setSubagentPreferBuiltin` | environment／mutation | 不支持：我们没有内置／原生子代理二选一开关 |
| `listSubagents` | `settings:listSubagents` | environment／read | 不支持：子代理运行记录在原生任务工作台中，不是 Percho 的代理定义清单 |
| `startProviderLogin` | `settings:loginStart` | environment／mutation | 已接入：`/api/auth-start` |
| `cancelProviderLogin` | `settings:loginCancel` | environment／mutation | 已接入：`/api/interaction-reply` |
| `respondProviderLogin` | `settings:loginRespond` | environment／mutation | 已接入：`/api/interaction-reply` |
| `respondPermission` | `permission:respond` | environment／mutation | 不支持：尚未接入：Host 有对应路由（/api/approval），但通道的请求／响应形状还没核实 |
| `getPermissionConfig` | `permission:getConfig` | environment／read | 已接入：`/api/state` |
| `getPermissionMode` | `permission:getMode` | environment／read | 已接入：`/api/state` |
| `setPermissionMode` | `permission:setMode` | environment／mutation | 已接入：`/api/approval` |
| `getContextManagerConfig` | `contextManager:getConfig` | environment／read | 不支持：我们没有 Percho 的上下文蒸发配置 |
| `setContextManagerMode` | `contextManager:setMode` | environment／mutation | 不支持：我们没有 Percho 的上下文蒸发配置 |
| `getChannelWatchConfig` | `channelWatch:getConfig` | environment／read | 不支持：我们没有频道观察配置 |
| `setChannelWatchEnabled` | `channelWatch:setEnabled` | environment／mutation | 不支持：我们没有频道观察配置 |
| `respondTrust` | `trust:respond` | environment／mutation | 不支持：项目信任在当前项目上明确确认，不产生 Percho trust request ID |
| `validateProjectDirectory` | `project:validateDirectory` | environment／read | 已接入：`/api/workspace/validate-directory` |
| `saveFileDialog` | `file:saveDialog` | desktop／mutation | 已接入：`browser.download` |
| `pickDirectory` | `project:pickDirectory` | desktop／mutation | 已接入：`/api/workspace/directory` |
| `getGitBranch` | `project:getGitBranch` | environment／read | 已接入：`/api/git` |
| `listGitBranches` | `project:listGitBranches` | environment／read | 已接入：`/api/git` |
| `checkoutBranch` | `project:checkoutBranch` | environment／mutation | 已接入：`/api/git` |
| `openExternal` | `app:openExternal` | desktop／mutation | 已接入：`window.open` |
| `resolvePath` | `app:resolvePath` | environment／read | 不支持：路径解析由桌面壳提供 |
| `openPath` | `app:openPath` | desktop／mutation | 不支持：在文件管理器中打开是桌面壳能力 |
| `revealPath` | `app:revealPath` | desktop／mutation | 不支持：定位文件是桌面壳能力 |
| `getAppInfo` | `app:getInfo` | desktop／mutation | 已接入：`package.json` |
| `getDailyDir` | `app:getDailyDir` | environment／read | 已接入：`/api/daily-dir` |
| `loadEnvironmentUiState` | `environmentUi:load` | desktop／mutation | 已接入：`/api/environment-ui-state` |
| `saveEnvironmentUiState` | `environmentUi:save` | desktop／mutation | 已接入：`/api/environment-ui-state` |
| `loadUiState` | `uiState:load` | desktop／mutation | 已接入：`/api/ui-state` |
| `saveUiState` | `uiState:save` | desktop／mutation | 已接入：`/api/ui-state` |
| `pickBackgroundImage` | `background:pick` | desktop／mutation | 不支持：自定义背景图是 Percho 的外观特性 |
| `checkForUpdates` | `update:check` | desktop／mutation | 不支持：我们以 pi package 分发，没有内置更新器 |
| `downloadUpdate` | `update:download` | desktop／mutation | 不支持：我们以 pi package 分发，没有内置更新器 |
| `installUpdate` | `update:install` | desktop／mutation | 不支持：我们以 pi package 分发，没有内置更新器 |
| `getUpdateDiagnostics` | `update:diagnostics` | desktop／mutation | 不支持：我们以 pi package 分发，没有内置更新器 |
| `exportUpdateDiagnostics` | `update:exportDiagnostics` | desktop／mutation | 不支持：我们以 pi package 分发，没有内置更新器 |
| `setQuitGuard` | `app:setQuitGuard` | desktop／mutation | 不支持：退出确认是桌面壳行为 |
| `quitDialogShown` | `app:quitDialogShown` | desktop／mutation | 不支持：退出确认是桌面壳行为 |
| `confirmQuit` | `app:confirmQuit` | desktop／mutation | 不支持：退出确认是桌面壳行为 |
| `uiPluginsGetConfig` | `uiPlugins:getConfig` | desktop／mutation | 不支持：Pi 扩展由原生资源工作台管理，不执行 Percho UI 插件 |
| `uiPluginsSetEnabled` | `uiPlugins:setEnabled` | desktop／mutation | 不支持：Pi 扩展由原生资源工作台管理 |
| `uiPluginsList` | `uiPlugins:list` | desktop／mutation | 不支持：Pi 扩展清单不是 Percho UI 插件清单 |
| `uiPluginsReadCode` | `uiPlugins:readCode` | desktop／mutation | 不支持：此宿主不加载 Percho UI 插件代码 |
| `uiPluginsSetPluginEnabled` | `uiPlugins:setPluginEnabled` | desktop／mutation | 不支持：Pi 扩展由原生资源工作台管理 |
| `uiPluginsAssignSlot` | `uiPlugins:assignSlot` | desktop／mutation | 不支持：我们没有 Percho 的 UI 插件运行时 |
| `uiPluginsRebuild` | `uiPlugins:rebuild` | desktop／mutation | 不支持：我们没有 Percho 的 UI 插件运行时 |
| `uiPluginsOpenDir` | `uiPlugins:openDir` | desktop／mutation | 不支持：我们没有 Percho 的 UI 插件运行时 |
| `remoteListSshAliases` | `remote:listSshAliases` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remoteAuthGuide` | `remote:authGuide` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remoteStopService` | `remote:stopService` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remotePreflight` | `remote:preflight` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remoteForget` | `remote:forget` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remoteCheckOperation` | `remote:checkOperation` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remoteDismissOperation` | `remote:dismissOperation` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remoteGetStatus` | `remote:status` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remotePrepareInstall` | `remote:prepareInstall` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remoteInstall` | `remote:install` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remoteConnect` | `remote:connect` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `remoteDisconnect` | `remote:disconnect` | desktop／mutation | 不支持：Percho 用 SSH 远端；我们的远程路线由手机端方案取代 |
| `storageStartupGet` | `storageStartup:get` | desktop／mutation | 不支持：我们没有首启数据迁移步骤 |
| `storageStartupAct` | `storageStartup:act` | desktop／mutation | 不支持：我们没有首启数据迁移步骤 |

## 订阅全表

| 方法 | 实际通道 | 作用域 | 后端或不可用原因 |
| --- | --- | --- | --- |
| `onStorageStartup` | `storageStartup:changed` | desktop | 不支持：我们没有首启数据迁移步骤 |
| `onRemoteConnectionStatus` | `remote:statusChanged` | desktop | 不支持：我们的远程路线由手机端方案取代 |
| `onProviderLoginEvent` | `settings:loginEvent` | environment | 已接入：`/api/interactions` |
| `onMcpServersChanged` | `mcp:serversChanged` | environment | 不支持：本 Host 没有独立的 MCP 服务器变更事件；写入后读取原生清单 |
| `onChannelSubscriptionsChanged` | `channel:subscriptionsChanged` | environment | 不支持：我们没有频道订阅模型 |
| `onUiPluginsEvent` | `uiPlugins:event` | desktop | 不支持：我们没有 Percho 的 UI 插件运行时 |
| `onQuitRequested` | `app:quit-requested` | desktop | 不支持：退出确认是桌面壳行为 |
| `onUpdateEvent` | `update:event` | desktop | 不支持：我们没有内置更新器 |
| `onEvent` | `pi:event` | environment | 已接入：`/api/events` |
| `onPermissionRequest` | `pi:permission-request` | environment | 不支持：本 Host 的审批使用同一个一次性扩展对话框通道 |
| `onPermissionResolved` | `pi:permission-resolved` | environment | 不支持：审批的结算由 onExtensionDialogResolved 通知 |
| `onTrustRequest` | `pi:trust-request` | environment | 不支持：本 Host 的信任交互使用扩展对话框，不产生 Percho TrustRequest |
| `onTrustResolved` | `pi:trustResolved` | environment | 不支持：信任交互的结算由扩展对话框通知 |
| `onExtensionDialogRequest` | `pi:extension-dialog-request` | environment | 已接入：`/api/events` |
| `onExtensionDialogResolved` | `pi:extension-dialog-resolved` | environment | 已接入：`/api/events` |
| `onExtensionNotify` | `pi:extension-notify` | environment | 已接入：`/api/events` |
| `onExtensionEditorText` | `pi:extension-editor-text` | environment | 已接入：`/api/events` |

## 验证入口

- `npm run check`：Node 与完整 React／手机端类型、源码规则。
- `npm run test:ui-next`：实际 Percho 通道／订阅表逐项匹配、Host 处理器、原生 Provider／MCP 与会话契约。
- `node --test test/durable-models.test.mjs`：SDK 运行态端点、认证、环境凭据与原生配置保留。
- `npm run test:ui-next:browser`：从实际添加项目、设置、侧栏和聊天消费者验证。
- `npm test` 与 `npm run package:check`：全量回归及重新构建后的真实解包检查。
