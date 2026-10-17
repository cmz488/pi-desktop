> 历史验收记录：保留原始结论与环境信息，不代表当前版本全部行为。当前说明见 [文献入口](../README.md)。

# 0.13.0 · Todo 批次与 VSCode 风格 Git 图表验收

## Todo

用户确认整批完成清空，不要求每项完成立即隐藏。原实现只隐藏全完成 DOM，新任务加入时完整快照重新带出旧完成项；两项初始测试真实失败为 `[1,2]` 而不是 `[2]`。

投影现在记住整批完成的显示退休集合，保留原生记录、当前批完成进度、顺序和依赖；新批次过滤旧完成项，显式重开重新显示。clear／nextId 回退与分支生命周期 reset 隔离 ID。新持久化快照增量消费，不把 nested live 已观察到的完成边界重置。持久化历史按真实快照重放，不读自然语言或猜 tool args；插件未持久化的 nested 状态仍不承诺刷新后恢复。

`test/todo-batches.test.mjs` 验证新批次、历史恢复、live、当前批进度、重开、clear 与分支；Chromium 夹具保留旧完成记录并加入新任务，实际 DOM 仅新任务，原生快照仍保留旧记录。独立提交 `88c45b5`。

## Git 图表

参考 VSCode 官方固定提交 7f20cdad4f4ab923272e91e330a7701c52706fc7 的 scmHistory.ts，不复制运行时或替换主题。最初两项 Git 图表回归因 parentIds 缺失失败；现在服务端真实父提交和作者、拓扑顺序与引用元数据驱动轨道，不是装饰列表。

- 单行 24px，真实分叉／合并／汇合 SVG 曲线、HEAD 空心节点、多父节点、作者、分支／已存在远端／tag pill；标题／完整 SHA／日期／引用悬停可见，点击保持原有详情。
- 默认自动当前 HEAD；可切已有全部分支／标签／远端引用。不自动 fetch、不假造 incoming/outgoing，detached HEAD 不冒充分支。
- 拓扑前缀保证分页连续；4 MiB 输出、原有超时和 128 轨道上限，超限报错不生成假关系。引用前后复核，变化返回 409；工作树编辑不移动引用身份。合作复核不等于跨进程事务锁。
- 沿用 pi.dev 主题，旧宿主缺 gitGraph 只展示已有列表，不依赖新的前端静态模块。仓库文字全部转义，不允许注入 SVG／脚本。

三项 Git 图测试使用临时仓库：35 条线性提交跨页、真实非快进 merge 与祖先汇合、注释 tag、未合并分支的 all 范围、读中引用变化、detached HEAD。Chromium 真实仓库验证路径／HEAD／作者／标签／24px 连续行、切换 all 与 current、恶意 `<img>` 提交说明保持文本，详情与已有管理操作未回退。截图在忽略提交的 screenshots/git-history-graph-dark.png，父执行直接检查。

## 交付边界

完整门禁通过：92 项 Node 零失败／零跳过、15 项 Git；check/typecheck、format:check、diff --check、实际 Pi/SDK/PTY、Chromium 与 Electron 43＋Xvfb。执行 `npm run check`、`npm test`、`npm run test:git`、`npm run test:pi`、`npm run test:browser`、`npm run test:desktop`、`npm run format:check` 与 `git diff --check`。LSP 5 项真实服务器诊断包含在 Node 全套中。未安装依赖或调用真实外部模型；未修改 Pi 核心／第三方插件、个人配置，未重启或 reload 真实 TUI／手机服务，未推送。刷新前保存草稿和附件；新的 Todo 投影与图表元数据需要任务结束后经用户授权更新旧宿主，仅刷新前端不更新后端。公共远端认证、真实手机 OS、macOS/Windows 未新增验证。
