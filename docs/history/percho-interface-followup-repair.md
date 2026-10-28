# Percho 后续接口差异修复

对应[后续接口调查](../references/percho-interface-followup-research.md)在 `606a234` 上确认的八项问题。沿现有 Host、SDK 和 React 消费者修复，没有新增模型循环、任务状态或配置存储格式。

| 问题 | 最终行为 |
| --- | --- |
| Provider 保存期间切换会话写错目标 | 操作开始固定 worker 身份，同一身份用于 revision、写入与凭据登录 |
| 协议枚举与实际模型装载不一致 | 新建 Provider 的协议选项与配置校验共用四项支持列表；已有内置 Provider 的同协议模型覆盖交给原 SDK Provider，保留认证、OAuth、动态目录与已知模型元数据；保存的模型可从 SDK 注册表取出 |
| 登录启动期间取消丢失 | await 目标与创建任务前登记流程；提前取消不启动原生任务，任务创建中的取消会在取得任务 ID 后送达；终态／未知流程取消保持幂等，UI 捕获网络失败 |
| 无会话项目的文件、Git、MCP 功能被阻断 | Host 为显式目录复用现有有界文件读取、Git 仓库、原生信任与 MCP 配置模块；不创建 worker；草稿分支切换继续走预览 token 与确认 |
| MCP 提供不受支持的 model-only | 前端类型、选项、通道校验与配置校验共用 SDK 支持的四项暴露方式，包括 hidden |
| MCP 信任状态误报 | 清单直接返回实际 projectTrusted，空 server 列表不推导信任 |
| Provider 名称丢失 | 校验、保存、加载名称，清空名称可恢复默认 |
| MCP 路径占位 | 返回实际全局与项目 mcp.json 路径，供原界面展示 |

## 边界

`src/control-plane/project-access.mjs` 只供本机同源 Host 请求。目录先校验为实际绝对路径；文件读取仍执行工作区边界、符号链接和大小限制；Git 仍要求 SDK 项目信任、固定目录绑定、原生 revision／token，并在项目启动会话后拒绝草稿写入。MCP 配置和信任更新沿现有全局空闲门禁、原生版本、锁与原子写入。远程客户端不能访问新增目录管理入口。兼容 TUI／SDK 的其他目录执行所有权不改变。

`src/shared/resource-options.mjs` 是实际消费者共用的纯枚举，避免前端能选择、后端却无法处理的取值。内置模型覆盖继续调用原 SDK Provider 的请求方法，不另做协议或认证实现。

## 验证

- `test/ui-next-interface-repair.test.mjs`：双 worker 延迟回复与目标切换、两个登录启动取消窗口、原生交互终态、无 worker 目录的文件／Git／MCP 全流程、远程拒绝、路径越界、信任前后、所有可选协议和暴露方式、原生额外 API 模型与 Provider 名称。
- `test/ui-capabilities-browser-check.mjs`：从实际新增项目及新会话草稿进入 Git 和 MCP 编辑器，显示真实配置路径、只提供原生暴露方式、保存 hidden 配置且 worker 数保持 0。
- `npm run check`、`npm test`、三套 `test:ui-next:browser` 与 `npm run package:check` 验证类型、现有行为和实际发布产物。

调查中的重连计数疑虑未确认，不另行改变它的会话统计语义；SDK Web 工具只读提示仍是独立研究项，不混入本轮八项修复。
