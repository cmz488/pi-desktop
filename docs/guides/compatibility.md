# 兼容入口

本页只描述显式选择的兼容模式。默认 `pi-desktop`／`pi-web` 使用独立 Host 管理多个 Agent，不依赖 TUI；两者不能混为同一种所有权模型。

## 原生 TUI `/desk`

Pi 加载本包扩展后，`/desk` 打开附加当前 TUI 的桌面，`/desk web` 仅打开服务；`/sessions` 管理同一宿主内的会话。TUI 模式中退出 TUI 会关闭其服务，关闭附加窗口不会停止 TUI。若命令未发现，检查 Pi 包配置或显式 `pi -e /包目录/index.ts`；仅安装 PATH 启动适配器不等于注册扩展。

## 单宿主 Durable 与独立 SDK Web

`--single-process` 保留原单宿主 Durable 入口；`npm run web:legacy` 保留独立 SDK 宿主。它们不是附加另一个 TUI 的命令。原生工具、配置与模型能力按各 adapter 实际声明提供，不承诺任意自定义 TUI 控件都可渲染。

不同模式共用浏览器展示与部分传输 module，但保留各自运行所有权。不要让两个模式同时写同一个原生 JSONL。旧版完整命令及适用环境见 [原说明快照](../history/readme-before-organization.md)。
