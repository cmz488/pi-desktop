# Pi 标准扩展兼容基线

## 范围与结论

这是阶段 06 的**调查基线**，产品源码固定在 `a863083`；本阶段只增加标准扩展夹具、原生对照与文档，不提前交付阶段 07／08。表中的缺口不是允许最终验收忽略的范围。后续已修复项和验证另见[生命周期衔接记录](../history/native-extension-lifecycle.md)，不改写本表的历史观察值。

两个互不依赖的标准 Pi 包，已经通过临时 Pi 原生安装、配置持久化、发现、加载、工具／命令执行、禁用／启用与重载进入真实 Desktop Host。相同源码也在内嵌 SDK 原生会话中运行。**包能加载不等于完整兼容**：对照证实仍有输入、事件、边界决策、重载上下文和通用展示缺口。

任意终端绘制不承诺网页等价；最终要求是标准能力自动适配，自定义 TUI 有可见、可取消且不自动确认的通用回退。既有 `details.piDesktop` 和专用增强 adapter 保持兼容，但不是普通扩展的前提。

## 实际运行版本

| 执行路径                  | SDK 来源                                                          | 已核实版本 | 本轮规范用途                   |
| ------------------------- | ----------------------------------------------------------------- | ---------- | ------------------------------ |
| 默认 Durable 资源宿主     | 项目 `node_modules/@earendil-works/pi-coding-agent/dist/index.js` | **1.0.0**  | 默认 Desktop 的兼容基线        |
| `startWeb()` 未显式传 SDK | `loadEmbeddedPiSdk()`                                             | **1.0.0**  | 内嵌 Web 宿主基线              |
| 本机 PATH 上的 Pi         | 全局 CLI 包的真实入口                                             | **1.3.0**  | 仅记录版本差异，不替代上述规范 |

证据来自 `src/agent/pi-sdk.mjs` 的 `sdkEntry`／`embeddedSdkEntry` 解析、realpath 和入口所属包清单，而不是命令名称推测。`createDurableResources.ensureHost()` 明确传递 `sdk: piSdk`、`sdkEntry: embeddedSdkEntry`、`resourcesOnly: true` 给 `startWebSlot()`；资源会话不运行第二个模型循环。

本轮未升级 SDK／lockfile、修改个人 Pi 配置、全局安装或重启用户桌面端。源码提交不会自动更新全局安装副本。

## 规范与 implementation 来源

使用内嵌包 **1.0.0** 的本地发布内容，而不是上游 `main` 或 CLI 1.3.0 的相似文档：

- 入口与主要规范：`README.md`、`docs/extensions.md`、`sdk.md`、`tui.md`、`packages.md`、`rpc-extension-ui.md`。
- 相关配置与状态语义：`configuration.md`、`settings.md`、`security.md`、`sessions.md`、`session-format.md`、`message-types.md`、`how-pi-works.md`、`compaction.md`、`cli.md`。
- 相关资源／模型 interface：`skills.md`、`prompt-templates.md`、`themes.md`、`mcp.md`、`custom-provider.md`、`virtual-models.md`。
- 类型与实现：`dist/core/extensions/types.d.ts`、`runner.js`、`loader.js`、`wrapper.js`，以及 `dist/core/agent-session.js` 的工具管线、消息替换、边界提交、settlement、绑定和重载实现。
- 原生装配示例：`examples/sdk/06-extensions.ts`、`13-session-runtime.ts`。后者要求 runtime 替换会话后重新绑定，不应把旧会话闭包当成新会话的上下文。

内嵌 `docs/extensions.md` 的 SHA-256：

```text
26c7542e365fed7d6bd3f1d39b1ac38ef67c30ff1b714477ea49f97a3f7fde9c
```

该值与 CLI 1.3.0 同名文件不同。事件的返回类型、合并／短路顺序与错误语义以当前包导出的类型和 runner 为准；不能用 RPC 的最低降级规范代替本目标的可见回退要求。

项目侧 seam：[资源会话契约](../architecture/interfaces/resource-session.md)；运行归属：[Pi／Durable 边界](../architecture/pi-boundary.md)。当前调用链：

```text
Pi DefaultPackageManager.installAndPersist
  → 原生 settings.json 的 packages／资源过滤
  → createAgentSessionServices / DefaultResourceLoader
  → ExtensionRunner / bindExtensions(mode: rpc)
  → durable-resources 的同会话工具 scope 与 native-runtime
  → Durable 原生执行、提交和调度
  → Host HTTP／SSE → 聊天与扩展工作台
```

Desktop 不按包名再次发现或加载扩展，也不把扩展源码下载到浏览器执行。

## interface 兼容矩阵（阶段 06）

标记：**已验证**指本阶段通过真实安装夹具的行为；**部分**表示只能验证其中一段；**待补足**不算已支持；**待专项**表示已找到原生归属，但不能仅凭注册成功承诺默认模型路径的效果。

| 标准 interface                                          | Pi 1.0.0 语义                                                                 | 阶段 06 默认 Desktop                                                                                        | 后续验收要求                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 包／扩展工厂发现                                        | Pi 安装与配置选择资源；项目资源受 trust 门控                                  | **已验证**两个本地标准包自动发现，无工厂注入；原生 `extensions: []` 禁用后不重新加载，恢复后只注册一次命令  | 保留 Pi 作为唯一 loader；继续覆盖项目 trust、会话范围和卸载               |
| `registerTool` / `execute`                              | schema、signal、更新、普通／结构化结果、异常均经原生工具管线                  | **已验证**两个包的工具确实被模型调用；普通结果进入转录，工具 signal 存在；结构化字段跨 Durable 提交仍需专项 | 不复制执行器；完整保留结果／错误字段及取消，不只转发文本                  |
| `tool_call`                                             | 等待 handler；按顺序修改 `input`；阻止必须早于副作用                          | **已验证**参数修改影响真实执行；`block` 阻止执行，转录保留错误原因                                          | 保留审批、嵌套调用身份和原生抛错语义                                      |
| `tool_result`                                           | 等待 handler；替换 content／details／structuredContent／isError／usage        | **部分**已验证 content 改写进入模型与转录；其余字段不能据此推断                                             | 在相同原生工具管线消费全部返回字段                                        |
| `registerCommand`                                       | 发现命令，使用 command context 执行；不必触发模型                             | **已验证**目录自动出现，两包命令均可发现；笔记命令发送普通 custom 消息，不新增模型请求                      | 交互命令由真实浏览器回答／取消；保持命令与模型输入分离                    |
| `input`                                                 | 在模型准入前等待；可 `transform` 或 `handled`，保留 source／images            | **待补足**真实 Desktop trace 无该事件；原生对照能改写输入或完全处理且不发模型请求                           | 必须在准入前消费结果；用户、扩展程序输入和模板路径不可重复执行            |
| `before_agent_start`                                    | handler 依次看到可变 prompt options；可替换完整 system prompt、追加消息       | **部分**已等待并消费 messages；完整 system prompt override 尚未接入                                         | 保留顺序、原生 prompt 合并与 images，不能把已等待的 dispatch 改成广播     |
| `context` / `context_with_system`                       | 分别变换消息上下文与包含真实 system 的上下文                                  | **部分**前者已等待；Desktop 后者 trace 没有 leading system，而原生对照有                                    | 变换应作用于真正交给模型的 request，不重复 system，也不混入展示原文       |
| `message_start/update/end`                              | 有序流式事件；`message_end` 可替换同 role 的最终消息                          | **待补足**已有开始／结束，但无增量事件，未消费 message replacement，工具结果消息也不完整                    | 提交与展示必须使用原生决策后的最终内容；保留原始用量／工具关联            |
| `turn_start/end`                                        | turn index、timestamp、已持久化消息 ID；边界 preview／draft entries／continue | **待补足**Desktop 缺 index／entry IDs／boundary；原生对照能提交 custom draft 并准确继续一轮                 | 从 Durable 提交身份形成边界；等待和消费 draft／continue，不额外建模型循环 |
| `agent_start/end`                                       | 一个低层 run 的开始与结束；结束不代表彻底 idle                                | **部分**事件已等待且普通回合存在                                                                            | 追加工作、错误和取消后也保持原生顺序，不提前宣布 settled                  |
| `agent_before_settle` / `agent_settled`                 | 恢复／队列之后才到 pre-settle；可提交 draft、继续；真正无后续工作才 settled   | **待补足**Desktop 没有 before-settle；原生对照的该边界可继续一轮                                            | 取消不得被 continuation 重新启动；Goal 自动调度只能走既有 Durable 准入    |
| `session_start/shutdown` / reload                       | shutdown(reload) → 失效旧 context／监听 → 重建 runner → start(reload)         | **部分**真实顺序、新工厂实例和状态恢复通过；重载后工具 signal 仍在，但 `ctx.signal` 缺失                    | fresh runner 在 session_start 前重新绑定；旧回调／UI／监听不得泄漏        |
| session switch／fork／tree／compaction hooks            | 变更前可取消／提供原生结果；变更后通知；状态和 entry 属于同会话               | **待专项**Web 已有若干原生回调，但资源会话不能独立改变 Durable 会话／压缩真相                               | 对照实际管理入口与返回值；Agent 页签导航不等于重新执行扩展工厂            |
| `appendEntry` / session manager 读取                    | 私有状态进入原生 branch，按当前 branch 恢复                                   | **已验证**工具计数跨多次 reload／禁用启用恢复                                                               | 继续验证关闭、继承、取消与重启边界；不能直接写第二份 JSONL 真相           |
| `sendMessage` / `sendUserMessage`                       | custom 展示与模型贡献分开，triggerTurn／steer／followUp 走既有队列            | **部分**普通 custom 命令结果可见且不发模型；程序消息已有 Durable 委托路径                                   | 追加工作／输入变换／取消／来源与幂等必须专项，不让刷新观察发起工作        |
| 工具选择、模型／thinking、名称、标签、exec 等状态 API   | Pi 当前会话状态与原生执行上下文                                               | **待专项**已有资源状态代理，不能把 resource Session 的变更误当 Durable 配置已变                             | 对有返回／变更语义的 API 核对真实拥有者、提交和隔离                       |
| `registerProvider` 与 provider 请求／响应／stream hooks | 原生 ModelRuntime／Pi AI 的注册与请求级语义                                   | **待专项**注册可进入 SDK，但不以此宣称默认 Durable 模型请求经过同一 runner                                  | 核对真实模型 seam；若有原生能力冲突，报告证据并询问，不静默降级           |
| `resources_discover` / MCP 变更                         | Pi 扩展资源发现、原生 MCP 生命周期和工具暴露                                  | **部分**复用 SDK loader／MCP；本阶段的两个包未新增这类资源                                                  | 保留既有 MCP／技能回归，不另建资源系统                                    |
| flags／shortcuts／message renderer                      | flags 有原生默认值；快捷键与 renderer 有终端界面语义                          | **部分**SDK 仍拥有注册；没有凭空生成 Web CLI 表单或执行终端 renderer                                        | 通用工具／消息文本应可用；不可表达的终端界面能力必须可见回退              |

## UI 与自定义 TUI 矩阵

| 能力                                                                     | 当前证据／缺口                                                                                                | 阶段 08 要求                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `notify` / `setStatus`                                                   | Web 已发布通知／状态；真实 Host 的状态含普通扩展的就绪文字                                                    | 真实浏览器看到通知／状态，不被切换前的迟到事件覆盖                              |
| `select` / `confirm` / `input`                                           | Web 复用 host interaction store；原生对照走完整选择／确认／输入                                               | 真实浏览器回答和取消，保留 prompt ID、source owner、signal／timeout；不自动确认 |
| `editor`                                                                 | 原生有预填多行编辑语义；当前 Web 将 prefill 作为 input 的占位内容                                             | 必须是真正可编辑的预填内容；取消和空字符串不同                                  |
| `setWidget`（行／factory）                                               | Web 可 render、替换时 dispose；默认 Durable 只让识别出的增强 widget 进入扩展投影，普通 `notes-summary` 不出现 | 通用 Pi widget 自动展示，保留 placement／替换／清理；不是要求插件加专用声明     |
| 工具结果／custom 消息                                                    | 普通结果与文字已进入真实 Host 转录；已有增强卡片 registry                                                     | 真实页面验证通用内容、HTML 清理与增强展示兼容                                   |
| editor text／paste                                                       | 发布 `editor_text`，读取 editor text 仍为 `""`                                                                | 当前目标的读写／草稿语义明确；不把另一会话草稿送给扩展                          |
| `custom`                                                                 | `async () => undefined`，阻塞交互静默消失                                                                     | 可见、可操作、可取消的通用回退；不能假装用户已确认或制造组件返回值              |
| header／footer／title、editor component、autocomplete、terminal input 等 | 若干 no-op／终端降级；它们不是已适配 Web 的证明                                                               | 能表达的走通用展示；不能表达的明确提示／保留必要回退，不执行插件浏览器代码      |
| terminal theme／工具展开／键盘绘制                                       | 与网页 DOM、主题和输入法不是同一个 interface                                                                  | 不承诺任意 ANSI、光标、图片协议或自定义终端布局等价；限制必须可见               |

### 不可变的安全与运行归属

- Pi 发现／加载／执行扩展与工具；Durable 拥有唯一模型执行、任务、队列和恢复真相。
- 不能为事件兼容另跑 `session.prompt()`；文档中的原生对照会话只在测试中使用，不属于产品运行路径。
- 观察、刷新和切换页面不执行扩展命令；活跃资源按 Agent／会话隔离，旧 context 失效不能污染新目标。
- 保留项目 trust、审批、后端 capability、CSP、DOMPurify 和远程路径裁剪。UI 显示或通用回退不授予权限。

## 两个真实标准包与复现

源码位于 `test/fixtures/standard-extensions/`：

| 包                          | 业务与使用的标准 interface                                                              | 独立性                                                                |
| --------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pi-fixture-session-notes`  | 会话笔记工具／计数、流式更新、私有 entry、命令／custom 消息、生命周期和边界观察         | 自己的工厂／状态，无另一个包的 import                                 |
| `pi-fixture-review-dialogs` | 独立复核工具、通用 tool hook 门禁／结果改写、选择／确认／输入／editor、终端 custom 组件 | 无笔记包依赖；hook 按工具输入生效，测试允许观察另一普通工具的真实调用 |

两包只使用 Pi／TypeBox 标准 API，manifest 声明 `pi.extensions` 与 host peer dependencies；不含 `details.piDesktop`，不注册专用 Desktop adapter。测试 helper 会校验这两项约束。日志仅写测试临时 cwd，不注册外部进程／网络服务或启动模型。

安装不是把工具塞进 Host 选项：`test/standard-extension-fixture.mjs` 复制标准包到临时来源目录，调用生产也使用的 `runNativePackageAction()` → **真实 `DefaultPackageManager.installAndPersist()`**，验证原生 settings 持久化及 `getInstalledPath()`。Pi 对本地包按规范保留来源路径，不复制到 npm 目录；相对路径以所属 settings 文件解析。没有假 npm、`extensionFactories` 注入或改写 loader。

`test/standard-extension-baseline.test.mjs` 包含：

1. 真实 Host／worker 发现两工具和两命令；模型调用两工具；参数／结果变换、阻止前无副作用、普通 custom 命令结果且无额外模型请求。
2. 多次原生 reload 的 shutdown／start 顺序、新实例、私有计数恢复、唯一命令注册；原生资源过滤禁用／恢复。
3. **相同源码**在内嵌 SDK 的 `createAgentSessionServices` → `createAgentSessionFromServices` → `createAgentSessionRuntime` 中运行。原生对照覆盖 input transform／handled、完整 system override、message replacement、两种 boundary draft／continuation，以及标准 UI 返回值和 shutdown(quit)。原生 UI recorder 只用于协议对照，不代替浏览器验收。
4. 诊断输出当前 Desktop 的事件／字段／widget 缺口；不把错误行为写成应当保持的断言。阶段 07／08 必须补行为断言，不能凭这份基线完成最终目标。

复现命令：

```bash
node --test test/standard-extension-baseline.test.mjs
./node_modules/.bin/tsc --noEmit --skipLibCheck --module esnext \
  --moduleResolution bundler --target ES2023 --allowImportingTsExtensions \
  test/fixtures/standard-extensions/notes/extension.ts \
  test/fixtures/standard-extensions/review/extension.ts
```

阶段 06 观察值：`input`、message updates、tool start／updates、turn entry IDs、before-settle、leading system 均缺失；reload 后 `toolSignal:true`、`contextSignal:false`；普通 widget 不进入聊天投影。原生对照的相应语义断言全部通过。

本阶段验证：`npm test` **446／446**；`npm run check`（109 源文件）、两包独立 TypeScript 检查、本次文件格式与 diff 检查通过；`npm run package:check` 真实解包 **220 文件／934 KiB**，Host 启动、公开模块和文献引用完整。这里没有把阶段 08 的浏览器验收提前计入通过。

最终仍需阶段 07 的真实生命周期／取消／隔离验收，阶段 08 的两个包真实浏览器交互与 TUI 回退，以及阶段 09 的完整测试／格式／check／解包与既有 Goal、审批、扩展工作台回归。实际命令入口见[验证说明](../architecture/verification.md)。
