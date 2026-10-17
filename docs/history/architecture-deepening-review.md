> 历史验收记录：保留本版本的交付与验证证据，不代表未来版本行为。当前说明见 [文献入口](../README.md)。

# 0.26.12 · 架构深化验收

## 交付

- **Host interface**：`src/server/host-interface.mjs` 统一 web、Durable、pi-history、TUI native 与 TUI session-manager 的 Host 接入。能力由 adapter 显式声明；未声明即 false，回调存在不会自动开启功能。`host.target()` 提供请求目标 token。
- **Agent snapshot**：`src/server/agent-snapshot.mjs` 统一 web／Durable／pi-history 的 snapshot shape、默认值和 typed activity；`/api/state` 与 SSE 既有字段保持兼容。
- **Target guard**：`src/server/target-guard.mjs` 在请求开始时捕获 session／cwd，文件选择、Git、LSP、btw、prompt 等 await 后复用同一校验规则。
- **扩展面板动作**：Goal adapter 在注册时声明 command／prefill／refresh／focus-composer；workbench 只转发 typed intent，页面不再从 HTML value 反解析命令。
- **Agent runtime adapter**：`src/control-plane/agent-runtime.mjs` 将 Durable 包成 worker 进程内的第一个 runtime adapter；Host 仍负责进程监督，不引入 headless Pi runtime。
- **Git affordance**：`read()` 返回 `limits` 与 `permittedActions`；页面使用服务端 affordance，`prepare()`／`confirm()` 继续唯一裁决路径、字节预算、动作许可和一次性确认。

Durable 显式声明 sessions／newSession／switchSession／sessionCommand，既有 `/api/sessions`、新建和切换行为保持不变。`requestContext`、`effectiveSettings` 与包管理清单也由显式 capability 门控。

## 验证

- `npm test`：292／292 通过。
- `npm run check`：通过（82 源文件）；`npm run format:check`：通过。
- `test:browser`、`test:extensions:browser`、`test:workspace:browser`、`test:durable`（29／29）、conversation-timeline browser 通过。
- `env -u ELECTRON_RUN_AS_NODE npm run test:workspace:desktop`：Electron workspace 回归通过。
- 新增 focused tests：`host-interface`、`agent-snapshot`、`target-guard`、`agent-runtime`、`bridge` capability 负向断言、Durable sessions／new／switch、goal panel intent、Git limits／permittedActions。

## 边界

未新增 headless Pi runtime、依赖或协议；未改变公开 UI 文案与 HTTP/SSE 形状；未引入 Herta 角色素材。版本为 0.26.12。
