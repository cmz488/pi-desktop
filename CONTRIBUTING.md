# 贡献说明

当前架构和模块归属分别见 [架构说明](docs/architecture/README.md)与[源码地图](docs/architecture/source-map.md)。领域术语以 [CONTEXT.md](CONTEXT.md) 为准。

## 运行所有权

默认 Desktop/Web 模式由独立 Host 管理多个 Agent 进程；模型循环、工具和原生资源由每个 Agent 中的 Pi Durable／Pi SDK 承担。TUI `/desk` 是兼容 adapter，生命周期依赖其所属 TUI。不要把兼容模式的限制应用到默认主管模式，也不要再实现模型执行循环。

活跃会话保持 Pi JSONL 语义。归档先可靠保存完整树，再移除原 JSONL；恢复保持 session ID，不覆盖冲突文件。运行中的 Desktop Agent 或 Pi TUI 会话不能归档。测试只使用临时目录、本地模型和本地 Git 夹具，禁止修改个人配置或真实会话。

## 修改与发布

公开 CLI、Pi 扩展入口和浏览器 URL 保持兼容；实现文件可按职责迁移。静态资源必须在统一资产清单登记；Host 与预览通过同一资产 module 处理，不另建路径列表。npm 检查必须验证真实产物内的模块、字体、schema、文献和示例，不能用开发目录掩盖遗漏。

配置变更沿用 Pi 原生设置、内容 revision、锁与原子写入，保留未知字段。全局资源更新沿用现有全部 Agent 空闲／共享写入门禁；单会话切换不能停止其他 Agent。任何权限控制、TLS、网络与进程行为修改须有对应验证，不能以“整理目录”为由调整这些语义。

卡片优先使用通用 schema；复杂 adapter 走既有注册 interface，不在时间线或页面增加插件 ID 特判。浏览器共享代码保持可在无 Node 环境下运行。

## 文献与验证

指南只写当前行为，历史结论保存在 `docs/history/`，研究来源保存在 `docs/references/` 并标记版本／提交。修改后同步相关文献引用，保留上游许可证与 NOTICE。

先运行 `npm run check` 和与修改相符的专项验证。目录／发布修改必须运行 `npm run package:check`；涉及浏览器引用时验证真实 HTTP 加载链。完整命令及已知限制见 [验证说明](docs/architecture/verification.md)。
