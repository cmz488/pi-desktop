# 会话只读面板契约

## 位置与职责

- `src/ui/shared/task-vocabulary.js`：任务标签、种类、投递失败与回执提示的纯展示规则，不拥有任务状态或 worker 生命周期。
- `src/ui/shared/client-policy.js`：共享读取／管理、只读、远程与就绪规则；见[客户端策略](client-policy.md)。
- `src/ui/shared/session-panel-loader.js`：两面板共用的会话身份、只读加载与资源生命周期，不拥有 Durable 状态。
- `src/ui/shared/branch-tree-panel.js`、`task-panel.js`：分别展示分支树与任务读模型，业务动作沿用既有命令路径。
- `src/ui/shared/extension-workbench.js`：为所有内置页更新上下文，包括当前未选中的页；只列可用入口。
- `src/ui/chat/chat.js`：传入选中会话与权限，在切换开始时立即使旧面板失效，在页面暂停／恢复时管理读取。
- `task-panel-management.js`：现有任务页内的当前会话发起草稿与实时详情；`task-detail-view.js` 提供纯文本结果／过程展示；`subagent-history.js` 为分支页提供独立只读终态记录。
- `src/ui/shared/host-task-panel.js`：保留的全 Host controller／module 兼容入口；清单复用任务面板，详情与会话内管理区共用只读 loader，不维护第二套请求身份状态机。Desktop 不再挂载独立任务弹窗，公开协议仍见 [Host 任务契约](host-tasks.md)。

## 签名

```js
createSessionPanelLoader({ read, onChange?, onReset? });
// read(sessionId, { signal }) -> Promise<读模型>
// onChange()：当前读取状态改变；onReset(reason)：identity/activity/dispose
// 返回：setContext、refresh、capture、isCurrent、setActive、dispose
// 只读属性：context、data、error、loading、available、canManage

loader.setContext({ owner, sessionId, enabled, canManage });
loader.refresh({ force = false } = {});
loader.capture();       // 不可变身份令牌；没有可用数据时为 undefined
loader.isCurrent(token);
loader.setActive(boolean);
loader.dispose();

taskStatusLabel(status); // 活跃态／终态行标签；未知值原样返回，不推断终态。
taskOutcomeLabel(status); // 仅解释任务终态。
taskDeliveryLabel(status); // 投递 pending 为“等待投递”，不同于任务 pending 的“排队”。
taskKindLabel(kind);
isMessageFailure(status);
hasMessageFailure(task); // 首次成功后的预算错误或未完成的后续消息。
taskReceiptLabel(task); // 默认标签不再依赖外部回调。
taskReceiptNotice(result, fallback); // 原生终态、marked、旧空回执分别提示。
createBranchTreePanel({ fetchTree, fetchHistory?, fetchDetail?, command, toast, switchSession, openCreatedSession? });
createTaskPanel({ fetchTasks, fetchDetail?, command, toast, currentSession? });
// 任务 command(input, { signal }?)：wait 必须遵守 signal；非 wait 不增加生命周期选项。
// 兼容旧空回执；原生单任务回执可含 task／abortStatus，提示语只读取原生终态。
// 返回 key/view/available、builtin.update/render/setVisible、refresh、setActive、dispose；
// 分支树另有 setSession(id)，空字符串表示跟随当前会话。
```

词汇函数可直接在 Node 中调用。`task-panel.js` 的 `taskStatusLabel` 与 `task-detail-view.js` 的旧词汇导出保留为同一 implementation 的再导出；`taskReceiptLabel`、详情及管理区仍接受旧的可选标签回调，但生产调用方无需注入。任务词汇不解释 worker 的启动／停止状态，标签不从消息状态猜测任务是否完成，后续失败也不修改首次结果。

同 owner、同内置页的更新复用已挂载容器，其他扩展卡片变化不重挂当前输入节点；身份变化仍先清空旧展示并使旧回调失效。内置页可为可重建控件声明稳定的 `data-workbench-focus` 键；工作台仅在同页、同 owner 的同步重绘后恢复该控件，不覆盖 renderer 已明确设置的新焦点。分支图临时重挂历史区时，历史 controller 在同一挂载身份恢复后补回焦点；离开或换目标使该恢复失效。

工作台 `update(rows, context)` 的 context 为 `{ sessionId, ready?, capabilities, sessionCommands, taskCommands? }`；`builtin.update(context)` 必须先于可用入口过滤与渲染。读取的 `owner` 是页面当前会话，`sessionId` 是显示目标：任务面板跟随 owner，分支树可显式查看另一个目标。只读 loader 的调用方在 `setContext` 后负责同步重画；其返回值表示身份是否改变。

## 不变量

- Desktop 的 iframe 按 Agent／generation／进程隔离；任务读写请求携带该 iframe 的 generation，经 Host 在转发前校验，不转发到新库同号任务。原 Host 管理 API 的必填目标门禁仍保留。
- 会话、显示目标、读能力或管理权限变化，立即清除旧数据／错误／确认并中止旧读取；A/B/A 是不同代际，不能仅比较会话字符串。
- 读取使用调用时捕获的目标。即使提供方忽略 abort，过期成功／失败也不能发布到新身份。
- 取消首次点击只确认；再次点击的确认必须属于同一代会话／任务目标，4 秒后撤销。旧 DOM 回调不可发送命令；命令已开始后的过期结果不可提示成功、刷新另一会话或改选分支。
- 同一身份补刷不清折叠、滚动与轮次按钮焦点；改变 owner／目标可重置其阅读状态。分支动作在每个节点标签内，当前位置只有 fork，历史只有 rewind；hover 与 focus 同等可用，触屏无需 hover。内置页入口是紧凑页签，不冒充“会话记录”；其他扩展页类型与生命周期不变。
- 实时页只展示当前会话及 owned 后代的非终态任务；终态子会话不继续占实时清单，已提交内容转由分支页独立的只读「已结束的子代理记录」读取，不冒充历史 fork。发起目标固定当前会话，没有跨 Agent 选择器。
- 发起表单在清单之前按需展开，折叠状态公开 `aria-expanded`／`aria-controls`，收起时焦点返回可见发起按钮。草稿与不确定提交尝试按 owner 隔离；同内容重试沿用冻结的 requestId 和内容。回执晚到不得覆盖随后改选的任务。
- 任务面板以紧凑执行行区分名称、原生状态、标识／拥有者与操作；任务名称直接打开详情，按钮的可访问名称保留可见的名称、状态与编号；等待／中止使用有名称与提示的轻量图标按钮，中止确认与取消等待仍有可见文字。中止仍需两次独立点击，“确认中止”不授予第二次执行资格。已在委托行展示的 owned 子会话不重复成卡片；在跑工具和其余子会话按需展开为执行活动。
- 任务页只有既有列表和详情区；选中行与任务名按钮同步，按钮以 `aria-expanded`／`aria-controls` 指向具名详情 region。列表补刷仍恢复同一操作的焦点；不为选择另建任务真相。宽度足够时并排阅读，按实际容器宽度转为单列，空清单不另显示无用的详情占位。外层页签与返回操作同排，不重复展示标题。
- 两页以 `aria-busy` 公开当前读取，失败保留先前内容并呈现错误，不把失败当作空态；成功重试清错。没有存量分支时摘要标明“当前会话”，存量族内记录称“原有分支”，不与新建独立会话混淆。
- 样式只使用现有语义 token；正常动作、选中、失败与终态仍含文字。触屏的动作、表单／披露及 SVG 轮次折叠热区至少 44px；轨道留白须容纳热区，不能以裁掉的透明框冒充触达尺寸。
- 工作台与 Host 共用原生回执提示：completed／failed／aborted／orphaned／faulted 分开显示，`marked` 只提示已请求中止、尚未确认终态。没有新回执字段的旧宿主保留泛化提示，不补造终态；任何提示仍受同一身份令牌校验。
- 嵌入聊天的首次状态就绪后，应用父窗口为同一 Agent／generation 保留的最新导航意图；首次默认会话通知不覆盖该意图。只接受同源父窗口，旧 iframe 不能改变当前窗口导航。
- 会话切换等待目标带 `messages` 的快照；旧事件、旧详情与过期成功／失败不能撤掉加载骨架。相同目标在途时合并重复意图；当前切换失败恢复原会话与外层选择，仍向使用者报错。首次读取同样显示骨架，包括停止会话的只读历史视图。
- 这是 UI 缓存与 affordance，不代替后端会话归属、权限、目标 409 或远程路径裁剪。

## 展示层次

输入框工具栏提供「工具 → pi-desktop 侧工具 → 子代理」快捷入口，打开现有「任务与子代理」页，不另建面板、不自动发起委托，也不注册、启停或调用模型工具；真实工具名仍为 `desk_subagent`。菜单向上展开并保持在视口内，支持键盘进入与选择、点击开关及点击外部关闭；Esc 关闭后焦点返回触发器。切换会话、权限变化、切换视图或窗口尺寸变化时关闭菜单，旧菜单回调不能改选新会话的页面；聊天草稿不受导航影响。

任务清单支持「全部／子代理／其他任务」与名称、类型、编号搜索，统计始终来自当前完整读模型；过滤只影响行的可见性，不改任务范围、选择、原生执行或正在等待的目标。筛选／搜索是只读交互，不使用管理命令，也不因只读模式禁用。身份变化重置筛选与搜索；普通补刷保留其内容、光标和焦点，搜索框的中文输入法组合期间延后重画，不打断组合；组合状态绑定当前输入节点，离开页面或节点失效后不冻结后续读取。

详情优先展示不可变首次回答；尚无首次回答时展示当前输出或委托内容，完整的本次过程预览收在原生披露组件中。过程披露及焦点在同任务更新时保持，切任务不继承另一任务的展开状态。消息失败与预算原因保持可见，失败消息默认展开，但不因定时补刷强行重开用户已收起的区域。终态记录采用同一详情展示规则；没有可展示输出时明确说明已结束，不再提示等待或承诺自动更新。过程与消息裁剪仍明确标注，不把预览当作全量。

## 能力与权限

聊天入口与面板通过同一 `readClientPolicy` 投影资格；切换期间明确传 `ready:false`，保留模式事实而不读取旧目标。策略只收敛公共规则，loader 的可见性、数据身份与业务确认继续额外收窄。

- `/api/state` 和 chat 视图的 `capabilities.sessionTree`／`tasks`／`taskDetails` 明确来自 Host 声明，不信任 snapshot 自填字段或方法是否存在；没有声明时为 false。
- `taskDetails` 额外控制内嵌实时详情、发起区与终态记录；不依据 fetch 回调存在推断。未提供该能力的兼容宿主仍可展示基础任务读模型。只读能力不授予 spawn／cancel。
- 未声明能力不读取、不显示对应内置入口；读模型返回 `supported:false` 后同样隐藏，当前身份不持续探测；会话／能力变化重新判断。
- 输入框的子代理快捷入口跟随任务页的可用性，仅在明确声明 `tasks` 的非远程会话展示；只读模式仍可导航，管理权限沿用任务页既有门控。远程不为该入口开放本地工作台或命令路径。
- 只读宿主可查看声明支持的模型，但管理按钮使用原生 disabled 语义并给出原因。
- 管理动作要求调用方明确提供会话命令能力；任务的 `taskCommands` 可进一步收窄。任务控制器不笼统禁用所有 remote 操作，允许调用方提供其合法的本会话管理能力。
- 生产聊天页继续遵守现有远程网关：远程仍保留会话工作区与 `/api/abort` 等既有动作，不为面板放宽 `/api/command`；该路径被裁剪时不把任务管理按钮伪装可用。远程读模型不因此变成全局读模型。

## 顺序约束

1. 更新所有内置页上下文 → 过滤 available → 渲染选中页；用户开始选择另一个会话时不等待新快照才失效。
2. 管理动作捕获不可变目标 → 检查当前身份与权限 → 既有命令 → 仅在身份仍有效时提示与补刷。
3. `builtin.setVisible(false)` 或 `setActive(false)` 撤详情／历史读取、提交 HTTP 等待和任务等待观察，并清补刷／确认／等待期限；不发送原生任务中止。恢复后显式 refresh，缓存不复用旧令牌；主任务读模型仍可更新内置页可用性。
4. `dispose()` 幂等；之后不能读取、补刷或发布迟到结果。提供方应遵守 AbortSignal 以释放物理请求资源。

## 错误模式

- 当前读取失败保留错误供重试，不伪装成“没有任务”；过期或主动中止错误不显示。
- 返回目标与请求不符时显示“会话读模型目标不一致，请重新读取”，不采用该响应。
- 当前命令失败由面板提示，过期命令结果忽略；取消 HTTP 读取不等于取消 Durable 任务。
- 等待取消只停止观察，408 续租、5 分钟总期限与 45 秒连接超时均见 [任务契约](task-graph.md)；旧结果仍按同一身份令牌失效。
- 业务 HTTP 错误语义沿用 [任务契约](task-graph.md) 与 [分支树契约](session-tree.md)。

## 性能特征

每个 loader 的每代身份最多一个在途读取、一个补刷定时器；普通刷新按 1500 ms 节流，密集通知合并为一次补刷，空闲时 force 跳过节流，在途时只合并一次补刷。unsupported 不形成轮询。关闭后迟到回调不能重启补刷。加载器只管理读模型；命令等待的生命周期见任务契约。可见的实时详情每 2 秒补刷，历史折叠时不读取，展开后按每页 20 条按需读取；不把历史拉回实时图。

## 可执行证据

- `test/client-policy.test.mjs`：声明／只读／远程／未就绪／unsupported 与显式 taskCommands 收窄；真实面板另验证门控、恢复与详情 unsupported 不再探测。
- `test/task-vocabulary.test.mjs`：任务／终态／投递的不同词域、种类、未知值、首次结果与后续失败、预算、marked／旧回执及旧导出的兼容；面板与真实 Host 浏览器回归继续验证调用路径。

- `test/session-panel-loader.test.mjs`：9 条有界时钟／迟到响应回归，覆盖能力、A/B/A、权限、节流／补刷、暂停／销毁和错误。
- `test/read-panels-browser-check.mjs`：真实工作台和面板，覆盖背景取消确认跨会话失效、旧 DOM、晚到响应、A/B/A、同会话权限变化、折叠／滚动、unsupported／只读／可用远程回调和销毁；另验证细指针真实 hover、Tab／Enter、按钮焦点、busy 互斥、390px、触屏、减少动态效果及 SVG 实际底色上的双主题 4.5:1 文本对比度；另覆盖全部活跃态文案与未知态透传、其他扩展卡片更新期间的真实中文组合／提交与切页后的组合状态释放，图面 280–760px 裁剪、初始 460px 回退和无新数据时的 resize。
- `test/desktop-sidebar-navigation-browser-check.mjs`：初始与目标快照分别延迟时保留最后选择，过期代际、非父窗口及旧 Agent 窗口不改变当前导航；A/B/C/B 的迟到失败不覆盖最新骨架，相同目标在途不重复 POST，当前失败恢复内外选择与可用输入；内外层选择与重载保持一致，归档分支说明与根整族恢复隔离。
- `test/conversation-timeline-browser-check.mjs`：等待目标时，旧工具／流式事件与排队重绘不改动骨架、不重绘旧消息；同时记录 100 条旧工具事件的处理耗时与 DOM 修改次数。
- `test/desktop-workspace-check.mjs`：真实停止会话的首次历史快照被延迟时仍显示骨架；设置分类连续切换保留表单节点，并记录耗时与子节点替换次数。
- `test/read-panels-desktop-browser-check.mjs`：真实默认 Host／worker、完整聊天控制器与真实在途任务，覆盖快照返回前立即失效、延迟读模型、过期分叉结果、能力变化与会话栏入口隐藏，且未误取消任何任务；输入框快捷入口保留只读导航，远程、未声明任务能力及 unsupported 时隐藏。
- `test/desktop-remote-browser-check.mjs`：真实 HTTPS 远程页面在会话切换／重载后，320／360／390／430px 均隐藏本地工具入口。
- `test/long-task-wait-browser-check.mjs`：默认真实长任务的终态、取消／到期不误中止、续租不重置期限、旧成功不影响另一会话、焦点与定时器回收。
- `test/host-tasks-browser-check.mjs`：两个 worker 的同号 task 隔离、当前 owner 固定、表单草稿、不确定回执的冻结内容重试与真实去重、迟到发起不抢选中任务、等待／二次中止确认、切 Agent 不误中止、结果与 390px。
- `test/subagent-workbench-browser-check.mjs`：输入框工具分类与键盘／真实指针导航、Esc 返回焦点、聊天草稿与模型工具配置不变、无自动发起、触屏 44px 菜单及窄屏工具栏边界；无独立侧栏入口／弹窗、现有唯一任务面板内发起和详情、原生 owned 名称、终态实时／历史分流，以及切页撤详情和等待观察、创建折叠／焦点、实际透明表面的双主题 4.5:1 文本对比度、390px 详情／表单占满栏宽、44px 触达目标、只读历史选中后焦点保持，以及详情仅溢出标记变化的更新；另验证任务名 Enter 打开详情、选中控制关系、类型筛选与编号搜索、中文组合输入时实际 HTTP 补刷不替换输入、过程披露／焦点保持、顶部表单的控制关系、375px 与横屏无溢出、真实 HTTP 读取后注入延迟／503 的加载／错误／恢复，以及真实终态后的单一空态、首次输出前中止的历史说明与任务名按钮的浏览器无障碍树名称。`test/subagent-history.test.mjs` 验证分页与权限。
- `test/bridge.test.mjs`：完整／chat 快照都只按 Host 声明返回读能力。
- `npm run test:extensions:browser`、`test:workspace:browser` 纳入上述浏览器证据；静态 module 统一经资产清单发布并由 `package:check` 验证。

子代理回执区分首次委托与后续消息：任务历史标签、详情和管理回执提示不能仅以首次 completed 表示全部成功；消息原生状态、预算错误与裁剪标记沿用 [Host 任务契约](host-tasks.md)。`test/subagent-workbench-browser-check.mjs` 实际查看 followUp 耗尽预算后的历史标签、消息未回答原因和仍保留的首次答案。
