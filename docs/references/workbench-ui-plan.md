# 工作台面板视觉计划

状态：本阶段已实施并通过专项回归；本目标最终验收尚未完成。只调整已有会话／任务面板，不新增管理页面，不移动左侧导航；功能与权限仍由现有读模型和命令决定。

## 方向与取舍

把工作台当作编辑器内的轻量管理台，而非统计仪表盘：任务是列表，右侧是当前选择的详情，轮次 SVG 仍是会话页的核心。主要动作只有“新建子代理”；刷新和范围中止保留为次要动作，中止仍需现有确认。不加 KPI 卡片、装饰编号、新字体或不停播放的动画。

沿用 Herta 派生 token：浅色 canvas `#edf5f4`、panel `#fbfdfd`、text `#263638`、muted `#52666b`、accent `#2f6970`；深色全部走现有语义映射，不按页面硬编码。文字沿用 `--font-ui`，元数据保持次要层级；只有真正编号／代码才使用 `--mono`。间距沿用 4／8／12／16／24px token。

```text
工作台标题                                      返回会话
[对话分支] [任务与子代理]
┌ 标题＋当前范围摘要              刷新  新建子代理 ┐
│ 任务列表                       │ 任务详情       │
│ 选中任务、状态、操作           │ 原生状态与记录 │
│ 子代理会话及归属               │ 可滚动输出     │
└────────────────────────────────────────────────┘
窄屏改为单列，操作可换行但不横向溢出。
```

对模板化风险的复核：不把每条信息塞入同样的圆角卡片；只给选中行和详情阅读区明确层级。图标复用现有 SVG，状态含文字，不仅靠颜色。任务行的“查看”公开展开状态和所控制的详情区域，保持补刷后的焦点。

## Skill 与验证

已阅读 `frontend-design`、`ui-ux-pro-max`。定向检索确认键盘导航、清晰焦点、成功反馈和破坏性确认适用；两次 disclosure 检索未命中特定渐进披露规则，不把不相关的 z-index／标题结果当作依据。布局取舍来自本项目现有界面及 frontend-design 的层级与克制原则。

改动前真实 Chromium 截图：`/tmp/pi-session-redesign-JhF7QI/ui-before/`（任务页 light／dark／390px）；改动后在 `ui-after/`，另包含分支页双主题和窄屏。样式变化不作为性能收益，前后性能测量另行进行。

## 阶段证据

- `ui-selection-red.log`：现有查看按钮没有展开状态／详情控制关系的红测；`ui-disclosure-red.log`：轮次折叠只有 24px 触达区域的红测。修复后两个真实 Chromium 专项通过。
- `test/subagent-workbench-browser-check.mjs`：默认 Host／worker、真实子代理执行与已注册面板；Enter 打开详情并保留焦点、选中控制关系、只有一个面板、双主题透明表面文字对比度 ≥4.5:1、390px 不溢出、按钮／表单／高级披露 44px。真实读取后通过浏览器运输层注入一次延迟／503，验证加载、保留旧内容的错误和重试恢复；释放实际模型工作后才验证终态空清单。
- `test/read-panels-browser-check.mjs`：隔离 UI 夹具验证旧 DOM、A/B/A、只读／remote／unsupported、键盘轮次导航、减少动态效果与双主题；44px 折叠热区同时验证未被 SVG 裁掉、未压住标签。这不是默认 Host 端到端替代品。
- 默认 Host 的 `read-panels-desktop-browser-check`、`host-tasks-browser-check`、`long-task-wait-browser-check`、`desktop-branch-family-browser-check`、`desktop-sidebar-navigation-browser-check` 五项均通过。其中 read-panels-desktop 与 long-task-wait 的同 worker 观察夹具改用已登记的 `legacyFork` 布置存量；其旧入口失败属于夹具语义过期，不作为产品红测。默认 UI 创建及迟到结果的断言保留。
- 本阶段 `npm test` 392/392、`npm run check`、自身文件格式通过；真实解包 199 文件／860 KiB，用户 package、3 份 release 和 194 个安装文件指纹未变（`ui-protection.json`）。全项目格式仍受未授权修改的用户既有 `package.json` 格式影响，未宣称完整 12 项通过。
