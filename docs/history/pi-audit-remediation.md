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

| 编号 | 发现与基线证据                                                                                                                | 状态                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| P1   | 默认 runtime 固定 `singleAgent: true`，合法 `fork` 返回 409；新浏览器夹具没有覆盖默认多进程路径                               | 已修复，见下文               |
| P2   | Q1/Q2/Q3 → 退回 Q2 → 继续 Q4 → 退回 Q4 后，Q1 的 entry id 塌缩到退回标记；从 Q1 分叉错误带入 Q2/Q4                            | 已修复，见下文               |
| P3   | A/B 各有真实后台任务；读取 A 的任务图包含 B，对 A 取消返回两个任务 id；以 B 为合法请求目标指定 A 的 taskId 也能取消           | 已修复，见下文               |
| P4   | Chromium 中在 A 首次确认后切 B，仍保留 A 的任务行及确认状态，第二次点击直接发取消 B 的命令                                    | 已修复，见下文               |
| P5   | 读模型返回 `supported: false`，工作台仍显示两个内置页                                                                         | 已修复，见下文               |
| P6   | 对 16.5 秒任务点等待，12008 ms 弹出通用中止，任务仍运行且回答尚未提交                                                         | 已修复，见下文               |
| S1   | 两个新增面板和后台夹具没有完整的接口／不变量／错误契约块                                                                      | 契约已补齐，待规范总复核     |
| S2   | 分支树文档漏写 `entryId`、`preview`，`rewindTo` 的含义与投影不符                                                              | 字段已修正，待文档总复核     |
| S3   | 两面板重复加载／节流／补刷骨架，身份失效处理分别维护（主观气味）                                                              | 已修复，见下文               |
| E1   | 调用使用无效的 `options.progress`，当前 schema 是 `includeProgress`／`chatProgress`；技能参考存在旧示例                       | 已纠正并隔离核验，见下文     |
| E2   | 只读 reviewer 无法执行 Git 命令；仅提供 diff 命令、未交付可读 committed diff，触发主管求助后 detached                         | 交接已纠正并隔离核验，见下文 |
| E3   | detached 后 status 找不到回执 id；另一路调用中断；延迟主管请求 reply 又找不到 pending request；尚无证据确定根因或确认任务停止 | 未闭环；需原始日志或额外授权 |

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

### P2：多次退回的消息原点

- 正式正确性断言先失败：默认 worker 两次退回后，Q1 的 entry 从 9 变成标记 29；从界面可见 Q1 的目标分叉，实际带入 Q1 回答、Q2、Q4。不是单次退回的问题，也不能用“数量不符就不写 origins”作为安全降级。
- 原生句柄新增 `rewindContext(entryId)`，从 Pi `buildSessionProjection` 同时取得消息与 sourceEntry，导出检查点只补全同一 Durable 贡献的原生来源，不另推导活跃路径、编辑或压缩。旧 `rewindMessages` 仍可取消息；HTTP 输入与目标规则不变，Host 不信任客户端传入的上下文／来源。
- 来源与 `desk.rewind` 标记原子落盘；无效来源 422、未知／越界来源 404、数量无法对齐 409，拒绝不追加部分标记。简单的直接旧调用仍兼容，不再静默落到整个标记。
- 压缩补测发现原有路径把 `compactionSummary` 等 UI 角色直接写进 Durable model，导致退回后不能续跑；使用 Pi 的 `convertToLlm`，同时只在需要时保留同一条目里的原始 UI 贡献。真实压缩会话续跑确认请求含原生摘要与保留区，不含放弃内容；custom 卡片和来源也保持。
- 正式证据：`durable-rewind-origins.test.mjs` 3 条默认 Host／worker 用例（原点／重启／parent／leaf、再次分叉与真实请求、压缩续跑）；`native-rewind-context.test.mjs` 5 条 Pi 投影用例（批量、omit、replace、压缩、custom）；`agent-workspace.test.mjs` 2 条边界与 UI／LLM 分离用例。默认 Chromium 用消息右键完成同一两次退回流程，最后分叉只有 Q1、Token 0，无重放请求。
- 隔离副本 12 项反向验证均失败：还原 `208ce90` 的旧实现（API 与浏览器分别失败）、不转交 Pi 来源、绕过 Pi 投影（编辑与压缩断言失败）、不补批量贡献来源、把全部原点指向目标、落盘省略来源、取消已知来源校验、取消数量校验、取消 LLM 规范化、忽略原生 UI 贡献、把摘要计入可见来源。所有失败都对应行为断言，不是语法、模块或代理错误。
- 阶段回归：`npm test` 337／337、`test:workspace` 25／25、`test:durable` 31／31（包含新增 workspace 用例）、`check`（88 个源文件）、`format:check`、Durable／默认工作区 Chromium、SIGKILL 恢复和 npm 产物检查均通过。
- 本会话两轴复核：Standards 检查中文契约、兼容输入、原子提交、错误与文档；Spec 检查不可变原点、只从 Q1 分叉、重启与原生 parent／leaf、Pi 原生上下文及规范化、源会话与用量不变。未使用子代理。

### P4／P5／S3：面板身份、确认与能力

- 原始浏览器回归先失败：切换到 B 后仍显示 A 的任务行。后续把加载／失效移入最小 `session-panel-loader`，工作台在过滤与渲染前更新全部内置页，不再等重新打开任务页才清旧状态。
- 代际令牌同时包含页面 owner、显示目标与权限；请求中止只是资源释放，迟到响应还必须通过代际检查。确认与命令捕获不可变目标；旧 DOM 不可执行，命令的过期结果不提示、不刷新另一会话、不改选分支。消息／会话菜单也捕获目标并校验动作代际。
- 完整与 chat 快照显式投影 Host 声明的 `sessionTree`／`tasks`（能力集仍为 40），不靠方法存在性或 snapshot 自填字段。未声明／unsupported 隐藏入口；只读按钮 disabled；同会话权限变化同样撤销确认。远程网关的 `/api/command` 裁剪没有放宽，现有 `/api/abort` 仍可用；能提供合法 scoped 命令的嵌入控制器不被 remote 布尔值一刀切。
- 共享读取保持折叠／滚动，1500 ms 节流并合并补刷；暂停／销毁中止读取并撤销定时器，忽略迟到回调。补齐两面板、后台夹具及相关共享模块中文契约，接口归档到 `read-panels.md`，未引入依赖或通用框架。
- 正式证据：9 条 loader 时钟／资源用例；隔离 Chromium 覆盖旧 DOM、后台取消、未选中页失效、迟到响应、A/B/A、同身份权限变化、折叠／滚动和销毁；默认 Host／worker 的真实任务 + 完整聊天控制器覆盖即时失效、实际读模型晚到、过期分叉、能力变化与会话栏入口隐藏，最后仍确认 A/B 的真实任务未被误取消。Bridge 声明用例先红后绿。
- 15 项隔离反向验证均命中行为断言失败：还原旧面板、保留旧数据、不 abort、读取只比较会话字符串、命令令牌只比较字符串、只更新选中页、绕过首次确认、不冻结目标、忽略能力声明、忽略 unsupported、忽略只读、信任自填 snapshot 能力、移除节流、漏撤补刷定时器、接受错目标响应。对 A/B/A 的实际过期分叉单独验证，不能只用读取测试代替动作结果检查。
- 阶段回归：unit 347／347、Durable 31／31、workspace 25／25、check（89 个源文件）、格式、五套浏览器、SIGKILL 恢复与 npm 产物（174 个文件）均通过。扩展浏览器首次功能断言已通过，但收尾遇到 Chromium profile 的短暂 ENOTEMPTY；增加仅限临时目录的有界原生 rm 重试，仍保留最终错误，之后整套重跑通过，首次失败不计作通过。
- 本会话 Standards 复核：中文契约与 why、接口归属、唯一加载骨架、无新依赖、受控夹具与资源关闭。Spec 复核：不可变目标与即时失效、延迟／快速切换、所有入口门控、只读／远程边界、折叠／滚动／节流／补刷及晚到资源结果。长等待的 HTTP 生命周期留在下一阶段，不因当前 UI 通过而计作 P6 完成。

### P6：可取消的长任务观察

- 默认 Host／worker 的真实前台任务在点击等待后继续挂起 16.5 秒；初次红测在 13 秒读取到 `signal is aborted without reason`，而任务仍未空闲。根因是 wait 复用了普通 API 的 12 秒期限；原来后台 Context 的等待也没有随 HTTP 断连释放。
- 仅给 wait 使用 45 秒连接期限，普通 API 的 12 秒与其他端点既有预算保持不变。worker 的观察请求使用 40 秒租约、32 项容量；租约到期 408、超额 429、关闭 503，均不伪装终态。通过 Chord 的公开 `withAbortSignal` 将取消仅传给 Durable 等待 Context，不改任务上下文或归属校验。
- 面板每次观察一个冻结目标，“取消等待”只停止观察；408 对同一目标续租，不重发工作，总预算 5 分钟且不因续租重置。取消、到期、切换、权限变化、暂停、销毁和 unsupported 都释放观察；晚到成功即使故意无视 abort，也不提示或刷新另一会话。连接超时使用明确中文错误，保留键盘焦点和原有任务中止确认。
- 新回归先红后绿：workspace 取消后观察者不释放；真实 HTTP 没有有界配额；真实浏览器缺少独立取消等待；评审还发现 unsupported 隐藏页后等待仍存活，以物理 signal 的红测补齐，未只把隐藏入口当作资源清理。
- 证据：`test/long-task-wait-browser-check.mjs` 完整默认路径验证 >12 秒真实终态、A 的独立取消／到期、同目标续租、总预算与计时器、故意晚到的成功，以及 B 的真实在途工作不受影响；`task-waits.test.mjs` 的 5 条用例覆盖真实 HTTP、资源出口和配置；workspace 与范围 API 用例验证取消 Context、32 项配额与断连后重新接受等待。隔离面板也断言 wait 目标冻结。
- 24 项隔离反向均命中行为断言：恢复原等待期限、加长所有普通 API、丢前端 signal、丢 workspace 取消 Context、丢 runtime signal、租约不触发、去容量、丢断连、漏清 timer／listener／slot、关闭不取消、去配置验证、不续租、身份变化不取消、显式取消不 abort、总期限不取消、采用晚到成功、漏撤总预算、续租重置预算、wait 目标不冻结、通用中止错误、提前返回终态、unsupported 不清等待。未把脚本／模块／语法错误或单纯进程超时当作失败证据。
- 阶段回归：unit 354／354、Durable 32／32、workspace 25／25、check（90 个源文件）、格式、五套浏览器、SIGKILL 恢复及 npm 产物（175 个文件）均通过，日志前缀 `long-wait-full-*`。普通浏览器曾两次在既有 `.preview-resize` 指针断言失败；隔离诊断与随后未改代码的完整重跑通过，原因尚未证实，不将此前失败计为通过，也没有放宽该断言或修改无关产品代码。
- 本会话 Standards 复核：新增 HTTP 观察模块有中文契约与独立职责，公开 Context API、命名期限、校验与全部出口清理，无依赖／外部包改动。Spec 复核：实际长任务、真实作用域与租约回收、取消观察与中止任务分离、迟到结果及另一会话保护，且未扩大远程权限或请求目标。

### E1／E2：参数与只读交接纠正

- E1 是调用契约错误，不是 Desktop 产品缺陷。已安装 `pi-subagents` 0.77.0 的 `src/extension/subagent-options.js` 先拒绝未知 options key；`schemas.js:211,231` 声明 `chatProgress` 为 `auto/off/live-card` 字符串、`includeProgress` 为 boolean。正确关闭片段为 `includeProgress:false, chatProgress:"off"`，不是 `progress:false`，也不是 `chatProgress:false`。`skills/pi-subagents/references/prompting-and-roles.md` 的 cleanup 示例仍含旧字段；不修改外部包，项目指南以实际 schema 为准。
- E2 是父会话交接错误：前序本对话记录的 reviewer 已执行 `ls`、`watchdog_diff` 和 `contact_supervisor`，不能概括为“完全无法启动”。安装包 `agents/reviewer.md` 明确没有 Shell，并说明 `watchdog_diff` 不检查 committed ranges；正确交接是父会话先提供可读的 immutable artifact，而非仅给出 Git 命令。本轮没有重新启动 reviewer 或扩大其权限。
- 新指南 `docs/guides/review-handoff.md` 约定完整 base／head SHA、范围、补丁、变更路径、摘要／字节数、两端源码快照、只读封存和读文件 preflight；源码上下文不能用变化后的当前工作树冒充旧 HEAD。缺少文件、身份不符或摘要不符时先补交接，不开始结论。
- 独立验证 `test/toolchain-contract-check.mjs` 显式读取已安装包／宿主路径；扩展 peers 由该宿主解析，不安装或改写依赖。参数部分读取指南中的真实示例进行校验。交接部分重新从 Git 对象生成本次 10 个提交的材料，验证可读、同长度篡改／字节数错误／越界路径／身份错误被拒绝，以及补丁与上下文只读。只调用纯校验／解析函数和父会话的 Git／tar，不调用子代理工具或执行器。
- 本次补丁身份：base `147eced3907e51ccd2135a7543ede085e676b131`，head `bc1ed7af74d2ea98fb1dcccf0c06b907b35f6714`，10 个提交，158215 bytes，SHA-256 `c8086df47ac910a63c0d2ba09f17ce888c9f4ee0a52589f229809667400565e1`。临时产物不是永久依赖，正式验证脚本可重建。
- 9 项隔离反向核验：把指南恢复为旧 progress 字段，移除摘要、字节数、快照只读、manifest 版本、种类、base、head 或路径边界校验；均命中 AssertionError，而不是模块或运行环境错误。首次直接导入遇到未提供宿主 peer `typebox`，这是独立 Node 夹具的解析问题；改为显式宿主 peer 解析后再计入上述结果，没有修改 node_modules。

- 本阶段核验：E1／E2 独立验证与 9 项反向断言通过；`npm test` 354／354、check（90 个源文件）、format、npm 产物（176 个文件）通过。它们不替代仍缺失的 E3 实际生命周期验收。
- 本会话两轴复核：Standards 检查指南／历史分离、显式环境与隔离目录、未引入产品抽象或外部写入；Spec 检查 schema 字段类型、实际可读且固定身份的交接、不增加 reviewer 权限，以及 E3 的未知状态没有被当作完成或停止。

### E3：调查边界与未闭环证据

- **当前不宣称修复，不确认旧任务已经停止。** 原始 `/tmp/pi-review-bc1ed7a.mcg8d2/review.md` 与 `02bf8b81-9988-4128-954e-d57d6bc496d1` 的旧 meta／转录产物现已不存在；此前本对话记录的 `exitCode:-2`、acceptance pending 和 3 次工具调用也不是停止或完成证据。
- 0.77.0 的源码可定位行为：`subagent-executor.js:3928,3951–3964` 记录前台结果并生成 detached 恢复提示；`run-id-resolver.js` 先看当前父会话的前台记录，再看 async／alias／nested 定位信息；`run-status.js:414–475` 没有可用定位时返回 `Async run not found`。仅凭这句话不能推断任务从未启动或已经停止。
- 正式脚本在临时目录复现**条件路径**：内存中 detached 前台记录可查，`foreground-history.js` 的 compact／restore 仅接受 completed/failed/paused/stopped，因此在没有其他 async／nested 定位记录时，新状态不能恢复它；completed 对照可恢复，另一父会话仍保持隔离。**没有证据证明原始事件确实发生了这种状态重建或会话不匹配，不能把条件模型当成本次根因。**
- 主管通道 `native-supervisor-channel.js:482–486` 对 pending Map 查不到 replyTo 时明确失败；成功 reply、请求清理与通道关闭均可能改变 pending，关闭路径会清 Map。它不证明子任务退出。另一路“Tool … interrupted and may have partially run”缺少原始调用／取消时序，无法与 detached 或 pending 消失建立因果链。
- 本仓库不实现这些 run-id／foreground-history／supervisor 注册表，目前没有证据支持一个项目内适配修复；也不能排除上层编排或宿主生命周期的影响。修改上游持久化规则、移除父会话隔离或补造停止状态都不安全。当前需要原始工具回执、status 的准确参数与父会话身份、reload/中断/回复时间线及相关生命周期日志；若不足以判定，才考虑另行授权的隔离真实生命周期回归。
- 因此触发目标的停下询问规则：E3 不计完成，工具链任务保持进行中；文档总复核与最终全量验收也尚未完成。后续若需真实子代理、原会话操作或外部源码修改，先由用户明确调整边界。纯条件夹具的退出 0 不是 E3 产品验收通过。
