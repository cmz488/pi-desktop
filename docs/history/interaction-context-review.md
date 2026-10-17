> 历史验收记录：保留原始结论与环境信息，不代表当前版本全部行为。当前说明见 [文献入口](../README.md)。

# 0.9.0：过程、Ask User、Todo 与上下文附件验收

## 目标与实施方案

本轮在现有 Pi extension package 中完善四项交互。Web、Electron Desktop 与手机复用 prototype.html/js/css、bridge、SessionHost 和原生 Pi 会话，不创建新的 Agent 核心，不修改 Pi 安装或真实用户配置。

| 能力     | 原结构问题                                       | 本轮落点                                                                                                                              |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 过程     | 思考、工具及中间文字被整轮 process 再包一层      | 原生消息块按顺序逐条 disclosure，工具 ID 关联结果，默认折叠；最终回复保留正常正文                                                     |
| Ask User | 原生 custom 问卷无法远端回答；RPC 选择是通用弹窗 | sessions.ts 使用公开 custom done 回调；questionnaire.mjs 映射真实结果；输入区内嵌选项、多选和 Custom option                           |
| Todo     | 没有输入区任务视图，也不能猜模型文字中的清单     | conversation.mjs 消费真实 details.tasks/nextId 与工具结束事件；prototype 展示当前 slot 的非删除任务                                   |
| 上下文   | 输入区没有附件选择与提交协议                     | context-attachments.mjs 校验上传字节，调用 Pi 公开图片能力，经原生 prompt.images/sendUserMessage 提交；前端选择、预览、移除与草稿隔离 |

实现分阶段提交：独立过程、同步问卷、Todo 投影、原生附件、文档与完整回归。未把 DSH/ZCode 的模型调用、工具 reducer、附件 transfer 或文档解析器移植进 Pi。

## 来源与真实能力边界

DSH 固定提交 `639ed015397290b3745d163aafe02ffee4aa3f84`：ReasoningRow、ToolRow、QuestionToolRow 的独立 disclosure；TodoPanel 的真实 input dock、状态与空列表规则。

ZCode 固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`：ContextAttachmentPill 的预览与移除；useComposerAttachments 的 scope、ready 门禁、发送成功后只清冻结附件 ID。其 PDF、远端路径和其他格式能力不代表 Pi 支持。准确源码链接见 [SOURCES.md](../references/source-notes.md)。只阅读这些上游源码，没有运行其测试或复制运行时。

原生契约实际核对版本：

- Pi **0.99.2**：ExtensionAPI/ui.custom callback、tool_execution_start/end、SessionManager.getBranch、prompt.images、sendUserMessage 的 TextContent/ImageContent；公开导出的 detectSupportedImageMimeTypeFromFile、convertToPng、resizeImage、formatDimensionNote。
- pi-tui：公开 getImageDimensions 返回 widthPx/heightPx，用于解码前像素门禁。
- `@juicesharp/rpiv-ask-user-question` **2.12.0**：真实 QuestionParams、QuestionnaireResult、RPC 顺序对话、选项预览和取消结果。
- `@juicesharp/rpiv-todo` **2.12.0**：工具 details 的完整 tasks/nextId 快照；删除 tombstone；按 session ID 隔离；session_start/tree/compact 的分支 replay。

Pi CLI 的文件处理仅构造文本及受支持图片。将任意其他字节按 UTF-8 读取不是 PDF／Word 语义解析能力，本包不会用乱码假装文档支持。

## 行为与安全约束

### 独立过程

思考、每次工具调用及中间行为按原生块顺序独立呈现；摘要包括类型／工具／状态，工具展开显示参数和关联结果。嵌套调用也保持独立行，不再把子工具藏在父工具披露下。保留当前原生返回的完整内容，移除本包额外的 60,000 字符截断；上游工具自身的截断／完整输出文件规则仍由 Pi 决定。

不生成隐藏思考，不发送思考签名。活动调用缓存仍有 100 项上限；会话快照保留最近 150 条消息，历史更多内容不在当前页无限加载。SSE replay 仍受 2,000 条／8 MiB 限额约束，失去回放的客户端重新读取原生快照。

### 问卷同步

Native UI 和 Web 竞争同一个一次性 resolver；原生控件回答、Esc、远端提交和取消均结清等待。HTTP 对 job ID、prompt ID、实际候选值／结构进行校验；迟到提交不能覆盖赢家，旧 prompt 的取消不能误取消后续 prompt。一次完成后，各前端收到不含答案的 interaction_changed 通知并重读当前 slot 交互，隐藏内嵌问卷；认证对话继续走原有弹窗。0.9.1 修正原先“问卷在输入框上方叠放”的布局：问卷与普通输入区互斥，等待时替换输入区，提交／取消后恢复原草稿。

网络失败保留当前输入；重连／刷新恢复未完成问卷，而不是重新执行工具。会话切换立即撤下旧问卷，迟到的轮询结果不跨 session 显示。秘密输入不写普通 composer 草稿。

SDK 的 RPC walker 按问题逐个使用 select/input：单选 Custom option 先选中再输入；多选以原生数字列表回复。纯数字自定义多选答案在原生 RPC 中不可区分于选项索引，界面拒绝这种歧义并提示加文字说明；TUI 原生问卷可保留字面数字。没有通过改写 ctx.mode 或替换插件工具伪装一致性。

### Todo

任务只来自真实插件快照／结果，保持顺序、状态、activeForm 和有效依赖；不从自然语言或请求参数模拟任务变化。删除项隐藏，空列表或全部任务完成时 hidden 且内容为空，不删除原生记录。0.9.1 增加默认折叠的 details/summary，支持展开／收起，同会话快照更新保持当前开关，切会话或开始新列表默认折叠。

直接工具结果负责持久化 replay；嵌套 Codemode 的真实 todo 工具结束事件负责 live 同步。插件未把嵌套结果记录为分支 todo 消息时，跨重载／压缩后的保留能力仍以插件自身 replay 为准。投影不会擅自建立第二个持久化任务库。

### 附件

支持 UTF-8 文本／代码、PNG/JPEG/GIF/WebP/BMP；BMP 经 Pi 转 PNG，SVG 只作文本。PDF／Word、归档、非法编码、伪造图片和二进制内容明确报错。

- 单会话最多 8 项／4 MiB，单文本最多 512 KiB；图片最多 3200 万像素；浏览器所有附件草稿合计最多 16 MiB。
- 服务端根据真实字节检测图片，不信任文件后缀或浏览器 MIME；尊重模型 input 与 images.blockImages/autoResize。使用原生 worker 解码／缩放；转换前检查像素上限。
- 上传使用随机临时目录、0600 文件和 finally 清理，不读取客户端传入的宿主路径，不建立永久附件 URL。
- 只有 prompt 请求放宽到 6 MiB，其他接口保持 96 KiB。转换 await 后重新验证 focus；native dispatch 再校对 session ID。
- 选择／读取中的附件阻止提交；预览文本转义，图片使用本地数据；失败不清空，成功只清本次发送的附件 ID。文件读取期间切换会话不会把文件加入新会话。
- 未发送文件仅在当前前端内存，断线重连保留，刷新／关闭丢失；不同前端不共享未发送文件草稿。成功提交后进入共同的原生会话上下文，遵循 Pi 会话文件持久化规则。
- 附件只能随普通消息提交；斜杠命令先单独执行。手机选择手机文件，不提供浏览电脑文件系统的功能。

## 验收记录与复现

测试全部使用临时 agent／项目目录、本地模型 SSE 夹具、临时 Chromium／Electron profile；不调用外部真实模型，不操作真实会话任务。

| 验收                                                         | 证据                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 思考／工具／中间行为独立折叠，参数与原生输出保留             | conversation.test.mjs、browser-check.mjs；不存在 turn-process 父容器，工具与思考可各自展开                               |
| 问卷选项、Custom option、多选、预览与取消                    | questionnaire.test.mjs；真实 rpiv 插件的 ask-user-check.mjs                                                              |
| 原生 TUI 接受远端答案，原生 Esc 结清远端，重复／迟到答案拒绝 | ask-user-check.mjs 的真实 Linux PTY＋HTTP；工具结果确认，不仅比较桥接内存                                                |
| 两个前端同步、刷新恢复问卷                                   | browser-check.mjs 的两个独立 Chromium 窗口，第二窗口模拟 390px；一端提交后两端问卷隐藏                                   |
| 真实 Todo 增删改清空、嵌套 Codemode、顺序与会话隔离          | todo.test.mjs 加载真实 rpiv 插件；browser-check.mjs 检查输入区顺序、activeForm、删除隐藏及空列表                         |
| 文件选择、预览、移除、读取失败、提交失败、草稿隔离与重连保留 | browser-check.mjs 的真实 File API／CDP file input；读取失败使用显式 FileReader error 夹具，非法 PNG 的 HTTP 失败保留草稿 |
| 文本／图片实际纳入模型上下文                                 | context-attachments.test.mjs 的真实 SDK prompt；context-tui-check.mjs 的公开 sendUserMessage 与原生 JSONL                |
| 非法格式、UTF-8、路径、数量、字节、像素、图片模型／设置限制  | context-attachments.test.mjs；上传期间 focus 改变返回 409，不发送到新会话                                                |
| Electron／共享宿主和手机布局                                 | test:desktop：Electron 43＋Xvfb；browser-check.mjs：320/360/390px 工具栏及两行状态栏                                     |

```bash
npm run check
npm test
npm run test:pi
npm run test:browser
npm run test:desktop
npm run format:check
```

单独验证：`npm run test:ask`、`npm run test:context`、`node --test test/todo.test.mjs`。插件测试默认从本机 agent npm 目录加载已安装源码；非此目录可设置 `PI_DESK_ASK_PLUGIN`／`PI_DESK_TODO_PLUGIN` 为对应 index.ts 绝对路径。当前本地验证的两个插件均为 2.12.0，未冒充其他版本的兼容结论。

0.9.0／0.9.1 验收记录：68 项 Node 测试，加真实 RPC／PTY、Ask User、附件 TUI、Chromium 和 Electron 回归通过；测试结果不等于手机实机或所有平台结论。

## 0.9.1 回归补充

用户实测反馈问卷显示正常，但在输入框上方而非替换；Todo 无折叠按钮且全部完成仍显示。修改前运行 `npm run test:browser`，同时捕获以上三项失败；修复后同一真实 DOM 回归通过。

测试覆盖 Todo 初始折叠、展开／收起、更新保持展开、全部完成清空可视区域（原生快照仍保留任务）、新列表默认折叠；双窗口问卷原位替换、刷新恢复、提交／取消恢复普通输入及保留草稿。Chromium 对折叠 details 内部元素仍可能返回布局矩形，所以用 checkVisibility 判断列表确实不可见，不把有矩形误判为已展开。

本次只改页面呈现，不改宿主或插件契约；现有服务可读取新静态文件时，刷新前端页面即可加载这项修复，不需要重启 Agent。页面刷新会丢弃尚未发送的普通草稿／内存附件，操作前请先处理。

## 0.9.2 回归补充

用户截图要求移除输入预览、上下文仅加号，并参考 ZCode 提高控件与背景区分度。真实服务只读快照：GPT-6.1 Sol 声明 minimal/low/medium/high/xhigh/max，所选 high，idle=false；没有发送真实切换或模型请求。新增 HTTP 红色回归确认旧运行锁返回 409，浏览器红色回归捕获输入预览残留与 320px 思考菜单越界。

修复后验证：输入预览不存在，＋ 有可访问名称，浅色／深色控件均有独立表面与边框、文字对比至少 4.5；菜单在 320/360/390px 内可见；不支持／旧宿主／初始化状态禁用且显示明确原因。真实浏览器 SDK 与 Linux PTY Native/SDK 在流式任务中切换档位，原任务仍运行，两个 session 的档位独立，后端 ID 不变。HTTP 拒绝模型未声明的等级并保留共享配置运行锁。0.9.2 新增一项 HTTP Node 测试，共 69 项；全套命令仍同上。

样式可在处理未发送草稿／附件后刷新前端加载；运行中档位控制包含宿主改动，旧运行进程不自动获得新能力，需等所有任务结束后经用户批准重启原宿主。没有为验证重启真实服务或调整真实 Sol 档位。

## 未部署与未验证范围

没有重启／迁移当前真实 TUI 或手机服务，没有停止真实任务，没有更新个人配置、推送或发布。已加载旧服务／管理器的进程必须等所有真实任务结束，经用户批准后重启原宿主才能完整应用；刷新页面或 /reload 不保证宿主代码热替换。旧服务没有 attachments 能力时，新界面禁用附件入口。

手机相机／系统文件选择器、锁屏与实际 Wi-Fi 长期行为、macOS／Windows 发行包、外部 OAuth 账号流程未验证。Electron 与 Web 核心页面／协议共用，但操作系统选择器与安装行为仍有平台差异；本轮实际 Desktop 验证是 Linux Electron 43＋Xvfb。
