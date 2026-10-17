# 验证说明

```bash
npm run check
npm run package:check
npm test
npm run test:workspace:browser
npm run test:workspace:desktop
npm run test:browser
npm run test:extensions:browser
npm run test:context:browser
npm run format:check
```

目录和发布修改以真实包内容为验证对象：检查入口及模块引用、公共字体／schema、Markdown 引用和示例完整性；运行时分别检查项目工作区、聊天页面与预览的加载链。浏览器回归还覆盖展开状态、流式思考、当前状态卡片和会话切换。

`node test/conversation-timeline-browser-check.mjs` 使用真实聊天渲染器验证活动折叠栏：兼容 Durable 的 `partial` 消息，只有当前活动播放逐字流水高亮，刷新保留动画进度。等待和空消息使用同样的折叠栏，正文流式输出不另加状态行；运行结束后停止动画。同一回归还验证扩展卡片只进入对话右侧扩展栏、懒详情与展开状态在流式更新后保持、未支持 adapter 回退到原消息，以及会话切换时展示骨架屏而不是演示／空会话界面。

`npm run test:extensions:browser` 使用真实页面标记、CSS 与扩展工作台 controller，覆盖状态去重、选择／展开／滚动保持、键盘操作、懒详情恢复、失败重试与切换会话竞态、通用文本转义、注册 renderer 的 HTML 清理／回退、375–1280px、双主题与减少动态效果。工作区浏览器和 Electron 回归另验证外层入口与顶部页签同步，扩展页不进入设置布局。

果冻式界面回归还检查默认浅色、父子 iframe 的透明背景／根节点主题同步，以及桌面横向扩展页面架。`test/surface-contrast.mjs` 对静态底光取保守色域边界，逐层合成透明表面后测量文本对比度；降低透明度偏好会启用实色表面并关闭局部背景模糊。页面切换动画、放宽后的对话流宽、单行读数标签与窄屏堆叠在 `test/browser-check.mjs` 中断言；输入框上方的项目／提示词／权限胶囊和文件查看器树在桌面回归中覆盖，树只在容器宽度足够时显示，点击文件切换到已有标签。

Electron 专项若继承 `ELECTRON_RUN_AS_NODE=1`，应使用 `env -u ELECTRON_RUN_AS_NODE npm run test:workspace:desktop` 和 `env -u ELECTRON_RUN_AS_NODE npm run test:context:browser`；仅取消当前测试命令的变量，不改用户全局环境。

测试使用临时目录和本地模型／Git／HTTPS 夹具，不触碰真实用户配置、会话或远端仓库。Chromium／Electron／PTY 的专项需要对应本机工具，详见 package.json 中各命令。真实 Tailscale 公网、第三方 OAuth 和任意 Pi 自定义 TUI 控件不能由本地夹具保证。

## 原生压缩会话恢复回归

此前续跑超时已修复：原生自定义消息曾以 `role: custom` 进入 Durable 模型上下文，导致请求前的 token 估算失败。现在统一复用 Pi 的 `convertToLlm`，原消息元数据单独保留用于卡片展示；旧 SQLite 通过幂等上下文编辑兼容，不改写原始历史或向 JSONL 追加伪造的用户编辑。

相关回归覆盖压缩摘要、保留历史、图片、工具结果、自定义卡片、重启与旧记录分支续跑，保持实际模型请求及原生 session ID 的断言。诊断和修复证据见 [恢复续跑验收](../history/native-custom-context-review.md)。

文件上下文验收使用真实 Electron preload、原生选择器夹具和本地模型，检查本地 HTTP 请求及模型上下文只含文件索引；匿名剪贴板文件仅经本地 IPC 落盘。远程上传、主机路径拒绝、草稿隔离和重试标识同时覆盖。

Goal 回归使用已安装的真实 `pi-goal-x` 和本地 faux 模型，覆盖空参数 `/goal` 起草、草稿取消、原生确认对话、无工具调用时的仪表盘、自动续跑、独立完成审计，以及用户停止后不自动重启、显式恢复后继续。测试目标与插件设置都在临时项目中，不创建真实用户目标。

历史测量与测试环境见 [验收目录](../history/README.md)，历史通过不替代当前验证。
