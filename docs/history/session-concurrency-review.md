> 历史验收记录：保留原始结论与环境信息，不代表当前版本全部行为。当前说明见 [文献入口](../README.md)。

# 新建对话与并行会话检查

## 验收标准与结论

用户要求：A 会话仍在执行时，新建独立 B 会话；A 不被中止，B 可以执行自己的任务；切换显示不会停止任何会话。保留旧 JSONL 和聊天记录不等于后台运行。

**0.8.0 的同进程管理器已通过核心并行验收。** A/B 使用独立 SDK slot，创建、选择和停止分开，共用后端 PID、端口与显示焦点。原生 `/new` 仍是替换操作，并行需用 `/sessions new` 或 Web 新建。本文件保留原单会话诊断证据；当前正在使用的真实服务没有被重启或迁移，手机实机与长期网络行为仍未实测。

## 隔离复现

使用真实 Pi SDK、临时工作区和配置，以及本机 OpenAI 兼容 SSE 模型夹具。模型先输出 A 的部分消息，再等待测试释放，保证新建请求发生在 A 执行期间。没有访问真实模型或操作正在使用的手机服务。

```sh
node test/session-concurrency-check.mjs
node test/session-concurrency-check.mjs native-replace
```

以上保留为诊断探针：Web 路径修正后应通过；`native-replace` 仍**预期失败**，用于演示原生替换语义，不放进默认绿色套件。以下两条是修正前的历史失败证据：

- 网页路径重复两次：新建返回 409，当前 session ID 未变化，A 仍运行。失败断言：应允许创建 B。
- 原生替换路径：新 session 创建成功，A 不再运行，旧会话分支包含 `stopReason: aborted`。失败断言：A 应继续运行。

## 原单会话实现的根因（历史）

- `prototype.js` 的 `new-session` 操作调用 `/api/new-session`，没有并行管理层。
- `bridge.mjs` 的 new/switch 路由用全局 `canWrite()` 拒绝运行中操作。
- `web.mjs` 的 `exclusive()` 再检查唯一当前会话的 `isIdle`，随后调用 `runtime.newSession()`；列表来自磁盘 `SessionManager.list()`，不是活跃任务清单。
- `index.ts` / `tui-host.ts` 也只绑定一个当前原生上下文，通过 `ctx.newSession()` 替换它。
- 本机 Pi 0.99.2 `dist/core/agent-session-runtime.js` 的 `teardownCurrent()` 明确依次执行 `session.abort()`、shutdown、UI invalidation、`session.dispose()`。new/resume 都调用它。
- 现有流事件及 `prototype.js` 的 `applyRecord()` 按单个全局会话直接更新正文和工具集合，没有并行事件的目标 session 过滤；不能直接拼接多个 SDK 会话的输出。

## 参考源码事实

旧 `/tmp/pi-desktop-references` 已不存在。本轮重新获取以下固定提交，源码缓存位于 `/tmp/pi-session-references/{DSH,ZCode}`。GitHub REST API 因匿名限流返回 403，改用公开 Git fetch 获取同一固定提交；未运行上游项目。

### DSH

固定提交：`639ed015397290b3745d163aafe02ffee4aa3f84`。

- [Agent 创建／恢复](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/session-controller/src/agent.ts)：`ctx.agents.get(sessionId)` 查找已运行实例，create/resume 按目标 ID 管理，不替换一个全局 Agent。
- [客户端会话管理](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/session-controller/src/client/sessions/manager.ts)：Map 保存各 session 实例；列表状态单独跟踪 `running`。
- [并行隔离测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/acp/acp/tests/multi-session.spec.ts)：源码测试覆盖 A/B 并行、按 ID 分流输出、只取消 A、各会话独立限制在途 prompt，以及退出时释放全部活动会话。这里是阅读测试源码，不是声称本轮执行了上游测试。

### ZCode

固定提交：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`。

- [会话服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-session/zcodeSessionService.ts)：创建后按返回 session ID 建立同步订阅并广播初始快照；延迟持久化的空草稿与正式会话区分。
- [Agent 服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentService.ts)：按 workspace + session ID 分派事件、维护序号和去重；创建通过独立 `session/create` 请求完成。
- [会话常驻池](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts)：只回收已持久化、没有阻塞工作／交互／排队命令／订阅／操作租约的会话。不能因为切换显示就释放运行中的会话。

## 已实现的修正范围

1. 一个共享后端服务内管理多个 Pi 原生 SDK 会话；每个会话独立保存模型、消息、工具、队列、交互及运行状态。不引入独立的每前端后端。
2. 创建、选择、运行、停止和释放分开；新建 B 不调用 A 的 abort/dispose。
3. HTTP 控制及 SSE 事件带 session ID；前端仅将目标会话消息写入其正文，后台状态单独更新侧栏。避免切换竞态把 A 的迟到请求投递到 B。
4. 列表合并当前进程的活动会话和持久化历史；空新会话在首次模型回复前也能正确显示。恢复同一会话复用现有实例，避免重复 JSONL writer。
5. 退出宿主释放全部会话；关闭网页／Desktop 或切换会话不释放正在运行的任务。全局配置变更与每会话运行锁分开。
6. 同时执行 A/B、切换增量隔离、指定停止 A 而不影响 B、真实 read 完成、双请求历史恢复单 writer、浏览器独立草稿和退出清理均有隔离回归；连接恢复由既有真实浏览器与 connection 回归覆盖。

新增历史双恢复回归在修正前得到 `opened = 2`，修正后为 1。Input 在会话／交互绑定变化时重建，阻止 Ctrl+N 被当成密码回复以及切换后的 undo 恢复旧秘密。SDK 子会话不扩大父工具集合，缺失工具会提示。原生 resume 指向已托管的 JSONL 时取消并提示改用 `/sessions use ID`。

```sh
npm run test:sessions
npm run test:commands
npm run test:browser
```

真实 Linux PTY 加载注册包，验证 `/sessions help/new`、`/use` 前缀、Tab/共享焦点、后台 A 完成、Esc 保留 B、原生恢复取消和 quit 清理。Chromium 用本地模型夹具验证两会话同时运行、正文及工具隔离、侧栏完成状态、草稿恢复、help/use/stop 与迟到返回不清空新焦点输入。

## 0.8.0 收尾验证

- `npm run check`：TypeScript 与脚本语法检查通过。
- `npm test`：59 项单元／真实 SDK 集成测试通过。
- `npm run test:pi`：三种命令发现路径、真实 RPC、原生与并行 PTY 通过。
- `npm run test:browser`：Chromium 桌面／手机尺寸与真实并行交互通过。
- `npm run test:desktop`：Electron 43 + Xvfb 通过。
- `npm run format:check`：通过。

上述测试使用临时目录和本机模型夹具，不使用真实外部模型或修改用户配置。手机实机、跨平台发行包和外部 OAuth 账号仍不在本轮已验证范围内。

## 用户已确认的兼容边界

原生 Pi TUI 的扩展公开 new/switch 接口是破坏式替换，不能假装它已经支持并行。如果继续要求三端同步一个当前显示会话，需要让 TUI 也接入多会话管理宿主；这会调整 TUI 启动／接入方式，仍保持 extension package，不修改 Pi 核心或原版安装。

用户进一步提出：增加 Pi 会话管理扩展，在同一个原生 Pi 进程内管理多个 session，由 Web 适配这一管理器，而不是启动多个 Pi CLI。

据此，优先验证公开 `ctx.ui.custom` overlay 能否提供 `/sessions` 会话管理界面：扩展自己的界面根据管理器的 focus ID 显示和控制会话，独立 SDK 会话仍在同一个 Pi 进程内执行；原生已有活动会话需要保留为受跟踪的 native slot，而不能先 abort 再伪装为恢复。退出管理界面回到原生会话区时，显示焦点必须重新对齐原生会话；关闭界面不能中止后台任务。原生扩展 UI 交互、reload 和 quit 必须通过真实 PTY 验证，不能仅凭 API 声明宣称可行。

此方向的兼容边界是：原生 `/new` 和 `ctx.newSession()` 仍有替换语义；管理器界面内的新建、发送与切换由扩展处理。若要求原生聊天区及原生 `/new` 本身也直接多会话，就需要 SDK TUI 宿主或上游支持，不能靠删除 guard、操作私有字段或恢复被中止的会话实现。

用户已确认采用 `/sessions` 管理界面且不改变原生 `/new`。0.8.0 已实现上述管理器及命令适配，不修改 Pi 核心；第三方自定义 TUI 控件暂时隐藏管理界面并使用原生 UI，不宣称通用 Web 渲染。旧进程的 registry 与服务模块不热迁移，更新宿主须等待全部真实任务结束后重启；当前用户进程及手机服务未被操作。
