> 专题研究资料：以记录中的版本、提交和日期为准；当前行为见 [文献入口](../README.md)。

# pi.dev 目录与原生包管理核对

## 一手契约

- 官方目录是 <https://pi.dev/packages>，公开 GET 表单使用 `name`、`type`、`sort`、`page`。类型为 `extension`、`skill`、`theme`、`prompt`；排序为 `downloads`、`recent`、`name`。`recent` 是最近发布版本，不是臆造的仓库更新时间。
- 列表的 `data-package-card` 提供名称、真实类型、月下载数和发布时间；分页来自官方 `packages-pagination`，不只取 npm 搜索前 36 个结果。未标记类型不能推断成 extension。
- MCP 不在当前官方类型下拉中。可提供明确标为关键词搜索的 MCP 入口，不发送不存在的 `type=mcp`。
- 详情例：<https://pi.dev/packages/pi-subagents>。`Package details` 包含版本、发布时间、月/周下载、作者、许可证、类型、体积、依赖与 Pi manifest，`packages-readme` 提供完整 README。目录默认安装命令是未固定版本的 `pi install npm:包名`。
- 本轮未发现公开、版本化的目录 JSON 契约；适配官方 HTML 展示数据和表单，不维护另一份插件注册表，不运行官方页面脚本，不下载预览或 README 外部图片。

## Pi 公共 API

固定源码参考：[`4c6fb7cfe8c538a668726f6f8b3554098c39faee`](https://github.com/earendil-works/pi/tree/4c6fb7cfe8c538a668726f6f8b3554098c39faee)。也核对实际安装版本的 `dist/core/package-manager.d.ts` / `.js`。

- [`packages.md`](https://github.com/earendil-works/pi/blob/4c6fb7cfe8c538a668726f6f8b3554098c39faee/packages/coding-agent/docs/packages.md)：目录发现来自 npm 的 `pi-package`，配置和资源仍由原生 Pi package 管理。项目包受信任保护。
- [`package-manager.ts`](https://github.com/earendil-works/pi/blob/4c6fb7cfe8c538a668726f6f8b3554098c39faee/packages/coding-agent/src/core/package-manager.ts)：公共 `DefaultPackageManager.checkForAvailableUpdates()` 返回 `{source, displayName, type, scope}`，内部处理去重、项目覆盖、固定版本、版本范围、git 远端和离线状态。它不返回远端版本号，而且部分网络失败会被原生实现归为没有报告更新；UI 不能把空结果写成“已是最新”。
- `getInstalledPath()` 给出原生安装位置；已安装版本只读取该目录的 `package.json.version`，不猜测源字符串中的版本。
- 安装、移除、更新继续调用 `installAndPersist()`、`removeAndPersist()`、`update(source)`，持久化边界使用 `SettingsManager.flush()`。原生 `update(source)` 按原生来源/范围匹配，不能假装它是一个任意指定 scope 的更新接口。
- [`security.md`](https://github.com/earendil-works/pi/blob/4c6fb7cfe8c538a668726f6f8b3554098c39faee/packages/coding-agent/docs/security.md)：插件/安装器与宿主同权限。安装/更新仍需显式确认和共享任务空闲，不自动安装、更新或 reload。

## 原始缺口与实连补充

改动前 bridge 只查询 npm search 的 36 条摘要，前端没有官方筛选／分页／完整介绍或原生更新提示；原生 TUI 未提供包管理能力，右侧 × 只关闭页签。本轮由公共 API 薄适配和独立前端布局控件补齐，旧摘要 URI 仅作兼容。

实连核对发现官网会将显式 sort=downloads/page=1 302 规范化，因此请求省略这些默认参数，保留拒绝重定向；筛选结果的 packages-count 形如 `1-50 / 77 (of 5350)`，不是只含范围和结果数。上述数字只是本次观测，不是固定总量。普通 Node fetch 不自动继承当前代理；实际请求复用 Pi 既有网络配置，没有另改 TLS、代理或个人设置。

具体实现和验证结果记录在本轮验收文档；本核对不修改个人配置，也没有重启真实 TUI/手机服务。
