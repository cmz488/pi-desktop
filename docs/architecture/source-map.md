# 源码地图

根目录保留公开入口 `launch-desktop.mjs`、`pi-command.mjs`、`desk.mjs` 和 Pi 扩展 `index.ts`，以及包清单、领域词汇、贡献说明与文献导航。实现按执行职责归位；目录迁移不改变进程、权限或网络语义。

| 目录                             | 所属知识                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `src/control-plane/`             | 项目与 Agent 主管、Agent runtime adapter、索引、发现、进程监督和路由                  |
| `src/desktop/`                   | Electron 窗口、preload、Host worker 和系统目录选择                                    |
| `src/server/`                    | Host interface、Agent snapshot、请求目标、聊天／兼容宿主 HTTP、资产白名单、压缩与 SSE |
| `src/agent/`                     | Pi Durable 与原生资源适配、工具环境和交互                                             |
| `src/session/`                   | Pi JSONL 与 SQLite 归档存储                                                           |
| `src/resources/`                 | 插件／模型资源配置、包管理和人格                                                      |
| `src/tui/`                       | 原生 TUI 与会话命令兼容 adapter                                                       |
| `src/shared/`                    | Node／浏览器共用的投影、卡片、草稿、连接和索引逻辑                                    |
| `src/ui/`                        | 项目导航、生产聊天页面及浏览器专用 module                                             |
| `src/remote/`                    | Tailscale、认证和远程网关                                                             |
| `src/git/`、`src/workspace/`     | Git 审阅 limits／permitted actions、项目文件和只读诊断                                |
| `src/config/`                    | revision、锁和原子配置写入                                                            |
| `src/cli/`                       | 预览与可选启动适配器安装命令                                                          |
| `assets/fonts/`                  | 公共字体；许可保留在 `licenses/`                                                      |
| `docs/`                          | 指南、当前设计、研究来源与历史验收                                                    |
| `test/`、`examples/`、`scripts/` | 独立验证、示例和维护命令                                                              |

## 发布资产 seam

[src/server/asset-manifest.mjs](../../src/server/asset-manifest.mjs) 是公共 URL 与磁盘位置的唯一映射。聊天、项目工作区和预览共用它；外部地址 `/prototype.js`、`/prototype.css`、`/workspace.js` 等继续兼容，生产聊天源码位于 `src/ui/chat/`。

两个页面共用 `src/ui/boot.js` 的同步首屏引导，保留 `/boot.js`（聊天，含预览）与 `/workspace-boot.js`（项目工作区）两个既有 URL。宿主与 Agent 页面的 CSP 都是 `script-src 'self'`，引导必须作为同源外部脚本加载；主题与嵌入背景在聊天延迟模块运行前就生效。模块加载期间只显示加载提示，脚本失败时提供重新加载入口，不按超时展示演示占位内容；聊天控制器接管后才显示骨架或真实会话。

浏览器源码中的相对 import 按公共 URL 解释。它们不等同于磁盘目录关系；浏览器专用文件不能直接改成相对 `src/shared` 的路径。共享纯逻辑放在同一物理目录，使 Node 与浏览器都能跨相同 seam 使用。

## 运行边界

[Pi Durable 与 Pi SDK 的边界](pi-boundary.md) 固定两个运行时的归属：执行 seam 是 `src/control-plane/agent-runtime.mjs` 的 `AgentRuntime`，能力 seam 是 `src/agent/durable-resources.mjs` 里的 Pi 资源会话。新增行为先判断归属，再决定改哪一侧；跨边界的改动必须经过这两条 seam。

归档位置同时受代码规范约束：调用者视角的契约写在 `docs/architecture/interfaces/`，实现原因写在源码注释，命名与术语见 [代码与文档规范](../guides/code-style.md)。

## 客户端策略 seam

`src/ui/shared/client-policy.js` 为聊天入口和会话面板共享只读资格投影；原生能力声明、权限、项目可信及远程路径仍由后端拥有，连接／观察／数据身份与确认在消费方继续收窄。见[客户端策略契约](interfaces/client-policy.md)。

## 聊天视图 seam

`src/ui/chat/chat.js` 保留会话协调、固定请求目标、消息与装配；配置／人格／外观、提供商、技能／MCP、插件／市场、远程页及输入附件各有状态、请求和清理所有者，不穿透可写的全局状态包。共享对话框固定展示／保存代际，模型选择与工作台继续复用原 module。见[聊天视图契约](interfaces/chat-views.md)。

## 原生任务管理 seam

`src/control-plane/host-tasks.mjs` 保留公开聚合与定向转发；`src/agent/managed-subagents.mjs` 用原生 task／owned conversation／submission 组合委托，并注册模型可调用的 `desk_subagent`。`src/ui/shared/task-panel-management.js` 在既有任务页内承接当前会话的发起／详情，`task-detail-view.js` 共用纯文本展示，`subagent-history.js` 在既有分支页单列终态记录；不新增任务页面或弹窗。状态、模型循环、调度与恢复继续属于 Durable，子会话资源仍经既有能力 seam 绑定。接口和可执行证据见 [任务与子代理](interfaces/host-tasks.md) 和 [模型工具](interfaces/subagent-tools.md)。

## 独立会话与输入展示 seam

`src/control-plane/supervisor.mjs` 的普通创建工厂也承接独立继承，`src/session/pi-session-storage.mjs` 通过公开 SDK 捕获与发布原生快照。来源仅追溯，执行、存储与 writer 沿正常新建绑定；既有族内分支不迁移。见[独立会话契约](interfaces/independent-sessions.md)。

`src/agent/input-presentation.mjs` 只关联可信输入来源，`src/shared/input-presentation.mjs` 约束原生 custom 标注的窄格式；模型贡献与 UI 原文分离，未知历史完整回退。它们不是浏览器直接加载的 module，不额外开放源文件目录。见[输入展示契约](interfaces/input-presentation.md)。

## 迁移范围

路径整理自身不改写 Pi 执行链或删除兼容模式；后续会话与展示行为分别由上述契约约束。旧文献原文保存在历史／参考目录。提取行为时，应让调用者和测试通过同一 interface 验证，避免增加 shallow 转发 module。
