# Composer 样式契约

## 位置与职责

`src/ui/chat/composer.css` 是聊天输入区及其控件样式的唯一所有者，包括基础／兼容 DOM、当前皮肤、嵌入态、响应式规则与键盘菜单。公开资产 `/composer.css` 在 `src/server/asset-manifest.mjs` 登记，由实际聊天 HTML 加载；独立页、Host iframe 与预览走同一加载链。

`chat.css` 保留普通聊天、设置和共享动作菜单；`chat-shell.css` 保留外层布局与其他展示面；`design-tokens.css` 提供主题 token。不在这些文件为 composer 控件追加更晚的补丁。

## 签名

这是 CSS／DOM interface，无 JavaScript 导出。加载顺序：

```text
vendor/katex.css → prototype.css → task-panel.css
→ design-tokens.css → chat-shell.css → composer.css
```

由输入区样式拥有的 DOM：

- `.composer-wrap`、`.composer`、textarea、工具栏、附件／发送／停止／工具按钮及状态读数。
- 项目／提示词／权限 `.context-selector` 胶囊、保留原生值／change 契约的 select、触发器与列表。
- 既有模型／思考控件、`composer-model-picker` 浮层、命令补全和附件展示。
- 用量披露与其读数；独立 BTW 编辑器、任务页表单、Git 控件和 Ask User 的专属展示仍属于各自界面，不因名字含 composer 或 context 就混入。

共享 `.action-menu` 仍是消息菜单等调用方共用的样式；只有 `#composer-tools-menu` 的输入区专属触达规则属于本文件。

## 不变量

- 只整理所有权与移除被确定取代的声明，不更改 DOM、事件、权限、主题颜色或产品布局。
- 基础形态为既有独立／兼容控件提供结构，`.chat-shell` 使用现有语义 token 应用当前皮肤，`.desktop-embedded` 只表达嵌入差异。保留已有 specificity 和条件顺序，不用新 cascade layer 改写优先级。
- 响应式规则位于同一所有者内：具名 `composer` container 负责控件／读数的可用宽度；viewport 条件负责窄屏及安全区；pointer 条件负责触屏热区，不能以缩窄视口冒充粗指针测试。
- 隐藏／disabled／aria 状态继续由当前 controller 决定。CSS 不把不可用操作伪装可用，不以布局重构变更模型／任务配置。
- 主题跟随现有 token；键盘焦点、菜单定位、输入草稿及中文输入法沿用原 module。CSS 不复刻 JavaScript 中的实际浮层位置或 textarea 高度计算。

## 顺序约束

1. shell 和 token 先加载，再加载输入区样式；公共 URL 均通过资产清单发布。
2. 更改控件时在 `composer.css` 内同时核对基础、嵌入与适用断点，不在旧文件底部新增另一套覆盖。
3. 保留公开旧模型 DOM 的兼容形态，不为缩短文件删除它；嵌入模式继续使用既有 picker。
4. 修改条件／specificity 前先记录实际计算样式，在真实页面复测；不能仅通过源码选择器相似判断等价。

## 错误模式

无业务错误。CSS／资产加载失败由真实 HTTP、浏览器和解包回归发现；溢出、遮挡、菜单越界或焦点／触达不足按浏览器断言失败处理，不删除断言验收。

## 性能特征

同源静态 stylesheet，无新增运行时监听器或布局脚本；沿用现有缓存和压缩。具名 container 与既有 media 条件不变，不新增轮询或根据每次模型片段重算样式。

## 可执行证据

- `node test/composer-style-browser-check.mjs`：实际 CSSOM 的所有权、双主题、独立／嵌入、320／360／390／430／480／700／1280px 与 844×390 横屏、实际粗指针、键盘菜单、视口和发送按钮触达；共 96 个计算样式／几何状态。
- 可在修改前使用 `--write-baseline /tmp/composer-before.json`，修改后使用 `--baseline /tmp/composer-before.json` 精确比较所采集属性与几何。临时基线不作为包资产或提交内容；本次收敛的执行记录见[所有权验收](../../history/composer-style-ownership.md)。
- `test/browser-check.mjs`：真实原生输入／附件／命令、双主题对比度及 320／360／390px；`test/subagent-workbench-browser-check.mjs`：工具菜单与触屏导航。
- `test/context-files-browser-check.mjs`：Electron 文件选择与引用；`test/desktop-remote-browser-check.mjs`：远程手机输入、安全区、320／360／390／430px 和入口隐藏。
- `npm test`、`npm run check`、本次文件格式与 `npm run package:check`：真实加载链和解包资产，不仅检查开发目录引用。
