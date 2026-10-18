# 边界与两项深化的代码审查（0.26.16）

## 范围与方法

- **基点**：`a5e9fdf`（上一轮结束）；被审提交：`a5e9fdf..264a208` 共 8 个提交（`git diff --stat`：35 文件、+2352/−178，含文献与源码）。
- **方法**：按 `code-review` 技能的两轴——标准轴（是否遵守仓库记录的编码标准 + Fowler 气味基线）与规格轴（是否忠实实现起点规格）。两轴结论分开记录，不互相排序。
- **偏差说明**：技能要求在并行子代理里分别跑两轴；本机 pi-subagents 无法启动后台子代理（`Background children require a supported standalone Pi host`），因此两轴在同一会话内顺次完成。这不改变判据，只影响隔离度。
- **规格来源**：`.pi/goals/archived/goal_2026101811095030_mvd4v944-f767ff.md`（上一轮目标契约：目标、成功标准、边界、约束、验证契约）。
- **标准来源**：`docs/guides/code-style.md`（该轮自己的规范）、`CONTRIBUTING.md`、`AGENTS.md`、`docs/architecture/interfaces/README.md`（契约模板）、`docs/architecture/pi-boundary.md`（边界规则 R1–R4），加 Fowler 气味基线。
- 工具已覆盖的项（prettier、`tsc --noEmit`、`scripts/check-source.mjs`）不重复报告。

## 标准轴

1. **重复的菜单机制（Medium，主观判断）**：`src/ui/chat/chat.js` 现有三套菜单实现——上下文选择器增强（`.context-menu` listbox）、Git 的 `<details class="git-more-menu">`、以及上一轮新增的消息菜单（`.message-menu`）。气味：Duplicated Code。建议把“打开／定位／外部点击与 Esc 关闭”收敛成一个 helper，在分支树 UI 落地时一并做（本轮后续任务会再增加会话栏菜单，届时统一）。
2. **投影规则重复（Medium，已修）**：退回标记要靠“投影后每条消息对应哪个 entry”才能保住原点，这条规则原先只写在 `projectActive` 里；修复把规则抽成同一处的 `contributed(entry)`，投影与原点的计数因此不会再各自漂移（见规格轴第 1 条）。
3. **文档与实现不一致（Low，已修）**：`docs/architecture/interfaces/durable-workspace.md` 写“没有待恢复工作时为 `null`”，而实现只在**打开时任务图为空**时为 `null`；重启后待恢复工作已全部结束（`outstanding` 为 0）仍会报告 `count`/`resumedAt`。已改为按实现描述，并说明界面只在 `outstanding > 0` 时提示。
4. 范围内其余改动符合规范：10 个模块的中文契约块、中文错误消息、接口与实现分离（契约在 `docs/architecture/interfaces/`、实现原因在源码）、边界规则 R1–R4 未见违反；新增测试都带可执行断言。

## 规格轴

1. **退回后消息的原点丢失（High，已修）**：`desk.rewind` 标记承载退回前缀，投影里每条前缀消息的 `entryId` 都指向标记自身，于是界面上从消息触发的「退回到此消息／从此消息分叉」实际作用于**整个前缀**——例如退回后从“第一轮”分叉会连带“第二轮”。规格要求“可从任意 entry 退回……与从任意 entry 分支／克隆”，因此这是实现弱于承诺。
   **修复**：标记在写入时记录 `origins`（每条前缀消息原本的 entry id，仅当数量与模型上下文一致时写入，否则安全回退到标记 id），投影用 `origins[index] ?? entry.id`。新增两条断言（“被重放的消息保留原 entry id”“从被重放的消息分叉停在该处”），并做了敏感性验证：把投影改回 `entry.id` 时该测试失败（pass 0 / fail 1）。
2. **恢复语义的“usage 只记一次”（Low，已在文档如实记录）**：上游对中断回合是至少一次——中断尝试与恢复尝试都计入用量，只有已提交且不依赖中断工作的条目不被重发。规格措辞与上游语义有差距，已在 `verification.md` 与 `guides/sessions.md` 写明。
3. **“TUI 侧看到同一棵树”（Low，已记录）**：以 Pi JSONL 的结构断言（parent id、活跃分支、被放弃路径）代替真实 TUI 运行，属于合理代理，已如实标注。
4. **范围外行为：无**。未发现未要求的改动；`pi-boundary.md` 的 Backlog 两项（子代理与任务图管理、Pi 工具/扩展面板深化）确实未实现，符合该轮规格。

## 修复与验证证据

| 修复                | 严重度 | 文件                                                                                                                    | 证据                                                                          |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 退回后消息原点      | High   | `src/agent/agent-workspace.mjs`（`contributed()`、`prefixOrigins()`、`desk.rewind` 的 `origins`、`projectActive` 回退） | `test/durable-session-tree.test.mjs` 两条新断言；敏感性验证（撤销映射即失败） |
| `recovery` 语义文档 | Low    | `docs/architecture/interfaces/durable-workspace.md`                                                                     | 与实现逐条对齐；界面提示条件写明                                              |

验证（修复后）：`npm test` 306/306、`npm run test:durable` 29/29、`npm run check`（82 源文件）、`npm run format:check` 全绿；`npm run test:durable:browser`（Chromium：项目创建、草稿隔离、后台流式、配置、320/360/390px）通过。

## 增量复核（本轮提交）

基点 `147eced`（0.26.16 发布提交）之后的本轮提交：`6fba75e`（上一轮审查 + High 修复）、`4bae18a`（分支树读模型）、`b3b56f3`（会话栏动作）、`b77d827`（分支树面板）、`cc95110`（任务图读模型）、`2f5ecfb`（任务管理操作）、`14ac688`（任务与子代理面板）。两轴结论：

**标准轴**

1. **共享字段白名单两次漏项（Medium，已修一次）**：`chatSnapshot` 曾把新增的 `native`／`forkOf` 从瘦身投影里丢掉（会话栏因此判断不出能否退回），本轮修好；同类问题（面板新字段也要登记）留作风险点，建议后续加一条「投影形状」契约测试而不是继续靠人工记。
2. **两个内置面板重复同一套加载骨架（Medium，未修）**：`branch-tree-panel.js` 与 `task-panel.js` 各自实现「节流 + pending 补刷 + 容器重画 + repaint 回调」。气味：Duplicated Code。建议抽 `createReadPanel({ fetch, render, throttleMs })`，把两个面板收成配置。
3. **`durable-server.mjs` 继续变大（Low）**：`sessionTree`／`tasks` 两个读模型宿主实现都写在这个文件里（会话树/任务图/状态/命令混在一起）。气味：Divergent Change。建议后续把宿主读模型移到 `src/server/host-read-models.mjs`。
4. **琐碎项（Low，已修）**：`task-panel.js` 里 `task.background ? "◆" : "◆"` 的三元是死代码，已改为常量。
5. 其余符合规范：中文契约块与注释、接口/实现分离、新增模块登记进资产清单、capability 计数与契约测试同步更新。

**规格轴**

1. **消息原点缺陷（High，已在 `6fba75e` 修复）**：见上文规格轴第 1 条。
2. **浏览器回归里运行的是前台任务，不是后台任务（Medium，记为 backlog）**：规格要求「浏览器回归覆盖一次真实的后台任务取消与一次等待」。现在浏览器回归覆盖真实 `bash` 前台任务的取消（两步确认）与一次等待，**后台取消**由 `test/durable-task-graph.test.mjs` 在 API 层覆盖（断言后台取消返回且不打断前台运行）。浏览器夹具没有能创建 `background` 任务的扩展，这是已知缺口，见 backlog。
3. **`forkOf` 的来源变化（Low，已记录）**：分叉来源从会话文档改为 Durable 会话记录的 `parent`，API 字段名不变；`session-tree.md` 与 `durable-workspace.md` 已同步。
4. **面板跟随会话依赖工作台既有行为（Low，已按现状适配）**：切换会话时工作台会重置选中页（既有行为），面板通过「读取页面当前会话 + 重开面板」跟随；浏览器断言按这个语义写。
5. **子代理不可用造成的偏差（Low，已记录）**：两轴审查在同一会话内完成而不是并行子代理（宿主不可用），结论仍按轴分开。
6. 其余满足规格：分支树读模型与三处入口、图谱的展开折叠与节点动作、任务图/子会话读模型、等待/取消/后台取消、只读 403 与两步确认、文档与验证记录都在。

**本轮新增 backlog**

- 浏览器端覆盖真实「后台任务」取消：夹具需要一个能创建 `background: true` 任务的扩展（`defineTask` 或 background 锚点），然后复用面板顶部的「取消后台任务」按钮做端到端断言。
- 抽出 `createReadPanel` 共享骨架，消掉两个内置面板的重复加载逻辑（标准轴第 2 条）。
- 给瘦身投影（`chatSnapshot`）加一条形状契约测试，避免新增字段再次被静默丢弃。

## 优先修复清单（按顺序）

1. 退回后消息原点（High，已修）
2. 重复的菜单机制（Medium，计划与分支树 UI 一并收敛）
