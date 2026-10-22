# Composer 样式所有权收敛验收

## 对照范围

前态为架构阶段 04 提交 `56a916f` 的输入区样式。先新增真实浏览器采集脚本，在未修改 CSS 时记录临时基线，再移动／收敛样式。没有以手工预期值替代前态，也没有把前后截图“看起来一致”当作计算样式等价。

`composer.css` 统一承接原来分布在 `chat.css` 与 `chat-shell.css` 的控件、嵌入、条件规则。保留公共旧 URL 与旧控件 DOM，只增加明确登记的 `/composer.css`；共享动作菜单、BTW、任务表单、Git 和 Ask User 的专属规则不归入输入控件。

只移除可证明被后置规则取代的 57 项声明：相同 selector、相同属性，且后置条件相同或在前态条件成立时必然成立；保留 `!important` 优先级，不把不同条件下有用的差异当作重复。相邻的相同规则／条件合并，但不改变原有 specificity 和顺序。主题仍消费原 token，无视觉重设计或额外布局脚本。

## 实际执行

```bash
node test/composer-style-browser-check.mjs --write-baseline /tmp/pi-composer-before.json
node test/composer-style-browser-check.mjs --baseline /tmp/pi-composer-before.json
```

结果：所采集的 96 个状态的计算属性与几何完全一致。覆盖：

- 独立聊天与真实 Host iframe；浅色／深色。
- 1280×900、700×900、480×800、430×900、390×844、360×780、320×740、844×390。
- 空闲、聚焦文字草稿；嵌入页另打开项目列表与模型菜单。
- 实际粗指针仿真、发送按钮触达、键盘 Esc、菜单／输入区视口边界和无横向溢出。

额外验证实际 CSSOM 的所有权：控件的规则只能来自 `composer.css`，避免以后再次在旧文件尾部追加覆盖。此断言实际发现初次迁移遗漏的 `.send-button` 与 `.analysis-control svg`；补齐其规则后通过，未移除断言。

临时 JSON 仅是本次前后比较证据，不进入提交或 npm 产物。该脚本默认执行所有权、布局与交互断言；比较模式增加与调用方保存基线的严格核对，不承诺未采集状态或任意第三方样式的等价性。完整原生输入、附件、工具菜单、双主题与远程手机行为继续由现有浏览器专项验证，命令入口见[当前样式契约](../architecture/interfaces/composer-styles.md)。
