# Durable entry 输入准入

## 位置与职责

`src/agent/durable-boundaries.mjs` 的 `ensureDurableInputs()` 准备无伪输入准入；`src/agent/durable-entry-source.mjs` 提供已核实 Durable 1.0.2 的源码变换。Pi 的 custom 消息可以作为原生 run 的真实输入贡献，不必额外合成 `pi.user`，也不把一次被动写入冒充模型执行。

## 签名

```js
await ensureDurableInputs();
// -> { apiVersion: 1, implementation: "native" | "patch" }

const submission = await conversation.submit(
  {
    type: "input",
    entry: {
      kind: "desk.native-message",
      model: llmMessages,
      data: { nativeMessage },
    },
    requestId,
    whenBusy: "steer", // 或 followUp／reject；默认仍是原生 followUp
  },
  context,
);
```

`entry` 与既有 `content` 二选一。entry 必须包含非空 model 消息数组，只追加新贡献，不得包含 head 或非空 edits；已有上下文变更继续使用 write／reset。具体 entry、模型消息和会话可见范围由原生 Tx 验证。

`submission` 是原生 input 回执，保留 `status()`／`wait()`／`abort()`。`entry` 指向实际提交的 entry，`answer` 指向该 run 的最终助手；被动 `{ type:"write", entry }` 的语义不变。需要触发模型的 custom 消息由调用方先按 Pi 的消息转换规则形成 model，原始消息保存在 data；此 interface 不运行 Pi 插件或自行转换它的消息。

## 不变量

- 唯一准入、inbox、generation、首次答案、幂等和任务归属继续由原生 Durable 拥有。
- 相同 requestId 保留第一次 input，不追加第二份 entry 或启动重复 run；后续输入不改写已结束的首次答案。
- 空闲 input 直接提交所给 entry 并启动原生 run；busy input 根据原生 steer／followUp／reject 语义处理。
- 队列只使用同一 `pi.inbox`。entry input 在选中的边界提交一次；排队取消不留下其模型贡献，不合成用户占位消息。
- 公开 `Harness`、GenerationTask、CompactionTask、InboxDoc 及 definition 身份保持；只有原生 factory 会创建实际使用的 Harness，补丁不创建额外实例、writer 或调度器。
- 不修改 node_modules，不在浏览器执行扩展代码，不改变 trust、审批或后端权限。

## 顺序约束与恢复

1. `ensureDurableInputs()` 在首次 Harness 创建／恢复前等待完成，包含[提交后边界](durable-boundaries.md)和[请求运行时](durable-request-runtime.md)的准备。
2. 进程内只安装一次，不能在活跃任务中途替换 factory。
3. `pi.inbox` definition version 为 **2**，v1 通过原生文档 migration 保留现有排队项；新增 entry input 的排队项仍由原生任务恢复和取消。
4. 未来原生 SDK 必须同时宣告 `Harness.capabilities.entryInput === 1`、inbox version 至少 2 且提供 migration，并满足前两项 seam，才采用完整原生路径。这是本项目提出的契约，不声称上游已提供；升级必须重新执行语义测试。

## 版本与源码

兼容实现仅适用于 npm `@earendil-works/pi-durable@1.0.2`，来源提交与许可见[边界接口](durable-boundaries.md)。全部受影响发布文件必须匹配摘要：

| dist/harness 文件 | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| generation.js     | `76e00ccac9f54fd61d0bffc1bfb8adb97ad462b428874a5100928f82e7ff1c94` |
| compaction.js     | `de7eed72f40ca9f571d03374020f1b4f47dc609aae374f13388831ccdbd8c88d` |
| harness.js        | `bccc40887ec3b24e7d015cd3e05aa8bce4e41eab67150b7301de8dbf9b7ab1b3` |
| submissions.js    | `1aa0780fee380912ba8123f0da003a087f7bee7a8b20b4157f99b60d42e68dd2` |
| inbox.js          | `082751494dda99eeab21d74a2207912ad409055fa504d370089807d7c0421d85` |

## 错误模式

- 未知版本、任一文件摘要不符、能力或迁移契约不完整：`DeskError(501)`，不打开执行 Harness。
- entry／content 混用、空 model 或改写已有上下文：`TypeError`，不接纳 input。
- busy 的 reject：原生 `ConversationBusy`；queued abort：原生 unanswered／aborted 回执。
- 原生准入、entry 验证、事务、取消和存储异常原样传播，不把未接纳请求当成功。

## 性能特征

安装读取并编译必要的原生 module graph，进程内一次；运行时不增加队列、输入缓存或额外数据库写入。entry 与提交身份在原生准入／边界事务中原子保存。payload 大小与原生 EntryDraft 的限制一致。

## 可执行证据

`node --test test/durable-entry-inputs.test.mjs` 覆盖：空闲无伪输入启动、幂等和首次答案、原生工具边界的 steer、followUp、busy reject、排队取消、append-only 校验、真实 SQLite 的 v1 inbox 迁移和 queued entry 二次恢复、token 身份与依赖文件不变，以及完整／缺少迁移的原生选择。

本页只验收 SDK seam；Pi 的 sendMessage 消费与生命周期集成仍在阶段 07 中继续。
