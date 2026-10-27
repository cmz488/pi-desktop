import { replaceOnce } from "./durable-boundary-source.mjs";

/**
 * Durable entry input 补丁（1.4.0 版）：让原生 input 准入携带完整的输入 entry。
 *
 * 1.4.0 原生已具备大部分能力：`SubmissionDraft.type === "input"` 接受 `entry`
 * （`admitSubmission` 调 `checkInputEntry` 校验 kind），`InboxItem.entry` 类型与
 * `applyBoundary` 的队列路径都已存在。唯一缺口是 `appendInput` 用
 * `pickInputEntry(entry)` 剥掉 `model`，再用 `content` 重写为一条 user 消息。
 *
 * `desk.native-message` 需要的是 `convertToLlm([nativeMessage])` 产生的 model，
 * 与 `content` 无关；被重写就会丢掉真实上下文。这里只改这一处，其余仍走原生：
 * 不 bump `InboxDoc` 版本、不改 `submissions.js`、不合成 `pi.user`。
 *
 * 接口：patchEntrySource(kind, source)；由摘要门禁后的兼容 installer 使用。
 * 不变量：kind 校验、幂等 requestId、队列模式、取消与恢复全部仍是原生行为。
 * 错误：锚点不唯一或不存在时抛错，不猜测源码位置。
 */
export function patchEntrySource(kind, source) {
  if (kind !== "inbox")
    throw new Error("Durable entry input 补丁种类无效");
  // 有 entry 时用 entry 自带的 model（调用方已决定上下文），没有才由 content 合成。
  return replaceOnce(
    source,
    '    if (entry === undefined)\n        return tx.appendEntry(UserEntry, conversationId, { model: [message] });\n    return tx.appendEntry(conversationId, { ...pickInputEntry(entry), model: [message] });',
    '    if (entry === undefined)\n        return tx.appendEntry(UserEntry, conversationId, { model: [message] });\n    // pi-desktop: 保留 entry 的 model，content 仅作为占位以满足原生 InboxItem 形状。\n    return tx.appendEntry(conversationId, { ...pickInputEntry(entry), model: entry.model ?? [message] });',
  );
}
