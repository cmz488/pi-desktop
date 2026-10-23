import { replaceOnce } from "./durable-boundary-source.mjs";

/**
 * Durable entry input 补丁：让原生 input 准入直接携带 append-only entry。
 *
 * 接口：patchEntrySource(kind, source)；由摘要门禁后的兼容 installer 使用。
 * 不变量：沿用原 submission、inbox、run、幂等及取消；不合成 pi.user，不另建队列。
 * 错误：不匹配锚点或未知源码种类抛错，不对其他 SDK 猜测式修改。
 */
export function patchEntrySource(kind, source) {
  if (kind === "inbox") {
    source = replaceOnce(
      source,
      '        const message = { role: "user", content: item.content, timestamp: now };\n        const entry = await tx.appendEntry(UserEntry, conversationId, { model: [message] });',
      '        const entry = item.entry === undefined\n            ? await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: item.content, timestamp: now }] })\n            : await tx.appendEntry(conversationId, item.entry);',
    );
    return (
      source +
      `\nInboxDoc.definition.version = 2;
InboxDoc.definition.migrate = (value, fromVersion) => {
    if (fromVersion !== 1 && fromVersion !== 2) throw new Error("Durable inbox 版本无效");
    return value;
};\n`
    );
  }
  if (kind !== "submissions")
    throw new Error("Durable entry input 补丁种类无效");
  source = replaceOnce(
    source,
    "export async function admitSubmission(tx, conversationId, draft, now, queueModes) {",
    `export async function admitSubmission(tx, conversationId, draft, now, queueModes) {
    const entryInput = draft.type === "input" && draft.entry !== undefined;
    if (entryInput) {
        if (draft.content !== undefined) throw new TypeError("输入不能同时指定正文与 entry");
        if (draft.entry.head !== undefined || draft.entry.edits?.length) throw new TypeError("输入 entry 不能改写已有上下文，请使用原生 write 或 reset");
        if (!Array.isArray(draft.entry.model) || draft.entry.model.length === 0) throw new TypeError("输入 entry 必须提供模型消息");
    }`,
  );
  source = replaceOnce(
    source,
    'copyJson(draft.type === "write" ? draft.entry : draft.content, {',
    'copyJson(draft.type === "write" || entryInput ? draft.entry : draft.content, {',
  );
  source = replaceOnce(
    source,
    "            items.push({ id, mode, content: value });",
    "            items.push(entryInput ? { id, mode, entry: value } : { id, mode, content: value });",
  );
  return replaceOnce(
    source,
    '    const message = { role: "user", content: draft.content, timestamp: now };\n    const entry = await tx.appendEntry(UserEntry, conversationId, { model: [message] });',
    '    const entry = entryInput\n        ? await tx.appendEntry(conversationId, draft.entry)\n        : await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: draft.content, timestamp: now }] });',
  );
}
