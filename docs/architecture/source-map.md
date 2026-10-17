# 源码地图

根目录保留公开入口 `launch-desktop.mjs`、`pi-command.mjs`、`desk.mjs` 和 Pi 扩展 `index.ts`，以及包清单、领域词汇、贡献说明与文献导航。实现按执行职责归位；目录迁移不改变进程、权限或网络语义。

| 目录                             | 所属知识                                           |
| -------------------------------- | -------------------------------------------------- |
| `src/control-plane/`             | 项目与 Agent 主管、索引、发现、进程监督和路由      |
| `src/desktop/`                   | Electron 窗口、preload、Host worker 和系统目录选择 |
| `src/server/`                    | 聊天／兼容宿主 HTTP、资产白名单、压缩与 SSE        |
| `src/agent/`                     | Pi Durable 与原生资源适配、工具环境和交互          |
| `src/session/`                   | Pi JSONL 与 SQLite 归档存储                        |
| `src/resources/`                 | 插件／模型资源配置、包管理和人格                   |
| `src/tui/`                       | 原生 TUI 与会话命令兼容 adapter                    |
| `src/shared/`                    | Node／浏览器共用的投影、卡片、草稿、连接和索引逻辑 |
| `src/ui/`                        | 项目导航、生产聊天页面及浏览器专用 module          |
| `src/remote/`                    | Tailscale、认证和远程网关                          |
| `src/git/`、`src/workspace/`     | Git 操作、项目文件和只读诊断                       |
| `src/config/`                    | revision、锁和原子配置写入                         |
| `src/cli/`                       | 预览与可选启动适配器安装命令                       |
| `assets/fonts/`                  | 公共字体；许可保留在 `licenses/`                   |
| `docs/`                          | 指南、当前设计、研究来源与历史验收                 |
| `test/`、`examples/`、`scripts/` | 独立验证、示例和维护命令                           |

## 发布资产 seam

[src/server/asset-manifest.mjs](../../src/server/asset-manifest.mjs) 是公共 URL 与磁盘位置的唯一映射。聊天、项目工作区和预览共用它；外部地址 `/prototype.js`、`/prototype.css`、`/workspace.js` 等继续兼容，生产聊天源码位于 `src/ui/chat/`。

浏览器源码中的相对 import 按公共 URL 解释。它们不等同于磁盘目录关系；浏览器专用文件不能直接改成相对 `src/shared` 的路径。共享纯逻辑放在同一物理目录，使 Node 与浏览器都能跨相同 seam 使用。

## 迁移范围

此次只整理归属与路径，没有顺手拆分聊天大文件、改写 Pi 执行链或删除兼容模式。旧文献原文保存在历史／参考目录。后续提取行为时，应让调用者和测试通过同一 interface 验证，避免增加 shallow 转发 module。
