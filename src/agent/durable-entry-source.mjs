import { replaceOnce } from "./durable-boundary-source.mjs";

/**
 * Durable entry input 补丁（1.4.0 版）：让原生 input 准入携带完整的输入 entry。
 *
 * 1.4.0 原生已具备大部分能力：`SubmissionDraft.type === "input"` 接受 `entry`
 * （`admitSubmission` 调 `checkInputEntry` 校验 kind），`InboxItem.entry` 类型与
 * `applyBoundary` 的队列路径都已存在。缺口是 `appendInput` 用 `pickInputEntry(entry)`
 * 剥掉 `model`，再用 `content` 重写为一条 user 消息。
 *
 * `desk.native-message` 需要的是 `convertToLlm([nativeMessage])` 产生的 model，与 `content`
 * 无关；被重写就会丢掉真实上下文。另外 entry input 的 `content` 可以缺省，而原生在 entry
 * 路径里仍会构造 `{ content }` 消息，下游按 iterable 消费就会崩（实测 detail: "content is
 * not iterable"）。这里同时给出空文本占位，使原生形状成立。
 *
 * 接口：patchEntrySource(kind, source)；由摘要门禁后的兼容 installer 使用。
 * 不变量：kind 校验、幂等 requestId、队列模式、取消与恢复全部仍是原生行为。
 * 错误：锚点不唯一或不存在时抛错，不猜测源码位置。
 */
export function patchEntrySource(kind, source) {
  if (kind === "inbox") return patchInbox(source);
  if (kind === "submissions") return patchSubmissions(source);
  throw new Error("Durable entry input 补丁种类无效");
}

function patchInbox(source) {
  source = replaceOnce(
    source,
    '    const message = { role: "user", content, timestamp: now };\n    if (entry === undefined)\n        return tx.appendEntry(UserEntry, conversationId, { model: [message] });\n    return tx.appendEntry(conversationId, { ...pickInputEntry(entry), model: [message] });',
    '    const message = { role: "user", content: content === undefined ? "" : content, timestamp: now };\n    if (entry === undefined)\n        return tx.appendEntry(UserEntry, conversationId, { model: [message] });\n    // pi-desktop: entry 自带 model 时以它为准；content 仅作为原生形状占位。\n    return tx.appendEntry(conversationId, { ...pickInputEntry(entry), model: entry.model ?? [message] });',
  );
  // 旧补丁曾把 inbox 升到 v2；保留版本号与恒等 migrate，使既有 v2 检查点仍可恢复。
  return (
    source +
    "\nInboxDoc.definition.version = 2;\n" +
    "InboxDoc.definition.migrate = (value, fromVersion) => {\n" +
    '    if (fromVersion !== 1 && fromVersion !== 2) throw new Error("Durable inbox 版本无效");\n' +
    "    return value;\n" +
    "};\n"
  );
}

/**
 * 队列路径：entry input 的 content 可以缺省，但原生 InboxItem 与 applyBoundary 会按 iterable
 * 消费它。这里在入队时给空文本占位，并保留 entry 自带的 model（与 appendInput 同义）。
 */
function patchSubmissions(source) {
  // 输入 entry 的准入校验：只允许追加新贡献，不让 entry 改写已有上下文；
  // 正文与 entry 不能同时出现；模型消息不能为空。原生 chỉ校验 kind。
  source = replaceOnce(
    source,
    '    if (draft.type === "input" && draft.entry !== undefined)\n        checkInputEntry(draft.entry);',
    '    if (draft.type === "input" && draft.entry !== undefined) {\n        checkInputEntry(draft.entry);\n        checkEntryInputContributions(draft);\n    }',
  );
  source +=
    "\nfunction checkEntryInputContributions(draft) {\n" +
    "    if (draft.content !== undefined)\n" +
    '        throw new TypeError("输入不能同时指定正文与 entry");\n' +
    "    if (draft.entry.head !== undefined || draft.entry.edits?.length)\n" +
    '        throw new TypeError("输入 entry 不能改写已有上下文，请使用原生 write 或 reset");\n' +
    "    if (!Array.isArray(draft.entry.model) || draft.entry.model.length === 0)\n" +
    '        throw new TypeError("输入 entry 必须提供模型消息");\n' +
    "}\n";
  // copyJson 拒绝 undefined：entry input 只有 entry 时 content 缺省，先占位再入队。
  source = replaceOnce(
    source,
    '            const content = value;\n            const entry = draft.entry === undefined ? {} : { entry: pickInputEntry(draft.entry) };',
    '            const content = value === undefined ? "" : value;\n            const entry = draft.entry === undefined ? {} : { entry: pickInputEntry(draft.entry) };',
  );
  return replaceOnce(
    source,
    '        const value = copyJson(draft.type === "write" ? draft.entry : draft.content, {',
    '        const value = copyJson(\n            draft.type === "write"\n                ? draft.entry\n                : draft.content === undefined\n                    ? ""\n                    : draft.content,\n        {',
  );
}
