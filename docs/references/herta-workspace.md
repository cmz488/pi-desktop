# Herta 源码参考与果冻式工作区

## 可复查的来源

仓库：[PersonaCLI/Herta](https://github.com/PersonaCLI/Herta)。固定提交：`1cd918d00181394f189b2463a9f6cef051a03cb9`。

通过请求级代理 `http://127.0.0.1:7897` 取得 Git 元数据；checkout 多次遇到 TLS EOF，因此下载该提交的原始文件，以 `git hash-object` 与 `git ls-tree HEAD` 核对。不是完整成功 checkout，也不是仅凭截图推断。

| 已校验文件（阅读相关组件与主题／布局规则）                       | Git blob                                   |
| ---------------------------------------------------------------- | ------------------------------------------ |
| `packages/gui/src/renderer/App.tsx`                              | `25fa70894c3a2747adee558e7d543035fa678cb4` |
| `packages/gui/src/renderer/components/Sidebar/Sidebar.tsx`       | `b7b68046c375d825f8db05515ccb6b75ef3df052` |
| `packages/gui/src/renderer/components/Sidebar/SessionItem.tsx`   | `5798b63eb2d36a9b7979abbc25feefb8a96213b5` |
| `packages/gui/src/renderer/components/Workspace/Composer.tsx`    | `36a402c377df3b5147d427bb42f3740a48588476` |
| `packages/gui/src/renderer/components/Workspace/Workspace.tsx`   | `5ab92d7558761b01e4eb5945c2027c55043fd743` |
| `packages/gui/src/renderer/components/Workspace/HertaBubble.tsx` | `c4b419c7234fb0d4b6d10dbf71fff3ec42142740` |
| `packages/gui/src/renderer/components/Workspace/UserBubble.tsx`  | `524752cc2fbead0a6e2c9690cdffce4db1add092` |
| `packages/gui/src/renderer/components/TopBar/TopBar.tsx`         | `c7435453d8202334aae2b88dc82199d62f19b7a8` |
| `packages/gui/src/renderer/styles/reference-ux.css`              | `8486218b8ef49a6f5e5d5dfcd1a74e13326b525d` |

源码许可为 MIT；完整原文及第三方素材排除条款见 [herta-MIT.txt](../../licenses/herta-MIT.txt)。不使用 Herta 的角色、图像、语音、persona、对白或品牌资源，不引入 React、Herta bridge 或执行层。

## 本轮取舍：替换第一版，而非再换一次颜色

第一版刻意压平了 Herta 的渐变、透明度和圆润结构，产生了蓝灰色、硬边界的工作台；这不是上游没有玻璃效果。本轮按用户要求撤销这种保守处理，也不再使用 pi.dev 的网站配色。

实际源码依据：

- **底光与磨砂**：Herta 的 `--app-bg` 使用 mint/cyan/blue 多重径向渐变，叠加 `#25b7ee → #8fece7 → #14a5e2`；`--shell`、`--panel` 为带透明度的乳白色。其 frost source 是静态绘制、模糊和复用，而不是每帧重算整个工作区。
- **浮层**：Sidebar、Workspace、UtilityRail 各自承担滚动与内容层级，表面用细白边、内高光、软阴影分层。Desktop 的项目索引、输入框和按需工具区采用相同材料语言，而非铺满不透明蓝灰方块。
- **消息**：`HertaBubble` / `UserBubble` 为左右对齐的圆角气泡；源码明确去掉头像沟槽，限制阅读宽度。Pi 复用原有消息／活动 DOM，将文本段落变为圆润气泡，保留工具折叠和流式更新，不更改会话记录。
- **输入**：Composer 是独立浮起的玻璃输入区，正文、附件、上下文和操作分层。Desktop 保留 textarea、IME、草稿、权限、模型与发送路径。
- **溢出**：沿用 `minmax(0, 1fr)`、独立滚动和 `overflow: clip`，防止聚焦把整个外框卷走。Pi 的多 Agent 并发保持不变，不复制上游切换／新建会话会中断当前运行的策略。

## 具体落地

`src/ui/design-tokens.css` 在外层桌面和独立／嵌入式聊天共享：

- 浅色默认：青绿／青蓝静态底光，加乳白洗色。正文灰黑，强调色为沉稳 teal；不再把蓝色／紫色大块作为输入和扩展的主视觉。
- 深色是 charcoal/mint 玻璃主题，不是第一版 `#161d27` 的 pi.dev 深蓝灰。沿用 `pi-web-theme`，尊重已保存的 `light`、`dark`、`system`，不擅自覆盖偏好。
- 正文和页面标题使用带 CJK 回退的系统 sans-serif；仅品牌保留开源 Source Serif 4 Italic，代码使用已有 Commit Mono。Pi 标记以单色呈现。不发布专有 Plantin，也不增加远程字体依赖。
- 导航 26px、输入区 24–28px、消息约 20–22px 圆角；内高光与柔和阴影区分材料，普通工具输出仍紧凑。
- 全局底光只模糊静态伪元素；`backdrop-filter` 限于导航、输入和弹窗等局部表面。没有持续的渐变动画，也未移植上游数十万字节 CSS。
- 嵌入式聊天自身完全透明，共用父窗口背景。根节点的 `color-scheme` 跟随 body 主题，避免 Chromium 在深色 iframe 下强制绘制白底。
- 键盘焦点、减少动态效果、粗指针 44px 控件继续有效；`prefers-reduced-transparency` 将玻璃表面换成实色，保留结构与可读性。

扩展页改为**横向页面架 + 单个大玻璃详情面**，不再在主导航旁重复一个纵向侧栏。页面架自己横向滚动，详情自己纵向滚动；设置与工具面板使用同一材质。

## 交互与工作区细节（第二轮）

同一固定提交中的相关证据：

- `.utility-rail`（约 1154、5827 行）是 `workspace-body` 的独立轨道，卡片浮层与主体分开滚动，窗口变窄后整条轨道隐藏。Desktop 的扩展卡片据此离开消息流，放进对话右侧的扩展栏；不是右侧工具侧栏，也不改变 adapter 投影。
- `@keyframes conv-switch-in`（约 3355 行）与注释说明：只在新切入会话的可见行上逐行错开入场，减少动态效果时直接跳过。Desktop 仅在会话标识真正变化时应用该入场，2 秒状态轮询不重播。页面切换使用同一条轻位移＋淡入曲线（约 320ms）。
- 设置里的原生 `<select>` 弹层被源码明确视为 OS chrome，因此触发器改为应用自己的玻璃胶囊（约 7860–7900 行）；Desktop 保留原生 `<select>` 菜单与键盘／IME 语义，只重做触发器，并沿用同一个做法处理项目、系统提示词与权限选择。
- `.status-row`（约 1146、3324 行）把会话读数做成细横线与弱化文字；Desktop 相应地把上下文、Token、费用、缓存和引导／排队模式收为同一行的玻璃小标签，窄宽度时自然换行，不新造数据。

其余交互决定：切换会话期间只显示骨架屏与状态标签，不再闪出演示内容或空会话主视觉；对话阅读区放宽到 1120px 流宽（气泡上限 860px），输入区 1180px。文件查看器按用户提供的参考图增加文件树：内容与树分列、树内可筛选、文件夹按需展开，点击文件切换到已有标签页而不重复开页；树只复用现有的有界 `/api/files` 读取。

## 界面可用性修复（第三轮）

- **非活跃 Agent 的载入面**：切换 Agent 不再回落到项目主视觉。父页面新增 `#agent-boot` 玻璃载入卡（启动中显示进度，停止／失败时给出启动按钮），`#empty` 只在没有选中 Agent 时出现。`workspace.html` 与 `chat/index.html` 都在首帧前读取 `pi-web-theme`，深色偏好下 iframe 不会先闪一帧浅色，因此切换过程既没有浅色预览页，也没有主题闪烁。
- **动画**：补齐共享缓动 token `--ease-jelly`（此前缺失，使相关 transition／animation 实际失效）。页面切换、会话行错开入场、侧栏网格收起、Agent 载入、扩展栏与下拉菜单共用同一条轻位移＋淡入曲线；拖拽调整侧栏时禁用过渡，键盘步进即时生效，`prefers-reduced-motion` 全部关闭。
- **下拉列表**：三处 composer 选择器保留原生 `<select>` 作为值／change 契约（隐藏且不参与 Tab），但增加整颗胶囊可点的触发按钮与玻璃 listbox：正确的 `aria-expanded`／`aria-selected`、方向键／Home／End／Enter／Escape、点击外部关闭；项目、提示词模式、权限等级统一。
- **附件上下位**：本机 Desktop 仍只发送文件索引（绝对路径），Agent 自行读取；远程上传的文件由 Host 以 0600 写入 0700 缓存目录，消息只携带缓存路径（24 小时清理），图片继续作为模型图片输入。
- **网页链接**：消息内的 http(s) 链接不再导航聊天 iframe（被 frame 拒绝时即白屏），统一转到右侧工作区浏览器；共享 Chromium 返回的新标签会成为当前页签。远程禁用浏览器时退回系统新标签。

## 扩展工作台的边界

`src/ui/shared/extension-workbench.js` 调用 `extensionAdapterRegistry.layout` 和 `render(view, { placement: "page", disclosures })`，不识别插件 ID。当前已加载分支的普通卡片保留各自记录，state 卡片每个 scoped identity 只显示最新一条，包括工具结果中的状态。最多列出 80 页，状态优先、各类内部由新到旧。

选择、滚动与 disclosure 在同会话更新中保持，切换会话时清空；未支持版本不产生伪页面。懒加载使用聊天已有 message-detail 路径及会话所有权检查。注册的 renderer 仍是受信任的本地代码，但页面边界再次使用 DOMPurify；通用声明文本不解释为 HTML。没有新命令、远程插件 HTML、TUI 嵌入或独立调度器。

## 检查方法

- `test/desktop-workspace-check.mjs` 检查父子窗口连续背景、默认浅色、深色根节点同步、输入框上方选择器的胶囊样式、文件树与文档分列、点击树内文件切换标签，以及原有工作区交互与大字号／窄屏。
- `test/conversation-timeline-browser-check.mjs` 用真实渲染器检查扩展卡片只进扩展栏、懒详情与展开保持、未支持版本的内联回退，以及切换会话时的骨架屏。
- `test/browser-check.mjs` 检查页面切换动画确实触发、放宽后的对话流宽、单行读数标签与窄屏堆叠；远程上传的附件在模型请求中只出现缓存路径。
- 桌面回归还覆盖 `#agent-boot` 载入面（切换／创建 Agent 不闪项目主视觉）、shell 过渡与 `--ease-jelly`、整颗胶囊打开的自定义下拉、消息链接转到右侧浏览器且聊天 iframe URL 不变；`npm test` 的 Durable／context 用例验证本机只传路径、远程缓存路径与重启后仍可读取。
- `test/extension-workbench-browser-check.mjs` 检查宽／窄屏横向页面架、玻璃详情结构、选择与焦点／滚动保持、懒加载、重试、会话竞态和安全渲染。
- `test/surface-contrast.mjs` 对静态渐变底光取保守色域边界，并逐层合成透明表面；不把半透明白色当成纯白背景计算对比度。另用黑底上 50% 白色的已知低对比样例检查该算法。

设计技能的默认营销页／AI 紫色方案不适用于本任务，未持久化；改用经核对适用的 glassmorphism、文本对比和 HTML 焦点指导，具体视觉以固定 Herta 源码及用户要求为准。
