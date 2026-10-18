# 验证说明

```bash
npm run check
npm run package:check
npm test
npm run test:workspace:browser
npm run test:workspace:desktop
npm run test:browser
npm run test:extensions:browser
npm run test:context:browser
npm run format:check
```

架构深化专项由 `test/host-interface.test.mjs`、`test/agent-snapshot.test.mjs`、`test/target-guard.test.mjs`、`test/agent-runtime.test.mjs`、`test/goal-panel.test.mjs`、`test/extension-workbench.test.mjs`、`test/git-review.test.mjs` 和 `test/bridge.test.mjs` 覆盖：Host 能力声明与动态 TUI slot、snapshot 统一 shape/typed activity、请求目标竞态、声明式面板动作、Durable runtime adapter，以及 Git limits／permitted actions。其中 `test/bridge.test.mjs` 明确验证“回调存在但未声明能力不会启用功能”，包括 `requestContext`、`sessionCommand`、会话新建／切换、`effectiveSettings` 和包管理清单（`updatesSupported`／`writable`）；`test/durable-server.test.mjs` 断言 Durable 的 `/api/sessions` 仍返回 `supported:true` 与 Agent 行，并验证 `/api/new-session`／`/api/switch-session` 仍返回 200，避免 capability 声明和既有会话管理行为分叉。`test/conversation-timeline-browser-check.mjs` 验证新增 activity 不改变旧的思考／生成文案。浏览器回归继续验证真实页面上的目标面板和 Git 审阅 affordance。

目录和发布修改以真实包内容为验证对象：检查入口及模块引用、公共字体／schema、Markdown 引用和示例完整性；运行时分别检查项目工作区、聊天页面与预览的加载链。浏览器回归还覆盖展开状态、流式思考、当前状态卡片和会话切换。

`node test/conversation-timeline-browser-check.mjs` 使用真实聊天渲染器验证活动折叠栏：兼容 Durable 的 `partial` 消息，只有当前活动播放逐字流水高亮，刷新保留动画进度。等待和空消息使用同样的折叠栏，正文流式输出不另加状态行；运行结束后停止动画。展开的折叠栏正文（工具参数与长输出）按稳定键记住各自滚动位置，重绘后沿用同一偏移，不把读者甩回折叠栏顶端；展开状态、折叠正文偏移与会话滚动位置属于本客户端阅读状态，写入 `sessionStorage`，页面刷新后重新展开并回到原位置。同一回归还验证扩展卡片只进入对话右侧扩展栏、懒详情与展开状态在流式更新后保持、未支持 adapter 回退到原消息，以及会话切换时展示骨架屏而不是演示／空会话界面。

`npm test` 内的 Git 专项（`test/git-review.test.mjs`、`test/git-operations.test.mjs`、`test/git-safety.test.mjs`）覆盖审查、暂存与写入确认：变更列表为每个文件提供 git add／取消暂存，工具栏提供受限的批量暂存，预览只列出本次确认的路径；批量选择遵守单次 100 个路径与 16 MiB 未跟踪指纹额度，超出部分明确跳过而不是让整次暂存失败。状态读取合并重复的 git 调用（一次 `rev-parse --git-path`、复用 ref 列表）并用 `--raw --numstat` 同时取得内容指纹与行统计；大二进制改动不再生成补丁文本，也不会再撞上输出上限。

`npm run test:extensions:browser` 使用真实页面标记、CSS 与扩展工作台 controller，覆盖状态去重、选择／展开／滚动保持、键盘操作、懒详情恢复、失败重试与切换会话竞态、通用文本转义、注册 renderer 的 HTML 清理／回退、目标操作面板与动作转发、375–1280px、双主题与减少动态效果。`test/goal-panel.test.mjs` 另验证目标工具合一面板、工具覆盖声明、验收／起草／完成状态与 adapter 面板过滤。工作区浏览器和 Electron 回归另验证外层入口与顶部页签同步，扩展页不进入设置布局。

果冻式界面回归还检查默认浅色、父子 iframe 的透明背景／根节点主题同步，以及桌面横向扩展页面架。第三轮追加：非活跃 Agent 使用 `#agent-boot` 载入面且不闪项目主视觉、首帧主题引导脚本、`--ease-jelly` 驱动的 shell／视图／会话动画、整颗胶囊可点的主题下拉、消息链接在右侧浏览器打开且聊天 iframe 不导航。附件回归分别断言本机只发送绝对路径、远程上传写入受控缓存并在提示词中只给缓存路径。`test/surface-contrast.mjs` 对静态底光取保守色域边界，逐层合成透明表面后测量文本对比度；降低透明度偏好会启用实色表面并关闭局部背景模糊。页面切换动画、放宽后的对话流宽、单行读数标签与窄屏堆叠在 `test/browser-check.mjs` 中断言；输入框上方的项目／提示词／权限胶囊和文件查看器树在桌面回归中覆盖，树只在容器宽度足够时显示，点击文件切换到已有标签。

Electron 专项若继承 `ELECTRON_RUN_AS_NODE=1`，应使用 `env -u ELECTRON_RUN_AS_NODE npm run test:workspace:desktop` 和 `env -u ELECTRON_RUN_AS_NODE npm run test:context:browser`；仅取消当前测试命令的变量，不改用户全局环境。

测试使用临时目录和本地模型／Git／HTTPS 夹具，不触碰真实用户配置、会话或远端仓库。Chromium／Electron／PTY 的专项需要对应本机工具，详见 package.json 中各命令。真实 Tailscale 公网、第三方 OAuth 和任意 Pi 自定义 TUI 控件不能由本地夹具保证。

## 原生压缩会话恢复回归

此前续跑超时已修复：原生自定义消息曾以 `role: custom` 进入 Durable 模型上下文，导致请求前的 token 估算失败。现在统一复用 Pi 的 `convertToLlm`，原消息元数据单独保留用于卡片展示；旧 SQLite 通过幂等上下文编辑兼容，不改写原始历史或向 JSONL 追加伪造的用户编辑。

相关回归覆盖压缩摘要、保留历史、图片、工具结果、自定义卡片、重启与旧记录分支续跑，保持实际模型请求及原生 session ID 的断言。诊断和修复证据见 [恢复续跑验收](../history/native-custom-context-review.md)。

文件上下文验收使用真实 Electron preload、原生选择器夹具和本地模型，检查本地 HTTP 请求及模型上下文只含文件索引；匿名剪贴板文件仅经本地 IPC 落盘。远程上传、主机路径拒绝、草稿隔离和重试标识同时覆盖。

Goal 回归使用已安装的真实 `pi-goal-x` 和本地 faux 模型，覆盖空参数 `/goal` 起草、草稿取消、原生确认对话、无工具调用时的仪表盘、自动续跑、独立完成审计，以及用户停止后不自动重启、显式恢复后继续。测试目标与插件设置都在临时项目中，不创建真实用户目标。

历史测量与测试环境见 [验收目录](../history/README.md)，历史通过不替代当前验证。

远程连接回归还覆盖：远程文件目录索引复用（文本、图片、大文件、二进制）、远程设置／插件／Agent 配置接口拒绝、远程新建会话/会话管理/文件/Git 保留、Tailscale 子进程无代理环境与守护进程有界重启。手机远程浏览器在 320／360／390／430px 的会话页验证无横向溢出、输入区可见、安全区 padding 与 44px 触控目标；桌面远程外层工作区隐藏设置、扩展、技能和添加项目入口，但保留导航按钮与聊天会话抽屉，远程 Git 路由保持可用。

性能深化专项由 `test/durable-delta.test.mjs`（流式回答只发增量、一次回答的工作区读取 ≤ 20、空闲 revision 探测 0 次完整读取）、`test/pi-sdk-lazy.test.mjs`（Pi SDK 懒加载、memoize、未加载时明确报错、启动关键子模块可单独加载）、Git 专项（`repo.read()` 子进程收敛、写入指纹与一次性确认不变）、`test/bridge.test.mjs`（revision 端点的 supported/unsupported 契约）与 `test/remote-lazy.test.mjs`（桌面宿主的 workspace revision 位）覆盖。`test/durable-browser-check.mjs` 另断言流式回答期间 `/api/state` 取整份快照不超过 5 次，`test/conversation-timeline-browser-check.mjs` 覆盖增量渲染后的折叠、懒详情与滚动保持。前后测量数字见 [性能记录](../history/performance-check.md)。

## Durable 定点重启与恢复

`npm run test:durable:recovery`（`test/durable-recovery-check.mjs` + `test/durable-recovery-worker.mjs`）用同一个 faux 夹具跑三次：一次不中断的对照运行、一次在回答生成流式中途 SIGKILL、一次在两个工具调用在途时 SIGKILL。每次中断后等待被杀死进程的租约到期（约 10.5 s）再重开同一 SQLite。

本机实测（一组固定夹具）：

| 场景                        | provider 请求 | 转录条目 | 用量 tokens | recovery                |
| --------------------------- | ------------- | -------- | ----------- | ----------------------- |
| 对照（不中断）              | 2             | 6        | 2306        | null                    |
| 中断生成（中断前 + 恢复后） | 2 + 1         | 7        | 1490 → 3863 | 1 项，outstanding 1 → 0 |
| 中断工具（中断前 + 恢复后） | 1 + 1         | 6        | 1490 → 3085 | 3 项，outstanding 2 → 0 |

断言：重开后 `read().recovery` 非空、至少一个任务以 `pending` 出现且 `resumedAt` 是时间戳；恢复完成后 `outstanding` 归零、`count` 保持不变；回答文本只出现一次；带工具调用的已提交生成不再被请求（恢复进程只发一次请求）；可安全重放的工具在崩溃后重跑，而一次性副作用不重跑并以错误结果出现在转录中。`/api/state` 的同名字段与聊天页状态旁的“已从检查点恢复 N 项”提示是同一读模型；`test/desktop-process-recovery.test.mjs` 在 `npm test` 内守住该字段的存在。

上游语义与限制（本地实测，非官方承诺）：

- **至少一次**：中断的回合会被重新发起；被中断的尝试会留下标记条目（生成场景是一条空 assistant 条目，工具场景是错误结果条目），已提交且不依赖中断工作的条目不会被重发。
- **用量**：中断尝试与恢复尝试都计入 `pi.usage`，因此恢复后的会话用量高于未中断的对照；已提交的生成不会被重复记账。
- **租约**：被杀死进程的锁需要约 10 秒过期，期间第二个 writer 被拒绝（`DeskError(409, "Agent 存储正在被另一个宿主占用")`）；优雅 `close()` 在前台任务在途时会等待，因此不属于中断。
- **不可控**：真正的中断只能由进程死亡产生，进程内无法模拟；该验证因此不在 `npm test` 的快速套件里，而是独立命令。

## 会话树退回与分叉

`test/durable-session-tree.test.mjs` 在 `npm test` 内验证两类操作（真实 HTTP 命令 + 真实原生日志）：

- **分叉（branch/fork）**：`fork` 从指定 entry 创建新会话，返回 `sessionId`；新会话拥有该点之前的上下文、以 0 用量开始，源会话的用量与消息不受影响。
- **退回（rewind）**：上下文重建到退回点——退回点之前的消息仍在上下文里，其后的回合不再出现；原条目仍在存储里（`desk.rewind` 标记记录 `rewindTo`），且不会把被放弃的回答重放进新上下文。退回后继续对话只提交一份回答。
- **Pi JSONL 一致性**：退回在同一个文件里完成（不新建会话文件），`pi-desktop-rewind` 自定义条目对模型不可见，活跃分支经过退回点、新回合是它的子条目，被放弃的回合仍在文件里但不在活跃分支上——TUI 因此看到与 Desktop 相同的会话树。

扩展工作台的分支树面板也在 `test/durable-browser-check.mjs` 中断言：树行、活跃/已放弃标记、唯一 leaf 与徽标、折叠子树后行数减少、刷新后折叠状态保持、再从节点创建分支（切到新会话）与从节点退回后树仍区分被放弃路径。浏览器回归在 `test/durable-browser-check.mjs` 中完成：会话栏右键出现三个动作（创建分支后新会话出现并切换过去、分支因没有原生转录而禁用退回并给出原因、打开分支树切到扩展工作台）；右键消息出现两个菜单动作，退回后时间线保留目标消息之前的内容并移除其后的回合，分叉后切到名称带“· 分支”的新会话且保留分叉点之前的上下文；整个回归仍断言无页面错误。

分支树读模型由 `GET /api/tree`（capability `sessionTree`）提供：Durable 侧给出分叉来源与会话 id，原生侧给出 parent 链与 leaf；`test/durable-session-tree.test.mjs` 断言分支点、被放弃路径不在活跃路径上、`forkOf` 与 branches 一致、无原生转录时为 `null`，`test/bridge.test.mjs` 断言未声明能力的宿主返回 `supported: false`。

已知限制：退回需要该 Agent 的原生转录（默认多进程 Desktop 每个 Agent 一个 worker，因此都有）；注入 workspace 或 `--single-process` 宿主只为启动时接管的 Agent 绑定转录，其他会话的退回返回 409，分叉不受影响。退回点之前的前缀消息由 Host 用 Pi 自己的推导（`buildSessionContext`）从原生日志取得，Desktop 不自行实现上下文推导。

## 契约与规范的验证

接口契约（[docs/architecture/interfaces/](../architecture/interfaces/README.md)）每条都必须在“可执行证据”里指向测试或命令；新增或改变契约时必须同时补上断言，未登记的对外行为不算契约。运行归属与两条 seam 见 [边界文档](../architecture/pi-boundary.md)。

形状与能力集由一个专门文件守住：`test/boundary-contracts.test.mjs` 断言 Host 的 38 个 capability、资源目标 token 的 409 语义、AgentRuntime 的固定选项与停止预算（8 s SIGTERM／10 s SIGKILL）、pi-sdk 的七条深路径在已安装包里真实存在且导出形状正确、workspace／facade／native／supervisor 的键与命令表，以及上述文档与链接仍然存在。敏感性已实测：临时删掉一个 capability 或重命名一个 workspace 键都会使断言失败，还原后恢复全绿。

代码与文档规范（[代码与文档规范](../guides/code-style.md)）本轮不引入自动检查器：靠评审清单核对（注释只写为什么、被覆盖模块有契约块、契约写在接口文档而不是调用点、术语与 `CONTEXT.md` 一致、改动自带可执行证据）。契约测试的“敏感性”归验证契约管辖：临时反向修改实现时至少一条断言必须失败，验证后还原；只有能因实现变化而失败的断言才算证据。
