# 子代理工具与现有工作台整合验收

## 范围与固定输入

本轮接续 `90b2b1f6ec7eb633fe32f5dc7df66c6dbc046b79`，按用户确认的模型工具调用、公开 HTTP 与真实 Chromium seam 开发；所有运行数据、provider、项目、SQLite 和浏览器 profile 均为临时夹具。

用户要求直接整合已有「任务与子代理」，不是增加任务页面或只迁移入口；实时范围为当前会话及 owned 后代的非终态任务，终态记录放在「对话分支」独立只读查看。内置管理工具必须由模型实际调用，不能包装 CLI 或自行实现调度器。

本记录提交前的功能验收固定于：

- HEAD：`917c6e2297db9af2ce5d56235fca9dae4335c6a0`。
- tree：`ff8a8f6f09bdb2a3b22a812236281f4e4b5a1996`。
- 记录提交后再以新的固定 HEAD/tree 运行完整 12 项；最终精确值与结果由 `/tmp/pi-subagent-workbench-check/final/`、`final-before.json`、`final-after.json` 及交付说明闭合，不用本文之前的结果替代。

## 已实现的行为

- 删除左侧「任务监控」入口与独立弹窗，在原有任务页内直接提供实时清单、详情和按需发起表单；不提供跨 Agent 目标选择器。
- 实时任务沿原生 owner 关系取范围，终态子会话退出实时清单。独立折叠的「已结束的子代理记录」按每页 20 条读取，不加入历史 fork 树，也不授予 fork／rewind。
- `desk-subagents` 内置 Durable 扩展注册 `desk_subagent`：spawn、message、read、list、wait、abort。调用身份来自原生 invocation，配置准入／持久幂等与 HTTP 共用；spawn 是 conversation-owned background task，不随调用工具结束。
- steer／followUp 使用原生提交边界；终态消息拒绝复活，回答始终绑定原生 submission 的不可变 answer。取消模型等待的父回合不取消后台委托。
- 新显式能力 `taskDetails` 控制详情与历史；能力集为 41 项。只读可以检查，不可发起或中止；远程详情／发起 affordance 不开放，原远程 `/api/command` 裁剪不变。
- Desktop 的相关任务请求绑定 iframe generation，Host 同时检查目录与实际 worker 代际；旧代际不读写新库同号 task。原 Host 任务 API 的必填目标校验保留，未带新查询参数的旧 worker URL 兼容。
- 三个新浏览器 module 均登记统一资产清单。保留旧 Host controller/module 与 HTTP 的兼容入口，但 Desktop 不再挂载独立窗口。

调用契约见 [模型工具](../architecture/interfaces/subagent-tools.md)、[任务接口](../architecture/interfaces/host-tasks.md)、[面板生命周期](../architecture/interfaces/read-panels.md) 与 [分支树](../architecture/interfaces/session-tree.md)。

## 主会话自查与修复

| 发现                                            | 修复与有效验证                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 单条文本裁剪未明示，预算耗尽后可能留下空文本项  | 顺序扣减展示预算，准确设置 messagesTruncated；真实模型工具测试覆盖每条 2000、合计 32000 代码单元及省略项                       |
| 中文长消息触发原生默认文本裁剪，JSON 回执被截坏 | 使用公开 ToolRegistration.outputLimits 配置 1 MiB，返回前检查完整 JSON 的 UTF-8 大小，超限明确报错；不改变原生上下文或消息预算 |
| 切内置页时详情／等待观察未完整撤销              | 工作台同步内置页可见性，撤 HTTP 观察和等待；真实子代理继续运行，隐藏不拥有工作                                                 |
| 整合路径需要保留原存储代际边界                  | 客户端固定 generation，路由及运行进程再次校验；公开 HTTP 断言过期 409、无效值 422                                              |
| 创建重试及迟到回执容易串目标或改选              | 固定 owner、冻结请求内容和 requestId；真实后端只创建一次，后续读取完成屏障确认迟到回执不抢选择                                 |
| 名称、无障碍与窄屏细节                          | 使用 owned 原生名称；公开展开状态，收起返回焦点；触屏宽高均至少 44px；窄屏详情与表单占满栏宽；历史记录重绘保留焦点             |
| 详情缓存漏看 hasMoreChildren 的独立变化         | 签名覆盖溢出标记，HTTP 响应边界单独翻转该字段验证更新；首次遗漏 ETag 的探针失败不计有效证据                                    |
| SDK 1.3.0 原生压缩后测试夹具误等回执            | 保留消息数会减少，改按 provider 的 toolCallId 精确绑定本次工具结果；不修改压缩或执行行为                                       |

首次完整验收为 11/12：旧浏览器断言把新增的只读「查看」也当作写操作，并在隐藏页尝试读取详情。测试现明确区分读取和管理，先显示实际面板；继续严格断言所有写操作禁用、只读详情可读、远程详情／发起入口隐藏。修正后新一轮完整 12/12 通过。

主会话分别按 Standards／Spec 自查，未委派开发，也不称为两名独立 reviewer 的结论：

- Standards：接口七节、中文契约／错误、必要的 why 注释、公共 API 薄适配、统一资产清单、无新增依赖；各管理状态不与 Durable 重复存储。
- Spec：只有现有任务页，实时与终态独立、owner 与历史 parent 不混用、请求目标与 generation 固定、只读／remote 门禁不扩大、所有关闭／隐藏／取消等待只撤观察。未新增单分支归档或恢复。

## 新隔离反向验证

反向基线是 `ac22108061bd080ea0077fc346c6577c709d9d00`。副本仅复制 313 个 Git 清单文件，排除 `.git`、`.agents`、`node_modules`、release、真实数据与浏览器 profile，依赖只读链接。

**25 个独立行为变体全部有效检出并还原。** 实际尝试 27 次，其中前两次 whenBusy 变体匹配到两个源码位置、未执行修改，属于夹具定位错误，排除计数；收窄到工具 message 后两项均有效失败。没有把语法错误或环境挂起算有效。

- 01–09：模型 list owned 范围／非终态默认、终态拒绝消息、steer／followUp 边界、单条裁剪、总预算省略、原生 JSON 上限和超限错误。
- 10–14：历史仅终态、owned 权限、分页界限、路由 generation 绑定、remote 拒绝。
- 15–25：切页撤等待、迟到发起不改选、重试身份、终态退出实时清单、显式详情能力、溢出缓存、原生名称、44px 触达、窄屏栏宽、历史焦点、表单展开状态。

每项保存 diff、前后 SHA-256、预期行为失败信号与完整日志。还原后全部 313 个副本文件回到基线 SHA；30 项模型／HTTP／bridge 专项及工作台、双 worker、兼容面板三组 Chromium 全绿。随后只改了未参与上述反向的只读浏览器断言；当前全部 `src/` 文件与反向基线指纹一致。

证据：`/tmp/pi-subagent-workbench-check/mutations/final-matrix.json`、各 `.diff/.log`、`isolation-manifest.json`、`mutation-baseline.log`、`mutation-restored.log`。本轮没有沿用前轮 14 项反向结论。

## 完整验收与兼容

在上面的功能 HEAD/tree，新跑以下全部命令且前后指纹一致：

```text
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

- unit：381/381；Durable：32/32；workspace：25/25；语法检查 97 个源文件。
- 完整 12 项不设置 PI_OFFLINE；专项 faux provider 可单独设置。
- 本记录提交前真实解包验证：193 文件、839 KiB，Host 启动、module、浏览器及文献引用完整；最终记录提交后的包另由最后一次 package:check 验证。
- 真实 Chromium 覆盖两套 writer 的同号 task、草稿／不确定重试、原生等待／中止、迟到读取／发起、终态分流、分页、readonly／remote、焦点、双主题透明表面 4.5:1、390px、44px 触达与减少动态效果；浅／深／窄屏截图另经主会话目视复核。
- 仓库依赖为 SDK 1.0.0／Durable 1.0.2；安装依赖 SDK 1.3.0／Durable 1.0.4 使用另一份 Git 清单副本与只读链接，13 项工具／HTTP 测试及工作台、双 worker 两组 Chromium 均通过，没有安装源码。

证据：`pre-full2/results.json`、`pre-full2-before.json`／`pre-full2-after.json`、`installed-sdk-tools.log`、`installed-sdk-browser.log`、`screenshots/`，均位于本轮 `/tmp/pi-subagent-workbench-check/`。

## 提交与保护边界

主要提交：`a487bb8`（内置工具）、`8c65a68`（完整有界回执）、`0483411`（测试 profile 隔离）、`1bb1adb`（直接整合工作台）、`ae92983`／`e908f51`（行为边界）、`ac22108`（原生工具调用身份）、`917c6e2`（只读测试语义）。

开发期间出现的三个并发文件未被覆盖或随本功能提交；它们后来由并发提交 `4dc49c2` 收入历史。本轮前后其 SHA-256 均未改变，不将该进程修复归功于本任务。

保护指纹保持：

- `release/pi-desktop-extension-0.26.16.tgz`：`a907013df771bf7a35d4ac1be92ea6b5ec50d9a49db971c7b667bc37e6df9272`。
- `release/pi-desktop-extension-0.26.16-773b9f8.tgz`：`cbb5794b4e5401bac46fc37d2e57ad6412da0ba4da4f88531d8283abed02884d`。
- 当前安装包的 186 个公开文件与初始指纹一致。

未发布、推送、tag 或改写历史；未安装／重启现有应用，未操作个人配置或真实会话。Chromium 使用 basic password store 仅为一次性测试 profile 避免桌面凭据库初始化阻塞，不改变生产认证、TLS、沙箱或用户 Chromium 设置。E3 历史 reload／中断因果不在本轮范围，不能从本轮通过反推旧事件已查明。
