> 历史验收记录：保留本轮结论与测量，不代表后续版本的默认行为。当前说明见 [文献入口](../README.md)。

# 0.28.x · Percho 界面移植与 Pi 1.4.0 升级

后续审查纠正：本页最初记录的 528/528 没有覆盖真实消费链，不能据此宣布移植完成。嵌套工具空输出实际由本地 Pi SDK／Durable 结果字段混用导致，已修正并恢复 stdout 断言。默认 Host 现在按 worker 所有权路由，SSE 投影为权威状态；手机连接回收与背压接入实际网络路径。新增回归见[验证说明](../architecture/verification.md#percho-适配回归)。下面的规模和门禁数字保留为初次记录。

本轮把界面移植、手机端重建、SDK 升级和扩展能力收口放在同一条线上做，因为四者互相卡住：不升到 1.4.0 就无法判断扩展缺口是实现问题还是版本问题；不打通传输层就无法验证移植的界面；手机端复用同一套传输层，做完才知道隧道该不该留。

## 规模

相对 `main`：**408 个文件，+53355 / −27596**，28 个提交。

| 区域                  | 说明                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui-next/percho/` | 移植源码 41264 行（渲染层 234 文件 + shared 契约 + lan-web 23 文件），MIT，`LICENSE` 随代码                                                                                         |
| 我们自己的新模块      | 12 个：`ui-context`、`mobile`、`mobile-data`、`mobile-projection`、`self-signed-cert`、`ui-state-store`、`channels`、`support`、`host-api`、`http-handlers`、`build`、`vite.config` |
| 删除                  | 30 个文件：Tailscale 全套（1173 行源码 + 2316 行测试）、旧页面壳与专属模块（20208 行）                                                                                              |
| 新增测试              | 11 个文件：扩展 UI 一致性、手机端（边界/TLS/数据面/投影/LAN）、移植契约（契约/HTTP/状态/通道）                                                                                      |

## 四条主线

### 1 · SDK 升级：全套对齐 1.4.0

只升「两个包」不够：`pi-durable@1.4.0` 精确依赖 `chord@1.4.0`，而 `chord` 被钉在 `~1.0.2`，于是 `withTelemetry` 缺失、**每次 commit 都崩**。这是最初的真正根因，症状看起来像补丁失效。

破坏性变更与适配：

| 变更                                                             | 处理                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ToolExecutionResult.content` → `output`                         | 三处 Durable 工具边界改写；Pi SDK 侧 `content` 未变，两者不能混                                                      |
| `defineDoc` 新增必需 `checkpointWhen`                            | 五个 `desk.*` doc 全部补上（上游 `transaction.js` 无保护直接调用）                                                   |
| `read` 改用 `openBinaryReader`                                   | 加入只读 env 白名单                                                                                                  |
| `TaskRuntime.sleep` → `sleepUntil(until, checkpoint, ctx)`       | 后台任务不再立即 faulted                                                                                             |
| `emitBeforeAgentStart` 签名变为 `(trigger, systemPromptOptions)` | 旧的三参数调用让 `beforeRequest` 卡死、`turnIndex` 永不递增，`turn_end` 报 −1；**这一个 bug 掩盖了后面所有边界问题** |
| `pi-ai` 必须只在 peerDependencies                                | 否则打包后装第二份 runtime                                                                                           |

### 2 · 边界补丁：从源码改写退回原生

Percho 的 `patches/@earendil-works+pi-coding-agent+1.4.0.patch` 实测**打不上真 1.4.0**：它依赖的 `_runAgentPrompt` 已被拆成 `_startRun`/`_prepareRun`。我们自己的 1.0.2 补丁同样失效。

两个实测结论决定了替代方案：

- **phase 返回值被调度器丢弃**（`scheduler.js:1608` 只 await，状态推进只能经 `runtime.commit`）；
- **`endRun` 之后 task 已终结**（`inspect()` 的 tasks 变空），此时写 running checkpoint 不会复活它。

因此改道必须发生在 `endRun` **之前**。`answer()` 现在在会话注册了 `afterTurn`/`beforeSettle` 时进入 `committedAnswer` phase，由它分发边界后执行原生结算；没有处理器时逐字节保持原生行为。工具回合与终端错误直接用原生 `afterTools`/`afterResponse`。

### 3 · 扩展零配置：三态契约

`ExtensionUIContext` 在 1.0.0 → 1.4.0 **一个成员都没变**（28 → 28），所以"零配置"的缺口全在实现里：9 个静默 no-op + 6 个假返回值（`getEditorText` 返回 `""` 最危险）。

`src/agent/ui-context.mjs` 给 28 个成员各自声明层级：

| 层级     | 数量 | 内容                                                                                      |
| -------- | ---- | ----------------------------------------------------------------------------------------- |
| native   | 19   | 真实 GUI 实现（含 `getEditorText` 输入框镜像、`getAllThemes`/`getTheme` 接 SDK 主题模块） |
| degraded | 8    | 可用但非终端语义，附原因，首次使用时记录                                                  |
| refused  | 1    | `setTheme` 明确返回失败                                                                   |

声明表是契约：SDK 新增成员未登记层级时 `test/extension-ui-conformance.test.mjs` 直接失败。

### 4 · 界面与手机端：复用而不是重写

入口 `/` 改为移植后的渲染层；手机端复用 Percho 的 `lan-web` 单文件构建（945 KB）。

手机端是**独立边界**：独立端口、独立令牌、内置自签 HTTPS。桌面 Host 的路由没有鉴权（只服务本机回环），把手机路由混进去就得给桌面路由也加鉴权，那是更大的安全面改动。

自签证书由 `src/server/self-signed-cert.mjs` 纯 Node 生成（P-256 + X.509 v3 DER，无 openssl 依赖）。编码时踩到两个真问题：`Name` 少一层 `SEQUENCE` 会得到 `wrong tag`；序列号是 BigInt。

**Tailscale 已移除**：手机端不再经过任何第三方中继。移除不只是删入口——它承载扫码配对协议（`/api/remote` 写操作、`/_pi/connect`）和 host capability `remote`（41 → 40），这些都必须一并摘净，否则 host 启动失败。

## 通道现状

Percho 契约共 123 个 invoke + 17 订阅：

| 状态                    | invoke | 订阅 |
| ----------------------- | ------ | ---- |
| 已登记 invoke／实际订阅 | **64** | 5    |
| unsupported             | 59     | 12   |

保持 unsupported 的按「我们后端有没有」分诊，不硬造：`remote`(12) SSH 远端开发已被手机端取代、`app`(8) Electron 外壳能力、`update`(5) 无内置更新器、`uiPlugins`(3) 无该运行时、其余为无对应接口的存储与配置。

`permission:respond` 是**主动不实现**：Percho 的一次性 allow/deny（含 allowAlways/allowDir）与我们的 `interaction-reply` 形状不同，猜着实现会让手机答错问题。

## 实测纠正的错误假设

| 假设                                        | 实测                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/package` 列包                     | 不存在，`/api/package` 只接受 install/remove                                       |
| `/api/plugin` 读清单                        | 只写；读取端是 `/api/plugins`（复数）                                              |
| 审批模式在 `/api/state`                     | 在 `/api/agent.active.approvalMode`                                                |
| 新 provider 用 `models: [...]`              | `patchProvider` 用 `modelId`（单数）                                               |
| `/api/workspace/command` 可建会话           | Host 专属路由；worker 上是 `POST /api/command`                                     |
| 内置 `bash` 未声明 `structuredOutputSchema` | 它声明了；空输出来自本地适配器误把 Pi SDK 的 `content` 改为 `output`，不是上游缺陷 |
| Percho 是 58 个通道                         | 123 个（旧 grep 漏了多行定义）                                                     |

## 数据面

手机端出网内容统一在 `src/server/mobile-data.mjs` 裁剪：图片保留数量占位、本地路径与会话文件名递归清空、工具 `details` 走 6 层。写操作记入 `mobile-audit.jsonl`（时间/来源 IP/动作/目标/结果），**不记令牌、不记正文**。连接数上限 5、每客户端待发帧 64，并限制实际发送缓冲和队列的总字节数；超出断开慢连接。

实时投影由 `src/server/mobile-projection.mjs` 产出 Percho 的 view/transcript 状态；workspace 更新触发 SSE `snapshot` 帧，客户端原子替换历史与 partial，另保留 `list`／`ping`。

## 三个遗留失败的根因

| 失败                         | 根因                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| legacy SQLite history export | `migrateLegacy` 传的两方法 `models` 占位对象缺 `getAuth`，1.4.0 的 `withClientIdentity` 调用 `.bind` 时崩（16.7s → 1.1s） |
| TUI drafts                   | `pi-tui` 用 **APC** 序列标记光标，测试只清 CSI，草稿被切成 `ESC_pi:fc草ESC_pi:/fc稿-A`                                    |
| nested tool output           | 本地适配器混淆 Pi SDK 的 `content` 和 Durable 的 `output`；修正边界后恢复真实 stdout 断言                                 |

## 门禁

```
npm run check        tsc --noEmit + 113 个源文件语法检查
npm run package:check 660 文件 / 6079 KiB，资产与文档引用完整
npm test             528 / 528
```

`tsconfig` 与 `check-npm-package.mjs` 排除 `src/ui-next/percho`：移植的 React 树经 vite 打包，用 bundler 解析（无扩展名），不是 Node 模块图；检查脚本按既有 `src/ui/` 同一先例处理。

## 未做

- **59 个 unsupported 通道**：多数需要 Percho 独有子系统（UI 插件运行时、更新器、SSH 远端），或我们后端没有对应接口。
- **手机端 `permission:respond`**：需要一次契约设计，把 allow/deny 映射到 `interaction-reply` 的值语义。
- **`src/ui/shared/` 保留的 17 个纯模块**：`client-policy`、`task-vocabulary`、`task-panel` 等是有测试覆盖的领域逻辑，新界面尚未接替。
- 真实局域网设备的首次证书信任只能人工验收，夹具不能代替。

## 出处

移植源码来自 [Jaxton07/percho](https://github.com/Jaxton07/percho)（MIT），保留在 `src/ui-next/percho/LICENSE`；`SOURCES.md` 与本页只记录适配取舍，不复制其内部规格。
