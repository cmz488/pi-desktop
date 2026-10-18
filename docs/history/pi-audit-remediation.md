# 分支与任务管理的审计修复记录

## 范围与基线

- 审计范围：`147eced...bc1ed7a`，共 10 个提交、28 个文件；修复从 `bc1ed7af74d2ea98fb1dcccf0c06b907b35f6714` 开始，开工时工作树干净。
- 规格：目标 `mvdultga-q2ntqo`；原始交付目标为 `mvdhbwvm-xsm7mk`。本轮不使用子代理，不修改外部安装包、父仓库、个人配置或真实会话，不发布或推送。
- 方法：各问题在已确认的 seam（公开 HTTP、默认 Host／worker／runtime、真实 Chromium）先写正确行为的失败断言，再做最小修复；不靠私有 SQLite 状态或内部调用次数证明行为。
- 原审计夹具已经证实错误可复现，但它们断言的是“观察到错误”，不是产品正确。稳定回归须迁入正式测试，最终验收不依赖审计时的 `/tmp` 文件。

开工复测（同一精确 HEAD）：

| 命令                            | 结果                              |
| ------------------------------- | --------------------------------- |
| `npm run check`                 | 84 个源文件通过                   |
| `npm run format:check`          | 通过                              |
| `npm test`                      | 308／308                          |
| `npm run test:durable`          | 29／29                            |
| `npm run test:workspace`        | 25／25                            |
| `npm run test:durable:recovery` | 生成与工具在途 SIGKILL 后恢复通过 |

同一 HEAD 在前置审计中也已通过 `test:browser`、`test:durable:browser`、`test:workspace:browser`、`test:remote:desktop`、`test:extensions:browser` 与 `package:check`。它们不是本轮最终树的验证证据，修复后仍须重跑。

## 问题矩阵

| 编号 | 发现与基线证据                                                                                                                | 状态                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| P1   | 默认 runtime 固定 `singleAgent: true`，合法 `fork` 返回 409；新浏览器夹具没有覆盖默认多进程路径                               | 已修复，见下文                 |
| P2   | Q1/Q2/Q3 → 退回 Q2 → 继续 Q4 → 退回 Q4 后，Q1 的 entry id 塌缩到退回标记；从 Q1 分叉错误带入 Q2/Q4                            | 待修复                         |
| P3   | A/B 各有真实后台任务；读取 A 的任务图包含 B，对 A 取消返回两个任务 id；以 B 为合法请求目标指定 A 的 taskId 也能取消           | 已修复，见下文                 |
| P4   | Chromium 中在 A 首次确认后切 B，仍保留 A 的任务行及确认状态，第二次点击直接发取消 B 的命令                                    | 待修复                         |
| P5   | 读模型返回 `supported: false`，工作台仍显示两个内置页                                                                         | 待修复                         |
| P6   | 对 16.5 秒任务点等待，12008 ms 弹出通用中止，任务仍运行且回答尚未提交                                                         | 待修复                         |
| S1   | 两个新增面板和后台夹具没有完整的接口／不变量／错误契约块                                                                      | 待修复                         |
| S2   | 分支树文档漏写 `entryId`、`preview`，`rewindTo` 的含义与投影不符                                                              | 待修复                         |
| S3   | 两面板重复加载／节流／补刷骨架，身份失效处理分别维护（主观气味）                                                              | 待修复                         |
| E1   | 调用使用无效的 `options.progress`，当前 schema 是 `includeProgress`／`chatProgress`；技能参考存在旧示例                       | 待纠正与核验                   |
| E2   | 只读 reviewer 无法执行 Git 命令；仅提供 diff 命令、未交付可读 committed diff，触发主管求助后 detached                         | 待纠正与核验                   |
| E3   | detached 后 status 找不到回执 id；另一路调用中断；延迟主管请求 reply 又找不到 pending request；尚无证据确定根因或确认任务停止 | 待诊断；需要越界时停止申请授权 |

E1/E2 属于调用与交接问题，不自动归咎于产品代码；E3 也不能仅凭上游类似 changelog 就认定根因。上述工具调用未产出可用审查报告，不作为独立复核证据。

## 修复与验证记录

各阶段在此补记根因、正式回归、反向敏感性检查与提交；只记录已实际执行的证据，未解决项不能移入 backlog 后算作完成。

### P3：任务归属隔离

- 根因分别在两个边界：宿主忽略请求 id 返回全 workspace 读模型；单任务操作只验证 taskId 的形状/存在，后台取消只过滤后台标记。HTTP 的会话目标检查没有丢失，问题在目标以内没有再验证任务归属。
- 读模型和命令共用 `ownedConversationIds`，只沿 `owner.conversationId` 收集后代，不沿历史 `parent`；越界与未知 taskId 都返回 404，无效 taskId 返回 422。
- 补充覆盖发现 owned 子会话没有 Desktop 的配置文档，轻量视图原先漏掉了它的工具。只为 `live()` 允许观察 owned 会话；其他读/写 Agent 入口仍保持原校验。不再吞掉工具视图的非 404 错误。
- 正式测试 `test/durable-task-scope.test.mjs`：读模型、指定取消、越界等待、后台取消、owned 在跑工具先分别失败，再修复通过；另保留远程/只读/目标校验与独立 fork 不属于 owned 后代的断言。8 条用例均用公开 HTTP 和临时 Durable 会话，不启动 pi-subagents。
- 反向敏感性在工作树的隔离副本中完成（不修改原仓库或 node_modules），逐条还原后再测：

| 临时反向修改               | 指定用例                | 结果      |
| -------------------------- | ----------------------- | --------- |
| 读模型改回返回全部任务     | 任务读模型只返回…       | 失败 1 条 |
| 指定任务只查存在、不查归属 | 指定任务取消／等待拒绝… | 失败 2 条 |
| 后台取消去掉会话范围条件   | 后台取消仅中止…         | 失败 1 条 |
| 轻量视图不允许 owned 会话  | 任务图显示 owned…       | 失败 1 条 |
| 把历史 fork 来源当所有权边 | 历史 fork 来源…         | 失败 1 条 |

执行命令为 `node --test --test-name-pattern='<指定用例>' test/durable-task-scope.test.mjs`；每条临时修改都有非零退出及明确断言失败，不是运行环境错误。

阶段回归：`npm test` 316／316、`test:durable` 29／29、`check`（85 个源文件）、`format:check`，以及 `test:browser`、`test:durable:browser`、`test:workspace:browser`、`test:remote:desktop`、`test:extensions:browser` 均通过；`package:check` 验证解包后的 169 个文件与实际模块引用。

### P1：默认 worker 的会话族

- 实测默认 Host → worker → runtime 的合法 fork 返回 409，不是浏览器菜单问题。
- 用户已明确选择“同 worker 会话族”：每个 Desktop Agent 保留一个 writer／SQLite，历史分支为同一 Harness 中的独立 Durable 会话；需要同步处理忙闲、原生归属与归档恢复，不以删除检查或复制数据库解决。
- 已先红后绿：默认分叉与独立用量／转录、真正的共享人格与运行配置门禁（未被引用的新提示词追加不应被误禁）、整族三会话重启／归档恢复、发现器归属。补充锁冲突及恢复冲突的跨 Host 重启用例已通过。
- 默认 Chromium 夹具已跑通会话栏和树节点两处分叉，在浏览器内断言新分支 Token 0、源内容和用量不变、随后切换及原生分支可退回；不再仅用注入 workspace 证明默认模式。
- 正式专项共 11 条：`desktop-branch-family.test.mjs`、`session-family-ownership.test.mjs`、`native-transcript-family.test.mjs`。增加了首次恢复文件尚未移动就失败的持久意图、真实 JSONL 标记及 generation／原生身份校验、非法清单，以及同进程里一个转录关闭失败仍释放全部锁；最后一项不能只靠 worker 退出自动释放来证明。
- 隔离副本中逐项反向修改以下 14 条边界，每条均非零退出且命中对应行为断言（没有模块缺失、语法或联网错误）：

| 反向修改                | 失败信号                                 |
| ----------------------- | ---------------------------------------- |
| 恢复默认 fork 拒绝      | 合法分叉得到 409                         |
| 分支不绑定原生转录      | 会话栏 native 标记／原生树缺失           |
| 整族 idle 字段改为 true | 分支运行时 familyIdle 断言失败           |
| Host 配置只看根 idle    | rename 未拒绝                            |
| worker 权限只看根 idle  | policy 未拒绝                            |
| 发现忽略已登记的成员    | 多出 Pi 替身                             |
| 不读取发布窗口标记      | 新文件未收归 Desktop Agent               |
| 不校验标记的原生身份    | 伪造文件被误收归                         |
| 归档只处理根            | 分支 JSONL 未移除                        |
| 恢复只处理根            | 分支 JSONL 未恢复                        |
| 重启不消费已保存意图    | 首个文件失败后恢复保持 pending，未续迁移 |
| 忽略清单版本            | 非法清单被接受                           |
| 关闭遇错就中断          | 后续转录的写锁仍被占用                   |
| 允许整族单文件接管      | 危险 resume 未返回 409                   |

- 当前环境未设置 `NO_PROXY`，首次全量运行错误地把本地请求送往代理；最小 revision 用例已复现其 socket 远端为代理端口。后续命令仅临时设置 `NO_PROXY`／`no_proxy=127.0.0.1,localhost,::1,[::1]`，不改代理、个人配置或产品网络语义。显式代理的 Durable 网络专项仍通过。
- 阶段回归：`npm test` 327／327、`test:workspace` 25／25、`test:durable` 29／29、`test:durable:recovery`、五套浏览器（工作区套件追加默认会话族用例）、`check`（88 个源文件）、`format:check`、`package:check`（172 个产物文件）均通过。此前失败的环境运行不计作通过证据。
- 本会话增量复核：Standards 检查新增模块契约、中文错误、接口归属、无新依赖和唯一 writer；Spec 检查默认多进程路径、会话范围、独立 usage 与原生身份、整族门禁、发现、失败续迁移和不可覆盖。没有使用外部子代理报告。
