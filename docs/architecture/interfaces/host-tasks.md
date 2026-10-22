# 全 Host 任务与子代理契约

## 位置与职责

- `src/control-plane/host-tasks.mjs`、`supervisor.mjs`、`server.mjs`：聚合已运行 worker 的原生任务视图，转发有固定目标的命令。
- `src/agent/managed-subagents.mjs`、`agent-workspace.mjs`：组合 Pi Durable 的 task（持久状态机）、owned conversation（被任务拥有的会话）和 submission（会话工作准入）。
- `src/agent/durable-resources.mjs`：为受管 owned 会话绑定自己的 Pi 原生资源与工具 scope。
- `src/server/durable-server.mjs`：worker 的读取、权限与既有命令适配。
- `src/ui/shared/task-panel.js`、`task-panel-management.js`：直接整合在现有「任务与子代理」页的当前会话管理；`subagent-history.js` 在「对话分支」单列只读终态记录。旧 `host-task-panel.js` module 与 Host HTTP 保留兼容，不再挂载独立弹窗。

范围是此 Desktop Host 管理的 worker 中的 Durable task，不是全系统进程或旧 CLI 子代理记录。提供给模型的内置扩展工具及其 owned 范围见 [子代理工具契约](subagent-tools.md)。

## 签名

### Host HTTP

```js
GET /api/host/tasks
// -> { supported:true, partial:boolean, workers:[{
//   agentId:string, generation:number, name:string, projectId:string|null,
//   status:string, data:WorkerMonitor|null, error?:string
// }] }

POST /api/host/tasks/command
{
  agentId, generation, conversationId, // 三项必需；外层 UUID、存储代际、内层数值会话
  command: "subagent.spawn" | "wait" | "cancel",
  // spawn: requestId、prompt 必需；name、config 可选
  // wait/cancel: taskId 必需；cancel 也可改用 background:true，不与 taskId 并用
}
// -> 原生命令回执 + { agentId, generation, conversationId }
// wait(taskId): 追加原生 task 终态快照；cancel(taskId): 追加 abortStatus 与 task 快照

GET /api/host/tasks/detail?agentId=...&generation=...&conversationId=...&taskId=...
// -> { supported:true, task, children, hasMoreChildren, previewLimits }
```

所有数值 ID 和 generation 均为非负安全整数；POST 不接受数字字符串。UUID 必须是此 Host 的受管 Agent，不能用历史 Pi TUI 记录代替。Host 管理入口仅本地可用，远程请求为 403；不扩大原有远程 `/api/command` 的范围。

`WorkerMonitor`：

```js
{
  supported:true,
  capabilities:{taskInspection:boolean,manageTasks:boolean,spawnSubagent:boolean},
  scheduling, recovery,
  conversations:[{id,name,idle,parent,owner,managed,scopeId,model?,tools?}],
  tasks:[{id,conversationId,scopeId,name,kind,status,background,owner,
          ownedConversations,waitingOn,phase,abortRequested,schedulerState,blockedReason}],
  tools:[{conversationId,scopeId,callId,name,status}],
  models:[/* 已配置模型的公开摘要，不含凭据 */],
  submissions:[{id,conversationId,status,type}],
}
```

- `scopeId:number|null` 是沿原生任务所有权可管理该对象的 Desktop 会话；未绑定时为 null，只展示、不伪造管理能力。历史 `parent` 不授予任务权限。
- `status`、`owner`、`waitingOn`、`ownedConversations` 和 scheduler 状态来自 Durable。`name` 仅为本适配的子代理任务名称，其他 task 为 null。`blockedReason` 沿用原生代码，无阻塞为 null。
- worker 未运行或读取失败时 `data:null`；这不表示“无任务”或“任务已结束”。单个读取失败产生局部 error 与 `partial:true`，不吞掉其他 worker 的结果。
- 能力必须由 workspace 显式声明；worker 再受其只读策略收窄。不从方法存在、读模型自填字段或 UI 推断权限。

### 子代理发起

```js
{
  command:"subagent.spawn", agentId, generation, conversationId,
  requestId:string,                 // 非空，最多 200 个 UTF-16 code unit
  prompt:string,                    // trim 后非空，最多 512000 个 UTF-16 code unit
  name?:string,                     // 最多 120；空白或省略为“子代理”
  config?:{
    model?:{provider,modelId},
    thinkingLevel?:string,
    instructions?:string,
    tools?:string[],
    maxTurns?:number,
  },
}
// -> { id:父会话ID, taskId, agentId, generation, conversationId }
```

配置经既有 Pi 模型／工具／指令校验；省略时使用原生配置继承。不能覆盖 cwd、shellEnv、shellPath 或 extensions。原生配置继承不等同于复制父会话历史，不自行推导父上下文。POST 仍受 worker 现有 768 KiB JSON 传输上限约束。

准入校验成功后，同一父会话、requestId 和规范化内容复用持久 task 回执，包括终态；同一 requestId 换内容为 409。新的明确发起应使用新 requestId。同一顶层会话的整棵 owned 委托树最多 16 个未终结的适配子代理 task，最多嵌套 3 层；达到上限拒绝，不创建自有排队系统。`config.maxTurns` 默认 64，可设为 1–256，限制子会话累计模型回合，压缩与重启不重置；耗尽时原生停止；首次尚未回答则 failed，首次已回答则保留其原生结果，后续失败与预算原因单列，不能以首次完成代替后续消息完成。

`subagent.spawn` 是本应用通过公开 `defineTask`／`tx.createConversation`／`submit` 组合的最薄业务适配，不是上游现成的同名方法；不自建执行器或调度状态。发起回执只表示持久任务已创建，不表示执行成功。任务为 background，不阻塞父会话前台空闲；结果和过程在 owned 子会话与 task 原生回执中读取，不自动再调用父模型。

### 详情与 workspace

`task` 包含 `{id,conversationId,kind,status,outcome}`；`outcome` 未决定时为 null，否则为原生 `status`、可选 `error.message`、`reason`，以及本适配的 `result`。本适配完成结果含子会话 ID、submission ID、准入终态、`answerEntryId` 和最多 12000 个 UTF-16 code unit 的 answer 预览；新结果的 `answerUnits` 与 `answerTruncated` 明示完整长度与裁剪，模型工具 result 支持按该原生回答分段读取全文。答案与原生 submission 已决定的不可变 `answer` 条目绑定，`answerEntryId` 标识该回答；不会以当前上下文的最后一条助手消息替代，完整已提交记录保留在 Durable 子会话。旧版已持久化结果可以没有 `answerEntryId`，读取不能为补字段重放工作。

本适配的安全回执另含 `messageResults`（最近 20 条投递的原生 submission 状态）、`messageResultsTruncated`，并可有 `budgetError:{message}`。各消息包含投递 task ID、submission ID、模式、状态、可选回答编号与失败原因；不返回正文、原始输入或检查点。没有 submission 时不伪造执行成功；只有投递任务本身的 pending／失败等状态。主 outcome 与 answer 仍只代表首次委托，后续状态是只读投影，终态／重启后的所有读取与管理入口一致。完整规则见[子代理工具契约](subagent-tools.md)。

`children` 只含该 task 拥有的子会话：`{id,name,idle,model,usage,messages,partial,tools,messagesTruncated,toolsTruncated}`。这是展示预览：最多 20 个子会话、每会话最近 80 条消息与最近 40 个工具记录；每条消息文本保留前 12000 个 UTF-16 code unit，流式片段与工具输出保留尾 12000。`previewLimits` 明示这些上限，`hasMoreChildren`／truncated 字段报告裁剪。它不修改原生转录或模型上下文。

```js
workspace.capabilities;              // 冻结的显式能力对象
workspace.monitor();                 // WorkerMonitor
workspace.taskDetail(id, taskId);     // 同一 owned 范围内的详情，含终态
workspace.subagentHistory(id, {before?,limit?} = {}); // 按 id 降序的 owned 终态记录
workspace.setOwnedPreparer(prepare);  // 内部资源适配；prepare(active) -> Promise
workspace.execute("subagent.spawn", {id,requestId,prompt,name?,config?});

createManagedSubagents({createChild,prepareChild,beforeRequest,failureReason,spawn,read,result,message,list,wait,abort}); // -> {extension,task,messageTask}
// createChild(tx,task) -> 子会话ID；须在原生事务中创建 owned 关系与应用元数据
// prepareChild(id,config,context) -> Promise；资源绑定必须可重入
```

新增本地 `GET /api/subagent-history?sessionId=...&before=...`：`{supported:true,sessionId,records,nextBefore}`，records 为本适配原生 terminal task 的安全回执，按 task id 降序；默认每页 20，`before` 为上一页界限，结束时 `nextBefore:null`。仅沿 owner 范围，不沿历史 parent；不重放任务，不返回任意 task input／checkpoint。workspace 的 limit 可设为 1–50，HTTP 固定默认页长。需显式 `taskInspection`，未声明返回 unsupported；remote 返回 403，非法 before／limit 返回 422「子代理历史范围无效」。

worker 内部提供 `GET /api/task-monitor` 与 `GET /api/task-detail?sessionId=...&taskId=...`。它们同样拒绝远程全 worker 读取；未声明检查能力时返回 `{supported:false}`。发起、等待与中止继续复用既有 `/api/command`，未知 task 与越界目标均为 404。

Desktop 整合面板的 `/agents/<agentId>/api/tasks`、`task-detail`、`subagent-history` 和任务命令请求均带 iframe 固定的 `generation` 查询值；Host 转发前同时校验目录和实际 worker 代际，过期为 409，无效值为 422，不会读取或中止新库同号 task。未提供该参数的原公开 worker URL 保持兼容；原 Host 管理 API 的必填 generation 门禁不变。

界面默认先显示任务清单，发起表单按需展开并保留草稿；展开／收起不开始或中止任务。桌面清单与详情并列，窄屏纵向阅读。结果按原生 outcome、子会话、消息角色与实时片段分区，以纯文本写入 DOM；终态、工具名及预览裁剪标记仍可见。历史标签、详情和等待提示会注明后续消息未完成；详情单列消息处理状态与预算原因，同时保留首次不可变答案。图不变也读取新片段；相同详情不重建 DOM，更新保留阅读位置，失败后同内容的成功读取可恢复显示。有 `answerEntryId` 的回执在详情显示原生回答编号；旧结果没有该字段时仍正常展示，不重放补齐。发起成功默认选择对应原生任务，但若用户在等待发起回执时已显式改选查看目标，晚到回执不得抢回选择或取消新详情读取。

## 不变量

- 单任务等待透传原生终态，中止区分原生 `marked` 与 `terminal`；HTTP 成功、中止请求被接受或任务离开实时图都不等于执行成功／已经中止。详情与命令使用同一安全投影，不发布原始输入、检查点或非本适配任务的任意 result。
- Durable 是任务、submission、终态、所有权及恢复的唯一真相；Host 仅聚合视图和转发，不维护另一份任务状态或调度队列。
- 每个 Desktop Agent 仍只有一个 worker／SQLite／writer；子代理与历史分支都是其内部会话，不创建额外 Desktop Agent 或数据库。
- 管理范围只沿 `owner.conversationId` 扩展，历史分叉 `parent.conversationId` 不产生权限。
- 管理目标包含存储 generation，并在实际进程转发处再次校验；旧库同号 task 不能控制新库。任务数字 ID 不能跨 worker 裸用。
- owned 会话与原生任务检查点原子提交；submission 使用稳定 requestId。原生运行、重放、调度、工具循环和自底向上的取消全由 Durable 承担。
- owned 资源 scope 不借用父会话工具闭包；恢复时也先注册该 scope。所有写入仍遵守父 worker 的项目与权限边界。审批策略随父配置继承，子会话确认在父界面标明来源，交互读取与回答同样只沿 owner 范围。
- 关闭、隐藏、取消等待、超时或断连只释放观察，不推断工作已停止；中止必须显式提交原生取消命令，终态仍按原生回执区分 completed／failed／aborted／orphaned／faulted。

## 顺序约束

1. 资源适配在 `initialize(workspace)` 中注册，先于 Harness resume；已有受管 owned 会话同样在恢复前绑定资源。
2. 发起先校验并持久准入，再显示 task；对不确定的 HTTP 回执重试相同 requestId，不换 ID 重发工作。
3. 等待直接转发，不占 Host 配置串行队列；观察租约、配额与取消语义沿用[任务契约](task-graph.md)。
4. 整合工作台的详情只在可见时补刷；任务范围固定当前会话与 owned 后代，不再提供全 Host 目标切换 UI。切页、切 Agent、隐藏或销毁都撤旧观察；返回重新读取，不复用旧身份。公开 Host 请求的 Agent／generation／scope 固定校验仍保留。
5. worker 有后台／owned 工作时，启动不能仅因前台 `idle:true` 就覆盖共享配置。

## 错误模式

| 条件                                                           | 结果                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| 非 JSON 对象或 JSON 格式无效                                   | 400                                                      |
| 目标、ID 类型、请求或配置无效                                  | 422                                                      |
| Agent／会话／task 不存在，或 task 越过 owned 范围              | 404                                                      |
| worker 未运行、存储 generation 变化、requestId 内容冲突        | 409                                                      |
| 只读管理或远程全 Host／worker 访问                             | 403                                                      |
| 委托树未终结子代理达到 16／嵌套达到 3 层；原生等待观察配额已满 | 429                                                      |
| JSON 传输超限                                                  | 413                                                      |
| Host 管理／详情连接期限到达                                    | 504，不据此中止工作                                      |
| 原生等待租约到期                                               | 408；只续当前观察，不重发子代理                          |
| 单 worker 检查失败                                             | Host GET 仍为 200，但该行 error、data:null、partial:true |

原生执行失败写入 task outcome；不把 unanswered 记为 completed。SDK 运行错误与正常的 HTTP 准入错误分开，不因列表中暂时没有 task 就生成成功回执。

## 性能特征

- 聚合最多并行读取四个 worker，每个读取／详情连接 5 秒；普通管理 12 秒、等待 45 秒。客户端断连向上游传播 AbortSignal，批次间检查取消。
- 聚合读取只访问已运行进程，不做启动、模型调用或真实 CLI 子代理探测。成本随 worker、原生会话和 task 数增长。历史页使用原生扫描，成本随本适配历史任务数增长；分页限制响应与 DOM 数量，不宣称存储层只扫描一页。
- 可见的详情每 2 秒刷新；共用加载器合并在途读取和一次补刷。关闭、隐藏或销毁后释放读取、等待、确认和定时器；每个任务面板最多一个等待，总预算 5 分钟不因 408 重置。
- 详情最多一个在途读取；任务图 ETag 不变仍刷新所选原生过程片段，不把图未变当作输出未变。详情投影有上述展示上限，完整存储与模型上下文不受该窗口预算影响。

## 可执行证据

- `test/host-task-management.test.mjs`：真实 Host／worker HTTP 聚合、幂等、owned 关系／单 writer、失败与终态回执、等待断连、非串行观察、权限／非法与越界目标、重启与原生工具 scope、单 worker 暂停的局部超时。
- `test/host-tasks-browser-check.mjs`：两个 SQLite 的同号 task 隔离、当前会话与 generation 固定发起、草稿／冻结请求重试、原生去重与迟到回执不改选、等待／中止、切 Agent 不误中止及 390px。
- `test/subagent-reliability.test.mjs`：审批继承与停机权限变更、交互范围、终态资源回收与预算限制。
- `test/subagent-history.test.mjs`：21 个真实终态委托的 20＋1 分页、fork 不继承 owned 权限、remote／非法界限拒绝、旧 generation 读取／管理拒绝、无效 generation 为 422，且不重放模型。
- `test/subagent-workbench-browser-check.mjs`：现有唯一任务页的详情／发起、终态转独立历史区与切页撤观察。
- `test/durable-task-graph.test.mjs`、`test/task-waits.test.mjs` 与 `test/long-task-wait-browser-check.mjs`：复用的所有权、租约与等待生命周期。
- `test/boundary-contracts.test.mjs`：追加的 workspace／supervisor 接口和命令形状。
- `npm run test:workspace:browser`、`npm test`、`npm run check`、`npm run package:check`。
