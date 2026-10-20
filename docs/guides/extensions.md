# 扩展卡片与注册

Pi 继续负责扩展加载、工具执行、权限和会话 JSONL。Desktop 的 `extension-adapters.mjs` module 集中处理消息匹配、卡片规范、摘要、展示位置和去重。时间线与页面不识别插件 ID，也不处理 Goal 私有字段。

简单扩展在工具结果或自定义消息的 `details.piDesktop` 声明 v1 卡片，无需注册 UI 代码：

```json
{
  "piDesktop": {
    "version": 1,
    "label": "构建",
    "title": "发布检查",
    "status": "进行中",
    "body": "已通过编译，正在检查产物。",
    "progress": { "value": 1, "total": 2 },
    "items": [{ "label": "编译", "status": "已完成" }],
    "metrics": ["12 秒"],
    "detailsLabel": "查看检查项",
    "presentation": { "mode": "state", "key": "my-extension/build" }
  }
}
```

省略 `presentation` 时，卡片随原消息保留；`mode: state` 时按 Agent 会话、adapter ID 和 `key` 仅展示最新状态。会话内的卡片统一显示在对话右侧的扩展栏，不再插入消息流；工具结果仍保留摘要。`key` 必须以扩展名区分，防止通用卡片之间重名。切换会话不会沿用其他 Agent 的卡片；流式重绘从当前已加载分支选取状态，展开项保持展开。`detailsLabel` 可选，声明后将正文和条目放入折叠详情。文本作为纯文本转义，不接收 HTML。条目最多 40 个、嵌套深度最多 4、指标最多 8 个；进度约束到有效区间，未支持的版本回退到原消息。

扩展栏只是同一份消息投影的第二个展示位置：普通卡片与最新状态卡都在里面；窗口宽度不足 1000px 或工具侧栏展开时隐藏，避免压缩对话到最小宽度（详情仍在工作台）。它不另建数据源、命令通道或执行生命周期。

## 扩展工作台

从顶部「扩展」或项目导航「扩展工作台」进入当前会话的详情页。使用同一声明，无需插件增加路由：普通卡片保留独立记录，state 卡片只保留最新状态，工具内仍显示摘要。工作台只读取当前已加载分支，最多显示 80 页，不代表全局插件清单；没有卡片时可转到「管理扩展」。终端专用 TUI 控件不会自动变成网页。

选中页面与展开状态在同会话更新时保留，切换会话即隔离重置。完整内容按需通过原来的消息详情接口读取；失败可重试。既有受信任 renderer 接收 `context.placement === "page"` 和独立的 `disclosures` Map，不应把它当成新的执行生命周期。页面 HTML 经过 DOMPurify，通用声明仍为纯文本。

## 内置页面：对话分支

工作台内置「对话分支」，无需另装插件。SVG 按对话轮次聚合原生日志，明确活跃／已放弃路径与唯一「当前位置」；默认最近 10 轮，可在面板调整展示窗口，不修改完整上下文。

- **当前位置才能创建分支**；历史轮次只提供退回，再从新的当前位置创建分支。忙碌时可使用原生快照分支，不能退回；命令仍走既有接口。
- 展开、折叠、选择与滚动在同会话补刷后保留；鼠标、键盘与触屏均可操作。
- 从会话栏进入可查看指定会话，并可「跟随当前会话」。未绑定原生记录时只读展示 Durable 信息与原因。
- **已结束的子代理记录**在独立折叠区按需分页，只读查看原生答案、消息及结果。它不是历史 fork，没有创建分支／退回动作。

## 内置页面：任务与子代理

任务管理直接整合进工作台原有「任务与子代理」，不再提供左侧独立「任务监控」入口或弹窗。

- **实时清单**：仅当前会话及其 owned 子代理的非终态任务，展示名称、原生状态、拥有关系、后台标记与在跑工具。已结束子代理移至「对话分支」的独立记录区。
- **实时详情**：点击「查看」，在同一面板查看子代理消息、工具过程与流式片段。预览可能裁剪，完整内容仍保留在原生会话。
- **新建子代理**：按需展开名称／任务说明；高级选项可选模型、思考级别、指令和工具。目标固定当前会话，草稿随会话隔离；不确定回执可用同一尝试重试，不重复发起。
- **管理操作**：「等待」只观察；「中止」两步确认，第二次才发命令。「中止后台」只请求中止带后台标记的工作。回执 `marked` 仅表示已请求，不等于已经结束；完成、失败、中止分别按原生终态显示。
- 切页、隐藏、断连或取消等待只撤观察，不停止子代理。只读宿主不提供写操作；详情和历史需要宿主显式能力，远程不扩大已有命令范围。

### 模型可调用的内置扩展

Desktop 的 Durable Agent 内置 `desk-subagents`，向模型公开 `desk_subagent`，不是 CLI 包装或第二个执行器：

```js
{action:"spawn", prompt:"检查边界并汇报", name:"边界检查"}
{action:"message", taskId:123, message:"补充检查只读权限", mode:"steer"}
{action:"read", taskId:123}
{action:"list"}
{action:"wait", taskId:123}
{action:"abort", taskId:123}
```

模型调用身份固定为当前原生 invocation，只能管理其 owned 范围，不能指定别的 Agent。message 默认 steer，在原生轮次／工具边界生效，不立即打断当前工具；也可选择 followUp。终态任务不能借 message 复活，请新建委托。原生调度、恢复、模型循环与任务存储都由 Pi Durable 承担。完整参数及限制见 [子代理工具契约](../architecture/interfaces/subagent-tools.md)。

## 目标操作面板（pi-goal-x）

内置 `pi-goal-x` 适配器声明一个 `panel`（id、label、title、tools、aggregate、render），扩展工作台把它固定在页面列表顶部，并过滤掉该 adapter 的逐卡片页面。目标工具结果、事件、验收和起草不再作为散落卡片出现在会话栏或工作台列表中；会话消息流中被该面板声明的工具调用也不再重复展开。

面板集中呈现：

- 目标标题、状态、任务进度、用时和 token；
- 操作：新建目标／有序目标、暂停／恢复（直接发送已有 `/goal-*` 命令）、完成并验收、调整计划、清除目标（后三者填入输入框，由用户确认发送）；
- 任务树；每个任务可生成一条“标记完成／重开”的 Agent 请求；
- 最近一次独立验收的状态、审计模型与报告；
- 最近目标状态事件。

五个工具的分工在面板中落地为：`create_goal` → 新建操作；`get_goal` → 面板读取当前快照并刷新；`update_goal` → 暂停／恢复／完成验收；`set_goal_tasks`／`update_goal_task` → 任务树与逐任务请求。实现仍走既有 `/api/prompt` 和 composer，不新增插件运行时、调度器或旁路数据接口。

面板 HTML 经同一 DOMPurify 边界；按钮只暴露受限的 `data-panel-action`／`data-panel-value`，工作台校验后转交宿主处理，适配器不直接执行脚本。面板按 goal id 关联验收与事件，切换目标或会话后不会把旧目标的验收报告混到新目标上。

## 受信任的本地适配器

复杂展示继续兼容 `register({ id, version, project, render })`。`project(message)` 返回视图；`render(view, context)` 返回 HTML，原有单参数 renderer 可继续使用。适配器可选声明 `panel: { id, label, title, tools, aggregate(views), render(view, context) }`：`tools` 列出由面板接管的工具名，`aggregate` 把同一 adapter 的视图合并成一页；声明后工作台不再为该 adapter 生成逐卡片页面。module 的 `summary(view)` 负责工具摘要，`layout(messages, {sessionId})` 负责普通消息与状态卡片分流；页面只消费结果。通用卡片和 Goal 共用同一 renderer，新增插件优先使用上述 schema。

注册返回幂等 disposer；可选 `onRegister()` 返回清理函数、`onSessionChanged(next, previous)` 接收会话变化，注销或 `dispose()` 时调用 `onDispose()`。清理绑定每次注册的独立身份，同 ID 重注册后旧 disposer 无效；清理抛错不阻止其他注册释放。当前内置 adapter 都是纯投影，会话通知不会停止其他 Agent；本轮不引入命令调度或动态插件代码加载。

内置 `pi-goal-x` 适配其目标工具的 `details.version: 3` 快照、`pi-goal-event`／`pi-goal-audit-event` 消息，以及 `pi-goal-draft` 起草记录和原生 Goal widget。目标和起草状态共用同一会话状态卡片；清除草稿后不再显示旧记录。widget 通过 Pi 的渲染接口获取有界纯文本，不依赖工具是否被调用，重新进入会话也能看到当前目标。

`src/agent/native-runtime.mjs` 将原生扩展的 `sendUserMessage`／`sendMessage` 交给所选 Durable Agent。Pi 继续负责 Goal 的起草、确认、任务、审计与自动续跑；Desktop 转发请求上下文、轮次结束和真正空闲后的生命周期事件，不另写 Goal 调度器。用户中止使用整次运行的取消信号，不能把请求阶段切换误当成用户取消。原生资源 Session 禁止运行聊天模型循环；插件显式创建的独立 Pi Agent（例如完成审计）保留共享模型配置。

`/goal` 首先显示起草状态并开始澄清；提案通过 Pi 的 select/input 回退界面等待明确确认。确认后自动执行，`/goal-pause` 或停止操作暂停，`/goal-resume` 显式恢复。项目外只读会话不加载这些项目扩展。已运行 Host 返回的旧 Goal 视图仍在展示 module 内转换。

接口结构参考 DeepSeek Harness 的 Cordis 生命周期：模块进入、切换与释放时清理自己注册的副作用；Desktop 仍保留 Pi 扩展 API 与原生任务链，不把 Cordis 运行时引入 Agent。新增专用适配前优先使用通用卡片 schema；确有复杂交互时才注册对应 projector/renderer。

原生扩展运行与 UI 卡片的所有权见 [架构说明](../architecture/README.md)。
