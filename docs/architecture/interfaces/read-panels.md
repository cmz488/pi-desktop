# 会话只读面板契约

## 位置与职责

- `src/ui/shared/session-panel-loader.js`：两面板共用的会话身份、只读加载与资源生命周期，不拥有 Durable 状态。
- `src/ui/shared/branch-tree-panel.js`、`task-panel.js`：分别展示分支树与任务读模型，业务动作沿用既有命令路径。
- `src/ui/shared/extension-workbench.js`：为所有内置页更新上下文，包括当前未选中的页；只列可用入口。
- `src/ui/chat/chat.js`：传入选中会话与权限，在切换开始时立即使旧面板失效，在页面暂停／恢复时管理读取。
- `src/ui/shared/host-task-panel.js`：在全 Host 窗口中复用任务面板与加载器；每个实例额外固定 Agent／generation／owner scope，协议见 [Host 任务契约](host-tasks.md)。

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

taskStatusLabel(status); // 共用原生活跃态中文文案；未知值原样返回，不推断终态。
createBranchTreePanel({ fetchTree, command, toast, switchSession });
createTaskPanel({ fetchTasks, command, toast, currentSession? });
// 任务 command(input, { signal }?)：wait 必须遵守 signal；非 wait 不增加生命周期选项。
// 兼容旧空回执；原生单任务回执可含 task／abortStatus，提示语只读取原生终态。
// 返回 key/view/available、builtin.update/render、refresh、setActive、dispose；
// 分支树另有 setSession(id)，空字符串表示跟随当前会话。
```

工作台 `update(rows, context)` 的 context 为 `{ sessionId, capabilities, sessionCommands, taskCommands? }`；`builtin.update(context)` 必须先于可用入口过滤与渲染。读取的 `owner` 是页面当前会话，`sessionId` 是显示目标：任务面板跟随 owner，分支树可显式查看另一个目标。只读 loader 的调用方在 `setContext` 后负责同步重画；其返回值表示身份是否改变。

## 不变量

- 会话、显示目标、读能力或管理权限变化，立即清除旧数据／错误／确认并中止旧读取；A/B/A 是不同代际，不能仅比较会话字符串。
- 读取使用调用时捕获的目标。即使提供方忽略 abort，过期成功／失败也不能发布到新身份。
- 取消首次点击只确认；再次点击的确认必须属于同一代会话／任务目标，4 秒后撤销。旧 DOM 回调不可发送命令；命令已开始后的过期结果不可提示成功、刷新另一会话或改选分支。
- 同一身份补刷不清折叠、滚动与轮次按钮焦点；改变 owner／目标可重置其阅读状态。分支动作在每个节点标签内，当前位置只有 fork，历史只有 rewind；hover 与 focus 同等可用，触屏无需 hover。内置页入口是紧凑页签，不冒充“会话记录”；其他扩展页类型与生命周期不变。
- 任务面板以紧凑执行行区分名称、原生状态、标识／拥有者与操作；中止仍需两次独立点击，“确认中止”只缩短文案，不授予第二次执行资格。工具／子会话已有内容时不重复空任务说明。
- 工作台与 Host 共用原生回执提示：completed／failed／aborted／orphaned／faulted 分开显示，`marked` 只提示已请求中止、尚未确认终态。没有新回执字段的旧宿主保留泛化提示，不补造终态；任何提示仍受同一身份令牌校验。
- 嵌入聊天的首次状态就绪后，应用父窗口为同一 Agent／generation 保留的最新导航意图；首次默认会话通知不覆盖该意图。只接受同源父窗口，旧 iframe 不能改变当前窗口导航。
- 这是 UI 缓存与 affordance，不代替后端会话归属、权限、目标 409 或远程路径裁剪。

## 能力与权限

- `/api/state` 和 chat 视图的 `capabilities.sessionTree`／`tasks` 明确来自 Host 声明，不信任 snapshot 自填字段或方法是否存在；没有声明时为 false。
- 未声明能力不读取、不显示对应内置入口；读模型返回 `supported:false` 后同样隐藏，当前身份不持续探测；会话／能力变化重新判断。
- 只读宿主可查看声明支持的模型，但管理按钮使用原生 disabled 语义并给出原因。
- 管理动作要求调用方明确提供会话命令能力；任务的 `taskCommands` 可进一步收窄。任务控制器不笼统禁用所有 remote 操作，允许调用方提供其合法的本会话管理能力。
- 生产聊天页继续遵守现有远程网关：远程仍保留会话工作区与 `/api/abort` 等既有动作，不为面板放宽 `/api/command`；该路径被裁剪时不把任务管理按钮伪装可用。远程读模型不因此变成全局读模型。

## 顺序约束

1. 更新所有内置页上下文 → 过滤 available → 渲染选中页；用户开始选择另一个会话时不等待新快照才失效。
2. 管理动作捕获不可变目标 → 检查当前身份与权限 → 既有命令 → 仅在身份仍有效时提示与补刷。
3. `setActive(false)` 中止读取与任务等待观察并清补刷／确认／等待期限；恢复后显式 refresh。页面恢复缓存不复用旧令牌。
4. `dispose()` 幂等；之后不能读取、补刷或发布迟到结果。提供方应遵守 AbortSignal 以释放物理请求资源。

## 错误模式

- 当前读取失败保留错误供重试，不伪装成“没有任务”；过期或主动中止错误不显示。
- 返回目标与请求不符时显示“会话读模型目标不一致，请重新读取”，不采用该响应。
- 当前命令失败由面板提示，过期命令结果忽略；取消 HTTP 读取不等于取消 Durable 任务。
- 等待取消只停止观察，408 续租、5 分钟总期限与 45 秒连接超时均见 [任务契约](task-graph.md)；旧结果仍按同一身份令牌失效。
- 业务 HTTP 错误语义沿用 [任务契约](task-graph.md) 与 [分支树契约](session-tree.md)。

## 性能特征

每代身份最多一个在途读取、一个补刷定时器；普通刷新按 1500 ms 节流，密集通知合并为一次补刷，空闲时 force 跳过节流，在途时只合并一次补刷。unsupported 不形成轮询。关闭后迟到回调不能重启补刷。加载器只管理读模型；命令等待的生命周期见任务契约。

## 可执行证据

- `test/session-panel-loader.test.mjs`：9 条有界时钟／迟到响应回归，覆盖能力、A/B/A、权限、节流／补刷、暂停／销毁和错误。
- `test/read-panels-browser-check.mjs`：真实工作台和面板，覆盖背景取消确认跨会话失效、旧 DOM、晚到响应、A/B/A、同会话权限变化、折叠／滚动、unsupported／只读／可用远程回调和销毁；另验证细指针真实 hover、Tab／Enter、按钮焦点、busy 互斥、390px、触屏、减少动态效果及 SVG 实际底色上的双主题 4.5:1 文本对比度；另覆盖全部活跃态文案与未知态透传，图面 280–760px 裁剪、初始 460px 回退和无新数据时的 resize。
- `test/desktop-sidebar-navigation-browser-check.mjs`：初始与目标快照分别延迟时保留最后选择，过期代际、非父窗口及旧 Agent 窗口不改变当前导航；内外层选择与重载保持一致，归档分支说明与根整族恢复隔离。
- `test/read-panels-desktop-browser-check.mjs`：真实默认 Host／worker、完整聊天控制器与真实在途任务，覆盖快照返回前立即失效、延迟读模型、过期分叉结果、能力变化与会话栏入口隐藏，且未误取消任何任务。
- `test/long-task-wait-browser-check.mjs`：默认真实长任务的终态、取消／到期不误中止、续租不重置期限、旧成功不影响另一会话、焦点与定时器回收。
- `test/host-tasks-browser-check.mjs`：两个 worker 的同号 task、跨发起表单目标管理、关闭／快速重开失效、聚合更新保留键盘焦点；原生完成提示、回答条目编号，以及发起回执晚到不得抢走用户随后选择的任务。
- `test/bridge.test.mjs`：完整／chat 快照都只按 Host 声明返回读能力。
- `npm run test:extensions:browser`、`test:workspace:browser` 纳入上述浏览器证据；静态 module 统一经资产清单发布并由 `package:check` 验证。
