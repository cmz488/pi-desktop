# 当前架构

Pi Desktop 使用已有 Pi Agent／Pi Durable 运行链管理多个项目和 Agent。Desktop、Web 和手机共享浏览器界面；不同运行 adapter 的所有权明确分开。

## 启动与运行所有权

```mermaid
flowchart TD
  CLI[Desktop CLI] --> Electron[Electron 窗口]
  Electron --> Host[独立 Host]
  Web[纯 Web CLI] --> Host
  Host --> A[项目 A 的 Pi Agent 进程]
  Host --> B[项目 B 的 Pi Agent 进程]
  A --> Durable[各自的 Pi Durable Harness 与原生资源]
  B --> Durable
  TUI[兼容 TUI adapter] --> Shared[共享聊天展示与传输]
  Host --> Shared
```

默认 Host 只拥有项目／Agent 生命周期与路由；每个 Agent 的 Pi Durable 执行模型循环，Pi SDK 适配原生工具、扩展、技能、模板、MCP 和交互。TUI `/desk` 与单宿主模式是独立兼容 adapter，不能用其生命周期描述默认 Host。

原生资源 Session 的消息入口由 `native-runtime.mjs` 委托给当前 Durable Agent；模型轮次与实际空闲状态再映射回 Pi 生命周期。资源 Session 自己不能执行模型循环，插件主动创建的独立 Pi Agent 可以使用原有模型配置。扩展自定义记录随会话持久化，原生 widget 只投影为有界展示内容；关闭或更换资源宿主时释放事件订阅与组件。

## 会话同步与原生记录

活跃会话保存在 Pi JSONL，Durable 执行日志使用 SQLite。归档先可靠保存完整原生树到 SQLite 再移除 JSONL；恢复保持原 ID，检测已有 writer 与冲突。会话草稿属于客户端与 Agent，迟到请求不能清理另一个会话的输入。

导航、资源清单和聊天具有不同变化节奏。客户端获取有界消息页与索引，点开文件、思考或工具才请求正文。网络重连沿用 epoch／游标，不另建消息执行循环。

## 展示与发布资产 module

扩展卡片 interface 统一投影、摘要、布局和渲染。普通卡片随消息保留；状态卡片在当前会话按声明标识只展示最新一份。Goal adapter 与通用卡片共用规范，复杂 adapter 保留既有注册方式，清理按注册身份隔离。

发布资产 module 统一公共 URL、磁盘文件与每种页面所需资源。各 Host 和预览只选择对应资产集合；压缩、ETag、HEAD 和缓存沿用统一 handler。目录可变，公共 URL 保持兼容。npm 检查从真实 tarball 验证资源闭包与完整文献，公开资产白名单不包含会话、配置或源码目录的任意文件。

源码职责见 [源码地图](source-map.md)，验证与限制见 [验证说明](verification.md)。历史取舍、旧设计和上游研究保存在 [文献入口](../README.md)。
