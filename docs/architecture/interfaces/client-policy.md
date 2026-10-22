# 客户端能力策略

## 位置与职责

`src/ui/shared/client-policy.js` 的 `readClientPolicy` 为聊天入口、任务、分支、实时详情和子代理历史提供同一份展示／操作资格规则。它是纯浏览器 module，Node 测试也跨同一 interface 调用；公开 `/client-policy.js` 由统一资产清单发布。

它不读取会话、不持有 loader、不执行命令，也不替代 [Host interface](host-interface.md) 的能力声明、项目可信校验、会话归属或远程路由。

## 签名

```js
readClientPolicy({
  sessionId,
  ready?,                 // 缺省兼容已有调用方；false 明确表示新目标未就绪
  capabilities?,          // Host 显式声明，不能由回调存在推导
  sessionCommands?,
  taskCommands?,          // 缺省回退 sessionCommands；显式 false 不能被覆盖
} = {}, { supported? } = {});
// -> 冻结的只读对象：
// ready, remote, readOnly, supported,
// canReadTasks, canManageTasks, canReadTaskDetails, canReadSubagentHistory,
// canReadBranches, canManageBranches, canOpenTaskWorkbench,
// canViewSettings, canCompose
```

`sessionId` 可以是字符串或数值（包括 `0`）；空／缺少 ID 不表示就绪。`supported` 是当前读模型的回应；未读时可省略，以便对显式声明进行首次探测。

## 不变量

| 条件                                         | 规则                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| 未声明 `tasks`／`sessionTree`／`taskDetails` | 对应读取不可用，不以其他声明或函数存在代替                                     |
| 目标未就绪／没有会话 ID                      | 不读取、不管理、不提交旧目标；仍保留 remote／readOnly 模式事实                 |
| 当前读模型 `supported:false`                 | 当前面板的读取与管理不可用；不据此关闭独立的原生聊天入口                       |
| 只读                                         | 已声明的查看、筛选与聊天保留；任务和分支管理禁用                               |
| 远程                                         | 基础任务／分支读取保留；本地详情／终态历史、分支管理、本地工具入口和设置不开放 |
| 直接宿主允许远程管理本会话任务               | 不以通用 remote 判断误禁；仍需任务读取与明确命令能力                           |
| 网关显式 `taskCommands:false`                | 即使 `sessionCommands:true` 也不能管理任务；不放宽 `/api/command` 路由         |
| 原生历史视图                                 | 不提供 composer；不把只读历史当成可续写会话                                    |

消息菜单已有原生会话命令能力时，不要求先读取整棵树才能分支／退回；面板仍通过 loader 的可用数据与不可变身份校验执行。终态历史必须同时有 `taskDetails` 和 `sessionTree` 声明，并保留必要 fetch 实现的存在性检查；检查函数存在只防止错误调用，不产生能力。

策略不覆盖更窄的业务资格：连接、活跃／可见状态、已加载数据、等待租约、确认、项目可信、原生空闲门禁、字段校验和服务端 permitted actions 仍由各自所有者收窄。只读不是“不能发消息”；同样，能看到按钮不是后端授权。

## 顺序约束

1. 聊天入口先计算选中目标与是否已有该目标快照，再投影策略；切换期间使用 `ready:false`，不通过抹去模式事实模拟失效。
2. 面板以无回应时的策略设置 loader 的声明资格；不要把某次 `supported:false` 写回 capability 或反复切换 loader.enabled，否则会重新探测同一 unsupported 身份。
3. 读模型的 unsupported、loader.active 与数据令牌共同决定最终可用性；管理回调仍在执行前再次核对当前身份。
4. 调用方显式收窄先于执行；策略不能通过 fallback 把 false 变成 true。

## 错误模式

纯函数不抛业务错误、不发网络请求。当前读取错误仍由 loader 展示，后端的 403／404／409 与参数语义不变。详情返回 `supported:false` 时明确提示未提供详情，不把它当作 task、空成功或原生终态，不形成补刷循环。

## 性能特征

常数规模的同步只读投影，无缓存、计时器或监听器。调用方不共享可变策略状态，不增加会话操作前的 await。

## 可执行证据

- `test/client-policy.test.mjs`：未声明、数值零、只读、远程直接宿主与网关收窄、未就绪、unsupported、独立读取声明与冻结结果。
- `test/read-panels-browser-check.mjs`：真实公共 module 与 DOM，验证只读／远程、显式命令收窄、同目标未就绪撤入口／读取、恢复不恢复管理，以及详情 unsupported 的明确提示与停止探测。
- `test/read-panels-desktop-browser-check.mjs`：真实 Host／worker 的切换、迟到读模型、权限变化、入口与 toolbar 门控。
- `test/host-tasks-browser-check.mjs`、`test/subagent-workbench-browser-check.mjs`、`test/durable-browser-check.mjs`：兼容 adapter、真实等待／中止／发起与工作台操作。
- `test/chat-views-browser-check.mjs`：设置目标、草稿、迟到结果与 IME；远程专项保留原路由门禁。
- `npm test`、`npm run check`、本次文件格式与 `npm run package:check`。
