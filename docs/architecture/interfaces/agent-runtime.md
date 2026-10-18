# AgentRuntime 进程 seam 契约

## 位置与职责

- `src/control-plane/agent-runtime.mjs`：定义 runtime（进程内 agent harness）的形状；目前唯一 adapter 是 Durable。
- `src/control-plane/process.mjs`：父子进程协议与停止语义（`launchService`／`serviceMain`）。
- `src/control-plane/agent-worker.mjs`：worker 入口，把 `serviceMain` 接到默认 runtime 上。

这是 [边界文档](../pi-boundary.md) 的 **seam A（执行 seam）**：Host 拥有 spawning／restart／readiness／teardown，runtime 只拥有进程内 harness。

## 签名

```js
export function defineAgentRuntime({ id, start }); // -> frozen { id, start }
export function createDurableRuntime({ start = startDurableDesk } = {}); // -> AgentRuntime
export const defaultAgentRuntime; // createDurableRuntime()

// 父进程侧
export function launchService(entry, options, { timeout = 45000 } = {});
// -> { child, ready: Promise<{ type: "ready", url, nativeSession }>, stop(): Promise<void> }

// 子进程侧（worker 入口：serviceMain((options) => runtime.start(options))）
export function serviceMain(start); // start(options) -> { url, nativeSession, stop() }
```

`options` 由 Host 提供并原样传给 `runtime.start(options)`；durable runtime 会覆盖三个键（`singleAgent: true`、`host: "127.0.0.1"`、`port: 0`），其余（`agentDir`、`directory`、`cwd`、`readOnly`、`nativeSessionPath`、`nativeSessionOwner`、`noExtensions`、`approvalMode`、`agentName`、`agentInstructions`、`extensionPaths`、`nativeResources`、`providers`、`resources`、`workspace`、`workspaceOptions`、`agentBrowser`、`embeddedUI`）见 [durable-server 契约](lifecycle.md)。

## 不变量

- **runtime 不拥有进程**：`defineAgentRuntime` 只接受 `id` 与 `start`；spawn、就绪、重启、销毁全部属于 Host（`src/control-plane/supervisor.mjs`）。
- **`id` 非空、`start` 是函数**：否则 `defineAgentRuntime` 直接抛 `TypeError`；返回对象被 `Object.freeze`。
- **durable runtime 固定三个键**：worker 只监听回环地址、端口由系统分配（`port: 0`）、单 Agent 模式。
- **协议消息只有三种**：父→子 `{ type: "start", options }` 与 `{ type: "stop" }`；子→父 `{ type: "ready", url, nativeSession }` 与 `{ type: "failed", error }`。
- **子进程 stderr 被 drain 且不外泄**：`child.stderr.on("data", () => {})`，插件输出与凭据不进入 API 响应。
- **`stop()` 幂等且升级式**：先发 IPC `stop`，8 s 后 `SIGTERM`，10 s 后 `SIGKILL`；重复调用复用同一个 promise。
- **`serviceMain` 忽略重复 start**：`starting`／`closing` 期间收到 `start` 不重复启动；`disconnect`／`SIGTERM`／`SIGINT` 都走同一条 `stop()`。

## 顺序约束

1. `launchService(entry, options)` 必须先 fork，再由父进程 `child.send({ type: "start", options })`（`launchService` 内部完成）。
2. `ready` resolve 之前**不得**向 worker 发 HTTP 请求；`ready.reject` 会同时触发 `stop()`。
3. `runtime.start(options)` 必须在返回前完成监听（`serviceMain` 只在 resolve 后发 `ready`）。
4. 关闭顺序：`serviceMain` 先 `app.stop()` 再 `process.exit(0)`；父进程 `stop()` 等 `close` 事件。
5. 父进程断开 IPC（`disconnect`）视同 stop：worker 自行退出，避免孤儿进程。

## 错误模式

| 条件                                    | 结果                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ----------- |
| `defineAgentRuntime` 收到空 `id`        | `TypeError("Agent runtime 必须提供非空 id")`                                          |
| `defineAgentRuntime` 收到非函数 `start` | `TypeError("Agent runtime 必须提供 start")`                                           |
| `options.cwd` 无效导致 fork 失败        | `child.once("error")` → `ready` reject，并 `stop()`                                   |
| start 后进程提前退出                    | `ready` reject `Error("Agent 进程退出 (<code                                          | signal>)")` |
| 45 s（可覆盖）内没有 `ready`            | `ready` reject `Error("Agent 启动超时")`                                              |
| 子进程 start 抛错                       | 发 `{ type: "failed", error }` 后 `process.exit(1)`；父进程 reject 同一 error message |
| `app.stop()` 抛错                       | `serviceMain` 捕获后 `process.exit(1)`                                                |

## 性能特征

- 默认启动超时 **45 s**；停止预算 **8 s + 2 s**（SIGTERM→SIGKILL）。
- 每个 Agent 一个 worker 进程；`--single-process` 由 Host 决定（`singleAgent: false`），runtime 不参与该决策。
- fork 使用 `execArgv: []` 与 `ELECTRON_RUN_AS_NODE=1`，使 Electron 与普通 Node 走同一启动路径。
- 启动关键路径不得引入 SDK 整图加载：见 [pi-sdk 适配层](pi-sdk-adapter.md) 的懒加载契约。

## 可执行证据

- `test/agent-runtime.test.mjs`：`defineAgentRuntime` 输入校验与 durable adapter 的固定键。
- `test/desktop-process-recovery.test.mjs`、`test/durable-recovery-check.mjs`：进程重启与恢复路径（`npm run test:durable:recovery`）。
- `test/desktop-control-plane.test.mjs`：Supervisor 的 spawn／就绪／停止（`npm run test:workspace`）。
- 全量：`npm test`。
