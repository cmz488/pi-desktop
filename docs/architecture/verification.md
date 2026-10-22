# 验证说明

```bash
npm test
npm run check
npm run format:check
npm run test:durable
npm run test:workspace
npm run test:durable:recovery
npm run test:browser
npm run test:durable:browser
npm run test:workspace:browser
npm run test:remote:desktop
npm run test:extensions:browser
npm run package:check
```

Electron 的 `test:workspace:desktop`、`test:context:browser` 为额外的平台专项；环境要求见下文。

独立会话、原生恢复来源与输入原文的 Node 专项已由 `npm test` 自动纳入：`desktop-independent-fork`、`desktop-independent-scope`、`desktop-native-boundaries` 与 `input-presentation`。它们验证真实 Host／worker、SDK 压缩／context edit／custom、同号任务隔离、丢失回执后的拒绝与恢复、非 fork 代理及模型文本不变。另行执行 `node test/input-presentation-browser-check.mjs`，验证真实输入框、流式、标签、历史、独立继承与自动内容默认折叠；不以包脚本未包含该文件为由略过。

`node test/desktop-performance-check.mjs <证据目录>` 固定三轮同拓扑性能；`node test/independent-session-memory-check.mjs <证据目录>` 单列独立 worker 架构成本。夹具与指标限制、对齐前后各六轮及最终运行时复测见[本轮性能记录](../references/session-redesign-performance.md)。

全 Host 任务与子代理由 `test/host-task-management.test.mjs` 的真实 Host／worker HTTP 验证，覆盖持久幂等、原生 owned 关系、单 writer、等待断连、目标／权限、重启与子会话自身工具 scope，以及暂停单 worker 的局部超时。`test:workspace:browser` 纳入 `test/host-tasks-browser-check.mjs`：两个 SQLite 的同号 task、当前会话面板的 UI 发起／等待／中止、草稿与切换隔离、结果和窄屏边界。`test/subagent-workbench-browser-check.mjs` 验证直接整合既有任务页、移除独立入口／弹窗、实时／历史分流与页签观察回收；`test/subagent-tools.test.mjs` 由 faux provider 编排真实模型工具调用，`test/subagent-history.test.mjs` 验证真实终态分页及范围。`test/subagent-reliability.test.mjs` 追加审批继承／停机权限变更、owned 交互与越界拒绝、资源回收／历史不预热、跨重启回合预算、整树并发及嵌套限制；模型工具另验证消息终态重试和回答全文／历史分页，工作台浏览器实际批准／拒绝子代理写入并提交回合预算，另查看 followUp 预算失败的原生消息状态和不变的首次答案。Node 回归还覆盖既有分支／旧位置分叉的 Host 权限覆盖与 worker 隔离，以及旧 submission 的内容／模式校验、未知模式和重启后回执一致性。它不是 CLI 子代理探测；任务调度和模型循环仍由 Durable 原生能力承担。当前接口见 [Host 任务契约](interfaces/host-tasks.md)。

架构深化专项由 `test/host-interface.test.mjs`、`test/agent-snapshot.test.mjs`、`test/target-guard.test.mjs`、`test/agent-runtime.test.mjs`、`test/goal-panel.test.mjs`、`test/extension-workbench.test.mjs`、`test/git-review.test.mjs` 和 `test/bridge.test.mjs` 覆盖：Host 能力声明与动态 TUI slot、snapshot 统一 shape/typed activity、请求目标竞态、声明式面板动作、Durable runtime adapter，以及 Git limits／permitted actions。其中 `test/bridge.test.mjs` 明确验证“回调存在但未声明能力不会启用功能”，包括 `requestContext`、`sessionCommand`、会话新建／切换、`effectiveSettings` 和包管理清单（`updatesSupported`／`writable`）；`test/durable-server.test.mjs` 断言 Durable 的 `/api/sessions` 仍返回 `supported:true` 与 Agent 行，并验证 `/api/new-session`／`/api/switch-session` 仍返回 200，避免 capability 声明和既有会话管理行为分叉。`test/conversation-timeline-browser-check.mjs` 验证新增 activity 不改变旧的思考／生成文案。浏览器回归继续验证真实页面上的目标面板和 Git 审阅 affordance。

目录和发布修改以真实包内容为验证对象：检查入口及模块引用、公共字体／schema、Markdown 引用和示例完整性；运行时分别检查项目工作区、聊天页面与预览的加载链。浏览器回归还覆盖展开状态、流式思考、当前状态卡片和会话切换。

`test:workspace:browser` 包含 `test/chat-first-paint-browser-check.mjs`：从真实 Host 的运行会话切到原生历史会话，分别延迟聊天模块与首份状态，跨过旧的 4 秒兜底边界；断言当前目标实际计算出的主题、不透明度、背景伪元素和可见内容，不依赖加载标记或缓存帧计数。它还验证模块就绪后的骨架与非演示身份、切回后的草稿，以及脚本失败时可重新加载的明确提示。

`node test/conversation-timeline-browser-check.mjs` 使用真实聊天渲染器验证活动折叠栏：兼容 Durable 的 `partial` 消息，只有当前活动播放逐字流水高亮，刷新保留动画进度。等待和空消息使用同样的折叠栏，正文流式输出不另加状态行；运行结束后停止动画。展开的折叠栏正文（工具参数与长输出）按稳定键记住各自滚动位置，重绘后沿用同一偏移，不把读者甩回折叠栏顶端；展开状态、折叠正文偏移与会话滚动位置属于本客户端阅读状态，写入 `sessionStorage`，页面刷新后重新展开并回到原位置。同一回归还验证扩展卡片只进入对话右侧扩展栏、懒详情与展开状态在流式更新后保持、未支持 adapter 回退到原消息，以及会话切换时展示骨架屏而不是演示／空会话界面。

`npm test` 内的 Git 专项（`test/git-review.test.mjs`、`test/git-operations.test.mjs`、`test/git-safety.test.mjs`）覆盖审查、暂存与写入确认：变更列表为每个文件提供 git add／取消暂存，工具栏提供受限的批量暂存，预览只列出本次确认的路径；批量选择遵守单次 100 个路径与 16 MiB 未跟踪指纹额度，超出部分明确跳过而不是让整次暂存失败。状态读取合并重复的 git 调用（一次 `rev-parse --git-path`、复用 ref 列表）并用 `--raw --numstat` 同时取得内容指纹与行统计；大二进制改动不再生成补丁文本，也不会再撞上输出上限。

`npm run test:extensions:browser` 使用真实页面标记、CSS 与扩展工作台 controller，覆盖状态去重、选择／展开／滚动保持、键盘操作、懒详情恢复、失败重试与切换会话竞态、通用文本转义、注册 renderer 的 HTML 清理／回退、目标操作面板与动作转发、375–1280px、双主题与减少动态效果。`test/goal-panel.test.mjs` 另验证目标工具合一面板、工具覆盖声明、验收／起草／完成状态与 adapter 面板过滤。工作区浏览器和 Electron 回归另验证外层入口与顶部页签同步，扩展页不进入设置布局。

果冻式界面回归还检查默认浅色、父子 iframe 的透明背景／根节点主题同步，以及桌面横向扩展页面架。还覆盖：非活跃 Agent 使用 `#agent-boot` 载入面且不闪项目主视觉、首帧主题引导脚本、`--ease-jelly` 驱动的 shell／视图／会话动画、整颗胶囊可点的主题下拉、消息链接在右侧浏览器打开且聊天 iframe 不导航。附件回归分别断言本机只发送绝对路径、远程上传写入受控缓存并在提示词中只给缓存路径。`test/surface-contrast.mjs` 对静态底光取保守色域边界，逐层合成透明表面后测量文本对比度；降低透明度偏好会启用实色表面并关闭局部背景模糊。页面切换动画、放宽后的对话流宽、单行读数标签与窄屏堆叠在 `test/browser-check.mjs` 中断言；输入框上方的项目／提示词／权限胶囊和文件查看器树在桌面回归中覆盖，树只在容器宽度足够时显示，点击文件切换到已有标签。

Electron 专项若继承 `ELECTRON_RUN_AS_NODE=1`，应使用 `env -u ELECTRON_RUN_AS_NODE npm run test:workspace:desktop` 和 `env -u ELECTRON_RUN_AS_NODE npm run test:context:browser`；仅取消当前测试命令的变量，不改用户全局环境。

Chromium 夹具仅对一次性测试 profile 使用 `--password-store=basic`，避免依赖桌面凭据库解锁而卡住本地 HTTP 导航；不读取或修改用户 Chromium 配置，也不改变生产认证／TLS／沙箱策略。

测试使用临时目录和本地模型／Git／HTTPS 夹具，不触碰真实用户配置、会话或远端仓库。Chromium／Electron／PTY 的专项需要对应本机工具，详见 package.json 中各命令。真实 Tailscale 公网、第三方 OAuth 和任意 Pi 自定义 TUI 控件不能由本地夹具保证。

## 标准 Pi 扩展兼容基线

`node --test test/standard-extension-baseline.test.mjs` 已纳入 `npm test`：两个独立标准包经真实 Pi 安装／持久化／发现接入默认 Host，验证工具与参数／结果 hook、命令与普通 custom 消息、多次重载、私有状态、禁用／恢复及两包各自独立运行。相同源码另由内嵌 SDK 原生 runtime 对照输入决策、system override、消息替换、边界 continuation、标准 UI 协议和关闭。当前版本、来源、完整命令与已确认缺口见[扩展兼容基线](../references/pi-extension-compatibility-baseline.md)。

这只是阶段 06 的兼容调查，不把诊断输出缺失的事件当作已支持，也不以原生 UI recorder 代替真实浏览器交互。两个扩展的 TypeScript 源码还需按基线给出的独立 `tsc` 命令检查；它们不使用 Desktop 声明或专用 adapter。

`test/native-runtime-lifecycle.test.mjs` 继续用真实 SDK 的旧 context 验证失效错误不会被桥绕过，并在真实安装包中验证 fresh runner 的启动前绑定、标准命令 reload、signal／idle、无重复命令和卸载状态清理。阶段 07 的分项进展与原始红／绿证据见[生命周期记录](../history/native-extension-lifecycle.md)。

## 原生压缩会话恢复回归

模型消息通过 Pi 的 `convertToLlm` 规范化，原生 UI 消息元数据独立保留用于卡片展示；旧 SQLite 通过幂等上下文编辑兼容，不改写原始历史或向 JSONL 追加伪造的用户编辑。

相关回归覆盖压缩摘要、保留历史、图片、工具结果、自定义卡片、重启与旧记录分支续跑，保持实际模型请求及原生 session ID 的断言。诊断和修复证据见 [恢复续跑验收](../history/native-custom-context-review.md)。

文件上下文验收使用真实 Electron preload、原生选择器夹具和本地模型，检查本地 HTTP 请求及模型上下文只含文件索引；匿名剪贴板文件仅经本地 IPC 落盘。远程上传、主机路径拒绝、草稿隔离和重试标识同时覆盖。

Goal 回归使用已安装的真实 `pi-goal-x` 和本地 faux 模型，覆盖空参数 `/goal` 起草、草稿取消、原生确认对话、无工具调用时的仪表盘、自动续跑、独立完成审计，以及用户停止后不自动重启、显式恢复后继续。测试目标与插件设置都在临时项目中，不创建真实用户目标。

历史测量与测试环境见 [验收目录](../history/README.md)，历史通过不替代当前验证。

远程连接回归还覆盖：远程文件目录索引复用（文本、图片、大文件、二进制）、远程设置／插件／Agent 配置接口拒绝、远程新建会话/会话管理/文件/Git 保留、Tailscale 子进程无代理环境与守护进程有界重启。手机远程浏览器在 320／360／390／430px 的会话页验证无横向溢出、输入区可见、安全区 padding 与 44px 触控目标；桌面远程外层工作区隐藏设置、扩展、技能和添加项目入口，但保留导航按钮与聊天会话抽屉，远程 Git 路由保持可用。

性能深化专项由 `test/durable-delta.test.mjs`（流式回答只发增量、一次回答的工作区读取 ≤ 20、空闲 revision 探测 0 次完整读取）、`test/pi-sdk-lazy.test.mjs`（Pi SDK 懒加载、memoize、未加载时明确报错、启动关键子模块可单独加载）、Git 专项（`repo.read()` 子进程收敛、写入指纹与一次性确认不变）、`test/bridge.test.mjs`（revision 端点的 supported/unsupported 契约）与 `test/remote-lazy.test.mjs`（桌面宿主的 workspace revision 位）覆盖。`test/durable-browser-check.mjs` 另断言流式回答期间 `/api/state` 取整份快照不超过 5 次，`test/conversation-timeline-browser-check.mjs` 覆盖增量渲染后的折叠、懒详情与滚动保持。前后测量数字见 [性能记录](../history/performance-check.md)。

## Durable 定点重启与恢复

`npm run test:durable:recovery`（`test/durable-recovery-check.mjs` + `test/durable-recovery-worker.mjs`）用同一个 faux 夹具跑三次：一次不中断的对照运行、一次在回答生成流式中途 SIGKILL、一次在两个工具调用在途时 SIGKILL。每次中断后等待被杀死进程的租约到期（约 10.5 s）再重开同一 SQLite。

固定夹具的历史请求数、条目数与用量见[恢复测量记录](../history/durable-recovery-measurement.md)；当前验收以命令实际输出与断言为准。

断言：重开后 `read().recovery` 非空、至少一个任务以 `pending` 出现且 `resumedAt` 是时间戳；恢复完成后 `outstanding` 归零、`count` 保持不变；回答文本只出现一次；带工具调用的已提交生成不再被请求（恢复进程只发一次请求）；可安全重放的工具在崩溃后重跑，而一次性副作用不重跑并以错误结果出现在转录中。`/api/state` 的同名字段与聊天页状态旁的“已从检查点恢复 N 项”提示是同一读模型；`test/desktop-process-recovery.test.mjs` 在 `npm test` 内守住该字段的存在。

本地夹具的覆盖范围与限制（不扩大为上游承诺）：

- **至少一次**：中断的回合会被重新发起；被中断的尝试会留下标记条目（生成场景是一条空 assistant 条目，工具场景是错误结果条目），已提交且不依赖中断工作的条目不会被重发。
- **用量**：中断尝试与恢复尝试都计入 `pi.usage`，因此恢复后的会话用量高于未中断的对照；已提交的生成不会被重复记账。
- **租约**：被杀死进程的锁需要约 10 秒过期，期间第二个 writer 被拒绝（`DeskError(409, "Agent 存储正在被另一个宿主占用")`）；优雅 `close()` 在前台任务在途时会等待，因此不属于中断。
- **不可控**：真正的中断只能由进程死亡产生，进程内无法模拟；该验证因此不在 `npm test` 的快速套件里，而是独立命令。

## 会话树退回与分叉

默认 Desktop 的分支创建由 Host 协调，返回新 Agent／generation／sessionId，并拥有独立 worker 与存储；左侧、聊天菜单与工作台入口由 `test/desktop-branch-family-browser-check.mjs` 验证，包括同一 iframe 切到设置后的迟到回执不能抢页。精确位置、正常生命周期、源不变及存量路径见[独立会话契约](interfaces/independent-sessions.md)。

以下 `test/durable-session-tree.test.mjs` 验证低层／单进程兼容接口和既有族内分支，不代替默认 Host 独立创建验收（真实 HTTP 命令 + 真实原生日志）：

- **兼容分叉（branch/fork）**：`fork` 从指定 entry 创建同 worker 的历史会话，返回 `sessionId`；新会话拥有该点之前的上下文、以 0 用量开始，源会话的用量与消息不受影响。
- **退回（rewind）**：上下文重建到退回点——退回点之前的消息仍在上下文里，其后的回合不再出现；原条目仍在存储里（`desk.rewind` 标记记录 `rewindTo`），且不会把被放弃的回答重放进新上下文。退回后继续对话只提交一份回答。
- **Pi JSONL 一致性**：退回在同一个文件里完成（不新建会话文件），`pi-desktop-rewind` 自定义条目对模型不可见，活跃分支经过退回点、新回合是它的子条目，被放弃的回合仍在文件里但不在活跃分支上——TUI 因此看到与 Desktop 相同的会话树。

扩展工作台的任务与子代理面板同样在 `test/durable-browser-check.mjs` 中断言：空闲 Agent 显示空态、真实 `bash` 在跑任务出现在任务树与在跑工具里、第一步点击只进入待确认状态而任务仍在、第二步取消后面板清空、`等待` 返回时回答已提交，以及切到另一个 Agent 并重新打开面板后看到的是那个 Agent 自己的任务（面板跟随当前会话）。扩展工作台的分支树面板也在 `test/durable-browser-check.mjs` 中断言：SVG 按轮次聚合、活跃／已放弃路径、唯一当前位置、折叠与刷新保持；历史轮次只可退回，随后从当前位置创建分支（切到新会话），底层精确 entry 分叉能力不被移除。浏览器回归在 `test/durable-browser-check.mjs` 中完成：会话栏右键出现三个动作（创建分支后新会话出现并切换过去、在该单进程注入夹具中，分支因没有原生转录而禁用退回并给出原因、打开分支树切到扩展工作台）；右键消息出现两个菜单动作，退回后时间线保留目标消息之前的内容并移除其后的回合，历史消息的分支入口禁用，当前位置分叉后切到名称带“· 分支”的新会话并保留当前上下文；整个回归仍断言无页面错误。

任务管理由 `POST /api/command` 的 `wait`／`cancel` 提供；真实后台任务由 `test/background-fixture.mjs`（`tx.createTask(..., { background: true })`）造出，API 测试断言它在会话空闲时仍存活、取消后台任务返回它的 id 并让它进入终态，浏览器回归在面板上完成同一条路径（后台标记 + 两步确认取消）；任务管理（取消支持单任务、后台任务与该会话当前工作；只读宿主返回 403，远程取消自己的任务属于允许动作）；`test/durable-task-graph.test.mjs` 另外断言按任务 id 取消后任务图清空、子会话不产生孤儿、`wait` 在回答提交后才返回、未知任务 404、后台取消不打断前台运行。任务图与子会话读模型由 `GET /api/tasks`（capability `tasks`）提供：`test/durable-task-graph.test.mjs` 用真实子代理夹具断言空闲会话任务图为空而子会话仍在、子会话的 `owner` 边、挂起工具进入 `tools`、`pi.tool` 的 `owner` 指向它的 `pi.generation` 与 `waitingOn` 关系。

分支树读模型由 `GET /api/tree`（capability `sessionTree`）提供：Durable 侧给出分叉来源与会话 id，原生侧给出 parent 链与 leaf；`test/durable-session-tree.test.mjs` 断言分支点、被放弃路径不在活跃路径上、`forkOf` 与 branches 一致、无原生转录时为 `null`，`test/bridge.test.mjs` 断言未声明能力的宿主返回 `supported: false`。

已知限制：退回需要该会话自己的原生转录；新独立会话使用自己的 worker 与唯一 writer，既有族内历史会话各自绑定转录、仍共享原 worker 的唯一 Durable writer。注入 workspace 或 `--single-process` 宿主只为启动时接管的 Agent 绑定转录，其他会话的退回返回 409，分叉不受影响。退回点之前的前缀消息由 Host 用 Pi 自己的推导（`buildSessionProjection`）从原生日志取得，Desktop 不自行实现上下文推导。

## 契约与规范的验证

接口契约（[docs/architecture/interfaces/](../architecture/interfaces/README.md)）每条都必须在“可执行证据”里指向测试或命令；新增或改变契约时必须同时补上断言，未登记的对外行为不算契约。运行归属与两条 seam 见 [边界文档](../architecture/pi-boundary.md)。

形状与能力集由一个专门文件守住：`test/boundary-contracts.test.mjs` 断言 Host 的 41 个 capability、资源目标 token 的 409 语义、AgentRuntime 的固定选项与停止预算（8 s SIGTERM／10 s SIGKILL）、pi-sdk 的七条深路径在已安装包里真实存在且导出形状正确、workspace／facade／native／supervisor 的键与命令表，以及上述文档与链接仍然存在。接口变更须在隔离副本反向修改对应能力或键名，确认断言失败，再还原复测；各阶段结果保存在历史修复记录。

代码与文档规范（[代码与文档规范](../guides/code-style.md)）不新增自动风格检查器，按清单核对（注释只写为什么、被覆盖模块有契约块、契约写在接口文档而不是调用点、术语与 `CONTEXT.md` 一致、改动自带可执行证据）。契约测试的“敏感性”归验证契约管辖：临时反向修改实现时至少一条断言必须失败，验证后还原；只有能因实现变化而失败的断言才算证据。

## Composer 样式

`node test/composer-style-browser-check.mjs` 验证公开 stylesheet 的唯一所有权、96 个双主题／独立／嵌入计算样式状态、320–1280px 与横屏、实际粗指针、键盘菜单及视口／触达边界。修改前可用 `--write-baseline /tmp/composer-before.json` 保存临时基线，修改后用 `--baseline /tmp/composer-before.json` 比较所采集属性和几何；不把基线 JSON 作为产品资产。当前契约见[Composer 样式](interfaces/composer-styles.md)，本次前后记录见[所有权验收](../history/composer-style-ownership.md)。

## 聊天视图与附件

`node test/chat-views-browser-check.mjs` 使用真实 Host／worker 及公开模块，故意延迟已读取的真实 HTTP 响应，验证 A/B/A 的人格、配置和 MCP 读取隔离、设置草稿与分类／资源焦点、远程离页后不 prepare／补刷、页面卸载清理及共享对话框的保存代际。`test/browser-check.mjs` 继续覆盖全部设置／资源页面和市场／配置写入，`test/context-files-browser-check.mjs` 验证 Electron 本地文件索引；原会话导航、输入展示和远程专项保持。契约见[聊天视图](interfaces/chat-views.md)。

## 会话只读面板

`test/session-panel-loader.test.mjs` 用有界时钟验证代际、取消读取、节流／补刷与销毁，不依赖真实时间轮询。`test:extensions:browser` 追加真实工作台与两面板的隔离浏览器验收：旧 DOM、晚到响应、A/B/A、背景取消确认、同会话权限变化、折叠／滚动、unsupported 与资源清理。`test:workspace:browser` 追加真实默认 worker 的聊天控制器验收：在新快照返回前立即撤下旧数据，迟到任务读模型／分叉结果不切换会话，能力变化正确隐藏入口，且两个真实在途任务均未被误取消。它也验证默认分支的独立转录、两次退回后 Q1 原点与再次分叉。读模型能力在完整／chat 快照内都由 `test/bridge.test.mjs` 守住，不依赖方法存在性猜测。

## 长任务等待

`test:workspace:browser` 纳入 `test/long-task-wait-browser-check.mjs`：默认 Host → worker → runtime 的真实前台任务在点击等待后再阻塞 16.5 秒，13 秒时仍未结束且没有通用中止或提前成功，最终回答提交后才返回。后续通过同 worker 的两个独立会话验证取消等待／总期限不误中止任务、408 只续同一目标且不重置预算、旧成功故意无视 abort 晚到也不影响另一会话。读模型返回 unsupported 时立即释放等待，能力隐藏不留下观察请求。时钟边界还验证 5 分钟预算、45 秒等待连接错误与普通 API 的 12 秒预算，以及全部出口的定时器回收。

`test/task-waits.test.mjs` 用真实 HTTP 验证 408、断连归还配额、503 关闭、正常出口移除连接监听与到期时钟；`test/durable-task-scope.test.mjs` 用真实 Durable runtime 验证 32 项观察配额和物理断连后立即重用；`test/agent-workspace.test.mjs` 验证独立取消 Context 释放观察者而前台任务继续。完整调用与错误契约见 [任务契约](interfaces/task-graph.md)。

## 工具契约与只读交接

遇到参数 schema 不一致或 committed range 的只读审查交接时，先按[交接指南](../guides/review-handoff.md)固定输入并检查文件。`test/toolchain-contract-check.mjs` 使用显式的安装包／宿主路径，只做纯参数核验与临时产物／历史条件夹具，不加入默认产品测试依赖，不启动子代理。它对 E3 只提供条件解释，不验证实际历史事件已经修复；实际调查和边界阻塞保存在历史修复记录。
