# pi-sdk 适配层契约

## 位置与职责

`src/agent/pi-sdk.mjs` 是 Desktop 与 `@earendil-works/pi-coding-agent` 之间的**唯一适配层**：

- 解析 SDK 入口（PATH 里的 `pi` 可执行文件，或包内嵌副本）；
- 用 memoized loader 按需加载命名空间与三个启动关键子模块；
- 为 Pi 未公开的内部模块保留**窄的兼容 seam**（深路径导入集中在本文件）。

对应 [边界规则 R2](../pi-boundary.md)：资源加载属于 Pi，Desktop 只做适配，不重建。

## 签名

```js
export async function resolvePiSdk(nativePi = process.env.PI_WEB_NATIVE_PI); // -> file URL href
export const sdkEntry;         // await resolvePiSdk()
export const embeddedSdkEntry; // import.meta.resolve("@earendil-works/pi-coding-agent")

export function checkPiSdk(sdk);            // -> sdk（缺导出即抛）
export function loadPiSdk();                // -> Promise<namespace>（PATH 解析入口）
export function loadEmbeddedPiSdk();        // -> Promise<namespace>（内嵌入口，带 checkPiSdk）
export function loadPiSettingsManager(entry = embeddedSdkEntry); // -> Promise<{ SettingsManager, ... }>
export function loadPiSessionManager(entry = embeddedSdkEntry);  // -> Promise<{ SessionManager, buildSessionProjection, ... }>
export function loadPiMessages(entry = embeddedSdkEntry);        // -> Promise<{ convertToLlm, ... }>
export function loadPiToolPipeline(entry = embeddedSdkEntry);    // -> Promise<{ runToolCall, ... }>

export const piSdk;         // 懒命名空间：PATH 入口优先，未加载时任何访问都抛可执行错误
export const embeddedPiSdk; // 懒命名空间：内嵌入口

export async function expandNativePrompt(message, templates, entry = sdkEntry);        // -> string
export async function configurePiNetwork(settings, entry = sdkEntry);                  // -> boolean
export function webTerminalTheme(sdk);                                                 // -> Theme 实例
export async function scopedMcpCredentials(agentDir, entry = sdkEntry, sdk);           // -> store | undefined
```

`checkPiSdk` 必需的具名导出（缺一即抛）：

`SettingsManager`、`SessionManager`、`DefaultPackageManager`、`createAgentSessionServices`、`createAgentSessionFromServices`、`createAgentSessionRuntime`、`ProjectTrustStore`、`hasTrustRequiringProjectResources`、`getAgentDir`、`createCodemodeExtension`、`createToolSearchExtension`、`createMcpExtension`、`loadSkills`、`Theme`、`detectSupportedImageMimeTypeFromFile`、`convertToPng`、`resizeImage`、`formatDimensionNote`。

深路径兼容 seam（**绕过上游 `exports` 映射，集中在此文件**）：

| 路径                         | 用途                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `./core/settings-manager.js` | 启动时的设置与网络配置                                            |
| `./core/session-manager.js`  | 原生 transcript 与 `buildSessionProjection`                       |
| `./core/messages.js`         | `convertToLlm` 投影                                               |
| `./core/prompt-templates.js` | `expandPromptTemplate`（斜杠命令）                                |
| `./core/http-dispatcher.js`  | 代理与超时（`applyHttpProxySettings`／`configureHttpDispatcher`） |
| `./core/auth-storage.js`     | 作用域 MCP 凭据后端                                               |
| `./extensions/mcp/oauth.js`  | MCP OAuth 凭据存储                                                |

工具 pipeline 使用 coding SDK 依赖的 `@earendil-works/pi-agent-core` 公开 `runToolCall`。先从 SDK 位置解析其公开 package.json，再使用公开 import 导出，兼容 ESM-only，不依赖顶层 node_modules 提升；不新增依赖或访问另一版本的 core。它只在实际工具执行时加载，不使用 agentLoop。

## 不变量

- **memoize**：每个 loader 只 import 一次；重复调用返回同一 promise／同一命名空间实例。
- **未加载即占位**：`piSdk`／`embeddedPiSdk` 是 Proxy；加载前**读取**任意键得到可失败的占位函数（读取本身不抱错，`typeof sdk.X === "function"` 就是“尚未加载”的探针），而一旦**调用或构造**（包括嵌套访问后的调用）就抛出可执行提示，而不是在深层报 `is not a function`。
- **懒绑定不 rebind**：读到对象后不再包装，类的静态方法（如 `SessionManager.create`）保持可用。
- **入口优先级固定**：`piSdk` 先看 PATH 解析结果，再退回内嵌；`embeddedPiSdk` 只用内嵌。
- **深路径只在这里出现**：其他模块不得直接 `new URL("./core/...", entry)`。
- **网络只有一条栈**：`configurePiNetwork` 复用 Pi 的 dispatcher，Desktop 不新建 HTTP 栈（源码注释明确要求）。
- **`scopedMcpCredentials` 保护用户资料**：`agentDir` 等于 Pi 默认目录时返回 `undefined`（用 Pi 原生默认），自定义目录才写作用域文件。

## 顺序约束

1. 启动时先 `loadPiSettingsManager()` → `configurePiNetwork(...)`，**必须早于任何模型请求**；失败即 `DeskError(503, "无法初始化 Pi 网络配置，请更新资源 SDK")`。
2. `loadEmbeddedPiSdk()` 可与其它初始化并行发起（源码注释：`Start the SDK graph in parallel with everything below`），只有真正需要命名的步骤才 `await`。
3. 需要完整命名空间的地方（资源宿主）才 `await loadEmbeddedPiSdk()`；只读会话与启动关键路径不得等待它。
4. `webTerminalTheme(sdk)` 可在加载完成后随时调用；未加载且未传入 `sdk` 时抛错。

## 错误模式

| 条件                                                                                                  | 结果                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PI_WEB_NATIVE_PI` 指向无法解析的路径                                                                 | `Error("Cannot resolve SDK from PI_WEB_NATIVE_PI", { cause })`                                           |
| PATH 中找不到 Pi                                                                                      | 回退 `import.meta.resolve(packageName)`                                                                  |
| 内嵌命名空间缺少必需导出                                                                              | `Error("Installed Pi SDK does not provide <name>; update pi-desktop-extension")`                         |
| 未加载就**调用／构造** `piSdk.*`／`embeddedPiSdk.*`（例如 `SettingsManager.create()`、`new Theme()`） | `Error("Pi SDK 尚未加载（<key>）；请先 await loadEmbeddedPiSdk()")`；仅读取属性不抱错                    |
| 子模块文件被上游移动／改名                                                                            | 该 loader 的 import 抛 `ERR_MODULE_NOT_FOUND`；`configurePiNetwork` 捕获它并返回 `false`（调用方转 503） |
| `webTerminalTheme` 在无加载实例且无参数时调用                                                         | `Error("Pi SDK 尚未加载；请先 await loadEmbeddedPiSdk()")`                                               |

## 性能特征

- 整图冷加载在本机实测约 **460 ms**（源码注释记录），因此启动关键路径只付三个子模块的代价；02 性能深化后 worker ready 从 868–896 ms 降到 632–675 ms。
- `resolvePiSdk` 只在模块初始化时执行一次，含最多 PATH 逐目录的 `realpath` + `package.json` 向上查找。
- 懒命名空间的每次属性读取做一次 `get()` 调用与空值判断；`has`／`ownKeys`／`getOwnPropertyDescriptor` 已实现，便于 `Object.keys` 与 `in` 正常工作。
- 深路径导入让上游内部改名成为**静默风险**：契约测试必须覆盖全部 7 条路径（见下）。

## 可执行证据

- `test/pi-sdk.test.mjs`：入口解析、`checkPiSdk` 具名导出校验、PATH 与内嵌两条路径。
- `test/pi-sdk-lazy.test.mjs`：三个子模块各自加载、懒命名空间的失败语义、导入 worker 模块图不会加载命名空间。
- 深路径存在性：`grep -oE '"\./[a-z/.-]+\.js"' src/agent/pi-sdk.mjs` 应与上表一致；由 task-5 的契约测试逐条断言。
- 接口形状断言：`test/boundary-contracts.test.mjs` —— 重命名或删除本页列出的键、命令或深路径时该测试失败。
