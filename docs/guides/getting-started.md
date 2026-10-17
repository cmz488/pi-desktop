# 安装与启动

默认入口为 Desktop，多项目 Host 无需依赖 TUI。Node.js 版本要求由 [package.json](../../package.json) 声明。

```bash
npm ci
npm start -- --port 4318
# 纯 Web 工作空间
npm run web -- --port 4319
# 仅预览页面
npm run preview
```

npm 包安装后使用 `pi-desktop --port 4318`；`pi-desk` 是同义入口，`pi-web` 只启动 Web Host。省略端口时由系统分配可用端口。可选 `--cwd`、`--agent-dir`、`--data-dir`、`--extension` 等参数以 `pi-desktop --help` 为准。

Electron 随包安装；已有系统 Electron 可通过 `PI_DESK_ELECTRON` 指定。显式提供本机 URL 时，Desktop 可附加已有 Host。默认模式的 Desktop 持有其创建的 Host，退出会清理它拥有的进程；兼容模式的所有权见 [兼容入口](compatibility.md)。

构建本地 tarball 使用 `npm pack`，发布前运行 `npm run package:check` 验证真实包内容。该检查不发布 npm 包。
