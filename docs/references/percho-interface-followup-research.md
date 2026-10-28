# Percho 前端 ↔ 本仓库 Host/SDK 接口追查（续，基线 606a234）

后续八项已确认问题的修复与验证见[接口差异修复](../history/percho-interface-followup-repair.md)。以下保留调查时的原始结论与限制。

范围：以 `src/ui-next/http-handlers.mjs`、`native-contracts.mjs`、`session-transport.mjs` 为起点，
后台初审重点覆盖**会话 rename/close/archive/fork/recall、Git、包管理、MCP** 通道，对比 Percho 真实
renderer store/组件、共享类型、本仓库真实后端（`src/server/*`、`src/resources/*`、`src/agent/*`）
与已安装 SDK 声明。主代理随后独立核对 Provider／认证／模型配置并补充于末节。
未重复列出 606a234 已修的 `validateProjectDirectory`／订阅名／ProviderId。

方法：只读代码比对 + 定向秒级探针（`test/desktop-fixture.mjs` 起真实 Desktop Host，模型为
fixture 内的本地假 provider；未请求真实模型/账户，未安装任何包）。

```bash
cd /home/cmz488/.pi/design/pi-desktop
node /tmp/percho-interface-research-probe.mjs   # fork/rename/recall/close/MCP/包清单
node /tmp/percho-interface-research-probe2.mjs  # Git 双步确认、无会话 cwd、fork entryId、族内分支
node /tmp/percho-interface-research-probe3.mjs  # 流式 close、未受信项目、分支 recall/fork
node /tmp/percho-interface-research-probe4.mjs  # close 的 closed 时间线、分支改名
node /tmp/percho-interface-research-probe5.mjs  # 流式期间 close 抽样
node /tmp/percho-interface-research-probe6.mjs  # 分支流式 close、MCP remove/reload/paths
node /tmp/percho-interface-research-probe7.mjs  # MCP exposure=model-only、仅切 enabled
```

## 一、已确认的接口差异（按影响排序）

### Q1（高）MCP 编辑器提供的 `model-only` 暴露方式，本 Host/SDK 一律拒绝

- 前端期望：暴露方式下拉有五项，保存时把所选值原样交给 Host。
  `src/ui-next/percho/renderer/src/components/settings/mcp/ServerEditorPage.tsx:9`
  （`["deferred","codemode","direct","model-only","hidden"]`，渲染于 `:272`）；
  共享类型 `src/ui-next/percho/shared/mcp.ts:12` 也把 `model-only` 列为合法值。
- 后端实际：`src/resources/mcp-config.mjs:5` 只接受 `codemode|deferred|direct|hidden`
  （另兼容 `codemode-deferred`），`validateMcp` 在 `:27-35` 对 `exposure`/`toolExposure`
  逐值校验。已安装 SDK 的权威类型同样不含 `model-only`：
  `node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.d.ts:24`
  （`export type McpExposure = "codemode" | "deferred" | "direct" | "hidden"`）。
  `mcp:configUpsert` 把 `exposure` 原样转入 `config`
  （`src/ui-next/http-handlers.mjs:341-347`）。
- 影响：用户在 MCP 面板选「model-only」保存 → 422「工具暴露方式无效」，整个新增/编辑不落盘；
  前端无法从列表上看出哪个选项可用。
- 复现与观察（probe7）：`mcp:configUpsert({scope:"user",name:"model-only-server",command:"node",exposure:"model-only"})`
  → `{ok:false, error:"Error: 工具暴露方式无效", status:422}`；同调用改用 `deferred` → 成功。
- 置信度：高（前端枚举 + SDK 声明 + 后端校验 + 实测 422）。限制：只验证了 server 级
  `exposure`；`toolExposure` 走同一校验函数，未单独实测（前端表单当前不发送 `toolExposure`）。

### Q2（中）`cwd` 作用域的读通道要求「该 cwd 下已有活跃/期望会话」，Percho 原生按 cwd 直接读

- 前端期望：`mcpConfigList({cwd})`、`listGitBranches({cwd})`、`listProjectFiles({cwd})` 只依赖 cwd。
  证据：`.../components/settings/mcp/McpPanel.tsx:70-77`（cwd 取 `selectActiveCwd` = 会话 cwd
  **或 draft cwd**，`:76` 调 `mcpConfigList({cwd})`）、`.../lib/active-cwd.ts`
  （`activeSessionId===null` 时返回 `newSessionDraft.cwd`）、
  `.../components/session/ProjectBranchPicker.tsx:169`（挂载在 `chat/EmptyState.tsx:19`，
  即新会话空态页）。
- 后端实际：处理器用 `sessions.forCwd(args.cwd)`（默认 `required:true`）先解析出会话，
  再以该会话身份发请求：`http-handlers.mjs:288-290`（MCP）、`:269-272`（文件）、`:273-286`
  （Git 读）、`:469-470`（切分支）。`forCwd` 只在 `row.active || agent.desired` 且
  `row.cwd===cwd` 的行里找，找不到就抛「请先在此项目创建或打开会话」
  （`session-transport.mjs:306-319`）。
- 影响：新建/刚加入、尚无会话的项目里：MCP 设置面板弹 `toast.mcpLoadFailed` 且列表为空；
  空态页 Git 分支选择器显示该中文错误而不是分支；`@` 文件补全同样失败。这些消费者在 draft 阶段已经挂载，参数合同没有要求先创建会话。
- 复现与观察（probe2）：对 `fresh-project`（仅含 `.pi/` 目录、无会话）
  `mcp:configList`／`project:listFiles`／`project:listGitBranches` 均返回
  `Error: 请先在此项目创建或打开会话`。
- 置信度：高（三通道实测一致 + 前端挂载点确认走 draft cwd）。限制：未在真实浏览器里看
  面板呈现，仅确认通道抛错；`packages:*` 不用 cwd，不受影响。

### Q4（低）MCP 面板显示的配置文件「路径」是中文占位符

- 前端期望：`globalPath` / `projectPath` 是真实绝对路径，直接以 mono 字体展示
  （`McpPanel.tsx:251`、`:295-310`；类型 `shared/mcp.ts:79-82`）。
- 后端实际：`mcpView` 返回字面量 `globalPath: "用户 mcp.json"`、
  `projectPath: "项目 .pi/mcp.json"`（`native-contracts.mjs:106-107`）；真实路径其实在
  后端可得（`bridge.mjs:153-155` 的 `mcpPath(scope)`），但没进清单。
- 影响：设置 → MCP 的「配置文件」展开区显示的不是路径，用户无法据此定位/打开文件。
- 复现与观察（probe6）：`mcp:configList` 返回 `globalPath:"用户 mcp.json"`,
  `projectPath:"项目 .pi/mcp.json"`。
- 置信度：高（代码 + 实测字符串）。限制：纯展示缺陷，无功能阻塞。

### Q5（低）MCP 工具清单缺 `readOnly`，界面把所有工具标成「会改动」

- 前端期望：`McpToolView{name, readOnly?}`，`readOnly===true` 显示「只读」，
  否则显示「会改动」，并统计只读数量（`shared/mcp.ts:34-39`；
  `components/settings/mcp/ServerRow.tsx:172`、`:188`）。
- 后端实际：`mcpTools()` 映射为 `{name, description}`
  （`src/server/web.mjs:886-889`）；`mcpView` 直接透传 `tools: row.tools ?? []`（`native-contracts.mjs:93`）。
  这已确认 SDK Web 路径丢失该字段；Durable worker 的 `native().execute("mcpTools")` 路径未验证，不能断言使用同一工具映射。
- 影响：面板对每个 MCP 工具都显示「会改动」，只读计数永远 0 —— 与官方
  `ToolInfo.annotations.readOnlyHint` 的事实不符，用户会误判风险。
- 置信度：SDK Web 返回字段丢失的代码证据明确；本次未起真实只读 MCP server，因此不宣称其运行态标记或 Durable 路径已端到端复现。

### Q6（低）`mcpView.projectTrusted` 由「行」推导，未受信项目可能被报成已受信

- 前端期望：`projectTrusted` 反映项目本身是否受信，用来隐藏「项目级 MCP 未读」警告
  （`McpPanel.tsx:262`）。
- 后端实际：`projectTrusted: !(rows).some(row => row.scope === "project" && !row.trusted)`
  （`native-contracts.mjs:103-105`）。而 `bridge.mjs:174-217` 只在项目里**确有** server 时
  才产生 `scope:"project"` 行并标注 `trusted`；真实信任状态另有来源
  `host.capabilities.projectTrusted`（`bridge.mjs:323`）。
- 影响：项目未受信但 `.pi/mcp.json` 里没有（或只有空的 `mcpServers`）时，面板显示
  「项目级已读取」，隐藏了 Percho 会显示的未受信提示；用户在项目级新增 server 前不会被提醒。
- 主代理追加实际反例：在临时新项目写入 `.pi/extensions/noop.mjs`（未授予信任），创建 worker 后读取真实 `/api/state` 与 `mcp:configList`，得到 `actualProjectTrusted=false`、`projectServerCount=0`、`uiProjectTrusted=true`。
  复现：`node /tmp/percho-interface-research-trust.mjs`，结果见 `/tmp/percho-interface-research-trust.log`。无项目扩展时原探针得到 trusted=true，不是反例，已排除。
- 置信度：高（实际信任状态与实际视图返回值相反）。这是信任提示误报，不证明后端的信任门禁被绕过。

## 二、核对后**没有**发现新增问题的项（避免重复劳动）

- `session:fork`：workspace 下经 `conversation.fork` 生成新独立会话，返回的 `SessionMeta`
  含新 `sessionId`/`sessionFile`/`name`/`model`，并出现在 `session:listAll` 中；按
  `entryId` 与按文本（`ref.text`）两条路径都成功（probe1）。fork 会话的 `entryId` 是**新
  空间**（父 12/16 → 子 11/13），前端 `forkSession` 之后会 `loadSessionBundle(newId)` 重读，
  不会拿父入口 id 去操作子会话（`stores/sessions.ts:815-843`），因此 probe1 里「用父
  entryId 撤回 fork 会话」报「消息位置不明确」属误用，不是缺陷。
- `session:recall`：真实 rewind 生效（撤回用户消息后 `getMessages` 归零，`text`/`images`
  回填正确）；族内分支上同样可用（probe3）。缺 `document` 是前端显式容忍的降级
  （`stores/sessions.ts:850-865` 用 `recalled.document ?? composerDocumentFromText(...)`），
  且本 Host 从未持久化 `ComposerDocument`（`agent/input-presentation.mjs` 只存
  `{source, original}`），不构成契约违背。
- `session:setName`（根 Agent）：走 `agent.rename`，目录名随后同步（probe1）；
  族内分支改名（`owner/branchId`）经 `configure` 落库，目录最终也同步
  （probe2 立刻读仍为旧名，probe4 用 `until` 等到新名）—— 属异步刷新窗口，非缺陷。
- `session:close`：真实流式期间连续 8 次采样均为 `{closed:false}`（probe5），
  族内分支流式期间同样 `closed:false`（probe6）；idle 后返回 `closed:true`。
  仅在一次极窄的收尾窗口里观察到 `state.idle===false` 紧接着 `close→{closed:true}`
  （probe4 第一条），推断是 durable store 的 `idle` 标志滞后，**未定性为缺陷**。
- `session:delete`（归档）：`archivable:false`（`source==="pi"` 与族内分支）时处理器抛
  `HostApiUnsupported`，而左栏菜单对 `archivable===false` 已隐藏删除
  （`components/sidebar/SessionMenu.tsx:62-70`、`stores/projects.ts:222-241`），两侧一致；
  独立 Agent 的归档流程（stop → archive）实测可用。
- Git：`project:listGitBranches` 返回 `{current, branches}`；`checkoutBranch` 的
  「preview → confirm(token)」双步在真实临时仓库上成功切到 `feature-x`，`window.confirm`
  已在浏览器桥接好（`pi-http-bridge.ts:110-115`），不会静默 no-op（probe2）。
- 包管理：`packages:listConfigured` 把后端 `scope:"global"` 映射成前端 `"user"`
  （`http-handlers.mjs:293-299`，probe1 实测 `[{source:"npm:fixture-pkg",scope:"user"}]`）；
  `packages:install/remove` 的 `user→global` 映射与后端 `settings.json` 写入一致
  （`resources/package-management.mjs:260-262`），`onWrite` 会置 `pending`
  （`bridge.mjs:309-311`）且 Percho「已安装」页有原生重载入口
  （`components/native/NativeResources.tsx:72`），故「安装后不自动 reload」是设计差异而非缺陷。
- 目录搜索：`/api/package-catalog` 返回 `{source:"pi.dev",html,...}`，`parseCatalog` 用的正是
  同一份 `parseCatalogPage`，`total` 正则与 `parseCatalogPage` 的 `count` 校验同格式
  （`http-handlers.mjs:318-335` vs `src/ui/shared/package-settings.js:34-113`）——形状一致；
  未联网实测（避免外网请求）。

## 三、未验证的猜测（明确不作为结论）

- Q3 原先怀疑 `mcp:configReload` 的 `{reloaded:1}` 是伪造。复核后不能这样定性：`POST /api/reload` 确实等待当前目标 worker 的 `resources.reload()` 成功（`src/server/bridge.mjs:1150`），`McpReloadReport` 统计的是会话 reload 数，不是 MCP server 连接数（`shared/mcp.ts:110-118`）。无 MCP server 时返回 1 不足以证明错误。跨 worker 的覆盖与跳过统计仍需多会话／真实 MCP server 实测，本轮不报告为已确认缺陷。

1. `project:getGitBranch` 在 detached HEAD 返回 `"detached <sha>"`（probe2 实测），
   而前端类型是 `string|null`。可能让顶栏显示「⎇ detached 031b9dff」、分支列表无高亮项；
   未确认 Percho 原生的取值，故只记为待定。
2. `mcpView` 把后端 `scope:"extension"` 行并入 `global` 并标成 `source:"user"`
   （`native-contracts.mjs:99-102`），这类行不可经 `mcp.json` 编辑；正常配置下该分支似不可达，
   未构造出场景。
3. `mcp:configUpsert` 只透传 6 个键（`command/args/url/description/enabled/exposure`），
   粘贴 JSON 里的 `env`/`headers`/`timeout`/`cwd` 会被丢弃 —— 但 Percho 的
   `parsePastedServers` 本身也只保留 `command/url/args/description`
   （`components/settings/mcp/pure.ts:69-106`），所以目前不产生额外数据丢失；若前端未来扩展
   该类型则会。

## 四、限制

- 全程只读：未改生产代码/测试/配置，未做 git 操作，未启动其他代理；探针均用 fixture 的
  本地假 provider 与 `/tmp` 目录。probe1 曾因把 `npm:fixture-pkg` 写进临时 `settings.json`
  触发一次失败的本机 `npm install`（离线失败，未产生任何安装），后续探针已移除该步骤。
- 未跑完整测试套件，只做定向探针；未在真实浏览器渲染中验证 Q2/Q4/Q5 的视觉呈现。
- Q5 的只读工具运行态需真实 MCP server 才能端到端确认；Q3 已降为待验证，未断言重连回执造假。
## 主代理补充：Provider 与认证消费链

以下四项均由当前源码和隔离探针确认；未修改生产代码。版本基线为 `606a234`，Pi SDK／Durable 为仓库锁定的 1.4.0。没有向真实 Provider 发出模型请求。

### P1：Provider 保存的 revision 读取与写入会随聊天选择改变目标

前端切换活跃会话会执行 `desktopSessions.select(id)`；`createSessionTransport.target()` 对未显式传 session ID 的调用读取可变 `lastSession`。HTTP 适配器的默认 `get`、`post` 均不绑定身份；添加／编辑 Provider 先 `await providerRevision(get)`，再通过默认 `post` 写配置。因此等待读取回复时切换聊天，可使读取属于 A、写入属于 B。如果两份原生文档 revision 相同，写入直接成功，不会由 revision 校验拦下。

证据：[聊天选择](../../src/ui-next/percho/renderer/src/components/native/NativeSessionStatus.tsx#L16)、[目标解析与 select](../../src/ui-next/session-transport.mjs#L126)、[未绑定默认 IO](../../src/ui-next/http-handlers.mjs#L62)、[添加／编辑 Provider](../../src/ui-next/http-handlers.mjs#L499)。

实际双 worker 探针：在 A 的 `/api/providers` 回复返回给适配器之前挂起客户端，调用真实 `sessions.select(B)` 后释放。新增 `research-race` 的结果为 `aHasProvider=false`、`bHasProvider=true`；写入地址为 `/agents/<B>/api/provider`。两个 worker 均为临时目录／本地假模型，模型请求数为 0。直接修复方向是操作开始时固定目标，把同一身份传给后续读取、写入与认证，不用“当前选择”重新解析。

复现命令：`node /tmp/percho-interface-research-probes.mjs`；结果：`/tmp/percho-interface-research-probes.log`。探针为本次临时证据，不随 npm 包发布。

### P1：前端可选协议、配置校验和 SDK Provider 装载使用不同的兼容集合

实际自定义 Provider 表单枚举 10 种 `KNOWN_APIS`，但 `patchProvider` 的常规校验仅接受 4 种。新增不同 ID 的 `google-vertex`、`azure-openai-responses`、`mistral-conversations`、`bedrock-converse-stream`、`openai-codex-responses`、`pi-messages` 六项均返回 422“不支持的 API 类型”。用户可以在界面选择它们，提交却必定失败。

更严重的差异在内置 ID 的自定义模型：`save()` 通过 `additionalApi` 放行该内置 Provider 的原生 API，而 `reload()` 仍只为四种 `implementations` 装载自定义模型。对 `google-vertex`、`mistral`、`amazon-bedrock`、`openai-codex` 保存自定义模型 `research-custom-model`，均得到保存成功；`inventory()` 也列出该模型，但 `models.getModel(id, 'research-custom-model')` 为 `undefined`。Mistral／Codex 的运行态还保留原内置端点。这是“已保存”与实际执行目录不一致，不是拒绝未支持协议。

证据：[前端协议列表](../../src/ui-next/percho/shared/settings.ts#L4)、[真实表单枚举](../../src/ui-next/percho/renderer/src/components/settings/providers/CustomProviderForm.tsx#L76)、[配置校验](../../src/config/config-store.mjs#L83)、[装载映射及过滤](../../src/agent/durable-models.mjs#L20)、[内置 API 校验例外](../../src/agent/durable-models.mjs#L255)。应让可选项、校验与实际 SDK 装载能力保持一致，并在保存成功前保证相应模型可被运行态解析。

复现命令：`node /tmp/percho-interface-research-probes.mjs`、`node /tmp/percho-interface-research-native-apis.mjs`；结果分别在对应 `.log` 文件。探针只写入临时配置并检查 SDK 原生注册表，不请求真实服务。

### P2：登录任务建立之前的取消丢失，并形成未处理拒绝

登录界面在 invoke 开始前就建立 `login` 状态并提供取消操作。但 `createProviderLogins.start()` 需要先等待目标、目录和 `/api/auth-start`，完成后才登记 `jobs.set(loginId, job)`。此期间 `cancel()` 将未知 loginId 当作“登录已结束”抛错；前端以 `void ...cancelProviderLogin(...)` 调用，没有 catch，也未保存待取消意图。

隔离时序探针阻塞 `sessions.target()`，先 `start()` 再 `cancel()`：取消报“登录已结束”，随后释放目标后仍创建了 1 个 Native 登录任务，取消请求数为 0。后续把假任务标为终态仅用于结束探针，不能视为 UI 取消成功。原生合同还约定未知 loginId 的取消应静默忽略；单纯静默也不能解决启动后任务继续的问题，需要把取消意图覆盖启动阶段。

证据：[前端登录状态与取消](../../src/ui-next/percho/renderer/src/stores/provider-login.ts#L157)、[任务登记时机](../../src/ui-next/native-contracts.mjs#L137)、[取消实现](../../src/ui-next/native-contracts.mjs#L227)、[原生通道合同](../../src/ui-next/percho/shared/ipc-channels.ts#L625)。复现命令与结果同第一项的临时探针。

### P3：自定义 Provider 的显示名称成功提交后丢失

表单有独立名称输入，并通过 `toInput()` 发送 `name`；但 `patchProvider()` 没有保存 `input.name`，装载时 `createProvider()` 又固定 `name: id`。保存 `name='Research Friendly Name'` 后，通过实际 `settings:listProviders` 读回的名称为 `research-name`（ID）。后续重新打开编辑表单时名称输入也为空，因为它将 `provider.name === provider.id` 解释为未设置名称。

证据：[表单发送名称](../../src/ui-next/percho/renderer/src/components/settings/providers/CustomProviderForm.tsx#L31)、[名称输入与回填](../../src/ui-next/percho/renderer/src/components/settings/providers/CustomProviderForm.tsx#L103)、[配置构造](../../src/config/config-store.mjs#L98)、[运行态名称](../../src/agent/durable-models.mjs#L213)。实际 Host 探针命令与结果同第一项；只是显示／编辑数据丢失，不影响协议鉴权，优先级低于前述问题。
