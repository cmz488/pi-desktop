# 接口契约

本目录按 module 记录 pi-desktop 的 **interface（接口）**：调用者与测试必须知道的一切，包括类型签名、不变量、调用顺序、错误模式与性能特征。实现原因写在源码里（见 [中文代码规范](../../guides/code-style.md)）；运行边界与归属见 [Pi Durable 与 Pi SDK 的边界](../pi-boundary.md)。

## 契约模板

每篇文档按同一结构书写，缺项必须显式写"无"：

1. **位置与职责**：文件路径 + 一句话职责。
2. **签名**：函数名、参数、返回值。含可选参数与默认值。
3. **不变量**：任何时刻都成立的约束（顺序无关）。
4. **顺序约束**：调用的时间关系（谁必须先于谁、幂等性）。
5. **错误模式**：抛出的类型与判定条件（含 HTTP 状态码语义）。
6. **性能特征**：调用者需要预期的成本（阻塞点、缓存、上限）。
7. **可执行证据**：能证明契约成立的测试文件或命令。

## 模块清单

| 契约                                           | 模块                                                                                                                                   | 覆盖内容                                               | 主要证据                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| [Host interface](host-interface.md)            | `src/server/host-interface.mjs`、`src/server/target-guard.mjs`                                                                         | capability 声明、请求目标 token、`supports`／`require` | `test/boundary-contracts.test.mjs`（能力集与 409 语义）、`test/host-interface.test.mjs`、`test/target-guard.test.mjs`                   |
| [AgentRuntime 进程 seam](agent-runtime.md)     | `src/control-plane/agent-runtime.mjs`、`src/control-plane/process.mjs`、`src/control-plane/agent-worker.mjs`                           | runtime 定义、父子进程握手、停止语义                   | `test/boundary-contracts.test.mjs`（固定选项与停止预算）、`test/agent-runtime.test.mjs`、`npm run test:workspace`                       |
| [Durable workspace](durable-workspace.md)      | `src/agent/agent-workspace.mjs`                                                                                                        | Harness 打开与 workspace 接口、单 writer、提交顺序     | `test/boundary-contracts.test.mjs`（workspace 键与命令表）、`test/agent-workspace.test.mjs`、`npm run test:durable`                     |
| [Pi 资源会话与 native 桥](resource-session.md) | `src/agent/durable-resources.mjs`、`src/agent/native-runtime.mjs`、`src/server/web.mjs`                                                | 资源 facade、工具选择、事件方向                        | `test/boundary-contracts.test.mjs`（facade 与 native 键）、`test/durable-features.test.mjs`                                             |
| [pi-sdk 适配层](pi-sdk-adapter.md)             | `src/agent/pi-sdk.mjs`                                                                                                                 | 入口解析、懒加载、深路径子模块、具名导出校验           | `test/boundary-contracts.test.mjs`（七条深路径存在与导出形状）、`test/pi-sdk.test.mjs`、`test/pi-sdk-lazy.test.mjs`                     |
| [项目与 Agent 生命周期](lifecycle.md)          | `src/control-plane/supervisor.mjs`、`src/control-plane/server.mjs`、`src/control-plane/pi-sessions.mjs`、`src/config/config-store.mjs` | supervisor 接口、命令表、store revision、归档          | `test/boundary-contracts.test.mjs`（supervisor 键与命令表）、`test/desktop-control-plane.test.mjs`、`test/desktop-pi-sessions.test.mjs` |

形状测试（`test/boundary-contracts.test.mjs`）只断言接口形状、能力集、深路径与命令表：重命名或删掉其中一项就会失败；行为语义仍由各自的专项测试覆盖。

## 使用方式

- **改代码前**：先读对应契约的"不变量"与"顺序约束"，确认改动不会让已有调用者违反它们。
- **加字段／加操作**：契约里显式登记，并补一条可执行证据；未登记的对外行为不被视为契约。
- **接口与实现分离**：`docs/architecture/interfaces/` 只写调用者视角；实现细节、取舍与历史原因写在源码注释与 `docs/history/`。
