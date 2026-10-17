# Pi Desktop

Pi Desktop 是基于 Pi Agent 与 Pi Durable 的多项目工作空间。默认启动 Electron Desktop；Host 管理多个独立 Agent 进程，桌面和手机浏览器操作同一个工作空间，无需先启动 TUI。

## 启动

需要 Node.js ≥24.21。从源码安装与启动：

```bash
npm ci
npm start -- --port 4318
```

从本地 npm 包安装：

```bash
npm pack
npm install --global ./pi-desktop-extension-0.26.10.tgz
pi-desktop --port 4318
```

`--port` 指定本机 Web Host 端口，默认界面仍为 Desktop。纯 Web 使用 `pi-web --port 4319`；帮助使用 `pi-desktop --help`。`pi-desk` 是 Desktop 的兼容别名。

## 使用与设计

完整文献随 npm 包发布，可离线阅读。

- [文献入口](docs/README.md)：指南、现行设计、参考源码和历史验收。
- [项目与会话](docs/guides/sessions.md)：Pi TUI 历史、继续对话、归档与恢复。
- [配置与原生资源](docs/guides/configuration.md)：模型、网络代理、人格、插件与 MCP。
- [手机连接](docs/guides/remote-access.md)：扫码、重连与按需传输。
- [扩展展示](docs/guides/extensions.md)：通用卡片 schema 与 adapter 注册。
- [兼容入口](docs/guides/compatibility.md)：TUI `/desk` 与单宿主模式的独立适用范围。
- [当前架构](docs/architecture/README.md)与[源码地图](docs/architecture/source-map.md)。

Pi 负责模型交互、工具执行和原生资源加载。活跃会话使用 Pi JSONL；归档完整记录进入 SQLite，恢复时保持原 session ID。正在运行的会话不允许归档。手机先读取导航索引和当前会话的近期消息，展开工具、思考、文件或资源时再取详情。

## 开发与验证

```bash
npm run check
npm run package:check
npm test
npm run test:workspace:browser
npm run preview
```

`npm run preview` 仅预览页面；`npm run dev` 启动真实工作空间。环境要求与已知限制见 [验证说明](docs/architecture/verification.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

源码研究与许可证见 [SOURCES.md](SOURCES.md)、[NOTICE](NOTICE) 和 [licenses](licenses/)。旧版说明完整保存在 [历史快照](docs/history/readme-before-organization.md)，历史结论不作为当前规范。
