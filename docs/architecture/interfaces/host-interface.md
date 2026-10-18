# Host interface 契约

## 位置与职责

- `src/server/host-interface.mjs`：把每个宿主的实现收敛成同一形状，显式声明 capability，并提供请求目标 token。
- `src/server/target-guard.mjs`：一次请求的写目标身份，防止 `await` 之后会话已切换却继续写入。

调用者是 HTTP bridge（`src/server/bridge.mjs`）与各宿主 adapter（durable、web、pi-history、TUI）。归属见 [边界文档](../pi-boundary.md) 的 seam A 之外：Host interface 是**宿主与传输之间的 seam**，不是 Durable 的内部。

## 签名

```js
export const HOST_CAPABILITY_KEYS; // readonly string[]，40 个键（见下）
export function normalizeHostCapabilities(value = {}); // -> frozen Record<key, boolean>
export function createHostInterface(input = {}); // -> frozen host
export function createRequestTarget(snapshot, input = {}, validateTarget); // -> target
```

`createHostInterface(input)` 的输入：

| 键                                                                                                                                                | 必填   | 说明                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------ |
| `snapshot`                                                                                                                                        | **是** | `() => state`；缺少即 `TypeError`                      |
| `capabilities`                                                                                                                                    | 否     | 交给 `normalizeHostCapabilities`；未知键抛 `TypeError` |
| `agentDir`、`modelsPath`、`host`、`port`、`certPath`、`keyPath`、`autoPort`、`embeddedUI`、`funnel`、`filePicker`、`catalogFetch`、`lanAddresses` | 否     | 原样进入 `host.transport`                              |
| 操作实现                                                                                                                                          | 否     | 见"操作名与 capability 对应"；缺失即该操作不可用       |

host 表面（`Object.freeze` 后）：

```js
host.state; // snapshot、effectiveSettings、projectTrusted、canWrite、canSaveSettings、
// canManageSessions、canSetThinking、canDeferConfiguration、validateTarget、
// settingsChanged、gitChanged、revision、canEditShared
host.sessions; // list、create、switch、command
host.resources; // skills、mcpRegistered、mcpTools、mcpAction、packageAction、packageRoot、
// packageUpdates、interactions、trustProject、reload
host.models; // inventory、catalog、save、remove、authStart、authLogout、refresh、set、setThinking
host.prompt; // submit、abort、btw
host.hooks; // requestContext、route
host.transport;
host.capabilities; // normalizeHostCapabilities 的结果
host.snapshot(); // 直接转发 input.snapshot
host.target(body); // createRequestTarget(input.snapshot, body, capabilities.validateTarget ? validateTarget : undefined)
host.supports(name); // capabilities[name] === true
host.require(name, message); // 返回操作函数；没有对应操作时抛 DeskError 501
```

**操作名与 capability 对应**（`host.require(name)` 的合法取值）：

`listSessions`、`newSession`、`switchSession`、`sessionCommand`、`sessionTree`、`tasks`、`packageAction`、`packageUpdates`、`packageRoot`、`skillInventory`、`mcpAction`、`mcpRegistered`、`mcpTools`、`trustProject`、`reload`、`providerInventory`、`providerCatalog`、`providerSave`、`providerRemove`、`authStart`、`authLogout`、`refreshModels`、`setModel`、`setThinking`、`prompt`、`abort`、`btw`、`requestContext`、`route`。

`HOST_CAPABILITY_KEYS`：`sessions`、`remote`、`newSession`、`switchSession`、`sessionCommand`、`sessionTree`、`tasks`、`canManageSessions`、`packageManagement`、`packageUpdates`、`packageRoot`、`skills`、`mcp`、`interactions`、`reload`、`auth`、`authLogout`、`providerInventory`、`providerCatalog`、`providerSave`、`providerRemove`、`model`、`thinking`、`trustProject`、`prompt`、`abort`、`btw`、`settings`、`canSaveSettings`、`revision`、`projectTrusted`、`canWrite`、`canEditShared`、`validateTarget`、`canSetThinking`、`canDeferConfiguration`、`settingsChanged`、`gitChanged`、`route`、`requestContext`。

## 不变量

- **能力是显式声明，不是推断**：bridge 只看 `host.supports(name)` 与 `host.require(name)`；回调存在不会自动开启能力。
- **`normalizeHostCapabilities` 全量归一**：返回对象包含全部 40 个键，未给出的键为 `false`；输入含未知键抛 `TypeError`。
- **每次调用重新解析操作**：`optionalMethod` 返回的闭包在**调用时**才取 `input[key]`，因此 TUI 复用同一 transport、切换聚焦 slot 后不会把下一个 prompt 发到上一个 Agent。
- **`host.target()` 由 host 提供**：bridge 不自己创建 target token，也不复制 409 规则。
- **快照标识在创建时固定**：`createRequestTarget` 捕获的是 `snapshot` **函数本身**，期望身份为创建时的 `sessionId` 与 `cwd`；宿主必须让同一个函数返回最新状态（切换会话时不要整体替换 `snapshot` 引用），否则旧 token 会读到过期身份，409 保护静默失效。
- **`createRequestTarget` 只在同一 seam 判定**：期望身份是创建时的 `sessionId` + `cwd`；`assert()` 在每次 `await` 之后重新读取快照比较。

## 顺序约束

1. `createHostInterface` 必须在任何路由被注册之前完成：capabilities 决定 bridge 暴露哪些端点。
2. 写路由必须在开始处 `host.target(body)`，并在每个 `await` 之后 `target.assert(...)`（`requireSession: true` 时输入必须带 `sessionId`）。
3. `host.require(name, message)` 必须在调用操作**之前**执行，不要先解构再判空。
4. `target.assert({ ready: true })` 用于初始化／交接期间的写入：`snapshot.replacing` 或 `snapshot.initializing` 为真时抛 409。

## 错误模式

| 条件                                                                                | 结果                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `input` 非对象、或缺少 `snapshot`                                                   | `TypeError("Host 必须提供 snapshot()")`                      |
| `capabilities` 含未知键                                                             | `TypeError("未知的 Host capability：<key>")`                 |
| 操作未实现：`host.require(name)` 找不到操作函数                                     | `DeskError(501, message ?? "当前 Desktop 宿主未提供此能力")` |
| 能力声明为 `true` 但操作在调用时已消失（例如 TUI 切换了聚焦 slot）                  | 该次调用抛 `DeskError(501, "当前 Desktop 宿主未提供 <key>")` |
| `input.sessionId` 与当前快照不一致                                                  | `DeskError(409, "当前会话已变化，请刷新后重试")`             |
| `await` 之后 `sessionId`／`cwd` 变化，或 `initializing`／`replacing` 时要求 `ready` | `DeskError(409, ...)`                                        |
| `validateTarget?.(input)` 判定非法                                                  | 由该实现抛出的 `DeskError`（通常是 400／403）                |

## 性能特征

- `optionalMethod` 每次调用做一次属性读取 + 一次 `typeof` 判断，**刻意不缓存**（正确性换极小的读取成本）；操作在接口创建时不存在时，对应属性为 `undefined`。
- `createRequestTarget` 每次 `assert` 读取一次快照对象（内存读，无 I/O）。
- 本模块不做任何 I/O；40 余个 capability 键一次性冻结，无热路径分配。

## 可执行证据

- `test/host-interface.test.mjs`：能力归一化、未知键拒绝、`supports`／`require` 语义。
- `test/target-guard.test.mjs`：会话切换、`ready` 与 `requireSession` 的 409 行为。
- `test/bridge.test.mjs`：bridge 只按声明调用操作（未声明即 501）。
- 全量：`npm test`。
- 接口形状断言：`test/boundary-contracts.test.mjs` —— 重命名或删除本页列出的键、命令或深路径时该测试失败。
