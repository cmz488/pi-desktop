> 历史验收记录：保留原始结论与环境信息，不代表当前版本全部行为。当前说明见 [文献入口](../README.md)。

# 0.10.0 会话、Git 与剪贴板验收

## 用户确认范围

- /sessions：可搜索逐行选择器，方向键／Enter／Esc，保留原并行聊天能力。
- /git：本地管理＋fetch/pull/push，三端共享工作区服务，远端操作不自动解决冲突。
- 粘贴：浏览器实际提供的 File／图片，不接入 Electron 原生文件复制或宿主路径读取。

一手来源的固定提交和具体文件见 SOURCES.md。Codex `47379efd5289cba801c5a66273064fbe3bf92f60`，ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；只读源码，没有执行上游应用或测试，没有复制上游组件运行时。

## 实现边界

- 新原生模块 git.ts 在宿主注册 /git，也可单独作为扩展加载；Web/Desktop 走专用 API 与同一个仓库服务，不启动另一个 Agent。管理聊天里的命令和确认绑定真实 slot。
- Git 固定 argv、仓库与路径边界、可信项目门禁、所有任务空闲、状态／配置指纹、一次性时限确认、同仓库写互斥。无任意 shell、URL 参数、force push、hard reset、clean、自动 stash 或分支删除。
- 提交列出并包含全部已暂存文件，不自动 add；branch/pull 要求工作区干净，pull 为 ff-only；upstream 映射以目标 ref 明示，无 upstream 时同名远端分支。
- 读取符号链接不跟随目标；其他未跟踪字节读取验证 descriptor 的 inode 与根路径，分块设限。差异输出 4 MiB、未跟踪合计 16 MiB、预览 512 KiB。仓库 hooks/filters/凭据助手仍是 Git 执行语义，用户先信任项目并确认。
- 写锁是本包进程的合作锁，不是跨进程事务。外部终端／Agent 工具仍可能同时改 Git。已启动操作保持原 cwd，不因前端换会话改派；没有中途取消远端操作的入口，最长 90 秒。
- 粘贴复用原 file input 读取器；只对实际文件阻止默认粘贴，混合文本保留，普通文字／HTML／文件路径不被当作文件。会话草稿、大小、模型图片能力、失败和重连语义不变。
- CLI/PTY 夹具使用 Pi 0.99.2，直接 SDK 单元／浏览器环境检测到已安装 Pi 1.0.0。MCP 测试按 SDK 版本调用原生 store 签名；没有改 Pi 或真实认证配置。

## 验收证据

| 场景                                                                        | 可复现验证                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| 搜索、窄宽度、完整 ID、草稿不混入搜索                                       | session-picker.test.mjs                                  |
| 真实 TUI 搜索进入 B，B 不被停止，managed /git help 不进模型                 | concurrent-tui-check.mjs                                 |
| 原生命令注册、取消／确认后实际暂存                                          | git-extension.test.mjs；tui-smoke.mjs 的真实 /git status |
| 初始无 HEAD 取消暂存保留文件、相同 status 内容变化、目标切换、重复 token    | git.test.mjs                                             |
| 临时 bare 远端的 push/fetch/pull、upstream 与本地异名 ref、非快进拒绝       | git.test.mjs                                             |
| 可信度／会话／任务运行门禁，/git 不转成模型提示词                           | git.test.mjs                                             |
| 过期、仓库／配置变化、同根互斥、符号链接、非 UTF-8、merge marker            | git-safety.test.mjs                                      |
| Chromium Git 分组、历史空态与写确认入口                                     | browser-check.mjs                                        |
| 真正的 File 字节及合成 paste 事件：文本＋图片、混合文本、PDF 拒绝、9 件限 8 | browser-check.mjs                                        |
| Electron Git 面板与 File paste 路径，关闭窗口不停止 Agent                   | test:desktop 的 tui-smoke.mjs（独立 Xvfb/profile）       |
| 320/360/390px、浅／深主题、Ask User 替换、Todo 折叠／完成隐藏               | browser-check.mjs                                        |

```bash
npm run check
npm test
npm run test:git
npm run test:pi
npm run test:browser
npm run test:desktop
npm run format:check
git diff --check -- .
```

最终验收：**76 项 Node 测试全部通过**；check/typecheck、test:pi（真实 PTY／SDK／Ask User／附件）、test:browser、test:desktop（Electron 43＋Xvfb）、format:check 和 diff whitespace 检查均通过。

全部新操作在临时 agent/project/repo 或本地 bare 远端执行。不调用外部真实模型，不对当前实际工作区执行管理扩展的 Git 操作；不重启真实 TUI／手机宿主，不修改个人配置或认证。

## 0.10.1 Git 反馈修正

用户截图对应旧宿主缺少 gitManagement，openGit 原先直接抛错，只弹 toast。本轮真实服务只读 /api/state 确认 Pi 0.99.2、gitManagement:null、idle:false；先运行 npm run test:browser，旧宿主夹具明确红色断言“面板没有打开”，再修改。

现已验证：旧宿主按钮打开面板显示分支／升级说明，零 Git API 请求；分支移出 composer；分组数量、文件展开／折叠、同一 revision 单份缓存复用、刷新／历史保留远端选择、空提交禁用、共享写门禁仍允许 diff、提交草稿恢复和换会话清旧数据；320/360/390px Git 面板与单列不溢出。现有 TUI 与 Git 固定 argv／确认安全回归保持。新增 git-state.test.mjs 用原生上下文交接夹具先复现 /api/state 500，再验证可写提示先检查生命周期 readiness，不在 /new／/reload 期间读取缺失上下文的信任状态；只读快照保留 backend 标识。0.10.1 最终验证：**77 项 Node 测试全部通过**，check/typecheck、test:pi、test:browser、test:desktop、format:check 和 diff whitespace 检查全部通过。

## 未部署与未验证

当前真实进程不保证热加载新宿主逻辑；需全部真实任务结束后经用户确认更新原宿主。本轮不会自动重启或 /reload。

没有验证公共远端 OAuth／SSH 初次认证、真实手机操作系统剪贴板、OS 文件管理器复制出的文件、macOS／Windows 安装包。浏览器／Electron 的合成 File paste 事件验证真实组件读取与提交路径，不等同 OS 实机粘贴验证。手机模拟宽度不等同实机验收。PDF／Word 仍明确不支持。
