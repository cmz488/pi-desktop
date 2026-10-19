# 任务与子代理管理的原生 API 收口

## 用户边界与验收 seam

本轮要求优化任务与子代理管理，只使用 Pi Durable 的原生能力。用户已明确确认：允许通过官方 `defineTask` 保留最薄业务适配，不自建调度器、执行器、模型循环或任务存储；验收 seam 为公开 HTTP 和两处真实 Chromium 界面。未使用开发／审查 subagents，产品中的 owned 子会话测试均由本地假模型执行。

运行与真相仍在同一个 Agent 的 Durable Harness／SQLite／writer 内。历史关系沿 `parent`，管理权限沿 `owner`；只读、不可变目标、generation 和生产远程裁剪不放宽。未实现单分支归档、暂停、重排或重试调度，也未改安装。

## 原生能力与薄适配的区别

实际核查仓库依赖 Pi SDK `1.0.0`／Pi Durable `1.0.2`，以及安装依赖 Pi SDK `1.3.0`／Pi Durable `1.0.4` 的公开声明与运行行为：

| 关注点                       | 原生 API／归属                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| 在跑任务与调度状态           | `Harness.taskGraph()`／`inspect()`                                                         |
| 持久任务及终态               | `getTask()`／`waitForTask()`                                                               |
| 中止                         | `abortTask()`／会话 `abort()`，原生 owned 级联                                             |
| 子会话与准入                 | `tx.createConversation({ownership:{kind:"task",taskId}})`、`submit()`／submission `wait()` |
| 本次回答                     | submission 的 `answer` → `tx.entry(AssistantEntry, id)`                                    |
| 调度、检查点、崩溃恢复与存储 | Durable，不由 Host 或浏览器重建                                                            |

`desk.subagent-run` 是本应用通过公开 `defineTask` 注册的一次委托，不是 SDK 开箱即用的同名子代理管理器。此次没有新增业务任务状态机；只把其回答读取收口到 submission 已决定的不可变条目。旧版已终结结果缺少新增字段时不重放补齐。当前归属说明与接口见 [Pi 边界](../architecture/pi-boundary.md)、[任务契约](../architecture/interfaces/task-graph.md)和[Host 管理契约](../architecture/interfaces/host-tasks.md)。

## 实施与红绿证据

1. `750bcca`：指定任务的等待透传原生终态；中止透传 `marked`／`terminal` 及原生任务快照。等待、中止与详情共用安全投影，不泄露任意 task 的输入、检查点或 result。兼容字段 `cancelled:true` 只表示请求已处理，不能据此改写 completed 为 aborted。子代理结果读取 `submission.answer` 对应 `AssistantEntry`，追加 `answerEntryId`，不再扫描当前上下文找最后一条助手消息。
2. `566439f`：工作台和 Host 共用原生回执提示，区分 completed／failed／aborted／orphaned／faulted；`marked` 仅提示尚未确认终态，旧空回执不补造完成结果。Host 详情显示原生回答编号；发起回执晚到不能抢走用户随后显式选择的另一个任务。
3. `a2d3b48`：修正文献里“没有任务管理面”的过时 backlog，明确 SDK 与应用业务适配的区别。

6 组逐片红绿分别证明：等待遗漏原生回执、已完成任务的中止缺少原生 terminal 语义、子代理结果缺少回答来源、工作台等待只给泛化提示、晚到 A 抢走 B 的查看目标、Host 详情遗漏原生回答编号。脚本与日志在 `/tmp/pi-native-task-api-check/tdd/`。其中旧实现可能在上下文继续变化时取错答案属于设计风险；本轮未用并发串答案例证明旧实现曾实际串答，不把显式原生绑定的优化夸大为该因果已证实。

阶段 `check` 为 94 个源码文件；35 项相关 API／归属／观察专项通过。真实 HTTP 保留完整的同 writer、幂等准入、失败／中止终态、owned 资源恢复、代际和权限检查。两处浏览器验证原生状态提示、旧回执兼容、原生回答编号、A/B 同号 task 隔离、晚到发起回执、观察取消／关闭／快速重开、实时片段和双主题／窄屏。

## 主会话双轴复核与隔离反向

主会话直接完成 Standards／Spec 复核：新增执行相关调用均为 Durable 公开 API；只新增安全 DTO 与展示，不读取内部 SQLite、不复制存储、不增加依赖或模型循环。模块契约、中文错误／注释及接口七节结构保持；客户端的选择 epoch 只管理观察身份，不是任务状态机。

在 `a2d3b48` 的隔离源码副本实施 **14 项有效反向**，全部由公开 HTTP 或真实 Chromium 的行为断言捕获，而非导入、语法或启动失败：

- 原生等待回执被丢弃、失败被改成完成、已终态中止被改成 marked、completed 被伪装成 aborted、原始任务输入泄露。
- 回答绑定错误条目、回答引用遗漏、回答预览被清空。
- 等待忽略原生结果、失败提示完成、marked 冒充已中止、旧空回执被当作完成。
- 晚到发起回执抢回查看目标、原生回答编号隐藏。

每项修改前后 SHA、diff、命令和日志位于 `/tmp/pi-native-task-api-check/sensitivity/`。还原后 HTTP、工作台和 Host 三组全绿。副本只复制 Git 列出的文件并排除 release／依赖／技能目录，不复制忽略的真实数据或浏览器资料。上述计数是本轮新增，不复用此前轮次结果。

使用只读链接的实际安装依赖再次运行 8 项 Host HTTP 和两组 Chromium 专项，全部通过；回执为 `/tmp/pi-native-task-api-check/global-deps/`。这不是重新安装或验证用户真实会话。

## 全量收口与夹具纠正

完整收口必须在本次提交后的固定 HEAD／tree 重新执行以下 12 项；阶段验证和旧轮结果均不能替代。最终逐项退出码、受测 HEAD／tree、工作树及 release 指纹以 `/tmp/pi-native-task-api-check/final/results.json`、`final/verification.json` 为准：

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

全量前发现并保留了三类夹具／环境记录，不算产品执行器修复或反向验证：

- 诊断确认只改 Host 的主题属性会被共享设置的 storage 通知还原；先前读取到 light／未保存偏好及重新启动的过渡动画。测试改走临时浏览器的真实主题设置，dark／保存偏好一致且动画结束后，仍执行完整 4.5:1 对比度和窄屏断言；未改生产 CSS。
- 新的原生完成提示使旧长等待夹具停在“任务已结束”文本。夹具改为同时断言真实 `task.status === terminal`、原生 outcome completed 和“任务已完成”，原 16.5 秒等待、续租、过期不误中止与隔离断言保留。
- 第一次全量脚本设置 `PI_OFFLINE=1`，使实际原生包更新器跳过测试要求的更新检查；去掉该环境覆盖后，原生包专项 5 项通过，未改包更新实现。另一次浏览器检查在对话框关闭后立即断言清单版本，早于异步补刷；增加对同一用户可见条件的有界等待后通过，没有放宽原生安装版本和重载提示断言。

两份既有 release 与已安装 `773b9f8` 包均保留；检查产物只在临时目录生成。完整验证还需核对安装目录包文件与旧 artifact 相同，不得自动安装、重启应用、推送或发布。更早 E3 只读调查的因果边界不因本轮管理优化而改变。
