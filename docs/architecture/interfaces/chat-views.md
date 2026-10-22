# 聊天视图与输入区契约

## 位置与职责

`src/ui/chat/chat.js` 仍拥有请求路由、当前会话／generation、连接、消息、命令目录和装配，不把可写的全局状态包交给视图。各 module 在固定 seam 上拥有自己的状态、请求、表单事件与清理：

| Module                    | 所有权                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| `preferences-settings.js` | Pi 配置草稿／scope／revision、人格表单、浏览器外观与字号监听       |
| `provider-settings.js`    | 提供商与 picker 模型清单、配置／默认模型／认证入口                 |
| `resource-settings.js`    | 技能视图、MCP 清单／表单、可见期间的资源观察                       |
| `package-settings.js`     | 唯一插件清单、配置／资源过滤、更新检查、市场目录及清理后的完整介绍 |
| `remote-settings.js`      | 远程页读取、共享动作入口及可见期间的补刷                           |
| `composer-attachments.js` | 文件选择／读取／粘贴、附件条目和预览入口；不拥有文字或发送循环     |
| `chat-dialog.js`          | 单个共享对话框的展示令牌、保存尝试、关闭与过期保存隔离             |

模型选择继续使用 `composer-model-picker.js`；工作台、侧栏、附件预览继续使用原有 module。`src/shared/session-drafts.mjs` 仍是唯一会话草稿；`session-inventories.mjs` 合并并缓存提供商／插件清单，不阻塞聊天。

## 签名

设置 module 的构造参数包含既有 `api(path,input?,{signal}?)`、必要的实时只读 getter 和跨职责回调。所有浏览器公共 URL 均登记在 `src/server/asset-manifest.mjs`，不直接暴露源码目录。

```js
preferences.setContext({ identity, view, active });
preferences.update();                    // 快照／Desktop 配置改变，不重建未变表单
preferences.handleClick(button);         // 同步返回是否拥有此动作；异步失败在内部处理
preferences.reloaded();                  // 既有重载完成后协调未修改的表单
preferences.applyAppearance();
preferences.adjustFontSize(delta);
preferences.dispose();

providers.setContext({ identity });
providers.applyInventory("providers" | "modelChoices", value);
providers.pickerModels;                  // picker 的实时只读清单
providers.update();
providers.handleClick(button);
providers.dispose();

resources.setContext({ identity, view, active });
resources.update();                      // 命令目录改变
resources.handleClick(button);
resources.dispose();

packages.setContext({ identity, view, active });
packages.applyInventory(value);
packages.handleClick(button);
packages.reloaded();
packages.dispose();

remote.setContext({ identity, active });  // active 只表示远程页可见；进入时 prepare 刷新
await remote.refresh({ address?, prepare = false } = {});
remote.dispose();

attachments.render();
attachments.resize();
attachments.rows(owner?);                // 默认当前草稿 owner
attachments.restore(files, owner);       // 仅追加附件，文字仍由入口写入
attachments.choosing;
attachments.dispose();

const token = dialog.open(title, html, save, submit = "保存");
dialog.isCurrent(token);                 // 异步详情写 DOM 前核对
dialog.close();
dialog.dispose();
```

`identity` 是入口生成的稳定请求目标值，包含外层 worker、存储 generation、切换代际、内层会话、cwd 和运行时代际；A/B/A 不是同一次观察。`active` 合并页面可见性、Host 焦点、连接与目标就绪；它不授予任何后端权限。

`createSessionInventories` 保留 `refresh(snapshot,options)`／`invalidate()`，增加 `dispose()`；`load(kind,owner,{signal})` 的第三个参数兼容原有两参数实现。`composerModelPicker.openModels(providerId)` 使用现有模型窗格，不另建第二份模型选择状态。

## 不变量

- 配置、工具、包管理、信任与权限仍由原生 Host 校验；所有会话请求继续经过聊天入口的固定目标路由。module 不能自选另一个 Agent、放宽远程接口或自动重载。
- Pi 配置保留 scope、内容 revision、未知字段、空密钥保留与项目可信门禁。包操作保留 inventoryKey、原生来源／固定版本规则及全部 Agent 空闲门禁。
- 离页／隐藏只撤读取、定时器和观察；不发送停止 Agent 或停止远程共享的命令。已提交的原生写入可以完成，但旧身份不能再发起后续读取或覆盖新表单。
- 同身份离页保留配置／人格输入；换目标先清旧文档。设置分类只切可见性；未变的提供商、技能、MCP 和包列表不重建节点，保留焦点与展开状态。
- 附件读取先捕获原草稿 owner 与能力上限，完成仍写回原草稿。已移除条目不能被晚到读取复活；旧 submission 不能清除另一会话或后来编辑的文字／附件。
- 市场 HTML 继续经过 DOMPurify 与链接校验，不执行第三方脚本、不自动加载媒体；对话框被替换或关闭后，迟到详情不再修改它。
- 共享对话框的保存令牌固定打开时的目标。旧保存完成不能关闭／重置新表单；身份已失效时不能提交旧表单到当前目标。
- 页面非缓存卸载销毁 module；缓存恢复只恢复当前观察，不产生第二套监听器或原生执行。中文输入法的 `isComposing` 判断仍由原发送入口提前处理。

## 顺序约束

1. 构造时只绑定本地事件；请求依赖当前身份，不能在装配未完成时读取。
2. 入口在切换开始时、快照应用时及可见性／Host 焦点变化时调用 `setContext`，失效先于新读取。提供商／包清单的同一代际由唯一清单协调器发布。
3. 页面内按钮由所属 module 处理并在首个 await 前阻止继续冒泡；共享对话框／导航按钮通过同步 `handleClick` 分派。未命中的会话操作不因此增加异步间隙。
4. 重载仍由入口沿既有请求执行，成功后通知相应视图；不能以刷新视图替代原生重载，也不能因观察断连重新执行写入。
5. 处置与撤观察可重复调用；销毁后不再绑定、读取或发布。外观监听属于页面生命周期，不随外观设置页隐藏而撤销。

## 错误模式

- 当前读取失败显示原错误，不把失败当作空资源或成功；主动撤销和过期结果不污染新目标。
- 当前配置／包／认证操作失败保留可编辑表单并提示使用者；HTTP 权限、冲突与配置语义不变。
- 附件格式、大小、路径或读取失败保留可移除的错误条目；不能默默上传不可用文件。
- 远程 `refresh` 的当前错误交给调用方；module 自己发起的进入、点击和定时刷新负责提示。旧 GET 返回不能再触发 prepare。
- 共享对话框拒绝过期目标保存，提示重新打开；保存失败不会关闭当前表单。

## 性能特征

提供商／插件清单保留原有 30 秒缓存、失败短暂退避与在途合并；失效撤 AbortSignal，即使提供方忽略取消也不发布。MCP 使用共用只读 loader 合并／节流读取，每 1.5 秒先探测资源 revision；旧宿主或探测失败回退真实读取，离页撤观察。远程页同一代际只保留当前读取，连接中每秒、其余每 3 秒补刷，离页后无补刷。

上传附件保留每会话 4 MiB、全部草稿 16 MiB、文本 512 KiB 的既有预算；本地引用不上传原文件字节。文件预览只裁剪展示，不改提交内容。完整市场介绍仍受既有宿主传输预算约束。

## 可执行证据

- `test/chat-views-browser-check.mjs`：真实 Host／worker 的 A/B/A、设置草稿、人格／Pi 设置／MCP 迟到读取、分类与资源焦点、远程撤观察、卸载、IME 和共享 dialog 保存代际。
- `test/session-inventories.test.mjs`、`test/session-drafts.test.mjs`：缓存、取消、忽略 abort 的旧回调、销毁与草稿／附件所有权。
- `test/browser-check.mjs`：真实原生设置、提供商／认证入口、技能、MCP、插件配置、官方目录／完整惰性 README 与包操作、附件、双主题和窄屏。
- `test/context-files-browser-check.mjs`：真实 Electron preload 的本地选择、路径引用、匿名剪贴板缓存与原生提交。
- `test/desktop-sidebar-navigation-browser-check.mjs`、`test/input-presentation-browser-check.mjs`：会话切换、输入草稿、流式与原文展示。
- `test/remote-browser-check.mjs`、`test/desktop-remote-browser-check.mjs`：远程门禁与手机布局。
- `npm run check`、本次文件格式、`npm test`、`npm run package:check`：语法／类型、回归与真实 HTTP／解包资产。
