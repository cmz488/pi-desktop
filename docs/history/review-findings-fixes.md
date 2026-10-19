# 分支与任务管理审查发现修复

## 范围与边界

审查范围为 `773b9f8508b7c45fb6a100ed74209723bdc6287b` → `dd3143281b8e6c7878f39605a6fff8ad0d257ebe`，含前轮分支导航／UI 与任务／子代理原生 API 改动。两个独立只读 reviewer 分别检查 Standards 与 Spec；主会话用临时默认 Desktop 和真实 Chromium 复现加载丢选择、归档分支误恢复整个 Agent 两个行为问题。原审查材料保存在 `/tmp/pi-review-773b9f8-dd31432-hqz_ihoa/`。

用户随后授权修复全部六项。本轮由主会话直接修改及复核，不继续委派，不实现单分支归档／恢复。后端任务调度、模型循环、任务存储及原生回答绑定未改动。

## 六项修复

| 发现                                             | 修复与约束                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 加载期间选择分支，首次聊天状态仍覆盖为根会话     | iframe 加载／首次状态就绪时重放同一 Agent／generation 的最新选择；首次默认会话通知不覆盖该意图。后续内层主动选择仍同步，不锁死导航；旧窗口、非父窗口及过期代际门禁保留。 |
| 归档分支菜单提供 `agent.restore`，实际恢复整个族 | 分支先于归档状态分流；已归档分支只显示可聚焦的只读整族恢复说明，不提供任何 Agent 命令。根菜单仍可恢复全部分支，但不会启动 worker。                                       |
| 用户指南沿用“取消／取消后台任务”                 | 同步为“中止／确认中止／中止后台”；明确等待观察原生终态，中止请求被接受不等于确认中止。                                                                                   |
| 接口契约描述具体原生事务读取调用                 | 改为调用者保证：答案绑定 submission 已决定的不可变回答，`answerEntryId` 标识该回答；旧结果不重放补字段。具体调用留在源码与既有历史记录。                                 |
| 两处维护相同活跃态中文表                         | 任务面板与 Host 详情复用 `taskStatusLabel`；未知状态原样显示，不推断终态。不新增浏览器资源或依赖。                                                                       |
| 两处维护相同图面宽度裁剪                         | 同文件共用小函数；保留 280–760px 范围、初始不可测量时的 460px 回退，以及无新数据时的容器 resize。                                                                        |

对应实现提交：`9a25d0e`、`5b3d98f`、`74a5529`、`7e007f1`。补强浏览器边界证据：`4a22b07`。当前契约见[生命周期](../architecture/interfaces/lifecycle.md)、[只读面板](../architecture/interfaces/read-panels.md)、[Host 任务](../architecture/interfaces/host-tasks.md)与[扩展指南](../guides/extensions.md)。

## TDD 与浏览器证据

本轮继续使用用户已确认的公开 HTTP 与真实浏览器 seam，不读取内部数据库断言，也不模拟执行器：

- 新增 `test/desktop-sidebar-navigation-browser-check.mjs`：真实默认 worker、临时项目、本地 provider。分别延迟初始状态与目标分支状态，连续选择两个分支，验证最后选择、默认通知不抢回选择、代际／来源／旧窗口校验、重复根选择后的内层导航、刷新保留。归档后验证分支无 Agent 命令、说明焦点与 Escape，以及根菜单仍恢复整个族。
- 加载红测直接得到根 `2`，预期分支 `23`；归档红测直接得到 `['agent.restore']`，预期无 Agent 命令。修复后通过，日志在 `/tmp/pi-review-fixes-check/tdd/`。
- `test/read-panels-browser-check.mjs` 继续走统一资产的真实 HTTP module／CSS，补充四种活跃态、未知状态与图面宽度／resize 证据；原有键盘、触屏、窄屏、双主题和只读／远程门禁断言保留。重构前后该专项及真实 Host 任务浏览器专项均通过。
- 夹具调试中的 profile 清理竞争、CSP 对字符串 `eval` 的正常拒绝，以及隐藏窗口暂停观察的测试假设均不计为产品红测或有效反向。新夹具对临时 Chromium profile 做有界清理；来源验证改用独立 CDP execution context，不放宽生产 CSP。

## 新增隔离行为反向

固定实现／测试提交 `4a22b07e540c5194d98de13278651b133af6db10`，仅复制 Git 清单中的源码与测试，排除 release、node_modules、`.agents`、`.git`，不复制被忽略的真实数据。依赖只读链接；每次只反向一个行为并还原。

14 项均在有效语法与完整页面加载下因行为断言或预期 UI 条件有界失败：

1. 去掉 ready 后重放最新选择。
2. 允许首次根通知覆盖最后选择。
3. 把后续内层选择也误标成首次通知。
4. 接受过期 generation 的选择。
5. 接受非父窗口的同源选择。
6. 接受旧 Agent iframe 的导航消息。
7. 恢复归档优先判断，使分支暴露整族恢复。
8. 错删根 Agent 的正常恢复入口。
9. 活跃态显示错误中文。
10. 未知状态被冒充为完成。
11. 去掉图面宽度上限。
12. 去掉图面宽度下限。
13. 去掉初始宽度回退。
14. 去掉容器 resize 重画。

证据：`/tmp/pi-review-fixes-check/sensitivity/` 的逐项 diff、SHA、失败日志、`results.json` 与 `verification.json`。**14/14 有效**；还原后的导航、只读面板、Host 任务三组 Chromium 专项全部通过。303 个复制文件完整还原，主工作树源码、两份 release 与当前安装的 186 个包文件指纹保持不变。两个文档项与重复代码收敛由 Standards 核对，不把文字回退或恢复相同行为的重复代码冒充有效行为反向。

## 依赖兼容与最终验收口径

仓库依赖为 Pi SDK `1.0.0`／Durable `1.0.2`。另以隔离源码只读链接当前实际安装依赖 Pi SDK `1.3.0`／Durable `1.0.4`，导航、只读面板、Host 任务三组 Chromium 专项均通过；证据在 `/tmp/pi-review-fixes-check/global-deps/`。这不是安装本轮源码，也不改变现有安装。

本记录提交后，完整执行以下 12 项，固定同一最终 HEAD／tree，并比较运行前后的源码、release 与安装文件指纹：

```text
npm test
npm run check
npm run format:check
npm run test:durable
npm run test:workspace
npm run test:durable:recovery
npm run test:browser
npm run test:durable:browser
npm run test:workspace:browser
npm run test:remote:desktop
npm run test:extensions:browser
npm run package:check
```

最终结果、实际包检查数量及固定提交以 `/tmp/pi-review-fixes-check/final/results.json`、`verification.json` 和各命令日志为准，不沿用前轮通过数量。全量不强制离线，避免跳过原生包更新检查。

未安装／发布／推送／打 tag，未重启用户应用，未修改个人配置或真实会话。两份已有 release 保留；现有安装在本轮开始时匹配普通 `0.26.16` artifact，不推定安装者，也不将它还原成 `773b9f8`。
