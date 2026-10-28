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
| `src/ui-next/`                   | Percho React 桌面与手机界面、Host 接口适配和 UI 构建                                   |
| `src/ui/`                        | 共享纯逻辑、浏览器画面与兼容控制器                                                    |
| `src/remote/`                    | 局域网地址发现（`lan.mjs`）；手机端服务见 `src/server/mobile*.mjs`                     |
| `src/git/`、`src/workspace/`     | Git 审阅 limits／permitted actions、项目文件和只读诊断                                |
| `src/config/`                    | revision、锁和原子配置写入                                                            |
| `src/cli/`                       | 预览与可选启动适配器安装命令                                                          |
| `assets/fonts/`                  | 公共字体；许可保留在 `licenses/`                                                      |
| `docs/`                          | 指南、当前设计、研究来源与历史验收                                                    |
| `test/`、`examples/`、`scripts/` | 独立验证、示例和维护命令                                                              |

## 当前 Percho 界面

当前生产入口为 `src/ui-next/percho/renderer/src/App.tsx`。设置功能注册在 `components/settings/SettingsDialog.tsx`；原生配置、人格、会话配置与资源组件位于 `components/native/NativePreferences.tsx` 和 `NativeResources.tsx`。左侧菜单接入 `NativeSidebar.tsx`，右侧 `WorkspaceSidebar.tsx` 集成文件、共享网页浏览器、Git、任务、分支与侧聊。瞬时导航使用 Percho stores，原生执行与存储继续由所属 worker 拥有。顶部总工作台及旧页面样式已移除，见[整合记录](../history/percho-native-ui-integration.md)。

## 发布资产 seam

`src/control-plane/project-access.mjs` 承接无 worker 草稿目录的文件／Git／MCP 与原生信任操作，复用既有模块并保留本机、路径、信任和确认边界，不启动执行进程。协议和 MCP 暴露取值共用 `src/shared/resource-options.mjs`。见[后续接口修复](../history/percho-interface-followup-repair.md)。

[src/server/asset-manifest.mjs](../../src/server/asset-manifest.mjs) 是公共 URL 与磁盘位置的唯一映射。生产 React／手机资源由 `src/ui-next/build.mjs` 和 Vite 生成并经同一清单发布；共享 module、字体与 schema 也从此映射。浏览器画面复用公开的 `/agent-browser-view.js`，不会直接加载远端网页脚本到界面进程。

Percho 的首屏引导、主题与骨架由其 `main.tsx`、`splash.ts` 和 stores 拥有。共享控制器仍用于兼容宿主与专门契约测试，不是当前生产页面壳。

Percho 输入区在 `components/composer/`，沿用自己的 React 组件、编辑器和主题 token。下述 `src/ui/chat/` 样式与控制器说明属于保留的兼容实现及历史契约，不能作为当前页面入口。

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
