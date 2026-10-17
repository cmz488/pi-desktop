> 历史验收记录：保留原始结论与环境信息，不代表当前版本全部行为。当前说明见 [文献入口](../README.md)。

# 0.15.0 架构优化验收 · 2026-10-05

按架构报告顺序完成四项重构，复用原 Pi Desktop 页面、两个宿主 Adapter、Pi Durable、原生 SDK 和 Tailscale Funnel。版本保持 0.15.0。

| 顺序 | Module                                         | 集中的规则与结果                                                                                                                                                             |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `session-inventories`、`agent-workspace.agent` | 聊天立即呈现，插件／提供商清单独立加载；请求合并、失效、错误重试和迟到结果归属集中管理。Durable 会话列表使用聊天快照，资源 GET 不投影完整聊天历史或读取无关 Git 信息。       |
| 2    | `durable-resources`                            | SDK Session、内部资源命名、工具作用域、原生会话 ID 转换、命令／模板／技能展开和重载后的工具选择留在资源 Adapter。HTTP Adapter 使用 `read`／`describe`／`execute` Interface。 |
| 3    | `session-drafts`                               | 各 Agent 的文字、附件、选择和提交重试身份集中管理；提交冻结内容，成功仅清除相同文字和已发送文件。迟到成功保留新 Agent／新输入，迟到文件读取不能恢复已移除附件。              |
| 4    | `package-management`                           | 清单、信任、目标、共享空闲、来源身份、revision／inventoryKey、更新提示和并发锁组成一个操作生命周期；锁覆盖异步校验到原生执行，失败释放。TUI／Durable 共用原生包管理。        |

有效清单在后续快照活动中缓存最多 30 秒；进入管理页面强制刷新，写操作使缓存失效。插件清单故障独立处理，管理页面提示错误，聊天连接继续工作。没有周期性后台扫描，也没有把所有会话历史保存为新一层缓存。

原页面已移除独立的 `composerDrafts`、`attachmentDrafts`、`durableAttempts` 与 `composerOwner`；原 HTTP bridge 已移除包清单投影、目标检查、更新提示和写锁的重复实现。Module 的 Interface 是测试 surface，生命周期规则的集中提供 locality，原页面、两个宿主 Adapter 与回归测试复用它们提供 leverage。领域词汇见 [CONTEXT.md](../../CONTEXT.md)，最终 Interface 与职责见 [DESIGN.md](design-evolution.md)。

## 验证

- `npm test`：137 项通过，零失败、零跳过。
- `npm run test:durable`：16 项通过，包含真实原生扩展命令、提示模板、技能、工具、MCP、交互、设置、HTTP 和存储。
- `test:durable:browser`：创建两个项目 Agent、独立草稿、刻意延迟提交响应后切换 Agent、后台流式完成、配置和 320／360／390px 布局。
- `test:remote:browser`：真实 Chromium 经本地 HTTPS 隧道夹具扫码认证，插件清单持续等待／返回失败时仍收到流式回答并保持连接；压缩、离线／限速重连、草稿、撤销和隔离继续通过。
- `test:browser`：原页面的聊天、设置、包市场、原生包管理、技能／模板、MCP、附件、Todo、Ask User、多会话、Git 与手机布局回归通过。
- `test:pi`：真实 Pi 1.0.0 CLI／PTY、扩展加载、托管会话、工具、模型／思考、交互和附件通过。
- `test:desktop`、`test:durable:desktop`：Electron 43 + Xvfb 的 TUI 附加模式与 Durable 托管模式均通过，覆盖窗口关闭、服务清理和恢复。
- `test:durable:recovery`：真实 SIGKILL 后 SQLite 恢复；safe 工具重放，unsafe 副作用不重复。
- `check`、`format:check`、`git diff --check` 通过。

测试仅使用本地模型、临时项目／配置／SQLite 和隔离窗口。远程检查使用本地 TLS 代理夹具，实际公网 Tailscale 和真实手机实机不在本轮验收范围。未重启当前使用中的 Desktop 或 TUI；重新打开 Desktop 后加载本轮代码。
