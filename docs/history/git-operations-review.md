> 历史验收记录：保留原始结论与环境信息，不代表当前版本全部行为。当前说明见 [文献入口](../README.md)。

# 0.12.0 · 主题、双侧拖动与 Git 历史／管理验收

## 范围和红绿反馈

- 恢复 pi.dev 色板、像素／等宽标签、衬线标题、网格和基础 4px 圆角；ZCode 只参考布局／Git 交互。最初浏览器失败为 `#171717 !== #161d27`。Git 移除色只做对比度适配。
- 左右边缘统一 pointer capture、键盘、取消及宽度限制；先得到“必须用真实 pointer capture 调整实际面板”失败，修复后 CDP 鼠标拖动两侧 60px，实际增长超过 40px，反向方向键可缩小。手机不启用拖动。
- 原 Git log 是变更列表下的原始输出；现“历史”独立分页，每页 30 项，精确 SHA 详情／补丁。“管理”独立显示 merge、checkout、reset 与 tag，不依赖文件列表滚动。
- 新操作三项初始测试全部失败：历史没有 commits，新命令解析返回 422。现解析、执行、确认与前端共用真实服务，没有通过模型或 shell。

## 契约

固定 argv，cwd 来自服务器目标会话；目标只允许 HEAD、已有本地 heads/tags 或唯一 SHA，不接受修订表达式、URL、任意 flag。预览解析 SHA，确认绑定 session/cwd、内容／配置／索引、heads/tags 与 merge 状态，60 秒一次性；要求全部任务／配置空闲。

正常 merge 不自动 stash、解冲突或 abort；冲突返回明确状态与未合并路径，保留现场。可在终端／编辑器解决后明确 stage 并 commit；仍有冲突索引时禁止提交，其他写操作禁止。无效 MERGE_HEAD 也不开放写入。

checkout 只已有／新建分支、提交和 detached HEAD，脏工作区拒绝，不恢复文件或丢弃改动。reset 仅本地分支 soft/mixed，说明目标 SHA 与影响；工作树和未跟踪文件保留，不提供 hard。tag 支持本地轻量／注释标签、列出和删除，不覆盖、不自动推送。

旧宿主缺 gitExtended 时禁止新命令请求，原有历史可保持原始文本；缺 Git API 的面板仍给出更新说明而不冒充已读取。历史／详情请求的 owner、generation、选择对象防迟到结果污染；切换会话清旧视图。

## 验证记录

- Git 2.55.0、临时仓库：32 条历史两页、精确提交详情，真实非快进 merge 提交、冲突保留／暂存／提交，新分支／detached checkout，soft/mixed 保留工作树，本地轻量／注释 tag 与删除。
- 安全：heads/tags 变化使旧 token 失效，重复／过期 token、目标绑定、共享锁；hard／文件恢复／恶意 flag／URL／任意修订表达式拒绝；脏工作区不能 checkout。
- 原生 git.ts 注册与确认：实际临时 Git 写入，log/show、merge/checkout、soft/mixed、tag／注释／删除；不发送模型提示。
- Chromium：实际点击历史列表并查看提交补丁；通过管理表单和独立确认执行 checkout、新分支、merge、tag 创建／删除、soft/mixed。旧 API 无请求、会话隔离、延迟 slash 不误发、草稿和远端选择仍通过。
- 主题、双侧真实拖动／键盘、320/360/390px、LSP 和现有交互一并回归。没有把移动宽度模拟声称为真实手机 OS 验证。

完整验收通过：87 项 Node（零失败、零跳过）、Git 专项 12 项、check/typecheck、format:check、真实 Pi/SDK/PTY、Chromium 及 Electron 43＋Xvfb。执行 `npm run check`、`npm test`、`npm run test:git`、`npm run test:pi`、`npm run test:browser`、`npm run test:desktop`、`npm run format:check` 与 `git diff --check`。LSP 5 项包含在 Node 全套中，本机已有 TS/JSON 服务器返回真实诊断。

主题与双侧缩放已独立提交 `076cbe6`；Git 增强和本记录作为后续独立阶段提交。未重启／reload 或中断真实 TUI／手机宿主，未推送。刷新只更新前端，后端新能力须任务结束后经用户授权更新；刷新前保存草稿与附件。公共远端认证、真实手机剪贴板及 macOS/Windows 未新增验证。
