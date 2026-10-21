# 原始输入与自动内容展示契约

## 位置与职责

- `src/agent/input-presentation.mjs`：通过 Durable 公开 document／submission／entry 关联展示来源，不拥有任务生命周期。
- `src/shared/input-presentation.mjs`：窄来源格式与原生 custom 类型常量；不依赖正文标签。
- `src/server/bridge.mjs`、`durable-server.mjs`：验证并捕获 HTTP 原始输入；资源展开前后分别保留用户原文和模型文本。
- `src/agent/durable-resources.mjs`、`native-runtime.mjs`：已注册扩展命令保留只展示原文；原生程序发送的输入标注为自动来源。
- `src/session/pi-session-storage.mjs`、`agent-workspace.mjs`：来源随 SDK 原生 custom entry 导出／继承；UI 投影与模型贡献分开。
- `src/ui/chat/chat.js`：用户原文按纯文本呈现，自动内容使用原生 details 默认折叠；输入历史不回填自动内容。

## 签名

```js
// POST /api/prompt：原有字段不变，追加可选原文。
{ message, original?, mode?, sessionId?, requestId?, attachments? }
// original 仅允许与 message 的 trim() 相同，且不超过现有 50000 字符限制。
// message 仍是此前实际提交给模型的文本；原文不能用来更改模型载荷。

workspace.execute("send", input, {signal?, presentation?});
// presentation 是受信宿主选项，不从 /api/command JSON 中采纳。
workspace.recordInput(id, original, requestId?); // 原生 passive write，不开模型回合。

// 聊天展示消息的追加字段；text／blocks 保留原生内容，不替换模型文本。
message.presentation = {
  source: "user" | "automatic" | "unknown",
  original?: string, // 仅 user；与模型文本相同可省略。
};
message.commandOnly = true; // 自行处理的命令只有展示记录，无模型贡献。

createInputPresentation(harness, context); // submit／record／read／seed
normalizeInputPresentation(value); // 合法窄对象或 undefined
normalizeInputCommand(value); // version:1 的原生命令展示数据或 undefined
```

## 不变量

- 原始输入来自输入框冻结草稿／HTTP message；`original` 只补回已有 trim 行为丢弃的空白。命令展开前捕获，不从展开后的文本猜回原文。
- 来源关联使用原生 `submission.requestId → submission.entry` 和正文摘要校验，不按时间、相同文字或 `<skill>` 正则匹配。相同请求 ID 已接纳时保留第一次来源；确认未接纳的失败尝试清理，不确定回执仍保留可恢复来源。
- `desk.input-presentation` 是 conversation 范围的展示 document（latest／current），不是任务／inbox 存储。局部串行只覆盖来源落盘和原生 submit，不等待模型、工具或终态，不选择任务运行时机。
- 扩展 `sendUserMessage`／触发回合的 custom 消息没有人工原文，标注 automatic；已注册扩展命令另外通过原生 write 保存原文，`model: []`，不额外触发模型。
- 文本与模型内容不变。普通用户的标签、Markdown 字符、空白与换行以 textContent 原样展示；自动展开只进入可展开的模型输入区。未知／无标注历史完整展示原生文本并标明“来源未记录”，不猜测、不误删。
- 自动输入不使用人的头像／用户正文，也不进入输入框历史。只展示命令没有可退回的模型位置，不为其显示轮次管理动作。
- 新标注只使用 SDK 支持的 custom entry，不把原文补成额外模型消息。`pi-desktop-input` 标记在对应 user 消息前，直接 parent 关系及文本摘要均匹配才可采纳；精确 fork 到该消息仍包含标注。`pi-desktop-command` 只记录 UI 原文。
- 独立继承导入时，标注在同一原生导入事务中关联目标新 entry ID，不借用来源 worker／任务。存量族内 fork 保留 current 展示 document；追溯不是管理权限。
- 关闭、切页或断连不取消原生工作；readonly／remote、目标／generation、路径与唯一 writer 约束不变。

## 顺序约束

1. 校验 HTTP 目标／原文 → 捕获原始输入 → 沿现有资源展开／附件准备 → 原文来源先落盘 → 原生 submit 接纳。
2. 展示时用公开 submission 的 entry 绑定来源；排队输入等待原生实际放置，不伪造 transcript。崩溃后使用持久来源与原生接纳记录恢复。
3. 纯命令 write 与扩展自动输入的放置顺序交给原生 inbox；不自建调度器或模型循环。
4. 导出按 SDK 维护的 parent／leaf 写 custom 标注；导入先验证标注类型、版本、直接父子关系和文本摘要，再写目标来源。旧文件不补写迁移标注。
5. UI 默认收起自动内容；用户手动展开可在同一 Agent／generation／conversation 恢复，不能把来源会话的展开状态串入新会话。

## 错误模式

- original 类型／长度非法或与 message 不符：422“输入原文与消息不一致”，不接纳模型工作。
- 宿主来源非法：422“输入展示来源无效”；命令原文非法：422“输入原文无效”。
- 存储或原生接纳失败原样传播；接纳失败后无法确认清理结果时保留两项错误原因，不空白降级。
- 正文摘要不符、版本未知或标注非法：不信任该标注，保留完整原生文字；不按标签补造来源。
- 旧宿主／未标注输入保留兼容展示，不谎称已恢复人工原文。

## 性能特征

- 只保存原文和窄来源；原文与模型文本相同不重复保存。展开文本仍取已存在的原生消息，不复制一套模型上下文。
- 少量待关联来源使用原生 lookup；已关联读模型不重新扫描全部 submission／task。
- 纯展示命令不消耗模型侧子代理读取的 40 entry 内容预算；由现有分页读跳过 UI 记录，不扩大文本预算。
- 来源 document／custom 标注的新增成本必须纳入最终同拓扑性能复测，不能沿用实施前数据宣称零成本。

## 可执行证据

- `test/input-presentation.test.mjs`：真实注册资源、默认 Host／worker 与模型请求，验证命令、模板、附件默认提示、伪造原文拒绝、无来源兼容、重启及精确位置继承；模型请求保持原内容。
- `test/input-presentation-browser-check.mjs`：真实输入框、真实流式响应、手写标签、注册命令与自动输入分离、默认折叠、输入历史、刷新与新会话继承、双主题 4.5:1、390px 与 44px；作为最终专项另行运行，不改受保护 package 脚本。
- `test/durable-features.test.mjs`：自行处理的命令增加只展示记录，但 `model` 为空，不新增模型回合；既有模板／技能行为仍通过。
- 本阶段完整回归、反向验证与固定最终版本验收另记历史；未以局部绿测替代最终完整 12 项。
