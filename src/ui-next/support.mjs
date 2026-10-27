/**
 * 每个 Percho 通道在我们 Host 上的支持状态。
 *
 * 接口：`UI_SUPPORT`（channel → status）；`implemented` 必须给出承载它的 Host 路由或 workspace
 *   命令，`unsupported` 必须给出原因。
 * 不变量：`channels.mjs` 的每个通道在这里恰好有一条记录；不允许留空、也不允许静默回落。
 * 为什么：GUI 移植的真实风险不是“少几个界面”，而是渲染进程以为某个操作成功。把不可用的通道
 *   显式标成 unsupported，适配层就能立刻抛出可诊断的错误，页面也能据此隐藏表面。
 * 错误：调用未实现的通道抛 `HostApiUnsupported`（见 host-api.mjs）。
 *
 * 复核方式：`implemented` 的 `route` 必须出现在 `src/server/bridge.mjs` 的路由表或
 *   `src/agent/agent-workspace.mjs` 的 workspace 命令里，`test/ui-next-contract.test.mjs` 会核对。
 */
const implemented = (route) => ({ status: "implemented", route });
const unsupported = (reason) => ({ status: "unsupported", reason });

export const UI_SUPPORT = Object.freeze({
  // ── 会话 ────────────────────────────────────────────────────────────────
  "session:create": implemented("/api/workspace/command"),
  "session:open": unsupported(
    "尚未接入：Host 有对应路由（/api/switch-session），但通道的请求／响应形状还没核实",
  ),
  "session:close": unsupported(
    "会话在 worker 内常驻；我们没有 Percho 的显式 close 语义",
  ),
  "session:delete": unsupported("没有删除归档的通道；归档走 workspace 命令"),
  "session:list": implemented("/api/sessions"),
  "session:listAll": implemented("/api/sessions"),
  "session:prompt": implemented("/api/prompt"),
  "session:abort": implemented("/api/abort"),
  "session:setModel": implemented("/api/model"),
  "session:setThinkingLevel": implemented("/api/thinking"),
  "session:compact": implemented("/api/workspace/command"),
  "session:fork": implemented("/api/workspace/command"),
  "session:stats": implemented("/api/state"),
  "session:getContextUsage": implemented("/api/state"),
  "session:getMessages": implemented("/api/state"),
  "session:getLoaded": implemented("/api/state"),
  "session:getPendingInteractions": implemented("/api/interactions"),
  "session:listSlashCommands": implemented("/api/commands"),
  "session:listSlashCommandsForCwd": implemented("/api/commands"),
  "session:getLoadedResources": unsupported(
    "尚未接入：Host 有对应路由（/api/plugin-resources），但通道的请求／响应形状还没实测核实",
  ),
  "session:historyReady": unsupported(
    "我们的会话装载以 HTTP 快照为单位，没有 Percho 的 history-ready ACK 协议",
  ),
  "session:getBaseline": unsupported(
    "Percho 的 baseline 是它自己的消息投影；我们的等价物是 /api/state 与 /api/message-detail",
  ),
  "session:getQuota": unsupported("我们没有 provider 套餐额度服务"),
  "session:retryLastFailedTurn": unsupported(
    "我们走 Durable 的 generation 重试；Pi SDK 未提供该公开入口",
  ),
  "session:getTodos": unsupported("todo 以工具结果进入转录，没有独立读取接口"),
  "session:clearQueue": unsupported("队列由 Durable 拥有，没有公开清空入口"),
  "session:getFollowUpMessages": unsupported("队列由 Durable 拥有，没有公开读取入口"),
  "session:setName": unsupported("会话改名走 /api/workspace/command，通道名未对齐"),
  "session:export": unsupported("会话导出走 workspace 命令，通道名未对齐"),
  "session:recall": unsupported("撤回走 workspace rewind 命令，语义与 Percho recall 不同"),
  "session:getChannelSubscriptionSessionIds": unsupported("我们没有频道订阅模型"),
  "session:getChannelSubscriptions": unsupported("我们没有频道订阅模型"),
  "domain:action": unsupported("Percho 的通用域动作分发；我们没有等价入口"),

  // ── 模型 ────────────────────────────────────────────────────────────────
  "models:list": implemented("/api/providers"),

  // ── 项目与 Git ──────────────────────────────────────────────────────────
  "project:listFiles": implemented("/api/files"),
  "project:ensureTrust": unsupported(
    "尚未接入：Host 有 /api/project-trust，但信任请求体的形状还没核实",
  ),
  "project:getGitBranch": implemented("/api/git"),
  "project:listGitBranches": implemented("/api/git"),
  "project:checkoutBranch": unsupported(
    "尚未接入：Host 有对应路由（/api/git），但通道的请求／响应形状还没核实",
  ),
  "project:validateDirectory": unsupported(
    "尚未接入：Host 有对应路由（/api/workspace/command），但通道的请求／响应形状还没核实",
  ),

  // ── 包与 MCP ────────────────────────────────────────────────────────────
  "packages:searchCatalog": unsupported(
    "尚未接入：Host 有对应路由（/api/marketplace），但通道的请求／响应形状还没核实",
  ),
  "packages:listConfigured": unsupported(
    "尚未接入：Host 有对应路由（/api/package），但通道的请求／响应形状还没实测核实",
  ),
  "packages:install": unsupported(
    "尚未接入：Host 有对应路由（/api/package），但通道的请求／响应形状还没核实",
  ),
  "packages:remove": unsupported(
    "尚未接入：Host 有对应路由（/api/package），但通道的请求／响应形状还没核实",
  ),
  "mcp:configList": implemented("/api/mcp"),
  "mcp:configUpsert": unsupported(
    "尚未接入：Host 有对应路由（/api/mcp-action），但通道的请求／响应形状还没核实",
  ),
  "mcp:configRemove": unsupported(
    "尚未接入：Host 有对应路由（/api/mcp-action），但通道的请求／响应形状还没核实",
  ),
  "mcp:configReload": unsupported(
    "尚未接入：Host 有对应路由（/api/mcp-action），但通道的请求／响应形状还没核实",
  ),

  // ── 交互与权限 ──────────────────────────────────────────────────────────
  "extension-dialog:respond": unsupported(
    "尚未接入：Host 有对应路由（/api/interaction-reply），但通道的请求／响应形状还没核实",
  ),
  "trust:respond": unsupported(
    "尚未接入：Host 有对应路由（/api/interaction-reply），但通道的请求／响应形状还没核实",
  ),
  "permission:respond": unsupported(
    "尚未接入：Host 有对应路由（/api/approval），但通道的请求／响应形状还没核实",
  ),
  "permission:getConfig": unsupported(
    "尚未接入：Host 有对应路由（/api/approval），但通道的请求／响应形状还没核实",
  ),
  "permission:getMode": unsupported(
    "尚未接入：Host 有对应路由（/api/state），但通道的请求／响应形状还没核实",
  ),
  "permission:setMode": unsupported(
    "尚未接入：Host 有对应路由（/api/approval），但通道的请求／响应形状还没核实",
  ),

  // ── 设置 ────────────────────────────────────────────────────────────────
  "settings:listProviders": implemented("/api/providers"),
  "settings:saveApiKey": unsupported(
    "尚未接入：Host 有对应路由（/api/provider），但通道的请求／响应形状还没核实",
  ),
  "settings:removeCredential": unsupported(
    "尚未接入：Host 有对应路由（/api/provider-remove），但通道的请求／响应形状还没核实",
  ),
  "settings:addCustomProvider": unsupported(
    "尚未接入：Host 有对应路由（/api/provider），但通道的请求／响应形状还没核实",
  ),
  "settings:updateCustomProvider": unsupported(
    "尚未接入：Host 有对应路由（/api/provider），但通道的请求／响应形状还没核实",
  ),
  "settings:removeCustomProvider": unsupported(
    "尚未接入：Host 有对应路由（/api/provider-remove），但通道的请求／响应形状还没核实",
  ),
  "settings:loginStart": unsupported(
    "尚未接入：Host 有对应路由（/api/auth-start），但通道的请求／响应形状还没核实",
  ),
  "settings:loginCancel": unsupported(
    "尚未接入：Host 有对应路由（/api/auth-logout），但通道的请求／响应形状还没核实",
  ),
  "settings:getModelPrefs": unsupported("我们没有独立的模型可见性偏好存储"),
  "settings:setModelHidden": unsupported("我们没有独立的模型可见性偏好存储"),
  "settings:setModelsHidden": unsupported("我们没有独立的模型可见性偏好存储"),
  "settings:setProviderModelsHidden": unsupported("我们没有独立的模型可见性偏好存储"),
  "settings:setProviderBaseUrl": unsupported("base URL 走 /api/provider 的完整保存，通道未对齐"),
  "settings:testProvider": unsupported("没有独立的 provider 连通性测试入口"),
  "settings:setSubagentModel": unsupported("子代理模型选择随 workspace configure，没有独立通道"),
  "settings:setSubagentThinking": unsupported("子代理思考等级随 workspace configure"),
  "settings:setSubagentPreferBuiltin": unsupported("我们没有内置／原生子代理二选一开关"),
  "settings:listSubagents": unsupported(
    "尚未接入：Host 有对应路由（/api/subagent-history），但通道的请求／响应形状还没核实",
  ),
  "settings:loginRespond": unsupported("交互式登录的应答走 /api/interaction-reply"),

  // ── 上下文管理／频道观察 ────────────────────────────────────────────────
  "contextManager:getConfig": unsupported("我们没有 Percho 的上下文蒸发配置"),
  "contextManager:setMode": unsupported("我们没有 Percho 的上下文蒸发配置"),
  "channelWatch:getConfig": unsupported("我们没有频道观察配置"),
  "channelWatch:setEnabled": unsupported("我们没有频道观察配置"),

  // ── 桌面外壳（Electron / preload 拥有） ─────────────────────────────────
  "project:pickDirectory": unsupported("目录选择是 Electron 原生能力，不在 Host HTTP 上"),
  "file:saveDialog": unsupported("保存对话框是 Electron 原生能力"),
  "app:openExternal": unsupported("外部链接由桌面壳处理"),
  "app:openPath": unsupported("在文件管理器中打开是桌面壳能力"),
  "app:revealPath": unsupported("定位文件是桌面壳能力"),
  "app:getInfo": unsupported("应用信息由桌面壳提供"),
  "app:getDailyDir": implemented("/api/daily-dir"),
  "app:resolvePath": unsupported("路径解析由桌面壳提供"),
  "app:setQuitGuard": unsupported("退出确认是桌面壳行为"),
  "app:quitDialogShown": unsupported("退出确认是桌面壳行为"),
  "app:confirmQuit": unsupported("退出确认是桌面壳行为"),
  "environmentUi:load": implemented("/api/environment-ui-state"),
  "environmentUi:save": implemented("/api/environment-ui-state"),
  "uiState:load": implemented("/api/ui-state"),
  "uiState:save": implemented("/api/ui-state"),
  "background:pick": unsupported("自定义背景图是 Percho 的外观特性"),
  "storageStartup:get": unsupported("我们没有首启数据迁移步骤"),
  "storageStartup:act": unsupported("我们没有首启数据迁移步骤"),

  // ── 更新 ────────────────────────────────────────────────────────────────
  "update:check": unsupported("我们以 pi package 分发，没有内置更新器"),
  "update:download": unsupported("我们以 pi package 分发，没有内置更新器"),
  "update:install": unsupported("我们以 pi package 分发，没有内置更新器"),
  "update:diagnostics": unsupported("我们以 pi package 分发，没有内置更新器"),
  "update:exportDiagnostics": unsupported("我们以 pi package 分发，没有内置更新器"),

  // ── UI 插件 ─────────────────────────────────────────────────────────────
  "uiPlugins:getConfig": unsupported("我们没有 Percho 的 UI 插件运行时"),
  "uiPlugins:setEnabled": unsupported("我们没有 Percho 的 UI 插件运行时"),
  "uiPlugins:list": unsupported("我们没有 Percho 的 UI 插件运行时"),
  "uiPlugins:readCode": unsupported("我们没有 Percho 的 UI 插件运行时"),
  "uiPlugins:setPluginEnabled": unsupported("我们没有 Percho 的 UI 插件运行时"),
  "uiPlugins:assignSlot": unsupported("我们没有 Percho 的 UI 插件运行时"),
  "uiPlugins:rebuild": unsupported("我们没有 Percho 的 UI 插件运行时"),
  "uiPlugins:openDir": unsupported("我们没有 Percho 的 UI 插件运行时"),

  // ── 远端 ────────────────────────────────────────────────────────────────
  "remote:listSshAliases": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:authGuide": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:stopService": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:preflight": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:forget": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:checkOperation": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:dismissOperation": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:status": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:prepareInstall": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:install": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:connect": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),
  "remote:disconnect": unsupported("Percho 用 SSH 远端；我们的远程路线由手机端方案取代"),

  // ── 局域网 ──────────────────────────────────────────────────────────────
  "lan:getStatus": implemented("/api/lan"),
  "lan:setEnabled": implemented("/api/lan"),
  "lan:setRemoteControl": implemented("/api/lan"),
});

/** 订阅通道的支持状态；事件侧同样不允许静默不回。 */
export const UI_SUBSCRIPTION_SUPPORT = Object.freeze({
  onEvent: implemented("/api/events"),
  onPermissionRequest: implemented("/api/events"),
  onPermissionResolved: implemented("/api/events"),
  onTrustRequest: implemented("/api/events"),
  onTrustResolved: implemented("/api/events"),
  onExtensionDialogRequest: implemented("/api/events"),
  onExtensionDialogResolved: implemented("/api/events"),
  onExtensionNotify: implemented("/api/events"),
  onExtensionEditorText: implemented("/api/events"),
  onMcpServersChanged: implemented("/api/events"),
  onStorageStartup: unsupported("我们没有首启数据迁移步骤"),
  onRemoteConnectionStatus: unsupported("我们的远程路线由手机端方案取代"),
  onProviderLoginEvent: unsupported("登录事件走 /api/events 的其它类型"),
  onChannelSubscriptionsChanged: unsupported("我们没有频道订阅模型"),
  onUiPluginsEvent: unsupported("我们没有 Percho 的 UI 插件运行时"),
  onQuitRequested: unsupported("退出确认是桌面壳行为"),
  onUpdateEvent: unsupported("我们没有内置更新器"),
});
